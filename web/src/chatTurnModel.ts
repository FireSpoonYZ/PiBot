import type { ImageAttachment } from '../../host-core/index.js';
import { resolveActiveActivityStartedAt, type BotActivity } from './botActivity';

/**
 * Unified Bot session UI attribution (contract: safe projection of backend
 * data.attribution / live item.attribution). Names are display only; IDs are
 * the stable identity. Never carry native control IDs, tool params or credentials.
 */
export interface MessageAttribution {
  kind: 'user' | 'bot' | 'host';
  botId?: string;
  deviceId?: string;
  name?: string;
  channel: 'primary' | 'dm' | 'room';
  scopeId?: string;
  messageId?: string;
  replyTo?: string;
  rootId?: string;
  category?: 'public' | 'notice' | 'request' | 'reply';
  direction?: 'incoming' | 'outgoing';
  createdAt?: string;
}

export interface ChatToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  /** 工具调用参数（来自 raw history entry.model 中的 toolCall.arguments）。 */
  args?: Record<string, unknown>;
  /** 语义胶囊单行关键参数摘要（如命令、文件路径、搜索词等）。 */
  argSummary?: string;
  /** 工具执行输出文本（来自 liveTools.output 或 toolResult 文本内容）。 */
  output?: string;
  /** 输出是否因长度预算被截断。 */
  outputTruncated?: boolean;
  /** host 投影的工具交互结构（todo/问卷）；来自 live slot 或历史 toolResult，未验证形状，渲染前需 readToolPresentation。 */
  presentation?: Record<string, unknown>;
  /** presentation 来自仍活跃 live slot 时为 true，历史结果替换后为 false。 */
  presentationLive?: boolean;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  entryId: number;
  /** 用户消息已上传图片附件（host.user-message 的 data.attachments / live user message 的 attachments）。 */
  attachments?: ImageAttachment[];
  error?: string;
  thinking?: string;
  toolSummary?: string[];
  tools?: ChatToolCallItem[];
  startedAt?: number;
  durationMs?: number;
  isStreaming?: boolean;
  createdAt?: string;
  /** 该轮真实来源（用户/对端 Bot/Host 触发器、DM/群聊/主聊、原始 messageId/replyTo）。 */
  attribution?: MessageAttribution;
  /** assistant 轮：本轮生成源自 dm/room 触发（协作过程文本，不是投递给用户的消息）；
   *  普通聊天经 parseHistoryEntries 过滤不返回此类轮。 */
  collaborative?: boolean;
}

export interface ParseHistoryOptions {
  liveTools?: Array<Record<string, unknown>>;
  isBusy?: boolean;
  liveGeneratingText?: string;
  /** 当前 Bot 的 botId：用于区分 self echo（outgoing）与对端消息（incoming）。 */
  selfBotId?: string;
  /** 仍在生成的 live 轮的 attribution（LiveGeneration.attribution），仅套用到流式活轮。 */
  liveAttribution?: MessageAttribution;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 从历史/实时 user 消息的 attachments 数组提取展示所需的元数据；字段非法逐项丢弃。 */
function readMessageAttachments(value: unknown): ImageAttachment[] {
  const list = asArray<unknown>(value);
  const out: ImageAttachment[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (typeof item.id !== 'string' || !item.id) continue;
    const mime = item.mimeType === 'image/jpeg' || item.mimeType === 'image/png' ? item.mimeType : 'image/jpeg';
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out.push({
      id: item.id,
      name: typeof item.name === 'string' ? item.name : '',
      mimeType: mime,
      size: num(item.size),
      width: num(item.width),
      height: num(item.height),
    });
  }
  return out;
}

function compactSingleLine(value: string, maxLen = 56): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function shortenPath(rawPath: string, maxLen = 44): string {
  const clean = rawPath.trim();
  if (!clean || clean.length <= maxLen) return clean;
  const parts = clean.split(/([\\/])/).filter(Boolean);
  if (parts.length >= 3) {
    const tail = parts.slice(-3).join('');
    if (tail.length + 2 <= maxLen) return `…${tail}`;
  }
  return `…${clean.slice(-(maxLen - 1))}`;
}

export function summarizeToolArgs(
  name: string,
  args?: Record<string, unknown>,
): string | undefined {
  if (!args) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  const lower = name.toLowerCase();

  const pickStr = (...candidates: string[]): string => {
    for (const key of candidates) {
      const val = args[key];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
  };

  if (lower === 'bash' || lower.endsWith('_bash') || lower === 'shell' || lower === 'exec') {
    const cmd = pickStr('command', 'cmd', 'script');
    if (cmd) return compactSingleLine(cmd, 52);
  }

  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'lsp_fix') {
    const p = pickStr('path', 'file_path', 'filePath', 'file');
    if (p) {
      const short = shortenPath(p, 42);
      if (lower === 'read' && (typeof args.offset === 'number' || typeof args.limit === 'number')) {
        const start = typeof args.offset === 'number' ? args.offset : 1;
        const lim = typeof args.limit === 'number' ? `+${args.limit}` : '';
        return `${short} :${start}${lim}`;
      }
      return short;
    }
  }

  if (lower === 'grep' || lower === 'search') {
    const pat = pickStr('pattern', 'query', 'q');
    const p = pickStr('path', 'glob');
    if (pat && p) return `"${compactSingleLine(pat, 26)}" in ${shortenPath(p, 24)}`;
    if (pat) return `"${compactSingleLine(pat, 44)}"`;
  }

  if (lower === 'find' || lower === 'ls' || lower === 'glob') {
    const pat = pickStr('pattern', 'glob');
    const p = pickStr('path', 'dir', 'directory');
    if (pat && p) return `${compactSingleLine(pat, 26)} · ${shortenPath(p, 24)}`;
    if (pat) return compactSingleLine(pat, 44);
    if (p) return shortenPath(p, 44);
  }

  if (lower === 'codemode') {
    const code = pickStr('code');
    if (code) {
      const firstMeaningful =
        code
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('//')) ?? code;
      return compactSingleLine(firstMeaningful, 48);
    }
  }

  if (lower.includes('websearch') || lower.includes('search')) {
    const q = pickStr('query', 'q', 'prompt');
    if (q) return `"${compactSingleLine(q, 44)}"`;
  }

  const primary = pickStr(
    'command',
    'path',
    'file',
    'query',
    'pattern',
    'url',
    'action',
    'prompt',
    'title',
    'name',
    'id',
  );
  if (primary) return compactSingleLine(primary, 46);

  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) {
      return `${key}: ${compactSingleLine(v, 36)}`;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      return `${key}=${String(v)}`;
    }
  }
  return undefined;
}

export function formatTurnDuration(
  durationMs: number,
  t: (zh: string, en: string) => string = (zh) => zh,
): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 10_000) {
    const sec = Math.max(0.1, Math.round(ms / 100) / 10);
    const formatted = Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`;
    return t(`耗时 ${formatted}`, formatted);
  }
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) {
    return t(`耗时 ${totalSec}s`, `${totalSec}s`);
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    const label = secs > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${mins}m`;
    return t(`耗时 ${label}`, label);
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  const label = `${hours}h ${String(remMins).padStart(2, '0')}m`;
  return t(`耗时 ${label}`, label);
}

export function formatWorkingElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, '0')}m`;
}

interface AssistantTurnAccumulator {
  /** 该累积轮所属来源（attribution 身份序列化）；同一轮工具链跨条目只认同来源，
   *  不同触发/频道的生成绝不合并。无归属条目同为 ''，沿用原有连续合并。 */
  originKey: string;
  turn: ChatTurn;
  textParts: string[];
  thinkingParts: string[];
  tools: ChatToolCallItem[];
  settledToolIds: Set<string>;
  startMs?: number;
  endMs?: number;
  sumDurationMs: number;
}

const ATTRIBUTION_KINDS = new Set(['user', 'bot', 'host']);
const ATTRIBUTION_CHANNELS = new Set(['primary', 'dm', 'room']);
const ATTRIBUTION_CATEGORIES = new Set(['public', 'notice', 'request', 'reply']);
const ATTRIBUTION_DIRECTIONS = new Set(['incoming', 'outgoing']);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 宽容读取共享 UI attribution schema：未知/非法值返回 undefined（不渲染徽标），
 * 绝不从文本推断来源，也不读取信封之外的字段。
 */
export function normalizeAttribution(value: unknown): MessageAttribution | undefined {
  const raw = asRecord(value);
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const channel = typeof raw.channel === 'string' ? raw.channel : '';
  if (!ATTRIBUTION_KINDS.has(kind) || !ATTRIBUTION_CHANNELS.has(channel)) return undefined;
  const out: MessageAttribution = {
    kind: kind as MessageAttribution['kind'],
    channel: channel as MessageAttribution['channel'],
  };
  const botId = readString(raw.botId);
  if (botId !== undefined) out.botId = botId;
  const deviceId = readString(raw.deviceId);
  if (deviceId !== undefined) out.deviceId = deviceId;
  const name = readString(raw.name);
  if (name !== undefined) out.name = name;
  const scopeId = readString(raw.scopeId);
  if (scopeId !== undefined) out.scopeId = scopeId;
  const messageId = readString(raw.messageId);
  if (messageId !== undefined) out.messageId = messageId;
  const replyTo = readString(raw.replyTo);
  if (replyTo !== undefined) out.replyTo = replyTo;
  const rootId = readString(raw.rootId);
  if (rootId !== undefined) out.rootId = rootId;
  const category = typeof raw.category === 'string' && ATTRIBUTION_CATEGORIES.has(raw.category)
    ? (raw.category as MessageAttribution['category'])
    : undefined;
  if (category !== undefined) out.category = category;
  const direction = typeof raw.direction === 'string' && ATTRIBUTION_DIRECTIONS.has(raw.direction)
    ? (raw.direction as MessageAttribution['direction'])
    : undefined;
  if (direction !== undefined) out.direction = direction;
  const createdAt = readString(raw.createdAt);
  if (createdAt !== undefined) out.createdAt = createdAt;
  return out;
}

/**
 * 从 ledger 信封推导 attribution（host.scope-message 等导入条目的 data.message）。
 * 方向相对本 Bot：author.kind === 'bot' 且 botId === selfBotId 视为 outgoing（self echo），
 * 否则 incoming；author.kind === 'user' 是用户消息（普通群聊人类发言），kind 'user'。
 * 无法确定方向时省略 direction（显示层按 incoming 处理）。
 */
function attributionFromEnvelope(
  envelope: Record<string, unknown>,
  scopeKind: string,
  selfBotId: string | undefined,
): MessageAttribution | undefined {
  const author = asRecord(envelope.author);
  const authorKind = typeof author.kind === 'string' ? author.kind : '';
  const channel = ATTRIBUTION_CHANNELS.has(scopeKind) ? (scopeKind as MessageAttribution['channel']) : undefined;
  if (!channel) return undefined;
  const kind: MessageAttribution['kind'] =
    authorKind === 'user' ? 'user' : authorKind === 'bot' ? 'bot' : 'host';
  const botId = kind === 'bot' ? readString(author.botId) : undefined;
  const sourceDeviceId = readString(envelope.sourceDeviceId);
  const scopeId = readString(envelope.scopeId);
  const messageId = readString(envelope.messageId);
  const replyTo = readString(envelope.replyTo);
  const rootId = readString(envelope.rootId);
  const createdAt = readString(envelope.createdAt);
  const category = typeof envelope.category === 'string' && ATTRIBUTION_CATEGORIES.has(envelope.category)
    ? (envelope.category as MessageAttribution['category'])
    : undefined;
  return {
    kind,
    channel,
    ...(botId !== undefined ? { botId } : {}),
    ...(sourceDeviceId !== undefined ? { deviceId: sourceDeviceId } : {}),
    ...(scopeId !== undefined ? { scopeId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(rootId !== undefined ? { rootId } : {}),
    ...(category !== undefined ? { category } : {}),
    direction: selfBotId !== undefined && botId !== undefined && botId === selfBotId ? 'outgoing' : 'incoming',
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/**
 * 轮次归属的稳定身份键：kind/channel/scopeId/botId/deviceId/replyTo。
 * 同一触发生成跨条目（工具/续写）的归属完全相同；不同触发的 replyTo
 * （triggerMessageId）不同，天然分轮。name/messageId/createdAt 不参与，
 * 避免同轮内次要字段差异拆轮。
 */
function attributionKey(a: MessageAttribution): string {
  return [a.kind, a.channel, a.scopeId ?? '', a.botId ?? '', a.deviceId ?? '', a.replyTo ?? ''].join('|');
}

/**
 * 单条目的安全 attribution：优先使用后端已规范化的 data.attribution；
 * 缺失时从 data.message（host.scope-message 的信封）派生，二者合并时
 * data.attribution 的显式字段优先，信封补齐缺失字段，不丢元数据。
 * selfBotId 传入当前 Bot 的 botId 以区分方向（self echo → outgoing）。
 */
export function entryAttribution(
  item: Record<string, unknown>,
  selfBotId?: string,
): MessageAttribution | undefined {
  const data = asRecord(item.data);
  // raw 历史条目：data.attribution；live 投影条目：item.attribution（同 schema）。
  // raw 覆盖 live（外层同 id 去重已做），这里只认该条目自身携带的一份。
  const projected =
    normalizeAttribution(data.attribution) ?? normalizeAttribution(item.attribution);
  const envelope = asRecord(data.message);
  // host.scope-message 条目 data.scopeKind 为 'dm'|'room'；其它 kind 下无信封。
  const scopeKind = readString(data.scopeKind);
  const derived =
    Object.keys(envelope).length > 0
      ? attributionFromEnvelope(envelope, scopeKind ?? '', selfBotId)
      : undefined;
  if (projected && derived) {
    // 合并：后端投影显式给出的字段优先；信封仅补其缺失字段。
    const merged: MessageAttribution = { ...derived, ...projected };
    return merged;
  }
  const single = projected ?? derived;
  return single;
}

/**
 * 单条目的执行来源 channel：带来源条目的 attribution.channel；
 * host.work-trigger 用冻结 turn.replyTarget.kind（真正回复目标，
 * data.scopeId 是工作协调域不是目标）。host.scope-message 是纯导入
 * 事件、不算执行来源。无来源信息返回 undefined。
 */
function entryChannel(
  item: Record<string, unknown>,
  selfBotId?: string,
): MessageAttribution['channel'] | undefined {
  if (item.kind === 'host.work-trigger') {
    const target = asRecord(asRecord(asRecord(item.data).turn).replyTarget);
    const kind = target.kind;
    return typeof kind === 'string' && ATTRIBUTION_CHANNELS.has(kind)
      ? (kind as MessageAttribution['channel'])
      : undefined;
  }
  if (item.kind === 'host.scope-message') return undefined;
  // 真实用户消息（含旧的无 attribution 历史）把执行来源重置回 primary。
  if (item.kind === 'host.user-message' || item.kind === 'pi.user') {
    return entryAttribution(item, selfBotId)?.channel ?? 'primary';
  }
  return entryAttribution(item, selfBotId)?.channel;
}

/**
 * 合并历史中最新可识别执行来源的 channel；无来源条目跳过，全部无来源视为 'primary'。
 * 用于 generation.attribution 缺失但 tools 仍活跃时判断当前是否协作工作。
 */
export function latestEntryChannel(
  items: Array<Record<string, unknown>>,
  selfBotId?: string,
): MessageAttribution['channel'] {
  let channel: MessageAttribution['channel'] = 'primary';
  for (const item of items) {
    const c = entryChannel(item, selfBotId);
    if (c !== undefined) channel = c;
  }
  return channel;
}

export function parseHistoryEntries(
  items: Array<Record<string, unknown>>,
  clearedAfterEntryId = 0,
  options?: ParseHistoryOptions,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let activeUserStartMs: number | undefined;
  let currentAssistant: AssistantTurnAccumulator | null = null;
  let lastBoundaryChannel: MessageAttribution['channel'] = 'primary';

  const ensureAssistant = (id: string, numericId: number, fallbackStartMs?: number, attribution?: MessageAttribution): AssistantTurnAccumulator => {
    // 来源检查在此处闭合内完成：仅当新旧条目都带实际归属且归属不同时才终结上轮，
    // 缺归属（''）的条目继续并入当前轮，同一轮工具链跨条目不拆。
    const nextOrigin = attribution ? attributionKey(attribution) : '';
    if (
      currentAssistant &&
      nextOrigin !== '' &&
      currentAssistant.originKey !== '' &&
      nextOrigin !== currentAssistant.originKey
    ) {
      finalizeCurrentAssistant(false);
    }
    // originKey 任一为空无法精确比较时，显式新归属的 primary/协作类别与当前轮
    // 已推断类别不同也先终结上轮：协作流式不并入旧普通轮，用户答案不并入隐藏协作轮。
    if (
      currentAssistant &&
      attribution !== undefined &&
      (attribution.channel !== 'primary') !== (currentAssistant.turn.collaborative === true)
    ) {
      finalizeCurrentAssistant(false);
    }
    if (currentAssistant) return currentAssistant;
    const startMs = activeUserStartMs ?? fallbackStartMs;
    // 无归属条目继承最近执行来源：dm/room 触发后的无归属生成仍是协作过程，
    // 与 live 活轮同一判断（不参与 originKey，后续真实归属条目照常并入）。
    const collaborative = attribution
      ? attribution.channel !== 'primary'
      : lastBoundaryChannel !== 'primary';
    const turn: ChatTurn = {
      id,
      role: 'assistant',
      entryId: Number.isFinite(numericId) ? numericId : 0,
      text: '',
      startedAt: startMs,
      ...(attribution ? { attribution } : {}),
      ...(collaborative ? { collaborative: true } : {}),
    };
    turns.push(turn);
    currentAssistant = {
      originKey: attribution ? attributionKey(attribution) : '',
      turn,
      textParts: [],
      thinkingParts: [],
      tools: [],
      settledToolIds: new Set<string>(),
      startMs,
      endMs: undefined,
      sumDurationMs: 0,
    };
    return currentAssistant;
  };

  const finalizeCurrentAssistant = (isStillActive: boolean) => {
    if (!currentAssistant) return;
    const acc = currentAssistant;
    currentAssistant = null;

    if (!isStillActive) {
      for (const tool of acc.tools) {
        if (tool.status === 'running') {
          tool.status = 'done';
        }
      }
      const spanMs =
        acc.startMs !== undefined && acc.endMs !== undefined && acc.endMs > acc.startMs
          ? acc.endMs - acc.startMs
          : 0;
      const totalMs = Math.max(spanMs, acc.sumDurationMs);
      if (totalMs > 0) {
        acc.turn.durationMs = totalMs;
      }
    }

    acc.turn.text = acc.textParts.filter(Boolean).join('\n\n').trim();
    acc.turn.thinking = acc.thinkingParts.length > 0 ? acc.thinkingParts.join('\n\n') : undefined;
    acc.turn.tools = acc.tools.length > 0 ? acc.tools : undefined;
    acc.turn.toolSummary = acc.tools.length > 0 ? acc.tools.map((tool) => tool.name) : undefined;
  };

  const selfBotId = typeof options?.selfBotId === 'string' ? options.selfBotId : undefined;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const numericId = typeof item.id === 'number' ? item.id : Number(item.id);
    const itemAttr = entryAttribution(item, selfBotId);
    if (clearedAfterEntryId > 0 && Number.isFinite(numericId) && numericId <= clearedAfterEntryId) {
      continue;
    }
    // Host 工作触发器是内部触发记录，不是人类气泡：不渲染为轮次，但它是
    // 明确的轮边界——此前的助手累积轮在此终结，下一轮触发（不同 requestId/来源）
    // 产生的生成文本绝不并入上一条回答。
    if (item.kind === 'host.work-trigger') {
      const c = entryChannel(item, selfBotId);
      if (c !== undefined) lastBoundaryChannel = c;
      finalizeCurrentAssistant(false);
      continue;
    }
    // host.scope-message 导入条目（含 self echo 与群用户发言）不在普通聊天中展示：
    // 它仍是明确的轮边界——先终结当前助手累积轮，再整条跳过，隐藏内容不合入前后轮。
    if (item.kind === 'host.scope-message') {
      finalizeCurrentAssistant(false);
      continue;
    }
    // 最新执行来源 channel：真实用户消息/生成归属/host 触发边界，scope 导入跳过。
    const itemChannel = entryChannel(item, selfBotId);
    if (itemChannel !== undefined) lastBoundaryChannel = itemChannel;
    // raw 条目用 model 块（含工具/思考）；Host live 投影条目有 messages:[{role,text,truncated,toolCalls,timestamp,durationMs}]。
    // host.user-message 的图片附件元数据在条目级 data.attachments（不在单个 message 上）。
    const entryAttachments = readMessageAttachments(asRecord(item.data).attachments);
    const model = asArray<unknown>(item.model);
    const blocks = model.length > 0 ? model : asArray<unknown>(item.messages);
    for (let mIdx = 0; mIdx < blocks.length; mIdx++) {
      const raw = blocks[mIdx];
      if (!raw || typeof raw !== 'object') continue;
      const entry = asRecord(raw);
      const role = entry.role;
      const msgTimestamp =
        typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) && entry.timestamp > 0
          ? entry.timestamp
          : undefined;
      const msgDurationMs =
        typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0
          ? entry.durationMs
          : undefined;

      if (role === 'user') {
        const content = entry.content;
        const msgAttachments = readMessageAttachments(entry.attachments);
        const attachments = msgAttachments.length > 0 ? msgAttachments : entryAttachments;
        const textParts: string[] = [];
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (typeof entry.text === 'string') {
          textParts.push(entry.text);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'string') {
              textParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text);
            }
          }
        }
        const joinedText = textParts.join('\n').trim();
        if (!joinedText && attachments.length === 0) continue;

        finalizeCurrentAssistant(false);
        activeUserStartMs = msgTimestamp;
        turns.push({
          id: `${String(item.id ?? i)}-${mIdx}`,
          role: 'user',
          entryId: Number.isFinite(numericId) ? numericId : 0,
          text: joinedText,
          ...(attachments.length > 0 ? { attachments } : {}),
          startedAt: msgTimestamp,
          ...(itemAttr ? { attribution: itemAttr } : {}),
        });
        continue;
      }

      if (role === 'assistant') {
        const content = entry.content;
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const extractedTools: Array<{ callId: string; name: string; args?: Record<string, unknown> }> = [];

        if (typeof content === 'string') {
          textParts.push(content);
        } else if (typeof entry.text === 'string') {
          textParts.push(entry.text);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'string') {
              textParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text);
            } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
              thinkingParts.push(part.thinking);
            } else if (part.type === 'toolCall' && typeof part.name === 'string' && part.name.trim()) {
              const rawArgs = asRecord(part.arguments ?? part.args ?? part.input);
              extractedTools.push({
                callId: typeof part.id === 'string' ? part.id : '',
                name: part.name.trim(),
                ...(Object.keys(rawArgs).length > 0 ? { args: rawArgs } : {}),
              });
            }
          }
        }

        if (Array.isArray(entry.toolCalls)) {
          for (const tc of entry.toolCalls) {
            const call = asRecord(tc);
            if (typeof call.name === 'string' && call.name.trim()) {
              const rawArgs = asRecord(call.arguments ?? call.args ?? call.input);
              extractedTools.push({
                callId: typeof call.callId === 'string' ? call.callId : '',
                name: call.name.trim(),
                ...(Object.keys(rawArgs).length > 0 ? { args: rawArgs } : {}),
              });
            }
          }
        } else if (extractedTools.length === 0 && typeof entry.toolName === 'string' && entry.toolName.trim()) {
          const rawArgs = asRecord(entry.arguments ?? entry.args ?? entry.input);
          extractedTools.push({
            callId: typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
            name: entry.toolName.trim(),
            ...(Object.keys(rawArgs).length > 0 ? { args: rawArgs } : {}),
          });
        }

        const joinedText = textParts.join('\n').trim();
        const error =
          (typeof entry.errorMessage === 'string' ? entry.errorMessage.trim() : '') ||
          (entry.stopReason === 'error' || entry.isError === true ? 'model_error' : undefined);

        if (!joinedText && extractedTools.length === 0 && !error && thinkingParts.length === 0) {
          continue;
        }

        const acc = ensureAssistant(`${String(item.id ?? i)}-${mIdx}`, numericId, msgTimestamp, itemAttr);
        if (itemAttr && itemAttr.channel !== 'primary') acc.turn.collaborative = true;
        if (Number.isFinite(numericId) && numericId > acc.turn.entryId) {
          acc.turn.entryId = numericId;
        }
        if (joinedText && acc.textParts.at(-1) !== joinedText) {
          acc.textParts.push(joinedText);
        }
        if (thinkingParts.length > 0) {
          acc.thinkingParts.push(thinkingParts.join('\n'));
        }
        if (error) {
          acc.turn.error = error;
        }
        for (let tIdx = 0; tIdx < extractedTools.length; tIdx++) {
          const tc = extractedTools[tIdx];
          const toolId = tc.callId || `${String(item.id ?? i)}-${mIdx}-tool-${tIdx}`;
          const summary = summarizeToolArgs(tc.name, tc.args);
          const existing = acc.tools.find((itemTool) => itemTool.id === toolId);
          if (!existing) {
            acc.tools.push({
              id: toolId,
              name: tc.name,
              status: 'running',
              ...(tc.args ? { args: tc.args } : {}),
              ...(summary ? { argSummary: summary } : {}),
            });
          } else {
            if (tc.args && !existing.args) existing.args = tc.args;
            if (summary && !existing.argSummary) existing.argSummary = summary;
          }
        }
        if (acc.startMs === undefined && msgTimestamp !== undefined) {
          acc.startMs = msgTimestamp;
          acc.turn.startedAt = msgTimestamp;
        }
        if (msgTimestamp !== undefined) {
          const stepEnd = msgTimestamp + (msgDurationMs ?? 0);
          acc.endMs = acc.endMs !== undefined ? Math.max(acc.endMs, stepEnd) : stepEnd;
        }
        if (msgDurationMs !== undefined) {
          acc.sumDurationMs += msgDurationMs;
        }
        continue;
      }

      if (role === 'toolResult') {
        const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : '';
        const toolName = typeof entry.toolName === 'string' ? entry.toolName.trim() : '';
        const isError = entry.isError === true;
        const resultTextParts: string[] = [];
        if (typeof entry.content === 'string') {
          resultTextParts.push(entry.content);
        } else if (typeof entry.text === 'string') {
          resultTextParts.push(entry.text);
        } else if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (typeof block === 'string') {
              resultTextParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              resultTextParts.push(part.text);
            }
          }
        }
        const resultOutput = resultTextParts.join('\n').trim();
        const resultTruncated = entry.truncated === true;
        // 历史结果上的白名单 presentation 投影（data/details 两种位置都认）。
        const presentation = asRecord(entry.presentation);
        const projectedPresentation = Object.keys(presentation).length > 0
          ? presentation
          : (() => {
              const details = asRecord(entry.details);
              const fromDetails = asRecord(details.presentation);
              if (Object.keys(fromDetails).length > 0) return fromDetails;
              const data = asRecord(entry.data);
              const fromData = asRecord(data.presentation);
              return Object.keys(fromData).length > 0 ? fromData : null;
            })();
        // 分页截断且没有任何可识别所属轮的孤立 toolResult 不新造气泡，
        // 等加载到其工具调用条目后正常归轮。
        if (!currentAssistant && itemAttr === undefined) continue;

        const fallbackStart =
          msgTimestamp !== undefined ? Math.max(0, msgTimestamp - (msgDurationMs ?? 0)) : undefined;
        const acc = ensureAssistant(`${String(item.id ?? i)}-${mIdx}`, numericId, fallbackStart, itemAttr);
        if (Number.isFinite(numericId) && numericId > acc.turn.entryId) {
          acc.turn.entryId = numericId;
        }
        const resolvedStatus: ChatToolCallItem['status'] = isError ? 'error' : 'done';
        let matched = toolCallId ? acc.tools.find((t) => t.id === toolCallId) : undefined;
        if (!matched && toolName) {
          matched = acc.tools.find((t) => t.name === toolName && !acc.settledToolIds.has(t.id));
        }
        if (matched) {
          matched.status = resolvedStatus;
          if (msgDurationMs !== undefined) matched.durationMs = msgDurationMs;
          if (resultOutput) matched.output = resultOutput;
          if (resultTruncated) matched.outputTruncated = true;
          if (projectedPresentation) {
            matched.presentation = projectedPresentation;
            matched.presentationLive = false;
          }
          acc.settledToolIds.add(matched.id);
        } else if (toolName) {
          const id = toolCallId || `${String(item.id ?? i)}-${mIdx}-result`;
          acc.tools.push({
            id,
            name: toolName,
            status: resolvedStatus,
            durationMs: msgDurationMs,
            ...(resultOutput ? { output: resultOutput } : {}),
            ...(resultTruncated ? { outputTruncated: true } : {}),
            ...(projectedPresentation ? { presentation: projectedPresentation, presentationLive: false } : {}),
          });
          acc.settledToolIds.add(id);
        }
        if (acc.startMs === undefined && fallbackStart !== undefined) {
          acc.startMs = fallbackStart;
          acc.turn.startedAt = fallbackStart;
        }
        if (msgTimestamp !== undefined) {
          acc.endMs = acc.endMs !== undefined ? Math.max(acc.endMs, msgTimestamp) : msgTimestamp;
        }
        if (msgDurationMs !== undefined) {
          acc.sumDurationMs += msgDurationMs;
        }
      }
    }
  }

  const isBusy = Boolean(options?.isBusy);
  const liveTools = asArray<Record<string, unknown>>(options?.liveTools);
  const streamingText = typeof options?.liveGeneratingText === 'string' ? options.liveGeneratingText.trim() : '';

  let activeAcc: AssistantTurnAccumulator | null = currentAssistant;
  if (isBusy && (liveTools.length > 0 || streamingText !== '')) {
    const lastEntryId = turns.at(-1)?.entryId ?? 0;
    if (options?.liveAttribution !== undefined) {
      // 明确的 liveAttribution 按完整来源键换轮/并轮（ensureAssistant 内部判定）。
      activeAcc = ensureAssistant('live-assistant', lastEntryId + 0.5, activeUserStartMs, options.liveAttribution);
    } else if (activeAcc === null) {
      // generation.attribution 缺失：已有累积轮直接复用其真实归属，不用残缺 key 拆轮；
      // 仅新造活轮时按最近执行来源 channel 标记归属。
      const liveOrigin: MessageAttribution | undefined =
        lastBoundaryChannel !== 'primary' ? { kind: 'bot', channel: lastBoundaryChannel } : undefined;
      activeAcc = ensureAssistant('live-assistant', lastEntryId + 0.5, activeUserStartMs, liveOrigin);
    }
  }

  if (activeAcc && isBusy) {
    const acc = activeAcc;
    const activeLiveIds = new Set<string>();

    for (let sIdx = 0; sIdx < liveTools.length; sIdx++) {
      const slot = asRecord(liveTools[sIdx]);
      const callId = typeof slot.callId === 'string' ? slot.callId : '';
      const name = typeof slot.name === 'string' ? slot.name.trim() : '';
      if (!name) continue;
      const slotStatus: ChatToolCallItem['status'] = slot.status === 'done' ? 'done' : 'running';
      const slotOutput = typeof slot.output === 'string' ? slot.output.trim() : '';
      const slotTruncated = slot.truncated === true;
      const slotPresentation = asRecord(slot.presentation);
      const hasPresentation = Object.keys(slotPresentation).length > 0;
      const existing = callId
        ? acc.tools.find((t) => t.id === callId)
        : acc.tools.find((t) => t.name === name && !acc.settledToolIds.has(t.id));
      if (existing) {
        activeLiveIds.add(existing.id);
        if (slotOutput && !existing.output) {
          existing.output = slotOutput;
          if (slotTruncated) existing.outputTruncated = true;
        }
        if (!acc.settledToolIds.has(existing.id)) {
          existing.status = slotStatus;
          if (slotOutput) {
            existing.output = slotOutput;
            if (slotTruncated) existing.outputTruncated = true;
          }
          if (hasPresentation) {
            existing.presentation = slotPresentation;
            existing.presentationLive = true;
          }
        }
      } else {
        const id = callId || `live-tool-${sIdx}`;
        activeLiveIds.add(id);
        acc.tools.push({
          id,
          name,
          status: slotStatus,
          ...(slotOutput ? { output: slotOutput } : {}),
          ...(slotTruncated ? { outputTruncated: true } : {}),
          ...(hasPresentation ? { presentation: slotPresentation, presentationLive: true } : {}),
        });
      }
    }

    // Earlier tool rounds in the same turn have already completed once a new round or text stream starts.
    if (liveTools.length > 0 || streamingText !== '') {
      for (const tool of acc.tools) {
        if (tool.status === 'running' && !activeLiveIds.has(tool.id)) {
          tool.status = 'done';
        }
      }
    }

    if (streamingText !== '') {
      acc.turn.isStreaming = true;
      if (acc.textParts.at(-1) !== streamingText) {
        acc.textParts.push(streamingText);
      }
    }
  }

  finalizeCurrentAssistant(isBusy);

  // 普通聊天只显示 primary 轮：dm/room 归因的协作过程轮（文本/思考/工具/错误）
  // 与 scope 导入一律隐藏；replyTarget 为 primary 的生成 channel 仍是 primary，不误删。
  return turns.filter(
    (turn) =>
      turn.collaborative !== true &&
      (turn.attribution === undefined || turn.attribution.channel === 'primary') &&
      (turn.role === 'user' ||
        Boolean(turn.text) ||
        Boolean(turn.tools && turn.tools.length > 0) ||
        Boolean(turn.error) ||
        Boolean(turn.thinking)),
  );
}

// 当前执行轮的计时起点：只认 Host activity.startedAt（含 compacting，自动压缩保持原轮起点）。
// 旧 Host 没有该字段时返回 null，由 WorkingSlot 首次观测忙碌时落锚；历史用户轮/提交时间
// 再也不是当前轮时钟的来源（曾把上一用户消息时间误当本轮起点显示成几十小时）。
export function resolveActiveTurnStartedAt(
  activity?: BotActivity | null,
): number | null {
  return resolveActiveActivityStartedAt(activity ?? null);
}
