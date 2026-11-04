// host-core/hindsight-protocol.js
// M13 Hindsight 记忆适配器边界：稳定错误码与严格输入归一化。
// 纯函数模块，无网络/store/FS 访问；只在公开输入边界校验，内部已规范化数据直接放行。
import { assertId } from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const MAX_QUERY_BYTES = 32768;
const MAX_TEXT_BYTES = 65536;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 4096;
const JOB_STATES = new Set(['pending', 'accepted', 'completed', 'failed']);
const DEFAULT_STATUS_LIMIT = 20;
const MAX_STATUS_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 创建携带稳定 machine-readable code 的 Error；message 仅面向人类阅读。 */
export function memoryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalid(message) {
  return memoryError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

function assertText(value, name, maxBytes) {
  if (typeof value !== 'string' || value.trim() === '' || !value.isWellFormed()) {
    throw invalid(`${name} must be a non-blank well-formed string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalid(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  }
}

// 后端资源 ID：额外拒绝 '.'/'..'，防止 URL 路径段逃逸；lone surrogate 已由 assertId 的
// isWellFormed 校验拒绝。
function assertBackendId(value, name) {
  assertId(value, name);
  if (value === '.' || value === '..') {
    throw invalid(`${name} must not be '.' or '..'`);
  }
}

/**
 * memoryContextKey：稳定上下文键 = JSON.stringify([botId, kind, scopeId|null, ...(topic ? [topic] : [])])。
 * 信任已归一化 target（normalizeMemoryTarget 产物）；非 scope 变体 scopeId 为 null。
 */
export function memoryContextKey(botId, target, topic) {
  const normalizedTopic = typeof topic === 'string' && topic.trim().length > 0 ? topic.trim() : null;
  const tuple = normalizedTopic
    ? [botId, target.kind, target.kind === 'scope' ? target.scopeId : null, normalizedTopic]
    : [botId, target.kind, target.kind === 'scope' ? target.scopeId : null];
  return JSON.stringify(tuple);
}

/**
 * normalizeMemoryTarget：undefined => {kind:'primary'}；严格变体。
 * primary/shared 只允许 kind；scope 必须携带非空白 scopeId。拒绝 null/数组/未知字段。
 */
export function normalizeMemoryTarget(value) {
  if (value === undefined) return { kind: 'primary' };
  if (!isPlainObject(value)) throw invalid('memory target must be a plain object');
  if (value.kind === 'primary' || value.kind === 'shared') {
    rejectUnknownFields(value, new Set(['kind']), 'memory target');
    return { kind: value.kind };
  }
  if (value.kind === 'scope') {
    rejectUnknownFields(value, new Set(['kind', 'scopeId']), 'memory target');
    assertId(value.scopeId, 'target.scopeId');
    return { kind: 'scope', scopeId: value.scopeId };
  }
  throw invalid("memory target.kind must be 'primary', 'scope', or 'shared'");
}

/** 严格 {target?,query,maxTokens?}；query 非空白且 ≤32768 UTF-8，maxTokens 1..4096 默认 1024。 */
export function normalizeMemoryQuery(input) {
  if (!isPlainObject(input)) throw invalid('memory query must be a plain object');
  rejectUnknownFields(input, new Set(['target', 'query', 'maxTokens']), 'memory query');
  const target = normalizeMemoryTarget(input.target);
  assertText(input.query, 'query', MAX_QUERY_BYTES);
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (input.maxTokens !== undefined) {
    if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > MAX_MAX_TOKENS) {
      throw invalid(`maxTokens must be a positive safe integer between 1 and ${MAX_MAX_TOKENS}`);
    }
    maxTokens = input.maxTokens;
  }
  return { target, query: input.query, maxTokens };
}

/** 严格 {requestId,target?,text}；text 非空白且 ≤65536 UTF-8。 */
export function normalizeMemoryRetain(input) {
  if (!isPlainObject(input)) throw invalid('memory retain input must be a plain object');
  rejectUnknownFields(input, new Set(['requestId', 'target', 'text']), 'memory retain input');
  assertId(input.requestId, 'requestId');
  const target = normalizeMemoryTarget(input.target);
  assertText(input.text, 'text', MAX_TEXT_BYTES);
  return { requestId: input.requestId, target, text: input.text };
}

/** 严格 {target?,memoryId}；memoryId 为后端资源 ID。 */
export function normalizeMemoryLookup(input) {
  if (!isPlainObject(input)) throw invalid('memory lookup input must be a plain object');
  rejectUnknownFields(input, new Set(['target', 'memoryId']), 'memory lookup input');
  const target = normalizeMemoryTarget(input.target);
  assertBackendId(input.memoryId, 'memoryId');
  return { target, memoryId: input.memoryId };
}

/** 严格 {target?,documentId}；documentId 为后端资源 ID。 */
export function normalizeMemorySource(input) {
  if (!isPlainObject(input)) throw invalid('memory source input must be a plain object');
  rejectUnknownFields(input, new Set(['target', 'documentId']), 'memory source input');
  const target = normalizeMemoryTarget(input.target);
  assertBackendId(input.documentId, 'documentId');
  return { target, documentId: input.documentId };
}

/** 严格 {requestId,target?,memoryId,text?,state?,reason?}；text/state 至少一项。 */
export function normalizeMemoryCorrection(input) {
  if (!isPlainObject(input)) throw invalid('memory correction input must be a plain object');
  rejectUnknownFields(input, new Set(['requestId', 'target', 'memoryId', 'text', 'state', 'reason']), 'memory correction input');
  assertId(input.requestId, 'requestId');
  const target = normalizeMemoryTarget(input.target);
  assertBackendId(input.memoryId, 'memoryId');
  if (input.text === undefined && input.state === undefined) {
    throw invalid('memory correction requires text or state');
  }
  const normalized = { requestId: input.requestId, target, memoryId: input.memoryId };
  if (input.text !== undefined) {
    assertText(input.text, 'text', MAX_TEXT_BYTES);
    normalized.text = input.text;
  }
  if (input.state !== undefined) {
    if (input.state !== 'valid' && input.state !== 'invalidated') {
      throw invalid("state must be 'valid' or 'invalidated'");
    }
    normalized.state = input.state;
  }
  if (input.reason !== undefined) {
    assertText(input.reason, 'reason', MAX_TEXT_BYTES);
    normalized.reason = input.reason;
  }
  return normalized;
}

/** 严格 {target?,operationId}；operationId 必须为 UUID。 */
export function normalizeMemoryRetry(input) {
  if (!isPlainObject(input)) throw invalid('memory retry input must be a plain object');
  rejectUnknownFields(input, new Set(['target', 'operationId']), 'memory retry input');
  const target = normalizeMemoryTarget(input.target);
  if (typeof input.operationId !== 'string' || !UUID_RE.test(input.operationId)) {
    throw invalid('operationId must be a UUID');
  }
  return { target, operationId: input.operationId };
}

/**
 * 严格 {target?,state?,limit?,cursor?}；memoryStatus 分页输入。
 * state 可选 pending|accepted|completed|failed；limit 1..200 默认 20；
 * cursor 必须携带 bankId/state/afterOperationId，bankId 仅作已派生上下文的续页绑定，
 * 不是可选目标（target 选择仍由 normalizeMemoryTarget 决定）。
 */
export function normalizeMemoryStatus(input = {}) {
  if (!isPlainObject(input)) throw invalid('memory status input must be a plain object');
  rejectUnknownFields(input, new Set(['target', 'state', 'limit', 'cursor']), 'memory status input');
  const target = normalizeMemoryTarget(input.target);
  let state;
  if (input.state !== undefined) {
    if (typeof input.state !== 'string' || !JOB_STATES.has(input.state)) {
      throw invalid("state must be 'pending', 'accepted', 'completed', or 'failed'");
    }
    state = input.state;
  }
  let limit = DEFAULT_STATUS_LIMIT;
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_STATUS_LIMIT) {
      throw invalid(`limit must be a positive safe integer between 1 and ${MAX_STATUS_LIMIT}`);
    }
    limit = input.limit;
  }
  let cursor;
  if (input.cursor !== undefined) {
    if (!isPlainObject(input.cursor)) throw invalid('memory status cursor must be a plain object');
    rejectUnknownFields(input.cursor, new Set(['bankId', 'state', 'afterOperationId']), 'memory status cursor');
    assertBackendId(input.cursor.bankId, 'cursor.bankId');
    if (
      input.cursor.state !== null &&
      (typeof input.cursor.state !== 'string' || !JOB_STATES.has(input.cursor.state))
    ) {
      throw invalid('cursor.state must be null or a job state');
    }
    if (typeof input.cursor.afterOperationId !== 'string' || !UUID_RE.test(input.cursor.afterOperationId)) {
      throw invalid('cursor.afterOperationId must be a UUID');
    }
    cursor = {
      bankId: input.cursor.bankId,
      state: input.cursor.state,
      afterOperationId: input.cursor.afterOperationId,
    };
  }
  const normalized = { target, limit };
  if (state !== undefined) normalized.state = state;
  if (cursor !== undefined) normalized.cursor = cursor;
  return normalized;
}
