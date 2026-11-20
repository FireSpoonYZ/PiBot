// host-core/browser-setup-protocol.js
// Pure boundary normalizers and error sanitizers for authenticated owner
// browserControl and googleSetupControl volatile RPCs.
// No I/O, no runtime/storage/network, and no reflection of sensitive user
// inputs (typed text, lease tokens, URLs, or answers) into error messages.

import { assertId, messageError } from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const MAX_URL_BYTES = 4096;
const MAX_ID_FIELD_BYTES = 256;
const MAX_LEASE_BYTES = 512;
const MAX_LABEL_BYTES = 128;
const MAX_REASON_BYTES = 256;
const MAX_KEY_BYTES = 64;
const MAX_TEXT_LENGTH = 2000;
const MAX_SETUP_PAYLOAD_BYTES = 16384;
const MAX_SETUP_CHOICES = 16;
const MAX_WHEEL_DELTA = 10000;
const MIN_DIMENSION = 160;
const MAX_DIMENSION = 4096;

const ALLOWED_MODIFIERS = new Set(['CTRL', 'ALT', 'SHIFT', 'META']);
const ALLOWED_BUTTONS = new Set(['left', 'right', 'middle']);

export const BROWSER_CONTROL_ACTIONS = Object.freeze([
  'status',
  'open',
  'navigate',
  'back',
  'forward',
  'reload',
  'select',
  'closeTab',
  'frame',
  'takeover',
  'input',
  'handback',
  'release',
]);

export const GOOGLE_SETUP_ACTIONS = Object.freeze([
  'status',
  'start',
  'answer',
  'advance',
  'cancel',
  'resume',
]);

const BROWSER_ERROR_MESSAGES = Object.freeze({
  BROWSER_CLOSED: 'Bot browser service is closed.',
  BROWSER_UNAVAILABLE: 'Bot browser is unavailable on this host.',
  BROWSER_UNSUPPORTED: 'This browser action is not supported on this host.',
  BROWSER_FORBIDDEN: 'Browser control action is not permitted.',
  BROWSER_BUSY: 'Bot browser is busy settling an active action.',
  BROWSER_SENSITIVE_BLOCKED: 'Action blocked at a sensitive browser boundary.',
  BROWSER_SECRET_STEP_BLOCKED: 'Secret creation or display cannot be observed by the bot or streamed as a normal frame; complete this step in the system browser.',
  BROWSER_HANDBACK_BLOCKED_SENSITIVE: 'Cannot hand control back to the bot while on a sensitive, login, MFA, policy, or secret page.',
  BROWSER_PAUSED_FOR_HUMAN: 'Bot browser is paused while a human holds control.',
  BROWSER_TAKEOVER_PENDING: 'Takeover is waiting for in-flight bot action to settle.',
  BROWSER_TAKEOVER_UNCONFIRMED: 'Unable to confirm in-flight bot action stopped; human input remains locked.',
  BROWSER_TAKEOVER_REQUIRED: 'Human takeover is required before performing this browser action.',
  BROWSER_LEASE_REQUIRED: 'An active takeover lease is required for this browser action.',
  BROWSER_LEASE_EXPIRED: 'Human takeover lease expired or disconnected; explicitly resume takeover, hand back, or release.',
  BROWSER_LEASE_MISMATCH: 'Takeover lease is no longer active; refresh browser status.',
  BROWSER_LEASE_CONFLICT: 'Another client currently holds browser takeover control.',
  BROWSER_STALE_REVISION: 'Browser page state changed; refresh before sending input.',
  BROWSER_STALE_PAGE: 'Target browser page is no longer active; refresh before sending input.',
  BROWSER_STALE_FRAME: 'Browser frame is stale after navigation or state change; wait for a fresh frame.',
  BROWSER_PAGE_NOT_FOUND: 'Target browser tab was not found.',
  BROWSER_SESSION_NOT_FOUND: 'Browser session was not found.',
  BROWSER_INPUT_FAILED: 'Browser input could not be confirmed.',
  BROWSER_FRAME_TOO_LARGE: 'Browser frame exceeded the single-image size limit.',
  BROWSER_STREAM_UNAVAILABLE: 'Live interactive browser stream is unavailable on this host.',
  BROWSER_NAVIGATION_BLOCKED: 'Navigation to this URL is not permitted.',
  BROWSER_URL_BLOCKED: 'URL is blocked by browser security policy.',
  BROWSER_ACTION_BLOCKED: 'Browser action is blocked by security policy.',
  BROWSER_LIMIT_REACHED: 'Bot browser tab or session limit reached.',
  BROWSER_SESSION_LIMIT: 'Active bot browser session limit reached on this host.',
  BROWSER_TAB_LIMIT: 'Tab limit reached for this bot browser.',
  BROWSER_BACKEND_FAILED: 'Browser backend failed.',
});

const GOOGLE_SETUP_ERROR_MESSAGES = Object.freeze({
  GOOGLE_SETUP_UNAVAILABLE: 'Google setup service is unavailable on this host.',
  GOOGLE_SETUP_CONFLICT: 'Google setup state changed; refresh and try again.',
  GOOGLE_SETUP_FORBIDDEN: 'Google setup action is not permitted for this caller.',
  GOOGLE_SETUP_INVALID_STATE: 'Google setup action is invalid for the current step.',
  GOOGLE_SETUP_SENSITIVE_BLOCKED: 'This Google setup step must be completed directly by the owner.',
  GOOGLE_SETUP_NOT_FOUND: 'Google setup session was not found.',
});

export const BROWSER_ERROR_CODES = Object.freeze(Object.keys(BROWSER_ERROR_MESSAGES));
export const GOOGLE_SETUP_ERROR_CODES = Object.freeze(Object.keys(GOOGLE_SETUP_ERROR_MESSAGES));
export const BROWSER_SETUP_ERROR_CODES = Object.freeze([
  ...BROWSER_ERROR_CODES,
  ...GOOGLE_SETUP_ERROR_CODES,
]);

const PASSTHROUGH_CONTROL_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid control request.',
  UNAUTHORIZED: 'Control authentication failed.',
  ORIGIN_FORBIDDEN: 'Request origin is not permitted.',
  BOT_NOT_FOUND: 'Bot was not found on this host.',
  BOT_ARCHIVED: 'Bot is archived and read-only.',
  BOT_CONTEXT_REQUIRED: 'Conversation bot ownership could not be verified.',
  FORBIDDEN: 'Action is not permitted.',
  REQUEST_CONFLICT: 'Request conflicted with current host state.',
  REVISION_CONFLICT: 'State revision conflict; refresh and try again.',
  STALE_INPUT: 'Input state is stale; refresh and try again.',
  INVALID_STATE: 'Action is invalid for the current state.',
  NOT_FOUND: 'Requested resource was not found.',
  RUNTIME_BUSY: 'Host is preparing an update.',
  CANCELLED: 'Request was cancelled.',
  CENTER_OFFLINE: 'Center is offline.',
  SCOPE_NOT_FOUND: 'Scope was not found.',
  SCOPE_FORBIDDEN: 'Scope access is not permitted.',
  WORK_CONTEXT_NOT_FOUND: 'Work context was not found.',
});

const FORBIDDEN_SECRET_KEYS = new Set([
  'authority',
  'actor',
  'caller',
  'trusted',
  'owner',
  'clientsecret',
  'client_secret',
  'clientfile',
  'client_file',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'idtoken',
  'id_token',
  'password',
  'masterpassword',
  'master_password',
  'token',
  'cookies',
  'cookie',
  'eval',
  'script',
  'cdp',
]);

const BROWSER_ACTION_FIELDS = Object.freeze({
  status: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease']),
  open: new Set(['action', 'botId', 'scopeId', 'url', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision']),
  navigate: new Set(['action', 'botId', 'scopeId', 'url', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision']),
  back: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision']),
  forward: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision']),
  reload: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'ignoreCache']),
  select: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision']),
  closeTab: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision']),
  frame: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'sinceSeq', 'format', 'maxWidth', 'maxHeight', 'maxBytes', 'quality']),
  takeover: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'holderLabel', 'force', 'preempt', 'resume', 'reason']),
  input: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'frameSeq', 'event']),
  handback: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'reason']),
  release: new Set(['action', 'botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'force', 'preempt', 'reason']),
});

const GOOGLE_SETUP_ACTION_FIELDS = Object.freeze({
  status: new Set(['action', 'botId', 'scopeId', 'id', 'sessionId']),
  start: new Set(['action', 'botId', 'scopeId', 'mode', 'choices', 'audience', 'projectId', 'account', 'force', 'restart']),
  answer: new Set([
    'action', 'botId', 'scopeId', 'id', 'sessionId', 'revision', 'expectedRevision',
    'step', 'mode', 'choices', 'audience', 'projectId', 'account', 'flowId', 'clientId',
    'answer', 'value', 'confirm', 'done', 'skip', 'input',
  ]),
  advance: new Set([
    'action', 'botId', 'scopeId', 'id', 'sessionId', 'revision', 'expectedRevision',
    'step', 'mode', 'choices', 'audience', 'projectId', 'account', 'flowId', 'clientId',
    'confirm', 'done', 'skip', 'input',
  ]),
  cancel: new Set(['action', 'botId', 'scopeId', 'id', 'sessionId', 'revision', 'expectedRevision', 'reason']),
  resume: new Set(['action', 'botId', 'scopeId', 'id', 'sessionId', 'revision', 'expectedRevision', 'mode', 'step', 'account', 'flowId', 'projectId']),
});

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unsupported field`);
    }
  }
}

function assertBoundedString(value, name, maxBytes, { allowEmpty = false, allowControl = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw invalid(`${name} must be a well-formed string`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw invalid(`${name} must be non-empty`);
  }
  if (value.includes('\0')) {
    throw invalid(`${name} must not contain NUL bytes`);
  }
  if (!allowControl && /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid(`${name} must not contain control characters`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalid(`${name} exceeds maximum byte length`);
  }
  return value;
}

function assertNonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertBoundedInt(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw invalid(`${name} must be a boolean`);
  }
  return value;
}

function assertUnitCoordinate(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

function assertWheelDelta(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -MAX_WHEEL_DELTA || value > MAX_WHEEL_DELTA) {
    throw invalid(`${name} must be a finite number within +/-${MAX_WHEEL_DELTA}`);
  }
  return value;
}

function normalizeModifiers(raw) {
  if (!Array.isArray(raw) || raw.length > 4) {
    throw invalid('modifiers must be an array of at most 4 modifier names');
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw invalid('modifier must be a string');
    const upper = item.trim().toUpperCase();
    const mapped = upper === 'CONTROL' ? 'CTRL' : upper;
    if (!ALLOWED_MODIFIERS.has(mapped) || seen.has(mapped)) {
      throw invalid('modifiers must be unique values from CTRL, ALT, SHIFT, META');
    }
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

function normalizeBrowserInputEvent(raw) {
  if (!isPlainObject(raw)) {
    throw invalid('event must be a plain object');
  }
  switch (raw.kind) {
    case 'click': {
      rejectUnknownFields(raw, new Set(['kind', 'x', 'y', 'button', 'count', 'modifiers']), 'browser click event');
      const out = {
        kind: 'click',
        x: assertUnitCoordinate(raw.x, 'event.x'),
        y: assertUnitCoordinate(raw.y, 'event.y'),
      };
      if (raw.button !== undefined) {
        if (typeof raw.button !== 'string' || !ALLOWED_BUTTONS.has(raw.button)) {
          throw invalid('event.button must be left, right, or middle');
        }
        out.button = raw.button;
      }
      if (raw.count !== undefined) {
        if (raw.count !== 1 && raw.count !== 2) {
          throw invalid('event.count must be 1 or 2');
        }
        out.count = raw.count;
      }
      if (raw.modifiers !== undefined) {
        out.modifiers = normalizeModifiers(raw.modifiers);
      }
      return out;
    }
    case 'text': {
      rejectUnknownFields(raw, new Set(['kind', 'text']), 'browser text event');
      if (typeof raw.text !== 'string' || !raw.text.isWellFormed() || raw.text.length < 1 || raw.text.length > MAX_TEXT_LENGTH || raw.text.includes('\0')) {
        throw invalid('event.text must be a well-formed non-empty string within length limit');
      }
      return { kind: 'text', text: raw.text };
    }
    case 'key': {
      rejectUnknownFields(raw, new Set(['kind', 'key', 'modifiers']), 'browser key event');
      const out = {
        kind: 'key',
        key: assertBoundedString(raw.key, 'event.key', MAX_KEY_BYTES),
      };
      if (raw.modifiers !== undefined) {
        out.modifiers = normalizeModifiers(raw.modifiers);
      }
      return out;
    }
    case 'wheel': {
      rejectUnknownFields(raw, new Set(['kind', 'x', 'y', 'deltaX', 'deltaY', 'modifiers']), 'browser wheel event');
      const deltaX = raw.deltaX === undefined ? 0 : assertWheelDelta(raw.deltaX, 'event.deltaX');
      const deltaY = raw.deltaY === undefined ? 0 : assertWheelDelta(raw.deltaY, 'event.deltaY');
      if (deltaX === 0 && deltaY === 0) {
        throw invalid('wheel event requires a non-zero deltaX or deltaY');
      }
      const out = { kind: 'wheel', deltaX, deltaY };
      if (raw.x !== undefined) out.x = assertUnitCoordinate(raw.x, 'event.x');
      if (raw.y !== undefined) out.y = assertUnitCoordinate(raw.y, 'event.y');
      if (raw.modifiers !== undefined) out.modifiers = normalizeModifiers(raw.modifiers);
      return out;
    }
    default:
      throw invalid('event.kind must be click, text, key, or wheel');
  }
}

function sanitizeJsonValue(value, name, depth = 0) {
  if (depth > 6) throw invalid(`${name} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${name} must not contain non-finite numbers`);
    return value;
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed() || value.includes('\0')) {
      throw invalid(`${name} contains invalid string data`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw invalid(`${name} array exceeds limit`);
    return value.map((item) => sanitizeJsonValue(item, name, depth + 1));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 64) throw invalid(`${name} object exceeds key limit`);
    const out = {};
    for (const key of keys) {
      if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
        throw invalid(`${name} must not contain credential or authority fields`);
      }
      out[key] = sanitizeJsonValue(value[key], name, depth + 1);
    }
    return out;
  }
  throw invalid(`${name} must be JSON-serializable`);
}

function assertBoundedSetupPayload(value, name) {
  const sanitized = sanitizeJsonValue(value, name);
  let json;
  try {
    json = JSON.stringify(sanitized);
  } catch {
    throw invalid(`${name} must be JSON-serializable`);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_SETUP_PAYLOAD_BYTES) {
    throw invalid(`${name} exceeds maximum payload size`);
  }
  return sanitized;
}

/**
 * Normalize and strictly validate owner browserControl params.
 * Never allows authority/actor spoofing or eval/cookie/CDP passthrough.
 */
export function normalizeBrowserControl(input) {
  if (!isPlainObject(input)) {
    throw invalid('browserControl params must be a plain object');
  }
  if (typeof input.action !== 'string' || !Object.hasOwn(BROWSER_ACTION_FIELDS, input.action)) {
    throw invalid('browserControl action is unsupported');
  }
  const allowed = BROWSER_ACTION_FIELDS[input.action];
  rejectUnknownFields(input, allowed, 'browserControl params');
  assertId(input.botId, 'botId');

  const out = { action: input.action, botId: input.botId };
  if (input.scopeId !== undefined && input.scopeId !== null) {
    assertId(input.scopeId, 'scopeId');
    out.scopeId = input.scopeId;
  }
  if (input.pageId !== undefined) {
    out.pageId = assertBoundedString(input.pageId, 'pageId', MAX_ID_FIELD_BYTES);
  }
  if (input.sessionId !== undefined) {
    out.sessionId = assertBoundedString(input.sessionId, 'sessionId', MAX_ID_FIELD_BYTES);
  }
  if (input.lease !== undefined) {
    out.lease = assertBoundedString(input.lease, 'lease', MAX_LEASE_BYTES);
  }
  if (input.revision !== undefined) {
    out.revision = assertNonNegativeInt(input.revision, 'revision');
  }
  if (input.expectedRevision !== undefined) {
    out.expectedRevision = assertNonNegativeInt(input.expectedRevision, 'expectedRevision');
  }
  if (input.sinceSeq !== undefined) {
    out.sinceSeq = assertNonNegativeInt(input.sinceSeq, 'sinceSeq');
  }
  if (input.frameSeq !== undefined) {
    out.frameSeq = assertBoundedInt(input.frameSeq, 1, Number.MAX_SAFE_INTEGER, 'frameSeq');
  }
  if (input.format !== undefined) {
    const fmt = assertBoundedString(input.format, 'format', 16);
    if (fmt !== 'png' && fmt !== 'jpeg' && fmt !== 'webp') {
      throw invalid('format must be png, jpeg, or webp');
    }
    out.format = fmt;
  }
  if (input.maxWidth !== undefined) {
    out.maxWidth = assertBoundedInt(input.maxWidth, MIN_DIMENSION, MAX_DIMENSION, 'maxWidth');
  }
  if (input.maxHeight !== undefined) {
    out.maxHeight = assertBoundedInt(input.maxHeight, MIN_DIMENSION, MAX_DIMENSION, 'maxHeight');
  }
  if (input.maxBytes !== undefined) {
    out.maxBytes = assertBoundedInt(input.maxBytes, 1, 737280, 'maxBytes');
  }
  if (input.quality !== undefined) {
    out.quality = assertBoundedInt(input.quality, 1, 100, 'quality');
  }
  if (input.holderLabel !== undefined) {
    out.holderLabel = assertBoundedString(input.holderLabel, 'holderLabel', MAX_LABEL_BYTES);
  }
  if (input.reason !== undefined) {
    out.reason = assertBoundedString(input.reason, 'reason', MAX_REASON_BYTES, { allowEmpty: true });
  }
  if (input.force !== undefined) {
    out.force = assertBoolean(input.force, 'force');
  }
  if (input.preempt !== undefined) {
    out.preempt = assertBoolean(input.preempt, 'preempt');
  }
  if (input.resume !== undefined) {
    out.resume = assertBoolean(input.resume, 'resume');
  }
  if (input.ignoreCache !== undefined) {
    out.ignoreCache = assertBoolean(input.ignoreCache, 'ignoreCache');
  }
  if (input.action === 'navigate') {
    out.url = assertBoundedString(input.url, 'url', MAX_URL_BYTES);
  } else if (input.url !== undefined) {
    out.url = assertBoundedString(input.url, 'url', MAX_URL_BYTES);
  }
  if (input.action === 'input') {
    out.event = normalizeBrowserInputEvent(input.event);
  }
  return out;
}

/**
 * Normalize and strictly validate owner googleSetupControl params.
 * Never allows authority spoofing or OAuth secrets / client files through setupControl.
 */
export function normalizeGoogleSetupControl(input) {
  if (!isPlainObject(input)) {
    throw invalid('googleSetupControl params must be a plain object');
  }
  if (typeof input.action !== 'string' || !Object.hasOwn(GOOGLE_SETUP_ACTION_FIELDS, input.action)) {
    throw invalid('googleSetupControl action is unsupported');
  }
  const allowed = GOOGLE_SETUP_ACTION_FIELDS[input.action];
  rejectUnknownFields(input, allowed, 'googleSetupControl params');
  assertId(input.botId, 'botId');

  const out = { action: input.action, botId: input.botId };
  if (input.scopeId !== undefined && input.scopeId !== null) {
    assertId(input.scopeId, 'scopeId');
    out.scopeId = input.scopeId;
  }
  const stringFields = [
    ['id', MAX_ID_FIELD_BYTES],
    ['sessionId', MAX_ID_FIELD_BYTES],
    ['mode', MAX_KEY_BYTES],
    ['step', MAX_LABEL_BYTES],
    ['audience', MAX_KEY_BYTES],
    ['projectId', MAX_LABEL_BYTES],
    ['account', 320],
    ['flowId', MAX_ID_FIELD_BYTES],
    ['clientId', MAX_ID_FIELD_BYTES],
  ];
  for (const [field, maxBytes] of stringFields) {
    if (input[field] !== undefined) {
      out[field] = assertBoundedString(input[field], field, maxBytes);
    }
  }
  if (input.reason !== undefined) {
    out.reason = assertBoundedString(input.reason, 'reason', MAX_REASON_BYTES, { allowEmpty: true });
  }
  if (input.revision !== undefined) {
    out.revision = assertNonNegativeInt(input.revision, 'revision');
  }
  if (input.expectedRevision !== undefined) {
    out.expectedRevision = assertNonNegativeInt(input.expectedRevision, 'expectedRevision');
  }
  if (input.choices !== undefined) {
    if (!Array.isArray(input.choices) || input.choices.length > MAX_SETUP_CHOICES) {
      throw invalid(`choices must be an array of at most ${MAX_SETUP_CHOICES} service groups`);
    }
    out.choices = [...new Set(input.choices.map((item) => assertBoundedString(item, 'choices[]', MAX_KEY_BYTES)))];
  }
  for (const flag of ['confirm', 'done', 'skip', 'force', 'restart']) {
    if (input[flag] !== undefined) {
      out[flag] = assertBoolean(input[flag], flag);
    }
  }
  if (input.answer !== undefined) {
    out.answer = assertBoundedSetupPayload(input.answer, 'answer');
  }
  if (input.value !== undefined) {
    out.value = assertBoundedSetupPayload(input.value, 'value');
  }
  if (input.input !== undefined) {
    if (!isPlainObject(input.input)) {
      throw invalid('input must be a plain object');
    }
    out.input = assertBoundedSetupPayload(input.input, 'input');
  }
  return out;
}

export function browserControlError(code) {
  const safeCode = Object.hasOwn(BROWSER_ERROR_MESSAGES, code)
    ? code
    : Object.hasOwn(PASSTHROUGH_CONTROL_MESSAGES, code)
      ? code
      : 'BROWSER_UNAVAILABLE';
  const msg = BROWSER_ERROR_MESSAGES[safeCode] ?? PASSTHROUGH_CONTROL_MESSAGES[safeCode] ?? BROWSER_ERROR_MESSAGES.BROWSER_UNAVAILABLE;
  return messageError(safeCode, msg);
}

export function safeBrowserControlError(error) {
  if (error?.name === 'AbortError') return browserControlError('CANCELLED');
  return browserControlError(error?.code);
}

export function googleSetupError(code) {
  const safeCode = Object.hasOwn(GOOGLE_SETUP_ERROR_MESSAGES, code)
    ? code
    : Object.hasOwn(PASSTHROUGH_CONTROL_MESSAGES, code)
      ? code
      : 'GOOGLE_SETUP_UNAVAILABLE';
  const msg = GOOGLE_SETUP_ERROR_MESSAGES[safeCode] ?? PASSTHROUGH_CONTROL_MESSAGES[safeCode] ?? GOOGLE_SETUP_ERROR_MESSAGES.GOOGLE_SETUP_UNAVAILABLE;
  return messageError(safeCode, msg);
}

export function safeGoogleSetupError(error) {
  if (error?.name === 'AbortError') return googleSetupError('CANCELLED');
  return googleSetupError(error?.code);
}
