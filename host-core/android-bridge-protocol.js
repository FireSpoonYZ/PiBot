// host-core/android-bridge-protocol.js
// M15 Android Host bridge wire protocol: pure boundary parsers/encoders for
// the private JSONL child IPC between the Java supervisor and this Node host.
// No I/O, no Runtime/service/storage. Structural violations throw fixed
// control codes and fail the connection; per-command payload mistakes throw
// BridgeCommandError which the runtime answers with an error frame.
import path from 'node:path';
import { messageError, assertId } from './message-protocol.js';
import { CONTROL_ERROR_CODES, CONTROL_OUTCOMES } from './remote-control-protocol.js';
import { SHOWER_ERROR_CODES } from './shower-protocol.js';
import { normalizeHostSettings } from './host-settings.js';
import { normalizeDeviceName } from './device-metadata.js';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_MAX_FRAME_BYTES = 41943040; // 40 MiB hard frame cap (UTF-8 bytes)
export const BRIDGE_MAX_CONTROL_BYTES = 41943040; // 40 MiB init/command/result frames
export const BRIDGE_MAX_CONTROL_CALLS = 8;
export const BRIDGE_MAX_OBSERVERS = 8;
export const BRIDGE_MAX_NATIVE_CALLS = 8;
export const BRIDGE_NATIVE_TIMEOUT_MS = 20000;
export const BRIDGE_MAX_ERROR_MESSAGE_BYTES = 512;
export const BRIDGE_MAX_CREDENTIALS = 64;
export const BRIDGE_MAX_CREDENTIAL_BYTES = 65536;
export const BRIDGE_MAX_CREDENTIAL_VALUE_BYTES = 4096;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
// Never allow credential aliases to replace variables the runtime / Android
// host environment depends on.
const PROTECTED_ENV = new Set([
  'PATH',
  'HOME',
  'PWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'ANDROID_ROOT',
  'ANDROID_DATA',
  'ANDROID_STORAGE',
  'LD_LIBRARY_PATH',
  'JAVA_HOME',
  'NODE_OPTIONS',
  'SYSTEMROOT',
  'WINDIR',
]);

export const ANDROID_NATIVE_CODES = new Set([
  'ANDROID_NATIVE_UNAVAILABLE',
  'ANDROID_NATIVE_BUSY',
  'ANDROID_NATIVE_UNCONFIRMED',
  'ANDROID_NATIVE_ERROR',
]);

// Inbound native_result may additionally carry the shared shower protocol code of
// a classified shower_surface failure (or the shared CANCELLED/INVALID_ARGUMENT),
// so the Android backend keeps SHOWER_UNSUPPORTED/SHOWER_SESSION_MISMATCH instead
// of collapsing every native failure onto a transport error. Outbound bridge
// error frames are unchanged (BRIDGE_ERROR_CODES does not use this set).
const NATIVE_RESULT_ERROR_CODES = new Set([
  ...ANDROID_NATIVE_CODES,
  ...SHOWER_ERROR_CODES,
  'CANCELLED',
  'INVALID_ARGUMENT',
]);

const BRIDGE_LOCAL_CODES = new Set(['BUSY', 'IO_ERROR', 'TOO_LARGE']);
// Client-mode codes extend CONTROL_ERROR_CODES on the private broker bridge.
export const BRIDGE_CLIENT_CODES = new Set(['REPLACED', 'PENDING_BUSY', 'CERTIFICATE_ERROR']);
export const BRIDGE_ERROR_CODES = new Set([
  ...CONTROL_ERROR_CODES,
  ...ANDROID_NATIVE_CODES,
  ...BRIDGE_LOCAL_CODES,
  ...BRIDGE_CLIENT_CODES,
]);

// Client mode is a fixed broker surface: the ordinary desktop-client
// operations. observe/unobserve stay separate (observe frame + cancel), so no
// arbitrary method, JS or HTTP ever crosses this IPC.
export const BRIDGE_CLIENT_OPERATIONS = new Set([
  'center_connect',
  'center_status',
  'center_disconnect',
  'center_owner_session',
  'center_owner_login',
  'center_bot_model_get',
  'center_bot_model_set',
  'center_bot_avatar_get',
  'center_bot_avatar_set',
  'center_bot_cwd_get',
  'center_bot_cwd_set',
  'center_bot_capabilities_get',
  'center_bot_capability_set',
  'center_runtime_status',
  'connect',
  'disconnect',
  'status',
  'devices',
  'bot_directory',
  'rename_device',
  'call',
  'settings_get',
  'settings_set',
  'service_status',
  'pending_enqueue',
  'pending_get',
  'pending_list',
  'pending_send',
  'pending_reconcile',
  'pending_cancel',
  'ui_get',
  'ui_set',
]);
export const BRIDGE_OUTCOMES = CONTROL_OUTCOMES;

function invalid(code, message) {
  return messageError(code, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid('INVALID_ARGUMENT', `${label} has unknown field: ${key}`);
    }
  }
}

function assertFrameId(value) {
  assertId(value, 'id');
}


function assertDataRoot(value) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw invalid('INVALID_ARGUMENT', 'dataRoot must be a non-empty absolute path');
  }
  return path.resolve(value);
}

// Truncate to a UTF-8 byte budget without splitting a code point.
function boundUtf8(text, maxBytes, label) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  for (const ch of text) {
    const next = out + ch;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    out = next;
  }
  if (out === '') throw invalid('INVALID_ARGUMENT', `${label} cannot fit in ${maxBytes} bytes`);
  return out;
}

function normalizeCredentials(value) {
  // Explicit null (or any non-object) is invalid; absence is handled by caller.
  if (!isPlainObject(value)) throw invalid('INVALID_ARGUMENT', 'credentials must be a plain object');
  const entries = Object.entries(value);
  if (entries.length > BRIDGE_MAX_CREDENTIALS) {
    throw invalid('INVALID_ARGUMENT', `credentials must have at most ${BRIDGE_MAX_CREDENTIALS} aliases`);
  }
  let total = 0;
  const out = Object.create(null); // null-prototype so __proto__ aliases are preserved
  for (const [name, val] of entries) {
    if (!ENV_NAME_RE.test(name) || name === '__proto__') {
      throw invalid('INVALID_ARGUMENT', `credential environment name is not a standard variable name: ${name}`);
    }
    if (PROTECTED_ENV.has(name) || /^(NODE_|PI_|npm_)/.test(name)) {
      throw invalid('INVALID_ARGUMENT', `credential would replace a reserved runtime environment variable: ${name}`);
    }
    if (typeof val !== 'string' || !val.isWellFormed() || val.length === 0) {
      throw invalid('INVALID_ARGUMENT', `credential value for ${name} must be a non-empty well-formed string`);
    }
    if (val.includes('\0')) {
      throw invalid('INVALID_ARGUMENT', `credential value for ${name} must not contain NUL`);
    }
    const bytes = Buffer.byteLength(val, 'utf8');
    if (bytes > BRIDGE_MAX_CREDENTIAL_VALUE_BYTES) {
      throw invalid('INVALID_ARGUMENT', `credential value for ${name} exceeds 4096 bytes`);
    }
    total += bytes + Buffer.byteLength(name, 'utf8');
    if (total > BRIDGE_MAX_CREDENTIAL_BYTES) {
      throw invalid('INVALID_ARGUMENT', 'credentials exceed 64KiB total');
    }
    out[name] = val;
  }
  return out;
}

/**
 * Validate the single init frame. Everything here is pure validation before
 * any resource is opened; any violation fails the connection. Host mode
 * carries dataRoot/token/optional credentials/initialSettings/displayName; settings and
 * client modes carry only dataRoot. initialSettings passes through
 * normalizeHostSettings (canonical config + 512KiB budget) so no malformed
 * settings ever reach the store.
 */
export function normalizeInitFrame(parsed) {
  if (!isPlainObject(parsed)) throw invalid('INVALID_BODY', 'init frame must be an object');
  if (parsed.type !== 'init') throw invalid('INVALID_BODY', 'init frame type must be init');
  if (parsed.protocol !== BRIDGE_PROTOCOL_VERSION) {
    throw invalid('UNSUPPORTED_SCHEMA', 'unsupported bridge protocol version');
  }
  if (parsed.mode !== 'host' && parsed.mode !== 'settings' && parsed.mode !== 'client') {
    throw invalid('INVALID_ARGUMENT', "init mode must be 'host', 'settings' or 'client'");
  }
  const dataRoot = assertDataRoot(parsed.dataRoot);
  if (parsed.mode !== 'host') {
    // settings/client carry only dataRoot: no token, no credentials, no model.
    rejectUnknownFields(parsed, new Set(['type', 'protocol', 'mode', 'dataRoot']), `${parsed.mode} init frame`);
    return { mode: parsed.mode, dataRoot };
  }
  rejectUnknownFields(parsed, new Set(['type', 'protocol', 'mode', 'dataRoot', 'token', 'credentials', 'initialSettings', 'center', 'npmPath', 'displayName']), 'host init frame');
  if (typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)) {
    throw invalid('INVALID_ARGUMENT', 'token must be a URL-safe opaque string of 32-512 characters');
  }
  let credentials = null;
  if (parsed.credentials !== undefined) {
    credentials = normalizeCredentials(parsed.credentials); // explicit null is invalid
  }
  if (!isPlainObject(parsed.center)) throw invalid('INVALID_ARGUMENT', 'center is required');
  rejectUnknownFields(parsed.center, new Set(['url', 'deviceToken', 'ca']), 'center');
  let centerUrl;
  try { centerUrl = new URL(parsed.center.url); } catch { throw invalid('INVALID_ARGUMENT', 'invalid center URL'); }
  if (centerUrl.protocol !== 'https:' || centerUrl.username || centerUrl.password || centerUrl.search || centerUrl.hash) {
    throw invalid('INVALID_ARGUMENT', 'center URL must be HTTPS without credentials, query or fragment');
  }
  if (typeof parsed.center.deviceToken !== 'string' || !TOKEN_PATTERN.test(parsed.center.deviceToken)) {
    throw invalid('INVALID_ARGUMENT', 'invalid center device token');
  }
  if (parsed.center.ca !== undefined && (typeof parsed.center.ca !== 'string' || !parsed.center.ca.trim())) {
    throw invalid('INVALID_ARGUMENT', 'invalid center CA');
  }
  const center = { url: parsed.center.url, deviceToken: parsed.center.deviceToken,
    ...(parsed.center.ca !== undefined ? { ca: parsed.center.ca } : {}) };
  if (parsed.npmPath !== undefined && (typeof parsed.npmPath !== 'string' || !path.isAbsolute(parsed.npmPath))) {
    throw invalid('INVALID_ARGUMENT', 'npmPath must be an absolute path');
  }
  const init = { mode: 'host', dataRoot, token: parsed.token, credentials, center,
    ...(parsed.npmPath !== undefined ? { npmPath: parsed.npmPath } : {}) };
  if (parsed.displayName !== undefined) init.displayName = normalizeDeviceName(parsed.displayName);
  if (parsed.initialSettings !== undefined) {
    init.initialSettings = normalizeHostSettings(parsed.initialSettings);
  }
  return init;
}

/**
 * Bridge command payload errors that the runtime answers with an error frame
 * instead of failing the connection (malformed but recognizable frames).
 */
export class BridgeCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeCommandError';
    this.code = code;
  }
}

/**
 * Validate one command frame from Java. Returns a normalized command. Frames
 * with an unknown top-level type or non-object body are fatal (throw plain
 * messageError); recognized types with malformed payloads throw
 * BridgeCommandError.
 */
export function normalizeBridgeCommandFrame(parsed) {
  if (!isPlainObject(parsed)) throw invalid('INVALID_BODY', 'bridge frame must be an object');
  switch (parsed.type) {
    case 'call': {
      rejectUnknownFields(parsed, new Set(['type', 'id', 'method', 'params']), 'call frame');
      assertFrameId(parsed.id);
      if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
        throw new BridgeCommandError('INVALID_ARGUMENT', 'call method must be a non-empty string');
      }
      if (!isPlainObject(parsed.params)) {
        throw new BridgeCommandError('INVALID_ARGUMENT', 'call params must be an object');
      }
      return { type: 'call', id: parsed.id, method: parsed.method, params: parsed.params };
    }
    case 'observe': {
      rejectUnknownFields(parsed, new Set(['type', 'id', 'target']), 'observe frame');
      assertFrameId(parsed.id);
      if (!isPlainObject(parsed.target)) {
        throw new BridgeCommandError('INVALID_ARGUMENT', 'observe target must be an object');
      }
      return { type: 'observe', id: parsed.id, target: parsed.target };
    }
    case 'cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'id']), 'cancel frame');
      assertFrameId(parsed.id);
      return { type: 'cancel', id: parsed.id };
    }
    case 'status': {
      rejectUnknownFields(parsed, new Set(['type', 'id']), 'status frame');
      assertFrameId(parsed.id);
      return { type: 'status', id: parsed.id };
    }
    case 'settings_get': {
      rejectUnknownFields(parsed, new Set(['type', 'id']), 'settings_get frame');
      assertFrameId(parsed.id);
      return { type: 'settings_get', id: parsed.id };
    }
    case 'settings_set': {
      rejectUnknownFields(parsed, new Set(['type', 'id', 'input']), 'settings_set frame');
      assertFrameId(parsed.id);
      return { type: 'settings_set', id: parsed.id, input: normalizeSettingsUpdateInput(parsed.input) };
    }
    case 'shutdown': {
      rejectUnknownFields(parsed, new Set(['type', 'id']), 'shutdown frame');
      assertFrameId(parsed.id);
      return { type: 'shutdown', id: parsed.id };
    }
    default:
      throw invalid('BAD_FRAME', `unknown bridge frame type: ${parsed.type}`);
  }
}

// Mirror control-server validateSettingsUpdate: exact {expectedRevision, settings}
// shape; deeper content validation is delegated to the online control server or
// the offline settings store.
function normalizeSettingsUpdateInput(value) {
  if (!isPlainObject(value)) throw new BridgeCommandError('INVALID_ARGUMENT', 'settings_set input must be an object');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('expectedRevision') || !keys.includes('settings')) {
    throw new BridgeCommandError('INVALID_ARGUMENT', 'settings_set input must contain exactly expectedRevision and settings');
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision <= 0) {
    throw new BridgeCommandError('INVALID_ARGUMENT', 'expectedRevision must be a positive safe integer');
  }
  if (!isPlainObject(value.settings)) {
    throw new BridgeCommandError('INVALID_ARGUMENT', 'settings must be an object');
  }
  return { expectedRevision: value.expectedRevision, settings: value.settings };
}

/**
 * Validate a native_result frame from Java. Exactly one of result/error;
 * unknown ids are a protocol failure, duplicate replies are a protocol failure.
 * Error message is bounded to 512 UTF-8 bytes.
 */
export function normalizeNativeResultFrame(parsed) {
  if (!isPlainObject(parsed)) throw invalid('INVALID_BODY', 'native_result frame must be an object');
  rejectUnknownFields(parsed, new Set(['type', 'id', 'result', 'error']), 'native_result frame');
  if (parsed.type !== 'native_result') throw invalid('BAD_FRAME', 'frame type must be native_result');
  assertFrameId(parsed.id);
  const hasResult = parsed.result !== undefined;
  const hasError = parsed.error !== undefined;
  if (hasResult === hasError) {
    throw invalid('BAD_FRAME', 'native_result must carry exactly one of result or error');
  }
  if (hasResult) {
    if (parsed.result === null || typeof parsed.result !== 'object') {
      throw invalid('BAD_FRAME', 'native_result must be a non-null JSON object or array');
    }
    return { id: parsed.id, result: parsed.result };
  }
  if (!isPlainObject(parsed.error)) throw invalid('BAD_FRAME', 'native_result error must be an object');
  rejectUnknownFields(parsed.error, new Set(['code', 'message']), 'native_result error');
  if (typeof parsed.error.code !== 'string' || !NATIVE_RESULT_ERROR_CODES.has(parsed.error.code)) {
    throw invalid('BAD_FRAME', 'native_result error code must be an allowed android native error code');
  }
  if (parsed.error.message !== undefined && (typeof parsed.error.message !== 'string' || !parsed.error.message.isWellFormed())) {
    throw invalid('BAD_FRAME', 'native_result error message must be a well-formed string');
  }
  return {
    id: parsed.id,
    error: {
      code: parsed.error.code,
      message: parsed.error.message === undefined
        ? ''
        : boundUtf8(parsed.error.message, BRIDGE_MAX_ERROR_MESSAGE_BYTES, 'native_result error message'),
    },
  };
}

const NATIVE_TOOLS = new Set(['android_apps', 'android_shower', 'android_speak', 'schedule_task', 'shower_surface']);
const NATIVE_KINDS = new Set(['primary', 'room', 'dm']);
// Unified Shower private entry: only the six environment actions cross this IPC.
// Arguments are assembled by the trusted Android backend, never by model output.
const SHOWER_SURFACE_ACTIONS = new Map([
  ['status', null],
  ['ensure', 'options'],
  ['frame', 'limits'],
  ['input', 'input'],
  ['launch', 'target'],
  ['release', null],
]);
const SHOWER_SURFACE_SOURCES = new Set(['agent', 'human']);
// Human operations have no durable numeric task; the manager still must pass a
// nonempty synthetic id so the native side can tell human calls apart.
const HUMAN_TASK_ID_RE = /^human:[0-9a-fA-F-]{8,64}$/;

function normalizeShowerSurfaceArguments(value) {
  const action = value.action;
  if (typeof action !== 'string' || !SHOWER_SURFACE_ACTIONS.has(action)) {
    throw invalid('INVALID_ARGUMENT', 'shower_surface action must be status, ensure, frame, input, launch or release');
  }
  if (!SHOWER_SURFACE_SOURCES.has(value.source)) {
    throw invalid('INVALID_ARGUMENT', "shower_surface source must be 'agent' or 'human'");
  }
  const payload = SHOWER_SURFACE_ACTIONS.get(action);
  const allowed = new Set(['action', 'sessionId', 'source']);
  if (payload) allowed.add(payload);
  rejectUnknownFields(value, allowed, 'shower_surface arguments');
  if (action === 'status') {
    // status may describe an environment that does not exist yet.
    if (value.sessionId !== undefined && value.sessionId !== null) {
      assertId(value.sessionId, 'sessionId');
    }
  } else {
    assertId(value.sessionId, 'sessionId');
  }
  if (payload && !isPlainObject(value[payload])) {
    throw invalid('INVALID_ARGUMENT', `shower_surface ${action} requires a ${payload} object`);
  }
  return value;
}

function normalizeNativeTaskId(value, tool) {
  if (tool === 'shower_surface' && typeof value === 'string') {
    if (!HUMAN_TASK_ID_RE.test(value)) {
      throw invalid('INVALID_ARGUMENT', "shower_surface human taskId must be 'human:<id>'");
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid('INVALID_ARGUMENT', 'taskId must be a positive safe integer');
  }
  return value;
}

/**
 * Normalize the trusted native tool request (core factory contract) into the
 * native_call context. Caller metadata only, no arbitrary fields. taskId is
 * a Durable numeric Id<'task'>; only the private shower_surface entry may carry
 * the manager's synthetic 'human:<id>' task instead. kind is primary|room|dm
 * with scope relation (primary has no scope, work kinds require one). Only the
 * five private native tools are allowed.
 */
export function normalizeNativeRequest(request) {
  if (!isPlainObject(request)) throw invalid('INVALID_ARGUMENT', 'native request must be an object');
  if (typeof request.tool !== 'string' || !NATIVE_TOOLS.has(request.tool)) {
    throw invalid('INVALID_ARGUMENT', 'native tool must be one of android_apps, android_shower, android_speak, schedule_task, shower_surface');
  }
  const rawArguments = request.arguments === undefined ? {} : request.arguments;
  if (!isPlainObject(rawArguments)) throw invalid('INVALID_ARGUMENT', 'native request arguments must be an object');
  const args = request.tool === 'shower_surface'
    ? normalizeShowerSurfaceArguments(rawArguments)
    : rawArguments;
  const actor = request.actor;
  if (!isPlainObject(actor)) throw invalid('INVALID_ARGUMENT', 'native request actor must be an object');
  rejectUnknownFields(actor, new Set(['deviceId', 'botId', 'conversationId', 'scopeId', 'kind']), 'native actor');
  assertId(actor.deviceId, 'actor.deviceId');
  assertId(actor.botId, 'actor.botId');
  if (typeof actor.conversationId !== 'string') throw invalid('INVALID_ARGUMENT', 'actor.conversationId must be a string');
  assertId(actor.conversationId, 'actor.conversationId');
  if (!NATIVE_KINDS.has(actor.kind)) {
    throw invalid('INVALID_ARGUMENT', "actor.kind must be 'primary', 'room' or 'dm'");
  }
  if (actor.kind === 'primary') {
    if (actor.scopeId !== null && actor.scopeId !== undefined) {
      throw invalid('INVALID_ARGUMENT', 'primary actor must not carry a scopeId');
    }
  } else if (typeof actor.scopeId !== 'string') {
    throw invalid('INVALID_ARGUMENT', 'work actor must carry a string scopeId');
  } else {
    assertId(actor.scopeId, 'actor.scopeId');
  }
  const taskId = normalizeNativeTaskId(request.taskId, request.tool);
  return {
    context: {
      deviceId: actor.deviceId,
      botId: actor.botId,
      conversationId: actor.conversationId,
      scopeId: actor.scopeId === undefined ? null : actor.scopeId,
      kind: actor.kind,
      taskId,
    },
    tool: request.tool,
    arguments: args,
  };
}

function assertSerializable(frame, label) {
  try {
    JSON.stringify(frame);
  } catch {
    throw invalid('INVALID_ARGUMENT', `${label} is not JSON-serializable`);
  }
}

export function encodeReadyFrame({ deviceId, url, nodeVersion, platform, arch }) {
  const frame = { type: 'ready', protocol: BRIDGE_PROTOCOL_VERSION, deviceId, url, nodeVersion, platform, arch };
  assertSerializable(frame, 'ready frame');
  return frame;
}

export function encodeClosedFrame(id) {
  assertFrameId(id);
  return { type: 'closed', id };
}

export function encodeResultFrame(id, result) {
  assertFrameId(id);
  if (result === undefined) throw invalid('INVALID_ARGUMENT', 'result must not be undefined');
  const frame = { type: 'result', id, result };
  assertSerializable(frame, 'result frame');
  return frame;
}

export function encodeErrorFrame(id, code, outcome, message) {
  assertFrameId(id);
  if (typeof code !== 'string' || !BRIDGE_ERROR_CODES.has(code)) {
    throw invalid('INTERNAL', 'error frame code must be an allowed bridge error code');
  }
  if (typeof outcome !== 'string' || !BRIDGE_OUTCOMES.has(outcome)) {
    throw invalid('INTERNAL', 'error frame outcome must be one of not-sent, unconfirmed, responded');
  }
  const frame = { type: 'error', id, code, outcome };
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') throw invalid('INTERNAL', 'error message must be a string');
    frame.message = boundUtf8(message, BRIDGE_MAX_ERROR_MESSAGE_BYTES, 'error message');
  }
  return frame;
}

// Wrapped live frame (snapshot/update/end) for observe.
export function encodeFrameFrame(id, frame) {
  assertFrameId(id);
  if (!isPlainObject(frame)) throw invalid('INVALID_ARGUMENT', 'live frame must be an object');
  const out = { type: 'frame', id, frame };
  assertSerializable(out, 'frame frame');
  return out;
}

export function encodeNativeCallFrame(id, context, tool, args) {
  assertFrameId(id);
  const frame = { type: 'native_call', id, context, tool, arguments: args };
  assertSerializable(frame, 'native_call frame');
  return frame;
}

export function encodeNativeCancelFrame(id) {
  assertFrameId(id);
  return { type: 'native_cancel', id };
}

/**
 * Serialize an outgoing frame as a single JSONL line with a hard byte cap.
 * maxBytes must cover the whole serialized line; oversized frames throw
 * REQUEST_TOO_LARGE and are never written.
 */
export function buildLine(object, maxBytes, label) {
  let json;
  try {
    json = JSON.stringify(object);
  } catch {
    throw invalid('INVALID_ARGUMENT', `${label} is not JSON-serializable`);
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) throw invalid('REQUEST_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`);
  return json + '\n';
}
