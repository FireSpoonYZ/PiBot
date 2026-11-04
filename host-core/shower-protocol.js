// host-core/shower-protocol.js
// Unified Shower graphical-environment protocol: pure boundary normalizers and
// constants shared by Android/Windows/Linux. No I/O, no Host/Runtime/storage,
// no model or process calls; platform backends consume the normalized values.
import { messageError, assertId } from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

// ABSOLUTE full base64 image budget (720 KiB); a whole control result must stay
// below the existing 1 MiB JSON frame. Backends resize/compress to fit and error
// out instead of ever raising this ceiling.
export const SHOWER_MAX_FRAME_BASE64_BYTES = 737280;

export const SHOWER_ERROR_CODES = Object.freeze([
  'SHOWER_UNAVAILABLE',
  'SHOWER_UNSUPPORTED',
  'SHOWER_BUSY',
  'SHOWER_AUTH_REQUIRED',
  'SHOWER_PERMISSION_REQUIRED',
  'SHOWER_SESSION_NOT_FOUND',
  'SHOWER_SESSION_MISMATCH',
  'SHOWER_NOT_READY',
  'SHOWER_INPUT_FAILED',
  'SHOWER_FRAME_TOO_LARGE',
  'SHOWER_BACKEND_FAILED',
]);

// Default desktop size and source-pixel bounds shared by every platform.
const DEFAULT_FRAME_WIDTH = 1280;
const DEFAULT_FRAME_HEIGHT = 800;
const MIN_DIMENSION = 160;
const MAX_DIMENSION = 4096;
const MAX_TEXT_LENGTH = 1000;
const MIN_DRAG_MS = 50;
const MAX_DRAG_MS = 3000;
// Wheel deltas are integer notches, positive Y down / positive X right.
const MAX_WHEEL_NOTCHES = 20;
const MAX_LAUNCH_ARGS = 256;
const MAX_LAUNCH_STRING_BYTES = 4096;

const KEY_NAMES = new Set([
  'ENTER',
  'TAB',
  'ESCAPE',
  'SPACE',
  'BACKSPACE',
  'DELETE',
  'LEFT',
  'RIGHT',
  'UP',
  'DOWN',
  'HOME',
  'END',
  'PAGEUP',
  'PAGEDOWN',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  // Android-only names: accepted here, rejected with SHOWER_UNSUPPORTED by
  // platforms without them rather than silently approximated.
  'BACK',
  'ANDROID_HOME',
]);
const MODIFIERS = ['CTRL', 'ALT', 'SHIFT', 'META'];

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${label} has unknown field: ${key}`);
  }
}

function assertIntegerInRange(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertCoordinate(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DIMENSION) {
    throw invalid(`${name} must be an integer source pixel between 0 and ${MAX_DIMENSION}`);
  }
  return value;
}

function assertDimension(value, name) {
  return assertIntegerInRange(value, MIN_DIMENSION, MAX_DIMENSION, name);
}

function assertWheelNotches(value, name) {
  return assertIntegerInRange(value, -MAX_WHEEL_NOTCHES, MAX_WHEEL_NOTCHES, name);
}

// Launch strings are passed to a child process directly, never through a shell.
function assertLaunchString(value, name, allowEmpty = false) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    (!allowEmpty && value.trim() === '') ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_LAUNCH_STRING_BYTES
  ) {
    throw invalid(`${name} must be a non-blank well-formed string without NUL within ${MAX_LAUNCH_STRING_BYTES} UTF-8 bytes`);
  }
  return value;
}

/** Target = {botId, scopeId?}; an absent (or null) scopeId means the primary conversation. */
export function normalizeShowerTarget(value) {
  if (!isPlainObject(value)) throw invalid('target must be a plain object');
  rejectUnknownFields(value, new Set(['botId', 'scopeId']), 'target');
  assertId(value.botId, 'botId');
  const target = { botId: value.botId };
  if (value.scopeId !== undefined && value.scopeId !== null) {
    assertId(value.scopeId, 'scopeId');
    target.scopeId = value.scopeId;
  }
  return target;
}

/** Create dimensions are environment source pixels; omitted values keep the backend default. */
export function normalizeShowerCreate(value = {}) {
  if (!isPlainObject(value)) throw invalid('create options must be a plain object');
  rejectUnknownFields(value, new Set(['width', 'height']), 'create options');
  const create = {};
  if (value.width !== undefined) create.width = assertDimension(value.width, 'width');
  if (value.height !== undefined) create.height = assertDimension(value.height, 'height');
  return create;
}

/** Frame limits always resolve to concrete values so every backend bounds the same way. */
export function normalizeShowerFrameLimits(value = {}) {
  if (!isPlainObject(value)) throw invalid('frame limits must be a plain object');
  rejectUnknownFields(value, new Set(['maxWidth', 'maxHeight', 'maxBytes']), 'frame limits');
  const limits = {
    maxWidth: DEFAULT_FRAME_WIDTH,
    maxHeight: DEFAULT_FRAME_HEIGHT,
    maxBytes: SHOWER_MAX_FRAME_BASE64_BYTES,
  };
  if (value.maxWidth !== undefined) limits.maxWidth = assertDimension(value.maxWidth, 'maxWidth');
  if (value.maxHeight !== undefined) limits.maxHeight = assertDimension(value.maxHeight, 'maxHeight');
  if (value.maxBytes !== undefined) {
    if (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > SHOWER_MAX_FRAME_BASE64_BYTES) {
      throw invalid(`maxBytes must be an integer between 1 and ${SHOWER_MAX_FRAME_BASE64_BYTES}`);
    }
    limits.maxBytes = value.maxBytes;
  }
  return limits;
}

export function normalizeShowerSessionId(value) {
  assertId(value, 'sessionId');
  return value;
}

/**
 * Tagged input in source pixels. Unknown keys stay invalid arguments here; a
 * known-but-unsupported key or direction is the backend's SHOWER_UNSUPPORTED
 * decision, never an approximation.
 */
export function normalizeShowerInput(value) {
  if (!isPlainObject(value)) throw invalid('input must be a plain object');
  switch (value.type) {
    case 'click': {
      rejectUnknownFields(value, new Set(['type', 'x', 'y', 'button', 'count']), 'click input');
      const button = value.button === undefined ? 'left' : value.button;
      if (button !== 'left' && button !== 'right' && button !== 'middle') {
        throw invalid("click button must be 'left', 'right' or 'middle'");
      }
      const count = value.count === undefined ? 1 : value.count;
      if (count !== 1 && count !== 2) throw invalid('click count must be 1 or 2');
      return {
        type: 'click',
        x: assertCoordinate(value.x, 'x'),
        y: assertCoordinate(value.y, 'y'),
        button,
        count,
      };
    }
    case 'drag': {
      rejectUnknownFields(value, new Set(['type', 'x1', 'y1', 'x2', 'y2', 'durationMs']), 'drag input');
      const drag = {
        type: 'drag',
        x1: assertCoordinate(value.x1, 'x1'),
        y1: assertCoordinate(value.y1, 'y1'),
        x2: assertCoordinate(value.x2, 'x2'),
        y2: assertCoordinate(value.y2, 'y2'),
      };
      if (value.durationMs !== undefined) {
        drag.durationMs = assertIntegerInRange(value.durationMs, MIN_DRAG_MS, MAX_DRAG_MS, 'durationMs');
      }
      return drag;
    }
    case 'scroll': {
      rejectUnknownFields(value, new Set(['type', 'x', 'y', 'deltaX', 'deltaY']), 'scroll input');
      const deltaX = value.deltaX === undefined ? 0 : assertWheelNotches(value.deltaX, 'deltaX');
      const deltaY = assertWheelNotches(value.deltaY, 'deltaY');
      if (deltaX === 0 && deltaY === 0) throw invalid('scroll needs at least one nonzero delta');
      return {
        type: 'scroll',
        x: assertCoordinate(value.x, 'x'),
        y: assertCoordinate(value.y, 'y'),
        deltaX,
        deltaY,
      };
    }
    case 'key': {
      rejectUnknownFields(value, new Set(['type', 'key', 'modifiers']), 'key input');
      if (typeof value.key !== 'string') throw invalid('key must be a string');
      const key = value.key.toUpperCase();
      if (!KEY_NAMES.has(key)) throw invalid('key is not a supported key name');
      const keyInput = { type: 'key', key };
      if (value.modifiers !== undefined) {
        if (!Array.isArray(value.modifiers)) throw invalid('key modifiers must be an array');
        const modifiers = value.modifiers.map((modifier) => {
          if (!MODIFIERS.includes(modifier)) throw invalid("key modifiers must be 'CTRL', 'ALT', 'SHIFT' or 'META'");
          return modifier;
        });
        if (new Set(modifiers).size !== modifiers.length) throw invalid('key modifiers must not repeat');
        if (modifiers.length > 0) keyInput.modifiers = modifiers;
      }
      return keyInput;
    }
    case 'text': {
      rejectUnknownFields(value, new Set(['type', 'text']), 'text input');
      if (typeof value.text !== 'string' || !value.text.isWellFormed() || value.text.length === 0) {
        throw invalid('text must be a non-empty well-formed string');
      }
      if (value.text.length > MAX_TEXT_LENGTH) throw invalid(`text must be at most ${MAX_TEXT_LENGTH} characters`);
      return { type: 'text', text: value.text };
    }
    default:
      throw invalid("input.type must be 'click', 'drag', 'scroll', 'key' or 'text'");
  }
}

/** Launch runs inside the environment as an app id or a direct program, never through a shell. */
export function normalizeShowerLaunch(value) {
  if (!isPlainObject(value)) throw invalid('launch must be a plain object');
  if (value.kind === 'app') {
    rejectUnknownFields(value, new Set(['kind', 'appId']), 'app launch');
    assertId(value.appId, 'appId');
    return { kind: 'app', appId: value.appId };
  }
  if (value.kind === 'process') {
    rejectUnknownFields(value, new Set(['kind', 'program', 'args', 'cwd']), 'process launch');
    const launch = { kind: 'process', program: assertLaunchString(value.program, 'program') };
    if (value.args !== undefined) {
      if (!Array.isArray(value.args)) throw invalid('process args must be an array');
      if (value.args.length > MAX_LAUNCH_ARGS) throw invalid(`process args must have at most ${MAX_LAUNCH_ARGS} entries`);
      launch.args = value.args.map((arg, index) => assertLaunchString(arg, `args[${index}]`, true));
    }
    if (value.cwd !== undefined) launch.cwd = assertLaunchString(value.cwd, 'cwd');
    return launch;
  }
  throw invalid("launch.kind must be 'app' or 'process'");
}
