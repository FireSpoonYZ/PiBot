// host-core/bot-browser/protocol.js
// Pure Bot Browser protocol normalizers, constants, DTO validators, and safe error helpers.
// Zero I/O, zero Host/Runtime/storage dependencies, and never reflects sensitive input/secrets.
import { resolve, sep } from 'node:path';
import { assertId, messageError } from '../message-protocol.js';

export const BROWSER_PHASES = Object.freeze(['bot', 'taking', 'human', 'held']);

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

export const BROWSER_BOT_ACTIONS = Object.freeze([
  'status',
  'open',
  'navigate',
  'back',
  'forward',
  'reload',
  'select',
  'closeTab',
  'snapshot',
  'act',
  'screenshot',
  'requestTakeover',
]);

export const BROWSER_ACT_KINDS = Object.freeze([
  'click',
  'dblclick',
  'fill',
  'type',
  'select',
  'scroll',
  'hover',
  'press',
  'wait',
]);

export const BROWSER_INPUT_KINDS = Object.freeze(['click', 'text', 'key', 'wheel']);

// Fits inside PiBot's existing 1 MiB volatile control RPC wire frame budget.
export const BROWSER_MAX_FRAME_BASE64_BYTES = 737280; // 720 KiB
export const BROWSER_MAX_SNAPSHOT_TEXT_BYTES = 48 * 1024; // 48 KiB
export const BROWSER_MAX_TABS_PER_BOT = 8;
export const BROWSER_MAX_ACTIVE_SESSIONS = 8;
export const BROWSER_DEFAULT_LEASE_TTL_MS = 30_000;
export const BROWSER_MIN_LEASE_TTL_MS = 5_000;
export const BROWSER_MAX_LEASE_TTL_MS = 120_000;
export const BROWSER_DEFAULT_TAKEOVER_TIMEOUT_MS = 15_000;
export const BROWSER_MIN_TAKEOVER_TIMEOUT_MS = 500;
export const BROWSER_MAX_TAKEOVER_TIMEOUT_MS = 60_000;
export const BROWSER_DEFAULT_IDLE_CLOSE_MS = 10 * 60_000;

export const BROWSER_ERROR_CODES = Object.freeze([
  'INVALID_ARGUMENT',
  'BOT_NOT_FOUND',
  'BOT_CONTEXT_REQUIRED',
  'RUNTIME_BUSY',
  'CANCELLED',
  'BROWSER_CLOSED',
  'BROWSER_UNAVAILABLE',
  'BROWSER_UNSUPPORTED',
  'BROWSER_FORBIDDEN',
  'BROWSER_SESSION_LIMIT',
  'BROWSER_TAB_LIMIT',
  'BROWSER_PAGE_NOT_FOUND',
  'BROWSER_PAUSED_FOR_HUMAN',
  'BROWSER_TAKEOVER_PENDING',
  'BROWSER_TAKEOVER_UNCONFIRMED',
  'BROWSER_TAKEOVER_REQUIRED',
  'BROWSER_LEASE_CONFLICT',
  'BROWSER_LEASE_EXPIRED',
  'BROWSER_STALE_REVISION',
  'BROWSER_STALE_PAGE',
  'BROWSER_STALE_FRAME',
  'BROWSER_SENSITIVE_BLOCKED',
  'BROWSER_SECRET_STEP_BLOCKED',
  'BROWSER_HANDBACK_BLOCKED_SENSITIVE',
  'BROWSER_URL_BLOCKED',
  'BROWSER_ACTION_BLOCKED',
  'BROWSER_FRAME_TOO_LARGE',
  'BROWSER_STREAM_UNAVAILABLE',
  'BROWSER_BACKEND_FAILED',
]);

const KNOWN_ERROR_CODE_SET = new Set(BROWSER_ERROR_CODES);

const SAFE_DEFAULT_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid browser request.',
  BOT_NOT_FOUND: 'Bot not found on this host.',
  BOT_CONTEXT_REQUIRED: 'Conversation is not owned by a local bot.',
  RUNTIME_BUSY: 'Host is preparing an update.',
  CANCELLED: 'Browser operation cancelled.',
  BROWSER_CLOSED: 'Bot browser service is closed.',
  BROWSER_UNAVAILABLE: 'Bot browser is unavailable on this host.',
  BROWSER_UNSUPPORTED: 'Requested browser action is not supported.',
  BROWSER_FORBIDDEN: 'Browser control action is not permitted.',
  BROWSER_SESSION_LIMIT: 'Active bot browser session limit reached on this host.',
  BROWSER_TAB_LIMIT: 'Tab limit reached for this bot browser.',
  BROWSER_PAGE_NOT_FOUND: 'Requested browser page does not belong to this bot.',
  BROWSER_PAUSED_FOR_HUMAN: 'Browser is paused for human control.',
  BROWSER_TAKEOVER_PENDING: 'Takeover is waiting for in-flight bot action to settle.',
  BROWSER_TAKEOVER_UNCONFIRMED: 'Unable to confirm in-flight bot action stopped; human input remains locked.',
  BROWSER_TAKEOVER_REQUIRED: 'Human takeover is required before performing this action.',
  BROWSER_LEASE_CONFLICT: 'Another client currently holds human control for this bot browser.',
  BROWSER_LEASE_EXPIRED: 'Human takeover lease expired or disconnected; explicitly resume takeover, hand back, or release.',
  BROWSER_STALE_REVISION: 'Browser state changed; refresh status before sending input.',
  BROWSER_STALE_PAGE: 'Target page is no longer active; refresh before sending input.',
  BROWSER_STALE_FRAME: 'Frame is stale after page navigation or state change; wait for a fresh frame.',
  BROWSER_SENSITIVE_BLOCKED: 'Sensitive page or authentication step requires human action and blocks bot/bystander access.',
  BROWSER_SECRET_STEP_BLOCKED: 'Secret creation or display cannot be observed by the bot or streamed as a normal frame; complete this step in the system browser.',
  BROWSER_HANDBACK_BLOCKED_SENSITIVE: 'Cannot hand control back to the bot while on a sensitive, login, MFA, policy, or secret page.',
  BROWSER_URL_BLOCKED: 'URL is blocked by browser security policy.',
  BROWSER_ACTION_BLOCKED: 'Browser action is blocked by security policy.',
  BROWSER_FRAME_TOO_LARGE: 'Browser frame exceeds size limit.',
  BROWSER_STREAM_UNAVAILABLE: 'Live interactive browser stream is unavailable on this host.',
  BROWSER_BACKEND_FAILED: 'Browser backend failed.',
});

const CONTROL_ACTION_FIELDS = Object.freeze({
  status: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease'],
  open: ['botId', 'scopeId', 'pageId', 'sessionId', 'url', 'lease', 'revision', 'expectedRevision'],
  navigate: ['botId', 'scopeId', 'pageId', 'sessionId', 'url', 'lease', 'revision', 'expectedRevision'],
  back: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision'],
  forward: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision'],
  reload: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'ignoreCache'],
  select: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision'],
  closeTab: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision'],
  frame: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'sinceSeq', 'format', 'quality', 'maxWidth', 'maxHeight', 'maxBytes'],
  takeover: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'force', 'preempt', 'resume', 'holderLabel', 'reason', 'sensitive'],
  input: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'frameSeq', 'event'],
  handback: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'reason'],
  release: ['botId', 'scopeId', 'pageId', 'sessionId', 'lease', 'revision', 'expectedRevision', 'force', 'preempt', 'reason'],
});

const PRIVILEGED_ROLES = new Set(['owner', 'admin']);
const VIEWER_ROLES = new Set(['viewer']);
const FORBIDDEN_ROLES = new Set(['bot', 'agent', 'collaborator', 'member', 'room', 'guest']);

const ALLOWED_SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', ' ',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

const MODIFIER_CANONICAL = Object.freeze({
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
});
const ALLOWED_MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);
const ALLOWED_FRAME_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_FRAME_FORMATS = new Set(['png', 'jpeg', 'webp']);
const ALLOWED_SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const ALLOWED_WAIT_LOAD_STATES = new Set(['load', 'domcontentloaded', 'networkidle']);
const ALLOWED_WAIT_ELEMENT_STATES = new Set(['visible', 'hidden']);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const MAX_PAGE_ID_BYTES = 128;
const MAX_LEASE_BYTES = 256;
const MAX_LABEL_CHARS = 80;
const MAX_URL_BYTES = 4096;
const MAX_TITLE_CHARS = 256;
const MAX_REF_CHARS = 128;
const MAX_SELECTOR_CHARS = 512;
const MAX_TEXT_INPUT_CHARS = 1000;
const MAX_FILL_VALUE_CHARS = 4000;
const MAX_WAIT_TIMEOUT_MS = 15_000;
const MIN_DIMENSION = 160;
const MAX_DIMENSION = 4096;
const MAX_WHEEL_DELTA = 4000;

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function browserError(code, message, details) {
  const normalizedCode = KNOWN_ERROR_CODE_SET.has(code) ? code : 'BROWSER_BACKEND_FAILED';
  const err = messageError(normalizedCode, message || SAFE_DEFAULT_MESSAGES[normalizedCode]);
  if (details !== undefined && isPlainObject(details)) {
    err.details = details;
  }
  return err;
}

/** Never reflects untrusted user input, keystrokes, or internal exception details across secret/control boundaries. */
export function safeBrowserError(error, fallbackCode = 'BROWSER_BACKEND_FAILED') {
  const code = typeof error?.code === 'string' && KNOWN_ERROR_CODE_SET.has(error.code)
    ? error.code
    : fallbackCode;
  const err = browserError(code, SAFE_DEFAULT_MESSAGES[code]);
  if (error?.outcome === 'not-sent' || error?.outcome === 'unconfirmed') {
    err.outcome = error.outcome;
  }
  if (isPlainObject(error?.details)) {
    const safeDetails = {};
    for (const key of ['phase', 'reason', 'holderLabel', 'fallbackToSystemBrowser', 'revision', 'pageId']) {
      if (error.details[key] !== undefined) safeDetails[key] = error.details[key];
    }
    if (Object.keys(safeDetails).length > 0) err.details = safeDetails;
  }
  return err;
}

function rejectUnknownFields(obj, allowed, label) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw browserError('INVALID_ARGUMENT', `${label} has unknown field: ${key}`);
    }
  }
}

function assertBoundedString(value, name, { min = 1, max = 256, maxBytes = null, allowControl = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw browserError('INVALID_ARGUMENT', `${name} must be a well-formed string`);
  }
  if (value.length < min || value.length > max) {
    throw browserError('INVALID_ARGUMENT', `${name} length must be between ${min} and ${max}`);
  }
  if (maxBytes !== null && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw browserError('INVALID_ARGUMENT', `${name} exceeds ${maxBytes} UTF-8 bytes`);
  }
  if (!allowControl && /[\u0000-\u001f\u007f]/u.test(value)) {
    throw browserError('INVALID_ARGUMENT', `${name} must not contain control characters`);
  }
  return value;
}

export function normalizePageId(value, name = 'pageId') {
  return assertBoundedString(value, name, { min: 1, max: 128, maxBytes: MAX_PAGE_ID_BYTES }).trim();
}

export function normalizeLeaseToken(value, name = 'lease') {
  return assertBoundedString(value, name, { min: 8, max: 256, maxBytes: MAX_LEASE_BYTES });
}

export function normalizeRevision(value, name = 'revision') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw browserError('INVALID_ARGUMENT', `${name} must be a non-negative safe integer`);
  }
  return value;
}

export function normalizeFrameSeq(value, name = 'frameSeq') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw browserError('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
  }
  return value;
}

export function normalizeHolderLabel(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, MAX_LABEL_CHARS);
}

/**
 * Validates per-bot profile directory under profileRoot.
 * Mirrors host-core/attachments.js botAttachmentDirectory: rejects path separators,
 * drive letters, and parent traversal so bots can never share or escape their profile root.
 */
export function botBrowserProfileDirectory(profileRoot, botId) {
  assertId(botId, 'botId');
  if (typeof profileRoot !== 'string' || profileRoot.trim() === '') {
    throw browserError('INVALID_ARGUMENT', 'profileRoot must be a non-empty path');
  }
  if (
    botId === '.' ||
    botId === '..' ||
    botId.includes('/') ||
    botId.includes('\\') ||
    botId.includes(':') ||
    /[\u0000-\u001f\u007f]/u.test(botId)
  ) {
    throw browserError('INVALID_ARGUMENT', 'botId is not a safe profile directory name');
  }
  const base = resolve(profileRoot);
  const dir = resolve(base, botId);
  if (dir !== base + sep + botId) {
    throw browserError('INVALID_ARGUMENT', 'botId is not a safe profile directory name');
  }
  return dir;
}

/**
 * Trusted control-channel authority normalizer.
 * Authority MUST come from the authenticated control transport (local Tauri/HTTP or remote relay),
 * never from model arguments or untrusted request body fields.
 */
export function normalizeControlAuthority(authority) {
  if (!isPlainObject(authority)) {
    throw browserError('BROWSER_FORBIDDEN', 'Trusted authenticated control authority is required');
  }
  if (authority.authenticated === false) {
    throw browserError('BROWSER_FORBIDDEN', 'Control authority is not authenticated');
  }
  if (authority.trustedSystem === true && authority.actor === 'system') {
    return Object.freeze({
      role: 'system',
      clientId: 'system:google-setup',
      holderLabel: 'System Privacy Lock',
      principalId: null,
      transport: 'system',
      canControl: true,
      canViewSensitive: false,
    });
  }
  const rawRole = authority.role === undefined ? 'owner' : authority.role;
  if (typeof rawRole !== 'string' || FORBIDDEN_ROLES.has(rawRole)) {
    throw browserError('BROWSER_FORBIDDEN', 'Caller role is not permitted to use browserControl');
  }
  if (!PRIVILEGED_ROLES.has(rawRole) && !VIEWER_ROLES.has(rawRole)) {
    throw browserError('BROWSER_FORBIDDEN', 'Unknown browserControl authority role');
  }

  const rawClientId = authority.clientId ?? authority.callerId ?? authority.deviceId ?? (
    authority.transport === 'local' || authority.kind === 'local' ? 'local-control' : null
  );
  if (typeof rawClientId !== 'string' || rawClientId.trim() === '') {
    throw browserError('BROWSER_FORBIDDEN', 'Control authority must identify the client (clientId)');
  }
  const clientId = assertBoundedString(rawClientId.trim(), 'authority.clientId', { min: 1, max: 128, maxBytes: 128 });
  const holderLabel = normalizeHolderLabel(
    authority.holderLabel ?? authority.label ?? authority.deviceName ?? authority.clientLabel ?? clientId
  ) ?? clientId;
  const principalId = authority.principalId === undefined || authority.principalId === null
    ? null
    : assertBoundedString(String(authority.principalId).trim(), 'authority.principalId', { min: 1, max: 128, maxBytes: 128 });
  const canControl = PRIVILEGED_ROLES.has(rawRole);
  const canViewSensitive = PRIVILEGED_ROLES.has(rawRole);

  return Object.freeze({
    role: rawRole,
    clientId,
    holderLabel,
    principalId,
    transport: typeof authority.transport === 'string' ? authority.transport : (typeof authority.kind === 'string' ? authority.kind : 'control'),
    canControl,
    canViewSensitive,
  });
}

function assertUnitCoordinate(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw browserError('INVALID_ARGUMENT', `${name} must be a finite number in [0, 1]`);
  }
  return value;
}

function assertKeyName(value, name = 'key') {
  const key = assertBoundedString(value, name, { min: 1, max: 32, maxBytes: 32 });
  if (ALLOWED_SPECIAL_KEYS.has(key)) return key;
  // Allow single printable Unicode scalar (character) key presses.
  const chars = [...key];
  if (chars.length === 1 && !/[\u0000-\u001f\u007f]/u.test(key)) return key;
  throw browserError('BROWSER_UNSUPPORTED', `Unsupported key name: ${name}`);
}

function normalizeModifiers(modifiers) {
  if (modifiers === undefined) return undefined;
  if (!Array.isArray(modifiers) || modifiers.length > 4) {
    throw browserError('INVALID_ARGUMENT', 'modifiers must be an array of at most 4 modifier names');
  }
  const out = [];
  for (const mod of modifiers) {
    if (typeof mod !== 'string') {
      throw browserError('BROWSER_UNSUPPORTED', 'Unsupported keyboard modifier');
    }
    const canonical = MODIFIER_CANONICAL[mod.trim().toLowerCase()];
    if (!canonical) {
      throw browserError('BROWSER_UNSUPPORTED', 'Unsupported keyboard modifier');
    }
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export function normalizeInputEvent(event) {
  if (!isPlainObject(event)) {
    throw browserError('INVALID_ARGUMENT', 'input event must be an object');
  }
  if (typeof event.kind !== 'string' || !BROWSER_INPUT_KINDS.includes(event.kind)) {
    throw browserError('INVALID_ARGUMENT', 'input event.kind must be click, text, key, or wheel');
  }
  switch (event.kind) {
    case 'click': {
      rejectUnknownFields(event, ['kind', 'x', 'y', 'button', 'count', 'clickCount', 'modifiers'], 'input.event');
      const normalized = {
        kind: 'click',
        x: assertUnitCoordinate(event.x, 'event.x'),
        y: assertUnitCoordinate(event.y, 'event.y'),
      };
      if (event.button !== undefined) {
        if (!ALLOWED_MOUSE_BUTTONS.has(event.button)) {
          throw browserError('INVALID_ARGUMENT', 'event.button must be left, right, or middle');
        }
        normalized.button = event.button;
      }
      const rawCount = event.count !== undefined ? event.count : event.clickCount;
      if (rawCount !== undefined) {
        if (rawCount !== 1 && rawCount !== 2) {
          throw browserError('INVALID_ARGUMENT', 'event.count must be 1 or 2');
        }
        normalized.count = rawCount;
      }
      const modifiers = normalizeModifiers(event.modifiers);
      if (modifiers !== undefined && modifiers.length > 0) {
        normalized.modifiers = modifiers;
      }
      return normalized;
    }
    case 'text': {
      rejectUnknownFields(event, ['kind', 'text'], 'input.event');
      if (typeof event.text !== 'string' || !event.text.isWellFormed()
          || event.text.length < 1 || event.text.length > MAX_TEXT_INPUT_CHARS) {
        throw browserError('INVALID_ARGUMENT', 'event.text must be a non-empty string of at most 1000 chars');
      }
      if (event.text.includes('\u0000')) {
        throw browserError('INVALID_ARGUMENT', 'event.text must not contain NUL bytes');
      }
      return { kind: 'text', text: event.text };
    }
    case 'key': {
      rejectUnknownFields(event, ['kind', 'key', 'modifiers'], 'input.event');
      const normalized = {
        kind: 'key',
        key: assertKeyName(event.key, 'event.key'),
      };
      const modifiers = normalizeModifiers(event.modifiers);
      if (modifiers !== undefined && modifiers.length > 0) {
        normalized.modifiers = modifiers;
      }
      return normalized;
    }
    case 'wheel': {
      rejectUnknownFields(event, ['kind', 'deltaX', 'deltaY', 'x', 'y', 'modifiers'], 'input.event');
      const deltaX = event.deltaX === undefined ? 0 : event.deltaX;
      const deltaY = event.deltaY === undefined ? 0 : event.deltaY;
      if (typeof deltaX !== 'number' || !Number.isFinite(deltaX) || Math.abs(deltaX) > MAX_WHEEL_DELTA) {
        throw browserError('INVALID_ARGUMENT', 'event.deltaX must be a finite number within [-4000, 4000]');
      }
      if (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || Math.abs(deltaY) > MAX_WHEEL_DELTA) {
        throw browserError('INVALID_ARGUMENT', 'event.deltaY must be a finite number within [-4000, 4000]');
      }
      if (deltaX === 0 && deltaY === 0) {
        throw browserError('INVALID_ARGUMENT', 'wheel event requires non-zero deltaX or deltaY');
      }
      const normalized = { kind: 'wheel', deltaX, deltaY };
      if (event.x !== undefined) normalized.x = assertUnitCoordinate(event.x, 'event.x');
      if (event.y !== undefined) normalized.y = assertUnitCoordinate(event.y, 'event.y');
      const modifiers = normalizeModifiers(event.modifiers);
      if (modifiers !== undefined && modifiers.length > 0) {
        normalized.modifiers = modifiers;
      }
      return normalized;
    }
    default:
      throw browserError('INVALID_ARGUMENT', 'Unsupported input event kind');
  }
}

export function normalizeFrameLimits(input = {}, maxFrameBase64Bytes = BROWSER_MAX_FRAME_BASE64_BYTES) {
  const limits = {};
  if (input.format !== undefined) {
    if (!ALLOWED_FRAME_FORMATS.has(input.format)) {
      throw browserError('INVALID_ARGUMENT', 'format must be png, jpeg, or webp');
    }
    limits.format = input.format;
  }
  if (input.quality !== undefined) {
    if (!Number.isSafeInteger(input.quality) || input.quality < 1 || input.quality > 100) {
      throw browserError('INVALID_ARGUMENT', 'quality must be an integer between 1 and 100');
    }
    limits.quality = input.quality;
  }
  if (input.maxWidth !== undefined) {
    if (!Number.isSafeInteger(input.maxWidth) || input.maxWidth < MIN_DIMENSION || input.maxWidth > MAX_DIMENSION) {
      throw browserError('INVALID_ARGUMENT', `maxWidth must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`);
    }
    limits.maxWidth = input.maxWidth;
  }
  if (input.maxHeight !== undefined) {
    if (!Number.isSafeInteger(input.maxHeight) || input.maxHeight < MIN_DIMENSION || input.maxHeight > MAX_DIMENSION) {
      throw browserError('INVALID_ARGUMENT', `maxHeight must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`);
    }
    limits.maxHeight = input.maxHeight;
  }
  if (input.maxBytes !== undefined) {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > maxFrameBase64Bytes) {
      throw browserError('INVALID_ARGUMENT', `maxBytes must be an integer between 1 and ${maxFrameBase64Bytes}`);
    }
    limits.maxBytes = input.maxBytes;
  } else {
    limits.maxBytes = maxFrameBase64Bytes;
  }
  return limits;
}

export function normalizeControlInput(input, maxFrameBase64Bytes = BROWSER_MAX_FRAME_BASE64_BYTES) {
  if (!isPlainObject(input)) {
    throw browserError('INVALID_ARGUMENT', 'browserControl input must be a plain object');
  }
  const action = input.action;
  if (typeof action !== 'string' || !Object.hasOwn(CONTROL_ACTION_FIELDS, action)) {
    throw browserError('INVALID_ARGUMENT', 'browserControl action is invalid or unsupported');
  }
  rejectUnknownFields(input, ['action', ...CONTROL_ACTION_FIELDS[action]], `browserControl.${action}`);

  assertId(input.botId, 'botId');
  const normalized = { action, botId: input.botId };

  if (input.scopeId !== undefined && input.scopeId !== null) {
    assertId(input.scopeId, 'scopeId');
    normalized.scopeId = input.scopeId;
  }
  if (input.pageId !== undefined && input.pageId !== null) {
    normalized.pageId = normalizePageId(input.pageId);
  }
  if (input.sessionId !== undefined && input.sessionId !== null) {
    normalized.sessionId = assertBoundedString(input.sessionId, 'sessionId', { min: 1, max: 256, maxBytes: 256 }).trim();
  }
  if (input.lease !== undefined && input.lease !== null) {
    normalized.lease = normalizeLeaseToken(input.lease);
  }
  if (input.revision !== undefined && input.revision !== null) {
    normalized.revision = normalizeRevision(input.revision);
  } else if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
    normalized.revision = normalizeRevision(input.expectedRevision, 'expectedRevision');
  }
  if (input.sinceSeq !== undefined && input.sinceSeq !== null) {
    normalized.sinceSeq = normalizeRevision(input.sinceSeq, 'sinceSeq');
  }
  if (input.frameSeq !== undefined && input.frameSeq !== null) {
    normalized.frameSeq = normalizeFrameSeq(input.frameSeq);
  }
  if (input.url !== undefined) {
    normalized.url = assertBoundedString(input.url, 'url', { min: 1, max: MAX_URL_BYTES, maxBytes: MAX_URL_BYTES });
  }
  if (input.force !== undefined) {
    if (typeof input.force !== 'boolean') throw browserError('INVALID_ARGUMENT', 'force must be boolean');
    normalized.force = input.force;
  }
  if (input.preempt !== undefined) {
    if (typeof input.preempt !== 'boolean') throw browserError('INVALID_ARGUMENT', 'preempt must be boolean');
    normalized.preempt = input.preempt;
  }
  if (input.resume !== undefined) {
    if (typeof input.resume !== 'boolean') throw browserError('INVALID_ARGUMENT', 'resume must be boolean');
    normalized.resume = input.resume;
  }
  if (input.ignoreCache !== undefined) {
    if (typeof input.ignoreCache !== 'boolean') throw browserError('INVALID_ARGUMENT', 'ignoreCache must be boolean');
    normalized.ignoreCache = input.ignoreCache;
  }
  if (input.sensitive !== undefined) {
    if (typeof input.sensitive !== 'boolean') throw browserError('INVALID_ARGUMENT', 'sensitive must be boolean');
    normalized.sensitive = input.sensitive;
  }
  if (input.reason !== undefined) {
    normalized.reason = assertBoundedString(input.reason, 'reason', { min: 0, max: 256, maxBytes: 256 });
  }
  if (input.holderLabel !== undefined) {
    const label = normalizeHolderLabel(input.holderLabel);
    if (!label) throw browserError('INVALID_ARGUMENT', 'holderLabel must be a non-empty display label');
    normalized.holderLabel = label;
  }

  if (action === 'navigate' && !normalized.url) {
    throw browserError('INVALID_ARGUMENT', 'navigate requires url');
  }
  if ((action === 'select' || action === 'closeTab') && !normalized.pageId) {
    throw browserError('INVALID_ARGUMENT', `${action} requires pageId`);
  }
  if (action === 'frame') {
    normalized.frameLimits = normalizeFrameLimits(input, maxFrameBase64Bytes);
  }
  if (action === 'input') {
    if (!normalized.pageId) throw browserError('INVALID_ARGUMENT', 'input requires pageId');
    if (normalized.revision === undefined) throw browserError('INVALID_ARGUMENT', 'input requires revision');
    if (!normalized.lease) throw browserError('BROWSER_TAKEOVER_REQUIRED', 'input requires an active human lease token');
    normalized.event = normalizeInputEvent(input.event);
  }

  return normalized;
}

export function normalizeBotSnapshotOptions(input = {}) {
  if (!isPlainObject(input)) {
    throw browserError('INVALID_ARGUMENT', 'snapshot options must be an object');
  }
  rejectUnknownFields(input, ['interactive', 'compact', 'depth', 'selector', 'urls', 'delta', 'full'], 'snapshot');
  const out = {};
  for (const flag of ['interactive', 'compact', 'urls', 'delta', 'full']) {
    if (input[flag] !== undefined) {
      if (typeof input[flag] !== 'boolean') {
        throw browserError('INVALID_ARGUMENT', `snapshot.${flag} must be boolean`);
      }
      out[flag] = input[flag];
    }
  }
  if (out.delta && out.full) {
    throw browserError('INVALID_ARGUMENT', 'snapshot cannot specify both delta and full');
  }
  if (input.depth !== undefined) {
    if (!Number.isSafeInteger(input.depth) || input.depth < 1 || input.depth > 20) {
      throw browserError('INVALID_ARGUMENT', 'snapshot.depth must be an integer between 1 and 20');
    }
    out.depth = input.depth;
  }
  if (input.selector !== undefined) {
    out.selector = assertBoundedString(input.selector, 'snapshot.selector', { min: 1, max: MAX_SELECTOR_CHARS, maxBytes: MAX_SELECTOR_CHARS });
  }
  return out;
}

/**
 * Restricted safe DOM interaction normalizer for Bot tools.
 * Explicitly excludes eval, cookie access, CDP passthrough, and JS wait predicates.
 */
export function normalizeBotActInput(act) {
  if (!isPlainObject(act)) {
    throw browserError('INVALID_ARGUMENT', 'act must be an object');
  }
  if (typeof act.kind !== 'string' || !BROWSER_ACT_KINDS.includes(act.kind)) {
    throw browserError('BROWSER_ACTION_BLOCKED', 'Unsupported or forbidden bot browser action kind');
  }
  switch (act.kind) {
    case 'click':
    case 'dblclick':
    case 'hover': {
      rejectUnknownFields(act, ['kind', 'ref'], `act.${act.kind}`);
      return {
        kind: act.kind,
        ref: assertBoundedString(act.ref, 'act.ref', { min: 1, max: MAX_REF_CHARS, maxBytes: MAX_REF_CHARS }).trim(),
      };
    }
    case 'fill': {
      rejectUnknownFields(act, ['kind', 'ref', 'value'], 'act.fill');
      if (typeof act.value !== 'string' || !act.value.isWellFormed() || act.value.length > MAX_FILL_VALUE_CHARS) {
        throw browserError('INVALID_ARGUMENT', `act.value must be a string of at most ${MAX_FILL_VALUE_CHARS} chars`);
      }
      if (act.value.includes('\u0000')) {
        throw browserError('INVALID_ARGUMENT', 'act.value must not contain NUL bytes');
      }
      return {
        kind: 'fill',
        ref: assertBoundedString(act.ref, 'act.ref', { min: 1, max: MAX_REF_CHARS, maxBytes: MAX_REF_CHARS }).trim(),
        value: act.value,
      };
    }
    case 'select': {
      rejectUnknownFields(act, ['kind', 'ref', 'value'], 'act.select');
      return {
        kind: 'select',
        ref: assertBoundedString(act.ref, 'act.ref', { min: 1, max: MAX_REF_CHARS, maxBytes: MAX_REF_CHARS }).trim(),
        value: assertBoundedString(act.value, 'act.value', { min: 0, max: 512, maxBytes: 1024 }),
      };
    }
    case 'type': {
      rejectUnknownFields(act, ['kind', 'text'], 'act.type');
      if (typeof act.text !== 'string' || !act.text.isWellFormed()
          || act.text.length < 1 || act.text.length > MAX_TEXT_INPUT_CHARS) {
        throw browserError('INVALID_ARGUMENT', `act.text must be a non-empty string of at most ${MAX_TEXT_INPUT_CHARS} chars`);
      }
      if (act.text.includes('\u0000')) {
        throw browserError('INVALID_ARGUMENT', 'act.text must not contain NUL bytes');
      }
      return { kind: 'type', text: act.text };
    }
    case 'scroll': {
      rejectUnknownFields(act, ['kind', 'direction', 'amount'], 'act.scroll');
      if (!ALLOWED_SCROLL_DIRECTIONS.has(act.direction)) {
        throw browserError('INVALID_ARGUMENT', 'act.direction must be up, down, left, or right');
      }
      const normalized = { kind: 'scroll', direction: act.direction };
      if (act.amount !== undefined) {
        if (typeof act.amount !== 'number' || !Number.isFinite(act.amount) || act.amount < 1 || act.amount > 4000) {
          throw browserError('INVALID_ARGUMENT', 'act.amount must be a number between 1 and 4000');
        }
        normalized.amount = Math.round(act.amount);
      }
      return normalized;
    }
    case 'press': {
      rejectUnknownFields(act, ['kind', 'key', 'modifiers'], 'act.press');
      const normalized = { kind: 'press', key: assertKeyName(act.key, 'act.key') };
      const modifiers = normalizeModifiers(act.modifiers);
      if (modifiers !== undefined && modifiers.length > 0) {
        normalized.modifiers = modifiers;
      }
      return normalized;
    }
    case 'wait': {
      // Explicitly NO `fn` / arbitrary JS predicate allowed.
      rejectUnknownFields(act, ['kind', 'selector', 'text', 'url', 'load', 'state', 'timeoutMs'], 'act.wait');
      const normalized = { kind: 'wait' };
      if (act.selector !== undefined) {
        normalized.selector = assertBoundedString(act.selector, 'act.selector', { min: 1, max: MAX_SELECTOR_CHARS, maxBytes: MAX_SELECTOR_CHARS });
      }
      if (act.text !== undefined) {
        normalized.text = assertBoundedString(act.text, 'act.text', { min: 1, max: 256, maxBytes: 512 });
      }
      if (act.url !== undefined) {
        normalized.url = assertBoundedString(act.url, 'act.url', { min: 1, max: 512, maxBytes: 512 });
      }
      if (act.load !== undefined) {
        if (!ALLOWED_WAIT_LOAD_STATES.has(act.load)) {
          throw browserError('INVALID_ARGUMENT', 'act.load must be load, domcontentloaded, or networkidle');
        }
        normalized.load = act.load;
      }
      if (act.state !== undefined) {
        if (!ALLOWED_WAIT_ELEMENT_STATES.has(act.state)) {
          throw browserError('INVALID_ARGUMENT', 'act.state must be visible or hidden');
        }
        normalized.state = act.state;
      }
      if (act.timeoutMs !== undefined) {
        if (!Number.isSafeInteger(act.timeoutMs) || act.timeoutMs < 50 || act.timeoutMs > MAX_WAIT_TIMEOUT_MS) {
          throw browserError('INVALID_ARGUMENT', `act.timeoutMs must be an integer between 50 and ${MAX_WAIT_TIMEOUT_MS}`);
        }
        normalized.timeoutMs = act.timeoutMs;
      }
      return normalized;
    }
    default:
      throw browserError('BROWSER_ACTION_BLOCKED', 'Unsupported bot browser action kind');
  }
}

function verifyImageMagic(buffer, mimeType) {
  if (mimeType === 'image/png') {
    return buffer.length >= 24 && PNG_SIGNATURE.every((byte, idx) => buffer[idx] === byte);
  }
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

/** Validates a provider-returned frame before sending over trusted control or vision tool channels. */
export function validateFramePayload(frame, maxBytes = BROWSER_MAX_FRAME_BASE64_BYTES) {
  if (!isPlainObject(frame)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Provider returned invalid frame payload');
  }
  if (typeof frame.mimeType !== 'string' || !ALLOWED_FRAME_MIMES.has(frame.mimeType)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Provider returned unsupported frame mimeType');
  }
  if (typeof frame.data !== 'string' || frame.data.length === 0) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Provider returned empty frame data');
  }
  if (frame.data.length > maxBytes) {
    throw browserError('BROWSER_FRAME_TOO_LARGE', `Frame exceeds ${Math.round(maxBytes / 1024)} KiB base64 limit`);
  }
  if (frame.data.length % 4 !== 0 || !BASE64_RE.test(frame.data)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Provider returned malformed base64 frame');
  }
  const buffer = Buffer.from(frame.data, 'base64');
  if (!verifyImageMagic(buffer, frame.mimeType)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Frame bytes do not match declared image mimeType');
  }
  if (!Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > MAX_DIMENSION) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Frame width is invalid');
  }
  if (!Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > MAX_DIMENSION) {
    throw browserError('BROWSER_BACKEND_FAILED', 'Frame height is invalid');
  }
  const pageId = frame.pageId === undefined ? null : normalizePageId(frame.pageId, 'frame.pageId');
  return {
    mimeType: frame.mimeType,
    data: frame.data,
    width: frame.width,
    height: frame.height,
    pageId,
    url: typeof frame.url === 'string' ? frame.url : undefined,
    title: typeof frame.title === 'string' ? frame.title : undefined,
    documentGeneration: frame.documentGeneration,
    sensitive: frame.sensitive === true,
    hints: isPlainObject(frame.hints) ? frame.hints : undefined,
  };
}

export function normalizeTabs(rawTabs, maxTabs = BROWSER_MAX_TABS_PER_BOT) {
  if (!Array.isArray(rawTabs)) return [];
  const tabs = [];
  const seen = new Set();
  for (const item of rawTabs) {
    if (tabs.length >= maxTabs) break;
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id.trim() === '') continue;
    const id = item.id.trim().slice(0, MAX_PAGE_ID_BYTES);
    if (seen.has(id)) continue;
    seen.add(id);
    const title = typeof item.title === 'string' && item.title.isWellFormed()
      ? item.title.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, MAX_TITLE_CHARS)
      : '';
    const url = typeof item.url === 'string' && item.url.isWellFormed()
      ? item.url.slice(0, MAX_URL_BYTES)
      : '';
    tabs.push({ id, title, url });
  }
  return tabs;
}
