// 模块 14：scope 消息只读查询（面向外部 HTTP/client）。直接复用 MessageLog 现有只读
// 查询，不触碰 harness/Native/BC/模型。历史响应强制 1MiB 串行化上限：超限时通过有界
// 二分缩小 limit 重查，保整条消息前缀且 streams/nextCursor 仍由原查询生成；一条都放不下
// 时报 RESPONSE_TOO_LARGE。绝不截断文本或跳过记录。
import { assertId, messageError, normalizeScopeHistoryOptions } from './message-protocol.js';

const MAX_HISTORY_RESPONSE_BYTES = 1024 * 1024;

function serializedSize(page) {
  return Buffer.byteLength(JSON.stringify(page), 'utf8');
}

/**
 * 分页读取 scope 历史：优先一次 limit 查询；序列化超 1MiB 时二分最大可完整容纳的
 * 消息数（<=200 项，至多约 8 次查询）并重新查询，保证返回项是连续完整前缀。
 */
export function readScopeHistory(log, scopeId, options = {}) {
  assertId(scopeId, 'scopeId');
  const { limit, cursor, order } = normalizeScopeHistoryOptions(options);
  const page = log.history(scopeId, { limit, cursor, order });
  if (serializedSize(page) <= MAX_HISTORY_RESPONSE_BYTES) return page;
  let lo = 1;
  let hi = limit;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = log.history(scopeId, { limit: mid, cursor, order });
    if (serializedSize(candidate) <= MAX_HISTORY_RESPONSE_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === 0) {
    throw messageError('RESPONSE_TOO_LARGE', 'scope history exceeds 1 MiB even for a single message');
  }
  return log.history(scopeId, { limit: best, cursor, order });
}

function requireScopeMessage(log, scopeId, messageId) {
  assertId(scopeId, 'scopeId');
  assertId(messageId, 'messageId');
  if (!log.getScope(scopeId)) {
    throw messageError('SCOPE_NOT_FOUND', 'scope not found: ' + scopeId);
  }
  // 消息必须属于请求 scope，跨 scope 一律视为未找到，不泄漏外区数据。
  const stored = log.getMessage(messageId);
  if (!stored || stored.message?.scopeId !== scopeId) {
    throw messageError('MESSAGE_NOT_FOUND', 'message not found: ' + messageId);
  }
  return stored;
}

/** 返回 StoredMessage：{localId, message, digest, storedAt, missingRefs}。 */
export function readScopeMessage(log, scopeId, messageId) {
  return requireScopeMessage(log, scopeId, messageId);
}

/**
 * 返回送达状态；仅校验 scope 归属后转发 log.deliveryStatus（保留其既有 source/ACK 规则，
 * 不发明 ACK）。
 */
export function readScopeMessageDelivery(log, scopeId, messageId) {
  requireScopeMessage(log, scopeId, messageId);
  return log.deliveryStatus(messageId);
}
