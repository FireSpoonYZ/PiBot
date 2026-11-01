// Relay wire protocol boundary helper (modules 8-9). Parses/validates relay
// frames and relay URLs; no ws, no Runtime, no generic schema framework.
// Module 9 adds optional hello/ready role fields and fixed-direction control-*
// frames, delegated to remote-control-protocol.js helpers.
// Module 12 adds the host-only optional scopeProtocol:1 hello/ready capability
// and delegates managed-scope sync frames to scope-wire.js helpers.
// Module 14 adds controlProtocol 1/2 negotiation and delegates live-* frames
// to remote-live-protocol.js helpers.
import { normalizeDeviceName, normalizeDevicePlatform } from './device-metadata.js';
import { messageError, assertId, normalizeEnvelope, normalizeAck } from './message-protocol.js';
import { readControlClientFrame, readControlHostFrame, readControlServerFrame } from './remote-control-protocol.js';
import { readLiveClientFrame, readLiveHostFrame, readLiveServerFrame } from './remote-live-protocol.js';
import { readScopeClientFrame, readScopeServerFrame } from './scope-wire.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

export const MAX_RELAY_FRAME_BYTES = 41943040; // 40 MiB, actual UTF-8 bytes
export const RELAY_HIGH_WATER_BYTES = 83886080; // 80 MiB bufferedAmount + frame budget
export const RELAY_HELLO_TIMEOUT_MS = 5000;
export const RELAY_HEARTBEAT_MS = 15000;

export const RELAY_CLOSE = Object.freeze({
  BAD_FRAME: 4400,
  UNAUTHORIZED: 4401,
  REVOKED: 4403,
  HELLO_TIMEOUT: 4408,
  REPLACED: 4409,
});

// Allowed relay reject codes; reject frames carry NO free-form message.
// Read-only in practice: never mutate; internal receiver imports this set.
export const DELIVERY_REJECT_CODES = new Set([
  'INVALID_ARGUMENT',
  'REQUEST_CONFLICT',
  'UNSUPPORTED_SCHEMA',
  'BOT_NOT_FOUND',
  'SCOPE_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'DELIVERY_NOT_FOUND',
  'SCOPE_FORBIDDEN',
  'PEER_MISMATCH',
  'STORE_FAILED',
]);

const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{32,512}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const FRAME_MAX_TEXT = 'relay frame exceeds 40 MiB';

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

export function isCertificateError(error) {
  return typeof error?.code === 'string' && /^(?:CERT_|CRL_|ERROR_IN_CERT_|ERR_TLS_CERT_|ERR_OSSL_PEM_|ERR_OSSL_X509_|ERR_SSL_CERTIFICATE_VERIFY_FAILED$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE|DECRYPT_CERT_SIGNATURE|DECODE_ISSUER_PUBLIC_KEY)|INVALID_CA$|INVALID_PURPOSE$|PATH_LENGTH_EXCEEDED$|HOSTNAME_MISMATCH$)/.test(error.code);
}

export function assertDeviceToken(token) {
  if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) {
    throw invalid('token must be 32-512 characters of A-Za-z0-9_-');
  }
}

function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw invalid('digest must be a lowercase 64-character hex SHA-256');
  }
}

/**
 * Parse and validate a relay URL. ws is loopback-only (literal 127.0.0.1 or
 * ::1); wss accepts any non-empty host. Path must be exactly /v1/link with no
 * query, fragment, or user info. Redirects are rejected by the client, not here.
 */
export function parseRelayUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('relay URL must be a valid ws:// or wss:// URL');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw invalid('relay URL must use ws:// or wss://');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid('relay URL must not contain user info');
  }
  if (url.search !== '') {
    throw invalid('relay URL must not contain a query string');
  }
  if (url.hash !== '') {
    throw invalid('relay URL must not contain a fragment');
  }
  if (url.hostname === '') {
    throw invalid('relay URL must include a host');
  }
  if (url.pathname !== '/v1/link') {
    throw invalid('relay URL path must be exactly /v1/link');
  }
  if (url.protocol === 'ws:' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw invalid('ws relay URLs are allowed only for literal loopback 127.0.0.1 or ::1');
  }
  return url;
}

function decodeText(data) {
  if (typeof data === 'string') {
    if (!data.isWellFormed()) {
      throw invalid('relay frame must be valid UTF-8 text');
    }
    return data;
  }
  if (data instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw invalid('relay frame must be valid UTF-8 text');
    }
  }
  throw invalid('relay frame must be a string or bytes');
}

function frameBytes(data) {
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
}

function parseFrame(data) {
  if (frameBytes(data) > MAX_RELAY_FRAME_BYTES) {
    throw invalid(FRAME_MAX_TEXT);
  }
  let value;
  try {
    value = JSON.parse(decodeText(data));
  } catch (err) {
    if (err && err.code === INVALID_ARGUMENT) throw err;
    throw invalid('relay frame must be valid JSON text');
  }
  if (!isPlainObject(value)) {
    throw invalid('relay frame must be a JSON object');
  }
  return value;
}

function readHello(frame) {
  rejectUnknownFields(frame, new Set(['type', 'protocolVersion', 'deviceId', 'token', 'role', 'controlProtocol', 'scopeProtocol', 'displayName', 'platform']), 'hello frame');
  if (frame.protocolVersion !== 1) throw invalid('hello.protocolVersion must be 1');
  assertId(frame.deviceId, 'deviceId');
  assertDeviceToken(frame.token);
  const normalized = { type: 'hello', protocolVersion: 1, deviceId: frame.deviceId, token: frame.token };
  if (frame.role !== undefined) {
    if (frame.role !== 'host' && frame.role !== 'client') {
      throw invalid('hello.role must be host or client');
    }
    normalized.role = frame.role;
  }
  if (frame.controlProtocol !== undefined) {
    if (frame.controlProtocol !== 1 && frame.controlProtocol !== 2) {
      throw invalid('hello.controlProtocol must be 1 or 2');
    }
    if (normalized.role === 'client' && frame.controlProtocol === 1) {
      throw invalid('hello.controlProtocol 1 is not allowed for the client role');
    }
    normalized.controlProtocol = frame.controlProtocol;
  }
  if (frame.scopeProtocol !== undefined) {
    if (frame.scopeProtocol !== 1) {
      throw invalid('hello.scopeProtocol must be 1');
    }
    if (normalized.role === 'client') {
      throw invalid('hello.scopeProtocol is allowed only for the host role');
    }
    normalized.scopeProtocol = 1;
  }
  if (frame.displayName !== undefined || frame.platform !== undefined) {
    if (normalized.role === 'client') throw invalid('hello metadata is host-only');
    if (frame.displayName !== undefined) normalized.displayName = normalizeDeviceName(frame.displayName);
    if (frame.platform !== undefined) normalized.platform = normalizeDevicePlatform(frame.platform);
  }
  return normalized;
}

function readReady(frame) {
  rejectUnknownFields(frame, new Set(['type', 'protocolVersion', 'deviceId', 'role', 'controlProtocol', 'scopeProtocol']), 'ready frame');
  if (frame.protocolVersion !== 1) throw invalid('ready.protocolVersion must be 1');
  assertId(frame.deviceId, 'deviceId');
  let role = 'host';
  if (frame.role !== undefined) {
    if (frame.role !== 'host' && frame.role !== 'client') {
      throw invalid('ready.role must be host or client');
    }
    role = frame.role;
  }
  const normalized = { type: 'ready', protocolVersion: 1, deviceId: frame.deviceId, role };
  if (frame.controlProtocol !== undefined) {
    if (frame.controlProtocol !== 2) {
      throw invalid('ready.controlProtocol must be 2 when present');
    }
    normalized.controlProtocol = 2;
  }
  if (frame.scopeProtocol !== undefined) {
    if (frame.scopeProtocol !== 1) {
      throw invalid('ready.scopeProtocol must be 1');
    }
    if (role === 'client') {
      throw invalid('ready.scopeProtocol is allowed only for the host role');
    }
    normalized.scopeProtocol = 1;
  }
  return normalized;
}

// Cross-checks needing the authenticated device (source === authenticated,
// target !== self) live in the relay server, not in this pure parser.
function readClientDeliver(frame) {
  rejectUnknownFields(frame, new Set(['type', 'targetDeviceId', 'message']), 'deliver frame');
  assertId(frame.targetDeviceId, 'targetDeviceId');
  const message = normalizeEnvelope(frame.message);
  if (frame.targetDeviceId === message.sourceDeviceId) {
    throw invalid('deliver target must differ from envelope source device');
  }
  if (!message.targets.some((m) => m.deviceId === frame.targetDeviceId)) {
    throw invalid('deliver target must be listed in envelope targets');
  }
  return { type: 'deliver', targetDeviceId: frame.targetDeviceId, message };
}

function readClientAck(frame) {
  rejectUnknownFields(frame, new Set(['type', 'targetDeviceId', 'ack']), 'ack frame');
  assertId(frame.targetDeviceId, 'targetDeviceId');
  const ack = normalizeAck(frame.ack);
  if (frame.targetDeviceId !== ack.sourceDeviceId) {
    throw invalid('ack targetDeviceId must match ack source device');
  }
  if (frame.targetDeviceId === ack.recipientDeviceId) {
    throw invalid('ack targetDeviceId must differ from ack recipient device');
  }
  return { type: 'ack', targetDeviceId: frame.targetDeviceId, ack };
}

function readClientReject(frame) {
  rejectUnknownFields(frame, new Set(['type', 'targetDeviceId', 'messageId', 'digest', 'code']), 'reject frame');
  assertId(frame.targetDeviceId, 'targetDeviceId');
  assertId(frame.messageId, 'messageId');
  assertSha256Hex(frame.digest);
  if (typeof frame.code !== 'string' || !DELIVERY_REJECT_CODES.has(frame.code)) {
    throw invalid('reject code must be an allowed delivery rejection code');
  }
  return {
    type: 'reject',
    targetDeviceId: frame.targetDeviceId,
    messageId: frame.messageId,
    digest: frame.digest,
    code: frame.code,
  };
}

// Server frames carry fromDeviceId injected relay-side; it must match the
// envelope/ack identity it wraps.
function readServerDeliver(frame) {
  rejectUnknownFields(frame, new Set(['type', 'fromDeviceId', 'message']), 'deliver frame');
  assertId(frame.fromDeviceId, 'fromDeviceId');
  const message = normalizeEnvelope(frame.message);
  if (frame.fromDeviceId !== message.sourceDeviceId) {
    throw invalid('deliver fromDeviceId must match envelope source device');
  }
  return { type: 'deliver', fromDeviceId: frame.fromDeviceId, message };
}

function readServerAck(frame) {
  rejectUnknownFields(frame, new Set(['type', 'fromDeviceId', 'ack']), 'ack frame');
  assertId(frame.fromDeviceId, 'fromDeviceId');
  const ack = normalizeAck(frame.ack);
  if (frame.fromDeviceId !== ack.recipientDeviceId) {
    throw invalid('ack fromDeviceId must match ack recipient device');
  }
  return { type: 'ack', fromDeviceId: frame.fromDeviceId, ack };
}

function readServerReject(frame) {
  rejectUnknownFields(frame, new Set(['type', 'fromDeviceId', 'messageId', 'digest', 'code']), 'reject frame');
  assertId(frame.fromDeviceId, 'fromDeviceId');
  assertId(frame.messageId, 'messageId');
  assertSha256Hex(frame.digest);
  if (typeof frame.code !== 'string' || !DELIVERY_REJECT_CODES.has(frame.code)) {
    throw invalid('reject code must be an allowed delivery rejection code');
  }
  return {
    type: 'reject',
    fromDeviceId: frame.fromDeviceId,
    messageId: frame.messageId,
    digest: frame.digest,
    code: frame.code,
  };
}

function readUnavailable(frame) {
  rejectUnknownFields(frame, new Set(['type', 'targetDeviceId', 'messageId', 'digest', 'code']), 'unavailable frame');
  assertId(frame.targetDeviceId, 'targetDeviceId');
  assertId(frame.messageId, 'messageId');
  assertSha256Hex(frame.digest);
  if (frame.code !== 'OFFLINE' && frame.code !== 'BACKPRESSURE') {
    throw invalid('unavailable code must be OFFLINE or BACKPRESSURE');
  }
  return {
    type: 'unavailable',
    targetDeviceId: frame.targetDeviceId,
    messageId: frame.messageId,
    digest: frame.digest,
    code: frame.code,
  };
}

/**
 * Parse a frame sent by a relay client (hello/deliver/ack/reject/control-*).
 * Throws messageError with code INVALID_ARGUMENT on any protocol violation.
 * Role legality of control frames is enforced by the relay server, not here.
 */
export function readClientFrame(data, isBinary = false) {
  if (isBinary) throw invalid('relay frames must be text frames');
  const frame = parseFrame(data);
  const scopeFrame = readScopeClientFrame(frame);
  if (scopeFrame !== null) return scopeFrame;
  switch (frame.type) {
    case 'hello':
      return readHello(frame);
    case 'deliver':
      return readClientDeliver(frame);
    case 'ack':
      return readClientAck(frame);
    case 'reject':
      return readClientReject(frame);
    case 'control-call':
    case 'control-cancel':
      return readControlClientFrame(frame);
    case 'control-result':
      return readControlHostFrame(frame);
    case 'live-open':
    case 'live-cancel':
    case 'devices-list':
    case 'device-rename':
      return readLiveClientFrame(frame);
    case 'live-frame':
    case 'live-end':
      return readLiveHostFrame(frame);
    default:
      throw invalid('unknown relay frame type');
  }
}

/**
 * Parse a frame sent by a relay server
 * (ready/deliver/ack/reject/unavailable/control-*).
 * "Ready first" ordering is enforced by the link lifecycle, not here.
 */
export function readServerFrame(data, isBinary = false) {
  if (isBinary) throw invalid('relay frames must be text frames');
  const frame = parseFrame(data);
  const scopeFrame = readScopeServerFrame(frame);
  if (scopeFrame !== null) return scopeFrame;
  switch (frame.type) {
    case 'ready':
      return readReady(frame);
    case 'deliver':
      return readServerDeliver(frame);
    case 'ack':
      return readServerAck(frame);
    case 'reject':
      return readServerReject(frame);
    case 'unavailable':
      return readUnavailable(frame);
    case 'control-request':
    case 'control-cancel':
    case 'control-result':
      return readControlServerFrame(frame);
    case 'live-request':
    case 'live-cancel':
    case 'live-frame':
    case 'live-end':
    case 'devices-result':
    case 'device-renamed':
      return readLiveServerFrame(frame);
    default:
      throw invalid('unknown relay frame type');
  }
}

/**
 * Encode a known outbound frame (already validated by its caller) to JSON text
 * with the 40 MiB byte cap. No full schema revalidation here.
 */
export function encodeRelayFrame(frame) {
  if (!isPlainObject(frame)) {
    throw invalid('relay frame must be an object');
  }
  let text;
  try {
    text = JSON.stringify(frame);
  } catch {
    throw invalid('relay frame must be JSON-serializable');
  }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_RELAY_FRAME_BYTES) {
    throw invalid(FRAME_MAX_TEXT);
  }
  return text;
}
