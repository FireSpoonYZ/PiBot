// host-core/google-workspace-privacy.js
// Google Workspace 业务结果的数据使用边界（Host 侧权威隐私 provenance Helper）：
// - 只认 Center 受信解析分配：target === 'center' 且
//   installationId === 'builtin.google-workspace'；
//   绝不以 packageId、effectiveConfig、工具名、业务结果文本前缀或模型可写字段作为身份依据。
// - 仅 tools/list 或默认对全部 Bot 可见绝不标记会话；只有在真实执行 Google Workspace MCP
//   调用时（进入 Center 网络调用前）才原子持久化标记到 Durable 文档，标记失败则 fail-closed
//   拒绝执行调用，绝不放行未受保护的 Google Workspace 调用。
// - 规则事件只认内部可信分发器写入的 entry.data.dataBoundary === 'google-workspace' 或
//   Host 侧 attribution/turn.sender.sourceType === 'google-workspace-rule'，绝不从 webhook
//   payload 文本推断。
// - 隔离范围覆盖工具调用中途 abort/崩溃重启及上下文压缩（pi.compaction / Billion Context）：
//   同一 pi.reset 代次内，从触发/发生 Google Workspace 访问的轮起，工具结果、衍生助手回复、
//   后续轮次与压缩摘要均保守隔离出自动/手动学习、Hindsight 长期记忆与跨 Bot Skill 提炼；
//   仅在新的 pi.reset（/clear）之后恢复干净上下文，先于首次访问的干净轮仍保留。
import { randomUUID } from 'node:crypto';
import { defineDoc, ResetEntry } from '@earendil-works/pi-durable';
import { messageError } from './message-protocol.js';

import { GOOGLE_WORKSPACE_INSTALLATION_ID as GOOGLE_WORKSPACE_MCP_INSTALLATION_ID } from '../center-contract/google-workspace.js';

export { GOOGLE_WORKSPACE_MCP_INSTALLATION_ID };
export const GOOGLE_WORKSPACE_DATA_BOUNDARY = 'google-workspace';
export const GOOGLE_WORKSPACE_RULE_SOURCE_TYPE = 'google-workspace-rule';
export const GOOGLE_WORKSPACE_PRIVACY_DOC_KIND = 'host.google-workspace-privacy';
export const GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE = 'GOOGLE_WORKSPACE_PRIVACY_BLOCKED';
export const GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE = 'GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE';

export const TRUSTED_HOST_SOURCE_TYPES = Object.freeze([
  'webhook',
  GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
]);

const RESET_ENTRY_KIND = ResetEntry.kind;
const TURN_INPUT_ENTRY_KINDS = new Set([
  'host.user-message',
  'pi.user',
  'host.work-trigger',
  'host.scope-message',
]);
const RULE_ENTRY_KINDS = new Set(['host.user-message', 'host.work-trigger']);
const MAX_STORED_MARKS = 64;
const SCAN_PAGE_SIZE = 100;
const TURN_START_SCAN_LIMIT = 64;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeNonNegativeInt(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * 会话级持久 Google Workspace 隐私边界文档（每条 Durable 会话一份）。
 * - earliestByReset：按最近 pi.reset 条目 id（无 reset 为 "0"）永久保留该代次最早的隔离起点
 *   { turnStartEntryId, anchorEntryId, recordedAt }，不受 marks 滚动裁剪影响。
 * - marks：最近最多 64 条调用/规则标记（审计与崩溃恢复诊断用）。
 */
export const GoogleWorkspacePrivacyState = defineDoc({
  kind: GOOGLE_WORKSPACE_PRIVACY_DOC_KIND,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    schema: 1,
    boundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
    earliestByReset: {},
    marks: [],
    updatedAt: null,
  }),
  checkpointWhen: () => false,
});

/** 仅依据 Center 受信解析分配识别内置 Google Workspace MCP（不看 packageId/config/工具名/正文）。 */
export function isGoogleWorkspaceCapability(capability) {
  if (!isPlainObject(capability)) return false;
  if (capability.target !== 'center') return false;
  return capability.installationId === GOOGLE_WORKSPACE_MCP_INSTALLATION_ID;
}

/** Host 侧合法的自动化 sourceType 白名单。 */
export function isTrustedHostSourceType(value) {
  return value === 'webhook' || value === GOOGLE_WORKSPACE_RULE_SOURCE_TYPE;
}

/** 受信数据边界字面量校验。 */
export function isTrustedDataBoundary(value) {
  return value === GOOGLE_WORKSPACE_DATA_BOUNDARY;
}

/**
 * 识别由 Host 内部可信规则分发器写入的 Google Workspace 规则条目。
 * 绝不检查 entry.model 文本或 webhook payload JSON 内容。
 */
export function isTrustedGoogleWorkspaceRuleEntry(entry) {
  if (!isPlainObject(entry) || !RULE_ENTRY_KINDS.has(entry.kind)) return false;
  const data = entry.data;
  if (!isPlainObject(data)) return false;
  const isHostAttributed =
    data.attribution?.kind === 'host' ||
    data.turn?.sender?.kind === 'host';
  if (
    data.dataBoundary === GOOGLE_WORKSPACE_DATA_BOUNDARY &&
    (data.source === 'host' || isHostAttributed)
  ) {
    return true;
  }
  if (
    data.attribution?.kind === 'host' &&
    data.attribution?.sourceType === GOOGLE_WORKSPACE_RULE_SOURCE_TYPE
  ) {
    return true;
  }
  if (
    data.turn?.sender?.kind === 'host' &&
    data.turn?.sender?.sourceType === GOOGLE_WORKSPACE_RULE_SOURCE_TYPE
  ) {
    return true;
  }
  return false;
}

function highestRecordedAnchor(privacyState) {
  if (!isPlainObject(privacyState)) return 0;
  let max = 0;
  const earliest = isPlainObject(privacyState.earliestByReset) ? privacyState.earliestByReset : {};
  for (const [resetKey, rec] of Object.entries(earliest)) {
    const resetId = Number(resetKey);
    if (Number.isSafeInteger(resetId) && resetId > max) max = resetId;
    if (Number.isSafeInteger(rec?.anchorEntryId) && rec.anchorEntryId > max) max = rec.anchorEntryId;
    if (Number.isSafeInteger(rec?.turnStartEntryId) && rec.turnStartEntryId > max) max = rec.turnStartEntryId;
  }
  if (Array.isArray(privacyState.marks)) {
    for (const mark of privacyState.marks) {
      if (Number.isSafeInteger(mark?.resetEntryId) && mark.resetEntryId > max) max = mark.resetEntryId;
      if (Number.isSafeInteger(mark?.anchorEntryId) && mark.anchorEntryId > max) max = mark.anchorEntryId;
      if (Number.isSafeInteger(mark?.turnStartEntryId) && mark.turnStartEntryId > max) max = mark.turnStartEntryId;
    }
  }
  return max;
}

export function hasAnyRecordedTaint(privacyState) {
  if (!isPlainObject(privacyState)) return false;
  if (isPlainObject(privacyState.earliestByReset) && Object.keys(privacyState.earliestByReset).length > 0) {
    return true;
  }
  return Array.isArray(privacyState.marks) && privacyState.marks.length > 0;
}

/**
 * 计算某个 pi.reset 代次（resetEntryId 之后的全部条目）中 Google Workspace 隔离的起始条目 id。
 * 返回 null 表示该代次干净；返回 >= 0 的整数表示该 id 及之后的全部条目（含压缩摘要与后续轮）均需保守隔离。
 */
export function taintStartEntryIdForEpoch(privacyState, resetEntryId = 0, entriesAfterReset = []) {
  const epochReset = safeNonNegativeInt(resetEntryId, 0);
  let earliest = null;
  const consider = (candidate) => {
    if (!Number.isSafeInteger(candidate) || candidate < 0) return;
    if (earliest === null || candidate < earliest) earliest = candidate;
  };

  if (isPlainObject(privacyState)) {
    const earliestMap = isPlainObject(privacyState.earliestByReset) ? privacyState.earliestByReset : {};
    for (const [resetKey, rec] of Object.entries(earliestMap)) {
      if (!isPlainObject(rec)) continue;
      const markReset = Number(resetKey);
      if (!Number.isSafeInteger(markReset) || markReset < 0) continue;
      const anchor = safeNonNegativeInt(rec.anchorEntryId, 0);
      const start = safeNonNegativeInt(rec.turnStartEntryId, anchor);
      if (markReset === epochReset || (markReset < epochReset && anchor > epochReset)) {
        consider(markReset < epochReset ? Math.max(start, epochReset + 1) : start);
      }
    }
    if (Array.isArray(privacyState.marks)) {
      for (const mark of privacyState.marks) {
        if (!isPlainObject(mark)) continue;
        const markReset = safeNonNegativeInt(mark.resetEntryId, 0);
        const anchor = safeNonNegativeInt(mark.anchorEntryId, 0);
        const start = safeNonNegativeInt(mark.turnStartEntryId, anchor);
        if (markReset === epochReset || (markReset < epochReset && anchor > epochReset)) {
          consider(markReset < epochReset ? Math.max(start, epochReset + 1) : start);
        }
      }
    }
  }

  for (const entry of Array.isArray(entriesAfterReset) ? entriesAfterReset : []) {
    if (!isPlainObject(entry) || !Number.isSafeInteger(entry.id)) continue;
    if (entry.id <= epochReset) continue;
    if (isTrustedGoogleWorkspaceRuleEntry(entry)) {
      consider(entry.id);
    }
  }

  return earliest;
}

/**
 * 纯函数判定：给定 reset 代次内，截至 throughEntryId（含）的范围是否已受 Google Workspace 污染。
 */
export function isRangeTainted({
  privacyState,
  resetEntryId = 0,
  entriesAfterReset = [],
  throughEntryId = Number.POSITIVE_INFINITY,
} = {}) {
  const start = taintStartEntryIdForEpoch(privacyState, resetEntryId, entriesAfterReset);
  if (start === null) return false;
  return start <= throughEntryId;
}

/**
 * 纯函数过滤（供 bot-learning.js 构建学习快照使用）：
 * - 输入升序条目切片 + 持久 privacyState + 外部已知的最新 resetEntryId；
 * - 若切片内含 pi.reset，取最近一次 reset 之后的活跃代次；
 * - 保留该代次内严格早于 taintStartEntryId 的干净条目，剥离自污染起点起的所有条目
 *   （含 Google 工具调用/结果、衍生助手回复、压缩摘要与同代次后续轮）。
 */
export function filterCleanEntriesForLearning(entries, { privacyState = null, resetEntryId = 0 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let lastResetIndex = -1;
  let lastResetInSlice = 0;
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (entry?.kind === RESET_ENTRY_KIND) {
      lastResetIndex = i;
      if (Number.isSafeInteger(entry.id) && entry.id > lastResetInSlice) {
        lastResetInSlice = entry.id;
      }
    }
  }
  const activeEntries = lastResetIndex >= 0 ? list.slice(lastResetIndex + 1) : list;
  const effectiveResetId = Math.max(safeNonNegativeInt(resetEntryId, 0), lastResetInSlice);
  const taintStartEntryId = taintStartEntryIdForEpoch(privacyState, effectiveResetId, activeEntries);
  if (taintStartEntryId === null) {
    return {
      cleanEntries: activeEntries,
      isolatedCount: 0,
      tainted: false,
      taintStartEntryId: null,
      resetEntryId: effectiveResetId,
    };
  }
  const cleanEntries = [];
  let isolatedCount = 0;
  for (const entry of activeEntries) {
    if (Number.isSafeInteger(entry?.id) && entry.id < taintStartEntryId) {
      cleanEntries.push(entry);
    } else {
      isolatedCount += 1;
    }
  }
  return {
    cleanEntries,
    isolatedCount,
    tainted: true,
    taintStartEntryId,
    resetEntryId: effectiveResetId,
  };
}

/** 扫描会话尾部至最近一次 pi.reset（可选按 maxEntryId 截顶、按 stopBelowEntryId 提前停止）。 */
async function scanLatestResetEntryId(conversation, callContext, { maxEntryId, stopBelowEntryId = 0 } = {}) {
  if (!conversation || typeof conversation.entries !== 'function') return 0;
  let cursor;
  for (;;) {
    const query = Number.isSafeInteger(maxEntryId)
      ? { order: 'descending', maxEntryId }
      : { order: 'descending' };
    const page = await conversation.entries(query, SCAN_PAGE_SIZE, cursor, callContext);
    const items = page?.items ?? [];
    for (const entry of items) {
      if (entry?.kind === RESET_ENTRY_KIND && Number.isSafeInteger(entry.id)) {
        return entry.id;
      }
      if (stopBelowEntryId > 0 && Number.isSafeInteger(entry?.id) && entry.id <= stopBelowEntryId) {
        return 0;
      }
    }
    if (!page?.next || items.length === 0) return 0;
    cursor = page.next;
  }
}

/** 从尾部倒序定位当前轮输入起点（不超过最近 pi.reset），以便连同触发该调用的用户请求一起保守隔离。 */
async function locateCurrentTurnBounds(conversation, callContext) {
  if (!conversation || typeof conversation.entries !== 'function') {
    return { resetEntryId: 0, turnStartEntryId: null, latestEntryId: 0 };
  }
  let resetEntryId = 0;
  let turnStartEntryId = null;
  let latestEntryId = 0;
  let scanned = 0;
  let cursor;
  for (;;) {
    const page = await conversation.entries({ order: 'descending' }, TURN_START_SCAN_LIMIT, cursor, callContext);
    const items = page?.items ?? [];
    for (const entry of items) {
      if (!Number.isSafeInteger(entry?.id)) continue;
      if (latestEntryId === 0) latestEntryId = entry.id;
      if (entry.kind === RESET_ENTRY_KIND) {
        resetEntryId = entry.id;
        return { resetEntryId, turnStartEntryId, latestEntryId };
      }
      if (turnStartEntryId === null && TURN_INPUT_ENTRY_KINDS.has(entry.kind)) {
        turnStartEntryId = entry.id;
      }
      scanned += 1;
      if (turnStartEntryId !== null && scanned >= TURN_START_SCAN_LIMIT) {
        // 找到输入起点后仍需精确确认最新 pi.reset（避免跨 64 条遗漏 reset）。
        const deeperReset = entry.id > 1
          ? await scanLatestResetEntryId(conversation, callContext, { maxEntryId: entry.id - 1 })
          : 0;
        return { resetEntryId: deeperReset, turnStartEntryId, latestEntryId };
      }
    }
    if (!page?.next || items.length === 0) break;
    cursor = page.next;
  }
  return { resetEntryId, turnStartEntryId, latestEntryId };
}

/** 在指定截顶内倒序单遍扫描：定位最近 pi.reset 及该代次内最早的受信 Google 规则条目。 */
async function scanEpochResetAndRule(conversation, callContext, { minResetEntryId = 0, maxEntryId } = {}) {
  if (!conversation || typeof conversation.entries !== 'function') {
    return { resetEntryId: safeNonNegativeInt(minResetEntryId, 0), earliestRuleId: null };
  }
  const floorReset = safeNonNegativeInt(minResetEntryId, 0);
  let earliestRuleId = null;
  let cursor;
  for (;;) {
    const query = {
      order: 'descending',
      ...(floorReset > 0 ? { minEntryId: floorReset + 1 } : {}),
      ...(Number.isSafeInteger(maxEntryId) ? { maxEntryId } : {}),
    };
    const page = await conversation.entries(query, SCAN_PAGE_SIZE, cursor, callContext);
    const items = page?.items ?? [];
    for (const entry of items) {
      if (!Number.isSafeInteger(entry?.id)) continue;
      if (entry.kind === RESET_ENTRY_KIND) {
        return { resetEntryId: Math.max(floorReset, entry.id), earliestRuleId };
      }
      if (isTrustedGoogleWorkspaceRuleEntry(entry)) {
        if (earliestRuleId === null || entry.id < earliestRuleId) {
          earliestRuleId = entry.id;
        }
      }
    }
    if (!page?.next || items.length === 0) {
      return { resetEntryId: floorReset, earliestRuleId };
    }
    cursor = page.next;
  }
}

function recordMarkOnDoc(doc, {
  markId,
  kind,
  installationId = null,
  botId = null,
  callId = null,
  taskId = null,
  requestId = null,
  resetEntryId,
  turnStartEntryId,
  anchorEntryId,
  status = 'started',
  nowIso,
}) {
  const resetKey = String(safeNonNegativeInt(resetEntryId, 0));
  doc.schema = 1;
  doc.boundary = GOOGLE_WORKSPACE_DATA_BOUNDARY;
  if (!isPlainObject(doc.earliestByReset)) doc.earliestByReset = {};
  const existing = doc.earliestByReset[resetKey];
  if (!isPlainObject(existing)) {
    doc.earliestByReset[resetKey] = {
      turnStartEntryId,
      anchorEntryId,
      recordedAt: nowIso,
    };
  } else {
    if (turnStartEntryId < safeNonNegativeInt(existing.turnStartEntryId, turnStartEntryId)) {
      existing.turnStartEntryId = turnStartEntryId;
    }
    if (anchorEntryId < safeNonNegativeInt(existing.anchorEntryId, anchorEntryId)) {
      existing.anchorEntryId = anchorEntryId;
    }
  }
  if (!Array.isArray(doc.marks)) doc.marks = [];
  doc.marks.push({
    id: markId,
    kind,
    ...(installationId ? { installationId } : {}),
    ...(botId ? { botId } : {}),
    ...(callId ? { callId: String(callId) } : {}),
    ...(taskId !== null && taskId !== undefined ? { taskId: String(taskId) } : {}),
    ...(requestId ? { requestId: String(requestId) } : {}),
    resetEntryId: safeNonNegativeInt(resetEntryId, 0),
    turnStartEntryId,
    anchorEntryId,
    status,
    startedAt: nowIso,
    settledAt: status === 'started' ? null : nowIso,
  });
  if (doc.marks.length > MAX_STORED_MARKS) {
    doc.marks.splice(0, doc.marks.length - MAX_STORED_MARKS);
  }
  doc.updatedAt = nowIso;
}

/**
 * Host 侧 Google Workspace 隐私边界运行时服务：
 * - recordGoogleWorkspaceCallStart：MCP 工具真实执行前原子持久化隔离标记（fail-closed）；
 * - recordGoogleWorkspaceCallOutcome：调用结算后仅更新审计状态，绝不撤销/削弱隔离；
 * - syncTrustedRuleEntries：在 beforeRequest/进入插件前持久化可信规则事件边界，确保跨压缩生效；
 * - inspectConversationPrivacy / isConversationTainted / assertExportAllowed：供 Hindsight、
 *   bot-learning 与模型管理工具查询/强制隔离边界；
 * - filterConversationEntriesForLearning：供 bot-learning.js 精准裁剪学习快照。
 */
export function createGoogleWorkspacePrivacy({ getHarness, context, documents = {} } = {}) {
  const BotSessionStateDoc = documents?.BotSessionState ?? null;

  function requireHarness() {
    const harness = typeof getHarness === 'function' ? getHarness() : null;
    if (!harness) {
      throw messageError(
        GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
        'Google Workspace privacy boundary is unavailable; refusing unguarded call',
      );
    }
    return harness;
  }

  async function snapshotPrivacyDoc(harness, conversationId, callContext) {
    if (typeof harness.snapshot !== 'function') return null;
    return await harness.snapshot(GoogleWorkspacePrivacyState, conversationId, callContext);
  }

  async function resolveResetEntryId(harness, conversation, conversationId, callContext, {
    maxEntryId,
    privacyState = null,
  } = {}) {
    let sessionCleared = 0;
    if (BotSessionStateDoc && typeof harness.snapshot === 'function') {
      try {
        const sessionState = await harness.snapshot(BotSessionStateDoc, conversationId, callContext);
        if (Number.isSafeInteger(sessionState?.clearedThroughEntryId) && sessionState.clearedThroughEntryId > 0) {
          if (!Number.isSafeInteger(maxEntryId) || sessionState.clearedThroughEntryId <= maxEntryId) {
            sessionCleared = sessionState.clearedThroughEntryId;
          }
        }
      } catch {
        // 无法读 sessionState 时降级扫描 entries。
      }
    }
    const maxAnchor = highestRecordedAnchor(privacyState);
    if (sessionCleared > 0 && (maxAnchor === 0 || sessionCleared >= maxAnchor)) {
      return sessionCleared;
    }
    const scanned = await scanLatestResetEntryId(conversation, callContext, {
      maxEntryId,
      stopBelowEntryId: sessionCleared,
    });
    return Math.max(sessionCleared, scanned);
  }

  async function recordGoogleWorkspaceCallStart({
    installationId,
    target,
    dataBoundary,
    conversationId,
    callId = null,
    taskId = null,
    botId = null,
    callContext = context,
  }) {
    if (!isGoogleWorkspaceCapability({ installationId, target, dataBoundary })) {
      return { marked: false };
    }
    if (conversationId === undefined || conversationId === null) {
      throw messageError(
        GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
        'Conversation id is required to persist Google Workspace privacy boundary',
      );
    }
    const harness = requireHarness();
    const markId = 'gwp_' + randomUUID();
    const nowIso = new Date().toISOString();
    try {
      const conversation = typeof harness.conversation === 'function'
        ? await harness.conversation(conversationId, callContext)
        : null;
      const bounds = await locateCurrentTurnBounds(conversation, callContext);
      let sessionCleared = 0;
      if (BotSessionStateDoc && typeof harness.snapshot === 'function') {
        try {
          const sessionDoc = await harness.snapshot(BotSessionStateDoc, conversationId, callContext);
          if (Number.isSafeInteger(sessionDoc?.clearedThroughEntryId) && sessionDoc.clearedThroughEntryId > 0) {
            sessionCleared = sessionDoc.clearedThroughEntryId;
          }
        } catch {
          // 非统一/无 BotSessionState 会话仍以 bounds.resetEntryId 为准。
        }
      }
      let recorded = null;
      await harness.commit(async (tx) => {
        let anchorEntryId = bounds.latestEntryId;
        if (typeof tx.latestEntryId === 'function') {
          const latest = await tx.latestEntryId(conversationId);
          if (Number.isSafeInteger(latest) && latest >= 0) anchorEntryId = latest;
        }
        const resetEntryId = Math.max(bounds.resetEntryId, sessionCleared);
        let turnStartEntryId;
        if (
          Number.isSafeInteger(bounds.turnStartEntryId) &&
          bounds.turnStartEntryId > resetEntryId &&
          bounds.turnStartEntryId <= anchorEntryId
        ) {
          turnStartEntryId = bounds.turnStartEntryId;
        } else if (anchorEntryId > resetEntryId) {
          turnStartEntryId = anchorEntryId;
        } else {
          // 尚无条目落盘或与 reset 齐平：从 resetEntryId + 1（或 0）保守拦截后续条目。
          turnStartEntryId = resetEntryId > 0 ? resetEntryId + 1 : 0;
        }
        const doc = await tx.doc(GoogleWorkspacePrivacyState, conversationId);
        recordMarkOnDoc(doc, {
          markId,
          kind: 'mcp_call',
          installationId,
          botId,
          callId,
          taskId,
          resetEntryId,
          turnStartEntryId,
          anchorEntryId: Math.max(anchorEntryId, turnStartEntryId),
          status: 'started',
          nowIso,
        });
        recorded = {
          marked: true,
          markId,
          resetEntryId,
          turnStartEntryId,
          anchorEntryId: Math.max(anchorEntryId, turnStartEntryId),
        };
      }, callContext);
      return recorded;
    } catch (err) {
      if (err?.code === GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE) throw err;
      throw Object.assign(
        messageError(
          GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
          'Failed to persist Google Workspace privacy boundary; refusing unguarded call',
        ),
        { cause: err },
      );
    }
  }

  async function recordGoogleWorkspaceCallOutcome({
    conversationId,
    markId,
    status,
    callContext = context,
  }) {
    if (!markId || conversationId === undefined || conversationId === null) return;
    if (!['completed', 'aborted', 'failed'].includes(status)) return;
    const harness = typeof getHarness === 'function' ? getHarness() : null;
    if (!harness || typeof harness.commit !== 'function') return;
    const nowIso = new Date().toISOString();
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(GoogleWorkspacePrivacyState, conversationId);
        if (!Array.isArray(doc.marks)) return;
        const mark = doc.marks.find((item) => item?.id === markId);
        if (mark) {
          mark.status = status;
          mark.settledAt = nowIso;
          doc.updatedAt = nowIso;
        }
      }, callContext);
    } catch {
      // 仅更新审计状态；earliestByReset 已在调用前持久落盘，失败绝不解除隔离。
    }
  }

  /**
   * 同步可见条目中的受信 Google Workspace 规则事件到持久文档，保证跨 pi.compaction 与
   * SNAPSHOT_MAX_ENTRIES 窗口持续生效；无规则条目时零 I/O。
   */
  async function syncTrustedRuleEntries(conversationId, entries, { callContext = context } = {}) {
    if (conversationId === undefined || conversationId === null || !Array.isArray(entries) || entries.length === 0) {
      return { marked: false };
    }
    let lastResetId = 0;
    let earliestRuleEntry = null;
    for (const entry of entries) {
      if (entry?.kind === RESET_ENTRY_KIND && Number.isSafeInteger(entry.id)) {
        lastResetId = entry.id;
        earliestRuleEntry = null;
        continue;
      }
      if (isTrustedGoogleWorkspaceRuleEntry(entry) && Number.isSafeInteger(entry.id)) {
        if (earliestRuleEntry === null || entry.id < earliestRuleEntry.id) {
          earliestRuleEntry = entry;
        }
      }
    }
    if (!earliestRuleEntry) return { marked: false };
    const harness = requireHarness();
    const existing = await snapshotPrivacyDoc(harness, conversationId, callContext);
    const existingStart = taintStartEntryIdForEpoch(existing, lastResetId);
    if (existingStart !== null && existingStart <= earliestRuleEntry.id) {
      return { marked: false, alreadyMarked: true };
    }
    const nowIso = new Date().toISOString();
    const markId = 'gwpr_' + randomUUID();
    await harness.commit(async (tx) => {
      const doc = await tx.doc(GoogleWorkspacePrivacyState, conversationId);
      recordMarkOnDoc(doc, {
        markId,
        kind: 'rule_event',
        botId: earliestRuleEntry.data?.botId ?? null,
        requestId: earliestRuleEntry.data?.requestId ?? null,
        resetEntryId: lastResetId,
        turnStartEntryId: earliestRuleEntry.id,
        anchorEntryId: earliestRuleEntry.id,
        status: 'completed',
        nowIso,
      });
    }, callContext);
    return { marked: true, markId, resetEntryId: lastResetId, turnStartEntryId: earliestRuleEntry.id };
  }

  async function inspectConversationPrivacy(conversationId, {
    throughEntryId,
    entries = null,
    callContext = context,
  } = {}) {
    if (conversationId === undefined || conversationId === null) {
      return { tainted: false, resetEntryId: 0, taintStartEntryId: null, state: null };
    }
    const harness = typeof getHarness === 'function' ? getHarness() : null;
    if (!harness) {
      return { tainted: false, resetEntryId: 0, taintStartEntryId: null, state: null };
    }
    const state = await snapshotPrivacyDoc(harness, conversationId, callContext);
    const hasRecorded = hasAnyRecordedTaint(state);
    const conversation = typeof harness.conversation === 'function'
      ? await harness.conversation(conversationId, callContext)
      : null;

    let resetEntryId = 0;
    let sliceEntries = Array.isArray(entries) ? entries : null;
    let scannedRuleEntryId = null;

    if (sliceEntries !== null) {
      for (const entry of sliceEntries) {
        if (entry?.kind === RESET_ENTRY_KIND && Number.isSafeInteger(entry.id)) {
          if (!Number.isSafeInteger(throughEntryId) || entry.id <= throughEntryId) {
            if (entry.id > resetEntryId) resetEntryId = entry.id;
          }
        }
      }
      if (hasRecorded && resetEntryId === 0) {
        // 切片可能未包含更早的 pi.reset（例如超过 SNAPSHOT_MAX_ENTRIES 或已压缩）：向底层确认真实 reset。
        resetEntryId = await resolveResetEntryId(harness, conversation, conversationId, callContext, {
          maxEntryId: throughEntryId,
          privacyState: state,
        });
      }
    } else if (hasRecorded) {
      resetEntryId = await resolveResetEntryId(harness, conversation, conversationId, callContext, {
        maxEntryId: throughEntryId,
        privacyState: state,
      });
    } else if (conversation) {
      const scanned = await scanEpochResetAndRule(conversation, callContext, {
        maxEntryId: throughEntryId,
      });
      resetEntryId = scanned.resetEntryId;
      scannedRuleEntryId = scanned.earliestRuleId;
    }

    let taintStartEntryId = taintStartEntryIdForEpoch(state, resetEntryId, sliceEntries ?? []);
    if (scannedRuleEntryId !== null && (taintStartEntryId === null || scannedRuleEntryId < taintStartEntryId)) {
      taintStartEntryId = scannedRuleEntryId;
    }

    // 若调用方未提供条目切片且存在更早代次记录但当前代次尚未命中，额外检查当前代次是否有未同步的受信规则条目。
    if (sliceEntries === null && hasRecorded && taintStartEntryId === null && conversation) {
      const scanned = await scanEpochResetAndRule(conversation, callContext, {
        minResetEntryId: resetEntryId,
        maxEntryId: throughEntryId,
      });
      if (scanned.earliestRuleId !== null) taintStartEntryId = scanned.earliestRuleId;
    }

    const bound = Number.isSafeInteger(throughEntryId) ? throughEntryId : Number.POSITIVE_INFINITY;
    const tainted = taintStartEntryId !== null && taintStartEntryId <= bound;
    return { tainted, resetEntryId, taintStartEntryId, state };
  }

  async function isConversationTainted(conversationId, options = {}) {
    const inspection = await inspectConversationPrivacy(conversationId, options);
    return inspection.tainted === true;
  }

  async function assertExportAllowed(conversationId, { operation = 'export', callContext = context } = {}) {
    const inspection = await inspectConversationPrivacy(conversationId, { callContext });
    if (inspection.tainted) {
      throw messageError(
        GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
        `Blocked ${operation}: Google Workspace results in this conversation cannot be exported to learning, long-term memory, or cross-Bot skills by default.`,
      );
    }
    return inspection;
  }

  async function filterConversationEntriesForLearning(conversationId, entries, { callContext = context } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const harness = typeof getHarness === 'function' ? getHarness() : null;
    if (!harness || conversationId === undefined || conversationId === null) {
      return filterCleanEntriesForLearning(list, { privacyState: null, resetEntryId: 0 });
    }
    const state = await snapshotPrivacyDoc(harness, conversationId, callContext);
    let resetEntryId = 0;
    for (const entry of list) {
      if (entry?.kind === RESET_ENTRY_KIND && Number.isSafeInteger(entry.id) && entry.id > resetEntryId) {
        resetEntryId = entry.id;
      }
    }
    if (hasAnyRecordedTaint(state) && resetEntryId === 0) {
      const conversation = typeof harness.conversation === 'function'
        ? await harness.conversation(conversationId, callContext)
        : null;
      const maxId = list.length > 0 && Number.isSafeInteger(list[list.length - 1]?.id)
        ? list[list.length - 1].id
        : undefined;
      resetEntryId = await resolveResetEntryId(harness, conversation, conversationId, callContext, {
        maxEntryId: maxId,
        privacyState: state,
      });
    }
    return filterCleanEntriesForLearning(list, { privacyState: state, resetEntryId });
  }

  return {
    isGoogleWorkspaceCapability,
    isTrustedGoogleWorkspaceRuleEntry,
    recordGoogleWorkspaceCallStart,
    recordGoogleWorkspaceCallOutcome,
    syncTrustedRuleEntries,
    inspectConversationPrivacy,
    isConversationTainted,
    assertExportAllowed,
    filterConversationEntriesForLearning,
  };
}

/**
 * 供 host-core/capabilities/mcp.js（及 center 组复用）调用的单一门控入口：
 * - 非 Google Workspace MCP 直接返回 { guarded: false, finish }（零开销）；
 * - 命中 target === 'center' 且 installationId === 'builtin.google-workspace' 时，
 *   必须在真实调用 Center 之前完成持久标记；host.dataPrivacy 缺失或提交失败一律 fail-closed 抛
 *   GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE，绝不执行未受保护的调用。
 */
export async function guardGoogleWorkspaceMcpCall({
  installationId,
  target,
  dataBoundary,
  botId,
  conversationId,
  callId = null,
  taskId = null,
  host,
}) {
  if (!isGoogleWorkspaceCapability({ installationId, target, dataBoundary })) {
    return { guarded: false, mark: null, finish: async () => {} };
  }
  const recorder = host?.dataPrivacy?.recordGoogleWorkspaceCallStart;
  if (typeof recorder !== 'function') {
    throw messageError(
      GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
      'Google Workspace privacy boundary service is unavailable; refusing unguarded call',
    );
  }
  const mark = await recorder({
    installationId,
    target,
    dataBoundary,
    botId,
    conversationId,
    callId,
    taskId,
  });
  return {
    guarded: true,
    mark,
    async finish(status) {
      if (!mark?.markId || typeof host?.dataPrivacy?.recordGoogleWorkspaceCallOutcome !== 'function') return;
      await host.dataPrivacy.recordGoogleWorkspaceCallOutcome({
        conversationId,
        markId: mark.markId,
        status,
      });
    },
  };
}
