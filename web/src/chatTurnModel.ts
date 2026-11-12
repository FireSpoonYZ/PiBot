import type { ImageAttachment } from '../../host-core/index.js';
import { resolveActiveActivityStartedAt, type BotActivity } from './botActivity.ts';

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
  sourceType?: 'webhook';
  channel: 'primary' | 'dm' | 'room';
  scopeId?: string;
  messageId?: string;
  replyTo?: string;
  rootId?: string;
  category?: 'public' | 'notice' | 'request' | 'reply';
  direction?: 'incoming' | 'outgoing';
  createdAt?: string;
}

export interface SendToToolPreview {
  scopeKind?: 'dm' | 'room';
  category?: 'request' | 'reply' | 'public' | 'notice';
  targetName?: string;
  text?: string;
  silentPass?: boolean;
  fileCount?: number;
}

export interface KnownBotSummary {
  botId: string;
  deviceId?: string;
  role?: string;
  name?: string;
}

export interface ChatToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  /** done without an outcome is incomplete, not proof of success. */
  outcome?: 'ok' | 'error' | 'cancelled' | 'interrupted';
  parentCallId?: string;
  children?: ChatToolCallItem[];
  nestedCallsTruncated?: boolean;
  error?: string;
  durationMs?: number;
  /** 工具调用参数（来自 raw history entry.model 中的 toolCall.arguments）。 */
  args?: Record<string, unknown>;
  /** 语义胶囊单行关键参数摘要（如命令、文件路径、搜索词等）。 */
  argSummary?: string;
  /** 工具执行输出文本（来自 liveTools.output 或 toolResult 文本内容）。 */
  output?: string;
  /** 输出是否因长度预算被截断。 */
  outputTruncated?: boolean;
  /** send_to 跨智能体通信的结构化预览摘要（用于对话流内联展示）。 */
  sendTo?: SendToToolPreview;
  /** host 投影的工具交互结构（todo/问卷）；来自 live slot 或历史 toolResult，未验证形状，渲染前需 readToolPresentation。 */
  presentation?: Record<string, unknown>;
  /** presentation 来自仍活跃 live slot 时为 true，历史结果替换后为 false。 */
  presentationLive?: boolean;
}

/**
 * 助手轮内的有序展示块：按 model.content / live blocks 原序保留文字/思考/工具组
 * 位置；连续相邻工具合并为一个 tools 块（沿用折叠分组）。块内工具与 ChatTurn.tools
 * 共享同一 ChatToolCallItem 引用，toolResult / live slot 状态更新原地生效，不重复插入。
 * 消息缺有序信息（旧 Host live 投影）时按文本→工具回退顺序追加，不宣称恢复已丢失交错。
 */
export type ChatTurnBlock =
  | { id: string; kind: 'text'; text: string; entryId?: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tools'; tools: ChatToolCallItem[] };

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  entryId: number;
  /** 构成本轮助手正文的持久 entry ID；entryId 会随工具结果推进，不能代替正文归属。 */
  assistantTextEntryIds?: string[];
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
  /** assistant 轮的有序展示块（原始交错顺序）；user 轮与无展示内容轮不设置。
   *  text/tools/thinking 派生字段仍供搜索/摘要与旧渲染路径使用。 */
  blocks?: ChatTurnBlock[];
}

export interface ParseHistoryOptions {
  liveTools?: Array<Record<string, unknown>>;
  isBusy?: boolean;
  liveGeneratingText?: string;
  /** 当前 Bot 的 botId：用于区分 self echo（outgoing）与对端消息（incoming）。 */
  selfBotId?: string;
  /** 仍在生成的 live 轮的 attribution（LiveGeneration.attribution），仅套用到流式活轮。 */
  liveAttribution?: MessageAttribution;
  /** 当前生成的有序内容块投影（LiveGeneration.blocks，仅新 Host）；缺省时流式
   *  文本/工具按工具→文本回退顺序追加到活轮末尾。 */
  liveGeneratingBlocks?: unknown;
  /** 保留持久正文的条目边界，供桌面根据正文在视口内的位置标记结果。 */
  trackAssistantTextEntries?: boolean;
  /** 已知 Bot 目录（用于补全对端/本机 Bot 的可读名称，不展示裸 ID）。 */
  knownBots?: readonly KnownBotSummary[];
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

function readToolOutcome(value: unknown): ChatToolCallItem['outcome'] {
  return value === 'ok' || value === 'error' || value === 'cancelled' || value === 'interrupted'
    ? value
    : undefined;
}

function toolStatus(outcome: ChatToolCallItem['outcome'], done: boolean): ChatToolCallItem['status'] {
  return outcome === 'ok' ? 'done' : outcome ?? (done ? 'done' : 'running');
}

function readDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Durable numeric IDs and live slot IDs identify the same child, never its tool name. */
function mergeToolChildren(parent: ChatToolCallItem, incoming: ChatToolCallItem[]) {
  const byId = new Map((parent.children ?? []).map(child => [child.id, child]));
  for (const child of incoming) {
    const existing = byId.get(child.id);
    if (existing) Object.assign(existing, child);
    else byId.set(child.id, child);
  }
  parent.children = [...byId.values()];
  const prefix = parent.id + '/c';
  const ordinal = (id: string) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))
    ? Number(id.slice(prefix.length))
    : undefined;
  parent.children.sort((a, b) => {
    const left = ordinal(a.id);
    const right = ordinal(b.id);
    return left !== undefined && right !== undefined ? left - right : 0;
  });
}

/** Read only codemode's bounded summaries; child output is not part of this durable contract. */
function readNestedCalls(parent: ChatToolCallItem, entry: Record<string, unknown>) {
  if (parent.name !== 'codemode') return;
  if (entry.nestedCallsTruncated === true) parent.nestedCallsTruncated = true;
  const projected = Array.isArray(entry.nestedCalls);
  const details = asRecord(entry.details);
  const source = projected ? entry.nestedCalls : details.calls;
  if (!Array.isArray(source)) return;
  const children: ChatToolCallItem[] = [];
  // Host 投影已把 details.nestedPresentationsTruncated 并入 nestedCallsTruncated；
  // raw 历史直接读该标志（装饰器丢 presentation 预算耗尽时写入）。
  let truncated = entry.nestedCallsTruncated === true ||
    details.nestedPresentationsTruncated === true || source.length > 128;
  for (const value of source.slice(0, 128)) {
    const call = asRecord(value);
    const id = projected
      ? (call.parentCallId === parent.id ? readString(call.callId) : undefined)
      : Number.isSafeInteger(call.id) && (call.id as number) >= 0
        ? parent.id + '/c' + call.id
        : undefined;
    const name = readString(call.name);
    const outcome = readToolOutcome(call.status);
    if (!id || !name || (!outcome && call.status !== 'running')) {
      truncated = true;
      continue;
    }
    const args = projected ? call.argsPreview : call.args;
    const argSummary = typeof args === 'string' ? args.slice(0, 1024) : undefined;
    const error = typeof call.error === 'string' ? call.error.slice(0, 2048) : undefined;
    truncated ||= name.length > 256 || (typeof args === 'string' && args.length > 1024) ||
      (typeof call.error === 'string' && call.error.length > 2048);
    // 终态子调用的专用卡：投影行与 raw details.calls 行都可能带白名单
    // presentation（codemode-presentations 装饰器按 cN 合入）；形状由渲染侧
    // readToolPresentation 再校验，历史一律 presentationLive:false 不可交互。
    const presentation = asRecord(call.presentation);
    children.push({
      id,
      parentCallId: parent.id,
      name: name.slice(0, 256),
      // A final summary still marked running has no recorded outcome.
      status: toolStatus(outcome, true),
      outcome,
      ...(argSummary !== undefined ? { argSummary } : {}),
      ...(error !== undefined ? { error } : {}),
      durationMs: readDuration(call.durationMs),
      ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
      presentationLive: false,
    });
  }
  mergeToolChildren(parent, children);
  parent.nestedCallsTruncated = truncated;
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

  if (lower === 'send_to') {
    const txt = pickStr('text');
    if (txt) {
      if (/^\(?\s*pass\s*\)?\.?$/i.test(txt)) return '(pass)';
      return compactSingleLine(txt, 48);
    }
  }

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

/** 累积期展示块：tools 块持有自身工具子序列；工具引用与 acc.tools 共享。 */
type AccBlock =
  | { kind: 'text'; text: string; entryId?: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tools'; tools: ChatToolCallItem[] };

interface AssistantTurnAccumulator {
  /** 该累积轮所属来源（attribution 身份序列化）；同一轮工具链跨条目只认同来源，
   *  不同触发/频道的生成绝不合并。无归属条目同为 ''，沿用原有连续合并。 */
  originKey: string;
  channel: MessageAttribution['channel'];
  turn: ChatTurn;
  textParts: string[];
  thinkingParts: string[];
  tools: ChatToolCallItem[];
  /** 原始交错顺序的展示块序列；工具引用与 tools 同步（原地状态更新）。 */
  blocks: AccBlock[];
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

function isSilentPassText(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || /^\(?\s*pass\s*\)?\.?$/i.test(trimmed);
}

function resolveBotDisplayName(
  knownBots: readonly KnownBotSummary[] | undefined,
  botId: string | undefined,
  deviceId?: string,
): string | undefined {
  if (!knownBots?.length || !botId) return undefined;
  if (deviceId) {
    const exact = knownBots.find((b) => b.botId === botId && b.deviceId === deviceId);
    const exactName = readString(exact?.role) ?? readString(exact?.name);
    if (exactName) return exactName;
  }
  const byBotId = knownBots.find((b) => b.botId === botId);
  return readString(byBotId?.role) ?? readString(byBotId?.name);
}

function enrichAttributionName(
  attr: MessageAttribution | undefined,
  knownBots: readonly KnownBotSummary[] | undefined,
): MessageAttribution | undefined {
  if (!attr || attr.kind !== 'bot' || attr.name) return attr;
  const resolved = resolveBotDisplayName(knownBots, attr.botId, attr.deviceId);
  return resolved ? { ...attr, name: resolved } : attr;
}

function applySendToMetadata(
  tool: ChatToolCallItem,
  args: Record<string, unknown> | undefined,
  outputJsonText: string | undefined,
  knownBots: readonly KnownBotSummary[] | undefined,
): void {
  if (tool.name !== 'send_to') return;
  const current: SendToToolPreview = { ...(tool.sendTo ?? {}) };
  if (args) {
    const rawText = typeof args.text === 'string' ? args.text.trim() : '';
    const files = Array.isArray(args.files) ? args.files.length : 0;
    if (files > 0) current.fileCount = files;
    if (rawText) {
      if (files === 0 && isSilentPassText(rawText)) {
        current.silentPass = true;
      } else {
        current.text = rawText;
        current.silentPass = false;
      }
    }
  }
  if (outputJsonText) {
    try {
      const parsed = asRecord(JSON.parse(outputJsonText));
      const scopeKind = parsed.scopeKind;
      if (scopeKind === 'dm' || scopeKind === 'room') current.scopeKind = scopeKind;
      const category = parsed.category;
      if (
        category === 'request' ||
        category === 'reply' ||
        category === 'public' ||
        category === 'notice'
      ) {
        current.category = category;
      }
      if (parsed.status === 'silent_pass') {
        current.silentPass = true;
      }
      const targetName =
        readString(parsed.targetName) ??
        resolveBotDisplayName(knownBots, readString(parsed.peerBotId));
      if (targetName) current.targetName = targetName;
      if (!current.text && !current.silentPass) {
        const preview = readString(parsed.previewText);
        if (preview) current.text = preview;
      }
      if (current.fileCount === undefined && Array.isArray(parsed.files) && parsed.files.length > 0) {
        current.fileCount = parsed.files.length;
      }
    } catch {
      // Non-JSON error output leaves existing args preview intact.
    }
  }
  if (Object.keys(current).length > 0) {
    tool.sendTo = current;
    if (current.targetName) {
      const snippet = current.silentPass
        ? '(pass)'
        : current.text
          ? compactSingleLine(current.text, 40)
          : '';
      tool.argSummary = snippet ? `→ ${current.targetName}: ${snippet}` : `→ ${current.targetName}`;
    }
  }
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
  if (kind === 'host' && raw.sourceType === 'webhook') out.sourceType = 'webhook';
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

  const knownBots = options?.knownBots;

  const ensureAssistant = (id: string, numericId: number, fallbackStartMs?: number, rawAttribution?: MessageAttribution): AssistantTurnAccumulator => {
    const attribution = enrichAttributionName(rawAttribution, knownBots);
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
    // originKey 任一为空无法精确比较时，显式新归属的频道（primary / dm / room）
    // 与当前轮已推断频道不同也先终结上轮：不同频道的流式生成与回答绝不互相混并。
    if (
      currentAssistant &&
      attribution !== undefined &&
      attribution.channel !== currentAssistant.channel
    ) {
      finalizeCurrentAssistant(false);
    }
    if (currentAssistant) return currentAssistant;
    const startMs = activeUserStartMs ?? fallbackStartMs;
    const effectiveChannel: MessageAttribution['channel'] = attribution?.channel ?? lastBoundaryChannel;
    // 仅群聊（room）生成作为隐藏协作过程处理；1v1 用户主聊（primary）与 1v1 Bot 私聊（dm）
    // 均在当前 Bot 的 1v1 对话页内可见执行。
    const collaborative = effectiveChannel === 'room';
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
      channel: effectiveChannel,
      turn,
      textParts: [],
      thinkingParts: [],
      tools: [],
      blocks: [],
      settledToolIds: new Set<string>(),
      startMs,
      endMs: undefined,
      sumDurationMs: 0,
    };
    return currentAssistant;
  };

  /** 同条目的相邻文本换行续接；未跟踪条目时维持原有合并方式。 */
  const accPushText = (acc: AssistantTurnAccumulator, text: string, entryId?: string) => {
    const last = acc.blocks.at(-1);
    if (last?.kind === 'text' && last.entryId === entryId) {
      last.text = last.text + '\n' + text;
    } else {
      acc.blocks.push({ kind: 'text', text, entryId });
    }
  };
  const accPushThinking = (acc: AssistantTurnAccumulator, text: string) => {
    const last = acc.blocks.at(-1);
    if (last && last.kind === 'thinking') {
      last.text = last.text + '\n' + text;
    } else {
      acc.blocks.push({ kind: 'thinking', text });
    }
  };
  /** 工具加入展示块：尾部 tools 块为同段连续普通工具组时并入，否则新开一组；
   *  send_to 始终独立成块，避免被 3+ 工具折叠收起。 */
  const accPushTool = (acc: AssistantTurnAccumulator, tool: ChatToolCallItem, joinAdjacent: boolean) => {
    const last = acc.blocks.at(-1);
    const canJoin =
      joinAdjacent &&
      tool.name !== 'send_to' &&
      last !== undefined &&
      last.kind === 'tools' &&
      last.tools.at(-1)?.name !== 'send_to';
    if (canJoin && last && last.kind === 'tools') {
      last.tools.push(tool);
      return;
    }
    acc.blocks.push({ kind: 'tools', tools: [tool] });
  };

  /** 工具进入 acc.tools（去重/补字段）与展示块：callId 已有工具原地复用不重复
   *  入块（live/history 重叠区更新原位置）；joinAdjacent=true 表示与前一工具
   *  同段连续，并入尾部 tools 组。 */
  const accAddTool = (
    acc: AssistantTurnAccumulator,
    toolId: string,
    name: string,
    args: Record<string, unknown> | undefined,
    joinAdjacent: boolean,
  ): ChatToolCallItem => {
    const summary = summarizeToolArgs(name, args);
    const existing = acc.tools.find((itemTool) => itemTool.id === toolId);
    if (existing) {
      if (args && !existing.args) existing.args = args;
      if (summary && !existing.argSummary) existing.argSummary = summary;
      applySendToMetadata(existing, args, existing.output, knownBots);
      return existing;
    }
    const tool: ChatToolCallItem = {
      id: toolId,
      name,
      status: 'running',
      ...(args ? { args } : {}),
      ...(summary ? { argSummary: summary } : {}),
    };
    applySendToMetadata(tool, args, undefined, knownBots);
    acc.tools.push(tool);
    accPushTool(acc, tool, joinAdjacent);
    return tool;
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
    const out: ChatTurnBlock[] = [];
    let blockSeq = 0;
    for (const block of acc.blocks) {
      if (block.kind === 'tools') {
        if (block.tools.length === 0) continue;
        blockSeq += 1;
        out.push({ id: acc.turn.id + '-b' + blockSeq, kind: 'tools', tools: block.tools });
      } else {
        const text = block.text.trim();
        if (!text) continue;
        blockSeq += 1;
        out.push({
          id: acc.turn.id + '-b' + blockSeq,
          kind: block.kind,
          text,
          ...(block.kind === 'text' && block.entryId !== undefined ? { entryId: block.entryId } : {}),
        });
      }
    }
    acc.turn.blocks = out.length > 0 ? out : undefined;
  };

  const selfBotId = typeof options?.selfBotId === 'string' ? options.selfBotId : undefined;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const numericId = typeof item.id === 'number' ? item.id : Number(item.id);
    const itemAttr = enrichAttributionName(entryAttribution(item, selfBotId), knownBots);
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
    // host.scope-message：
    // - 入站 1v1 DM 消息（非 selfEcho）在当前 Bot 的用户对话页中渲染为左侧对端气泡（is-peer）；
    //   注意只取 data.message.text 或 live 投影 messages[0].text，绝不取 raw model[0].content 包装文本。
    // - 出站 selfEcho（由调用点 send_to 工具卡片按真实时序内联展示）与群聊（room）导入条目跳过。
    if (item.kind === 'host.scope-message') {
      finalizeCurrentAssistant(false);
      const isSelfEcho = asRecord(item.data).selfEcho === true || itemAttr?.direction === 'outgoing';
      if (itemAttr?.channel === 'dm' && !isSelfEcho) {
        const rawMsg = asRecord(asRecord(item.data).message);
        const projectedFirst = asRecord(asArray<unknown>(item.messages)[0]);
        const rawText = typeof rawMsg.text === 'string'
          ? rawMsg.text
          : typeof projectedFirst.text === 'string'
            ? projectedFirst.text
            : '';
        const cleanText = rawText.trim();
        if (cleanText) {
          const ts =
            typeof projectedFirst.timestamp === 'number' &&
            Number.isFinite(projectedFirst.timestamp) &&
            projectedFirst.timestamp > 0
              ? projectedFirst.timestamp
              : (() => {
                  const parsed = Date.parse(readString(rawMsg.createdAt) ?? readString(itemAttr.createdAt) ?? '');
                  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
                })();
          activeUserStartMs = ts;
          turns.push({
            id: `${String(item.id ?? i)}-dm-in`,
            role: 'user',
            entryId: Number.isFinite(numericId) ? numericId : 0,
            text: cleanText,
            startedAt: ts,
            attribution: itemAttr,
            ...(itemAttr.createdAt ? { createdAt: itemAttr.createdAt } : {}),
          });
        }
      }
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
        // 有序展示段：content 数组按块原序（文本/思考/工具交错）；纯 text/toolCalls
        // 投影（旧 Host live、无 content 数组）回退为文本→工具的消息内顺序。
        let messageHasDisplay = false;
        let pendingText = '';
        let pendingThinking = '';
        let toolSeq = 0;
        // 消息内有序段：工具段暂存描述（id/name/args），ensureAssistant 后统一
        // 经 accAddTool 落实为共享 ChatToolCallItem，保证空消息不产生 acc。
        const messageBlocks: AccBlock[] = [];
        const flushText = () => {
          if (pendingText) messageBlocks.push({ kind: 'text', text: pendingText });
          pendingText = '';
        };
        const flushThinking = () => {
          if (pendingThinking) messageBlocks.push({ kind: 'thinking', text: pendingThinking });
          pendingThinking = '';
        };
        const noteText = (value: string) => {
          textParts.push(value);
          messageHasDisplay = true;
          // 类型切换前先把对侧 pending 落段，保持原序。
          flushThinking();
          pendingText = pendingText ? pendingText + '\n' + value : value;
        };
        const noteThinking = (value: string) => {
          thinkingParts.push(value);
          messageHasDisplay = true;
          flushText();
          pendingThinking = pendingThinking ? pendingThinking + '\n' + value : value;
        };
        const noteTool = (callId: string, name: string, args: Record<string, unknown> | undefined) => {
          const toolId = callId || String(item.id ?? i) + '-' + mIdx + '-tool-' + toolSeq;
          toolSeq += 1;
          flushText();
          flushThinking();
          const last = messageBlocks.at(-1);
          const staged: ChatToolCallItem = { id: toolId, name, status: 'running', ...(args ? { args } : {}) };
          if (last && last.kind === 'tools') {
            last.tools.push(staged);
          } else {
            messageBlocks.push({ kind: 'tools', tools: [staged] });
          }
          messageHasDisplay = true;
        };

        if (typeof content === 'string') {
          noteText(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'string') {
              noteText(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              noteText(part.text);
            } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
              noteThinking(part.thinking);
            } else if (part.type === 'toolCall' && typeof part.name === 'string' && part.name.trim()) {
              const rawArgs = asRecord(part.arguments ?? part.args ?? part.input);
              noteTool(
                typeof part.id === 'string' ? part.id : '',
                part.name.trim(),
                Object.keys(rawArgs).length > 0 ? rawArgs : undefined,
              );
            }
          }
        } else {
          // live 投影消息：新 Host 的 blocks 携带真实交错顺序（text/toolCall 原序），
          // 缺省（旧 Host）回退为 整条 text→toolCalls 顺序，不宣称恢复已丢失交错。
          const projectedBlocks = asArray<Record<string, unknown>>(entry.blocks);
          if (projectedBlocks.length > 0) {
            for (const pb of projectedBlocks) {
              if (pb.type === 'text' && typeof pb.text === 'string' && pb.text) {
                noteText(pb.text);
              } else if (pb.type === 'toolCall' && typeof pb.name === 'string' && pb.name.trim()) {
                noteTool(
                  typeof pb.callId === 'string' ? pb.callId : '',
                  pb.name.trim(),
                  undefined,
                );
              }
            }
          } else {
            if (typeof entry.text === 'string' && entry.text) {
              noteText(entry.text);
            }
            const projected = asArray<Record<string, unknown>>(entry.toolCalls);
            if (projected.length > 0) {
              for (const tc of projected) {
                if (typeof tc.name !== 'string' || !tc.name.trim()) continue;
                noteTool(
                  typeof tc.callId === 'string' ? tc.callId : '',
                  tc.name.trim(),
                  undefined,
                );
              }
            } else if (typeof entry.toolName === 'string' && entry.toolName.trim()) {
              noteTool(
                typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
                entry.toolName.trim(),
                undefined,
              );
            }
          }
        }
        flushText();
        flushThinking();

        const joinedText = textParts.join('\n').trim();
        const error =
          (typeof entry.errorMessage === 'string' ? entry.errorMessage.trim() : '') ||
          (entry.stopReason === 'error' || entry.isError === true ? 'model_error' : undefined);

        if (!messageHasDisplay && !error) {
          continue;
        }

        const acc = ensureAssistant(`${String(item.id ?? i)}-${mIdx}`, numericId, msgTimestamp, itemAttr);
        if (itemAttr && itemAttr.channel === 'room') acc.turn.collaborative = true;
        if (Number.isFinite(numericId) && numericId > acc.turn.entryId) {
          acc.turn.entryId = numericId;
        }
        // 不按文本内容去重：相邻不同发言/消息可能正文相同，判重会丢消息。
        if (joinedText) {
          acc.textParts.push(joinedText);
          (acc.turn.assistantTextEntryIds ??= []).push(String(item.id));
        }
        if (thinkingParts.length > 0) {
          acc.thinkingParts.push(thinkingParts.join('\n'));
        }
        if (error) {
          acc.turn.error = error;
        }
        // 按消息内记录顺序落实展示块：同消息内连续工具并入一组，不跨消息合并
        // 工具组；同 callId 已由 accAddTool 去重，不会重复入块。
        const textEntryId = options?.trackAssistantTextEntries && Number.isSafeInteger(numericId) && numericId > 0
          ? String(item.id)
          : undefined;
        for (const seg of messageBlocks) {
          if (seg.kind === 'text') {
            accPushText(acc, seg.text, textEntryId);
          } else if (seg.kind === 'thinking') {
            accPushThinking(acc, seg.text);
          } else {
            // 段内首个工具新开一组（不跨消息合并）；其后工具仅当上一已放置
            // 工具是尾部工具组末位时才并入，保证同段连续工具同组。
            let lastPlaced: ChatToolCallItem | null = null;
            for (const staged of seg.tools) {
              const tail = acc.blocks.at(-1);
              const joinAdjacent =
                lastPlaced !== null &&
                tail !== undefined &&
                tail.kind === 'tools' &&
                tail.tools.at(-1) === lastPlaced;
              lastPlaced = accAddTool(acc, staged.id, staged.name, staged.args, joinAdjacent);
            }
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
        const presentationStatus = projectedPresentation?.status;
        const outcome = readToolOutcome(entry.outcome) ??
          (presentationStatus === 'cancelled' || presentationStatus === 'interrupted'
            ? presentationStatus
            : isError ? 'error' : 'ok');
        const resolvedStatus = toolStatus(outcome, true);
        const matched = toolCallId ? acc.tools.find((t) => t.id === toolCallId) : undefined;
        if (matched) {
          matched.status = resolvedStatus;
          matched.outcome = outcome;
          matched.presentationLive = false;
          readNestedCalls(matched, entry);
          acc.settledToolIds.add(matched.id);
          if (msgDurationMs !== undefined) matched.durationMs = msgDurationMs;
          if (resultOutput) matched.output = resultOutput;
          if (resultTruncated) matched.outputTruncated = true;
          if (projectedPresentation) {
            matched.presentation = projectedPresentation;
            matched.presentationLive = false;
          }
          applySendToMetadata(matched, matched.args, resultOutput || undefined, knownBots);
        } else if (toolName) {
          const id = toolCallId || `${String(item.id ?? i)}-${mIdx}-result`;
          const tool: ChatToolCallItem = {
            id,
            name: toolName,
            status: resolvedStatus,
            outcome,
            durationMs: msgDurationMs,
            ...(resultOutput ? { output: resultOutput } : {}),
            ...(resultTruncated ? { outputTruncated: true } : {}),
            ...(projectedPresentation ? { presentation: projectedPresentation, presentationLive: false } : {}),
          };
          applySendToMetadata(tool, undefined, resultOutput || undefined, knownBots);
          readNestedCalls(tool, entry);
          acc.settledToolIds.add(id);
          acc.tools.push(tool);
          // 孤立 toolResult（分页窗口内未见调用侧）在轮尾追加展示组；
          // 已匹配的调用不移动位置，仅原地更新状态。
          accPushTool(acc, tool, false);
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
  const genBlocks = asArray<Record<string, unknown>>(options?.liveGeneratingBlocks);

  let activeAcc: AssistantTurnAccumulator | null = currentAssistant;
  // 纯 toolCall 的 generation.blocks（尚无 live slot/流式文本）也要开活轮，
  // 否则有序块被丢弃、流式归并不进轮。
  if (isBusy && (liveTools.length > 0 || streamingText !== '' || genBlocks.length > 0)) {
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

    // 工具按 callId 建索引：先按 generation.blocks 放置当前生成的有序块，
    // 再以 live slot 更新/补未定位工具状态——genBlocks 的 text→tool→text
    // 原序不被 slot 顺序打乱；历史已定位 callId 不移动。
    const slotByCallId = new Map<string, Record<string, unknown>>();
    for (const slot of liveTools) {
      const rec = asRecord(slot);
      const callId = typeof rec.callId === 'string' ? rec.callId : '';
      if (callId) slotByCallId.set(callId, rec);
    }
    const makeLiveTool = (
      id: string,
      name: string,
      slot: Record<string, unknown> | undefined,
    ): ChatToolCallItem => {
      const outcome = readToolOutcome(slot?.outcome);
      const status = toolStatus(outcome, slot?.status === 'done');
      const slotOutput = slot && typeof slot.output === 'string' ? slot.output.trim() : '';
      const slotPresentation = asRecord(slot?.presentation);
      const hasPresentation = Object.keys(slotPresentation).length > 0;
      const liveItem: ChatToolCallItem = {
        id,
        name,
        status,
        outcome,
        durationMs: readDuration(slot?.durationMs),
        ...(typeof slot?.parentCallId === 'string' ? { parentCallId: slot.parentCallId } : {}),
        ...(typeof slot?.argsPreview === 'string' ? { argSummary: slot.argsPreview } : {}),
        ...(typeof slot?.error === 'string' ? { error: slot.error } : {}),
        ...(slotOutput ? { output: slotOutput } : {}),
        outputTruncated: slot?.truncated === true,
        ...(hasPresentation ? { presentation: slotPresentation } : {}),
        presentationLive: hasPresentation && status === 'running',
      };
      applySendToMetadata(liveItem, undefined, slotOutput || undefined, knownBots);
      return liveItem;
    };
    const isPlaced = (callId: string) =>
      callId !== '' && acc.blocks.some((b) => b.kind === 'tools' && b.tools.some((t) => t.id === callId));

    // 1) generation.blocks（新 Host）：按块原序落 text/toolCall；toolCall 已在块内
    //    （历史已展示或本轮已放置）原地保留，新工具用 slot 数据就位。
    //    缺该字段（旧 Host）：不在此放工具，下面 slot 循环按尾部追加。
    let prevWasGenTool = false;
    for (const [blockIndex, block] of genBlocks.entries()) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        accPushText(acc, block.text);
        prevWasGenTool = false;
      } else if (block.type === 'toolCall' && typeof block.name === 'string' && block.name.trim()) {
        const callId = typeof block.callId === 'string' ? block.callId : '';
        // Nested slots belong only to their parent, even if an older projection also lists them here.
        if (slotByCallId.get(callId)?.parentCallId) continue;
        // generation 提到的工具计入活跃集合：未 settled 的不被下面
        // running→done 扫描误标完成。
        if (callId) activeLiveIds.add(callId);
        if (!isPlaced(callId)) {
          const name = block.name.trim();
          // 已在 acc.tools 但未入块（slot 先行追加等）：移动既有引用就位不复制；
          // 未见工具用 slot 数据（含 callId 时）或裸名新建。
          const known = callId ? acc.tools.find((t) => t.id === callId) : undefined;
          if (known) {
            accPushTool(acc, known, prevWasGenTool);
            activeLiveIds.add(known.id);
          } else {
            const slot = callId ? slotByCallId.get(callId) : undefined;
            const id = callId || `live-block-tool-${blockIndex}`;
            const tool = makeLiveTool(id, name, slot);
            acc.tools.push(tool);
            accPushTool(acc, tool, prevWasGenTool);
            activeLiveIds.add(tool.id);
          }
        }
        prevWasGenTool = true;
      }
    }

    // 2) Place roots first, then attach children by ID; slot/completion order cannot flatten a child.
    const toolsById = new Map<string, ChatToolCallItem>();
    const indexTool = (tool: ChatToolCallItem) => {
      toolsById.set(tool.id, tool);
      for (const child of tool.children ?? []) indexTool(child);
    };
    for (const tool of acc.tools) indexTool(tool);
    const nested: ChatToolCallItem[] = [];
    for (let sIdx = 0; sIdx < liveTools.length; sIdx++) {
      const slot = asRecord(liveTools[sIdx]);
      const callId = typeof slot.callId === 'string' ? slot.callId : '';
      const name = typeof slot.name === 'string' ? slot.name.trim() : '';
      if (!name) continue;
      const id = callId || `live-tool-${sIdx}`;
      const tool = makeLiveTool(id, name, slot);
      if (tool.parentCallId) {
        // No stable ID means this child cannot be reconciled with a durable result.
        if (callId) nested.push(tool);
        continue;
      }
      activeLiveIds.add(id);
      const existing = toolsById.get(id);
      if (existing) {
        if (!acc.settledToolIds.has(id)) Object.assign(existing, tool);
      } else {
        acc.tools.push(tool);
        toolsById.set(id, tool);
        accPushTool(acc, tool, true);
      }
    }
    // Index the child slots before linking, so a child's parent need not precede it in the frame.
    for (const child of nested) {
      if (!toolsById.has(child.id)) toolsById.set(child.id, child);
    }
    for (const child of nested) {
      const parent = toolsById.get(child.parentCallId!);
      if (!parent) continue;
      activeLiveIds.add(child.id);
      if (!acc.settledToolIds.has(parent.id)) activeLiveIds.add(parent.id);
      const existing = parent.children?.find(item => item.id === child.id);
      if (acc.settledToolIds.has(parent.id)) {
        // A durable result is authoritative; a stale slot cannot reopen its interactive card.
        if (existing) continue;
        child.presentationLive = false;
        if (child.status === 'running') child.status = 'done';
      }
      mergeToolChildren(parent, [child]);
    }

    // Earlier slots are no longer running; without a result their outcome remains unknown.
    if (liveTools.length > 0 || streamingText !== '') {
      for (const tool of acc.tools) {
        if (tool.status === 'running' && !activeLiveIds.has(tool.id)) {
          tool.status = 'done';
        }
      }
    }

    if (streamingText !== '') {
      acc.turn.isStreaming = true;
      // 不做文本内容去重：相邻不同消息可能文本相同，按内容判重会丢正文；
      // textParts 仅供摘要/搜索，原样追加。
      acc.textParts.push(streamingText);
      // 旧 Host 无 generation.blocks 时流式文本按尾部追加；新 Host 经 genBlocks
      // 有序段已经放置，不重复。
      if (genBlocks.length === 0) {
        accPushText(acc, streamingText);
      }
    }
  }

  finalizeCurrentAssistant(isBusy);

  // 1v1 对话页显示 primary（用户主聊）与 dm（1v1 Bot 私聊任务执行）轮；
  // 群聊（room）轮保持隔离在群聊页面内，不在各 Bot 的 1v1 对话页中刷屏。
  return turns.filter(
    (turn) =>
      turn.collaborative !== true &&
      (turn.attribution === undefined || turn.attribution.channel !== 'room') &&
      (turn.role === 'user' ||
        Boolean(turn.text) ||
        Boolean(turn.tools && turn.tools.length > 0) ||
        Boolean(turn.error) ||
        Boolean(turn.thinking)),
  );
}

/** 从调用方实际显示的轮次提取正文 ID，不重做归属或搜索过滤。 */
export function visibleAssistantTextEntryIds(turns: readonly ChatTurn[]): string[] {
  return turns.flatMap(turn => turn.assistantTextEntryIds ?? []);
}

// 当前执行轮的计时起点：只认 Host activity.startedAt（含 compacting，自动压缩保持原轮起点）。
// 旧 Host 没有该字段时返回 null，由 WorkingSlot 首次观测忙碌时落锚；历史用户轮/提交时间
// 再也不是当前轮时钟的来源（曾把上一用户消息时间误当本轮起点显示成几十小时）。
export function resolveActiveTurnStartedAt(
  activity?: BotActivity | null,
): number | null {
  return resolveActiveActivityStartedAt(activity ?? null);
}
