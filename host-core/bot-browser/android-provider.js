// host-core/bot-browser/android-provider.js
// Android native Bot Browser provider. Routes strictly through the private
// Node Mobile -> Java native bridge tool `bot_browser` backed by per-Bot
// WebView multi-profile isolation (never shares the App UI WebView or Default
// profile, never runs Electron, and honestly reports unavailable with external
// system-browser guidance on devices without WebViewFeature.MULTI_PROFILE).
import { randomUUID } from 'node:crypto';
import { assertId, messageError } from '../message-protocol.js';
import { ANDROID_BROWSER_ERROR_CODES } from '../android-bridge-protocol.js';

export { ANDROID_BROWSER_ERROR_CODES };

export const ANDROID_BROWSER_PLATFORM = 'android';
export const ANDROID_BROWSER_MAX_URL_LENGTH = 4096;
export const ANDROID_BROWSER_MAX_TEXT_LENGTH = 2048;
export const ANDROID_BROWSER_MAX_FRAME_WIDTH = 1280;
export const ANDROID_BROWSER_MAX_FRAME_HEIGHT = 800;
export const ANDROID_BROWSER_MAX_FRAME_BASE64_BYTES = 512 * 1024;
export const ANDROID_BROWSER_MAX_WHEEL_DELTA = 2000;
export const ANDROID_BROWSER_MAX_WAIT_MS = 5000;

const NATIVE_TOOL = 'bot_browser';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const REF_RE = /^e[1-9][0-9]{0,2}$/;
const SYNTHETIC_TASK_ID_RE = /^(human|agent):[0-9a-fA-F-]{8,64}$/;
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
  ['ANDROID_NATIVE_UNCONFIRMED', 'BROWSER_BACKEND_FAILED'],
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
  const needsRef = kind === 'click' || kind === 'fill' || kind === 'type'
    || kind === 'select' || kind === 'check' || kind === 'uncheck';
  if (needsRef || (act.ref !== undefined && act.ref !== null && act.ref !== '')) {
    if (typeof act.ref !== 'string' || !REF_RE.test(act.ref)) {
      throw browserError('INVALID_ARGUMENT', 'act.ref must be a valid snapshot element ref (e.g. e1)');
    }
    out.ref = act.ref;
  }
  if (kind === 'fill' || kind === 'type') {
    const text = act.text ?? act.value ?? '';
    if (typeof text !== 'string' || !text.isWellFormed()
      || text.length > ANDROID_BROWSER_MAX_TEXT_LENGTH || text.includes('\0')) {
      throw browserError('INVALID_ARGUMENT', 'act text must be a bounded string without NUL');
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
  } else if (kind === 'wait') {
    out.ms = clampInt(act.ms ?? 300, 300, 0, ANDROID_BROWSER_MAX_WAIT_MS);
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

function normalizeSnapshotReply(result) {
  if (!isPlainObject(result)) {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser snapshot reply must be an object');
  }
  if (typeof result.pageId !== 'string' || result.pageId === '') {
    throw browserError('BROWSER_BACKEND_FAILED', 'bot_browser snapshot missing pageId');
  }
  const out = {
    pageId: result.pageId,
    revision: Number.isSafeInteger(result.revision) && result.revision >= 0 ? result.revision : 0,
    url: typeof result.url === 'string' ? result.url : 'about:blank',
    title: typeof result.title === 'string' ? result.title : '',
    loading: result.loading === true,
    canGoBack: result.canGoBack === true,
    canGoForward: result.canGoForward === true,
    sensitive: result.sensitive === true,
    requiresHumanTakeover: result.requiresHumanTakeover === true,
    requiresSystemBrowser: result.requiresSystemBrowser === true,
    interactive: Array.isArray(result.interactive) ? result.interactive : [],
    textSummary: typeof result.textSummary === 'string' ? result.textSummary : '',
    truncated: result.truncated === true,
  };
  if (typeof result.sensitiveReason === 'string' && result.sensitiveReason !== '') {
    out.sensitiveReason = result.sensitiveReason;
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
    outcome: typeof err?.outcome === 'string' ? err.outcome : undefined,
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
      return normalizeSnapshotReply(reply);
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
