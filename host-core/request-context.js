import { isDeepStrictEqual } from 'node:util';
import { defineDoc } from '@earendil-works/pi-durable';
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

// Request budgeting is independent of any context-preparation provider.
export const RequestContext = defineDoc({
  kind: 'host.request-context',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ prepared: null }),
  checkpointWhen: () => true,
});

const requestBudgets = new WeakMap();

export function setRequestBudget(messages, tokenCount, contextWindow) {
  // The SDK copies the messages array but preserves its message objects.
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  if (last && typeof last === 'object') {
    requestBudgets.set(last, { tokenCount, contextWindow });
  }
}

export function withRequestBudget(provider) {
  const guard = (method) => (model, context, options) => {
    const budget = requestBudgets.get(context.messages.at(-1));
    if (!budget || budget.tokenCount < budget.contextWindow) {
      return provider[method](model, context, options);
    }
    const error = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'error',
      errorMessage: 'context_length_exceeded: 上下文约 ' + budget.tokenCount +
        ' tokens，达到模型配置的 ' + budget.contextWindow + ' tokens 上限。请压缩对话或调整模型上下文窗口。',
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'error', reason: 'error', error });
    stream.end();
    return stream;
  };
  return { ...provider, stream: guard('stream'), streamSimple: guard('streamSimple') };
}

export function countMessageTokens({ text = '', thinkingTokens = 0 }) {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4) +
    (typeof thinkingTokens === 'number' && Number.isFinite(thinkingTokens) && thinkingTokens > 0 ? thinkingTokens : 0);
}

// SDK estimateContext 同一算法：最新一条带可用 usage 的 assistant（其请求已含
// 当前 head 摘要）作为权威锚点，其后消息与 extra 追加项按估计补差；无锚点则
// 全量估计。view 是 ContextView（contributions/entries/messages 同序）。
export function estimateContextTokensHost(view, extra = []) {
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
  let measuredIndex = -1;
  let anchorTokens = 0;
  for (let i = view.entries.length - 1; i >= 0; i--) {
    if (view.entries[i].id <= after) continue;
    const assistant = (view.contributions[i] ?? []).findLast(
      (message) => message.role === 'assistant' && calculateContextTokens(message.usage) > 0);
    if (assistant) {
      anchorTokens = calculateContextTokens(assistant.usage);
      measuredIndex = view.messages.lastIndexOf(assistant);
      break;
    }
  }
  let tokens = measuredIndex >= 0 ? anchorTokens : 0;
  for (const message of view.messages.slice(measuredIndex + 1)) tokens += estimateMessageTokens(message);
  for (const message of extra) tokens += estimateMessageTokens(message);
  return tokens;
}

// 有序子序列 + 增量计费（JSON 内容对齐，深拷贝同值匹配，重复消息保留各自次数）。
// baseline 全部保留且顺序不变时，baselineTokens 的权威 usage 覆盖仍然成立，
// 只对 baseline 之外的消息逐条 SDK 估计；baseline 有任何删除/替换/重排
//（如 BC 整体投影），原估计不再成立，改按本次有效消息全量 SDK 估计，
// 绝不叠加已被移除的原始历史，也绝不引用比较。
export function budgetRequestTokens(baselineMessages, baselineTokens, messages) {
  const matched = new Array(messages.length).fill(false);
  let index = 0;
  let intact = true;
  for (const want of baselineMessages) {
    const serialized = JSON.stringify(want);
    let found = false;
    while (index < messages.length) {
      const current = index;
      index += 1;
      if (!matched[current] && JSON.stringify(messages[current]) === serialized) {
        matched[current] = true;
        found = true;
        break;
      }
    }
    if (!found) {
      intact = false;
      break;
    }
  }
  if (!intact) {
    // baseline 未完整有序保留（含空基线被当作“全保留”的歧义也走这里：
    // baseline 为空时 intact 保持 true，正好走增量分支）。
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  }
  let tokens = baselineTokens;
  for (const [i, message] of messages.entries()) {
    if (!matched[i]) tokens += estimateMessageTokens(message);
  }
  return tokens;
}

export function countRequestTokens(request) {
  return request.messages.reduce((sum, message) => {
    const content = message.content;
    const pure = (message.role === 'user' || message.role === 'assistant') &&
      (message.role === 'user' && typeof content === 'string' || Array.isArray(content) && content.every((item) => item.type === 'text'));
    const text = pure ? (typeof content === 'string' ? content : content.map((item) => item.text).join('\n')) : JSON.stringify(message);
    return sum + countMessageTokens({ text });
  }, 0);
}

const TURN_CONTEXT_INPUT_ROLES = new Set(['user', 'assistant', 'toolResult']);

function turnError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isMessageObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStrictPlainObject(value) {
  if (!isMessageObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isExplicitAuxiliaryMessage(message) {
  return Boolean(
    isMessageObject(message) &&
    message.role === 'user' &&
    (message.bcContextMaterial === true || message.bcSummaryMaterial === true),
  );
}

export function assertValidAntigravityTurnContext(messages, turnContext) {
  if (!Array.isArray(messages)) throw turnError('INVALID_ARGUMENT', 'Invalid antigravity messages for turnContext');
  if (!isStrictPlainObject(turnContext)) throw turnError('INVALID_ARGUMENT', 'Invalid antigravity turnContext');
  const keys = Object.keys(turnContext);
  if (keys.length !== 2 || !Object.hasOwn(turnContext, 'inputIndex') || !Object.hasOwn(turnContext, 'auxiliaryIndices')) {
    throw turnError('INVALID_ARGUMENT', 'Invalid antigravity turnContext keys');
  }
  const { inputIndex, auxiliaryIndices } = turnContext;
  if (!Array.isArray(auxiliaryIndices)) throw turnError('INVALID_ARGUMENT', 'Invalid antigravity turnContext.auxiliaryIndices');
  const auxSet = new Set();
  let prev = -1;
  for (const idx of auxiliaryIndices) {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= messages.length || idx <= prev) {
      throw turnError('INVALID_ARGUMENT', 'Invalid antigravity turnContext.auxiliaryIndices entry');
    }
    if (!isMessageObject(messages[idx]) || messages[idx].role !== 'user') {
      throw turnError('INVALID_ARGUMENT', 'Antigravity turnContext auxiliary index must point to a user message');
    }
    prev = idx;
    auxSet.add(idx);
  }
  if (inputIndex === null) {
    for (let i = 0; i < messages.length; i++) {
      if (auxSet.has(i)) continue;
      if (!isMessageObject(messages[i]) || messages[i].role !== 'system') {
        throw turnError('INVALID_ARGUMENT', 'Antigravity turnContext.inputIndex cannot be null when non-system non-auxiliary messages exist');
      }
    }
    return turnContext;
  }
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= messages.length || auxSet.has(inputIndex)) {
    throw turnError('INVALID_ARGUMENT', 'Invalid antigravity turnContext.inputIndex');
  }
  if (!isMessageObject(messages[inputIndex]) || !TURN_CONTEXT_INPUT_ROLES.has(messages[inputIndex].role)) {
    throw turnError('INVALID_ARGUMENT', 'Antigravity turnContext.inputIndex must point to a user, assistant, or toolResult message');
  }
  for (let i = inputIndex + 1; i < messages.length; i++) {
    if (auxSet.has(i)) continue;
    if (!isMessageObject(messages[i]) || messages[i].role !== 'system') {
      throw turnError('INVALID_ARGUMENT', 'Antigravity turnContext.inputIndex must be the last non-system non-auxiliary message');
    }
  }
  return turnContext;
}

function sameMessage(a, b) {
  return a === b || (isMessageObject(a) && isMessageObject(b) && a.role === b.role && isDeepStrictEqual(a, b));
}

// 基于真实 Durable cutoff 视图与 prepareContext 结果（优先消费插件侧带 turnProvenance；
// 旧插件仅接受可证明引用、全量有序匹配或无同形歧义的精确结构克隆，禁止任何文本/时间戳猜测）。
export function createTurnProvenanceFromCutoff(cutoffMessages, baselineMessages, requestView, expectedCutoff) {
  if (!Array.isArray(cutoffMessages)) throw turnError('INVALID_STATE', 'Antigravity cutoff context messages are unavailable');
  const baseline = Array.isArray(baselineMessages) ? baselineMessages : cutoffMessages;
  const projected = Array.isArray(requestView) ? requestView : requestView?.messages;
  const sideband = Array.isArray(requestView) ? undefined : requestView?.turnProvenance;
  if (!Array.isArray(projected)) throw turnError('INVALID_STATE', 'Antigravity projected context messages must be an array');

  const sameLen = baseline.length === cutoffMessages.length;
  const cutAt = (i) => (sameLen ? cutoffMessages[i] : baseline[i]);
  const rawRefs = new Set();
  for (let i = 0; i < baseline.length; i++) {
    rawRefs.add(baseline[i]);
    rawRefs.add(cutAt(i));
  }
  const sameRawAt = (msg, i) => sameMessage(msg, baseline[i]) || (cutAt(i) !== baseline[i] && sameMessage(msg, cutAt(i)));
  const matchesRawAt = (msg, i) => {
    const base = baseline[i];
    const cut = cutAt(i);
    if (msg === base || msg === cut) return true;
    if (rawRefs.has(msg)) return false;
    return sameRawAt(msg, i);
  };

  const nonSysRaw = [];
  for (let i = 0; i < baseline.length; i++) {
    const msg = baseline[i];
    if (!isMessageObject(msg)) throw turnError('INVALID_STATE', 'Invalid message entry in Durable cutoff context');
    if (msg.role === 'system' || isExplicitAuxiliaryMessage(msg)) continue;
    if (!TURN_CONTEXT_INPUT_ROLES.has(msg.role)) throw turnError('INVALID_STATE', 'Unsupported message role in Durable cutoff context');
    nonSysRaw.push(i);
  }
  const hasRawInput = nonSysRaw.length > 0;

  // 1) 生产者侧带来源映射（如 BC restoreWithProvenance）：O(n)，直接基于真实 Durable ordinal。
  if (sideband !== undefined) {
    if (!isStrictPlainObject(sideband)) throw turnError('INVALID_STATE', 'Invalid Antigravity turn provenance sideband');
    if (sideband.lostInput !== undefined && typeof sideband.lostInput !== 'boolean') {
      throw turnError('INVALID_STATE', 'Invalid Antigravity turn provenance lostInput flag');
    }
    if (expectedCutoff !== undefined && sideband.cutoff !== expectedCutoff) {
      throw turnError('INVALID_STATE', 'Antigravity turn provenance cutoff mismatch');
    }
    if (sideband.lostInput === true || (hasRawInput && sideband.inputIndex === null)) {
      throw turnError('INVALID_STATE', 'Antigravity turn input was removed by context projection');
    }
    if (!hasRawInput && sideband.inputIndex !== null) {
      throw turnError('INVALID_STATE', 'Antigravity turn provenance contradicts empty cutoff input');
    }
    assertValidAntigravityTurnContext(projected, { inputIndex: sideband.inputIndex, auxiliaryIndices: sideband.auxiliaryIndices });
    if (hasRawInput) {
      const rawInputIndex = nonSysRaw[nonSysRaw.length - 1];
      const rawBase = baseline[rawInputIndex];
      const rawCut = cutAt(rawInputIndex);
      const projInput = projected[sideband.inputIndex];
      if (projInput.role !== rawBase.role) {
        throw turnError('INVALID_STATE', 'Antigravity turn projection changed input role');
      }
      if (projInput !== rawBase && projInput !== rawCut && rawRefs.has(projInput)) {
        throw turnError('INVALID_STATE', 'Antigravity turn projection substituted an earlier message reference');
      }
      if (rawBase.role === 'toolResult' && (
        projInput.toolCallId !== rawBase.toolCallId ||
        projInput.toolName !== rawBase.toolName ||
        Boolean(projInput.isError) !== Boolean(rawBase.isError)
      )) {
        throw turnError('INVALID_STATE', 'Antigravity turn projection changed toolResult identity');
      }
    }
    return { hasRawInput, inputIndex: sideband.inputIndex, auxiliaryIndices: [...sideband.auxiliaryIndices], messages: [...projected] };
  }

  // 2) 原 cutoff 本身无非 system 非辅助输入：仅此时允许 inputIndex: null。
  if (!hasRawInput) {
    const auxiliaryIndices = [];
    for (let j = 0; j < projected.length; j++) {
      const msg = projected[j];
      if (!isMessageObject(msg)) throw turnError('INVALID_STATE', 'Invalid message entry in projected context');
      if (msg.role === 'system') continue;
      if (msg.role === 'user') { auxiliaryIndices.push(j); continue; }
      throw turnError('INVALID_STATE', 'Unexpected non-system message in empty-input turn projection');
    }
    return { hasRawInput: false, inputIndex: null, auxiliaryIndices, messages: [...projected] };
  }

  const rawInputIndex = nonSysRaw[nonSysRaw.length - 1];

  // 3) 线性引用快路径（无 context provider 或原样透传）。
  if (projected.length === baseline.length) {
    let sameAll = true;
    for (let i = 0; i < baseline.length; i++) {
      if (projected[i] !== baseline[i] && projected[i] !== cutAt(i)) { sameAll = false; break; }
    }
    if (sameAll) {
      const auxiliaryIndices = [];
      for (let i = 0; i < projected.length; i++) {
        if (isExplicitAuxiliaryMessage(projected[i])) auxiliaryIndices.push(i);
      }
      return { hasRawInput: true, inputIndex: rawInputIndex, auxiliaryIndices, messages: [...projected] };
    }
  }

  // 4) 旧插件严格回退：只接受可证明引用、全量有序匹配或无同形歧义的精确结构克隆。
  const auxSet = new Set();
  const nonSysProj = [];
  for (let j = 0; j < projected.length; j++) {
    const msg = projected[j];
    if (!isMessageObject(msg)) throw turnError('INVALID_STATE', 'Invalid message entry in projected context');
    if (msg.role === 'system') continue;
    if (isExplicitAuxiliaryMessage(msg)) { auxSet.add(j); continue; }
    nonSysProj.push(j);
  }

  const earlierBuckets = new Map();
  const indexEarlier = (msg, r) => {
    const key = `${msg.role}\0${msg.timestamp}`;
    let list = earlierBuckets.get(key);
    if (!list) { list = []; earlierBuckets.set(key, list); }
    if (list[list.length - 1] !== r) list.push(r);
  };
  for (let r = 0; r < nonSysRaw.length - 1; r++) {
    const i = nonSysRaw[r];
    indexEarlier(baseline[i], r);
    const cut = cutAt(i);
    if (cut !== baseline[i]) indexEarlier(cut, r);
  }
  const findEarlierMatch = (msg, minR, allowKnownRef = false) => {
    const list = earlierBuckets.get(`${msg.role}\0${msg.timestamp}`);
    if (!list) return -1;
    for (const r of list) {
      if (r >= minR && (allowKnownRef ? sameRawAt(msg, nonSysRaw[r]) : matchesRawAt(msg, nonSysRaw[r]))) return r;
    }
    return -1;
  };

  const finalizePositioned = (targetP) => {
    for (let p = targetP + 1; p < nonSysProj.length; p++) {
      const idx = nonSysProj[p];
      const msg = projected[idx];
      if (msg.role !== 'user') throw turnError('INVALID_STATE', 'Unexpected non-user message after turn input');
      if (findEarlierMatch(msg, 0, true) !== -1) throw turnError('INVALID_STATE', 'Antigravity turn projection reordered durable messages');
      auxSet.add(idx);
    }
    let cursor = 0;
    for (let p = 0; p < targetP; p++) {
      const idx = nonSysProj[p];
      const msg = projected[idx];
      const matched = findEarlierMatch(msg, cursor);
      if (matched !== -1) cursor = matched + 1;
      else if (msg.role === 'user') auxSet.add(idx);
    }
    return { hasRawInput: true, inputIndex: nonSysProj[targetP], auxiliaryIndices: [...auxSet].sort((a, b) => a - b), messages: [...projected] };
  };

  // 4a) 唯一精确对象引用（===）证明末条输入身份。
  const rawBase = baseline[rawInputIndex];
  const rawCut = cutAt(rawInputIndex);
  const rawRefUnique = nonSysRaw.filter((i) => baseline[i] === rawBase || cutAt(i) === rawCut).length === 1;
  if (rawRefUnique) {
    const refHits = [];
    for (let p = 0; p < nonSysProj.length; p++) {
      const msg = projected[nonSysProj[p]];
      if (msg === rawBase || msg === rawCut) refHits.push(p);
    }
    if (refHits.length === 1) return finalizePositioned(refHits[0]);
  }

  // 4b) 全部既有 Durable 非 system 消息按严格顺序完整保留（覆盖全量克隆 + 追加辅助）。
  const matchedPos = [];
  let scan = 0;
  for (let r = 0; r < nonSysRaw.length; r++) {
    let found = -1;
    while (scan < nonSysProj.length) {
      const p = scan++;
      if (matchesRawAt(projected[nonSysProj[p]], nonSysRaw[r])) { found = p; break; }
    }
    if (found === -1) { matchedPos.length = 0; break; }
    matchedPos.push(found);
  }
  if (matchedPos.length === nonSysRaw.length) {
    const lastP = matchedPos[matchedPos.length - 1];
    const matchedSet = new Set(matchedPos);
    for (let p = 0; p < nonSysProj.length; p++) {
      if (matchedSet.has(p)) continue;
      const idx = nonSysProj[p];
      if (projected[idx].role !== 'user' || rawRefs.has(projected[idx])) {
        throw turnError('INVALID_STATE', 'Unexpected non-auxiliary message introduced by context projection');
      }
      if (p > lastP && sameRawAt(projected[idx], rawInputIndex)) {
        throw turnError('INVALID_STATE', 'Antigravity turn input position is ambiguous');
      }
      auxSet.add(idx);
    }
    return { hasRawInput: true, inputIndex: nonSysProj[lastP], auxiliaryIndices: [...auxSet].sort((a, b) => a - b), messages: [...projected] };
  }

  // 4c) 发生裁剪时，仅当原末条输入在 raw 中无较早同形项且在投影中精确唯一出现才可确认；否则 fail closed。
  if (findEarlierMatch(rawBase, 0, true) !== -1 || (rawCut !== rawBase && findEarlierMatch(rawCut, 0, true) !== -1)) {
    throw turnError('INVALID_STATE', 'Antigravity turn input cannot be unambiguously located in projection');
  }
  const exactHits = [];
  for (let p = 0; p < nonSysProj.length; p++) {
    if (matchesRawAt(projected[nonSysProj[p]], rawInputIndex)) exactHits.push(p);
  }
  if (exactHits.length !== 1) {
    throw turnError('INVALID_STATE', exactHits.length === 0
      ? 'Antigravity turn input was removed or altered without provenance'
      : 'Antigravity turn input position is ambiguous');
  }
  return finalizePositioned(exactHits[0]);
}

// 追踪后续 append-only 插件（如已有 Hindsight）、路由 system 前置、Durable 浅复制与 normalizeContext。
export function advanceTurnProvenance(provenance, nextMessages, { allowAppendAuxiliaryUsers = false } = {}) {
  if (!provenance || typeof provenance !== 'object') throw turnError('INVALID_STATE', 'Antigravity turn provenance is unavailable');
  if (!Array.isArray(nextMessages)) throw turnError('INVALID_STATE', 'Antigravity request messages must be an array');
  const prev = provenance.messages;

  // O(n) 前置 system + 尾部引用一致（路由指引 / Durable 浅复制 / normalizeContext）。
  const offset = nextMessages.length - prev.length;
  if (offset >= 0) {
    let leadingSys = true;
    for (let i = 0; i < offset; i++) {
      if (!isMessageObject(nextMessages[i]) || nextMessages[i].role !== 'system') { leadingSys = false; break; }
    }
    if (leadingSys) {
      let sameSuffix = true;
      for (let i = 0; i < prev.length; i++) {
        if (nextMessages[offset + i] !== prev[i]) { sameSuffix = false; break; }
      }
      if (sameSuffix) {
        return {
          ...provenance,
          inputIndex: provenance.inputIndex === null ? null : provenance.inputIndex + offset,
          auxiliaryIndices: offset === 0 ? [...provenance.auxiliaryIndices] : provenance.auxiliaryIndices.map((idx) => idx + offset),
          messages: [...nextMessages],
        };
      }
    }
  }

  // O(n) 严格前缀引用一致 + 尾部追加（已有 Hindsight `[...request.messages, recall]`）。
  const prevRefs = new Set(prev);
  if (nextMessages.length >= prev.length) {
    let samePrefix = true;
    for (let i = 0; i < prev.length; i++) {
      if (nextMessages[i] !== prev[i]) { samePrefix = false; break; }
    }
    if (samePrefix) {
      const auxiliaryIndices = [...provenance.auxiliaryIndices];
      for (let j = prev.length; j < nextMessages.length; j++) {
        const msg = nextMessages[j];
        if (!isMessageObject(msg)) throw turnError('INVALID_STATE', 'Invalid message entry appended to request');
        if (msg.role === 'system') continue;
        if (msg.role === 'user' && !prevRefs.has(msg) && (allowAppendAuxiliaryUsers || isExplicitAuxiliaryMessage(msg))) {
          auxiliaryIndices.push(j);
          continue;
        }
        throw turnError('INVALID_STATE', 'Unexpected non-auxiliary message appended after turn input');
      }
      return { ...provenance, auxiliaryIndices, messages: [...nextMessages] };
    }
  }

  // 克隆回退：要求既有非 system 消息全部按顺序精确保留且无已知引用冲突，否则 fail closed。
  const prevAuxSet = new Set(provenance.auxiliaryIndices);
  const prevNonSys = [];
  for (let i = 0; i < prev.length; i++) {
    if (isMessageObject(prev[i]) && prev[i].role !== 'system') prevNonSys.push(i);
  }
  const nextNonSys = [];
  for (let j = 0; j < nextMessages.length; j++) {
    if (!isMessageObject(nextMessages[j])) throw turnError('INVALID_STATE', 'Invalid message entry in request');
    if (nextMessages[j].role !== 'system') nextNonSys.push(j);
  }
  const matchesPrevAt = (msg, prevIdx) => msg === prev[prevIdx] || (!prevRefs.has(msg) && sameMessage(msg, prev[prevIdx]));
  const matchedPrev = new Map();
  let scan = 0;
  for (const prevIdx of prevNonSys) {
    let found = -1;
    while (scan < nextNonSys.length) {
      const k = scan++;
      if (matchesPrevAt(nextMessages[nextNonSys[k]], prevIdx)) { found = k; break; }
    }
    if (found === -1) throw turnError('INVALID_STATE', 'Antigravity turn provenance could not be preserved across request mutation');
    matchedPrev.set(found, prevIdx);
  }
  let inputIndex = null;
  const auxiliaryIndices = [];
  for (let k = 0; k < nextNonSys.length; k++) {
    const j = nextNonSys[k];
    const msg = nextMessages[j];
    if (matchedPrev.has(k)) {
      const prevIdx = matchedPrev.get(k);
      if (prevIdx === provenance.inputIndex) {
        if (isExplicitAuxiliaryMessage(msg)) throw turnError('INVALID_STATE', 'Antigravity turn input was marked as auxiliary');
        inputIndex = j;
      } else if (prevAuxSet.has(prevIdx) || isExplicitAuxiliaryMessage(msg)) {
        if (msg.role !== 'user') throw turnError('INVALID_STATE', 'Auxiliary message must have role user');
        auxiliaryIndices.push(j);
      }
    } else if (msg.role === 'user' && !prevRefs.has(msg) && (allowAppendAuxiliaryUsers || isExplicitAuxiliaryMessage(msg))) {
      if (provenance.inputIndex !== null && inputIndex !== null && sameMessage(msg, prev[provenance.inputIndex])) {
        throw turnError('INVALID_STATE', 'Antigravity turn input position is ambiguous');
      }
      auxiliaryIndices.push(j);
    } else {
      throw turnError('INVALID_STATE', 'Unexpected non-auxiliary message introduced in request projection');
    }
  }
  if (provenance.hasRawInput && inputIndex === null) {
    throw turnError('INVALID_STATE', 'Antigravity turn input was removed by context projection');
  }
  return { ...provenance, inputIndex, auxiliaryIndices, messages: [...nextMessages] };
}

export function resolveAntigravityTurnContext(provenance, payloadMessages) {
  const finalState = advanceTurnProvenance(provenance, payloadMessages, { allowAppendAuxiliaryUsers: false });
  const turnContext = { inputIndex: finalState.inputIndex, auxiliaryIndices: finalState.auxiliaryIndices };
  assertValidAntigravityTurnContext(payloadMessages, turnContext);
  return turnContext;
}

export function createTurnProvenanceStore() {
  const entries = new Map();
  const cleanups = new Map();
  const drop = (key) => {
    entries.delete(key);
    const detach = cleanups.get(key);
    if (detach) {
      cleanups.delete(key);
      detach();
    }
  };
  return {
    set(taskId, state, signal) {
      const key = String(taskId);
      drop(key);
      if (signal?.aborted) return;
      entries.set(key, state);
      if (signal) {
        const onAbort = () => drop(key);
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.set(key, () => signal.removeEventListener('abort', onAbort));
      }
    },
    get(taskId) {
      return entries.get(String(taskId));
    },
    delete(taskId) {
      drop(String(taskId));
    },
  };
}
