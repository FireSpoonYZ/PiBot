// Bounded codemode summaries only. No output parsing, raw details or SDK mutation.
// Kept pure (no I/O); callers own the surrounding frame budget. Shares the
// tool-presentation whitelist with its host-side consumers (projection/wire).
import { projectToolPresentation } from './tool-presentation.js';

export const MAX_NESTED_CALLS = 32;
export const MAX_NESTED_CALLS_BYTES = 49152;
export const MAX_NESTED_CALL_ID_UNITS = 1024;
export const MAX_NESTED_CALL_NAME_UNITS = 256;
export const MAX_TOOL_ARGS_PREVIEW_UNITS = 1024;
export const MAX_TOOL_ERROR_UNITS = 500;
export const NESTED_CALL_STATUSES = new Set(['running', 'ok', 'error', 'cancelled', 'interrupted']);
export const TOOL_OUTCOMES = new Set(['ok', 'error', 'cancelled', 'interrupted']);

const encoder = new TextEncoder();

export function isToolDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isIdentity(value, max) {
  return typeof value === 'string' && value.length <= max && value.trim() !== '' && value.isWellFormed();
}

function preview(value, max) {
  if (typeof value !== 'string') return { truncated: true };
  let text = value;
  const truncated = text.length > max;
  if (truncated) {
    let end = max - 1;
    const unit = text.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) end--;
    text = text.slice(0, end) + '…';
  }
  return text.isWellFormed() ? { text, truncated } : { truncated: true };
}

function copyPreview(target, key, value, max) {
  const part = preview(value, max);
  if (part.text !== undefined) target[key] = part.text;
  return part.truncated;
}

/** Durable numeric id -> the exact nested slot identity <parent>/c<id>. */
export function projectCodemodeCalls(calls, parentCallId, maxBytes = MAX_NESTED_CALLS_BYTES, droppedPresentations = false) {
  const nestedCalls = [];
  if (!Array.isArray(calls) || !isIdentity(parentCallId, MAX_NESTED_CALL_ID_UNITS)) {
    return { nestedCallsTruncated: true };
  }
  // droppedPresentations：装饰器因行数/字节预算丢弃的子调用 presentation 标记，
  // 并入同一 truncated，不在 wire 上新增字段。
  let truncated = calls.length > MAX_NESTED_CALLS || droppedPresentations === true;
  let bytes = 2;
  const ids = new Set();
  for (let i = 0; i < Math.min(calls.length, MAX_NESTED_CALLS); i++) {
    const source = calls[i];
    if (!Number.isSafeInteger(source?.id) || source.id < 0 ||
        !isIdentity(source.name, MAX_NESTED_CALL_NAME_UNITS) || !NESTED_CALL_STATUSES.has(source.status)) {
      truncated = true;
      continue;
    }
    const callId = parentCallId + '/c' + source.id;
    if (callId.length > MAX_NESTED_CALL_ID_UNITS || ids.has(callId)) {
      truncated = true;
      continue;
    }
    ids.add(callId);
    const call = { callId, parentCallId, name: source.name, status: source.status };
    if (source.args !== undefined) {
      truncated = copyPreview(call, 'argsPreview', source.args, MAX_TOOL_ARGS_PREVIEW_UNITS) || truncated;
    }
    if (source.durationMs !== undefined) {
      if (isToolDuration(source.durationMs)) call.durationMs = source.durationMs;
      else truncated = true;
    }
    if (source.error !== undefined) {
      truncated = copyPreview(call, 'error', source.error, MAX_TOOL_ERROR_UNITS) || truncated;
    }
    // 终态 calls[i].presentation 由 codemode-presentations 装饰器按 cN 捕获；
    // 这里再过同一白名单投影，缺失时省略，不合规时置 truncated 不静默丢。
    if (source.presentation !== undefined) {
      const presentation = projectToolPresentation({ presentation: source.presentation });
      if (presentation !== null) call.presentation = presentation;
      else truncated = true;
    }
    const size = encoder.encode(JSON.stringify(call)).byteLength + (nestedCalls.length > 0 ? 1 : 0);
    if (bytes + size > Math.min(maxBytes, MAX_NESTED_CALLS_BYTES)) {
      truncated = true;
      break;
    }
    bytes += size;
    nestedCalls.push(call);
  }
  return { nestedCalls, nestedCallsTruncated: truncated };
}

/** A done slot without summary is incomplete, not evidence of success. */
export function projectNestedToolFields(slot) {
  const fields = { truncated: false };
  if (slot.arguments !== undefined) {
    try {
      fields.truncated = copyPreview(fields, 'argsPreview', JSON.stringify(slot.arguments), MAX_TOOL_ARGS_PREVIEW_UNITS);
    } catch {
      fields.truncated = true;
    }
  }
  const summary = slot.summary;
  if (typeof summary?.isError === 'boolean') {
    fields.outcome = summary.isError ? 'error' : 'ok';
  } else if (slot.status === 'done') {
    fields.truncated = true;
  }
  if (summary?.durationMs !== undefined) {
    if (isToolDuration(summary.durationMs)) fields.durationMs = summary.durationMs;
    else fields.truncated = true;
  }
  if (summary?.error !== undefined) {
    fields.truncated = copyPreview(fields, 'error', summary.error, MAX_TOOL_ERROR_UNITS) || fields.truncated;
  }
  return fields;
}
