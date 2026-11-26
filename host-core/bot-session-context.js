// 统一 Bot 会话：每个 Bot 一条主 Durable 会话承载用户私聊 + Bot 私聊 + 普通群聊。
// 本模块只定义会话级持久状态（BotSessionState）、来源标记的安全归属（attribution）和
// 事件条目编码（createSessionMessageEntry）。执行逻辑在 runtime-bot-session.js。
// 归属只来自受信账本字段（author/scopeId/envelope），绝不从正文文本推断；
// scopeMessageAttribution 对未知/畸形 author 一律回退 bot，不采信发送方声称的 user。
import { defineDoc } from '@earendil-works/pi-durable';
import { isTrustedHostSourceType } from './google-workspace-privacy.js';

export const SCOPE_MESSAGE_KIND = 'host.scope-message';
export const WORK_TRIGGER_KIND = 'host.work-trigger';
export const USER_MESSAGE_KIND = 'host.user-message';

const EXTERNAL_EVENT_PREFIX = 'External conversation event (actual author in message.author):\n';

const ATTRIBUTION_KINDS = new Set(['user', 'bot', 'host']);
const ATTRIBUTION_CHANNELS = new Set(['primary', 'dm', 'room']);
const ATTRIBUTION_CATEGORIES = new Set(['public', 'notice', 'request', 'reply']);
const ATTRIBUTION_DIRECTIONS = new Set(['incoming', 'outgoing']);
export const GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE = 'google-workspace-assistant';
const PRIVATE_HOST_SOURCE_TYPES = new Set(['schedule', 'task_dispatch']);

/** Host 侧合法的受信事件来源白名单（含 Google Workspace 规则/主动助手与内部 schedule/task_dispatch）。 */
export function isAllowedHostSourceType(value) {
  return (
    isTrustedHostSourceType(value) ||
    value === GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE ||
    PRIVATE_HOST_SOURCE_TYPES.has(value)
  );
}

export const BOT_SESSION_CHECKPOINT_INTERVAL = 128;
export const TASK_OWNER_CHAIN_DEPTH = 8;
export const DEFAULT_TASK_OWNER_CACHE_LIMIT = 512;

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
    // 最近一次 pi.reset 条目 id；随 reset 原子推进，供 live 投影 O(1) 裁剪与跨压缩保留边界。
    clearedThroughEntryId: 0,
    // An accepted AGY request locks this history even if no assistant response was committed.
    nativeHistoryProvider: null,
    // 冻结的活动轮 + generation taskId -> requestId 映射（生成轮换任务/工具时归属不丢）。
    activeTurn: null,
    turnByTask: {},
    // 本 Bot 发出的 category=request 的原始来源（键 messageId），含已观察回复水位；永不删。
    outgoing: {},
    // requestId -> 冻结轮归档：历史/实时归属的来源，只要历史还在就不得裁剪。
    completedTurns: {},
    updatedAt: null,
  }),
  // deltasSinceBase 是本次写入之前的增量数。
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= BOT_SESSION_CHECKPOINT_INTERVAL - 1,
});

function cleanString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A presentation cannot confer authority on itself: it must address the
 * actual tool task in this native conversation before the wait store is read. */
export function questionnaireWaitKey(details, taskId, conversationId) {
  const p = details?.presentation;
  if (p?.kind !== 'questionnaire' || p.version !== 1 ||
      typeof p.installationId !== 'string' || !p.installationId ||
      !Number.isSafeInteger(p.conversationId) || p.conversationId < 1 ||
      typeof p.requestId !== 'string' || p.requestId !== String(taskId) ||
      (conversationId !== undefined && p.conversationId !== conversationId)) return null;
  return JSON.stringify([p.installationId, p.conversationId, p.requestId]);
}

/** 把账本/触发条目的 author 归一为受信归属：只认 kind/botId/deviceId，名字仅作展示。 */
export function senderAttribution(author, deviceId) {
  const kind = ATTRIBUTION_KINDS.has(author?.kind) ? author.kind : 'bot';
  const sender = { kind };
  if (kind === 'bot' && cleanString(author?.botId)) sender.botId = author.botId;
  const device = cleanString(deviceId) ?? cleanString(author?.deviceId);
  if (device) sender.deviceId = device;
  if (kind === 'host' && cleanString(author?.name)) sender.name = author.name.slice(0, 200);
  if (kind === 'host' && isAllowedHostSourceType(author?.sourceType)) sender.sourceType = author.sourceType;
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
  if (author.sourceType) attribution.sourceType = author.sourceType;
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

function lookupTurnRequestId(turnByTask, taskKey) {
  if (!turnByTask || typeof turnByTask !== 'object' || !Object.hasOwn(turnByTask, taskKey)) {
    return null;
  }
  const requestId = turnByTask[taskKey];
  return typeof requestId === 'string' && requestId !== '' ? requestId : null;
}

function hasExplicitAttribution(entry) {
  const attribution = entry?.data?.attribution;
  return Boolean(attribution && typeof attribution === 'object');
}

function setBoundedTaskOwnerCache(cache, key, value, maxSize) {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (maxSize > 0) {
    while (cache.size >= maxSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

/**
 * 沿 task.owner 链解析缺少显式 data.attribution 的条目（如 pi.tool-result）的
 * byTaskId 到 generation task 的 requestId，返回不修改原 sessionState 的浅副本。
 * 最多追踪 TASK_OWNER_CHAIN_DEPTH（8）跳并防环；缺失 harness.getTask 或任务查询失败时
 * 优雅降级为不映射（绝不抛错中断 live 帧或历史读取）。
 */
export async function augmentSessionTurnByTask(
  entries,
  sessionState,
  {
    harness = null,
    context,
    cache = null,
    conversationId,
    maxDepth = TASK_OWNER_CHAIN_DEPTH,
    maxCacheSize = DEFAULT_TASK_OWNER_CACHE_LIMIT,
  } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) return sessionState;
  if (!sessionState || typeof sessionState !== 'object') return sessionState;
  const turnByTask = sessionState.turnByTask;
  if (!turnByTask || typeof turnByTask !== 'object' || Object.keys(turnByTask).length === 0) {
    return sessionState;
  }

  const candidates = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (hasExplicitAttribution(entry)) continue;
    const rawTaskId = entry.byTaskId;
    if (rawTaskId === undefined || rawTaskId === null || rawTaskId === '') continue;
    const taskKey = String(rawTaskId);
    if (taskKey === '__proto__') continue;
    if (lookupTurnRequestId(turnByTask, taskKey) !== null) continue;
    if (!candidates.has(taskKey)) candidates.set(taskKey, rawTaskId);
  }
  if (candidates.size === 0) return sessionState;

  const hasGetTask = typeof harness?.getTask === 'function';
  const useExternalCache = cache instanceof Map;
  if (!hasGetTask && !useExternalCache) return sessionState;

  const lookupCache = useExternalCache ? cache : new Map();
  const cacheLimit = useExternalCache
    ? (Number.isSafeInteger(maxCacheSize) && maxCacheSize > 0 ? maxCacheSize : DEFAULT_TASK_OWNER_CACHE_LIMIT)
    : 0;
  const depthLimit = Number.isSafeInteger(maxDepth) && maxDepth > 0 ? maxDepth : TASK_OWNER_CHAIN_DEPTH;
  const hasConversationFilter = conversationId !== undefined && conversationId !== null;
  const resolved = new Map();

  for (const [taskKey, rawTaskId] of candidates) {
    if (lookupCache.has(taskKey)) {
      const cached = lookupCache.get(taskKey) ?? null;
      if (useExternalCache) {
        setBoundedTaskOwnerCache(lookupCache, taskKey, cached, cacheLimit);
      }
      if (typeof cached === 'string' && cached !== '') {
        resolved.set(taskKey, cached);
      }
      continue;
    }
    if (!hasGetTask) continue;

    const visited = new Set();
    const path = [];
    let curId = rawTaskId;
    let curKey = taskKey;
    let resolvedRequestId = null;
    let hitDepthLimit = false;
    let failedLookup = false;

    for (let depth = 0; depth < depthLimit; depth++) {
      if (visited.has(curKey)) {
        resolvedRequestId = null;
        break;
      }
      visited.add(curKey);
      path.push(curKey);

      let task;
      try {
        task = await harness.getTask(curId, context);
      } catch {
        failedLookup = true;
        resolvedRequestId = null;
        break;
      }
      if (!task || typeof task !== 'object') {
        resolvedRequestId = null;
        break;
      }
      if (
        hasConversationFilter &&
        task.conversationId !== undefined &&
        task.conversationId !== null &&
        task.conversationId !== conversationId
      ) {
        resolvedRequestId = null;
        break;
      }
      const owner = task.owner;
      if (owner === undefined || owner === null || owner === '') {
        resolvedRequestId = null;
        break;
      }
      const ownerKey = String(owner);
      const directRequestId = lookupTurnRequestId(turnByTask, ownerKey);
      if (directRequestId !== null) {
        resolvedRequestId = directRequestId;
        break;
      }
      if (visited.has(ownerKey)) {
        resolvedRequestId = null;
        break;
      }
      if (lookupCache.has(ownerKey)) {
        const cachedOwner = lookupCache.get(ownerKey) ?? null;
        if (useExternalCache) {
          setBoundedTaskOwnerCache(lookupCache, ownerKey, cachedOwner, cacheLimit);
        }
        resolvedRequestId = typeof cachedOwner === 'string' && cachedOwner !== '' ? cachedOwner : null;
        break;
      }
      if (depth + 1 >= depthLimit) {
        hitDepthLimit = true;
        resolvedRequestId = null;
        break;
      }
      curId = owner;
      curKey = ownerKey;
    }

    if (!failedLookup) {
      if (hitDepthLimit) {
        setBoundedTaskOwnerCache(lookupCache, taskKey, null, cacheLimit);
      } else {
        for (let i = path.length - 1; i >= 0; i--) {
          setBoundedTaskOwnerCache(lookupCache, path[i], resolvedRequestId, cacheLimit);
        }
      }
    }
    if (resolvedRequestId !== null) {
      resolved.set(taskKey, resolvedRequestId);
    }
  }

  if (resolved.size === 0) return sessionState;
  const nextTurnByTask = { ...turnByTask };
  for (const [taskKey, requestId] of resolved) {
    nextTurnByTask[taskKey] = requestId;
  }
  return { ...sessionState, turnByTask: nextTurnByTask };
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
  const taskKey = entry?.byTaskId !== undefined && entry?.byTaskId !== null
    ? String(entry.byTaskId)
    : null;
  const requestId = taskKey !== null ? lookupTurnRequestId(sessionState?.turnByTask, taskKey) : null;
  const completedTurns = sessionState?.completedTurns;
  const turn = requestId !== null
    ? ((completedTurns && typeof completedTurns === 'object' && Object.hasOwn(completedTurns, requestId)
        ? completedTurns[requestId]
        : null) ??
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
