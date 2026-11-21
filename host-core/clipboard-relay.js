// host-core/clipboard-relay.js
// Isolated native-only WebSocket relay for E2E encrypted clipboard sync.
// Shares the Center /v1/link HTTPS/WSS listener via explicit Upgrade header
// X-PiBot-Clipboard-V1: 1, but runs on its own noServer WebSocketServer with
// strictly isolated peer tables, tight frame/admission/rate/backpressure caps,
// and zero access to host replacement, RPC, live frames, SSE, Bot, or MCP.
// Never persists membership or payloads and never logs secrets or group IDs.

import { WebSocketServer } from 'ws';
import { assertId, messageError } from './message-protocol.js';
import {
  RELAY_CLOSE,
  RELAY_HEARTBEAT_MS,
  RELAY_HELLO_TIMEOUT_MS,
  assertDeviceToken,
} from './relay-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const WS_OPEN = 1; // WebSocket.OPEN

export const CLIPBOARD_UPGRADE_HEADER = 'x-pibot-clipboard-v1';
export const CLIPBOARD_UPGRADE_HEADER_WIRE = 'X-PiBot-Clipboard-V1';
export const CLIPBOARD_UPGRADE_VALUE = '1';
export const CLIPBOARD_PROTOCOL_VERSION = 1;
export const CLIPBOARD_ROLE = 'clipboard';

export const MAX_CLIPBOARD_FRAME_BYTES = 96 * 1024; // 98304 bytes
export const CLIPBOARD_NONCE_BYTES = 24;
export const CLIPBOARD_NONCE_CHARS = 32;
export const CLIPBOARD_SEALED_MIN_BYTES = 17;
export const CLIPBOARD_SEALED_MAX_BYTES = 65552;
export const CLIPBOARD_SEALED_MIN_CHARS = 23;
export const CLIPBOARD_SEALED_MAX_CHARS = 87403;

export const CLIPBOARD_HIGH_WATER_BYTES = 256 * 1024; // 256 KiB per-peer outbound buffer budget
export const CLIPBOARD_HELLO_TIMEOUT_MS = RELAY_HELLO_TIMEOUT_MS; // 5000 ms
export const CLIPBOARD_HEARTBEAT_MS = RELAY_HEARTBEAT_MS; // 15000 ms
export const CLIPBOARD_REGISTRY_CHECK_MS = 1000;
export const MAX_CLIPBOARD_CONNECTIONS = 128;
export const MAX_CLIPBOARD_PENDING_CONNECTIONS = 32;
export const MAX_CLIPBOARD_GROUP_DEVICES = 16;
export const CLIPBOARD_RATE_LIMIT_MAX = 16;
export const CLIPBOARD_RATE_LIMIT_WINDOW_MS = 10000;

export const CLIPBOARD_CLOSE = Object.freeze({
  BAD_FRAME: RELAY_CLOSE.BAD_FRAME,
  UNAUTHORIZED: RELAY_CLOSE.UNAUTHORIZED,
  REVOKED: RELAY_CLOSE.REVOKED,
  HELLO_TIMEOUT: RELAY_CLOSE.HELLO_TIMEOUT,
  REPLACED: RELAY_CLOSE.REPLACED,
  FRAME_TOO_LARGE: 1009,
  TRY_AGAIN_LATER: 1013,
});

const CLIPBOARD_GROUP_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64URL_REM2_LAST_RE = /^[AQgw]$/;
const BASE64URL_REM3_LAST_RE = /^[AEIMQUYcgkosw048]$/;

const HELLO_FIELDS = new Set([
  'type',
  'protocolVersion',
  'role',
  'deviceId',
  'token',
  'clipboardGroup',
]);
const READY_FIELDS = new Set([
  'type',
  'protocolVersion',
  'role',
  'deviceId',
]);
const PUT_FIELDS = new Set([
  'type',
  'nonce',
  'sealed',
  'sentAt',
]);
const EVENT_FIELDS = new Set([
  'type',
  'fromDeviceId',
  'nonce',
  'sealed',
  'sentAt',
]);

const HTTP_STATUS_TEXT = Object.freeze({
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
});

function noop() {}

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactFields(value, allowed, label) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw invalid(`${label} contains an unexpected field`);
    }
  }
  if (keys.length !== allowed.size) {
    throw invalid(`${label} is missing a required field`);
  }
}

function assertPositiveIntOption(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertClipboardGroup(value) {
  if (typeof value !== 'string' || !CLIPBOARD_GROUP_RE.test(value)) {
    throw invalid('clipboardGroup must be a lowercase 64-character hex string');
  }
}

function assertBase64UrlNoPad(value, minChars, maxChars, minBytes, maxBytes, label) {
  if (typeof value !== 'string' || value.length < minChars || value.length > maxChars) {
    throw invalid(`${label} length is out of bounds`);
  }
  const rem = value.length % 4;
  if (rem === 1 || !BASE64URL_RE.test(value)) {
    throw invalid(`${label} must be unpadded base64url`);
  }
  const lastChar = value[value.length - 1];
  if (rem === 2 && !BASE64URL_REM2_LAST_RE.test(lastChar)) {
    throw invalid(`${label} must have canonical zero trailing bits`);
  }
  if (rem === 3 && !BASE64URL_REM3_LAST_RE.test(lastChar)) {
    throw invalid(`${label} must have canonical zero trailing bits`);
  }
  const byteLength = Math.floor((value.length * 3) / 4);
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw invalid(`${label} decoded length is out of bounds`);
  }
}

function assertClipboardNonce(value) {
  assertBase64UrlNoPad(
    value,
    CLIPBOARD_NONCE_CHARS,
    CLIPBOARD_NONCE_CHARS,
    CLIPBOARD_NONCE_BYTES,
    CLIPBOARD_NONCE_BYTES,
    'nonce',
  );
}

function assertClipboardSealed(value) {
  assertBase64UrlNoPad(
    value,
    CLIPBOARD_SEALED_MIN_CHARS,
    CLIPBOARD_SEALED_MAX_CHARS,
    CLIPBOARD_SEALED_MIN_BYTES,
    CLIPBOARD_SEALED_MAX_BYTES,
    'sealed',
  );
}

function assertClipboardSentAt(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid('sentAt must be a positive safe integer');
  }
}

function frameBytes(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (data instanceof Uint8Array) return data.byteLength;
  throw invalid('clipboard frame must be a string or bytes');
}

function decodeText(data) {
  if (typeof data === 'string') {
    if (!data.isWellFormed()) {
      throw invalid('clipboard frame must be valid UTF-8 text');
    }
    return data;
  }
  if (data instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw invalid('clipboard frame must be valid UTF-8 text');
    }
  }
  throw invalid('clipboard frame must be valid UTF-8 text');
}

function parseClipboardJson(data, isBinary) {
  if (isBinary) {
    throw invalid('clipboard frames must be JSON text frames');
  }
  if (frameBytes(data) > MAX_CLIPBOARD_FRAME_BYTES) {
    throw invalid('clipboard frame exceeds 96 KiB');
  }
  let value;
  try {
    value = JSON.parse(decodeText(data));
  } catch (err) {
    if (err && err.code === INVALID_ARGUMENT) throw err;
    throw invalid('clipboard frame must be valid JSON text');
  }
  if (!isPlainObject(value)) {
    throw invalid('clipboard frame must be a JSON object');
  }
  return value;
}

function readClipboardHello(frame) {
  assertExactFields(frame, HELLO_FIELDS, 'hello frame');
  if (frame.protocolVersion !== CLIPBOARD_PROTOCOL_VERSION) {
    throw invalid('hello.protocolVersion must be 1');
  }
  if (frame.role !== CLIPBOARD_ROLE) {
    throw invalid('hello.role must be clipboard');
  }
  assertId(frame.deviceId, 'deviceId');
  assertDeviceToken(frame.token);
  assertClipboardGroup(frame.clipboardGroup);
  return {
    type: 'hello',
    protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
    role: CLIPBOARD_ROLE,
    deviceId: frame.deviceId,
    token: frame.token,
    clipboardGroup: frame.clipboardGroup,
  };
}

function readClipboardPut(frame) {
  assertExactFields(frame, PUT_FIELDS, 'clipboard-put frame');
  assertClipboardNonce(frame.nonce);
  assertClipboardSealed(frame.sealed);
  assertClipboardSentAt(frame.sentAt);
  return {
    type: 'clipboard-put',
    nonce: frame.nonce,
    sealed: frame.sealed,
    sentAt: frame.sentAt,
  };
}

function readClipboardReady(frame) {
  assertExactFields(frame, READY_FIELDS, 'ready frame');
  if (frame.protocolVersion !== CLIPBOARD_PROTOCOL_VERSION) {
    throw invalid('ready.protocolVersion must be 1');
  }
  if (frame.role !== CLIPBOARD_ROLE) {
    throw invalid('ready.role must be clipboard');
  }
  assertId(frame.deviceId, 'deviceId');
  return {
    type: 'ready',
    protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
    role: CLIPBOARD_ROLE,
    deviceId: frame.deviceId,
  };
}

function readClipboardEvent(frame) {
  assertExactFields(frame, EVENT_FIELDS, 'clipboard-event frame');
  assertId(frame.fromDeviceId, 'fromDeviceId');
  assertClipboardNonce(frame.nonce);
  assertClipboardSealed(frame.sealed);
  assertClipboardSentAt(frame.sentAt);
  return {
    type: 'clipboard-event',
    fromDeviceId: frame.fromDeviceId,
    nonce: frame.nonce,
    sealed: frame.sealed,
    sentAt: frame.sentAt,
  };
}

/**
 * Returns true iff the HTTP Upgrade request carries a single exact
 * X-PiBot-Clipboard-V1: 1 header.
 */
export function hasClipboardUpgradeHeader(req) {
  if (req?.headers?.[CLIPBOARD_UPGRADE_HEADER] !== CLIPBOARD_UPGRADE_VALUE) {
    return false;
  }
  if (Array.isArray(req.rawHeaders)) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (
        typeof req.rawHeaders[i] === 'string' &&
        req.rawHeaders[i].toLowerCase() === CLIPBOARD_UPGRADE_HEADER
      ) {
        count += 1;
        if (count > 1) return false;
      }
    }
  }
  return true;
}

export function readClipboardClientFrame(data, isBinary = false) {
  const frame = parseClipboardJson(data, isBinary);
  switch (frame.type) {
    case 'hello':
      return readClipboardHello(frame);
    case 'clipboard-put':
      return readClipboardPut(frame);
    default:
      throw invalid('unknown clipboard client frame type');
  }
}

export function readClipboardServerFrame(data, isBinary = false) {
  const frame = parseClipboardJson(data, isBinary);
  switch (frame.type) {
    case 'ready':
      return readClipboardReady(frame);
    case 'clipboard-event':
      return readClipboardEvent(frame);
    default:
      throw invalid('unknown clipboard server frame type');
  }
}

export function encodeClipboardFrame(frame) {
  if (!isPlainObject(frame)) {
    throw invalid('clipboard frame must be an object');
  }
  let text;
  try {
    text = JSON.stringify(frame);
  } catch {
    throw invalid('clipboard frame must be JSON-serializable');
  }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_FRAME_BYTES) {
    throw invalid('clipboard frame exceeds 96 KiB');
  }
  return text;
}

function rejectUpgrade(socket, status, body) {
  socket.on('error', noop);
  const text = HTTP_STATUS_TEXT[status] ?? 'Bad Request';
  const payload = Buffer.from(body, 'utf8');
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n` + body,
  );
}

function writeText(ws, text, byteLength, highWaterBytes, onError) {
  if (ws.readyState !== WS_OPEN) return false;
  if (ws.bufferedAmount + byteLength > highWaterBytes) {
    return false;
  }
  try {
    ws.send(text, (err) => {
      if (err) onError?.(err);
    });
  } catch {
    return false;
  }
  return true;
}

export function createClipboardRelay(options = {}) {
  const registry = options?.registry;
  if (
    typeof registry !== 'object' || registry === null ||
    typeof registry.authenticate !== 'function' ||
    typeof registry.get !== 'function'
  ) {
    throw invalid('registry with authenticate() and get() is required');
  }

  const helloTimeoutMs = options.helloTimeoutMs === undefined
    ? CLIPBOARD_HELLO_TIMEOUT_MS
    : assertPositiveIntOption(options.helloTimeoutMs, 'helloTimeoutMs');
  const heartbeatMs = options.heartbeatMs === undefined
    ? CLIPBOARD_HEARTBEAT_MS
    : assertPositiveIntOption(options.heartbeatMs, 'heartbeatMs');
  const registryCheckMs = options.registryCheckMs === undefined
    ? CLIPBOARD_REGISTRY_CHECK_MS
    : assertPositiveIntOption(options.registryCheckMs, 'registryCheckMs');
  const maxConnections = options.maxConnections === undefined
    ? MAX_CLIPBOARD_CONNECTIONS
    : assertPositiveIntOption(options.maxConnections, 'maxConnections');
  const maxPendingConnections = options.maxPendingConnections === undefined
    ? MAX_CLIPBOARD_PENDING_CONNECTIONS
    : assertPositiveIntOption(options.maxPendingConnections, 'maxPendingConnections');
  const maxGroupDevices = options.maxGroupDevices === undefined
    ? MAX_CLIPBOARD_GROUP_DEVICES
    : assertPositiveIntOption(options.maxGroupDevices, 'maxGroupDevices');
  const highWaterBytes = options.highWaterBytes === undefined
    ? CLIPBOARD_HIGH_WATER_BYTES
    : assertPositiveIntOption(options.highWaterBytes, 'highWaterBytes');
  const rateLimitMax = options.rateLimitMax === undefined
    ? CLIPBOARD_RATE_LIMIT_MAX
    : assertPositiveIntOption(options.rateLimitMax, 'rateLimitMax');
  const rateLimitWindowMs = options.rateLimitWindowMs === undefined
    ? CLIPBOARD_RATE_LIMIT_WINDOW_MS
    : assertPositiveIntOption(options.rateLimitWindowMs, 'rateLimitWindowMs');

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIPBOARD_FRAME_BYTES,
    perMessageDeflate: false,
  });

  const deviceMap = new Map(); // deviceId -> authenticated clipboard conn
  const groups = new Map(); // groupId -> Map<deviceId, conn>
  const allConns = new Set(); // every accepted clipboard WS
  const pendingConns = new Set(); // unauthenticated clipboard WS awaiting hello
  const upgradeSockets = new Set(); // raw sockets currently admitted
  const rateWindows = new Map(); // deviceId -> number[] timestamps (ms)
  let closed = false;

  function removeFromGroup(conn) {
    if (conn.groupId === null || conn.deviceId === null) return;
    const group = groups.get(conn.groupId);
    if (group !== undefined && group.get(conn.deviceId) === conn) {
      group.delete(conn.deviceId);
      if (group.size === 0) {
        groups.delete(conn.groupId);
      }
    }
  }

  function connCleanup(conn) {
    clearTimeout(conn.helloTimer);
    pendingConns.delete(conn);
    if (conn.deviceId !== null && deviceMap.get(conn.deviceId) === conn) {
      deviceMap.delete(conn.deviceId);
    }
    removeFromGroup(conn);
  }

  function closeWith(conn, code) {
    if (conn.dead) return;
    conn.dead = true;
    connCleanup(conn);
    try {
      conn.ws.close(code);
    } catch {
      /* already closing/closed */
    }
  }

  function checkRegistryVersion(conn) {
    let device;
    try {
      device = registry.get(conn.deviceId);
    } catch {
      return 'error';
    }
    if (
      device === null ||
      device.revokedAt !== null ||
      device.credentialVersion !== conn.version
    ) {
      return 'revoked';
    }
    return 'ok';
  }

  function pruneGroup(groupId, group) {
    for (const [deviceId, peer] of Array.from(group.entries())) {
      if (peer.dead || peer.replaced || peer.ws.readyState !== WS_OPEN) {
        group.delete(deviceId);
        continue;
      }
      if (checkRegistryVersion(peer) === 'revoked') {
        closeWith(peer, CLIPBOARD_CLOSE.REVOKED);
      }
    }
    if (group.size === 0) {
      groups.delete(groupId);
      return null;
    }
    return group;
  }

  function consumeRateLimit(deviceId, now) {
    let stamps = rateWindows.get(deviceId);
    if (stamps === undefined) {
      stamps = [];
      rateWindows.set(deviceId, stamps);
    }
    const cutoff = now - rateLimitWindowMs;
    let keepFrom = 0;
    while (keepFrom < stamps.length && stamps[keepFrom] <= cutoff) {
      keepFrom += 1;
    }
    if (keepFrom > 0) {
      stamps.splice(0, keepFrom);
    }
    if (stamps.length >= rateLimitMax) {
      return false;
    }
    stamps.push(now);
    return true;
  }

  function handleHello(conn, frame) {
    let device;
    try {
      device = registry.authenticate(frame.deviceId, frame.token);
    } catch {
      device = null;
    }
    if (device === null) {
      return closeWith(conn, CLIPBOARD_CLOSE.UNAUTHORIZED);
    }

    let targetGroup = groups.get(frame.clipboardGroup) ?? null;
    if (targetGroup !== null) {
      targetGroup = pruneGroup(frame.clipboardGroup, targetGroup);
    }
    if (
      targetGroup !== null &&
      !targetGroup.has(device.deviceId) &&
      targetGroup.size >= maxGroupDevices
    ) {
      return closeWith(conn, CLIPBOARD_CLOSE.TRY_AGAIN_LATER);
    }

    clearTimeout(conn.helloTimer);
    pendingConns.delete(conn);

    conn.deviceId = device.deviceId;
    conn.version = device.credentialVersion;
    conn.groupId = frame.clipboardGroup;
    conn.alive = true;

    const previous = deviceMap.get(conn.deviceId);
    const previousCloseCode = previous !== undefined && checkRegistryVersion(previous) === 'revoked'
      ? CLIPBOARD_CLOSE.REVOKED
      : CLIPBOARD_CLOSE.REPLACED;
    if (previous !== undefined) {
      previous.replaced = true;
      removeFromGroup(previous);
    }

    deviceMap.set(conn.deviceId, conn);
    let activeGroup = groups.get(conn.groupId);
    if (activeGroup === undefined) {
      activeGroup = new Map();
      groups.set(conn.groupId, activeGroup);
    }
    activeGroup.set(conn.deviceId, conn);

    if (previous !== undefined) {
      closeWith(previous, previousCloseCode);
    }

    let readyText;
    try {
      readyText = encodeClipboardFrame({
        type: 'ready',
        protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
        role: CLIPBOARD_ROLE,
        deviceId: conn.deviceId,
      });
    } catch {
      return closeWith(conn, CLIPBOARD_CLOSE.FRAME_TOO_LARGE);
    }

    if (!writeText(conn.ws, readyText, Buffer.byteLength(readyText, 'utf8'), highWaterBytes, noop)) {
      closeWith(conn, CLIPBOARD_CLOSE.FRAME_TOO_LARGE);
    }
  }

  function handleClipboardPut(conn, frame) {
    const senderStatus = checkRegistryVersion(conn);
    if (senderStatus === 'revoked') {
      return closeWith(conn, CLIPBOARD_CLOSE.REVOKED);
    }
    if (senderStatus !== 'ok') {
      // Registry read failure: fail closed without routing.
      return;
    }

    if (!consumeRateLimit(conn.deviceId, Date.now())) {
      return closeWith(conn, CLIPBOARD_CLOSE.TRY_AGAIN_LATER);
    }

    const group = groups.get(conn.groupId);
    if (group === undefined || group.size <= 1) {
      return;
    }

    let eventText;
    try {
      eventText = encodeClipboardFrame({
        type: 'clipboard-event',
        fromDeviceId: conn.deviceId,
        nonce: frame.nonce,
        sealed: frame.sealed,
        sentAt: frame.sentAt,
      });
    } catch {
      return closeWith(conn, CLIPBOARD_CLOSE.BAD_FRAME);
    }
    const eventBytes = Buffer.byteLength(eventText, 'utf8');

    for (const peer of Array.from(group.values())) {
      if (peer === conn || peer.deviceId === conn.deviceId) continue;
      if (peer.dead || peer.replaced || peer.ws.readyState !== WS_OPEN) continue;
      const peerStatus = checkRegistryVersion(peer);
      if (peerStatus === 'revoked') {
        closeWith(peer, CLIPBOARD_CLOSE.REVOKED);
        continue;
      }
      if (peerStatus !== 'ok') {
        continue;
      }
      writeText(peer.ws, eventText, eventBytes, highWaterBytes, noop);
    }
  }

  function onFrame(conn, data, isBinary) {
    let frame;
    try {
      frame = readClipboardClientFrame(data, isBinary);
    } catch {
      return closeWith(conn, CLIPBOARD_CLOSE.BAD_FRAME);
    }

    if (conn.deviceId === null) {
      if (frame.type !== 'hello') {
        return closeWith(conn, CLIPBOARD_CLOSE.BAD_FRAME);
      }
      return handleHello(conn, frame);
    }

    if (frame.type !== 'clipboard-put') {
      return closeWith(conn, CLIPBOARD_CLOSE.BAD_FRAME);
    }
    if (conn.replaced) return;

    return handleClipboardPut(conn, frame);
  }

  function onConnection(ws) {
    if (closed) {
      try { ws.terminate(); } catch { /* socket gone */ }
      return;
    }
    const conn = {
      ws,
      deviceId: null,
      version: 0,
      groupId: null,
      helloTimer: null,
      alive: true,
      dead: false,
      replaced: false,
    };
    allConns.add(conn);
    pendingConns.add(conn);

    ws.on('error', noop);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (conn.dead) return;
      onFrame(conn, data, isBinary);
    });
    ws.on('close', () => {
      conn.dead = true;
      connCleanup(conn);
      allConns.delete(conn);
    });

    conn.helloTimer = setTimeout(() => {
      closeWith(conn, CLIPBOARD_CLOSE.HELLO_TIMEOUT);
    }, helloTimeoutMs);
  }

  function handleUpgrade(req, socket, head) {
    if (closed) {
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    }
    if (req?.url !== '/v1/link') {
      return rejectUpgrade(socket, 404, 'Not Found');
    }
    if (req.headers?.origin !== undefined || req.headers?.['sec-websocket-origin'] !== undefined) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (!hasClipboardUpgradeHeader(req)) {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (upgradeSockets.size >= maxConnections || pendingConns.size >= maxPendingConnections) {
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    }
    upgradeSockets.add(socket);
    socket.on('error', noop);
    socket.on('close', () => {
      upgradeSockets.delete(socket);
    });
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws);
      });
    } catch {
      socket.destroy();
    }
  }

  const registryCheckTimer = setInterval(() => {
    for (const conn of Array.from(allConns)) {
      if (conn.dead || conn.replaced || conn.deviceId === null) continue;
      if (checkRegistryVersion(conn) === 'revoked') {
        closeWith(conn, CLIPBOARD_CLOSE.REVOKED);
      }
    }
    const cutoff = Date.now() - rateLimitWindowMs;
    for (const [deviceId, stamps] of rateWindows) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) {
        rateWindows.delete(deviceId);
      }
    }
  }, registryCheckMs);

  const heartbeatTimer = setInterval(() => {
    for (const conn of Array.from(allConns)) {
      if (conn.dead || conn.replaced || conn.deviceId === null) continue;
      if (!conn.alive) {
        try {
          conn.ws.terminate();
        } catch {
          /* socket gone */
        }
      } else {
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          /* socket gone */
        }
      }
    }
  }, heartbeatMs);

  let closing = null;
  function close() {
    if (closing === null) {
      closing = (async () => {
        closed = true;
        const errors = [];
        const capture = (fn) => {
          try { fn(); } catch (err) { errors.push(err); }
        };
        clearInterval(registryCheckTimer);
        clearInterval(heartbeatTimer);
        for (const conn of allConns) {
          clearTimeout(conn.helloTimer);
          conn.dead = true;
          capture(() => conn.ws.terminate());
        }
        allConns.clear();
        pendingConns.clear();
        deviceMap.clear();
        groups.clear();
        rateWindows.clear();
        for (const socket of upgradeSockets) {
          capture(() => socket.destroy());
        }
        upgradeSockets.clear();
        await new Promise((resolve) => {
          try {
            wss.close(() => resolve());
          } catch (err) {
            errors.push(err);
            resolve();
          }
        });
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'clipboard relay close cleanup failed');
      })();
    }
    return closing;
  }

  return {
    handleUpgrade,
    close,
  };
}
