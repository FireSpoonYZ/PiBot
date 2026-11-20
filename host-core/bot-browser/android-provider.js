// host-core/bot-browser/android-provider.js
// Android native Bot Browser provider. Routes strictly through the private
// Node Mobile -> Java native bridge tool `bot_browser` backed by per-Bot
// WebView multi-profile isolation (never shares the App UI WebView or Default
// profile, never runs Electron, and honestly reports unavailable with external
// system-browser guidance on devices without WebViewFeature.MULTI_PROFILE).
import { randomUUID } from 'node:crypto';
import { assertId, messageError } from '../message-protocol.js';
import { ANDROID_BROWSER_ERROR_CODES } from '../android-bridge-protocol.js';
import { BROWSER_MAX_SNAPSHOT_TEXT_BYTES, normalizeProviderWait } from './protocol.js';
import {
  checkBotActionSensitivity,
  classifyPageSensitivity,
  containsSecretLeak,
  sanitizeUrlForModel,
} from './policy.js';

export { ANDROID_BROWSER_ERROR_CODES };

export const ANDROID_BROWSER_PLATFORM = 'android';
export const ANDROID_BROWSER_MAX_URL_LENGTH = 4096;
export const ANDROID_BROWSER_MAX_TEXT_LENGTH = 2048;
export const ANDROID_BROWSER_MAX_FRAME_WIDTH = 1280;
export const ANDROID_BROWSER_MAX_FRAME_HEIGHT = 800;
export const ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES = 512 * 1024;
export const ANDROID_BROWSER_MAX_WHEEL_DELTA = 2000;
export const ANDROID_BROWSER_MAX_WAIT_MS = 15_000;

export const ANDROID_BROWSER_MAX_SNAPSHOT_REFS = 80;
export const ANDROID_BROWSER_MAX_SNAPSHOT_TEXT_BYTES = Math.min(24_576, BROWSER_MAX_SNAPSHOT_TEXT_BYTES);
export const ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS = 4096;

const NATIVE_TOOL = 'bot_browser';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const REF_RE = /^e[1-9][0-9]{0,2}$/;
const SYNTHETIC_TASK_ID_RE = /^(human|agent):[0-9a-fA-F-]{8,64}$/;
const ANDROID_SECRET_LEAK_RE = /\bGOCSPX-[A-Za-z0-9_-]{8,}\b/;
const INLINE_URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const SENSITIVE_EXACT_QUERY_KEYS = new Set(['code', 'state', 'pwd', 'key', 'sig']);
const SENSITIVE_QUERY_KEY_RE = /(?:secret|token|password|passwd|apikey|api[_-]?key|private[_-]?key|auth(?:$|[_-]|oriz|entic|token|code|key)|credential|cookie|session(?:$|[_-]|id)|signature|jwt|bearer|oauth)/i;
const MAX_SNAPSHOT_ROLE_CHARS = 32;
const MAX_SNAPSHOT_AUTOCOMPLETE_CHARS = 64;
const MAX_SNAPSHOT_NAME_CHARS = 80;
const MAX_SNAPSHOT_PLACEHOLDER_CHARS = 100;
const MAX_SNAPSHOT_LABEL_CHARS = 160;
const MAX_SNAPSHOT_TITLE_CHARS = 300;
const MAX_SNAPSHOT_HREF_CHARS = 512;
const MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const SOURCES = new Set(['agent', 'human']);
const BROWSER_ERROR_SET = new Set(ANDROID_BROWSER_ERROR_CODES);
const ALLOWED_ACTIONS = new Set([
  'status',
  'open',
  'navigate',
  'back',
  'forward',
  'reload',
  'select',
  'closeTab',
  'frame',
  'snapshot',
  'act',
  'input',
  'release',
]);
const ALLOWED_ACT_KINDS = new Set([
  'click',
  'fill',
  'type',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'wait',
]);
const ALLOWED_INPUT_KINDS = new Set(['click', 'text', 'key', 'wheel']);
const ALLOWED_KEYS = new Set([
  'ENTER', 'RETURN', 'TAB', 'ESCAPE', 'ESC', 'SPACE', ' ',
  'BACKSPACE', 'DELETE',
  'ARROWLEFT', 'LEFT', 'ARROWRIGHT', 'RIGHT', 'ARROWUP', 'UP', 'ARROWDOWN', 'DOWN',
  'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
]);

const NATIVE_CODE_MAP = new Map([
  ['ANDROID_NATIVE_UNAVAILABLE', 'BROWSER_UNAVAILABLE'],
  ['ANDROID_NATIVE_BUSY', 'BROWSER_BUSY'],
  ['ANDROID_NATIVE_UNCONFIRMED', 'BROWSER_ACTION_UNCONFIRMED'],
  ['ANDROID_NATIVE_ERROR', 'BROWSER_BACKEND_FAILED'],
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlChars(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function clampInt(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function browserError(code, message, extra = {}) {
  const err = messageError(code, message);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) err[k] = v;
  }
  return err;
}

/**
 * Validate and classify a target URL on the JS boundary (mirrored authoritatively
 * in Java BotBrowserPolicy and WebViewClient.shouldOverrideUrlLoading).
 */
export function classifyAndroidBrowserUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.isWellFormed()) {
    throw browserError('INVALID_ARGUMENT', 'url must be a well-formed string');
  }
  const trimmed = rawUrl.trim();
  if (trimmed === '' || trimmed.length > ANDROID_BROWSER_MAX_URL_LENGTH || hasControlChars(trimmed)) {
    throw browserError('BROWSER_NAVIGATION_BLOCKED', 'URL is empty, oversized, or contains control characters');
  }
  if (trimmed.toLowerCase() === 'about:blank') {
    return { canonicalUrl: 'about:blank', sensitivity: 'normal', reason: null };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw browserError('BROWSER_NAVIGATION_BLOCKED', 'Malformed URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw browserError('BROWSER_NAVIGATION_BLOCKED', 'Only http and https URLs are allowed in Bot browser');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw browserError('BROWSER_NAVIGATION_BLOCKED', 'URLs with embedded credentials are not allowed');
  }
  if (!parsed.hostname) {
    throw browserError('BROWSER_NAVIGATION_BLOCKED', 'URL must specify a valid host');
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host === 'accounts.google.com' || host.endsWith('.accounts.google.com')) {
    return {
      canonicalUrl: trimmed,
      sensitivity: 'blocked_external_auth',
      reason: 'google_auth_requires_system_browser',
    };
  }
  if (path.includes('/api/oauth/google/callback')) {
    return {
      canonicalUrl: trimmed,
      sensitivity: 'blocked_external_auth',
      reason: 'oauth_callback_requires_system_browser',
    };
  }
  if ((host === 'google.com' || host.endsWith('.google.com'))
    && (path.startsWith('/o/oauth2/') || path.startsWith('/signin/oauth') || path.startsWith('/o/openid2/'))) {
    return {
      canonicalUrl: trimmed,
      sensitivity: 'blocked_external_auth',
      reason: 'google_oauth_requires_system_browser',
    };
  }
  if (host === 'myaccount.google.com' || host.endsWith('.myaccount.google.com') || host === 'gds.google.com') {
    return {
      canonicalUrl: trimmed,
      sensitivity: 'secret_shield',
      reason: 'google_account_security_shield',
    };
  }
  if (host === 'console.cloud.google.com') {
    if (!path.includes('/auth/clients/create')
      && !path.includes('/apis/credentials/oauthclient')
      && (path.includes('/auth/clients/')
        || (path.includes('/iam-admin/serviceaccounts/details/') && path.includes('/keys'))
        || path.includes('/billing/pay'))) {
      return {
        canonicalUrl: trimmed,
        sensitivity: 'secret_shield',
        reason: 'cloud_console_secret_or_billing_shield',
      };
    }
  }
  return { canonicalUrl: trimmed, sensitivity: 'normal', reason: null };
}

/**
 * Validate and normalize a human takeover input event:
 * `{ kind: 'click'|'text'|'key'|'wheel', x?, y?, text?, key?, deltaX?, deltaY? }`.
 */
export function normalizeAndroidBrowserInputEvent(event) {
  if (!isPlainObject(event)) {
    throw browserError('INVALID_ARGUMENT', 'input requires an event object');
  }
  const kind = event.kind;
  if (typeof kind !== 'string' || !ALLOWED_INPUT_KINDS.has(kind)) {
    throw browserError('INVALID_ARGUMENT', 'input event.kind must be click, text, key, or wheel');
  }
  if (kind === 'click') {
    if (typeof event.x !== 'number' || !Number.isFinite(event.x) || event.x < 0 || event.x > 1) {
      throw browserError('INVALID_ARGUMENT', 'click event.x must be a finite number in 0..1');
    }
    if (typeof event.y !== 'number' || !Number.isFinite(event.y) || event.y < 0 || event.y > 1) {
      throw browserError('INVALID_ARGUMENT', 'click event.y must be a finite number in 0..1');
    }
    return { kind: 'click', x: event.x, y: event.y };
  }
  if (kind === 'text') {
    if (typeof event.text !== 'string' || !event.text.isWellFormed()
      || event.text.length === 0 || event.text.length > ANDROID_BROWSER_MAX_TEXT_LENGTH
      || event.text.includes('\0')) {
      throw browserError('INVALID_ARGUMENT', 'text event.text must be a bounded non-empty string without NUL');
    }
    return { kind: 'text', text: event.text };
  }
  if (kind === 'key') {
    if (typeof event.key !== 'string' || event.key.length === 0) {
      throw browserError('INVALID_ARGUMENT', 'key event.key must be a non-empty string');
    }
    const normalized = event.key === ' ' ? ' ' : event.key.trim().toUpperCase();
    if (!ALLOWED_KEYS.has(normalized)) {
      throw browserError('INVALID_ARGUMENT', `unsupported key: ${event.key}`);
    }
    return { kind: 'key', key: normalized };
  }
  // wheel
  const out = {
    kind: 'wheel',
    deltaX: clampInt(event.deltaX ?? 0, 0, -ANDROID_BROWSER_MAX_WHEEL_DELTA, ANDROID_BROWSER_MAX_WHEEL_DELTA),
    deltaY: clampInt(event.deltaY ?? 0, 0, -ANDROID_BROWSER_MAX_WHEEL_DELTA, ANDROID_BROWSER_MAX_WHEEL_DELTA),
  };
  if (event.x !== undefined) {
    if (typeof event.x !== 'number' || !Number.isFinite(event.x) || event.x < 0 || event.x > 1) {
      throw browserError('INVALID_ARGUMENT', 'wheel event.x must be in 0..1');
    }
    out.x = event.x;
  }
  if (event.y !== undefined) {
    if (typeof event.y !== 'number' || !Number.isFinite(event.y) || event.y < 0 || event.y > 1) {
      throw browserError('INVALID_ARGUMENT', 'wheel event.y must be in 0..1');
    }
    out.y = event.y;
  }
  return out;
}

/**
 * Validate and normalize a constrained Bot DOM action (no arbitrary eval,
 * no cookies, no CDP passthrough).
 */
export function normalizeAndroidBrowserAct(act) {
  if (!isPlainObject(act)) {
    throw browserError('INVALID_ARGUMENT', 'act requires an action object');
  }
  const kind = act.kind;
  if (typeof kind !== 'string' || !ALLOWED_ACT_KINDS.has(kind)) {
    throw browserError('INVALID_ARGUMENT', 'unsupported act.kind');
  }
  const out = { kind };
  if (kind === 'wait') return normalizeProviderWait(act, 300);

  const needsRef = kind === 'click' || kind === 'fill'
    || kind === 'select' || kind === 'check' || kind === 'uncheck';
  if (needsRef || (act.ref !== undefined && act.ref !== null && act.ref !== '')) {
    if (typeof act.ref !== 'string' || !REF_RE.test(act.ref)) {
      throw browserError('INVALID_ARGUMENT', 'act.ref must be a valid snapshot element ref (e.g. e1)');
    }
    out.ref = act.ref;
  }
  if (kind === 'fill') {
    const text = act.text ?? act.value ?? '';
    if (typeof text !== 'string' || !text.isWellFormed()
      || text.length > ANDROID_BROWSER_MAX_TEXT_LENGTH || text.includes('\0')) {
      throw browserError('INVALID_ARGUMENT', 'act text must be a bounded string without NUL');
    }
    out.text = text;
  } else if (kind === 'type') {
    const text = act.text ?? act.value;
    if (typeof text !== 'string' || !text.isWellFormed()
      || text.length === 0 || text.length > ANDROID_BROWSER_MAX_TEXT_LENGTH || text.includes('\0')) {
      throw browserError('INVALID_ARGUMENT', 'type act requires a non-empty bounded string without NUL');
    }
    out.text = text;
  } else if (kind === 'select') {
    const value = act.value ?? act.text;
    if (typeof value !== 'string' || !value.isWellFormed()
      || value.length > ANDROID_BROWSER_MAX_TEXT_LENGTH || value.includes('\0')) {
      throw browserError('INVALID_ARGUMENT', 'select act requires a bounded string value');
    }
    out.value = value;
  } else if (kind === 'press') {
    if (typeof act.key !== 'string' || act.key.length === 0) {
      throw browserError('INVALID_ARGUMENT', 'press act requires a key');
    }
    const normalized = act.key === ' ' ? ' ' : act.key.trim().toUpperCase();
    if (!ALLOWED_KEYS.has(normalized)) {
      throw browserError('INVALID_ARGUMENT', `unsupported key: ${act.key}`);
    }
    out.key = normalized;
  } else if (kind === 'scroll') {
    out.deltaX = clampInt(act.deltaX ?? 0, 0, -ANDROID_BROWSER_MAX_WHEEL_DELTA, ANDROID_BROWSER_MAX_WHEEL_DELTA);
    out.deltaY = clampInt(act.deltaY ?? 0, 0, -ANDROID_BROWSER_MAX_WHEEL_DELTA, ANDROID_BROWSER_MAX_WHEEL_DELTA);
  }
  return out;
}

function normalizeFrameLimits(limits) {
  if (limits === undefined || limits === null) {
    return {
      maxWidth: 960,
      maxHeight: 640,
      maxBytes: ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES,
      mimeType: 'image/jpeg',
    };
  }
  if (!isPlainObject(limits)) {
    throw browserError('INVALID_ARGUMENT', 'frame limits must be an object');
  }
  const mimeType = limits.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  return {
    maxWidth: clampInt(limits.maxWidth ?? 960, 960, 320, ANDROID_BROWSER_MAX_FRAME_WIDTH),
    maxHeight: clampInt(limits.maxHeight ?? 640, 640, 320, ANDROID_BROWSER_MAX_FRAME_HEIGHT),
    maxBytes: clampInt(
      limits.maxBytes ?? ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES,
      ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES,
      16 * 1024,
      ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES,
    ),
    mimeType,
  };
}

function unavailableDto(reason) {
  return {
    available: false,
    reason,
    canStreamInteract: false,
    platform: ANDROID_BROWSER_PLATFORM,
    profileIsolation: 'unavailable',
    fallbackMode: 'guide-browser',
    externalBrowserRecommendedForSetup: true,
    sessionId: null,
    pageId: null,
    revision: 0,
    tabs: [],
    sensitive: false,
    requiresSystemBrowser: true,
    requiresHumanTakeover: false,
  };
}

function sanitizeTabs(rawTabs) {
  if (!Array.isArray(rawTabs)) return [];
  const tabs = [];
  for (const item of rawTabs) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '') continue;
    tabs.push({
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : 'about:blank',
      ...(typeof item.loading === 'boolean' ? { loading: item.loading } : {}),
      ...(typeof item.sensitive === 'boolean' ? { sensitive: item.sensitive } : {}),
      ...(item.crashed === true ? { crashed: true } : {}),
    });
  }
  return tabs;
}

function normalizeStatusReply(result) {
  if (!isPlainObject(result)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser reply must be an object');
  }
  const available = result.available === true;
  const canStreamInteract = available && result.canStreamInteract === true;
  const revision = Number.isSafeInteger(result.revision) && result.revision >= 0 ? result.revision : 0;
  const dto = {
    available,
    canStreamInteract,
    platform: ANDROID_BROWSER_PLATFORM,
    profileIsolation: typeof result.profileIsolation === 'string'
      ? result.profileIsolation
      : (available ? 'webview-multi-profile' : 'unavailable'),
    externalBrowserRecommendedForSetup: true,
    sessionId: typeof result.sessionId === 'string' && result.sessionId !== '' ? result.sessionId : null,
    pageId: typeof result.pageId === 'string' && result.pageId !== '' ? result.pageId : null,
    revision,
    tabs: sanitizeTabs(result.tabs),
    sensitive: result.sensitive === true,
    requiresSystemBrowser: result.requiresSystemBrowser === true || !available,
    requiresHumanTakeover: result.requiresHumanTakeover === true,
  };
  if (typeof result.reason === 'string' && result.reason !== '') {
    dto.reason = result.reason;
  }
  if (!available) {
    dto.fallbackMode = typeof result.fallbackMode === 'string' ? result.fallbackMode : 'guide-browser';
  }
  if (typeof result.sensitiveReason === 'string' && result.sensitiveReason !== '') {
    dto.sensitiveReason = result.sensitiveReason;
  }
  if (result.ok === true) {
    dto.ok = true;
  }
  return dto;
}

function normalizeFrameReply(result, limits) {
  if (!isPlainObject(result)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser frame reply must be an object');
  }
  if (!Number.isSafeInteger(result.seq) || result.seq < 1) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser frame missing valid seq');
  }
  if (!MIME_TYPES.has(result.mimeType)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser frame mimeType is invalid');
  }
  if (typeof result.data !== 'string' || result.data === '' || result.data.length % 4 !== 0 || !BASE64_RE.test(result.data)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser frame data is not canonical base64');
  }
  const budget = Math.min(limits.maxBytes, ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES);
  if (result.data.length > budget) {
    throw browserError('BROWSER_FRAME_TOO_LARGE', `frame base64 (${result.data.length}) exceeds ${budget} bytes`);
  }
  if (!Number.isSafeInteger(result.width) || result.width <= 0 || result.width > ANDROID_BROWSER_MAX_FRAME_WIDTH
    || !Number.isSafeInteger(result.height) || result.height <= 0 || result.height > ANDROID_BROWSER_MAX_FRAME_HEIGHT) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser frame has invalid source dimensions');
  }
  if (typeof result.pageId !== 'string' || result.pageId === '') {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser frame missing pageId');
  }
  const revision = Number.isSafeInteger(result.revision) && result.revision >= 0 ? result.revision : 0;
  const frame = {
    seq: result.seq,
    mimeType: result.mimeType,
    data: result.data,
    width: result.width,
    height: result.height,
    revision,
    pageId: result.pageId,
    sensitive: result.sensitive === true,
  };
  if (Number.isSafeInteger(result.imageWidth) && result.imageWidth > 0) frame.imageWidth = result.imageWidth;
  if (Number.isSafeInteger(result.imageHeight) && result.imageHeight > 0) frame.imageHeight = result.imageHeight;
  if (typeof result.sensitiveReason === 'string' && result.sensitiveReason !== '') {
    frame.sensitiveReason = result.sensitiveReason;
  }
  return frame;
}

function hasSnapshotSecretLeak(value) {
  if (typeof value !== 'string' || value === '') return false;
  return containsSecretLeak(value) || ANDROID_SECRET_LEAK_RE.test(value);
}

function sliceCharsSafe(str, maxChars) {
  if (str.length <= maxChars) return str;
  if (maxChars <= 0) return '';
  let end = maxChars;
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return str.slice(0, end);
}

function truncateUtf8(str, maxBytes) {
  if (maxBytes <= 0 || str === '') return '';
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let out = '';
  let bytes = 0;
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

function cleanSingleLine(value, maxChars) {
  if (typeof value !== 'string' || value === '') return '';
  const wellFormed = typeof value.toWellFormed === 'function' ? value.toWellFormed() : value;
  const normalized = wellFormed
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxChars === undefined || normalized.length <= maxChars) return normalized;
  return `${sliceCharsSafe(normalized, Math.max(0, maxChars - 1))}…`;
}

function sanitizeSnapshotUrl(rawUrl, { stripQuery = false, allowRedactedFallback = true } = {}) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (trimmed === '') return '';
  if (trimmed.toLowerCase() === 'about:blank') return 'about:blank';

  const base = sanitizeUrlForModel(trimmed);
  if (base === '' || base === '[redacted-url]') {
    return allowRedactedFallback ? base : '';
  }

  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return '';
  }
  if (stripQuery) {
    return parsed.origin + parsed.pathname;
  }

  const clean = new URL(parsed.origin + parsed.pathname);
  for (const [key, value] of parsed.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_EXACT_QUERY_KEYS.has(lowerKey)
      || SENSITIVE_QUERY_KEY_RE.test(key)
      || hasSnapshotSecretLeak(value)
    ) {
      clean.searchParams.set(key, '[redacted]');
    } else {
      clean.searchParams.append(key, value);
    }
  }
  return clean.href;
}

function sanitizeInlineUrls(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(INLINE_URL_RE, (match) => {
    let trailing = '';
    let candidate = match;
    while (candidate.length > 0 && /[.,;:!?)}\]]$/.test(candidate)) {
      trailing = candidate[candidate.length - 1] + trailing;
      candidate = candidate.slice(0, -1);
    }
    const sanitized = sanitizeSnapshotUrl(candidate, { allowRedactedFallback: true });
    return (sanitized || '[redacted-url]') + trailing;
  });
}

function sanitizeSnapshotHref(rawHref) {
  if (typeof rawHref !== 'string' || rawHref.trim() === '') return '';
  const sanitized = sanitizeSnapshotUrl(rawHref, { allowRedactedFallback: false });
  if (sanitized === '' || sanitized === 'about:blank') return '';
  return sanitized.length <= MAX_SNAPSHOT_HREF_CHARS
    ? sanitized
    : sliceCharsSafe(sanitized, MAX_SNAPSHOT_HREF_CHARS);
}

function sanitizeRect(raw) {
  if (!isPlainObject(raw)) return null;
  const { x, y, width, height } = raw;
  if (
    typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof width !== 'number' || !Number.isFinite(width)
    || typeof height !== 'number' || !Number.isFinite(height)
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0, Math.min(1, width)),
    height: Math.max(0, Math.min(1, height)),
  };
}

function deriveInteractiveRole(explicitRole, tag, rawType) {
  if (explicitRole) return explicitRole;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'input') {
    if (rawType === 'button' || rawType === 'submit' || rawType === 'reset' || rawType === 'image') {
      return 'button';
    }
    if (rawType === 'checkbox') return 'checkbox';
    if (rawType === 'radio') return 'radio';
    if (rawType === 'search') return 'searchbox';
    if (rawType === 'range') return 'slider';
    if (rawType === 'number') return 'spinbutton';
    return 'textbox';
  }
  return tag || 'element';
}

function deriveInputType(rawType, autocomplete) {
  if (rawType === 'password' || autocomplete.includes('password')) return 'password';
  if (autocomplete.includes('one-time-code')) return 'one-time-code';
  if (autocomplete.startsWith('cc-')) return 'credit card';
  return rawType;
}

function inferSnapshotSensitivityMeta({
  secretDetected,
  reason,
  pageSensitivity,
  urlSensitivity,
  requiresHumanTakeover,
}) {
  const lowerReason = typeof reason === 'string' ? reason.toLowerCase() : '';
  if (
    secretDetected
    || pageSensitivity.secretRisk
    || /client_secret|secret_dialog|secret_material|secret_shield/.test(lowerReason)
  ) {
    return {
      sensitiveCategory: 'client_secret',
      hints: {
        ...(secretDetected ? { hasSecretText: true } : {}),
        secretDialogVisible: true,
      },
    };
  }
  if (
    pageSensitivity.oauthOrAuth
    || urlSensitivity === 'blocked_external_auth'
    || /oauth|auth/.test(lowerReason)
  ) {
    return { sensitiveCategory: 'oauth', hints: null };
  }
  if (pageSensitivity.passwordOrOtp || /password|otp|mfa/.test(lowerReason)) {
    return { sensitiveCategory: 'password_input', hints: null };
  }
  if (pageSensitivity.payment || /payment|card|billing/.test(lowerReason)) {
    return { sensitiveCategory: 'payment', hints: null };
  }
  if (requiresHumanTakeover || pageSensitivity.policyConsent || /policy_consent/.test(lowerReason)) {
    return { sensitiveCategory: 'policy_consent', hints: null };
  }
  return { sensitiveCategory: null, hints: null };
}

function normalizeSnapshotReply(result, options = {}) {
  if (!isPlainObject(result)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser snapshot reply must be an object');
  }
  if (typeof result.pageId !== 'string' || result.pageId === '') {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser snapshot missing pageId');
  }

  const interactiveOnly = options.interactiveOnly === true;
  const includeUrls = options.includeUrls === true;
  const revision = Number.isSafeInteger(result.revision) && result.revision >= 0 ? result.revision : 0;
  const rawUrl = typeof result.url === 'string' ? result.url.trim() : '';
  const rawTitle = typeof result.title === 'string' ? result.title : '';
  const rawTextSummary = typeof result.textSummary === 'string' ? result.textSummary : '';
  const rawInteractive = Array.isArray(result.interactive) ? result.interactive : [];
  const rawSensitiveReason = typeof result.sensitiveReason === 'string' && result.sensitiveReason.trim() !== ''
    ? result.sensitiveReason.trim()
    : '';

  let urlSensitivity = 'normal';
  let urlReason = null;
  if (rawUrl !== '') {
    try {
      const checked = classifyAndroidBrowserUrl(rawUrl);
      urlSensitivity = checked.sensitivity;
      urlReason = checked.reason;
    } catch {
      // Malformed / disallowed URL schemes or credentialed URLs are sanitized below.
    }
  }

  let secretDetected = hasSnapshotSecretLeak(rawUrl)
    || hasSnapshotSecretLeak(rawTitle)
    || hasSnapshotSecretLeak(rawTextSummary);
  if (!secretDetected) {
    for (const item of rawInteractive) {
      if (!isPlainObject(item)) continue;
      if (
        hasSnapshotSecretLeak(item.text)
        || hasSnapshotSecretLeak(item.name)
        || hasSnapshotSecretLeak(item.label)
        || hasSnapshotSecretLeak(item.ariaLabel)
        || hasSnapshotSecretLeak(item.placeholder)
        || hasSnapshotSecretLeak(item.value)
        || hasSnapshotSecretLeak(item.href)
      ) {
        secretDetected = true;
        break;
      }
    }
  }

  const pageSensitivity = classifyPageSensitivity({
    url: rawUrl,
    title: rawTitle,
    providerSensitive: result.sensitive === true,
  });

  const withhold =
    secretDetected
    || result.sensitive === true
    || result.requiresSystemBrowser === true
    || urlSensitivity !== 'normal'
    || pageSensitivity.blockBotObserve;

  if (withhold) {
    const safeUrl = rawUrl === '' || hasSnapshotSecretLeak(rawUrl)
      ? 'about:blank'
      : (sanitizeSnapshotUrl(rawUrl, { stripQuery: true }) || 'about:blank');
    const sensitiveReason = secretDetected
      ? 'secret_material_detected'
      : (rawSensitiveReason || urlReason || pageSensitivity.reasons[0] || '');
    const requiresSystemBrowser =
      result.requiresSystemBrowser === true
      || urlSensitivity !== 'normal'
      || pageSensitivity.oauthOrAuth;
    const meta = inferSnapshotSensitivityMeta({
      secretDetected,
      reason: sensitiveReason,
      pageSensitivity,
      urlSensitivity,
      requiresHumanTakeover: result.requiresHumanTakeover === true,
    });
    const out = {
      pageId: result.pageId,
      revision,
      url: safeUrl,
      title: '',
      loading: result.loading === true,
      canGoBack: result.canGoBack === true,
      canGoForward: result.canGoForward === true,
      sensitive: true,
      requiresHumanTakeover: result.requiresHumanTakeover === true,
      requiresSystemBrowser,
      snapshot: '',
      refs: [],
      interactive: [],
      textSummary: '',
      truncated: result.truncated === true,
    };
    if (sensitiveReason !== '') out.sensitiveReason = sensitiveReason;
    if (meta.sensitiveCategory) out.sensitiveCategory = meta.sensitiveCategory;
    if (meta.hints) out.hints = meta.hints;
    return out;
  }

  const safeUrl = rawUrl === ''
    ? 'about:blank'
    : (sanitizeSnapshotUrl(rawUrl) || 'about:blank');
  const safeTitle = cleanSingleLine(sanitizeInlineUrls(rawTitle), MAX_SNAPSHOT_TITLE_CHARS);

  const seenRefs = new Set();
  const refs = [];
  const interactive = [];
  const lines = [];
  let totalBytes = 0;
  let truncated = result.truncated === true;

  for (const item of rawInteractive) {
    if (!isPlainObject(item)) continue;
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    if (!REF_RE.test(ref) || seenRefs.has(ref)) continue;
    if (refs.length >= ANDROID_BROWSER_MAX_SNAPSHOT_REFS) {
      truncated = true;
      break;
    }

    const tag = cleanSingleLine(item.tag, MAX_SNAPSHOT_ROLE_CHARS).toLowerCase();
    const explicitRole = cleanSingleLine(item.role, MAX_SNAPSHOT_ROLE_CHARS).toLowerCase();
    const rawType = cleanSingleLine(item.inputType ?? item.type, MAX_SNAPSHOT_ROLE_CHARS).toLowerCase();
    const autocomplete = cleanSingleLine(item.autocomplete, MAX_SNAPSHOT_AUTOCOMPLETE_CHARS).toLowerCase();
    const role = deriveInteractiveRole(explicitRole, tag, rawType);
    const inputType = deriveInputType(rawType, autocomplete);

    const attrName = cleanSingleLine(sanitizeInlineUrls(item.name), MAX_SNAPSHOT_NAME_CHARS);
    const ariaLabel = cleanSingleLine(sanitizeInlineUrls(item.ariaLabel), MAX_SNAPSHOT_LABEL_CHARS);
    const explicitLabel = cleanSingleLine(sanitizeInlineUrls(item.label), MAX_SNAPSHOT_LABEL_CHARS);
    const text = cleanSingleLine(sanitizeInlineUrls(item.text), MAX_SNAPSHOT_LABEL_CHARS);
    const placeholder = cleanSingleLine(sanitizeInlineUrls(item.placeholder), MAX_SNAPSHOT_PLACEHOLDER_CHARS);
    const displayLabel = ariaLabel || explicitLabel || text || placeholder || attrName;

    const isCheckable =
      role === 'checkbox'
      || role === 'radio'
      || role === 'switch'
      || rawType === 'checkbox'
      || rawType === 'radio';
    const checked = isCheckable && typeof item.checked === 'boolean' ? item.checked : undefined;
    const disabled = item.disabled === true;
    const safeHref = sanitizeSnapshotHref(item.href);
    const rect = sanitizeRect(item.rect);

    const refEntry = {
      ref,
      role,
      name: attrName || displayLabel,
      ...(displayLabel ? { label: displayLabel } : {}),
      ...(text ? { text } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(inputType ? { inputType } : {}),
      ...(checked !== undefined ? { checked } : {}),
      ...(disabled ? { disabled: true } : {}),
    };

    const clickCheck = checkBotActionSensitivity({
      act: { kind: 'click', ref },
      pageUrl: safeUrl,
      pageTitle: safeTitle,
      targetRefMeta: refEntry,
    });
    const fillCheck = (role === 'textbox' || role === 'searchbox' || role === 'combobox' || inputType !== '')
      ? checkBotActionSensitivity({
          act: { kind: 'fill', ref, text: '' },
          pageUrl: safeUrl,
          pageTitle: safeTitle,
          targetRefMeta: refEntry,
        })
      : { allowed: true };
    const humanOnly = !clickCheck.allowed || !fillCheck.allowed;
    if (humanOnly) {
      refEntry.humanOnly = true;
    }

    const parts = [`[${ref}] ${role}`];
    if (displayLabel) parts.push(`"${displayLabel}"`);
    if (includeUrls && safeHref) parts.push(`url="${safeHref}"`);
    if (checked !== undefined) parts.push(checked ? '[checked]' : '[unchecked]');
    if (disabled) parts.push('[disabled]');
    if (humanOnly) parts.push('[human-only]');
    const line = parts.join(' ');
    const lineBytes = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);
    if (totalBytes + lineBytes > ANDROID_BROWSER_MAX_SNAPSHOT_TEXT_BYTES) {
      truncated = true;
      break;
    }

    seenRefs.add(ref);
    totalBytes += lineBytes;
    lines.push(line);
    refs.push(refEntry);
    interactive.push({
      ref,
      tag,
      role,
      type: rawType,
      autocomplete,
      name: attrName,
      ariaLabel,
      text,
      placeholder,
      ...(checked !== undefined ? { checked } : {}),
      disabled,
      href: safeHref,
      ...(rect ? { rect } : {}),
    });
  }

  let safeTextSummary = '';
  if (rawTextSummary !== '') {
    let preBounded = rawTextSummary;
    if (preBounded.length > ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS * 4) {
      preBounded = sliceCharsSafe(preBounded, ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS * 4);
      truncated = true;
    }
    const cleanedSummary = cleanSingleLine(sanitizeInlineUrls(preBounded));
    if (cleanedSummary.length > ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS) {
      safeTextSummary = `${sliceCharsSafe(cleanedSummary, ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS - 1)}…`;
      truncated = true;
    } else {
      safeTextSummary = cleanedSummary;
    }
  }

  if (!interactiveOnly && safeTextSummary !== '') {
    const summaryLine = `text "${safeTextSummary}"`;
    const sepBytes = lines.length > 0 ? 1 : 0;
    const remainingBytes = ANDROID_BROWSER_MAX_SNAPSHOT_TEXT_BYTES - totalBytes - sepBytes;
    const summaryBytes = Buffer.byteLength(summaryLine, 'utf8');
    if (summaryBytes <= remainingBytes) {
      lines.push(summaryLine);
      totalBytes += sepBytes + summaryBytes;
    } else if (remainingBytes > 12) {
      // Reserve 6 bytes for `text "` and 4 bytes for `…"` (UTF-8).
      const clipped = truncateUtf8(safeTextSummary, remainingBytes - 10);
      if (clipped !== '') {
        lines.push(`text "${clipped}…"`);
      }
      truncated = true;
    } else {
      truncated = true;
    }
  }

  const out = {
    pageId: result.pageId,
    revision,
    url: safeUrl,
    title: safeTitle,
    loading: result.loading === true,
    canGoBack: result.canGoBack === true,
    canGoForward: result.canGoForward === true,
    sensitive: false,
    requiresHumanTakeover: result.requiresHumanTakeover === true,
    requiresSystemBrowser: false,
    snapshot: lines.join('\n'),
    refs,
    interactive,
    textSummary: safeTextSummary,
    truncated,
  };
  if (rawSensitiveReason !== '') {
    out.sensitiveReason = rawSensitiveReason;
  }
  return out;
}

function mapNativeFailure(err) {
  if (err && err.name === 'AbortError') return err;
  const code = typeof err?.code === 'string' ? err.code : '';
  const message = typeof err?.message === 'string' && err.message !== ''
    ? err.message
    : 'Android bot browser native call failed';
  let mapped;
  if (BROWSER_ERROR_SET.has(code) || code === 'CANCELLED' || code === 'INVALID_ARGUMENT') {
    mapped = code;
  } else if (NATIVE_CODE_MAP.has(code)) {
    mapped = NATIVE_CODE_MAP.get(code);
  } else {
    mapped = 'BROWSER_BACKEND_FAILED';
  }
  return browserError(mapped, message, {
    outcome: code === 'ANDROID_NATIVE_UNCONFIRMED'
      ? 'unconfirmed'
      : (typeof err?.outcome === 'string' ? err.outcome : undefined),
    requiresSystemBrowser: (mapped === 'BROWSER_PROFILE_UNSUPPORTED' || mapped === 'BROWSER_SENSITIVE_BLOCKED')
      ? true
      : undefined,
  });
}

function resolveSource(action, input) {
  if (input.source !== undefined) {
    if (!SOURCES.has(input.source)) {
      throw browserError('INVALID_ARGUMENT', "source must be 'agent' or 'human'");
    }
    if (action === 'input' && input.source !== 'human') {
      throw browserError('INVALID_ARGUMENT', "raw input is only permitted for source 'human'");
    }
    return input.source;
  }
  if (action === 'input') return 'human';
  if (action === 'act' || action === 'snapshot') return 'agent';
  if (input.phase === 'human' || Boolean(input.lease)) return 'human';
  return 'agent';
}

function resolveTaskId(input, source) {
  const value = input.taskId;
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && SYNTHETIC_TASK_ID_RE.test(value)) return value;
  return `${source}:${randomUUID()}`;
}

/**
 * Create a per-Bot Android native browser provider.
 *
 * Returns `{ perform(input), close() }` (usable with or without `await`).
 * `opts`: `{ botId, deviceId?, profileDir?, nativeBridge?, actor?, getDeviceId? }`.
 */
export function createAndroidBrowserProvider(opts = {}) {
  if (!isPlainObject(opts)) {
    throw browserError('INVALID_ARGUMENT', 'options must be an object');
  }
  assertId(opts.botId, 'botId');
  const botId = opts.botId;
  const nativeBridge = typeof opts.nativeBridge === 'function' ? opts.nativeBridge : null;
  const getDeviceId = typeof opts.getDeviceId === 'function' ? opts.getDeviceId : null;
  const fixedDeviceId = typeof opts.deviceId === 'string' && opts.deviceId.trim() !== ''
    ? opts.deviceId.trim()
    : (typeof opts.actor?.deviceId === 'string' && opts.actor.deviceId.trim() !== ''
      ? opts.actor.deviceId.trim()
      : null);
  const defaultActor = isPlainObject(opts.actor) ? opts.actor : null;

  let closed = false;
  let lastDeviceId = fixedDeviceId;
  let touchedNative = false;

  function resolveActor(input) {
    const candidateDeviceId = fixedDeviceId
      ?? (getDeviceId ? getDeviceId() : null)
      ?? (typeof input?.actor?.deviceId === 'string' ? input.actor.deviceId : null)
      ?? (typeof input?.deviceId === 'string' ? input.deviceId : null)
      ?? lastDeviceId;
    if (typeof candidateDeviceId !== 'string' || candidateDeviceId.trim() === '') {
      return null;
    }
    assertId(candidateDeviceId, 'deviceId');
    lastDeviceId = candidateDeviceId;

    const srcActor = isPlainObject(input?.actor) ? input.actor : defaultActor;
    const kind = srcActor?.kind === 'room' || srcActor?.kind === 'dm' ? srcActor.kind : 'primary';
    const conversationId = typeof srcActor?.conversationId === 'string' && srcActor.conversationId.trim() !== ''
      ? srcActor.conversationId
      : `browser:${botId}`;
    assertId(conversationId, 'conversationId');
    let scopeId = null;
    if (kind !== 'primary') {
      if (typeof srcActor?.scopeId !== 'string' || srcActor.scopeId.trim() === '') {
        throw browserError('INVALID_ARGUMENT', 'work actor must carry a string scopeId');
      }
      assertId(srcActor.scopeId, 'scopeId');
      scopeId = srcActor.scopeId;
    }
    return {
      deviceId: candidateDeviceId,
      botId,
      conversationId,
      scopeId,
      kind,
    };
  }

  async function callNative(actor, source, taskId, args, signal) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    try {
      return await nativeBridge(
        {
          tool: NATIVE_TOOL,
          actor,
          taskId,
          arguments: { ...args, source },
        },
        { signal },
      );
    } catch (err) {
      throw mapNativeFailure(err);
    }
  }

  async function perform(input = {}) {
    if (closed) {
      throw browserError('BROWSER_UNAVAILABLE', 'Android browser provider is closed');
    }
    if (!isPlainObject(input)) {
      throw browserError('INVALID_ARGUMENT', 'perform input must be an object');
    }
    if (input.botId !== undefined && input.botId !== botId) {
      throw browserError('INVALID_ARGUMENT', 'input.botId does not match this provider owner');
    }
    const action = input.action;
    if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
      throw browserError('INVALID_ARGUMENT', `unsupported android browser action: ${String(action)}`);
    }

    const signal = input.signal;
    if (!nativeBridge) {
      const reason = 'Android native browser bridge is unavailable; use external system browser guidance.';
      if (action === 'status' || action === 'release') return unavailableDto(reason);
      throw browserError('BROWSER_UNAVAILABLE', reason, { requiresSystemBrowser: true });
    }

    const actor = resolveActor(input);
    if (!actor) {
      const reason = 'Android browser provider is missing host deviceId for native bridge isolation.';
      if (action === 'status' || action === 'release') return unavailableDto(reason);
      throw browserError('BROWSER_UNAVAILABLE', reason, { requiresSystemBrowser: true });
    }

    const source = resolveSource(action, input);
    const taskId = resolveTaskId(input, source);

    if (action === 'status') {
      const reply = await callNative(actor, source, taskId, { action: 'status' }, signal);
      return normalizeStatusReply(reply);
    }

    if (action === 'release') {
      const reply = await callNative(actor, source, taskId, { action: 'release' }, signal);
      touchedNative = false;
      return normalizeStatusReply(reply);
    }

    if (action === 'open') {
      const args = { action: 'open' };
      if (input.url !== undefined && input.url !== null && String(input.url).trim() !== '') {
        const check = classifyAndroidBrowserUrl(input.url);
        if (check.sensitivity === 'blocked_external_auth') {
          throw browserError(
            'BROWSER_SENSITIVE_BLOCKED',
            'Google sign-in and OAuth authorization must open in the system browser, never inside the Bot WebView.',
            { requiresSystemBrowser: true, sensitiveReason: check.reason },
          );
        }
        args.url = check.canonicalUrl;
      }
      if (input.width !== undefined) {
        args.width = clampInt(Number(input.width), 960, 320, ANDROID_BROWSER_MAX_FRAME_WIDTH);
      }
      if (input.height !== undefined) {
        args.height = clampInt(Number(input.height), 640, 320, ANDROID_BROWSER_MAX_FRAME_HEIGHT);
      }
      touchedNative = true;
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeStatusReply(reply);
    }

    if (action === 'navigate') {
      const check = classifyAndroidBrowserUrl(input.url);
      if (check.sensitivity === 'blocked_external_auth') {
        throw browserError(
          'BROWSER_SENSITIVE_BLOCKED',
          'Google sign-in and OAuth authorization must open in the system browser, never inside the Bot WebView.',
          { requiresSystemBrowser: true, sensitiveReason: check.reason },
        );
      }
      const args = { action: 'navigate', url: check.canonicalUrl };
      if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      if (input.revision !== undefined && input.revision !== null) {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
          throw browserError('INVALID_ARGUMENT', 'revision must be a non-negative safe integer');
        }
        args.revision = input.revision;
      }
      touchedNative = true;
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeStatusReply(reply);
    }

    if (action === 'back' || action === 'forward' || action === 'reload') {
      const args = { action };
      if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      if (input.revision !== undefined && input.revision !== null) {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
          throw browserError('INVALID_ARGUMENT', 'revision must be a non-negative safe integer');
        }
        args.revision = input.revision;
      }
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeStatusReply(reply);
    }

    if (action === 'select' || action === 'closeTab') {
      const args = { action };
      if (action === 'select') {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      } else if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeStatusReply(reply);
    }

    if (action === 'frame') {
      const limits = normalizeFrameLimits(input.limits);
      const args = { action: 'frame', limits };
      if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeFrameReply(reply, limits);
    }

    if (action === 'snapshot') {
      const args = { action: 'snapshot' };
      if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      if (input.revision !== undefined && input.revision !== null) {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
          throw browserError('INVALID_ARGUMENT', 'revision must be a non-negative safe integer');
        }
        args.revision = input.revision;
      }
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeSnapshotReply(reply, {
        interactiveOnly: input.interactive === true,
        includeUrls: input.urls === true,
      });
    }

    if (action === 'act') {
      const rawAct = isPlainObject(input.act) ? input.act : input;
      const act = normalizeAndroidBrowserAct(rawAct);
      const args = { action: 'act', act };
      if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      if (input.revision !== undefined && input.revision !== null) {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
          throw browserError('INVALID_ARGUMENT', 'revision must be a non-negative safe integer');
        }
        args.revision = input.revision;
      }
      const reply = await callNative(actor, source, taskId, args, signal);
      return normalizeStatusReply(reply);
    }

    if (action === 'input') {
      const event = normalizeAndroidBrowserInputEvent(input.event);
      const args = { action: 'input', event };
      if (input.pageId !== undefined && input.pageId !== null) {
        assertId(input.pageId, 'pageId');
        args.pageId = input.pageId;
      }
      if (input.revision !== undefined && input.revision !== null) {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
          throw browserError('INVALID_ARGUMENT', 'revision must be a non-negative safe integer');
        }
        args.revision = input.revision;
      }
      const reply = await callNative(actor, 'human', resolveTaskId(input, 'human'), args, signal);
      return normalizeStatusReply(reply);
    }

    throw browserError('INVALID_ARGUMENT', `unsupported android browser action: ${action}`);
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (!nativeBridge || !touchedNative) return;
    const actor = resolveActor({});
    if (!actor) return;
    try {
      await callNative(actor, 'human', `human:${randomUUID()}`, { action: 'release' }, undefined);
    } catch {
      // Best-effort cleanup on shutdown; native BotHostNativeTools.close() also destroys all WebViews.
    } finally {
      touchedNative = false;
    }
  }

  return { perform, close };
}
