// 模块 2：Pi Durable 本机主私聊的只读 helper。
// 不启动调度、不写记录、不合成回答；由后续运行时集成 worker 调用。
import { ResetEntry, StorageRequestError } from '@earendil-works/pi-durable';
import { BotSessionState, deriveEntryAttribution } from './bot-session-context.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RESET_KIND = ResetEntry.kind;
const RESET_SCAN_LIMIT = 200;
// 给 JSON/IPC 信封留出空间；历史总量和单条记录没有这个大小限制。
const TRANSFER_PAGE_BYTES = 256 * 1024;
const ENTRY_CHUNK_UNITS = 64 * 1024;
const CHUNK_CURSOR_KIND = 'history-entry-chunk';

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

/**
 * 校验并规范化分页选项：limit 默认 50，须为 1..200 的整数；cursor 省略/null 或普通非数组对象，
 * 否则 INVALID_ARGUMENT。供运行时 history 与 readPrimaryHistory 共用。
 */
export function normalizeHistoryOptions(options = {}) {
  const { limit = DEFAULT_LIMIT, cursor, chunked } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidArgument('limit must be an integer between 1 and 200');
  }
  const normalizedCursor = cursor ?? undefined;
  if (normalizedCursor !== undefined && (typeof normalizedCursor !== 'object' || Array.isArray(normalizedCursor))) {
    throw invalidArgument('cursor must be null or a plain object');
  }
  if (chunked !== undefined && typeof chunked !== 'boolean') {
    throw invalidArgument('chunked must be a boolean');
  }
  return { limit, cursor: normalizedCursor, ...(chunked ? { chunked: true } : {}) };
}

/**
 * 最近一次 pi.reset 之后的可见历史起点；无 reset 返回 0。清空用 reset 保留原始回执条目，
 * 因此只在读取时按 reset 裁剪，不动存储。倒序沿 cursor 扫到 reset 或历史起点，不设页数上限，
 * 否则更早的 reset 之前的历史会在清空后重新出现。
 */
async function latestResetEntryId(conversation, context) {
  let cursor;
  for (;;) {
    const result = await conversation.entries({ order: 'descending' }, RESET_SCAN_LIMIT, cursor, context);
    const reset = result.items.find((entry) => entry.kind === RESET_KIND);
    if (reset) return reset.id;
    if (!result.next) return 0;
    cursor = result.next;
  }
}

/**
 * 分页读取主私聊历史（最旧在前）。只读，不触发调度，不修改原文。
 * afterReset 为真时从最近一次 pi.reset 之后开始（主私聊可见历史）；work 历史不传该选项。
 * sessionState 为可选的 BotSessionState 快照；缺省且提供 harness 时自行按 conversation.id
 * 快照该 doc（doc 不存在为 null，归属回退既有 data.attribution；存储错误沿原错误路径上抛）。
 * 提供 sessionState 时每页所有条目的 data.attribution 由同一次 deriveEntryAttribution 冻结
 * （byTaskId 精确归属），同一会话跨页/续页的归属输出稳定，不逐页重造。
 * 返回的条目是新对象，原始 EntryRecord 不被改写。
 */
export async function readPrimaryHistory(conversation, options = {}, context, { afterReset = false, sessionState, harness = null } = {}) {
  const { limit, cursor, chunked } = normalizeHistoryOptions(options);
  if (sessionState === undefined) {
    sessionState = harness === null
      ? null
      : await harness.snapshot(BotSessionState, conversation.id, context);
  }
  const continuation = chunked && cursor?.kind === CHUNK_CURSOR_KIND ? cursor : null;
  if (continuation && (
    !Number.isSafeInteger(continuation.entryId) || continuation.entryId <= 0 ||
    !Number.isSafeInteger(continuation.offset) || continuation.offset < 0 ||
    (continuation.position !== null && (typeof continuation.position !== 'object' || Array.isArray(continuation.position)))
  )) {
    throw invalidArgument('invalid history chunk cursor');
  }
  const position = continuation ? continuation.position ?? undefined : cursor;
  try {
    const resetId = afterReset ? await latestResetEntryId(conversation, context) : 0;
    const query = resetId > 0 ? { order: 'ascending', minEntryId: resetId + 1 } : { order: 'ascending' };
    const read = (count) => conversation.entries(query, count, position, context);
    // 一次投影：host.user-message 先剥掉 image.data 再写冻结归属，后续预算/序列化/
    // 返回都用投影结果；durable 存储原内容不动，绝不把图片字节放进传输/日志，
    // 归属也不因剥字节而丢失。
    const project = (items) => sessionState === null
      ? items.map(stripAttachmentData)
      : items.map((entry) => withAttribution(stripAttachmentData(entry), sessionState));
    const readPage = async (count) => {
      const result = await read(count);
      return { items: project(result.items), next: result.next };
    };
    let page = await readPage(continuation ? 1 : limit);
    if (!chunked) return { items: page.items, nextCursor: page.next ?? null };

    if (continuation && page.items[0]?.id !== continuation.entryId) {
      throw invalidArgument('history chunk entry is no longer visible');
    }
    if (!continuation) {
      let count = 0;
      let bytes = 0;
      // 计量已归属副本（返回体），不计量原始条目，避免 attribution 把页面顶出传输预算。
      for (const entry of page.items) {
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (bytes > TRANSFER_PAGE_BYTES) break;
        count++;
      }
      if (count > 0 || page.items.length === 0) {
        // 重读实际返回的前缀，取得 SDK 的精确游标，不跳过放不下的条目。
        if (count < page.items.length) {
          const prefix = await readPage(count);
          return { items: prefix.items, nextCursor: prefix.next ?? null };
        }
        return { items: page.items, nextCursor: page.next ?? null };
      }
      if (page.items.length > 1) {
        // 只装得下第一条：重读精确前缀并同步 next 游标，否则 complete 分支会拿整页
        // 游标跳过中间历史。continuation position 语义不变（仍是原分页位置）。
        const first = await readPage(1);
        page.items = first.items;
        page.next = first.next;
      }
    }
    const entry = page.items[0];
    const json = JSON.stringify(entry);
    const offset = continuation?.offset ?? 0;
    const firstUnit = json.charCodeAt(offset);
    if (offset >= json.length || (firstUnit >= 0xdc00 && firstUnit <= 0xdfff)) {
      throw invalidArgument('history chunk offset is not a valid character boundary');
    }
    let end = Math.min(offset + ENTRY_CHUNK_UNITS, json.length);
    // 每片都须能独立通过 UTF-8/Rust 桥接，不能把 emoji 的代理对拆开。
    const lastUnit = json.charCodeAt(end - 1);
    if (end < json.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) end--;
    const complete = end === json.length;
    return {
      items: [],
      entryChunk: { entryId: entry.id, offset, json: json.slice(offset, end), complete },
      nextCursor: complete ? page.next ?? null : {
        kind: CHUNK_CURSOR_KIND, position: position ?? null, entryId: entry.id, offset: end,
      },
    };
  } catch (err) {
    // SDK 1.3.0 没有细分游标错误码，不能把其余 StorageRequestError 当成参数错误。
    if (err instanceof StorageRequestError && (
      err.message === 'Invalid storage cursor' ||
      err.message === 'The cursor continues a descending scan; the query asks for ascending'
    )) {
      throw invalidArgument(err.message);
    }
    throw err;
  }
}

/** 在条目副本上写入冻结归属；data.attribution 与 derive 结果一致时不再分配新对象。 */
function withAttribution(entry, sessionState) {
  const attribution = deriveEntryAttribution(entry, sessionState);
  if (entry.data?.attribution === attribution) return entry;
  // 无 data 且无归属的条目（如 pi.reset）不凭空造 data 字段。
  if (attribution === null && entry.data === undefined) return entry;
  return { ...entry, data: { ...(entry.data ?? {}), attribution } };
}

/** 把 Durable 提交记录格式化为 PrimarySubmission；conversationId 用公开 UUID。 */
export async function formatPrimarySubmission(harness, bot, record, context) {
  let answerText = null;
  let reason = null;
  if (record.status === 'unanswered') {
    reason = record.reason;
  } else if (record.status === 'done' && record.type === 'input') {
    const entry = await harness.commit((tx) => tx.entry(record.answer), context);
    answerText = assistantText(entry);
  }
  return {
    botId: bot.botId,
    conversationId: bot.primaryConversationId,
    requestId: record.requestId ?? null,
    submissionId: record.id,
    status: record.status,
    answerText,
    reason,
  };
}

/** assistant 消息的 text 块按换行连接；无文字为 ''，忽略 thinking 与 toolCall。 */
function assistantText(entry) {
  const texts = [];
  for (const message of entry?.model ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block?.type === 'text') texts.push(block.text);
    }
  }
  return texts.join('\n');
}

/**
 * host.user-message 条目投影：剥掉 user 消息 image 块的 base64 data，
 * 保留 entry.data.attachments 展示元数据与 text 块。durable 存储原内容不动；
 * 非 chunked 与 chunked 历史都先经此函数再序列化/返回，绝不把图片字节放进
 * UI 历史/日志/inspect 传输。
 */
export function stripAttachmentData(entry) {
  if (entry?.kind !== 'host.user-message' || !Array.isArray(entry?.model)) return entry;
  let changed = false;
  const model = entry.model.map((message) => {
    if (message?.role !== 'user' || !Array.isArray(message?.content)) return message;
    const content = message.content.map((block) => {
      if (block?.type !== 'image') return block;
      changed = true;
      const { data: _dropped, ...rest } = block;
      return rest;
    });
    return changed ? { ...message, content } : message;
  });
  return changed ? { ...entry, model } : entry;
}
