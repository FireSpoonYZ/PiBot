import { defineDoc } from '@earendil-works/pi-durable';
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
