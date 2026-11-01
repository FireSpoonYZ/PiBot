// 模块 6：Bot 主私聊实时投影的纯 helper。只读 ConversationView，不触发调度、不写记录，
// 不调用 Session；由 runtime-live.js 与传输/客户端消费。无新依赖。
//
// 安全窗口：仅投影文本与当前工具安全字段，不透传 raw docs、task memory、参数或签名。
// 工具 details 只经 tool-presentation.js 白名单投影 presentation；其他 details 字段
// （diagnostics、参数、凭据等）永不跨越此边界。
// 性能：历史/消息均从最新向前扫描，找到上限即停止，不遍历/暂存全部原文。
//
// 统一会话：host.scope-message 只渲染对端原文（不渲染 Host 包装 JSON），
// host.work-trigger 是内部触发标记不是人类气泡，一律隐藏；来源经
// deriveEntryAttribution（byTaskId 精确归属，缺失时回退 data.attribution）投影。

import { projectToolPresentation, toolPresentationBytes } from './tool-presentation.js';
import { MAX_LIVE_JSON_BYTES } from './remote-live-protocol.js';
import { deriveEntryAttribution } from './bot-session-context.js';

const MAX_HISTORY_ENTRIES = 50; // 最新可显示条目数
const MAX_MESSAGES_PER_ENTRY = 8; // 每条目最多消息数（保留最新）
const MAX_MESSAGE_UNITS = 4096; // 单条消息文本上限（UTF-16 单元）
const MAX_TOTAL_TEXT_UNITS = 65536; // 历史窗口文本总上限，超限丢弃最旧整条
const MAX_GENERATION_UNITS = 32768; // 当前生成文本上限
const MAX_TOOLS = 32; // 工具槽总数上限（tools + nestedTools）
const MAX_TOOL_OUTPUT_UNITS = 4096; // 工具运行输出保留尾部上限
// Attribution 只由 Host 端冻结 turn/信封生成，字段小而固定；仍留字符上限防伪造放大帧。
const MAX_ATTRIBUTION_TEXT_UNITS = 256;
// 快照/更新帧整体不超过 MAX_LIVE_JSON_BYTES（8MiB UTF-8）。presentation 预算按
// 帧余量计算：外层 envelope 与 id 上限合计 <8KiB，先按该常量扣减，再按 state
// 实际 JSON 字节收紧，保证任何有界投影（含最坏转义）都装得进一帧。
const FRAME_ENVELOPE_RESERVE_BYTES = 8192;

/**
 * 从 UTF-16 单元边界安全截断前缀，不拆分代理对。只读 max 附近的单元，
 * 不遍历巨型原文，也不使用 Array.from。
 */
function truncatePrefix(s, max) {
  if (s.length <= max) return { text: s, truncated: false };
  let end = max;
  const unit = s.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1; // 切在高代理后：回退一个单元
  return { text: s.slice(0, end), truncated: true };
}

/** 保留输出尾部 max 个 UTF-16 单元；窗口起点落在低代理上时前进避开。 */
function truncateTail(s, max) {
  if (s.length <= max) return { text: s, truncated: false };
  let start = s.length - max;
  const unit = s.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return { text: s.slice(start), truncated: true };
}

/**
 * 抽取 content 中的 text 块并按换行连接；跳过 thinking/toolCall/image 等非文本块。
 * 单块可极大，累计到 cap 即截断并置 truncated，不保留超出部分。
 */
function textFromBlocks(content, cap) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
  let out = '';
  let len = 0;
  let truncated = false;
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    const sep = len > 0 ? 1 : 0;
    if (len + sep + block.text.length <= cap) {
      out += (sep ? '\n' : '') + block.text;
      len += sep + block.text.length;
    } else {
      const room = cap - len;
      if (room > sep) {
        const part = truncatePrefix(block.text, room - sep);
        out += (sep ? '\n' : '') + part.text;
      }
      truncated = true;
      break;
    }
  }
  return { text: out, truncated };
}

function toolCallsFromBlocks(content) {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (!block || block.type !== 'toolCall' || typeof block.name !== 'string' || block.name === '') continue;
    calls.push({
      callId: typeof block.id === 'string' ? block.id : '',
      name: block.name,
    });
    if (calls.length >= MAX_TOOLS) break;
  }
  return calls;
}

/** 投影一条消息；跳过 system/未知角色与无内容消息，只带文本和工具安全字段与时间戳。
    user 消息可携带附件展示元数据（不含 base64），图片-only 消息因此不会被空文本过滤掉。 */
function projectMessage(message, budget, entry) {
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return null;
  const { text, truncated } = textFromBlocks(message.content, MAX_MESSAGE_UNITS);
  const toolCalls = role === 'assistant' ? toolCallsFromBlocks(message.content) : [];
  const hasToolResultIdentity =
    role === 'toolResult' &&
    ((typeof message.toolName === 'string' && message.toolName !== '') ||
      (typeof message.toolCallId === 'string' && message.toolCallId !== ''));
  const isAssistantError =
    role === 'assistant' &&
    (message.stopReason === 'error' || (typeof message.errorMessage === 'string' && message.errorMessage.trim() !== ''));

  const attachments = role === 'user' && entry?.kind === 'host.user-message' &&
    Array.isArray(entry?.data?.attachments) && entry.data.attachments.length > 0
    ? entry.data.attachments.map(({ id, name, mimeType, size, width, height }) => ({ id, name, mimeType, size, width, height }))
    : null;

  if (text === '' && toolCalls.length === 0 && !hasToolResultIdentity && !isAssistantError && !attachments) return null;

  const projected = { role, text, truncated };
  if (attachments) projected.attachments = attachments;
  if (role === 'toolResult') {
    if (typeof message.toolName === 'string') projected.toolName = message.toolName;
    if (typeof message.toolCallId === 'string') projected.toolCallId = message.toolCallId;
    if (message.isError === true) projected.isError = true;
    // Durable 1.4 把结果 details 存在 toolResult message 上（entry.data 只存 diagnostics）；
    // abort/interrupt 由 fromSlot 复用 slot.details 合成结果，因此取消的工具结果同样可能
    // 携带最后一次发布的 presentation。大小在加入前计算，超剩余预算省略并置 truncated。
    const presentation = projectToolPresentation(message.details);
    if (presentation && budget.canFit(toolPresentationBytes(presentation))) {
      projected.presentation = presentation;
      budget.take(presentation);
    } else if (presentation !== null ||
        (message.details != null && typeof message.details === 'object' && message.details.presentation != null)) {
      // 存在 presentation 但超界/不合规/超总预算：省略结构，置 truncated 标示消息不完整。
      projected.truncated = true;
    }
  } else if (role === 'assistant') {
    if (toolCalls.length > 0) projected.toolCalls = toolCalls;
    if (isAssistantError) projected.isError = true;
  }
  if (Number.isSafeInteger(message.timestamp) && message.timestamp >= 0) {
    projected.timestamp = message.timestamp;
  }
  if (Number.isSafeInteger(message.durationMs) && message.durationMs >= 0) {
    projected.durationMs = message.durationMs;
  }
  return projected;
}

/** 冻结 turn/信封里的字符串字段整体截断到上限；非字符串字段原样保留。 */
function boundAttributionString(value) {
  if (typeof value !== 'string' || value.length <= MAX_ATTRIBUTION_TEXT_UNITS) return value;
  return value.slice(0, MAX_ATTRIBUTION_TEXT_UNITS);
}

/**
 * 把 deriveEntryAttribution 的安全归属投影为线框可验证形状：只复制白名单字段，
 * 字符串字段截断，其余字段类型不符即丢弃（不抛错、不阻断投影）。
 */
function projectAttribution(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (kind !== 'user' && kind !== 'bot' && kind !== 'host') return null;
  const channel = raw.channel;
  if (channel !== 'primary' && channel !== 'dm' && channel !== 'room') return null;
  const out = { kind, channel };
  for (const key of ['botId', 'deviceId', 'name', 'scopeId', 'messageId', 'replyTo', 'rootId', 'createdAt']) {
    const value = raw[key];
    if (typeof value === 'string') out[key] = boundAttributionString(value);
  }
  if (raw.category === 'public' || raw.category === 'notice' || raw.category === 'request' || raw.category === 'reply') {
    out.category = raw.category;
  }
  if (raw.direction === 'incoming' || raw.direction === 'outgoing') out.direction = raw.direction;
  return out;
}

/** scope-message 的原始对端正文：信封 text 是有界字符串，缺失时此条目无可见内容。 */
function peerBodyFromScopeMessage(entry) {
  const text = entry?.data?.message?.text;
  return typeof text === 'string' ? text : null;
}

/**
 * 投影一条条目：从最新向前保留最多 8 条可显示消息，遇到第 9 条即判定丢消息并停止，
 * 不遍历/暂存更旧消息。messagesDropped 由调用方置 historyTruncated 标示窗口不完整。
 * 无可显示消息则整条不可显示，返回 null。
 * host.work-trigger 永不渲染为气泡；host.scope-message 只显示对端原文，不显示 Host 包装。
 */
function projectEntry(entry, sessionState, budget) {
  if (entry?.kind === 'host.work-trigger') return null;
  const attribution = projectAttribution(deriveEntryAttribution(entry, sessionState));
  if (entry?.kind === 'host.scope-message') {
    const text = peerBodyFromScopeMessage(entry);
    if (text === null) return null;
    const bounded = text.length > MAX_MESSAGE_UNITS
      ? { text: truncatePrefix(text, MAX_MESSAGE_UNITS).text, truncated: true }
      : { text, truncated: false };
    const message = { role: 'user', ...bounded };
    const createdAt = Date.parse(entry?.data?.message?.createdAt ?? '');
    if (Number.isSafeInteger(createdAt) && createdAt >= 0) message.timestamp = createdAt;
    const item = { id: entry.id, kind: entry.kind, messages: [message] };
    if (attribution !== null) item.attribution = attribution;
    return { item, messagesDropped: false };
  }
  const model = entry?.model ?? [];
  const messages = [];
  let seenMessages = 0;
  let messagesDropped = false;
  for (let i = model.length - 1; i >= 0; i--) {
    const projected = projectMessage(model[i], budget, entry);
    if (!projected) continue;
    seenMessages++;
    if (seenMessages > MAX_MESSAGES_PER_ENTRY) {
      messagesDropped = true;
      break;
    }
    messages.unshift(projected);
  }
  if (messages.length === 0) return null;
  const item = { id: entry.id, kind: entry.kind, messages };
  if (attribution !== null) item.attribution = attribution;
  return { item, messagesDropped };
}

function entryTextUnits(entry) {
  let units = 0;
  for (const message of entry.messages) units += message.text.length;
  return units;
}

/** 投影一个工具槽：只带安全字段与白名单 presentation，不带任务内存/其他 details/参数/诊断。 */
function projectTool(slot, budget) {
  const truncated = (slot.droppedBytes ?? 0) > 0 || (slot.droppedLines ?? 0) > 0;
  const tool = {
    callId: slot.callId,
    name: slot.name,
    status: slot.status,
    output: '',
    truncated,
    droppedBytes: slot.droppedBytes ?? 0,
    droppedLines: slot.droppedLines ?? 0,
  };
  if (typeof slot.parentCallId === 'string') tool.parentCallId = slot.parentCallId;
  if (typeof slot.entry === 'number') tool.entryId = slot.entry;
  if (typeof slot.output === 'string' && slot.output !== '') {
    const tail = truncateTail(slot.output, MAX_TOOL_OUTPUT_UNITS);
    tool.output = tail.text;
    if (tail.truncated) tool.truncated = true;
  }
  // 运行中工具经 api.details({presentation}) 发布到 pi.live slot.details；
  // finishSlot 会在 settle 时清除 details，终态卡片由历史 toolResult 投影承担。
  // 大小在加入前计算，超剩余预算省略并置 truncated，不静默丢结构。
  const presentation = projectToolPresentation(slot.details);
  if (presentation && budget.canFit(toolPresentationBytes(presentation))) {
    tool.presentation = presentation;
    budget.take(presentation);
  } else if (presentation !== null ||
      (slot.details != null && typeof slot.details === 'object' && slot.details.presentation != null)) {
    tool.truncated = true;
  }
  return tool;
}

/**
 * 投影当前生成：从 pi.live.generation.message 取文本块，限制 32768 单元。
 * 无 generation/message 时为 null。归属按 pi.live.run.taskId 经
 * deriveEntryAttribution 精确解析（合成 {kind:'pi.assistant',byTaskId} 查询
 * turnByTask 归属；执行 Bot + replyTarget + direction outgoing），避免把协作轮的
 * 流式草稿误标为对用户的回复；索引缺失时不带 attribution。
 */
function projectGeneration(message, sessionState, runTaskId) {
  const { text, truncated } = textFromBlocks(message.content, MAX_GENERATION_UNITS);
  const generation = { text, truncated };
  const attribution = runTaskId === null || runTaskId === undefined
    ? null
    : projectAttribution(
      deriveEntryAttribution({ kind: 'pi.assistant', byTaskId: runTaskId }, sessionState),
    );
  if (attribution !== null) generation.attribution = attribution;
  return generation;
}

/** 初始空状态。 */
export function emptyLiveState() {
  return {
    history: [],
    historyTruncated: false,
    lastEntryId: null,
    generation: null,
    tools: [],
    toolsTruncated: false,
    busy: false,
    queuedCount: 0,
  };
}

/**
 * 从 ConversationView 投影实时状态。历史从最新向前累计，50 条可显示后遇到第 51 条即停；
 * 总文本超 65536 单元丢弃最旧整条并立即 break，保证窗口是连续最新段。工具仅映射
 * tools/nestedTools 前 32 个。busy 由 pi.live.run 存在决定，queuedCount 取 pi.inbox.items 长度。
 */
export function projectLiveState(view, sessionState = null) {
  const live = view.docs?.['pi.live'] ?? null;
  const inbox = view.docs?.['pi.inbox'] ?? null;

  const entries = view.entries ?? [];
  const history = [];
  let usedUnits = 0;
  let seenDisplayable = 0;
  let lastEntryId = null;
  let historyTruncated = false;
  // 运行中工具优先占用 presentation 预算（pending 问卷优先但不豁免超限）；
  // 历史按从新到旧补充。预算是帧级字节余量：先按 envelope 常量预留，history
  // 按最坏情况计入实际字节后再收紧（见文件尾 fitPresentationBudget）。
  const budget = {
    limit: Math.max(0, MAX_LIVE_JSON_BYTES - FRAME_ENVELOPE_RESERVE_BYTES),
    used: 0,
    canFit(bytes) { return bytes <= this.limit - this.used; },
    take(presentation) { this.used += toolPresentationBytes(presentation); },
  };

  const liveTools = live?.tools ?? [];
  const nestedTools = live?.nestedTools ?? [];
  const tools = [];
  const toolCount = Math.min(liveTools.length, MAX_TOOLS);
  for (let i = 0; i < toolCount; i++) tools.push(projectTool(liveTools[i], budget));
  const nestedCount = Math.min(nestedTools.length, MAX_TOOLS - tools.length);
  for (let i = 0; i < nestedCount; i++) tools.push(projectTool(nestedTools[i], budget));

  for (let i = entries.length - 1; i >= 0; i--) {
    const projected = projectEntry(entries[i], sessionState, budget);
    if (!projected) continue;
    seenDisplayable++;
    if (seenDisplayable > MAX_HISTORY_ENTRIES) {
      historyTruncated = true;
      break;
    }
    if (lastEntryId === null) lastEntryId = projected.item.id;
    if (projected.messagesDropped) historyTruncated = true;
    const units = entryTextUnits(projected.item);
    if (units + usedUnits > MAX_TOTAL_TEXT_UNITS) {
      historyTruncated = true;
      break;
    }
    usedUnits += units;
    history.unshift(projected.item);
  }

  const generation = live?.generation?.message
    ? projectGeneration(live.generation.message, sessionState, live?.run?.taskId ?? null)
    : null;

  const state = {
    history,
    historyTruncated,
    lastEntryId,
    generation,
    tools,
    toolsTruncated: liveTools.length + nestedTools.length > MAX_TOOLS,
    busy: Boolean(live?.run),
    queuedCount: Array.isArray(inbox?.items) ? inbox.items.length : 0,
  };
  fitPresentationBudget(state);
  return state;
}

/**
 * 第二遍把整帧塞进预算：删 presentation 后仍可能超（文本 JSON 转义最坏 6 倍），
 * 按 旧历史presentation→整条旧历史→工具输出尾部→生成文本→工具presentation 的
 * 顺序逐级裁剪，每级后重算实际字节；新历史与待答问卷最后裁但不豁免上限。
 */
const FIT_FRAME_LIMIT = MAX_LIVE_JSON_BYTES - FRAME_ENVELOPE_RESERVE_BYTES;
function fitPresentationBudget(state) {
  if (utf8JsonBytes(state) <= FIT_FRAME_LIMIT) return;

  // 1) 历史 presentation：最旧条目、条目内最旧消息优先删。
  let deficit = utf8JsonBytes(state) - FIT_FRAME_LIMIT;
  for (const item of state.history) {
    for (const message of item.messages) {
      if (deficit <= 0) break;
      if (message.presentation === undefined) continue;
      deficit -= utf8JsonBytes(message.presentation);
      delete message.presentation;
      message.truncated = true;
      state.historyTruncated = true;
    }
    if (deficit <= 0) break;
  }

  // 2) 整条旧历史：从最旧向前删，保留连续最新窗口。
  if (deficit > 0) {
    let drop = 0;
    while (drop < state.history.length && deficit > 0) {
      deficit -= utf8JsonBytes(state.history[drop]);
      drop++;
    }
    if (drop > 0) {
      state.history = state.history.slice(drop);
      state.lastEntryId = state.history.length === 0 ? null : state.history[state.history.length - 1].id;
      state.historyTruncated = true;
    }
  }

  // 3) 工具输出尾部：先压到 1024 单元再清空，逐步让出转义放大的字节。
  if (utf8JsonBytes(state) > FIT_FRAME_LIMIT) {
    for (const tool of state.tools) {
      if (tool.output === '') continue;
      if (tool.output.length > 1024) {
        tool.output = truncateTail(tool.output, 1024).text;
        tool.truncated = true;
      }
    }
  }
  if (utf8JsonBytes(state) > FIT_FRAME_LIMIT) {
    let overflow = utf8JsonBytes(state) - FIT_FRAME_LIMIT;
    for (const tool of state.tools) {
      if (overflow <= 0) break;
      if (tool.output === '') continue;
      overflow -= utf8JsonBytes(tool.output);
      tool.output = '';
      tool.truncated = true;
    }
  }

  // 4) 生成文本：压到 4096 单元再清空。绝不只删 attribution 留正文——
  // 无来源的协作草稿会被误认为对用户的答复；正文清空后整条置 null。
  if (state.generation !== null && utf8JsonBytes(state) > FIT_FRAME_LIMIT) {
    const gen = state.generation;
    gen.text = truncateTail(gen.text, 4096).text;
    gen.truncated = true;
    if (utf8JsonBytes(state) > FIT_FRAME_LIMIT) {
      state.generation = null;
    }
  }

  // 5) 运行中工具 presentation 最后裁（pending 问卷优先保留）：投影顺序逐个删。
  if (utf8JsonBytes(state) > FIT_FRAME_LIMIT) {
    let overflow = utf8JsonBytes(state) - FIT_FRAME_LIMIT;
    for (const tool of state.tools) {
      if (overflow <= 0) break;
      if (tool.presentation === undefined) continue;
      overflow -= utf8JsonBytes(tool.presentation);
      delete tool.presentation;
      tool.truncated = true;
    }
    state.toolsTruncated = true;
  }
  // 全部裁剪后仍超限只剩有界骨架字段，实际不可能再超；不再做更多降级。
}

/** JSON.stringify 的 UTF-8 字节数；不可序列化返回 Infinity（视为超预算）。 */
function utf8JsonBytes(value) {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return Infinity;
  }
}

const STATE_KEYS = [
  'history',
  'historyTruncated',
  'lastEntryId',
  'generation',
  'tools',
  'toolsTruncated',
  'busy',
  'queuedCount',
  'turnAdmission',
];

/**
 * 逐字段整体替换 diff：字段变化则以新值整体替换，无变化返回 null。
 * 固定有界字段 JSON 比较：所有字段由投影上限封顶且键序固定，结果确定。
 */
export function diffLiveState(previous, next) {
  const changes = {};
  for (const key of STATE_KEYS) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key];
  }
  return Object.keys(changes).length === 0 ? null : changes;
}
