// host-core/browser-setup-protocol.js
// Unified boundary normalizers and error sanitizers for authenticated owner
// browserControl and googleSetupControl volatile RPCs.
// Delegates directly to host-core/bot-browser/protocol.js and
// host-core/google-setup/errors.js so wire validation, HTTP routes, local/remote
// control adapters, and the real Host services stay strictly in sync.

import { assertId, messageError } from './message-protocol.js';
import {
  BROWSER_CONTROL_ACTIONS,
  BROWSER_ERROR_CODES as RAW_BROWSER_ERROR_CODES,
  BROWSER_MAX_FRAME_BASE64_BYTES,
  normalizeControlInput,
  safeBrowserError,
} from './bot-browser/protocol.js';
import {
  assertNoSecretMaterial,
  SETUP_ERROR_CODES as RAW_SETUP_ERROR_CODES,
  SETUP_ERROR_CODE_SET,
} from './google-setup/errors.js';

export { BROWSER_CONTROL_ACTIONS };

export const GOOGLE_SETUP_ACTIONS = Object.freeze([
  'status',
  'start',
  'answer',
  'advance',
  'cancel',
  'resume',
]);

// Domain-specific error codes added to CONTROL_ERROR_CODES / LOCAL_DOMAIN_CODES.
export const BROWSER_ERROR_CODES = Object.freeze(
  RAW_BROWSER_ERROR_CODES.filter((code) => code.startsWith('BROWSER_')),
);
export const SETUP_ERROR_CODES = Object.freeze(
  RAW_SETUP_ERROR_CODES.filter((code) => code.startsWith('SETUP_')),
);
export const GOOGLE_SETUP_ERROR_CODES = SETUP_ERROR_CODES;
export const BROWSER_SETUP_ERROR_CODES = Object.freeze([
  ...new Set([...BROWSER_ERROR_CODES, ...SETUP_ERROR_CODES]),
]);

const MAX_ID_FIELD_BYTES = 256;
const MAX_LABEL_BYTES = 128;
const MAX_NOTE_BYTES = 500;
const MAX_PROJECT_ID_BYTES = 128;
const MAX_ACCOUNT_BYTES = 320;
const MAX_MODE_BYTES = 64;
const MAX_VALUES_COUNT = 20;
const MAX_SERVICES_COUNT = 16;

const WIRE_BROWSER_FIELDS = Object.freeze({
  status: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease']),
  open: new Set(['action', 'botId', 'scopeId', 'pageId', 'revision', 'url', 'lease']),
  navigate: new Set(['action', 'botId', 'scopeId', 'pageId', 'url', 'lease', 'revision']),
  back: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision']),
  forward: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision']),
  reload: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision', 'ignoreCache']),
  select: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision']),
  closeTab: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision']),
  frame: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision', 'format', 'quality', 'maxWidth', 'maxHeight', 'maxBytes']),
  takeover: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision', 'force', 'preempt', 'resume', 'holderLabel']),
  input: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision', 'frameSeq', 'event']),
  handback: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision']),
  release: new Set(['action', 'botId', 'scopeId', 'pageId', 'lease', 'revision', 'force', 'preempt']),
});

// Wire fields accepted for googleSetupControl (union of google-setup/service.js
// native fields and GoogleSetupWizard.tsx / GoogleChatCards.tsx payloads).
const WIRE_SETUP_FIELDS = Object.freeze({
  status: new Set(['action', 'botId', 'scopeId', 'fresh']),
  start: new Set([
    'action', 'botId', 'scopeId', 'fresh', 'mode', 'choices', 'services',
    'browserPageId', 'restart', 'reconfigureClient',
  ]),
  answer: new Set([
    'action', 'botId', 'scopeId', 'fresh', 'runId', 'revision', 'expectedRevision',
    'card', 'values', 'step', 'cardCopy', 'field', 'value', 'actionId',
  ]),
  advance: new Set([
    'action', 'botId', 'scopeId', 'fresh', 'runId', 'revision', 'expectedRevision',
    'card', 'cardCopy', 'step', 'mode', 'choices', 'services', 'account', 'kind',
    'projectId', 'note',
  ]),
  cancel: new Set([
    'action', 'botId', 'scopeId', 'fresh', 'runId', 'revision', 'expectedRevision',
    'card', 'step', 'cardCopy', 'reason',
  ]),
  resume: new Set([
    'action', 'botId', 'scopeId', 'fresh', 'runId', 'revision', 'expectedRevision',
    'card', 'step', 'cardCopy', 'mode',
  ]),
});

const FORBIDDEN_IDENTITY_OR_SECRET_KEYS = new Set([
  'authority',
  'actor',
  'caller',
  'callerid',
  'clientid',
  'fromdeviceid',
  'trusted',
  'trustedowner',
  'owner',
  'role',
  'principalid',
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

const SETUP_SAFE_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid Google setup request.',
  UNAUTHORIZED: 'Control authentication failed.',
  ORIGIN_FORBIDDEN: 'Request origin is not permitted.',
  BOT_NOT_FOUND: 'Bot was not found on this host.',
  BOT_ARCHIVED: 'Bot is archived and read-only.',
  BOT_CONTEXT_REQUIRED: 'Conversation bot ownership could not be verified.',
  FORBIDDEN: 'Action is not permitted.',
  RUNTIME_BUSY: 'Host is preparing an update.',
  CANCELLED: 'Request was cancelled.',
  CENTER_OFFLINE: 'Center is offline.',
  SCOPE_NOT_FOUND: 'Scope was not found.',
  SCOPE_FORBIDDEN: 'Scope access is not permitted.',
  WORK_CONTEXT_NOT_FOUND: 'Work context was not found.',
  STORE_FAILED: 'Failed to persist Google setup progress.',
  SETUP_FORBIDDEN: 'Google setup control requires authenticated owner authority.',
  SETUP_NOT_RUNNING: 'Google setup is not currently running for this bot.',
  SETUP_ADMIN_REQUIRED: 'Center Google Web OAuth application must be configured by a Center administrator.',
  SETUP_MODE_UNAVAILABLE: 'Requested Google setup mode is unavailable on this host.',
  SETUP_REVISION_CONFLICT: 'Google setup state changed; refresh and try again.',
  SETUP_STALE_CARD: 'This Google setup card is outdated; use the latest card.',
  SETUP_SENSITIVE_LOCKED: 'This Google setup step is locked for direct owner completion.',
  SETUP_CENTER_UNAVAILABLE: 'Center Google status is currently unreachable.',
  SETUP_NOT_READY: 'Google setup is not ready to finish; verify Center account and service readiness.',
  SETUP_SECRET_REJECTED: 'Credentials, OAuth tokens, and callback URLs must not be submitted through setup control.',
  SETUP_CLOSED: 'Google setup service is closed.',
});

const BROWSER_EXTRA_PASSTHROUGH = Object.freeze({
  UNAUTHORIZED: 'Control authentication failed.',
  ORIGIN_FORBIDDEN: 'Request origin is not permitted.',
  BOT_ARCHIVED: 'Bot is archived and read-only.',
  FORBIDDEN: 'Action is not permitted.',
  CENTER_OFFLINE: 'Center is offline.',
  SCOPE_NOT_FOUND: 'Scope was not found.',
  SCOPE_FORBIDDEN: 'Scope access is not permitted.',
  WORK_CONTEXT_NOT_FOUND: 'Work context was not found.',
});

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownOrForbiddenFields(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_IDENTITY_OR_SECRET_KEYS.has(key.toLowerCase()) || !allowed.has(key)) {
      throw invalid(`${label} has unsupported field`);
    }
  }
}

function assertBoundedString(value, name, maxBytes, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw invalid(`${name} must be a well-formed string`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw invalid(`${name} must be non-empty`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
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

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw invalid(`${name} must be a boolean`);
  }
  return value;
}

function assertStringArray(value, name, maxItems, maxItemBytes) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw invalid(`${name} must be a non-empty array of at most ${maxItems} strings`);
  }
  return value.map((item) => assertBoundedString(item, `${name}[]`, maxItemBytes));
}

/**
 * Normalize and strictly validate owner browserControl params across wire & HTTP.
 * Delegates core action/input validation to bot-browser/protocol.js so both sides
 * agree on coordinates, keys, modifiers, frame limits, and forbidden fields.
 */
export function normalizeBrowserControl(input, maxFrameBase64Bytes = BROWSER_MAX_FRAME_BASE64_BYTES) {
  if (!isPlainObject(input)) {
    throw invalid('browserControl params must be a plain object');
  }
  const action = input.action;
  if (typeof action !== 'string' || !Object.hasOwn(WIRE_BROWSER_FIELDS, action)) {
    throw invalid('browserControl action is unsupported');
  }
  rejectUnknownOrForbiddenFields(input, WIRE_BROWSER_FIELDS[action], `browserControl.${action}`);

  // Keep the control wire flat across broker, relay and Host; frameLimits is service-internal.
  const { frameLimits, ...wire } = normalizeControlInput(input, maxFrameBase64Bytes);
  return frameLimits ? { ...wire, ...frameLimits } : wire;
}

/**
 * Normalize and strictly validate owner googleSetupControl params across wire & HTTP.
 * Rejects secrets, OAuth callback URLs, tokens, and any authority/clientId spoofing.
 */
export function normalizeGoogleSetupControl(input) {
  if (!isPlainObject(input)) {
    throw invalid('googleSetupControl params must be a plain object');
  }
  const action = input.action;
  if (typeof action !== 'string' || !Object.hasOwn(WIRE_SETUP_FIELDS, action)) {
    throw invalid('googleSetupControl action is unsupported');
  }
  rejectUnknownOrForbiddenFields(input, WIRE_SETUP_FIELDS[action], `googleSetupControl.${action}`);
  assertNoSecretMaterial(input, 'googleSetupControl');
  assertId(input.botId, 'botId');

  const out = { action, botId: input.botId };
  if (input.scopeId !== undefined && input.scopeId !== null) {
    assertId(input.scopeId, 'scopeId');
    out.scopeId = input.scopeId;
  }
  for (const flag of ['fresh', 'restart', 'reconfigureClient']) {
    if (input[flag] !== undefined) out[flag] = assertBoolean(input[flag], flag);
  }
  for (const intField of ['revision', 'expectedRevision', 'cardCopy']) {
    if (input[intField] !== undefined) out[intField] = assertNonNegativeInt(input[intField], intField);
  }
  const boundedStrings = [
    ['runId', MAX_ID_FIELD_BYTES],
    ['mode', MAX_MODE_BYTES],
    ['card', MAX_MODE_BYTES],
    ['step', MAX_MODE_BYTES],
    ['field', MAX_MODE_BYTES],
    ['actionId', MAX_LABEL_BYTES],
    ['kind', MAX_MODE_BYTES],
    ['projectId', MAX_PROJECT_ID_BYTES],
    ['account', MAX_ACCOUNT_BYTES],
    ['browserPageId', MAX_ID_FIELD_BYTES],
    ['note', MAX_NOTE_BYTES],
  ];
  for (const [field, maxBytes] of boundedStrings) {
    if (input[field] !== undefined) {
      out[field] = assertBoundedString(input[field], field, maxBytes);
    }
  }
  if (input.reason !== undefined) {
    out.reason = assertBoundedString(input.reason, 'reason', MAX_NOTE_BYTES, { allowEmpty: true });
  }
  if (input.choices !== undefined) {
    out.choices = [...new Set(assertStringArray(input.choices, 'choices', MAX_SERVICES_COUNT, MAX_MODE_BYTES))];
  }
  if (input.services !== undefined) {
    out.services = [...new Set(assertStringArray(input.services, 'services', MAX_SERVICES_COUNT, MAX_MODE_BYTES))];
  }
  if (input.values !== undefined) {
    out.values = assertStringArray(input.values, 'values', MAX_VALUES_COUNT, MAX_ACCOUNT_BYTES);
  }
  if (input.value !== undefined) {
    if (typeof input.value === 'string') {
      out.value = assertBoundedString(input.value, 'value', MAX_ACCOUNT_BYTES);
    } else if (Array.isArray(input.value)) {
      out.value = assertStringArray(input.value, 'value', MAX_VALUES_COUNT, MAX_ACCOUNT_BYTES);
    } else {
      throw invalid('value must be a non-empty string or array of strings');
    }
  }
  return out;
}

/**
 * Translate normalized wire googleSetupControl payload into the exact input
 * expected by host-core/google-setup/service.js `control()`.
 * Supports both native `{ card, values, expectedRevision }` and UI shorthands
 * (`{ revision }`, `{ field: 'mode', value }`, `{ actionId, step }`).
 */
export function projectGoogleSetupControlForService(normalized) {
  const serviceInput = { ...normalized };
  delete serviceInput.scopeId;

  if (serviceInput.expectedRevision === undefined && serviceInput.revision !== undefined) {
    serviceInput.expectedRevision = serviceInput.revision;
  }
  delete serviceInput.revision;

  if (serviceInput.action === 'answer' && serviceInput.card === undefined) {
    if (serviceInput.field === 'mode' && typeof serviceInput.value === 'string') {
      serviceInput.card = 'path';
      serviceInput.values = [serviceInput.value];
    } else if (
      (serviceInput.field === 'services' || serviceInput.field === 'choices') &&
      Array.isArray(serviceInput.value)
    ) {
      serviceInput.card = 'services';
      serviceInput.values = serviceInput.value;
    } else if (serviceInput.field === 'account' && typeof serviceInput.value === 'string') {
      serviceInput.card = 'account';
      serviceInput.values = [serviceInput.value];
    } else if (typeof serviceInput.actionId === 'string') {
      serviceInput.card = 'step';
      serviceInput.values = serviceInput.step
        ? [serviceInput.actionId, serviceInput.step]
        : [serviceInput.actionId];
    }
  }
  delete serviceInput.field;
  delete serviceInput.value;
  delete serviceInput.actionId;

  return serviceInput;
}

export function browserControlError(code) {
  if (Object.hasOwn(BROWSER_EXTRA_PASSTHROUGH, code)) {
    return messageError(code, BROWSER_EXTRA_PASSTHROUGH[code]);
  }
  return safeBrowserError({ code }, 'BROWSER_UNAVAILABLE');
}

export function safeBrowserControlError(error) {
  if (error?.name === 'AbortError') return browserControlError('CANCELLED');
  if (typeof error?.code === 'string' && Object.hasOwn(BROWSER_EXTRA_PASSTHROUGH, error.code)) {
    return messageError(error.code, BROWSER_EXTRA_PASSTHROUGH[error.code]);
  }
  return safeBrowserError(error, 'BROWSER_UNAVAILABLE');
}

export function googleSetupError(code) {
  const safeCode = Object.hasOwn(SETUP_SAFE_MESSAGES, code)
    ? code
    : (SETUP_ERROR_CODE_SET.has(code) ? code : 'SETUP_CENTER_UNAVAILABLE');
  return messageError(safeCode, SETUP_SAFE_MESSAGES[safeCode] ?? 'Google setup request failed.');
}

export function safeGoogleSetupError(error) {
  if (error?.name === 'AbortError') return googleSetupError('CANCELLED');
  return googleSetupError(error?.code);
}
