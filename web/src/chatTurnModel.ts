import type { ImageAttachment } from '../../host-core/index.js';
import { resolveActiveActivityStartedAt, type BotActivity } from './botActivity.ts';
import {
  HOST_ATTACHED_IMAGE_LINE_PREFIX,
  isHostInjectedAttachmentLine,
  stripTrailingHostAttachmentLines,
} from './composerFlowControl.ts';

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
  sourceType?: 'schedule' | 'webhook' | 'task_dispatch' | 'google-workspace-rule' | 'google-workspace-assistant';
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
  /** send_to 跨 Bot 通信的结构化预览摘要（用于对话流内联展示）。 */
  sendTo?: SendToToolPreview;
  /** host 投影的工具交互结构（todo/问卷）；来自 live slot 或历史 toolResult，未验证形状，渲染前需 readToolPresentation。 */
  presentation?: Record<string, unknown>;
  /** presentation 来自活跃 live slot 或 Host 验证的 durable wait 时为 true。 */
  presentationLive?: boolean;
  /** Session-owned wait; the SDK tool itself may already be completed. */
  durableWait?: boolean;
}

/**
 * 助手轮内的有序展示块：按 model.content / live blocks 原序保留文字/思考/工具组
 * 位置；连续相邻工具合并为一个 tools 块（沿用折叠分组）。块内工具与 ChatTurn.tools
 * 共享同一 ChatToolCallItem 引用，toolResult / live slot 状态更新原地生效，不重复插入。
 * 消息缺有序信息（旧 Host live 投影）时按文本→工具回退顺序追加，不宣称恢复已丢失交错。
 */
export type ChatTurnBlock =
  | { id: string; kind: 'text'; text: string; entryId?: string; interim?: true }
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
  /** 持久消息的时间（毫秒）；与计算耗时用的轮次起点分开。 */
  timestamp?: number;
  durationMs?: number;
  isStreaming?: boolean;
  createdAt?: string;
  /** 该轮真实来源（用户/对端 Bot/Host 触发器、DM/群聊/主聊、原始 messageId/replyTo）。 */
  attribution?: MessageAttribution;
  /** 当后端未带 attribution 但由 1v1 Bot 私聊（dm）触发器派生时标记，确保过滤与折叠不漏网。 */
  dmChannel?: true;
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
  /** 当前 live 权威完整 durable wait 身份集合（缺省 = 不支持/离线 -> 历史持久等待只读；[] = 已知无活跃）。 */
  durableWaits?: unknown;
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
function readNestedCalls(
  parent: ChatToolCallItem,
  entry: Record<string, unknown>,
  enrichCtx?: CodemodeEnrichContext,
) {
  if (parent.name !== 'codemode') return;
  if (entry.nestedCallsTruncated === true) parent.nestedCallsTruncated = true;
  const projected = Array.isArray(entry.nestedCalls);
  const details = asRecord(entry.details);
  const source = projected ? entry.nestedCalls : details.calls;
  if (!Array.isArray(source)) return;
  const children: ChatToolCallItem[] = [];
  const rawArgsById = new Map<string, unknown>();
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
    if (args !== undefined) rawArgsById.set(id, args);
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
  if (enrichCtx) {
    enrichCodemodeChildren(parent, { ...enrichCtx, rawArgsById });
  }
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
  /** 当前 DM/群聊轮对应的 scopeId（即使条目本身缺 attribution 也可从 work-trigger 继承）。 */
  dmScopeId?: string;
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

interface KnownScopeContext {
  kinds: Map<string, 'dm' | 'room'>;
  dmPeerNames: Map<string, string>;
}

function recordScopeHint(
  ctx: KnownScopeContext,
  scopeId: string | undefined,
  kind: 'dm' | 'room' | undefined,
  peerName?: string,
): void {
  if (!scopeId) return;
  if (kind === 'dm' || kind === 'room') {
    ctx.kinds.set(scopeId, kind);
  }
  if (kind === 'dm' && peerName) {
    ctx.dmPeerNames.set(scopeId, peerName);
  }
}

interface PartialJsonField {
  value: unknown;
  complete: boolean;
  fields?: Map<string, PartialJsonField>;
}

interface PartialJsonReadResult {
  value: unknown;
  complete: boolean;
  nextIndex: number;
  fields?: Map<string, PartialJsonField>;
}

function skipJsonWhitespace(src: string, index: number): number {
  let i = index;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i += 1;
    else break;
  }
  return i;
}

function stripDanglingHighSurrogate(value: string): string {
  if (value.length === 0) return value;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? value.slice(0, -1) : value;
}

function cleanTruncatedJsonString(value: string): string {
  if (value.endsWith('…')) {
    return `${stripDanglingHighSurrogate(value.slice(0, -1))}…`;
  }
  return stripDanglingHighSurrogate(value);
}

function readPartialJsonString(
  src: string,
  start: number,
): { value: string; complete: boolean; nextIndex: number } | undefined {
  if (src[start] !== '"') return undefined;
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      return { value: out, complete: true, nextIndex: i + 1 };
    }
    if (ch === '\\') {
      if (i + 1 >= src.length) {
        return { value: cleanTruncatedJsonString(out), complete: false, nextIndex: src.length };
      }
      const esc = src[i + 1];
      if (esc === '…' && i + 2 === src.length) {
        return { value: cleanTruncatedJsonString(`${out}…`), complete: false, nextIndex: src.length };
      }
      switch (esc) {
        case '"': out += '"'; i += 2; break;
        case '\\': out += '\\'; i += 2; break;
        case '/': out += '/'; i += 2; break;
        case 'b': out += '\b'; i += 2; break;
        case 'f': out += '\f'; i += 2; break;
        case 'n': out += '\n'; i += 2; break;
        case 'r': out += '\r'; i += 2; break;
        case 't': out += '\t'; i += 2; break;
        case 'u': {
          const hex = src.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            const rem = src.slice(i + 2);
            if (/^[0-9a-fA-F]{0,3}$/.test(rem) || /^[0-9a-fA-F]{0,3}…$/.test(rem)) {
              const tail = rem.endsWith('…') ? '…' : '';
              return { value: cleanTruncatedJsonString(`${out}${tail}`), complete: false, nextIndex: src.length };
            }
            return undefined;
          }
          break;
        }
        default:
          return undefined;
      }
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) return undefined;
    out += ch;
    i += 1;
  }
  return { value: cleanTruncatedJsonString(out), complete: false, nextIndex: src.length };
}

function readPartialJsonObject(
  src: string,
  start: number,
  depth: number,
): PartialJsonReadResult | undefined {
  if (depth > 4 || src[start] !== '{') return undefined;
  const fields = new Map<string, PartialJsonField>();
  const record: Record<string, unknown> = {};
  let i = skipJsonWhitespace(src, start + 1);
  if (i >= src.length) return { value: record, fields, complete: false, nextIndex: i };
  if (src[i] === '}') return { value: record, fields, complete: true, nextIndex: i + 1 };
  while (i < src.length) {
    i = skipJsonWhitespace(src, i);
    if (i >= src.length) return { value: record, fields, complete: false, nextIndex: i };
    const key = readPartialJsonString(src, i);
    if (!key || !key.complete) {
      return { value: record, fields, complete: false, nextIndex: src.length };
    }
    i = skipJsonWhitespace(src, key.nextIndex);
    if (i >= src.length || src[i] !== ':') {
      return { value: record, fields, complete: false, nextIndex: src.length };
    }
    i = skipJsonWhitespace(src, i + 1);
    if (i >= src.length) {
      return { value: record, fields, complete: false, nextIndex: src.length };
    }
    const val = readPartialJsonValue(src, i, depth + 1);
    if (!val) {
      return { value: record, fields, complete: false, nextIndex: src.length };
    }
    fields.set(key.value, { value: val.value, complete: val.complete, fields: val.fields });
    record[key.value] = val.value;
    if (!val.complete) {
      return { value: record, fields, complete: false, nextIndex: src.length };
    }
    i = skipJsonWhitespace(src, val.nextIndex);
    if (i >= src.length) return { value: record, fields, complete: false, nextIndex: i };
    if (src[i] === ',') {
      i += 1;
      continue;
    }
    if (src[i] === '}') {
      return { value: record, fields, complete: true, nextIndex: i + 1 };
    }
    return { value: record, fields, complete: false, nextIndex: src.length };
  }
  return { value: record, fields, complete: false, nextIndex: src.length };
}

function readPartialJsonValue(
  src: string,
  start: number,
  depth: number,
): PartialJsonReadResult | undefined {
  if (depth > 4) return undefined;
  const i = skipJsonWhitespace(src, start);
  if (i >= src.length) return undefined;
  const ch = src[i];
  if (ch === '"') return readPartialJsonString(src, i);
  if (ch === '{') return readPartialJsonObject(src, i, depth);
  if (ch === '[') {
    const arr: unknown[] = [];
    let pos = skipJsonWhitespace(src, i + 1);
    if (pos >= src.length) return { value: arr, complete: false, nextIndex: pos };
    if (src[pos] === ']') return { value: arr, complete: true, nextIndex: pos + 1 };
    while (pos < src.length) {
      pos = skipJsonWhitespace(src, pos);
      if (pos >= src.length) return { value: arr, complete: false, nextIndex: pos };
      const elem = readPartialJsonValue(src, pos, depth + 1);
      if (!elem) return { value: arr, complete: false, nextIndex: src.length };
      if (elem.complete || (typeof elem.value === 'string' && elem.value !== '' && elem.value !== '…')) {
        arr.push(elem.value);
      }
      if (!elem.complete) return { value: arr, complete: false, nextIndex: src.length };
      pos = skipJsonWhitespace(src, elem.nextIndex);
      if (pos >= src.length) return { value: arr, complete: false, nextIndex: pos };
      if (src[pos] === ',') {
        pos += 1;
        continue;
      }
      if (src[pos] === ']') return { value: arr, complete: true, nextIndex: pos + 1 };
      return { value: arr, complete: false, nextIndex: src.length };
    }
    return { value: arr, complete: false, nextIndex: src.length };
  }
  if (src.startsWith('true', i)) return { value: true, complete: true, nextIndex: i + 4 };
  if (src.startsWith('false', i)) return { value: false, complete: true, nextIndex: i + 5 };
  if (src.startsWith('null', i)) return { value: null, complete: true, nextIndex: i + 4 };
  const numMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
  if (numMatch) {
    const nextIndex = i + numMatch[0].length;
    const hitEof = nextIndex >= src.length || (nextIndex === src.length - 1 && src[nextIndex] === '…');
    return { value: Number(numMatch[0]), complete: !hitEof, nextIndex };
  }
  return undefined;
}

interface ParsedNestedSendToArgs {
  args: Record<string, unknown>;
  textTruncated: boolean;
  scopeIdTruncated: boolean;
}

/** 安全解析 codemode 嵌套 send_to 的 JSON 参数（兼容完整 JSON 与截断的 argsPreview，绝不抛错或臆造字段）。 */
function parseNestedSendToArgs(raw: unknown): ParsedNestedSendToArgs | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, textTruncated: false, scopeIdTruncated: false };
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, textTruncated: false, scopeIdTruncated: false };
    }
    return undefined;
  } catch {
    const partial = readPartialJsonObject(trimmed, 0, 0);
    if (!partial?.fields) return undefined;
    const out: Record<string, unknown> = {};
    let textTruncated = false;
    let scopeIdTruncated = false;
    const scopeField = partial.fields.get('scopeId');
    if (scopeField && typeof scopeField.value === 'string') {
      if (scopeField.complete) {
        if (scopeField.value.trim()) out.scopeId = scopeField.value;
      } else {
        scopeIdTruncated = true;
      }
    }
    const textField = partial.fields.get('text');
    if (textField && typeof textField.value === 'string') {
      out.text = textField.value;
      if (!textField.complete) textTruncated = true;
    }
    const filesField = partial.fields.get('files');
    if (filesField && Array.isArray(filesField.value)) {
      const files = filesField.value.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      );
      if (files.length > 0) out.files = files;
    }
    if (Object.keys(out).length === 0 && !scopeIdTruncated) return undefined;
    return { args: out, textTruncated, scopeIdTruncated };
  }
}

/** 安全解析 codemode 嵌套 ensure_dm 的 peer 参数（要求 botId/deviceId 完整未截断）。 */
function parseNestedEnsureDmPeer(raw: unknown): { deviceId?: string; botId: string } | undefined {
  const fromObject = (obj: Record<string, unknown>): { deviceId?: string; botId: string } | undefined => {
    const peer = asRecord(obj.peer);
    const target = Object.keys(peer).length > 0 ? peer : obj;
    const botId = readString(target.botId);
    if (!botId) return undefined;
    const deviceId = readString(target.deviceId);
    return deviceId ? { deviceId, botId } : { botId };
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return fromObject(raw as Record<string, unknown>);
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? fromObject(parsed as Record<string, unknown>)
      : undefined;
  } catch {
    const partial = readPartialJsonObject(trimmed, 0, 0);
    if (!partial?.fields) return undefined;
    const peerFields = partial.fields.get('peer')?.fields ?? partial.fields;
    const botIdField = peerFields.get('botId');
    if (!botIdField?.complete || typeof botIdField.value !== 'string') return undefined;
    const botId = readString(botIdField.value);
    if (!botId) return undefined;
    const deviceIdField = peerFields.get('deviceId');
    const deviceId =
      deviceIdField?.complete && typeof deviceIdField.value === 'string'
        ? readString(deviceIdField.value)
        : undefined;
    return deviceId ? { deviceId, botId } : { botId };
  }
}

function recordScopeHintsFromToolOutput(
  ctx: KnownScopeContext,
  toolName: string,
  outputJsonText: string | undefined,
  selfBotId: string | undefined,
  knownBots: readonly KnownBotSummary[] | undefined,
): void {
  if (!outputJsonText) return;
  if (
    toolName !== 'ensure_dm' &&
    toolName !== 'list_scopes' &&
    toolName !== 'create_room' &&
    toolName !== 'send_to' &&
    toolName !== 'codemode'
  ) {
    return;
  }
  try {
    const parsedRoot: unknown = JSON.parse(outputJsonText);
    const pickPeerName = (membersRaw: unknown): string | undefined => {
      const members = asArray<unknown>(membersRaw);
      for (const memberRaw of members) {
        const member = asRecord(memberRaw);
        const botId = readString(member.botId);
        const deviceId = readString(member.deviceId);
        if (!botId || (selfBotId && botId === selfBotId)) continue;
        return resolveBotDisplayName(knownBots, botId, deviceId);
      }
      return undefined;
    };
    if (toolName === 'codemode') {
      let visited = 0;
      const walk = (node: unknown, depth: number) => {
        if (depth > 4 || visited >= 64 || !node || typeof node !== 'object') return;
        visited += 1;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
          return;
        }
        const obj = node as Record<string, unknown>;
        const scopeId = readString(obj.scopeId);
        if (scopeId) {
          const explicitKind =
            obj.scopeKind === 'dm' || obj.scopeKind === 'room' ? obj.scopeKind : undefined;
          if (explicitKind) {
            const peerName =
              readString(obj.targetName) ??
              resolveBotDisplayName(knownBots, readString(obj.peerBotId));
            recordScopeHint(ctx, scopeId, explicitKind, peerName);
          } else if ((obj.kind === 'dm' || obj.kind === 'room') && Array.isArray(obj.members)) {
            recordScopeHint(
              ctx,
              scopeId,
              obj.kind,
              obj.kind === 'dm' ? pickPeerName(obj.members) : undefined,
            );
          }
        }
        for (const val of Object.values(obj)) {
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      };
      walk(parsedRoot, 0);
      return;
    }
    const parsed = asRecord(parsedRoot);
    if (toolName === 'send_to') {
      const scopeId = readString(parsed.scopeId);
      const kind = parsed.scopeKind === 'dm' || parsed.scopeKind === 'room' ? parsed.scopeKind : undefined;
      const peerName = readString(parsed.targetName) ?? resolveBotDisplayName(knownBots, readString(parsed.peerBotId));
      recordScopeHint(ctx, scopeId, kind, peerName);
      return;
    }
    if (toolName === 'ensure_dm' || toolName === 'create_room') {
      const scopeObj = asRecord(parsed.scope);
      const target = Object.keys(scopeObj).length > 0 ? scopeObj : parsed;
      const scopeId = readString(target.scopeId) ?? readString(parsed.scopeId);
      const kind =
        target.kind === 'dm' || target.kind === 'room'
          ? target.kind
          : toolName === 'ensure_dm'
            ? 'dm'
            : 'room';
      recordScopeHint(ctx, scopeId, kind, kind === 'dm' ? pickPeerName(target.members) : undefined);
      return;
    }
    if (toolName === 'list_scopes') {
      for (const entryRaw of asArray<unknown>(parsed.scopes ?? parsed.items)) {
        const entry = asRecord(entryRaw);
        const scopeObj = asRecord(entry.scope);
        const target = Object.keys(scopeObj).length > 0 ? scopeObj : entry;
        const scopeId = readString(target.scopeId);
        const kind = target.kind === 'dm' || target.kind === 'room' ? target.kind : undefined;
        recordScopeHint(ctx, scopeId, kind, kind === 'dm' ? pickPeerName(target.members) : undefined);
      }
    }
  } catch {
    // Ignore non-JSON tool output.
  }
}

interface ApplySendToOptions {
  scopeCtx?: KnownScopeContext;
  fallbackScopeKind?: 'dm' | 'room';
  fallbackScopeId?: string;
  hintScopeKind?: 'dm' | 'room';
  hintTargetName?: string;
  textTruncated?: boolean;
  scopeIdTruncated?: boolean;
}

function applySendToMetadata(
  tool: ChatToolCallItem,
  args: Record<string, unknown> | undefined,
  outputJsonText: string | undefined,
  knownBots: readonly KnownBotSummary[] | undefined,
  options?: ApplySendToOptions,
): void {
  if (tool.name !== 'send_to') return;
  const current: SendToToolPreview = { ...(tool.sendTo ?? {}) };
  let argScopeId: string | undefined;
  if (args) {
    argScopeId = readString(args.scopeId);
    const rawText = typeof args.text === 'string' ? args.text.trim() : '';
    const files = Array.isArray(args.files) ? args.files.length : 0;
    if (files > 0) current.fileCount = files;
    if (rawText) {
      if (files === 0 && !options?.textTruncated && isSilentPassText(rawText)) {
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
      if (!argScopeId) argScopeId = readString(parsed.scopeId);
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
  const matchesTurnScope =
    (!argScopeId && !options?.scopeIdTruncated) ||
    (argScopeId !== undefined && options?.fallbackScopeId !== undefined && argScopeId === options.fallbackScopeId);
  if (!current.scopeKind && argScopeId && options?.scopeCtx?.kinds.has(argScopeId)) {
    current.scopeKind = options.scopeCtx.kinds.get(argScopeId);
  }
  if (!current.scopeKind && matchesTurnScope && options?.fallbackScopeKind) {
    current.scopeKind = options.fallbackScopeKind;
  }
  if (!current.scopeKind && options?.hintScopeKind) {
    current.scopeKind = options.hintScopeKind;
  }
  const lookupScopeId = argScopeId ?? (!options?.scopeIdTruncated ? options?.fallbackScopeId : undefined);
  if (!current.targetName && lookupScopeId && options?.scopeCtx?.dmPeerNames.has(lookupScopeId)) {
    current.targetName = options.scopeCtx.dmPeerNames.get(lookupScopeId);
  }
  if (!current.targetName && options?.hintTargetName) {
    current.targetName = options.hintTargetName;
  }
  if (
    current.category === undefined &&
    !current.silentPass &&
    current.scopeKind === 'dm' &&
    options?.fallbackScopeKind === 'dm' &&
    matchesTurnScope
  ) {
    current.category = 'reply';
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

interface CodemodeEnrichContext {
  knownBots: readonly KnownBotSummary[] | undefined;
  scopeCtx: KnownScopeContext;
  fallbackScopeKind?: 'dm' | 'room';
  fallbackScopeId?: string;
  rawArgsById?: ReadonlyMap<string, unknown>;
}

function extractCodemodeSendToReceipts(outputJsonText: string | undefined): Map<string, string> {
  const receipts = new Map<string, string>();
  if (!outputJsonText) return receipts;
  try {
    const parsed: unknown = JSON.parse(outputJsonText);
    let visited = 0;
    const walk = (node: unknown, depth: number) => {
      if (depth > 4 || visited >= 64 || !node || typeof node !== 'object') return;
      visited += 1;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      const obj = node as Record<string, unknown>;
      const scopeId = readString(obj.scopeId);
      if (
        scopeId &&
        (obj.scopeKind === 'dm' || obj.scopeKind === 'room') &&
        (obj.status === 'stored' ||
          obj.status === 'silent_pass' ||
          obj.category === 'request' ||
          obj.category === 'reply' ||
          obj.category === 'public' ||
          obj.category === 'notice')
      ) {
        if (!receipts.has(scopeId)) {
          receipts.set(scopeId, JSON.stringify(obj));
        }
      }
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') walk(val, depth + 1);
      }
    };
    walk(parsed, 0);
  } catch {
    // Ignore non-JSON codemode output.
  }
  return receipts;
}

/** 按执行顺序为 codemode 的嵌套 send_to 补齐元数据与前置 ensure_dm 推导的对端信息。 */
function enrichCodemodeChildren(
  parent: ChatToolCallItem,
  ctx: CodemodeEnrichContext,
): void {
  if (parent.name !== 'codemode' || !parent.children?.length) return;
  const outputReceipts = extractCodemodeSendToReceipts(parent.output);
  let pendingEnsureDms: Array<{ peerName?: string }> = [];
  let lastScopeProducer: 'dm' | 'room' | 'unknown' | null = null;

  for (const child of parent.children) {
    const rawArgs = ctx.rawArgsById?.get(child.id) ?? child.args ?? child.argSummary;
    const childFailed =
      child.status === 'error' ||
      child.status === 'cancelled' ||
      child.status === 'interrupted' ||
      child.outcome === 'error' ||
      child.outcome === 'cancelled' ||
      child.outcome === 'interrupted';

    if (child.name === 'ensure_dm' && !childFailed) {
      const peer = parseNestedEnsureDmPeer(rawArgs);
      const peerName = peer ? resolveBotDisplayName(ctx.knownBots, peer.botId, peer.deviceId) : undefined;
      if (lastScopeProducer !== 'dm') pendingEnsureDms = [];
      pendingEnsureDms.push({ peerName });
      lastScopeProducer = 'dm';
      continue;
    }
    if (child.name === 'create_room' && !childFailed) {
      pendingEnsureDms = [];
      lastScopeProducer = 'room';
      continue;
    }
    if (child.name === 'list_scopes' && !childFailed) {
      pendingEnsureDms = [];
      lastScopeProducer = 'unknown';
      continue;
    }
    if (child.name !== 'send_to') continue;

    const parsed = parseNestedSendToArgs(rawArgs);
    const argScopeId = parsed ? readString(parsed.args.scopeId) : undefined;
    const knownKind = argScopeId ? ctx.scopeCtx.kinds.get(argScopeId) : undefined;
    let hintScopeKind: 'dm' | 'room' | undefined;
    let hintTargetName: string | undefined;

    if ((!knownKind || knownKind === 'dm') && lastScopeProducer === 'dm' && pendingEnsureDms.length > 0) {
      const existingPeerName = argScopeId ? ctx.scopeCtx.dmPeerNames.get(argScopeId) : undefined;
      if (!knownKind) hintScopeKind = 'dm';
      if (pendingEnsureDms.length === 1) {
        const candidatePeer = pendingEnsureDms[0].peerName;
        if (!existingPeerName) {
          hintTargetName = candidatePeer;
          if (argScopeId) {
            recordScopeHint(ctx.scopeCtx, argScopeId, 'dm', hintTargetName);
          }
          pendingEnsureDms.shift();
        } else if (candidatePeer && candidatePeer === existingPeerName) {
          pendingEnsureDms.shift();
        }
      } else if (!knownKind && argScopeId) {
        recordScopeHint(ctx.scopeCtx, argScopeId, 'dm', undefined);
      }
    }

    const receiptLookupScopeId = argScopeId ?? (!parsed?.scopeIdTruncated ? ctx.fallbackScopeId : undefined);
    const matchedOutput =
      child.output ||
      (receiptLookupScopeId ? outputReceipts.get(receiptLookupScopeId) : undefined);

    applySendToMetadata(child, parsed?.args, matchedOutput, ctx.knownBots, {
      scopeCtx: ctx.scopeCtx,
      fallbackScopeKind: ctx.fallbackScopeKind,
      fallbackScopeId: ctx.fallbackScopeId,
      hintScopeKind,
      hintTargetName,
      textTruncated: parsed?.textTruncated,
      scopeIdTruncated: parsed?.scopeIdTruncated,
    });
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
  if (
    kind === 'host' &&
    (raw.sourceType === 'schedule' ||
      raw.sourceType === 'webhook' ||
      raw.sourceType === 'task_dispatch' ||
      raw.sourceType === 'google-workspace-rule' ||
      raw.sourceType === 'google-workspace-assistant')
  ) {
    out.sourceType = raw.sourceType;
  }
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
  if (item.kind === 'pi.compaction') return undefined;
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
  if (item.kind === 'host.scope-message' || item.kind === 'pi.compaction') return undefined;
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

const MAX_DURABLE_WAITS = 64;
const MAX_DURABLE_WAIT_ID_LEN = 1024;

function questionnaireKey(value: unknown): string | null {
  const p = asRecord(value);
  if (
    p.kind !== 'questionnaire' ||
    p.version !== 1 ||
    typeof p.installationId !== 'string' ||
    !p.installationId.trim() ||
    p.installationId.length > MAX_DURABLE_WAIT_ID_LEN ||
    !Number.isSafeInteger(p.conversationId) ||
    (p.conversationId as number) < 1 ||
    typeof p.requestId !== 'string' ||
    !p.requestId.trim() ||
    p.requestId.length > MAX_DURABLE_WAIT_ID_LEN
  ) {
    return null;
  }
  return JSON.stringify([p.installationId, p.conversationId, p.requestId]);
}

function parseActiveDurableWaits(durableWaits: unknown): Set<string> | null {
  if (!Array.isArray(durableWaits) || durableWaits.length > MAX_DURABLE_WAITS) {
    return null;
  }
  const active = new Set<string>();
  for (const identity of durableWaits) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
    const rec = identity as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.some((k) => k !== 'installationId' && k !== 'conversationId' && k !== 'requestId')) {
      return null;
    }
    const key = questionnaireKey({
      kind: 'questionnaire',
      version: 1,
      installationId: rec.installationId,
      conversationId: rec.conversationId,
      requestId: rec.requestId,
    });
    if (key === null) return null;
    active.add(key);
  }
  return active;
}

/** Preserve full raw tool output/arguments, but use current Host interaction
 * state. A live identity disappearing revokes even a cached/out-of-window card.
 * Details cannot self-authorize: only the complete live durableWaits set can
 * (absent = unsupported -> historical durable wait read-only; [] = known none). */
export function mergeHistoryWaitProjection(
  raw: Record<string, unknown>,
  live: Record<string, unknown> | undefined,
  durableWaits: unknown,
): Record<string, unknown> {
  const active = parseActiveDurableWaits(durableWaits);
  const latest = new Map<string, Record<string, unknown>>();
  if (Array.isArray(live?.messages)) {
    for (const message of live.messages) {
      const m = asRecord(message);
      if (m.role === 'toolResult' && typeof m.toolCallId === 'string') latest.set(m.toolCallId, m);
    }
  }
  const isRawModelEntry = Array.isArray(raw.model);
  const entryTaskId = raw.byTaskId;
  const matchesEntryTask = (p: Record<string, unknown>, requireTaskMatch: boolean): boolean => {
    if (!requireTaskMatch && entryTaskId === undefined) return true;
    return (
      Number.isSafeInteger(entryTaskId) &&
      (entryTaskId as number) >= 1 &&
      p.requestId === String(entryTaskId)
    );
  };
  const overlay = (value: unknown, fromRawModel: boolean) => {
    const message = asRecord(value);
    if (message.role !== 'toolResult') return value;
    const hasRawDetails =
      message.details !== null && typeof message.details === 'object' && !Array.isArray(message.details);
    const rawDetails = hasRawDetails ? (message.details as Record<string, unknown>) : {};
    const cleanDetails = hasRawDetails && 'durableWait' in rawDetails
      ? (() => {
          const { durableWait: _forged, ...rest } = rawDetails;
          return rest;
        })()
      : rawDetails;
    const isQuestionnaireTool = message.toolName === 'ask_user_question';
    const oldPresentation = message.presentation ?? cleanDetails.presentation;
    const key = isQuestionnaireTool ? questionnaireKey(oldPresentation) : null;
    const fresh = typeof message.toolCallId === 'string' ? latest.get(message.toolCallId) : undefined;
    const freshPresentation = fresh?.presentation;
    const same = key !== null && questionnaireKey(freshPresentation) === key;
    const presentation = same ? asRecord(freshPresentation) : asRecord(oldPresentation);
    const outcome = readToolOutcome(message.outcome);
    const notFailed =
      message.isError !== true &&
      outcome !== 'error' &&
      outcome !== 'cancelled' &&
      outcome !== 'interrupted';
    const allowed =
      active !== null &&
      key !== null &&
      notFailed &&
      matchesEntryTask(presentation, fromRawModel) &&
      active.has(key) &&
      presentation.status === 'pending' &&
      isQuestionnaireTool;
    return {
      ...message,
      durableWait: allowed,
      ...(same
        ? {
            presentation,
            ...(hasRawDetails ? { details: { ...cleanDetails, presentation } } : {}),
          }
        : hasRawDetails && 'durableWait' in rawDetails
          ? { details: cleanDetails }
          : {}),
    };
  };
  const { durableWait: _forgedEntryFlag, ...safeRaw } = raw;
  return {
    ...safeRaw,
    ...(isRawModelEntry ? { model: (raw.model as unknown[]).map((m) => overlay(m, true)) } : {}),
    ...(Array.isArray(raw.messages) ? { messages: raw.messages.map((m) => overlay(m, false)) } : {}),
  };
}

export interface ScopedLiveBinding {
  scopeKey: string;
  botKey: string;
  conversationId: string;
  transportKey: string;
}

export interface ScopedLiveState<TState> extends ScopedLiveBinding {
  state: TState;
}

export function matchesScopedLiveBinding(
  current: ScopedLiveBinding | null | undefined,
  expected: ScopedLiveBinding | null | undefined,
): boolean {
  if (!current || !expected) return false;
  return (
    current.scopeKey === expected.scopeKey &&
    current.botKey === expected.botKey &&
    current.conversationId === expected.conversationId &&
    current.transportKey === expected.transportKey
  );
}

const GENERIC_DONE_SUMMARIES = new Set(['任务已完成', '任务已取消', '已完成']); // i18n-ok

function extractTaskOutputSummary(output: string | undefined): string {
  if (!output) return '';
  const match =
    /(?:^|\n)摘要:\s*([\s\S]*?)(?=\n(?:待回应\s*\[|需求变更\s*\[|步骤:|任务已标记完成|所有有效步骤均已完成)|$)/.exec( // i18n-ok
      output,
    );
  if (!match) return '';
  const trimmed = match[1].trim();
  return GENERIC_DONE_SUMMARIES.has(trimmed) ? '' : trimmed;
}

function readSingleToolTaskReply(tool: ChatToolCallItem): string {
  if (
    tool.status === 'error' ||
    tool.status === 'cancelled' ||
    tool.status === 'interrupted' ||
    tool.outcome === 'error' ||
    tool.outcome === 'cancelled' ||
    tool.outcome === 'interrupted'
  ) {
    return '';
  }
  const pres = tool.presentation;
  if (pres && pres.kind === 'task' && pres.status === 'done') {
    const argSummary = typeof tool.args?.summary === 'string' ? tool.args.summary.trim() : '';
    if (argSummary && !GENERIC_DONE_SUMMARIES.has(argSummary)) return argSummary;
    const outSummary = extractTaskOutputSummary(tool.output);
    if (outSummary) return outSummary;
    const presSummary = typeof pres.summary === 'string' ? pres.summary.trim() : '';
    if (presSummary && !GENERIC_DONE_SUMMARIES.has(presSummary)) return presSummary;
  }
  if (tool.name === 'task' && tool.args) {
    const action = tool.args.action;
    const status = tool.args.status;
    if (action === 'complete' || (action === 'update' && status === 'done')) {
      const argSummary = typeof tool.args.summary === 'string' ? tool.args.summary.trim() : '';
      if (argSummary && !GENERIC_DONE_SUMMARIES.has(argSummary)) return argSummary;
    }
    if (action === 'update_step' && status === 'done') {
      const stepRes =
        typeof tool.args.resultSummary === 'string' ? tool.args.resultSummary.trim() : '';
      if (stepRes && !GENERIC_DONE_SUMMARIES.has(stepRes)) return stepRes;
    }
  }
  return '';
}

function extractCompletedTaskReply(tools: readonly ChatToolCallItem[]): string {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (tool.children && tool.children.length > 0) {
      for (let j = tool.children.length - 1; j >= 0; j -= 1) {
        const childReply = readSingleToolTaskReply(tool.children[j]);
        if (childReply) return childReply;
      }
    }
    const direct = readSingleToolTaskReply(tool);
    if (direct) return direct;
  }
  return '';
}

const SILENT_PROACTIVE_PASS_RE = /^\(?\s*pass\s*\)?\.?$/i;

function isSilentProactiveAssistantText(text: string | undefined): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed === '' || SILENT_PROACTIVE_PASS_RE.test(trimmed);
}

function isProactiveGoogleAssistantTrigger(turn: ChatTurn | null | undefined): boolean {
  return Boolean(
    turn &&
      turn.role === 'user' &&
      turn.attribution?.kind === 'host' &&
      turn.attribution?.sourceType === 'google-workspace-assistant',
  );
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
  let lastBoundaryScopeId: string | undefined;
  let lastUserTriggerTurn: ChatTurn | null = null;
  const silentEmptyTriggerIds = new Set<string>();
  const silentEmptyReplyTos = new Set<string>();

  const selfBotId = typeof options?.selfBotId === 'string' ? options.selfBotId : undefined;
  const knownBots = options?.knownBots;
  const scopeCtx: KnownScopeContext = {
    kinds: new Map(),
    dmPeerNames: new Map(),
  };
  // 预扫历史中的权威 scope 边界（host.scope-message / host.work-trigger），
  // 让先于 selfEcho 或对端回信发生的 codemode 嵌套 send_to 也能准确识别 scopeKind 与对端名称。
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'pi.compaction') continue;
    const numericId = typeof item.id === 'number' ? item.id : Number(item.id);
    if (clearedAfterEntryId > 0 && Number.isFinite(numericId) && numericId <= clearedAfterEntryId) {
      continue;
    }
    if (item.kind === 'host.work-trigger') {
      const target = asRecord(asRecord(asRecord(item.data).turn).replyTarget);
      const targetKind = target.kind === 'dm' || target.kind === 'room' ? target.kind : undefined;
      const targetScopeId = readString(target.scopeId);
      const targetPeerName =
        targetKind === 'dm'
          ? resolveBotDisplayName(knownBots, readString(target.botId), readString(target.deviceId))
          : undefined;
      recordScopeHint(scopeCtx, targetScopeId, targetKind, targetPeerName);
    } else if (item.kind === 'host.scope-message') {
      const itemAttr = enrichAttributionName(entryAttribution(item, selfBotId), knownBots);
      const isSelfEcho = asRecord(item.data).selfEcho === true || itemAttr?.direction === 'outgoing';
      if (itemAttr?.scopeId && (itemAttr.channel === 'dm' || itemAttr.channel === 'room')) {
        recordScopeHint(scopeCtx, itemAttr.scopeId, itemAttr.channel, !isSelfEcho ? itemAttr.name : undefined);
      }
    }
  }
  const hasDurableWaitsOption = options !== undefined && Object.prototype.hasOwnProperty.call(options, 'durableWaits');
  const activeDurableWaits = hasDurableWaitsOption ? parseActiveDurableWaits(options?.durableWaits) : null;
  const isAuthorizedWait = (presentation: Record<string, unknown> | null): boolean => {
    const key = questionnaireKey(presentation);
    if (key === null) return false;
    return !hasDurableWaitsOption || (activeDurableWaits !== null && activeDurableWaits.has(key));
  };

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
    const effectiveScopeId =
      attribution?.scopeId ??
      (effectiveChannel === 'dm' || effectiveChannel === 'room' ? lastBoundaryScopeId : undefined);
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
      ...(effectiveChannel === 'dm' && attribution?.channel !== 'dm' ? { dmChannel: true as const } : {}),
      ...(collaborative ? { collaborative: true } : {}),
    };
    turns.push(turn);
    currentAssistant = {
      originKey: attribution ? attributionKey(attribution) : '',
      channel: effectiveChannel,
      ...(effectiveScopeId ? { dmScopeId: effectiveScopeId } : {}),
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
    const fallbackScopeKind = acc.channel === 'dm' || acc.channel === 'room' ? acc.channel : undefined;
    const fallbackScopeId = acc.turn.attribution?.scopeId ?? acc.dmScopeId;
    const existing = acc.tools.find((itemTool) => itemTool.id === toolId);
    if (existing) {
      if (args && !existing.args) existing.args = args;
      if (summary && !existing.argSummary) existing.argSummary = summary;
      applySendToMetadata(existing, args, existing.output, knownBots, {
        scopeCtx,
        fallbackScopeKind,
        fallbackScopeId,
      });
      return existing;
    }
    const tool: ChatToolCallItem = {
      id: toolId,
      name,
      status: 'running',
      ...(args ? { args } : {}),
      ...(summary ? { argSummary: summary } : {}),
    };
    applySendToMetadata(tool, args, undefined, knownBots, {
      scopeCtx,
      fallbackScopeKind,
      fallbackScopeId,
    });
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

    let joinedTurnText = acc.textParts.filter(Boolean).join('\n\n').trim();
    let synthesizedReply = '';
    if (!isStillActive && acc.tools.length > 0) {
      const taskReply = extractCompletedTaskReply(acc.tools);
      if (taskReply) {
        const probe = taskReply.slice(0, Math.min(16, taskReply.length));
        const missingOrTinyAck =
          joinedTurnText === '' ||
          (joinedTurnText.length < 24 &&
            taskReply.length > joinedTurnText.length * 2 &&
            !joinedTurnText.includes(probe));
        if (missingOrTinyAck) {
          synthesizedReply = taskReply;
          joinedTurnText = joinedTurnText ? `${joinedTurnText}\n\n${taskReply}` : taskReply;
          if (options?.trackAssistantTextEntries && acc.turn.entryId > 0) {
            (acc.turn.assistantTextEntryIds ??= []).push(String(acc.turn.entryId));
          }
        }
      }
    }
    acc.turn.text = joinedTurnText;
    acc.turn.thinking = acc.thinkingParts.length > 0 ? acc.thinkingParts.join('\n\n') : undefined;
    acc.turn.tools = acc.tools.length > 0 ? acc.tools : undefined;
    acc.turn.toolSummary = acc.tools.length > 0 ? acc.tools.map((tool) => tool.name) : undefined;
    // 稳定的块 key：
    // - 按类型独立编号且空块照样占位递增，避免空块转非空或 raw 历史补入 thinking 时
    //   导致后续 text/tools 块的 key 漂移与 React 重挂；
    // - tools 块优先锚定组内首个工具的稳定 callId，跨流式/补入/2→3 合并全程不变。
    const out: ChatTurnBlock[] = [];
    const usedBlockIds = new Set<string>();
    const claimBlockId = (baseId: string): string => {
      if (!usedBlockIds.has(baseId)) {
        usedBlockIds.add(baseId);
        return baseId;
      }
      let suffix = 2;
      while (usedBlockIds.has(`${baseId}-${suffix}`)) suffix += 1;
      const unique = `${baseId}-${suffix}`;
      usedBlockIds.add(unique);
      return unique;
    };
    let textSeq = 0;
    let thinkingSeq = 0;
    let toolsSeq = 0;
    for (const block of acc.blocks) {
      if (block.kind === 'tools') {
        toolsSeq += 1;
        if (block.tools.length === 0) continue;
        const anchorToolId = block.tools[0]?.id;
        const baseId = anchorToolId
          ? `${acc.turn.id}-tools-${anchorToolId}`
          : `${acc.turn.id}-tools-${toolsSeq}`;
        out.push({ id: claimBlockId(baseId), kind: 'tools', tools: block.tools });
      } else if (block.kind === 'thinking') {
        thinkingSeq += 1;
        const text = block.text.trim();
        if (!text) continue;
        out.push({
          id: claimBlockId(`${acc.turn.id}-thinking-${thinkingSeq}`),
          kind: 'thinking',
          text,
        });
      } else {
        textSeq += 1;
        const text = block.text.trim();
        if (!text) continue;
        out.push({
          id: claimBlockId(`${acc.turn.id}-b${textSeq}`),
          kind: 'text',
          text,
          ...(block.entryId !== undefined ? { entryId: block.entryId } : {}),
        });
      }
    }
    if (synthesizedReply) {
      textSeq += 1;
      const entryId =
        options?.trackAssistantTextEntries && acc.turn.entryId > 0
          ? String(acc.turn.entryId)
          : undefined;
      out.push({
        id: claimBlockId(`${acc.turn.id}-b${textSeq}`),
        kind: 'text',
        text: synthesizedReply,
        ...(entryId !== undefined ? { entryId } : {}),
      });
    }
    let lastToolIdx = -1;
    for (let idx = out.length - 1; idx >= 0; idx -= 1) {
      if (out[idx].kind === 'tools') {
        lastToolIdx = idx;
        break;
      }
    }
    if (lastToolIdx > 0) {
      for (let idx = 0; idx < lastToolIdx; idx += 1) {
        const block = out[idx];
        if (block.kind === 'text') {
          block.interim = true;
        }
      }
    }
    acc.turn.blocks = out.length > 0 ? out : undefined;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // SDK 压缩摘要是模型上下文边界（role='user'），不渲染气泡也不参与轮次/归属/时间/编辑判断。
    if (item.kind === 'pi.compaction') {
      continue;
    }
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
      const target = asRecord(asRecord(asRecord(item.data).turn).replyTarget);
      const targetKind = target.kind === 'dm' || target.kind === 'room' ? target.kind : undefined;
      const targetScopeId = readString(target.scopeId);
      if (c !== undefined) {
        lastBoundaryChannel = c;
        lastBoundaryScopeId = c === 'dm' || c === 'room' ? targetScopeId : undefined;
      }
      const targetPeerName =
        targetKind === 'dm'
          ? resolveBotDisplayName(knownBots, readString(target.botId), readString(target.deviceId))
          : undefined;
      recordScopeHint(scopeCtx, targetScopeId, targetKind, targetPeerName);
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
      if (itemAttr?.scopeId && (itemAttr.channel === 'dm' || itemAttr.channel === 'room')) {
        recordScopeHint(scopeCtx, itemAttr.scopeId, itemAttr.channel, !isSelfEcho ? itemAttr.name : undefined);
      }
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
            timestamp: ts,
            attribution: itemAttr,
            ...(itemAttr.createdAt ? { createdAt: itemAttr.createdAt } : {}),
          });
        }
      }
      continue;
    }
    // 最新执行来源 channel：真实用户消息/生成归属/host 触发边界，scope 导入跳过。
    const itemChannel = entryChannel(item, selfBotId);
    if (itemChannel !== undefined) {
      lastBoundaryChannel = itemChannel;
      lastBoundaryScopeId =
        itemChannel === 'dm' || itemChannel === 'room' ? itemAttr?.scopeId : undefined;
    }
    // raw 条目用 model 块（含工具/思考）；Host live 投影条目有 messages:[{role,text,truncated,toolCalls,timestamp,durationMs}]。
    // host.user-message 的图片附件元数据在条目级 data.attachments（不在单个 message 上）。
    const itemData = asRecord(item.data);
    const entryAttachments = readMessageAttachments(itemData.attachments);
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
        let joinedText = '';
        if (typeof itemData.userText === 'string' && (item.kind === 'host.user-message' || mIdx === 0)) {
          joinedText = itemData.userText.trim();
        } else if (typeof content === 'string') {
          joinedText = (attachments.length > 0
            ? stripTrailingHostAttachmentLines(content, attachments.length)
            : content).trim();
        } else if (typeof entry.text === 'string') {
          joinedText = (attachments.length > 0
            ? stripTrailingHostAttachmentLines(entry.text, attachments.length)
            : entry.text).trim();
        } else if (Array.isArray(content)) {
          const hasImageBlock = content.some((b) => asRecord(b).type === 'image');
          let end = content.length;
          let strippedHostBlock = false;
          if (attachments.length > 0 || hasImageBlock) {
            while (end > 0) {
              const prev = asRecord(content[end - 1]);
              if (prev.type === 'image') {
                end -= 1;
                continue;
              }
              if (
                prev.type === 'text' &&
                typeof prev.text === 'string' &&
                prev.text.startsWith(HOST_ATTACHED_IMAGE_LINE_PREFIX) &&
                (asRecord(content[end]).type === 'image' || isHostInjectedAttachmentLine(prev.text))
              ) {
                strippedHostBlock = true;
                end -= 1;
                continue;
              }
              break;
            }
          }
          const textParts: string[] = [];
          for (const block of content.slice(0, end)) {
            if (typeof block === 'string') {
              textParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text);
            }
          }
          const rawJoined = textParts.join('\n');
          joinedText = (!strippedHostBlock && attachments.length > 0
            ? stripTrailingHostAttachmentLines(rawJoined, attachments.length)
            : rawJoined).trim();
        }
        if (!joinedText && attachments.length === 0) continue;

        finalizeCurrentAssistant(false);
        activeUserStartMs = msgTimestamp;
        const userTurn: ChatTurn = {
          id: `${String(item.id ?? i)}-${mIdx}`,
          role: 'user',
          entryId: Number.isFinite(numericId) ? numericId : 0,
          text: joinedText,
          ...(attachments.length > 0 ? { attachments } : {}),
          startedAt: msgTimestamp,
          timestamp: msgTimestamp,
          ...(itemAttr ? { attribution: itemAttr } : {}),
        };
        turns.push(userTurn);
        lastUserTriggerTurn = userTurn;
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
          if (itemAttr?.replyTo) {
            silentEmptyReplyTos.add(itemAttr.replyTo);
          } else if (isProactiveGoogleAssistantTrigger(lastUserTriggerTurn)) {
            silentEmptyTriggerIds.add(lastUserTriggerTurn!.id);
          }
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
          acc.turn.timestamp = msgTimestamp;
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
        const durableWait =
          entry.durableWait === true &&
          !isError &&
          outcome === 'ok' &&
          resolvedStatus === 'done' &&
          toolName === 'ask_user_question' &&
          projectedPresentation?.kind === 'questionnaire' &&
          presentationStatus === 'pending' &&
          isAuthorizedWait(projectedPresentation);
        const matched = toolCallId ? acc.tools.find((t) => t.id === toolCallId) : undefined;
        const fallbackScopeKind = acc.channel === 'dm' || acc.channel === 'room' ? acc.channel : undefined;
        const fallbackScopeId = acc.turn.attribution?.scopeId ?? acc.dmScopeId;
        if (matched) {
          matched.status = resolvedStatus;
          matched.outcome = outcome;
          matched.presentationLive = durableWait;
          matched.durableWait = durableWait;
          acc.settledToolIds.add(matched.id);
          if (msgDurationMs !== undefined) matched.durationMs = msgDurationMs;
          if (resultOutput) matched.output = resultOutput;
          if (resultTruncated) matched.outputTruncated = true;
          if (projectedPresentation) {
            matched.presentation = projectedPresentation;
            matched.presentationLive = durableWait;
          }
          recordScopeHintsFromToolOutput(scopeCtx, matched.name, resultOutput || undefined, selfBotId, knownBots);
          applySendToMetadata(matched, matched.args, resultOutput || undefined, knownBots, {
            scopeCtx,
            fallbackScopeKind,
            fallbackScopeId,
          });
          readNestedCalls(matched, entry, {
            knownBots,
            scopeCtx,
            fallbackScopeKind,
            fallbackScopeId,
          });
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
            ...(projectedPresentation ? { presentation: projectedPresentation, presentationLive: durableWait, durableWait } : {}),
          };
          recordScopeHintsFromToolOutput(scopeCtx, toolName, resultOutput || undefined, selfBotId, knownBots);
          applySendToMetadata(tool, undefined, resultOutput || undefined, knownBots, {
            scopeCtx,
            fallbackScopeKind,
            fallbackScopeId,
          });
          readNestedCalls(tool, entry, {
            knownBots,
            scopeCtx,
            fallbackScopeKind,
            fallbackScopeId,
          });
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
    const liveRawArgsById = new Map<string, unknown>();
    const liveFallbackScopeKind = acc.channel === 'dm' || acc.channel === 'room' ? acc.channel : undefined;
    const liveFallbackScopeId = acc.turn.attribution?.scopeId ?? acc.dmScopeId;
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
      const slotDurableWait =
        hasPresentation &&
        slot?.durableWait === true &&
        typeof slot?.parentCallId !== 'string' &&
        (status === 'running' || status === 'done') &&
        name === 'ask_user_question' &&
        slotPresentation.kind === 'questionnaire' &&
        slotPresentation.status === 'pending' &&
        isAuthorizedWait(slotPresentation);
      if (typeof slot?.argsPreview === 'string') {
        liveRawArgsById.set(id, slot.argsPreview);
      }
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
        presentationLive: hasPresentation && (status === 'running' || slotDurableWait),
        durableWait: slotDurableWait,
      };
      recordScopeHintsFromToolOutput(scopeCtx, name, slotOutput || undefined, selfBotId, knownBots);
      const parsedSendTo = name === 'send_to' ? parseNestedSendToArgs(slot?.argsPreview) : undefined;
      applySendToMetadata(liveItem, parsedSendTo?.args, slotOutput || undefined, knownBots, {
        scopeCtx,
        fallbackScopeKind: liveFallbackScopeKind,
        fallbackScopeId: liveFallbackScopeId,
        textTruncated: parsedSendTo?.textTruncated,
        scopeIdTruncated: parsedSendTo?.scopeIdTruncated,
      });
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
    const touchedCodemodeParents = new Set<ChatToolCallItem>();
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
      if (parent.name === 'codemode') touchedCodemodeParents.add(parent);
    }
    for (const parent of touchedCodemodeParents) {
      enrichCodemodeChildren(parent, {
        knownBots,
        scopeCtx,
        fallbackScopeKind: liveFallbackScopeKind,
        fallbackScopeId: liveFallbackScopeId,
        rawArgsById: liveRawArgsById,
      });
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

  // Suppress settled silent `(pass)` / empty proactive Google Workspace assistant sweeps
  // (both host trigger bubble and assistant bubble) so background no-op checks do not clutter
  // chat, while keeping durable audit entries untouched and never hiding positive alerts,
  // errors, pending interactive prompts, or in-flight runs.
  const suppressedTurnIds = new Set<string>();
  const lastTurn = turns.at(-1) ?? null;
  const isAssistantTurnInFlight = (turn: ChatTurn): boolean =>
    Boolean(
      turn.isStreaming === true ||
        (turn.tools ?? []).some((tool) => tool.status === 'running') ||
        (isBusy && turn === lastTurn),
    );
  for (let idx = 0; idx < turns.length; idx++) {
    const trigger = turns[idx];
    if (!isProactiveGoogleAssistantTrigger(trigger)) continue;
    const triggerMessageId = trigger.attribution?.messageId;
    const matchedAssistants: ChatTurn[] = [];
    if (triggerMessageId) {
      for (const candidate of turns) {
        if (candidate.role === 'assistant' && candidate.attribution?.replyTo === triggerMessageId) {
          matchedAssistants.push(candidate);
        }
      }
    }
    if (matchedAssistants.length === 0) {
      const next = turns[idx + 1];
      if (
        next &&
        next.role === 'assistant' &&
        (!next.attribution?.replyTo || next.attribution.replyTo === triggerMessageId)
      ) {
        matchedAssistants.push(next);
      }
    }
    if (matchedAssistants.length > 0) {
      const hasNonSilentOrActive = matchedAssistants.some(
        (assistant) =>
          isAssistantTurnInFlight(assistant) ||
          Boolean(assistant.error) ||
          pendingToolPrompts(assistant.tools ?? []).length > 0 ||
          !isSilentProactiveAssistantText(assistant.text),
      );
      if (!hasNonSilentOrActive) {
        suppressedTurnIds.add(trigger.id);
        for (const assistant of matchedAssistants) suppressedTurnIds.add(assistant.id);
      }
    } else if (!(isBusy && idx === turns.length - 1)) {
      if (
        silentEmptyTriggerIds.has(trigger.id) ||
        (triggerMessageId !== undefined && silentEmptyReplyTos.has(triggerMessageId))
      ) {
        suppressedTurnIds.add(trigger.id);
      }
    }
  }

  // 1v1 对话页显示 primary（用户主聊）与 dm（1v1 Bot 私聊任务执行）轮；
  // 群聊（room）轮保持隔离在群聊页面内，不在各 Bot 的 1v1 对话页中刷屏。
  return turns.filter(
    (turn) =>
      !suppressedTurnIds.has(turn.id) &&
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

export function isActiveDurableQuestionnaireTool(tool: ChatToolCallItem): boolean {
  return (
    tool.durableWait === true &&
    tool.presentationLive === true &&
    tool.parentCallId === undefined &&
    (tool.status === 'running' || tool.status === 'done') &&
    tool.name === 'ask_user_question' &&
    tool.presentation?.kind === 'questionnaire' &&
    tool.presentation?.status === 'pending' &&
    questionnaireKey(tool.presentation) !== null
  );
}

/** Shared activation gate for ToolCallCard: ordinary live tools keep their
 *  existing `active && tool.presentationLive` semantics; durable wait
 *  activation is strictly limited to valid pending top-level questionnaires
 *  and never enables Google setup/browser, task, vault, or todo cards. */
export function resolveToolPresentationActive(
  tool: ChatToolCallItem,
  presentation: { kind?: unknown; status?: unknown } | null | undefined,
  active: boolean,
  disabled = false,
): boolean {
  if (!presentation) return false;
  if (active && tool.presentationLive === true) return true;
  if (disabled) return false;
  return (
    presentation.kind === 'questionnaire' &&
    presentation.status === 'pending' &&
    isActiveDurableQuestionnaireTool(tool)
  );
}

export function pendingToolPrompts(tools: readonly ChatToolCallItem[], parentRunning = true): ChatToolCallItem[] {
  return tools.flatMap(tool => {
    const presentation = tool.presentation;
    const running = tool.status === 'running';
    const prompt = parentRunning && (running
      ? tool.presentationLive && presentation?.status === 'pending' &&
        (presentation.kind === 'questionnaire' || presentation.kind === 'vault-unlock')
      : isActiveDurableQuestionnaireTool(tool));
    // The Google setup run can await user input after the tool call and its parent finish.
    const googleSetup = presentation?.kind === 'google-setup' && presentation.state === 'running' &&
      readString(presentation.runId) !== undefined && readString(presentation.card) !== undefined;
    const children = tool.children ? pendingToolPrompts(tool.children, parentRunning && running) : [];
    return prompt || googleSetup ? [tool, ...children] : children;
  });
}

export function isBotDmTurn(turn: Pick<ChatTurn, 'attribution' | 'dmChannel'> | null | undefined): boolean {
  return Boolean(turn && (turn.attribution?.channel === 'dm' || turn.dmChannel === true));
}

export function isBotDmSendToTool(
  tool: ChatToolCallItem,
  parentTurn?: Pick<ChatTurn, 'attribution' | 'dmChannel'>,
): boolean {
  if (tool.name !== 'send_to') return false;
  if (tool.sendTo?.scopeKind === 'dm') return true;
  if (tool.sendTo?.scopeKind === 'room') return false;
  return Boolean(parentTurn && isBotDmTurn(parentTurn));
}

/** 递归收集本轮顶层与 codemode 子调用中所有发往 Bot 私聊（DM）的 send_to 工具，保持执行顺序。 */
export function collectBotDmSendToTools(
  tools: readonly ChatToolCallItem[],
  parentTurn?: Pick<ChatTurn, 'attribution' | 'dmChannel'>,
): ChatToolCallItem[] {
  const result: ChatToolCallItem[] = [];
  const visit = (list: readonly ChatToolCallItem[]) => {
    for (const tool of list) {
      if (isBotDmSendToTool(tool, parentTurn)) {
        result.push(tool);
      }
      if (tool.children && tool.children.length > 0) {
        visit(tool.children);
      }
    }
  };
  visit(tools);
  return result;
}

/** 统计除 DM send_to（及 codemode 内仅做 DM 通信的 ensure_dm/send_to）之外的实际工具步数。 */
export function countNonBotDmSendTools(
  tools: readonly ChatToolCallItem[],
  parentTurn?: Pick<ChatTurn, 'attribution' | 'dmChannel'>,
): number {
  let count = 0;
  for (const tool of tools) {
    if (isBotDmSendToTool(tool, parentTurn)) continue;
    if (tool.name === 'codemode' && tool.children && tool.children.length > 0) {
      for (const child of tool.children) {
        if (child.name === 'ensure_dm' || isBotDmSendToTool(child, parentTurn)) continue;
        count += 1;
      }
      continue;
    }
    count += 1;
  }
  return count;
}

function filterToolWithoutBotDm(
  tool: ChatToolCallItem,
  turn: Pick<ChatTurn, 'attribution' | 'dmChannel'>,
): { tool: ChatToolCallItem | null; changed: boolean } {
  if (isBotDmSendToTool(tool, turn)) {
    return { tool: null, changed: true };
  }
  if (tool.name === 'codemode' && tool.children && tool.children.length > 0) {
    let anyChanged = false;
    const keptChildren: ChatToolCallItem[] = [];
    for (const child of tool.children) {
      if (child.name === 'ensure_dm' || isBotDmSendToTool(child, turn)) {
        anyChanged = true;
        continue;
      }
      const sub = filterToolWithoutBotDm(child, turn);
      if (sub.changed) anyChanged = true;
      if (sub.tool) keptChildren.push(sub.tool);
    }
    if (!anyChanged) return { tool, changed: false };
    if (keptChildren.length === 0) return { tool: null, changed: true };
    return { tool: { ...tool, children: keptChildren }, changed: true };
  }
  return { tool, changed: false };
}

/** 过滤主对话框里与其他 Bot 的私聊内容（含入站 DM、DM 触发执行轮及主聊内发往 DM 的顶层/嵌套 send_to）。 */
export function chatTurnsWithoutBotDm(turns: readonly ChatTurn[]): ChatTurn[] {
  return turns.flatMap(turn => {
    if (isBotDmTurn(turn)) return [];
    if (turn.role !== 'assistant') return [turn];
    let anyChanged = false;
    const filteredCache = new Map<ChatToolCallItem, ChatToolCallItem | null>();
    const mapTool = (tool: ChatToolCallItem): ChatToolCallItem | null => {
      if (filteredCache.has(tool)) return filteredCache.get(tool) ?? null;
      const res = filterToolWithoutBotDm(tool, turn);
      if (res.changed) anyChanged = true;
      filteredCache.set(tool, res.tool);
      return res.tool;
    };
    const blocks = turn.blocks?.flatMap<ChatTurnBlock>(block => {
      if (block.kind !== 'tools') return [block];
      const kept: ChatToolCallItem[] = [];
      for (const tool of block.tools) {
        const next = mapTool(tool);
        if (next) kept.push(next);
      }
      return kept.length > 0 ? [{ ...block, tools: kept }] : [];
    });
    const tools = turn.tools?.flatMap<ChatToolCallItem>(tool => {
      const next = mapTool(tool);
      return next ? [next] : [];
    });
    if (!anyChanged) return [turn];
    const hasTools = Boolean(tools && tools.length > 0);
    const hasBlocks = Boolean(blocks && blocks.length > 0);
    if (!turn.text.trim() && !turn.thinking?.trim() && !turn.error && !hasTools && !hasBlocks) {
      return [];
    }
    return [{
      ...turn,
      blocks: hasBlocks ? blocks : undefined,
      tools: hasTools ? tools : undefined,
      toolSummary: hasTools ? tools!.map(tool => tool.name) : undefined,
    }];
  });
}

export function chatTurnsWithoutToolOutput(
  turns: readonly ChatTurn[],
  options?: { preserveBotDmSendTo?: boolean },
): ChatTurn[] {
  const preserveDmSendTo = options?.preserveBotDmSendTo === true;
  return turns.flatMap(turn => {
    if (turn.role !== 'assistant') return [turn];
    const keepTools = (list: readonly ChatToolCallItem[]): ChatToolCallItem[] => {
      const prompts = pendingToolPrompts(list);
      if (!preserveDmSendTo) return prompts;
      const promptIds = new Set(prompts.map(item => item.id));
      const seen = new Set<string>();
      const kept: ChatToolCallItem[] = [];
      const visit = (items: readonly ChatToolCallItem[]) => {
        for (const item of items) {
          if ((isBotDmSendToTool(item, turn) || promptIds.has(item.id)) && !seen.has(item.id)) {
            seen.add(item.id);
            kept.push(item);
          }
          if (item.children && item.children.length > 0) {
            visit(item.children);
          }
        }
      };
      visit(list);
      return kept;
    };
    // Keep pending prompts (including nested ones) without showing their tool calls.
    const blocks = turn.blocks?.flatMap<ChatTurnBlock>(block => {
      if (block.kind === 'text') return [block];
      if (block.kind === 'thinking') return [];
      const kept = keepTools(block.tools);
      return kept.length > 0 ? [{ ...block, tools: kept }] : [];
    });
    const keptTools = blocks
      ? blocks.flatMap(block => block.kind === 'tools' ? block.tools : [])
      : keepTools(turn.tools ?? []);
    if (!turn.text.trim() && !turn.error && keptTools.length === 0) return [];
    return [{
      ...turn,
      blocks: blocks?.length ? blocks : undefined,
      thinking: undefined,
      toolSummary: undefined,
      tools: keptTools.length > 0 ? keptTools : undefined,
    }];
  });
}

export function hasAssistantVisibleContent(turn: ChatTurn): boolean {
  if (turn.role !== 'assistant') return true;
  if (turn.blocks && turn.blocks.length > 0) return true;
  return Boolean(
    turn.text.trim() ||
      turn.thinking?.trim() ||
      (turn.tools && turn.tools.length > 0),
  );
}

export function resolveAssistantFailureDetail(
  error: string | undefined,
  t: (zh: string, en: string) => string,
): string {
  const trimmed = typeof error === 'string' ? error.trim() : '';
  if (!trimmed) return '';
  if (trimmed === 'model_error') {
    return t('模型生成失败。', 'Model generation failed.');
  }
  return trimmed;
}

export type AssistantTurnSegment =
  | { id: string; kind: 'process'; blocks: ChatTurnBlock[] }
  | { id: string; kind: 'block'; block: ChatTurnBlock };

export interface PartitionAssistantBlocksOptions {
  isLive?: boolean;
  isPromotedToolBlock?: (tools: readonly ChatToolCallItem[]) => boolean;
}

export function partitionAssistantTurnBlocks(
  blocks: readonly ChatTurnBlock[] | undefined,
  options?: PartitionAssistantBlocksOptions,
): AssistantTurnSegment[] {
  if (!blocks || blocks.length === 0) return [];
  const isTopLevel = blocks.map((block) => {
    if (block.kind === 'thinking') return false;
    if (block.kind === 'tools') return Boolean(options?.isPromotedToolBlock?.(block.tools));
    return block.interim !== true;
  });
  if (!options?.isLive && !isTopLevel.some(Boolean)) {
    for (let idx = blocks.length - 1; idx >= 0; idx -= 1) {
      if (blocks[idx].kind === 'text') {
        isTopLevel[idx] = true;
        break;
      }
    }
  }
  const segments: AssistantTurnSegment[] = [];
  let processGroup: ChatTurnBlock[] = [];
  const flushProcess = () => {
    if (processGroup.length === 0) return;
    segments.push({
      id: `${processGroup[0].id}-process`,
      kind: 'process',
      blocks: processGroup,
    });
    processGroup = [];
  };
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx];
    if (isTopLevel[idx]) {
      flushProcess();
      segments.push({ id: block.id, kind: 'block', block });
    } else {
      processGroup.push(block);
    }
  }
  flushProcess();
  return segments;
}

export interface ProcessTimelineStep {
  id: string;
  text?: string;
  entryId?: string;
  blocks: ChatTurnBlock[];
}

export function groupProcessTimelineSteps(
  blocks: readonly ChatTurnBlock[],
): ProcessTimelineStep[] {
  const steps: ProcessTimelineStep[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      steps.push({
        id: block.id,
        text: block.text,
        ...(block.entryId !== undefined ? { entryId: block.entryId } : {}),
        blocks: [],
      });
      continue;
    }
    const prev = steps.at(-1);
    if (prev) {
      prev.blocks.push(block);
    } else {
      steps.push({ id: block.id, blocks: [block] });
    }
  }
  return steps;
}

export function resolveAssistantCopyText(
  turn: Pick<ChatTurn, 'role' | 'text' | 'blocks'>,
): string {
  if (turn.role !== 'assistant' || !turn.blocks?.length) return turn.text;
  const finalParts: string[] = [];
  for (const block of turn.blocks) {
    if (block.kind !== 'text' || block.interim) continue;
    const trimmed = block.text.trim();
    if (trimmed) finalParts.push(trimmed);
  }
  return finalParts.length > 0 ? finalParts.join('\n\n') : turn.text;
}
