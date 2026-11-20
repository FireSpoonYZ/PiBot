import {
  BLOCKED_REF,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
  activeBlocks,
  buildCompressSystemPrompt,
  countMessageTokens,
  coveredMessageIds,
  prune,
  refToIndex,
} from 'acp-kernel';
import { AUTO_FOLD_BACKOFF_MS, AUTO_FOLD_TARGET_MIN } from './context-state.js';

export const MAX_COMPACT_ROUNDS = 12;
export const MAX_SUMMARY_CALLS = 12;
export const MAX_TIER_DISTILL_CALLS = 4;
const MAX_SUMMARY_INPUT_TOKENS = 48_000;
const MIN_SUMMARY_INPUT_TOKENS = 512;
const MAX_SUMMARY_OUTPUT_TOKENS = 4096;
const MIN_CANDIDATE_TOKENS = 40;
const SUMMARY_WRAPPER_OVERHEAD_TOKENS = 20;
const SUMMARY_JOIN_GAP = 2;
const MAX_CONSECUTIVE_SUMMARY_FAILURES = 2;

export function normalizePluginConfig(effectiveConfig) {
  const autoFold = effectiveConfig?.autoFold === true;
  const rawTarget = effectiveConfig?.autoFoldTargetTokens;
  const autoFoldTargetTokens =
    typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0
      ? Math.floor(rawTarget)
      : undefined;
  return { autoFold, autoFoldTargetTokens };
}

export function isAutoFoldBackoffActive(doc, now = Date.now()) {
  const until = doc?.autoFold?.backoffUntil;
  return typeof until === 'number' && Number.isFinite(until) && until > now;
}

export function getAutoFoldFloor(doc) {
  const floor = doc?.autoFold?.floorTokens;
  return typeof floor === 'number' && Number.isFinite(floor) && floor > 0 ? floor : undefined;
}

/**
 * 增长折叠目标：仅当 autoFold 开启且最终目标严格低于当前硬预算上限时生效；
 * 默认取有效硬预算的一半，下限 8192，并受已测不可压缩下界 floorTokens 约束。
 */
export function computeGrowthTarget(pluginConfig, hardTarget, measuredFloor) {
  if (!pluginConfig?.autoFold) return null;
  if (!(typeof hardTarget === 'number' && Number.isFinite(hardTarget) && hardTarget > 0)) return null;
  const configured = pluginConfig.autoFoldTargetTokens ?? Math.round(hardTarget / 2);
  const clamped = Math.max(
    AUTO_FOLD_TARGET_MIN,
    Math.min(configured, hardTarget),
    measuredFloor ?? 0,
  );
  return clamped < hardTarget ? clamped : null;
}

export function isGrowthFoldingArmed(pluginConfig, doc, hardTarget, now = Date.now()) {
  if (!pluginConfig?.autoFold) return false;
  if (isAutoFoldBackoffActive(doc, now)) return false;
  return computeGrowthTarget(pluginConfig, hardTarget, getAutoFoldFloor(doc)) !== null;
}

export function isBcAuxiliaryMessage(message) {
  return Boolean(
    message &&
    message.role === 'user' &&
    (message.bcContextMaterial === true || message.bcSummaryMaterial === true),
  );
}

export async function safeEstimateTokens(estimateTokens, messages, abortSignal) {
  abortSignal?.throwIfAborted();
  const raw = await estimateTokens(messages);
  abortSignal?.throwIfAborted();
  if (typeof raw !== 'number' || Number.isNaN(raw) || raw < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return raw;
}

/** acp-kernel@0.0.101 的 applyCompression 按 messageRefs.byRaw[id] 核对 protectedMessageIds，双写 rawId 与 ref。 */
export function buildProtectedRefSet(rawIds, state) {
  const out = new Set();
  const byRaw = state?.messageRefs?.byRaw ?? {};
  for (const rawId of rawIds ?? []) {
    out.add(rawId);
    const ref = byRaw[rawId];
    if (typeof ref === 'string' && ref) out.add(ref);
  }
  return out;
}

function extractNativeToolCallIds(nativeMsg, coreMsg) {
  const ids = [];
  if (nativeMsg?.role === 'assistant' && Array.isArray(nativeMsg.content)) {
    for (const block of nativeMsg.content) {
      if (block?.type === 'toolCall' && typeof block.id === 'string' && block.id) {
        ids.push(block.id);
      }
    }
  }
  if (
    coreMsg?.contentType === 'tool-call' &&
    typeof coreMsg.toolCallId === 'string' &&
    coreMsg.toolCallId &&
    !ids.includes(coreMsg.toolCallId)
  ) {
    ids.push(coreMsg.toolCallId);
  }
  return ids;
}

function extractNativeToolResultCallId(nativeMsg, coreMsg) {
  if (nativeMsg?.role === 'toolResult' && typeof nativeMsg.toolCallId === 'string' && nativeMsg.toolCallId) {
    return nativeMsg.toolCallId;
  }
  if (coreMsg?.contentType === 'tool-result' && typeof coreMsg.toolCallId === 'string' && coreMsg.toolCallId) {
    return coreMsg.toolCallId;
  }
  return null;
}

/**
 * 计算不可折叠硬保护集合：
 * - codec.protectedIds（opaque：system / thinking / image / 未放开的工具消息）
 * - 最新非 system 非辅助输入（保证 turnProvenance.lostInput 恒为 false）
 * - 最新真实 user 消息
 * - 未闭合工具调用、孤立工具结果、以及当前尾部的工具调用/结果对
 * 同时产出闭合工具对的原子区间 atomicGroups，确保按条目切分范围时绝不撕裂工具对。
 */
export function computeHardProtected(view, codec) {
  const viewMessages = Array.isArray(view?.messages) ? view.messages : [];
  const coreMessages = Array.isArray(codec?.messages) ? codec.messages : [];
  const hardProtectedIds = new Set(codec?.protectedIds ?? []);

  let rawInputOrdinal = -1;
  let lastRealUserOrdinal = -1;
  for (let i = viewMessages.length - 1; i >= 0; i--) {
    const m = viewMessages[i];
    if (!m || m.role === 'system' || isBcAuxiliaryMessage(m)) continue;
    if (rawInputOrdinal === -1) rawInputOrdinal = i;
    if (m.role === 'user' && lastRealUserOrdinal === -1) lastRealUserOrdinal = i;
    if (rawInputOrdinal !== -1 && lastRealUserOrdinal !== -1) break;
  }

  if (rawInputOrdinal >= 0 && coreMessages[rawInputOrdinal]) {
    hardProtectedIds.add(coreMessages[rawInputOrdinal].id);
  }
  if (lastRealUserOrdinal >= 0 && coreMessages[lastRealUserOrdinal]) {
    hardProtectedIds.add(coreMessages[lastRealUserOrdinal].id);
  }

  const firstUserIndex = coreMessages.findIndex((m) => m?.role === 'user');

  const callIdxByCallId = new Map();
  const callIdsByIdx = new Map();
  const resultIndicesByCallId = new Map();
  let lastToolCallOrdinal = -1;

  for (let i = 0; i < coreMessages.length; i++) {
    const nativeMsg = viewMessages[i];
    const coreMsg = coreMessages[i];
    const callIds = extractNativeToolCallIds(nativeMsg, coreMsg);
    if (callIds.length > 0) {
      callIdsByIdx.set(i, callIds);
      lastToolCallOrdinal = i;
      for (const callId of callIds) {
        if (!callIdxByCallId.has(callId)) callIdxByCallId.set(callId, i);
      }
    }
    const resultCallId = extractNativeToolResultCallId(nativeMsg, coreMsg);
    if (resultCallId !== null) {
      const list = resultIndicesByCallId.get(resultCallId);
      if (list) list.push(i);
      else resultIndicesByCallId.set(resultCallId, [i]);
    }
  }

  // 保护所有未闭合的 toolCall 与无归属的 toolResult。
  for (const [callId, callIdx] of callIdxByCallId.entries()) {
    const results = resultIndicesByCallId.get(callId);
    if (!results || results.length === 0) {
      if (coreMessages[callIdx]) hardProtectedIds.add(coreMessages[callIdx].id);
    }
  }
  for (const [callId, results] of resultIndicesByCallId.entries()) {
    if (!callIdxByCallId.has(callId)) {
      for (const rIdx of results) {
        if (coreMessages[rIdx]) hardProtectedIds.add(coreMessages[rIdx].id);
      }
    }
  }

  // 合并重叠工具对为原子区间，切分范围时不可拆断。
  const rawIntervals = [];
  for (const [callIdx, callIds] of callIdsByIdx.entries()) {
    let lo = callIdx;
    let hi = callIdx;
    for (const callId of callIds) {
      for (const rIdx of resultIndicesByCallId.get(callId) ?? []) {
        if (rIdx < lo) lo = rIdx;
        if (rIdx > hi) hi = rIdx;
      }
    }
    if (hi > lo) rawIntervals.push([lo, hi]);
  }
  rawIntervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const mergedIntervals = [];
  for (const [lo, hi] of rawIntervals) {
    const prev = mergedIntervals[mergedIntervals.length - 1];
    if (prev && lo <= prev[1]) {
      if (hi > prev[1]) prev[1] = hi;
    } else {
      mergedIntervals.push([lo, hi]);
    }
  }
  const atomicGroups = new Map();
  for (const interval of mergedIntervals) {
    for (let k = interval[0]; k <= interval[1]; k++) {
      atomicGroups.set(k, interval);
    }
  }

  const protectGroupAt = (idx) => {
    if (idx < 0 || idx >= coreMessages.length) return;
    const interval = atomicGroups.get(idx);
    if (interval) {
      for (let k = interval[0]; k <= interval[1]; k++) {
        if (coreMessages[k]) hardProtectedIds.add(coreMessages[k].id);
      }
    } else if (coreMessages[idx]) {
      hardProtectedIds.add(coreMessages[idx].id);
    }
  };

  // 保护尾部最新输入所在工具对，以及最新真实用户输入之后的当前工具调用对。
  if (rawInputOrdinal >= 0) protectGroupAt(rawInputOrdinal);
  if (lastToolCallOrdinal >= 0 && (lastRealUserOrdinal < 0 || lastToolCallOrdinal > lastRealUserOrdinal)) {
    protectGroupAt(lastToolCallOrdinal);
  }

  return { hardProtectedIds, rawInputOrdinal, lastRealUserOrdinal, firstUserIndex, atomicGroups };
}

function noEmergencyTruncate(config) {
  return {
    ...config,
    modelContextLimit: Math.max(1, (config.modelContextLimit || 32768) * 100),
  };
}

/** 构造不带临时 nudge 的干净投影，并准确测量实际投影 tokenCount；不污染 state.nudge 计数。 */
export function projectWithoutNudge(core, codec, state, contentStore, config) {
  const workingState = JSON.parse(JSON.stringify(state));
  const prevNudge = JSON.parse(JSON.stringify(workingState.nudge));
  const workingStore = JSON.parse(JSON.stringify(contentStore));
  const tokenCount = prune(codec.messages, workingState)
    .reduce((sum, message) => sum + countMessageTokens(message), 0);
  const turn = core.processTurn({
    messages: codec.messages,
    state: workingState,
    config: noEmergencyTruncate(config),
    contentStore: workingStore,
    tokenCount,
    renderTags: 'text-only',
  });
  const nextState = JSON.parse(JSON.stringify(turn.state));
  nextState.nudge = prevNudge;
  const restored = codec.restoreWithProvenance(turn.messages);
  const messages = JSON.parse(JSON.stringify(restored.messages));
  const projectedTokenCount = turn.messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
  const turnProvenance = {
    inputIndex: restored.inputIndex,
    lostInput: restored.lostInput,
    auxiliaryIndices: [...restored.auxiliaryIndices],
  };
  return {
    messages,
    turnProvenance,
    projectedTokenCount,
    state: nextState,
    contentStore: JSON.parse(JSON.stringify(turn.contentStore)),
  };
}

function computeSoftProtectedIds(messages, state, config, hardProtectedIds) {
  const preserveN = config.preserveRecentMessages ?? 5;
  const preserveTokens = config.preserveRecentTokens ?? 5000;
  const covered = coveredMessageIds(state);
  const result = new Set();
  const visible = [];
  for (const msg of messages) {
    if (!msg || msg.role === 'system' || msg.id?.startsWith('acp_summary_')) continue;
    if (covered.has(msg.id)) continue;
    if (hardProtectedIds.has(msg.id)) continue;
    const ref = state.messageRefs?.byRaw?.[msg.id];
    if (!ref || ref === BLOCKED_REF) continue;
    visible.push({ id: msg.id, tokens: countMessageTokens(msg) });
  }
  if (preserveN > 0) {
    for (const item of visible.slice(-preserveN)) result.add(item.id);
  }
  if (preserveTokens > 0) {
    let accum = 0;
    for (let i = visible.length - 1; i >= 0 && accum < preserveTokens; i--) {
      result.add(visible[i].id);
      accum += visible[i].tokens;
    }
  }
  return result;
}

function splitSpanByBudget(messages, startIdx, endIdx, atomicGroups, budgetTokens) {
  const spans = [];
  let curStart = -1;
  let curEnd = -1;
  let curTokens = 0;

  let i = startIdx;
  while (i <= endIdx) {
    const interval = atomicGroups.get(i);
    const uStart = i;
    const uEnd = interval ? Math.min(endIdx, interval[1]) : i;
    let unitTokens = 0;
    for (let k = uStart; k <= uEnd; k++) {
      unitTokens += countMessageTokens(messages[k]);
    }
    if (curStart === -1) {
      curStart = uStart;
      curEnd = uEnd;
      curTokens = unitTokens;
    } else if (curTokens + unitTokens <= budgetTokens) {
      curEnd = uEnd;
      curTokens += unitTokens;
    } else {
      spans.push([curStart, curEnd]);
      curStart = uStart;
      curEnd = uEnd;
      curTokens = unitTokens;
    }
    i = uEnd + 1;
  }
  if (curStart !== -1) spans.push([curStart, curEnd]);
  return spans;
}

/** 按摘要预算安全切分单条过长文本（保留代理对完整性，避免孤立 UTF-16 代理项）。 */
export function splitSummaryContent(content, budgetTokens) {
  if (!content) return [];
  const budget = Math.max(128, Math.floor(budgetTokens));
  if (countMessageTokens({ text: content }) <= budget) return [content];
  const chunks = [];
  let offset = 0;
  while (offset < content.length) {
    let low = offset + 1;
    let high = content.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countMessageTokens({ text: content.slice(offset, mid) }) <= budget) low = mid;
      else high = mid - 1;
    }
    if (low - offset > 1 && low < content.length) {
      const code = content.charCodeAt(low - 1);
      if (code >= 0xd800 && code <= 0xdbff) low -= 1;
    }
    chunks.push(content.slice(offset, low));
    offset = low;
  }
  return chunks;
}

function truncateSummaryToLimit(text, maxChars, minChars) {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const marker = '\n[truncated]';
  const room = maxChars - marker.length;
  if (room < minChars) return null;
  let cut = text.lastIndexOf('\n', room);
  if (cut < minChars) cut = room;
  const out = `${text.slice(0, cut)}${marker}`;
  return out.length <= maxChars && out.trim().length >= minChars ? out : null;
}

function renderPlannedBlockContent(planned, messages, state) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const parts = [];
  for (const id of planned.directMessageIds ?? []) {
    const m = byId.get(id);
    if (!m) continue;
    const text = m.text ?? '';
    if (!text) continue;
    const label =
      m.contentType === 'tool-call'
        ? `assistant tool-call ${m.toolName ?? 'tool'}`
        : m.contentType === 'tool-result'
          ? `tool result ${m.toolName ?? 'tool'}`
          : m.contentType === 'reasoning'
            ? 'assistant reasoning'
            : m.role;
    parts.push(`[${label}]\n${text}`);
  }
  for (const blockId of planned.directBlockIds ?? []) {
    const child = state.blocks.find((b) => b.blockId === blockId);
    if (!child) continue;
    const label = child.topic ? `${child.blockId}: ${child.topic}` : child.blockId;
    parts.push(`[summarized ${label}]\n${child.summary}`);
  }
  return parts.join('\n\n');
}

function extractAssistantText(response) {
  if (!response) return '';
  if (typeof response.content === 'string') return response.content;
  if (!Array.isArray(response.content)) return '';
  return response.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function computeSummaryInputBudget(model, hardTarget) {
  const modelWindow = typeof model?.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : 32768;
  const effectiveWindow =
    typeof hardTarget === 'number' && Number.isFinite(hardTarget) && hardTarget > 0
      ? Math.min(modelWindow, hardTarget)
      : modelWindow;
  const modelMaxOut = typeof model?.maxTokens === 'number' && Number.isFinite(model.maxTokens) && model.maxTokens > 0
    ? Math.floor(model.maxTokens)
    : MAX_SUMMARY_OUTPUT_TOKENS;
  const outputReserve = Math.min(modelMaxOut, MAX_SUMMARY_OUTPUT_TOKENS);
  const systemReserve = 1200;
  const headroom = Math.max(256, effectiveWindow - outputReserve - systemReserve);
  const fractional = Math.floor(effectiveWindow * 0.5);
  return Math.max(
    Math.min(MIN_SUMMARY_INPUT_TOKENS, Math.max(256, Math.floor(effectiveWindow * 0.4))),
    Math.min(MAX_SUMMARY_INPUT_TOKENS, fractional, headroom),
  );
}

function estimateSummaryText(text) {
  return Math.max(countMessageTokens({ text }), Math.ceil(text.length / 3.5));
}

function computeSummaryMaxTokens(model, hardTarget, systemPrompt, userContent) {
  const window = Math.min(model.contextWindow, hardTarget);
  const available = window - estimateSummaryText(systemPrompt) - estimateSummaryText(userContent) - 128;
  return Math.max(0, Math.min(model.maxTokens || MAX_SUMMARY_OUTPUT_TOKENS, MAX_SUMMARY_OUTPUT_TOKENS, available));
}

async function summarizeViaCompleteSimple({
  models,
  model,
  hardTarget,
  content,
  startRef,
  endRef,
  lengthBudget,
  maxSummaryChars,
  minSummaryLength,
  summaryInputBudget,
  remainingCalls,
  systemOverride,
  abortSignal,
}) {
  abortSignal?.throwIfAborted();
  if (typeof models?.completeSimple !== 'function') {
    return { ok: false, callsUsed: 0, reason: 'models.completeSimple is unavailable' };
  }
  const chunks = splitSummaryContent(content, summaryInputBudget);
  if (chunks.length === 0) {
    return { ok: false, callsUsed: 0, reason: 'empty candidate content' };
  }
  if (chunks.length > remainingCalls) {
    return { ok: false, callsUsed: 0, reason: 'summary call budget exhausted', budgetExceeded: true };
  }

  const perChunkCap =
    typeof lengthBudget === 'number' && Number.isFinite(lengthBudget) && lengthBudget > 0
      ? Math.max(
          minSummaryLength,
          Math.floor((lengthBudget - (chunks.length - 1) * SUMMARY_JOIN_GAP) / chunks.length),
        )
      : undefined;
  const budgetClause =
    perChunkCap && perChunkCap >= minSummaryLength
      ? ` Keep the summary concise and under ${perChunkCap} characters while preserving key facts, decisions, file/symbol identifiers, and user requests.`
      : '';
  const baseSystem =
    systemOverride ??
    `${buildCompressSystemPrompt()}\n\nTASK: Compress conversation segment ${startRef}..${endRef} into a concise tier-1 summary following every rule above. Output ONLY the summary text — no preamble, no closing remarks, no tool calls.${budgetClause}`;

  const pieces = [];
  let callsUsed = 0;
  for (let idx = 0; idx < chunks.length; idx++) {
    abortSignal?.throwIfAborted();
    const chunk = chunks[idx];
    const userContent = chunks.length > 1
      ? `[Part ${idx + 1}/${chunks.length} of ${startRef}..${endRef}]\n${chunk}`
      : chunk;
    const maxTokens = computeSummaryMaxTokens(model, hardTarget, baseSystem, userContent);
    if (maxTokens < 1) return { ok: false, callsUsed, reason: 'summary input exceeds its budget' };
    callsUsed += 1;
    let response;
    try {
      // 同配置模型、同 abort context、无 tools、仅携带受摘要预算约束的当前片段。
      response = await models.completeSimple(
        model,
        {
          systemPrompt: baseSystem,
          messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
        },
        {
          signal: abortSignal,
          maxTokens,
          maxRetries: 0,
          cacheRetention: 'none',
        },
      );
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      return {
        ok: false,
        callsUsed,
        providerError: true,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (abortSignal?.aborted) {
      abortSignal.throwIfAborted();
    }
    if (!response || response.stopReason === 'aborted') {
      if (abortSignal?.aborted) abortSignal.throwIfAborted();
      return { ok: false, callsUsed, providerError: true, reason: 'summary aborted' };
    }
    if (response.stopReason === 'error') {
      return {
        ok: false,
        callsUsed,
        providerError: true,
        reason: response.errorMessage || 'summary provider error',
      };
    }
    if (response.stopReason !== 'stop' || response.content?.some((block) => block.type === 'toolCall')) {
      return { ok: false, callsUsed, reason: 'summary did not finish cleanly' };
    }
    const piece = extractAssistantText(response).trim();
    if (!piece) {
      return { ok: false, callsUsed, reason: 'empty summary text' };
    }
    pieces.push(piece);
  }

  let summary = pieces.join('\n\n').trim();
  if (maxSummaryChars > 0 && summary.length > maxSummaryChars) {
    const truncated = truncateSummaryToLimit(summary, maxSummaryChars, minSummaryLength);
    if (!truncated) {
      return { ok: false, callsUsed, reason: 'summary exceeded maxSummaryLength' };
    }
    summary = truncated;
  }
  if (summary.length < minSummaryLength) {
    return { ok: false, callsUsed, reason: 'summary below minSummaryLength' };
  }
  return { ok: true, summary, callsUsed };
}

function collectCandidateSpans({
  messages,
  state,
  config,
  hardProtectedIds,
  firstUserIndex,
  atomicGroups,
  relaxed,
  summaryInputBudget,
  skippedSpanKeys,
}) {
  const covered = coveredMessageIds(state);
  const byRaw = state.messageRefs?.byRaw ?? {};
  const baseSoftProtected = computeSoftProtectedIds(messages, state, config, hardProtectedIds);
  const activeSoftProtected = relaxed ? new Set() : baseSoftProtected;

  const isIndexEligible = (idx) => {
    if (idx === firstUserIndex) return false;
    const m = messages[idx];
    if (!m || m.role === 'system' || m.id?.startsWith('acp_summary_')) return false;
    if (covered.has(m.id)) return false;
    if (hardProtectedIds.has(m.id)) return false;
    if (activeSoftProtected.has(m.id)) return false;
    const ref = byRaw[m.id];
    return typeof ref === 'string' && ref.length > 0 && ref !== BLOCKED_REF;
  };

  // 构建连续可压缩区段，原子工具对作为一个整体参与资格判断。
  const runs = [];
  let runStart = -1;
  let i = 0;
  while (i < messages.length) {
    const interval = atomicGroups.get(i);
    const uStart = i;
    const uEnd = interval ? interval[1] : i;
    let unitEligible = true;
    for (let k = uStart; k <= uEnd; k++) {
      if (!isIndexEligible(k)) {
        unitEligible = false;
        break;
      }
    }
    if (unitEligible) {
      if (runStart === -1) runStart = uStart;
    } else {
      if (runStart !== -1) {
        runs.push([runStart, uStart - 1]);
        runStart = -1;
      }
    }
    i = uEnd + 1;
  }
  if (runStart !== -1) runs.push([runStart, messages.length - 1]);

  const minCharsFloor = Math.max(150, (config.compress?.minSummaryLength ?? 50) * 3);
  const candidates = [];

  for (const [rStart, rEnd] of runs) {
    const subSpans = splitSpanByBudget(messages, rStart, rEnd, atomicGroups, summaryInputBudget);
    for (const [cs, ce] of subSpans) {
      let startRef = byRaw[messages[cs].id];
      let endRef = byRaw[messages[ce].id];
      if (!startRef || !endRef || startRef === BLOCKED_REF || endRef === BLOCKED_REF) continue;
      const startNum = refToIndex(startRef);
      const endNum = refToIndex(endRef);
      if (startNum !== null && endNum !== null && startNum > endNum) {
        [startRef, endRef] = [endRef, startRef];
      }
      const spanKey = `${startRef}:${endRef}`;
      if (skippedSpanKeys.has(spanKey)) continue;

      let spanTokens = 0;
      let spanChars = 0;
      let touchesSoftZone = false;
      for (let k = cs; k <= ce; k++) {
        spanTokens += countMessageTokens(messages[k]);
        spanChars += (messages[k]?.text ?? '').length;
        if (baseSoftProtected.has(messages[k].id)) touchesSoftZone = true;
      }
      if (spanTokens < MIN_CANDIDATE_TOKENS || spanChars < minCharsFloor) continue;

      candidates.push({
        cs,
        ce,
        startRef,
        endRef,
        spanKey,
        spanTokens,
        spanChars,
        tier: touchesSoftZone ? 2 : 1,
      });
    }
  }

  // 优先可节省历史：近期保护区外按可节省 token 降序（同量按最旧优先）；放宽后的近期区按最旧优先且排在后面。
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1 && b.spanTokens !== a.spanTokens) return b.spanTokens - a.spanTokens;
    return a.cs - b.cs;
  });
  return candidates;
}

function findTierDistillCandidate(messages, state, summaryInputBudget, skippedDistillKeys) {
  const active = activeBlocks(state);
  const msgIndex = new Map();
  for (let i = 0; i < messages.length; i++) msgIndex.set(messages[i].id, i);

  const extentOf = (block) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (const id of block.effectiveMessageIds ?? []) {
      const idx = msgIndex.get(id);
      if (idx === undefined) continue;
      if (idx < lo) lo = idx;
      if (idx > hi) hi = idx;
    }
    return lo <= hi ? [lo, hi] : [-1, -1];
  };

  for (const sourceTier of [1, 2]) {
    const positioned = active
      .filter((b) => b.tier === sourceTier)
      .map((b) => ({ block: b, ext: extentOf(b) }))
      .filter((item) => item.ext[0] >= 0)
      .sort((a, b) => a.ext[0] - b.ext[0]);
    if (positioned.length < 2) continue;

    for (let s = 0; s < positioned.length; s++) {
      let endIdx = s;
      let tokenSum = countMessageTokens({ text: positioned[s].block.summary });
      for (let e = s + 1; e < positioned.length; e++) {
        const nextTokens = countMessageTokens({ text: positioned[e].block.summary });
        if (tokenSum + nextTokens > summaryInputBudget) break;
        tokenSum += nextTokens;
        endIdx = e;
      }
      if (endIdx > s) {
        const first = positioned[s].block;
        const last = positioned[endIdx].block;
        const key = `${first.blockId}:${last.blockId}`;
        if (skippedDistillKeys.has(key)) continue;
        return { sourceTier, first, last, key };
      }
    }
  }
  return null;
}

/**
 * 纯计算 + 摘要 I/O 的预压缩/溢出压缩执行器；不接触 Durable 写事务。
 * 每次候选压缩均通过 kernel refs + applyCompression 预览、摘要、净缩减校验与 Host estimateTokens 复测。
 */
export async function runPreflightCompaction({
  core,
  models,
  model,
  view,
  codec,
  state,
  contentStore,
  config,
  reason,
  hardTarget,
  growthTarget,
  estimateTokens,
  initialEstimate,
  initialBaseEstimate,
  abortSignal,
}) {
  abortSignal?.throwIfAborted();

  const isGrowthOnly =
    reason === 'preflight' &&
    Number.isFinite(initialEstimate) &&
    initialEstimate < hardTarget &&
    growthTarget !== null &&
    initialEstimate >= growthTarget;
  const mode =
    reason === 'overflow'
      ? 'overflow'
      : isGrowthOnly
        ? 'preflight-growth'
        : 'preflight-hard';

  let loopTarget =
    mode === 'overflow'
      ? hardTarget
      : mode === 'preflight-growth'
        ? growthTarget
        : (growthTarget ?? hardTarget);

  const summaryInputBudget = computeSummaryInputBudget(model, hardTarget);
  const { hardProtectedIds, firstUserIndex, atomicGroups } = computeHardProtected(view, codec);

  // 初始化工作副本并确保所有消息都有稳定 refs。
  const seedProjection = projectWithoutNudge(core, codec, state, contentStore, config);
  let workingState = seedProjection.state;
  let workingContentStore = seedProjection.contentStore;
  let currentProjection = null;
  let currentEstimate = initialEstimate;

  let relaxed = false;
  let summaryCalls = 0;
  let compressedRanges = 0;
  let hadCandidates = false;
  let hadSummaryFailure = false;
  let exhausted = false;
  let providerFailed = false;
  let consecutiveFailures = 0;
  const skippedSpanKeys = new Set();

  const topic =
    mode === 'preflight-growth'
      ? 'preflight auto-fold (growth)'
      : mode === 'overflow'
        ? 'overflow compress'
        : 'preflight compress';

  for (let round = 0; round < MAX_COMPACT_ROUNDS; round++) {
    abortSignal?.throwIfAborted();
    if (Number.isFinite(currentEstimate) && currentEstimate < loopTarget) break;
    if (summaryCalls >= MAX_SUMMARY_CALLS) break;
    if (providerFailed || consecutiveFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) break;

    const candidates = collectCandidateSpans({
      messages: codec.messages,
      state: workingState,
      config,
      hardProtectedIds,
      firstUserIndex,
      atomicGroups,
      relaxed,
      summaryInputBudget,
      skippedSpanKeys,
    });

    if (candidates.length === 0) {
      // 增长折叠绝不放宽近期保护区；仅硬预算/溢出路径允许放宽软近期保护（仍保留硬保护）。
      if (mode !== 'preflight-growth' && !relaxed && (!Number.isFinite(currentEstimate) || currentEstimate >= hardTarget)) {
        relaxed = true;
        loopTarget = hardTarget;
        continue;
      }
      exhausted = true;
      break;
    }

    let appliedThisRound = false;
    for (const candidate of candidates) {
      abortSignal?.throwIfAborted();
      if (summaryCalls >= MAX_SUMMARY_CALLS) break;
      if (consecutiveFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) break;

      hadCandidates = true;
      const minSummaryLength = Math.max(50, config.compress?.minSummaryLength ?? 50);
      const maxSummaryChars = config.compress?.maxSummaryLength ?? 20_000;
      const effectiveMinCompressRange = Math.min(
        config.compress?.minCompressRange ?? 5000,
        candidate.spanChars,
      );
      const applyConfig = {
        ...config,
        compress: {
          ...config.compress,
          minCompressRange: effectiveMinCompressRange,
        },
      };
      const protectedRefs = buildProtectedRefSet(hardProtectedIds, workingState);

      // 预览阶段：0 次模型调用即可淘汰 kernel 拒绝的范围。
      const preview = core.applyCompression({
        messages: codec.messages,
        state: workingState,
        config: applyConfig,
        protectedMessageIds: protectedRefs,
        ranges: [
          {
            startRef: candidate.startRef,
            endRef: candidate.endRef,
            summary: 'x'.repeat(minSummaryLength),
            topic,
          },
        ],
      });
      const existingIds = new Set(workingState.blocks.map((b) => b.blockId));
      const planned = preview.state.blocks.find((b) => !existingIds.has(b.blockId));
      if (preview.result.errors.length > 0 || !planned) {
        skippedSpanKeys.add(candidate.spanKey);
        continue;
      }

      const content = renderPlannedBlockContent(planned, codec.messages, workingState);
      if (!content) {
        skippedSpanKeys.add(candidate.spanKey);
        continue;
      }

      const spanTokens = Math.max(planned.compressedTokens || 0, candidate.spanTokens);
      const targetMaxChars = Math.min(
        maxSummaryChars > 0 ? maxSummaryChars : Number.POSITIVE_INFINITY,
        Math.max(minSummaryLength + 50, Math.floor(content.length * 0.4)),
      );

      const summaryOutcome = await summarizeViaCompleteSimple({
        models,
        model,
        hardTarget,
        content,
        startRef: candidate.startRef,
        endRef: candidate.endRef,
        lengthBudget: targetMaxChars,
        maxSummaryChars,
        minSummaryLength,
        summaryInputBudget,
        remainingCalls: MAX_SUMMARY_CALLS - summaryCalls,
        abortSignal,
      });
      summaryCalls += summaryOutcome.callsUsed;

      if (!summaryOutcome.ok) {
        if (summaryOutcome.budgetExceeded) {
          skippedSpanKeys.add(candidate.spanKey);
          continue;
        }
        hadSummaryFailure = true;
        consecutiveFailures += 1;
        skippedSpanKeys.add(candidate.spanKey);
        if (summaryOutcome.providerError) {
          providerFailed = true;
          break;
        }
        continue;
      }

      const summaryTokens = countMessageTokens({ text: summaryOutcome.summary });
      if (summaryTokens + SUMMARY_WRAPPER_OVERHEAD_TOKENS >= spanTokens) {
        hadSummaryFailure = true;
        consecutiveFailures += 1;
        skippedSpanKeys.add(candidate.spanKey);
        continue;
      }

      const applied = core.applyCompression({
        messages: codec.messages,
        state: workingState,
        config: applyConfig,
        protectedMessageIds: protectedRefs,
        ranges: [
          {
            startRef: candidate.startRef,
            endRef: candidate.endRef,
            summary: summaryOutcome.summary,
            topic,
          },
        ],
      });
      if (applied.result.errors.length > 0 || applied.result.blocksCreated === 0) {
        skippedSpanKeys.add(candidate.spanKey);
        continue;
      }

      const stepProjection = projectWithoutNudge(core, codec, applied.state, workingContentStore, config);
      if (stepProjection.turnProvenance.lostInput) {
        skippedSpanKeys.add(candidate.spanKey);
        continue;
      }

      const stepEstimate = await safeEstimateTokens(estimateTokens, stepProjection.messages, abortSignal);
      if (!Number.isFinite(stepEstimate) || stepEstimate >= currentEstimate) {
        consecutiveFailures += 1;
        skippedSpanKeys.add(candidate.spanKey);
        continue;
      }

      workingState = stepProjection.state;
      workingContentStore = stepProjection.contentStore;
      currentProjection = stepProjection;
      currentEstimate = stepEstimate;
      compressedRanges += 1;
      consecutiveFailures = 0;
      appliedThisRound = true;
      break;
    }

    if (!appliedThisRound) {
      if (
        !providerFailed &&
        mode !== 'preflight-growth' &&
        !relaxed &&
        (!Number.isFinite(currentEstimate) || currentEstimate >= hardTarget) &&
        consecutiveFailures < MAX_CONSECUTIVE_SUMMARY_FAILURES
      ) {
        relaxed = true;
        loopTarget = hardTarget;
        continue;
      }
      if (!providerFailed && (candidates.length === 0 || consecutiveFailures === 0)) exhausted = true;
      break;
    }
  }

  // 有界分层蒸馏兜底（仅硬超限且原始范围已耗尽时，T1->T2 / T2->T3，仍保留原消息与可搜索块）。
  if (
    !providerFailed &&
    mode !== 'preflight-growth' &&
    (!Number.isFinite(currentEstimate) || currentEstimate >= hardTarget) &&
    summaryCalls < MAX_SUMMARY_CALLS &&
    consecutiveFailures < MAX_CONSECUTIVE_SUMMARY_FAILURES &&
    config.tiers?.enabled !== false
  ) {
    const skippedDistillKeys = new Set();
    let distillCalls = 0;
    while (
      distillCalls < MAX_TIER_DISTILL_CALLS &&
      summaryCalls < MAX_SUMMARY_CALLS &&
      consecutiveFailures < MAX_CONSECUTIVE_SUMMARY_FAILURES &&
      (!Number.isFinite(currentEstimate) || currentEstimate >= hardTarget)
    ) {
      abortSignal?.throwIfAborted();
      const pick = findTierDistillCandidate(codec.messages, workingState, summaryInputBudget, skippedDistillKeys);
      if (!pick) break;
      hadCandidates = true;
      const minSummaryLength = Math.max(50, config.compress?.minSummaryLength ?? 50);
      const maxSummaryChars = config.compress?.maxSummaryLength ?? 20_000;
      const protectedRefs = buildProtectedRefSet(hardProtectedIds, workingState);

      const preview = core.applyCompression({
        messages: codec.messages,
        state: workingState,
        config,
        protectedMessageIds: protectedRefs,
        ranges: [{ startRef: pick.first.blockId, endRef: pick.last.blockId, summary: 'x'.repeat(minSummaryLength), topic }],
      });
      const existingIds = new Set(workingState.blocks.map((b) => b.blockId));
      const planned = preview.state.blocks.find((b) => !existingIds.has(b.blockId));
      if (preview.result.errors.length > 0 || !planned) {
        skippedDistillKeys.add(pick.key);
        continue;
      }

      const content = renderPlannedBlockContent(planned, codec.messages, workingState);
      if (!content) {
        skippedDistillKeys.add(pick.key);
        continue;
      }

      const rules = pick.sourceTier === 1 ? TIER2_DISTILL_RULES : TIER3_CONDENSE_RULES;
      const systemOverride = `${buildCompressSystemPrompt()}\n\n${rules}\n\nTASK: Distill the tier-${pick.sourceTier} block summaries below (${pick.first.blockId}..${pick.last.blockId}) into ONE concise tier-${pick.sourceTier + 1} summary. Output ONLY the distilled summary text — no preamble, no closing remarks, no tool calls.`;
      const summaryOutcome = await summarizeViaCompleteSimple({
        models,
        model,
        hardTarget,
        content,
        startRef: pick.first.blockId,
        endRef: pick.last.blockId,
        lengthBudget: Math.min(maxSummaryChars > 0 ? maxSummaryChars : Number.POSITIVE_INFINITY, Math.max(minSummaryLength + 50, Math.floor(content.length * 0.45))),
        maxSummaryChars,
        minSummaryLength,
        summaryInputBudget,
        remainingCalls: MAX_SUMMARY_CALLS - summaryCalls,
        systemOverride,
        abortSignal,
      });
      summaryCalls += summaryOutcome.callsUsed;
      distillCalls += 1;

      if (!summaryOutcome.ok) {
        hadSummaryFailure = true;
        consecutiveFailures += 1;
        skippedDistillKeys.add(pick.key);
        if (summaryOutcome.providerError) break;
        continue;
      }

      const applied = core.applyCompression({
        messages: codec.messages,
        state: workingState,
        config,
        protectedMessageIds: protectedRefs,
        ranges: [{ startRef: pick.first.blockId, endRef: pick.last.blockId, summary: summaryOutcome.summary, topic }],
      });
      if (applied.result.errors.length > 0 || applied.result.blocksCreated === 0) {
        skippedDistillKeys.add(pick.key);
        continue;
      }

      const stepProjection = projectWithoutNudge(core, codec, applied.state, workingContentStore, config);
      if (stepProjection.turnProvenance.lostInput) {
        skippedDistillKeys.add(pick.key);
        continue;
      }
      const stepEstimate = await safeEstimateTokens(estimateTokens, stepProjection.messages, abortSignal);
      if (!Number.isFinite(stepEstimate) || stepEstimate >= currentEstimate) {
        consecutiveFailures += 1;
        skippedDistillKeys.add(pick.key);
        continue;
      }

      workingState = stepProjection.state;
      workingContentStore = stepProjection.contentStore;
      currentProjection = stepProjection;
      currentEstimate = stepEstimate;
      compressedRanges += 1;
      consecutiveFailures = 0;
    }
  }

  // 必须证明最终投影相对原请求净缩减（且不能靠剥离临时 nudge 伪造缩减）才允许保存/重发。
  const netReduced =
    compressedRanges > 0 &&
    currentProjection !== null &&
    currentProjection.turnProvenance.lostInput !== true &&
    Number.isFinite(currentEstimate) &&
    currentEstimate < initialEstimate &&
    (!Number.isFinite(initialBaseEstimate) || currentEstimate < initialBaseEstimate);

  return {
    mode,
    compacted: netReduced,
    compressedRanges: netReduced ? compressedRanges : 0,
    hadCandidates,
    hadSummaryFailure,
    exhausted,
    finalEstimate: netReduced ? currentEstimate : initialEstimate,
    finalState: netReduced ? workingState : null,
    finalContentStore: netReduced ? workingContentStore : null,
    finalProjection: netReduced ? currentProjection : null,
  };
}

export { AUTO_FOLD_BACKOFF_MS };
