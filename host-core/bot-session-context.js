// 统一 Bot 会话：每个 Bot 一条主 Durable 会话承载用户私聊 + Bot 私聊 + 普通群聊。
// 本模块只定义会话级持久状态（BotSessionState）、来源标记的安全归属（attribution）和
// 事件条目编码（createSessionMessageEntry）。执行逻辑在 runtime-bot-session.js。
// 归属只来自受信账本字段（author/scopeId/envelope），绝不从正文文本推断；
// scopeMessageAttribution 对未知/畸形 author 一律回退 bot，不采信发送方声称的 user。
import { defineDoc } from '@earendil-works/pi-durable';

export const SCOPE_MESSAGE_KIND = 'host.scope-message';
export const WORK_TRIGGER_KIND = 'host.work-trigger';
export const USER_MESSAGE_KIND = 'host.user-message';

const EXTERNAL_EVENT_PREFIX = 'External conversation event (actual author in message.author):\n';

const ATTRIBUTION_KINDS = new Set(['user', 'bot', 'host']);
const ATTRIBUTION_CHANNELS = new Set(['primary', 'dm', 'room']);
const ATTRIBUTION_CATEGORIES = new Set(['public', 'notice', 'request', 'reply']);
const ATTRIBUTION_DIRECTIONS = new Set(['incoming', 'outgoing']);

/** 会话级持久状态（latest-only）：导入水位、冻结的活动轮、发出请求与已观察回复水位。 */
export const BotSessionState = defineDoc({
  kind: 'host.bot-session',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    schema: 1,
    // 账本 localId 高水位；reset 时保留（旧账本记录不得再次导入）。
    lastImportedLocalId: 0,
    importedCount: 0,
    // 冻结的活动轮 + generation taskId -> requestId 映射（生成轮换任务/工具时归属不丢）。
    activeTurn: null,
    turnByTask: {},
    // 本 Bot 发出的 category=request 的原始来源（键 messageId），含已观察回复水位；永不删。
    outgoing: {},
    // requestId -> 冻结轮归档：历史/实时归属的来源，只要历史还在就不得裁剪。
    completedTurns: {},
    updatedAt: null,
  }),
  checkpointWhen: () => false,
});

function cleanString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 把账本/触发条目的 author 归一为受信归属：只认 kind/botId/deviceId，名字仅作展示。 */
export function senderAttribution(author, deviceId) {
  const kind = ATTRIBUTION_KINDS.has(author?.kind) ? author.kind : 'bot';
  const sender = { kind };
  if (kind === 'bot' && cleanString(author?.botId)) sender.botId = author.botId;
  const device = cleanString(deviceId) ?? cleanString(author?.deviceId);
  if (device) sender.deviceId = device;
  return sender;
}

/** 账本条目 -> 安全 UI 归属（schema 见 contract）；direction 由调用方给定。 */
export function scopeMessageAttribution(stored, scopeKind, direction) {
  const message = stored?.message ?? {};
  const author = senderAttribution(message.author, message.sourceDeviceId);
  const attribution = {
    kind: author.kind,
    channel: ATTRIBUTION_CHANNELS.has(scopeKind) ? scopeKind : 'room',
    direction: ATTRIBUTION_DIRECTIONS.has(direction) ? direction : 'incoming',
  };
  if (author.botId) attribution.botId = author.botId;
  if (author.deviceId) attribution.deviceId = author.deviceId;
  if (cleanString(message.scopeId)) attribution.scopeId = message.scopeId;
  if (cleanString(message.messageId)) attribution.messageId = message.messageId;
  if (cleanString(message.replyTo)) attribution.replyTo = message.replyTo;
  if (cleanString(message.rootId)) attribution.rootId = message.rootId;
  if (ATTRIBUTION_CATEGORIES.has(message.category)) attribution.category = message.category;
  if (cleanString(message.createdAt)) attribution.createdAt = message.createdAt;
  else if (cleanString(stored?.storedAt)) attribution.createdAt = stored.storedAt;
  return attribution;
}

/**
 * 冻结轮 -> 生成输出的安全归属：作者恒为实际执行 Bot（turn.botId/deviceId，本机身份），
 * 绝不是触发者 turn.sender；direction 恒为 outgoing；channel/scopeId 取固定 replyTarget；
 * replyTo 指触发消息（triggerMessageId）；rootId 仅当拿到真实 envelope.rootId 时才输出
 * （触发消息的直接父级 replyTo 不是根）。workNativeId、sender、对端 botId 永不外露。
 */
export function safeTurnAttribution(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const target = turn.replyTarget ?? {};
  const attribution = {
    kind: 'bot',
    channel: ATTRIBUTION_CHANNELS.has(target.kind) ? target.kind : 'primary',
    direction: 'outgoing',
  };
  if (cleanString(turn.botId)) attribution.botId = turn.botId;
  if (cleanString(turn.deviceId)) attribution.deviceId = turn.deviceId;
  if (cleanString(target.scopeId)) attribution.scopeId = target.scopeId;
  if (cleanString(turn.triggerMessageId)) attribution.replyTo = turn.triggerMessageId;
  if (cleanString(turn.rootId)) attribution.rootId = turn.rootId;
  return attribution;
}

/**
 * 条目 -> 归属：host 条目用 data.attribution；模型生成条目按 byTaskId 解析冻结轮。
 * tool-result 条目的 byTaskId 是工具任务：调用方（live/history lane）先经 task.owner
 * 链把工具任务解析到 generation taskId，再把该 id 加进传入 sessionState.turnByTask。
 */
export function deriveEntryAttribution(entry, sessionState) {
  const data = entry?.data;
  if (data && typeof data === 'object' && data.attribution && typeof data.attribution === 'object') {
    return data.attribution;
  }
  const requestId = entry?.byTaskId !== undefined
    ? sessionState?.turnByTask?.[String(entry.byTaskId)] : undefined;
  const turn = requestId !== undefined
    ? (sessionState?.completedTurns?.[requestId] ??
       (sessionState?.activeTurn?.requestId === requestId ? sessionState.activeTurn : null))
    : null;
  return turn ? safeTurnAttribution(turn) : null;
}

/**
 * 账本条目 -> host.scope-message：data 原样保留全部字段 + data.attribution；
 * 模型输入来源已标注（EXTERNAL_EVENT_PREFIX + JSON），正文绝不充当宿主权威。
 * identity 预留给需要本机身份的调用方（direction 目前由 selfEcho 决定）。
 */
export function createSessionMessageEntry(stored, scopeKind, identity = {}) {
  const direction = stored?.selfEcho === true ? 'outgoing' : 'incoming';
  const data = {
    version: 2,
    scopeKind,
    localId: stored.localId,
    digest: stored.digest,
    storedAt: stored.storedAt,
    selfEcho: stored.selfEcho === true,
    message: stored.message,
    attribution: scopeMessageAttribution(stored, scopeKind, direction),
  };
  return {
    kind: SCOPE_MESSAGE_KIND,
    data,
    model: [{
      role: 'user',
      content: EXTERNAL_EVENT_PREFIX + JSON.stringify(data),
      timestamp: Date.parse(data.storedAt) || Date.now(),
    }],
  };
}
