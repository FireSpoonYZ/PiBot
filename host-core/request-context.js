import { isDeepStrictEqual } from 'node:util';
import { defineDoc } from '@earendil-works/pi-durable';
import { clampMaxTokensToContext, resolveSamplingParams } from '@earendil-works/pi-ai/api/simple-options';
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';

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
const OPENAI_CONTEXT_SAFETY_TOKENS = 4096;
const openAIOutputLimits = new Map([
  ['openai-responses', { fields: ['max_output_tokens'], minimum: 16 }],
  ['openai-completions', { fields: ['max_completion_tokens', 'max_tokens'], minimum: 1 }],
]);
export function setBillionContextOutputBudget(messages, tokenCount, contextWindow) {
  // The SDK copies the messages array but preserves its message objects.
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  if (last && typeof last === 'object') {
    requestBudgets.set(last, { tokenCount, contextWindow });
  }
}

export function resolveRequestOutputCap(modelMaxTokens, requestMaxTokens) {
  const requested = requestMaxTokens ?? modelMaxTokens;
  return Math.min(requested, modelMaxTokens ?? requested);
}

function withBillionContextOutputBudget(model, context, options, budget) {
  const outputLimit = openAIOutputLimits.get(model.api);
  const maxTokens = resolveRequestOutputCap(model.maxTokens, options?.maxTokens);
  if (!outputLimit || !Number.isFinite(maxTokens) || maxTokens <= outputLimit.minimum) return options;
  const { safetyTokens } = computeRequestOutputBudget(budget.contextWindow, maxTokens, model.api);
  if (safetyTokens === 0) return options;
  const available = Math.floor(budget.contextWindow - budget.tokenCount) - safetyTokens;

  return {
    ...options,
    async onPayload(payload, requestModel) {
      const field = outputLimit.fields.find((key) => payload?.[key] === outputLimit.minimum && Object.hasOwn(payload, key));
      const replacement = await options?.onPayload?.(payload, requestModel);
      if (!field || (replacement !== undefined && replacement !== payload) ||
          !Object.hasOwn(payload, field) || payload[field] !== outputLimit.minimum ||
          outputLimit.fields.some((key) => key !== field && Object.hasOwn(payload, key))) return replacement;

      // The SDK applies sampling parameters after constructing the output limit.
      const samplingParams = resolveSamplingParams(model, options?.reasoning ?? 'off', options?.samplingParams);
      if (samplingParams && Object.hasOwn(samplingParams, field)) return replacement;
      const requested = options?.maxTokens ?? model.maxTokens;
      if (clampMaxTokensToContext(model, context, requested) > outputLimit.minimum) return replacement;

      // A preserved assistant's usage may still describe the history before BC projected it.
      // Estimates are advisory: let the provider judge requests without estimated output room.
      const outputCap = available > outputLimit.minimum
        ? Math.min(Math.floor(maxTokens), available)
        : Math.floor(maxTokens);
      return { ...payload, [field]: outputCap };
    },
  };
}

export function withBillionContextOutputRepair(provider) {
  return {
    ...provider,
    streamSimple(model, context, options) {
      const budget = requestBudgets.get(context.messages.at(-1));
      const requestOptions = budget ? withBillionContextOutputBudget(model, context, options, budget) : options;
      return provider.streamSimple(model, context, requestOptions);
    },
  };
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

function isMessageObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isExplicitAuxiliaryMessage(message) {
  return Boolean(
    isMessageObject(message) &&
    message.role === 'user' &&
    (message.bcContextMaterial === true || message.bcSummaryMaterial === true),
  );
}

function sameMessage(a, b) {
  return a === b || (isMessageObject(a) && isMessageObject(b) && a.role === b.role && isDeepStrictEqual(a, b));
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

// Protect the latest real user input as well as an active tool exchange, whose results may follow it.
function currentInput(messages) {
  const concrete = messages.filter((message) => message.role !== 'system' && !isExplicitAuxiliaryMessage(message));
  let index = concrete.length - 1;
  if (index < 0) return [];
  while (index >= 0 && concrete[index].role === 'toolResult') index--;
  if (index < 0 || (index < concrete.length - 1 && concrete[index].role !== 'assistant')) return null;
  const input = concrete.slice(index);
  const latestUser = concrete.findLast((message) => message.role === 'user');
  if (latestUser && latestUser !== input[0]) input.unshift(latestUser);
  return input;
}

// Replace only one unambiguous contiguous projection. Preserve routing, recall and other plugin contributions.
export function createBaseProjectionReplacer(finalMessages, baseMessages) {
  if (!baseMessages.length || baseMessages.length > finalMessages.length) return null;
  const input = currentInput(baseMessages);
  if (!input?.length) return null;

  const locate = (matches) => {
    let found = -1;
    for (let start = 0; start <= finalMessages.length - baseMessages.length; start++) {
      if (!baseMessages.every((message, index) => matches(message, finalMessages[start + index]))) continue;
      if (found !== -1) return null;
      found = start;
    }
    return found;
  };
  const refStart = locate((left, right) => left === right);
  const start = refStart === -1 ? locate(sameMessage) : refStart;
  if (start === null || start === -1) return null;

  const prefix = finalMessages.slice(0, start);
  const suffix = finalMessages.slice(start + baseMessages.length);
  return {
    replace(candidate) {
      if (!Array.isArray(candidate) || candidate.some((message) => !isMessageObject(message))) return null;
      const next = currentInput(candidate);
      if (next?.length !== input.length || !input.every((message, index) => sameMessage(message, next[index]))) return null;
      return [...prefix, ...candidate, ...suffix];
    },
  };
}

function computeRequestOutputBudget(contextWindow, maxTokens, api) {
  // Anthropic's input window excludes the independent completion budget.
  if (api === 'anthropic-messages') return { targetTokens: contextWindow, safetyTokens: 0 };
  if (!Number.isFinite(contextWindow) || contextWindow <= 1) return { targetTokens: 1, safetyTokens: 0 };
  const windowInt = Math.floor(contextWindow);
  let reserve;
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    reserve = Math.min(Math.floor(maxTokens), Math.floor(windowInt * 0.25));
  } else {
    reserve = Math.floor(windowInt * 0.1);
  }
  reserve = Math.max(1, Math.min(reserve, windowInt - 1));
  const target = Math.max(1, windowInt - reserve);
  // Keep the previous policy when the fixed margin leaves no usable input budget.
  const safetyTokens = openAIOutputLimits.has(api) && target > OPENAI_CONTEXT_SAFETY_TOKENS + 1
    ? OPENAI_CONTEXT_SAFETY_TOKENS
    : 0;
  return { targetTokens: target - safetyTokens, safetyTokens };
}

export function computePreflightTargetTokens(contextWindow, maxTokens = 0, api) {
  return computeRequestOutputBudget(contextWindow, maxTokens, api).targetTokens;
}

function parsePositiveInt(raw) {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function parseOverflowLimits(errorMessage) {
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) {
    return {};
  }
  let contextWindow;
  let inputLimit;
  let outputReserve;
  let actualTokens;

  const setMin = (cur, next) => (next === undefined ? cur : cur === undefined ? next : Math.min(cur, next));
  const setMax = (cur, next) => (next === undefined ? cur : cur === undefined ? next : Math.max(cur, next));

  // Input/prompt-specific limits (already exclude output reserve)
  const anthropic = /prompt (?:is )?too long:\s*([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*maximum/i.exec(errorMessage);
  if (anthropic) {
    actualTokens = setMax(actualTokens, parsePositiveInt(anthropic[1]));
    inputLimit = setMin(inputLimit, parsePositiveInt(anthropic[2]));
  }
  const gemini = /input token count\s*\(([\d,]+)\)\s*exceeds the maximum(?: number of tokens)? allowed\s*\(([\d,]+)\)/i.exec(errorMessage);
  if (gemini) {
    actualTokens = setMax(actualTokens, parsePositiveInt(gemini[1]));
    inputLimit = setMin(inputLimit, parsePositiveInt(gemini[2]));
  }
  const xai = /maximum prompt length is\s*([\d,]+)(?:.*?contains\s*([\d,]+)\s*tokens?)?/i.exec(errorMessage);
  if (xai) {
    inputLimit = setMin(inputLimit, parsePositiveInt(xai[1]));
    actualTokens = setMax(actualTokens, parsePositiveInt(xai[2]));
  }
  const orInput = /input length\s*\(?([\d,]+)\)?\s*exceeds (?:the )?maximum allowed input length of\s*([\d,]+)\s*tokens?/i.exec(errorMessage);
  if (orInput) {
    actualTokens = setMax(actualTokens, parsePositiveInt(orInput[1]));
    inputLimit = setMin(inputLimit, parsePositiveInt(orInput[2]));
  }
  const copilot = /prompt token count of\s*([\d,]+)\s*exceeds (?:the )?limit of\s*([\d,]+)/i.exec(errorMessage);
  if (copilot) {
    actualTokens = setMax(actualTokens, parsePositiveInt(copilot[1]));
    inputLimit = setMin(inputLimit, parsePositiveInt(copilot[2]));
  }
  const dashscope = /range of input length should be\s*\[\s*[\d,]+\s*,\s*([\d,]+)\s*\]/i.exec(errorMessage);
  if (dashscope) {
    inputLimit = setMin(inputLimit, parsePositiveInt(dashscope[1]));
  }

  // Total context window limits (input + output)
  const maxCtxIs = /maximum context length is\s*([\d,]+)\s*tokens?/i.exec(errorMessage);
  if (maxCtxIs) {
    contextWindow = setMin(contextWindow, parsePositiveInt(maxCtxIs[1]));
  }
  const maxCtxOf = /(?:input length\s*\(([\d,]+)\)\s*)?exceeds (?:the )?(?:model'?s )?maximum context length(?:\s+of\s*([\d,]+)\s*tokens?|\s*\(([\d,]+)\))/i.exec(errorMessage);
  if (maxCtxOf) {
    actualTokens = setMax(actualTokens, parsePositiveInt(maxCtxOf[1]));
    contextWindow = setMin(contextWindow, parsePositiveInt(maxCtxOf[2] ?? maxCtxOf[3]));
  }
  const together = /input\s*\(([\d,]+)\s*tokens?\)\s*is longer than the model'?s context length\s*\(([\d,]+)\s*tokens?\)/i.exec(errorMessage);
  if (together) {
    actualTokens = setMax(actualTokens, parsePositiveInt(together[1]));
    contextWindow = setMin(contextWindow, parsePositiveInt(together[2]));
  }
  const kimi = /exceeded model token limit:\s*([\d,]+)(?:\s*\(requested:\s*([\d,]+)\))?/i.exec(errorMessage);
  if (kimi) {
    contextWindow = setMin(contextWindow, parsePositiveInt(kimi[1]));
    actualTokens = setMax(actualTokens, parsePositiveInt(kimi[2]));
  }
  const ds4 = /prompt has\s*([\d,]+)\s*tokens?,?\s*but (?:the )?configured context size is\s*([\d,]+)\s*tokens?/i.exec(errorMessage);
  if (ds4) {
    actualTokens = setMax(actualTokens, parsePositiveInt(ds4[1]));
    contextWindow = setMin(contextWindow, parsePositiveInt(ds4[2]));
  }
  const mistral = /prompt contains\s*([\d,]+)\s*tokens?.*?model with\s*([\d,]+)\s*maximum context length/i.exec(errorMessage);
  if (mistral) {
    actualTokens = setMax(actualTokens, parsePositiveInt(mistral[1]));
    contextWindow = setMin(contextWindow, parsePositiveInt(mistral[2]));
  }

  // Output / completion reserve & input breakdown
  const inMessages = /([\d,]+)\s+(?:in the messages|in your prompt|of (?:text )?input)/i.exec(errorMessage);
  if (inMessages) {
    actualTokens = parsePositiveInt(inMessages[1]) ?? actualTokens;
  }
  const inCompletion = /([\d,]+)\s+(?:in|for) the (?:completion|output)/i.exec(errorMessage);
  if (inCompletion) {
    outputReserve = setMax(outputReserve, parsePositiveInt(inCompletion[1]));
  }
  const maxTokensHint = /(?:max_completion_tokens|max_output_tokens|max_tokens)\s*(?:=|:|is|of)\s*([\d,]+)/i.exec(errorMessage);
  if (maxTokensHint) {
    outputReserve = setMax(outputReserve, parsePositiveInt(maxTokensHint[1]));
  }
  if (actualTokens === undefined) {
    const reqTotal = /(?:messages resulted in|you requested(?: about)?)\s*([\d,]+)\s*tokens?/i.exec(errorMessage);
    if (reqTotal) {
      const totalReported = parsePositiveInt(reqTotal[1]);
      if (totalReported !== undefined) {
        actualTokens = outputReserve !== undefined && totalReported > outputReserve
          ? totalReported - outputReserve
          : totalReported;
      }
    }
  }

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    ...(outputReserve !== undefined ? { outputReserve } : {}),
    ...(actualTokens !== undefined ? { actualTokens } : {}),
  };
}

export function computeOverflowRecoveryBudget({
  configuredContextWindow,
  modelMaxTokens = 0,
  api,
  sentEstimatedTokens,
  errorMessage,
}) {
  const configured = Number.isFinite(configuredContextWindow) && configuredContextWindow > 0
    ? Math.floor(configuredContextWindow)
    : 1;
  const sent = Number.isFinite(sentEstimatedTokens) && sentEstimatedTokens > 0
    ? Math.floor(sentEstimatedTokens)
    : 0;
  const parsed = parseOverflowLimits(errorMessage);

  // Clamp downward for this turn only; never widen and never write back to the model catalog.
  const reportedBound = parsed.contextWindow !== undefined && parsed.inputLimit !== undefined
    ? Math.min(parsed.contextWindow, parsed.inputLimit)
    : (parsed.contextWindow ?? parsed.inputLimit);
  const effectiveContextWindow = reportedBound !== undefined && reportedBound < configured
    ? reportedBound
    : configured;

  let windowTarget;
  if (parsed.inputLimit !== undefined) {
    const effectiveInputCap = Math.min(effectiveContextWindow, parsed.inputLimit);
    windowTarget = effectiveInputCap > 1
      ? Math.max(1, Math.min(effectiveInputCap - 1, Math.floor(effectiveInputCap * 0.95)))
      : 1;
  } else if (parsed.contextWindow !== undefined) {
    let reserve = 0;
    if (parsed.outputReserve !== undefined && parsed.outputReserve > 0 && parsed.outputReserve < effectiveContextWindow) {
      reserve = parsed.outputReserve;
    } else if (Number.isFinite(modelMaxTokens) && modelMaxTokens > 0 && effectiveContextWindow > 1) {
      reserve = Math.min(Math.floor(modelMaxTokens), Math.floor(effectiveContextWindow * 0.5));
    }
    const available = Math.max(1, effectiveContextWindow - reserve);
    windowTarget = available > 1
      ? Math.max(1, Math.min(available - 1, Math.floor(available * 0.95)))
      : 1;
  }

  if (windowTarget !== undefined && parsed.actualTokens !== undefined && sent > 0 && parsed.actualTokens > sent) {
    windowTarget = Math.max(1, Math.floor(windowTarget * (sent / parsed.actualTokens)));
  }

  // Must strictly shrink below the rejected request (90%, and <= sent - 1 when sent > 1).
  const shrinkCap = sent > 1
    ? Math.min(sent - 1, Math.max(1, Math.floor(sent * 0.9)))
    : (sent === 1 ? 1 : Math.max(1, effectiveContextWindow - 1));
  const outputBudget = computeRequestOutputBudget(effectiveContextWindow, modelMaxTokens, api);
  const windowCap = outputBudget.safetyTokens > 0
    ? outputBudget.targetTokens
    : Math.max(1, effectiveContextWindow - 1);

  const targetTokens = windowTarget !== undefined
    ? Math.max(1, Math.min(windowTarget, shrinkCap, windowCap))
    : Math.max(1, Math.min(shrinkCap, windowCap));

  return {
    effectiveContextWindow,
    targetTokens,
    parsed,
  };
}
