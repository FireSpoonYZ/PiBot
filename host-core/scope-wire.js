// host-core/scope-wire.js
// Module 12 wire DTO boundary for managed-scope sync frames. Pure parsing and
// validation only: no authenticated identity, routing or state. Foundation
// normalizers validate nested DTOs; sender binding/roles are enforced by the
// relay server and MessageLog. Never imports relay-protocol (no cycle).
import { messageError, assertId } from './message-protocol.js';
import {
  normalizeScopeRecord,
  normalizeScopeAck,
  normalizeInventoryQuery,
  normalizeHistoryQuery,
  normalizeInventoryPage,
  normalizeHistoryPage,
} from './scope-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

export const SCOPE_SYNC_ERROR_CODES = new Set([
  'INVALID_ARGUMENT',
  'REQUEST_CONFLICT',
  'SCOPE_NOT_FOUND',
  'SCOPE_FORBIDDEN',
  'SCOPE_UNMANAGED',
  'SCOPE_AUTHORITY_REQUIRED',
  'SCOPE_DELETED',
  'BOT_NOT_FOUND',
  'RESPONSE_TOO_LARGE',
  'STORAGE_ERROR',
  'UNSUPPORTED_SCHEMA',
]);

const UNAVAILABLE_CODES = new Set(['OFFLINE', 'BACKPRESSURE', 'UNSUPPORTED']);

// Client direction: targetDeviceId. Server direction: authenticated fromDeviceId.
const CLIENT_TYPES = new Set([
  'scope-offer',
  'scope-ack',
  'scope-reject',
  'replica-request',
  'replica-result',
]);
const SERVER_TYPES = new Set([
  'scope-offer',
  'scope-ack',
  'scope-reject',
  'replica-request',
  'replica-result',
  'scope-unavailable',
  'replica-unavailable',
]);

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

function readScopeOffer(frame, senderKey) {
  rejectUnknownFields(frame, new Set(['type', senderKey, 'record']), 'scope-offer frame');
  assertId(frame[senderKey], senderKey);
  const record = normalizeScopeRecord(frame.record);
  if (record.authorityDeviceId === null) {
    throw invalid('scope-offer record requires a non-null authority');
  }
  return { type: 'scope-offer', [senderKey]: frame[senderKey], record };
}

function readScopeAck(frame, senderKey) {
  rejectUnknownFields(frame, new Set(['type', senderKey, 'ack']), 'scope-ack frame');
  assertId(frame[senderKey], senderKey);
  const ack = normalizeScopeAck(frame.ack);
  return { type: 'scope-ack', [senderKey]: frame[senderKey], ack };
}

function readScopeReject(frame, senderKey) {
  rejectUnknownFields(frame, new Set(['type', senderKey, 'ack', 'code']), 'scope-reject frame');
  assertId(frame[senderKey], senderKey);
  const ack = normalizeScopeAck(frame.ack);
  if (typeof frame.code !== 'string' || !SCOPE_SYNC_ERROR_CODES.has(frame.code)) {
    throw invalid('scope-reject code must be an allowed scope sync error code');
  }
  return { type: 'scope-reject', [senderKey]: frame[senderKey], ack, code: frame.code };
}

function readReplicaRequest(frame, senderKey) {
  rejectUnknownFields(
    frame,
    new Set(['type', senderKey, 'requestId', 'operation', 'query']),
    'replica-request frame'
  );
  assertId(frame[senderKey], senderKey);
  assertId(frame.requestId, 'requestId');
  const operation = frame.operation;
  const query = operation === 'inventory'
    ? normalizeInventoryQuery(frame.query)
    : operation === 'history'
      ? normalizeHistoryQuery(frame.query)
      : null;
  if (query === null) {
    throw invalid("replica-request operation must be 'inventory' or 'history'");
  }
  return {
    type: 'replica-request',
    [senderKey]: frame[senderKey],
    requestId: frame.requestId,
    operation,
    query,
  };
}

function readReplicaResult(frame, senderKey) {
  if (frame.ok === true) {
    rejectUnknownFields(
      frame,
      new Set(['type', senderKey, 'requestId', 'operation', 'ok', 'page']),
      'replica-result frame'
    );
    assertId(frame[senderKey], senderKey);
    assertId(frame.requestId, 'requestId');
    const operation = frame.operation;
    const page = operation === 'inventory'
      ? normalizeInventoryPage(frame.page)
      : operation === 'history'
        ? normalizeHistoryPage(frame.page)
        : null;
    if (page === null) {
      throw invalid("replica-result operation must be 'inventory' or 'history'");
    }
    return {
      type: 'replica-result',
      [senderKey]: frame[senderKey],
      requestId: frame.requestId,
      operation,
      ok: true,
      page,
    };
  }
  if (frame.ok === false) {
    rejectUnknownFields(
      frame,
      new Set(['type', senderKey, 'requestId', 'operation', 'ok', 'code']),
      'replica-result frame'
    );
    assertId(frame[senderKey], senderKey);
    assertId(frame.requestId, 'requestId');
    if (frame.operation !== 'inventory' && frame.operation !== 'history') {
      throw invalid("replica-result operation must be 'inventory' or 'history'");
    }
    if (typeof frame.code !== 'string' || !SCOPE_SYNC_ERROR_CODES.has(frame.code)) {
      throw invalid('replica-result code must be an allowed scope sync error code');
    }
    return {
      type: 'replica-result',
      [senderKey]: frame[senderKey],
      requestId: frame.requestId,
      operation: frame.operation,
      ok: false,
      code: frame.code,
    };
  }
  throw invalid('replica-result ok must be a boolean');
}

function readScopeUnavailable(frame) {
  rejectUnknownFields(
    frame,
    new Set(['type', 'targetDeviceId', 'ack', 'code']),
    'scope-unavailable frame'
  );
  assertId(frame.targetDeviceId, 'targetDeviceId');
  const ack = normalizeScopeAck(frame.ack);
  if (typeof frame.code !== 'string' || !UNAVAILABLE_CODES.has(frame.code)) {
    throw invalid('scope-unavailable code must be OFFLINE, BACKPRESSURE or UNSUPPORTED');
  }
  return {
    type: 'scope-unavailable',
    targetDeviceId: frame.targetDeviceId,
    ack,
    code: frame.code,
  };
}

function readReplicaUnavailable(frame) {
  rejectUnknownFields(
    frame,
    new Set(['type', 'targetDeviceId', 'requestId', 'operation', 'code']),
    'replica-unavailable frame'
  );
  assertId(frame.targetDeviceId, 'targetDeviceId');
  assertId(frame.requestId, 'requestId');
  if (frame.operation !== 'inventory' && frame.operation !== 'history') {
    throw invalid("replica-unavailable operation must be 'inventory' or 'history'");
  }
  if (typeof frame.code !== 'string' || !UNAVAILABLE_CODES.has(frame.code)) {
    throw invalid('replica-unavailable code must be OFFLINE, BACKPRESSURE or UNSUPPORTED');
  }
  return {
    type: 'replica-unavailable',
    targetDeviceId: frame.targetDeviceId,
    requestId: frame.requestId,
    operation: frame.operation,
    code: frame.code,
  };
}

/**
 * Parse a scope sync frame sent by a relay client. Returns the normalized
 * business frame, or null for an unrelated frame type (the caller continues
 * with its own dispatch). A recognized type that is malformed throws
 * messageError INVALID_ARGUMENT.
 */
export function readScopeClientFrame(frame) {
  if (!isPlainObject(frame)) throw invalid('scope frame must be an object');
  if (!CLIENT_TYPES.has(frame.type)) return null;
  switch (frame.type) {
    case 'scope-offer':
      return readScopeOffer(frame, 'targetDeviceId');
    case 'scope-ack':
      return readScopeAck(frame, 'targetDeviceId');
    case 'scope-reject':
      return readScopeReject(frame, 'targetDeviceId');
    case 'replica-request':
      return readReplicaRequest(frame, 'targetDeviceId');
    case 'replica-result':
      return readReplicaResult(frame, 'targetDeviceId');
  }
}

/**
 * Parse a scope sync frame sent by a relay server (fromDeviceId injected by the
 * relay). Same convention as readScopeClientFrame.
 */
export function readScopeServerFrame(frame) {
  if (!isPlainObject(frame)) throw invalid('scope frame must be an object');
  if (!SERVER_TYPES.has(frame.type)) return null;
  switch (frame.type) {
    case 'scope-offer':
      return readScopeOffer(frame, 'fromDeviceId');
    case 'scope-ack':
      return readScopeAck(frame, 'fromDeviceId');
    case 'scope-reject':
      return readScopeReject(frame, 'fromDeviceId');
    case 'replica-request':
      return readReplicaRequest(frame, 'fromDeviceId');
    case 'replica-result':
      return readReplicaResult(frame, 'fromDeviceId');
    case 'scope-unavailable':
      return readScopeUnavailable(frame);
    case 'replica-unavailable':
      return readReplicaUnavailable(frame);
  }
}
