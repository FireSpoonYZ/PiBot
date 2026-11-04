// host-core/shower-android.js
// Android provider for the unified Shower abstraction. This is the only Host
// side adapter for the private native tool `shower_surface`: the trusted
// BotIdentity actor and taskId travel as native frame side fields (never model
// arguments), the payload is the unified input/launch/limits, and native
// results are converted to the shared Session/Frame shapes. Ownership on the
// Java side is keyed by the trusted five-field actor; sessionId is only the
// opaque handle the surface must echo back, so no parallel desktop is created
// and status never starts Shower or wakes Shizuku.
import { randomUUID } from 'node:crypto';
import { assertId, messageError } from './message-protocol.js';
import {
  SHOWER_ERROR_CODES,
  SHOWER_MAX_FRAME_BASE64_BYTES,
  normalizeShowerFrameLimits,
} from './shower-protocol.js';

const PLATFORM = 'android';
const NATIVE_TOOL = 'shower_surface';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const SOURCES = new Set(['agent', 'human']);
const PHASES = new Set([
  'unavailable',
  'idle',
  'starting',
  'authentication-required',
  'ready',
  'closed',
  'error',
]);
const MAX_SOURCE_DIMENSION = 4096;

const KEYS = Object.freeze([
  'ENTER', 'TAB', 'ESCAPE', 'SPACE', 'BACKSPACE', 'DELETE', 'LEFT', 'RIGHT', 'UP', 'DOWN',
  'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  // Android-only names: the native surface maps them to the system BACK / HOME
  // behaviour instead of silently approximating them with another key.
  'BACK', 'ANDROID_HOME',
]);

// Android starts apps inside its own virtual display; the shower_surface command
// set has no process launcher and no native preview window (frames only).
const CAPABILITIES = Object.freeze({
  launchKinds: Object.freeze(['app']),
  inputKinds: Object.freeze(['click', 'drag', 'scroll', 'key', 'text']),
  keys: KEYS,
  nativePreview: false,
});

// Private bridge codes collapse onto the public table so callers never see a
// transport code as success and never lose the original outcome.
const NATIVE_CODE_MAP = new Map([
  ['ANDROID_NATIVE_UNAVAILABLE', 'SHOWER_UNAVAILABLE'],
  ['ANDROID_NATIVE_BUSY', 'SHOWER_BUSY'],
  ['ANDROID_NATIVE_ERROR', 'SHOWER_BACKEND_FAILED'],
]);

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function backendFailed(message) {
  return messageError('SHOWER_BACKEND_FAILED', message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoNow() {
  return new Date().toISOString();
}

function dimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SOURCE_DIMENSION ? value : null;
}

function nativeFailure(err, mutating) {
  // Cancellation stays a cancellation; it is never reported as applied or as a
  // backend failure.
  if (err && err.name === 'AbortError') return err;
  const code = typeof err?.code === 'string' ? err.code : '';
  const message = typeof err?.message === 'string' && err.message !== ''
    ? err.message
    : 'android shower_surface call failed';
  let mapped;
  if (code === 'ANDROID_NATIVE_UNCONFIRMED') {
    mapped = mutating ? 'SHOWER_INPUT_FAILED' : 'SHOWER_BACKEND_FAILED';
  } else if (NATIVE_CODE_MAP.has(code)) {
    mapped = NATIVE_CODE_MAP.get(code);
  } else if (code === 'CANCELLED' || code === 'INVALID_ARGUMENT' || SHOWER_ERROR_CODES.includes(code)) {
    mapped = code;
  } else {
    mapped = 'SHOWER_BACKEND_FAILED';
  }
  const failure = messageError(mapped, message);
  if (typeof err?.outcome === 'string') failure.outcome = err.outcome;
  return failure;
}

function assertNotAborted(signal, outcome) {
  if (!signal?.aborted) return;
  const err = new DOMException('The operation was aborted.', 'AbortError');
  err.outcome = outcome;
  throw err;
}

/** Signal is checked before spawning the native call and again before trusting its result. */
async function callNative(nativeBridge, request, { signal, mutating = false } = {}) {
  assertNotAborted(signal, 'not-sent');
  let result;
  try {
    result = await nativeBridge(request, { signal });
  } catch (err) {
    throw nativeFailure(err, mutating);
  }
  // A mutation may already have reached the screen; report it as unconfirmed
  // instead of pretending it never happened, and never replay it here.
  assertNotAborted(signal, mutating ? 'unconfirmed' : 'responded');
  if (!isPlainObject(result)) throw backendFailed('shower_surface result must be an object');
  if (result.ok === false) throw backendFailed('shower_surface reported a failure result');
  return result;
}

function trustedActor(record) {
  if (!isPlainObject(record)) throw invalid('record must be an object');
  if (!isPlainObject(record.actor)) throw invalid('record.actor must be the trusted Host actor');
  return record.actor;
}

/**
 * taskId only correlates and cancels native calls, so it is taken strictly from
 * the trusted manager options: agent calls must carry their own id, and human
 * 'human:<uuid>' ids are produced by the runtime/close caller, never guessed
 * here (an agent call missing its id must not become a human one).
 */
function trustedTaskId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value !== '') {
    assertId(value, 'taskId');
    return value;
  }
  throw invalid('taskId must be the trusted positive integer or nonempty string from manager options');
}

/** Source is trusted Host metadata from manager options, never a model argument. */
function trustedSource(value) {
  if (value === undefined) return 'agent';
  if (!SOURCES.has(value)) throw invalid("source must be 'agent' or 'human'");
  return value;
}

function nativeRequest(record, action, payload, options = {}) {
  return {
    tool: NATIVE_TOOL,
    actor: trustedActor(record),
    taskId: trustedTaskId(options.taskId),
    arguments: {
      action,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      ...payload,
      source: trustedSource(options.source),
    },
  };
}

function sessionIdOf(record) {
  if (!isPlainObject(record)) throw invalid('record must be an object');
  if (typeof record.sessionId !== 'string') {
    throw messageError('SHOWER_SESSION_NOT_FOUND', 'record has no manager assigned sessionId');
  }
  assertId(record.sessionId, 'record.sessionId');
  return record.sessionId;
}

/** A mutation never addresses a replacement desktop: a different echoed id is a mismatch. */
function assertSameSession(result, record) {
  const echoed = result.sessionId;
  if (typeof echoed === 'string' && echoed !== '' && echoed !== record.sessionId) {
    throw messageError('SHOWER_SESSION_MISMATCH', 'shower_surface answered for a different sessionId');
  }
}

/**
 * Session data is only trusted from a reply that echoes the manager assigned
 * sessionId verbatim. Nothing falls back to a record id or a legacy displayId:
 * guessing here would let the Host act on a screen it did not create.
 */
function requireEcho(result, record) {
  const echoed = result.sessionId;
  if (typeof echoed !== 'string' || echoed === '') {
    throw backendFailed('shower_surface did not echo the assigned sessionId');
  }
  if (echoed !== record.sessionId) {
    throw messageError('SHOWER_SESSION_MISMATCH', 'shower_surface answered for a different sessionId');
  }
  return echoed;
}

/** Full Session snapshot: idle/closed surfaces report 0x0 instead of a guessed size. */
function idleSession(phase = 'idle') {
  return {
    sessionId: null,
    platform: PLATFORM,
    phase,
    width: 0,
    height: 0,
    capabilities: CAPABILITIES,
    updatedAt: isoNow(),
  };
}

function sessionError(value) {
  if (!isPlainObject(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    return undefined;
  }
  return { code: value.code, message: value.message };
}

/** Partial unified Session derived from an echoing native reply. */
function sessionSnapshot(result, record, fallbackPhase) {
  const sessionId = requireEcho(result, record);
  const phase = PHASES.has(result.phase) ? result.phase : fallbackPhase;
  // Only a ready surface must report real source pixels; any other phase has no
  // usable size yet and reports 0x0 instead of a guessed one.
  const width = dimension(result.width) ?? 0;
  const height = dimension(result.height) ?? 0;
  if (phase === 'ready' && (width === 0 || height === 0)) {
    throw backendFailed('shower_surface reported ready without source width/height, so input cannot be mapped');
  }
  const session = {
    sessionId,
    platform: PLATFORM,
    phase,
    width,
    height,
    capabilities: CAPABILITIES,
    updatedAt: isoNow(),
  };
  const error = sessionError(result.error);
  if (error !== undefined) session.error = error;
  return session;
}

function frameFrom(result, record, limits) {
  requireEcho(result, record);
  const width = dimension(result.width);
  const height = dimension(result.height);
  if (width === null || height === null) {
    // Source input pixels must come from the surface itself; reusing the encoded
    // pixels would silently shift every click coordinate.
    throw backendFailed('shower_surface frame did not report source width/height');
  }
  if (!MIME_TYPES.has(result.mimeType)) throw backendFailed('shower_surface frame mimeType is invalid');
  const data = result.data;
  if (typeof data !== 'string' || data === '' || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw backendFailed('shower_surface frame data is not canonical base64');
  }
  const maxBytes = Math.min(limits.maxBytes, SHOWER_MAX_FRAME_BASE64_BYTES);
  if (data.length > maxBytes) {
    throw messageError('SHOWER_FRAME_TOO_LARGE',
      `frame base64 is ${data.length} bytes, above the ${maxBytes} byte budget`);
  }
  const imageWidth = dimension(result.imageWidth);
  const imageHeight = dimension(result.imageHeight);
  if (imageWidth === null || imageHeight === null) {
    throw backendFailed('shower_surface frame is missing imageWidth/imageHeight');
  }
  if (imageWidth > limits.maxWidth || imageHeight > limits.maxHeight) {
    throw messageError('SHOWER_FRAME_TOO_LARGE',
      `encoded frame ${imageWidth}x${imageHeight} exceeds ${limits.maxWidth}x${limits.maxHeight}`);
  }
  return {
    sessionId: record.sessionId,
    frameId: typeof result.frameId === 'string' && result.frameId !== '' ? result.frameId : randomUUID(),
    capturedAt: typeof result.capturedAt === 'string' && !Number.isNaN(Date.parse(result.capturedAt))
      ? result.capturedAt
      : isoNow(),
    width,
    height,
    imageWidth,
    imageHeight,
    mimeType: result.mimeType,
    data,
  };
}

export function createAndroidShowerBackend({ nativeBridge } = {}) {
  if (typeof nativeBridge !== 'function') throw invalid('nativeBridge must be a function');
  // Surfaces this backend ensured. close() releases exactly these and nothing
  // any other owner created.
  const owned = new Map();

  async function status(record, options = {}) {
    // No record (or no assigned session) means no environment: report a complete
    // idle snapshot without creating anything or waking Shizuku.
    if (!isPlainObject(record) || typeof record.sessionId !== 'string') return idleSession();
    sessionIdOf(record);
    const result = await callNative(nativeBridge, nativeRequest(record, 'status', {}, options),
      { signal: options.signal });
    // Explicit null/absent id means the surface is gone; any other value must be
    // the exact assigned id.
    if (result.sessionId === null || result.sessionId === undefined) {
      const idle = idleSession(PHASES.has(result.phase) && result.phase !== 'idle' ? result.phase : 'idle');
      const error = sessionError(result.error);
      if (error !== undefined) idle.error = error;
      return idle;
    }
    return sessionSnapshot(result, record, 'ready');
  }

  async function ensure(record, createOptions = {}, options = {}) {
    const sessionId = sessionIdOf(record);
    // Tracked before the native call: an unconfirmed ensure may already have
    // created a surface, and close must still release it.
    owned.set(sessionId, record);
    let result;
    try {
      result = await callNative(nativeBridge,
        nativeRequest(record, 'ensure', { options: createOptions ?? {} }, options),
        { signal: options.signal, mutating: true });
    } catch (err) {
      if (err?.outcome === 'not-sent') owned.delete(sessionId); // provably never created
      throw err;
    }
    return sessionSnapshot(result, record, 'ready');
  }

  async function frame(record, limits, options = {}) {
    sessionIdOf(record);
    const resolved = normalizeShowerFrameLimits(limits);
    const result = await callNative(nativeBridge,
      nativeRequest(record, 'frame', { limits: resolved }, options),
      { signal: options.signal });
    return frameFrom(result, record, resolved);
  }

  // callId stays a Host-side receipt concern; the native frame only carries the
  // trusted actor, taskId and the tagged input.
  async function input(record, value, options = {}) {
    sessionIdOf(record);
    const result = await callNative(nativeBridge,
      nativeRequest(record, 'input', { input: value }, options),
      { signal: options.signal, mutating: true });
    assertSameSession(result, record);
    return {
      sessionId: record.sessionId,
      type: isPlainObject(value) && typeof value.type === 'string' ? value.type : null,
    };
  }

  async function launch(record, value, options = {}) {
    sessionIdOf(record);
    if (!isPlainObject(value) || value.kind !== 'app') {
      // No silent fallback to a process launcher: Android has no such ability.
      throw messageError('SHOWER_UNSUPPORTED', 'the Android environment only launches apps, not processes');
    }
    if (typeof value.appId !== 'string' || value.appId === '') throw invalid('appId must be a nonempty string');
    const result = await callNative(nativeBridge,
      nativeRequest(record, 'launch', { target: value }, options),
      { signal: options.signal, mutating: true });
    assertSameSession(result, record);
    return { sessionId: record.sessionId, kind: 'app', appId: value.appId };
  }

  async function release(record, options = {}) {
    const sessionId = sessionIdOf(record);
    const result = await callNative(nativeBridge, nativeRequest(record, 'release', {}, options),
      { signal: options.signal, mutating: true });
    assertSameSession(result, record);
    owned.delete(sessionId);
    return {
      sessionId,
      phase: PHASES.has(result.phase) ? result.phase : 'closed',
    };
  }

  /**
   * Cleanup only the surfaces this backend ensured, never another owner's. Each
   * failure is collected while the rest are still released, the owned set is
   * emptied first so a second close is a no-op, and the summary is reported
   * instead of swallowed. Cleanup must not wait behind agent automation, so the
   * synthetic human taskId is generated here.
   */
  async function close() {
    const records = [...owned.values()];
    owned.clear();
    const failures = [];
    for (const record of records) {
      try {
        await callNative(nativeBridge,
          nativeRequest(record, 'release', {}, { source: 'human', taskId: `human:${randomUUID()}` }),
          { mutating: true });
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      const code = typeof failures[0].code === 'string' ? failures[0].code : 'SHOWER_BACKEND_FAILED';
      throw messageError(code,
        `close released ${records.length - failures.length}/${records.length} shower surface(s): ${failures[0].message}`);
    }
  }

  return { platform: PLATFORM, status, ensure, frame, input, launch, release, close };
}
