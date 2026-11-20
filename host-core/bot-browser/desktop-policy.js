// host-core/bot-browser/desktop-policy.js
//
// Desktop Bot browser security policy, URL allowlist, sensitive page/element
// boundaries, bounded frame/snapshot limits, and human input normalization.
//
// Portions of error classification, key/element interaction semantics, and
// snapshot projection are adapted from Orca v1.4.265 (commit e64e561738d8d465ab459e7e3f9e46d08b6396ea):
//   - src/main/browser/browser-error.ts
//   - src/main/orcad/browser-providers/chromium/external-chromium-page-input.ts
//   - src/main/orcad/browser-providers/chromium/external-chromium-browser-session.ts
//
// MIT License — Copyright (c) 2026 Lovecast Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

export const DESKTOP_BROWSER_DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const DESKTOP_BROWSER_MIN_VIEWPORT = Object.freeze({ width: 320, height: 240 });
export const DESKTOP_BROWSER_MAX_VIEWPORT = Object.freeze({ width: 2560, height: 1600 });

// Match host-core/shower-protocol.js 720 KiB base64 budget so a full volatile
// control frame stays well under the 1 MiB transport frame ceiling.
export const DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES = 737_280;
export const DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY = 65;
export const DESKTOP_BROWSER_MIN_FRAME_INTERVAL_MS = 100;
export const DESKTOP_BROWSER_FLOOR_FRAME_INTERVAL_MS = 50;
export const DESKTOP_BROWSER_SCREENCAST_IDLE_STOP_MS = 15_000;

export const DESKTOP_BROWSER_MAX_TABS_PER_BOT = 8;
export const DESKTOP_BROWSER_HARD_MAX_TABS = 16;
export const DESKTOP_BROWSER_MAX_INPUT_TEXT_LENGTH = 1_000;
export const DESKTOP_BROWSER_MAX_WHEEL_DELTA = 2_000;
export const DESKTOP_BROWSER_MAX_SNAPSHOT_NODES = 250;
export const DESKTOP_BROWSER_HARD_MAX_SNAPSHOT_NODES = 600;
export const DESKTOP_BROWSER_MAX_SNAPSHOT_TEXT_BYTES = 24_576;
export const DESKTOP_BROWSER_MAX_WAIT_MS = 15_000;
export const DESKTOP_BROWSER_MAX_URL_LENGTH = 8_192;

export const ALLOWED_BOT_ACT_KINDS = Object.freeze(new Set([
  'click',
  'dblclick',
  'hover',
  'focus',
  'fill',
  'clear',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'scroll',
  'wait',
]));

export const FORBIDDEN_ACT_KINDS = Object.freeze(new Set([
  'eval',
  'evaluate',
  'execute',
  'exec',
  'script',
  'cookie',
  'cookies',
  'cdp',
  'storage',
  'localStorage',
  'sessionStorage',
  'extension',
  'extensions',
  'certificate',
  'proceedCertificate',
  'profile',
  'download',
  'upload',
  'raw',
]));

export function browserError(code, message, extra = {}) {
  const err = new Error(message);
  err.name = 'BrowserError';
  err.code = code;
  if (extra.outcome !== undefined) err.outcome = extra.outcome;
  if (extra.sensitive !== undefined) err.sensitive = extra.sensitive;
  if (extra.sensitiveCategory !== undefined) err.sensitiveCategory = extra.sensitiveCategory;
  if (extra.sensitiveReason !== undefined) err.sensitiveReason = extra.sensitiveReason;
  if (extra.authUseSystemBrowser !== undefined) err.authUseSystemBrowser = extra.authUseSystemBrowser;
  if (extra.data !== undefined) err.data = extra.data;
  return err;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeViewport(raw) {
  if (raw === undefined || raw === null) {
    return { ...DESKTOP_BROWSER_DEFAULT_VIEWPORT };
  }
  if (!isPlainObject(raw)) {
    throw browserError('INVALID_ARGUMENT', 'viewport must be a plain object');
  }
  const width = raw.width === undefined ? DESKTOP_BROWSER_DEFAULT_VIEWPORT.width : raw.width;
  const height = raw.height === undefined ? DESKTOP_BROWSER_DEFAULT_VIEWPORT.height : raw.height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < DESKTOP_BROWSER_MIN_VIEWPORT.width ||
    width > DESKTOP_BROWSER_MAX_VIEWPORT.width ||
    height < DESKTOP_BROWSER_MIN_VIEWPORT.height ||
    height > DESKTOP_BROWSER_MAX_VIEWPORT.height
  ) {
    throw browserError(
      'INVALID_ARGUMENT',
      `viewport must be integers within ${DESKTOP_BROWSER_MIN_VIEWPORT.width}x${DESKTOP_BROWSER_MIN_VIEWPORT.height}..${DESKTOP_BROWSER_MAX_VIEWPORT.width}x${DESKTOP_BROWSER_MAX_VIEWPORT.height}`
    );
  }
  return { width, height };
}

/**
 * Strict navigation URL allowlist: only about:blank, http:, and https:.
 * Rejects file:, javascript:, data:, chrome:, edge:, devtools:, view-source:,
 * blob:, and embedded URL credentials.
 */
export function normalizeNavigationUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > DESKTOP_BROWSER_MAX_URL_LENGTH) return null;
  if (typeof trimmed.isWellFormed === 'function' && !trimmed.isWellFormed()) return null;
  if (trimmed === 'about:blank') return 'about:blank';

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  return parsed.toString();
}

const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'myaccount.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'oauth2.googleapis.com',
]);

const OTHER_AUTH_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'signin.aws.amazon.com',
]);

const PAYMENT_HOSTS = new Set([
  'pay.google.com',
  'payments.google.com',
  'billing.google.com',
  'checkout.stripe.com',
]);

const CLOUD_CONSOLE_HOSTS = new Set([
  'console.cloud.google.com',
  'console.developers.google.com',
]);

const MFA_PATH_OR_TITLE_RE = /(?:two-?factor|\b2fa\b|\bmfa\b|\btotp\b|authenticator|security[- ]key|passkey|challenge\/(?:pwd|totp|ipp|sk|az|dp))/i;
const LOGIN_URL_OR_TITLE_RE = /(?:\/(?:sign-?in|log-?in|auth|oauth|session|sso)\b|\bsign\s*in\b|\blog\s*in\b|登录|验证身份)/i;
const OAUTH_CONSENT_PATH_RE = /^\/(?:o\/oauth2|signin\/oauth|v\d+\/signin\/oauth|consent)/i;
const PAYMENT_PATH_RE = /\/(?:checkout|billing\/pay|payment|card-details)/i;

export function isGoogleApiOAuthUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'oauth2.googleapis.com') return true;
  if (host === 'accounts.google.com' && OAUTH_CONSENT_PATH_RE.test(parsed.pathname)) {
    return true;
  }
  return false;
}

export function isCloudConsoleOAuthClientPath(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!CLOUD_CONSOLE_HOSTS.has(host)) return false;
  const fullPath = `${parsed.pathname}${parsed.hash}`.toLowerCase();
  return (
    fullPath.includes('/apis/credentials/oauthclient') ||
    fullPath.includes('/auth/clients/create') ||
    fullPath.includes('/auth/clients/') ||
    fullPath.includes('/apis/credentials/consent')
  );
}

/**
 * Classify whether the current page hits any hard privacy / authentication
 * boundary defined in 04-frontend-interaction.md §3.3.
 */
export function classifySensitivePage({ url = '', title = '', domSignals = null } = {}) {
  let host = '';
  let pathname = '';
  try {
    if (url && url !== 'about:blank') {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    }
  } catch {
    // Unparseable URL treated conservatively below if signals match.
  }

  const signals = isPlainObject(domSignals) ? domSignals : {};
  const safeTitle = typeof title === 'string' ? title : '';

  // 1. Cloud Console OAuth Client Secret dialog (highest risk: never stream as ordinary frame).
  if (signals.hasClientSecretModal === true) {
    return {
      sensitive: true,
      category: 'secret_modal',
      reason: 'OAuth client secret dialog detected; blocking model access and ordinary frame streaming.',
      secretExposureRisk: true,
      authUseSystemBrowser: false,
    };
  }

  // 2. OAuth Consent screens (Google API auth must use system browser).
  if (isGoogleApiOAuthUrl(url) || signals.hasOAuthConsentPrompt === true) {
    const isGoogle = GOOGLE_AUTH_HOSTS.has(host) || host.endsWith('.google.com');
    return {
      sensitive: true,
      category: 'oauth_consent',
      reason: isGoogle
        ? 'Google OAuth consent must be completed in the system browser, not the Bot browser.'
        : 'OAuth authorization consent screen detected; human review required.',
      secretExposureRisk: false,
      authUseSystemBrowser: isGoogle,
    };
  }

  // 3. Google login / account / MFA / external IdP login pages.
  if (GOOGLE_AUTH_HOSTS.has(host)) {
    return {
      sensitive: true,
      category: 'google_auth',
      reason: 'Google sign-in/account page detected; blocking Bot observation. Use system browser for Google API authorization.',
      secretExposureRisk: false,
      authUseSystemBrowser: true,
    };
  }
  if (
    OTHER_AUTH_HOSTS.has(host) ||
    (host === 'github.com' && /^\/(?:login|sessions\/two-factor)/i.test(pathname)) ||
    MFA_PATH_OR_TITLE_RE.test(pathname) ||
    MFA_PATH_OR_TITLE_RE.test(safeTitle)
  ) {
    return {
      sensitive: true,
      category: 'auth_mfa',
      reason: 'Sign-in or multi-factor authentication boundary detected; blocking Bot observation.',
      secretExposureRisk: false,
      authUseSystemBrowser: false,
    };
  }

  // 4. Active password field focus or password field on a sign-in page.
  if (
    signals.passwordFocused === true ||
    (signals.hasVisiblePasswordInput === true &&
      (LOGIN_URL_OR_TITLE_RE.test(pathname) || LOGIN_URL_OR_TITLE_RE.test(safeTitle)))
  ) {
    return {
      sensitive: true,
      category: 'password_input',
      reason: 'Password input boundary detected; blocking Bot observation and model screenshots.',
      secretExposureRisk: false,
      authUseSystemBrowser: false,
    };
  }

  // 5. Payment / billing checkout pages.
  if (
    PAYMENT_HOSTS.has(host) ||
    (host === 'paypal.com' && PAYMENT_PATH_RE.test(pathname)) ||
    signals.hasPaymentInput === true
  ) {
    return {
      sensitive: true,
      category: 'payment',
      reason: 'Payment or billing credential page detected; blocking Bot observation.',
      secretExposureRisk: false,
      authUseSystemBrowser: false,
    };
  }

  return {
    sensitive: false,
    category: null,
    reason: null,
    secretExposureRisk: false,
    authUseSystemBrowser: false,
  };
}

const PASSWORD_OR_SECRET_FIELD_RE =
  /(?:\bpassword\b|\bpasscode\b|\bclient\s*secret\b|\bsecret\b|\botp\b|verification\s*code|security\s*code|\b2fa\b|\bmfa\b|credit\s*card|\bcvv\b|\bcvc\b|密码|验证码|密钥)/i;

const TOS_OR_POLICY_RE =
  /(?:user\s*data\s*policy|terms\s*of\s*service|terms\s*and\s*conditions|privacy\s*policy|\bi\s*agree\b|\baccept\s*terms\b|agree\s*and\s*continue|用户数据政策|服务条款|隐私政策|同意并继续|我同意)/i;

const OAUTH_APPROVE_RE =
  /(?:\ballow\b|\bgrant\s*access\b|\bauthorize\b|\bapprove\b|允许|授予权限|同意授权)/i;

const SECRET_CREATE_OR_REVEAL_RE =
  /(?:^\s*create\s*$|download\s*json|copy\s*(?:client\s*)?secret|show\s*(?:client\s*)?secret|reveal\s*secret|reset\s*secret|创建|下载\s*json|复制密钥|显示密钥)/i;

/**
 * Guard Bot `act` commands against crossing human-only legal, OAuth, or secret
 * boundaries (e.g. checking Terms of Service, consenting to OAuth, typing into
 * secret/password fields, or clicking final Create on OAuth client creation).
 */
export function checkBotHumanOnlyTarget({
  url = '',
  title = '',
  role = '',
  name = '',
  inputType = '',
  actionKind = '',
} = {}) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedRole = typeof role === 'string' ? role.toLowerCase() : '';
  const normalizedType = typeof inputType === 'string' ? inputType.toLowerCase() : '';

  if (
    normalizedType === 'password' ||
    ((actionKind === 'fill' || actionKind === 'type' || actionKind === 'clear') &&
      PASSWORD_OR_SECRET_FIELD_RE.test(normalizedName))
  ) {
    return {
      blocked: true,
      category: 'password_or_secret_input',
      reason: 'Bot cannot enter passwords, OTP codes, or secrets; human takeover is required.',
    };
  }

  if (
    (actionKind === 'click' || actionKind === 'dblclick' || actionKind === 'check' || actionKind === 'press') &&
    TOS_OR_POLICY_RE.test(normalizedName)
  ) {
    return {
      blocked: true,
      category: 'terms_consent',
      reason: 'Human must personally review and accept Terms of Service / User Data Policy.',
    };
  }

  if (
    (actionKind === 'click' || actionKind === 'dblclick' || actionKind === 'check') &&
    (isGoogleApiOAuthUrl(url) || /oauth|consent|授权/i.test(`${url} ${title}`)) &&
    OAUTH_APPROVE_RE.test(normalizedName)
  ) {
    return {
      blocked: true,
      category: 'oauth_consent',
      reason: 'Bot cannot approve OAuth consent; human must complete authorization in the system browser.',
    };
  }

  if (
    (actionKind === 'click' || actionKind === 'dblclick' || actionKind === 'press') &&
    isCloudConsoleOAuthClientPath(url) &&
    (normalizedRole === 'button' || normalizedRole === 'link' || normalizedRole === '') &&
    SECRET_CREATE_OR_REVEAL_RE.test(normalizedName)
  ) {
    return {
      blocked: true,
      category: 'secret_creation',
      reason:
        'Stopping before OAuth Client Secret creation/reveal; human should take over or complete this step in the system browser so the secret is never exposed to the Bot.',
    };
  }

  return { blocked: false, category: null, reason: null };
}

// US keyboard layout CDP key descriptors for standard navigation, editing, and ASCII keys.
const NAMED_KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' },
  F1: { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
  F2: { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
  F3: { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
  F4: { key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 },
  F5: { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
  F6: { key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 },
  F7: { key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 },
  F8: { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 },
  F9: { key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 },
  F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
  F11: { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 },
  F12: { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 },
});

const KEY_ALIASES = Object.freeze({
  return: 'Enter',
  esc: 'Escape',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  spacebar: 'Space',
});

const US_PUNCTUATION_KEYS = Object.freeze({
  '-': { code: 'Minus', keyCode: 189, shift: false, base: '-' },
  _: { code: 'Minus', keyCode: 189, shift: true, base: '-' },
  '=': { code: 'Equal', keyCode: 187, shift: false, base: '=' },
  '+': { code: 'Equal', keyCode: 187, shift: true, base: '=' },
  '[': { code: 'BracketLeft', keyCode: 219, shift: false, base: '[' },
  '{': { code: 'BracketLeft', keyCode: 219, shift: true, base: '[' },
  ']': { code: 'BracketRight', keyCode: 221, shift: false, base: ']' },
  '}': { code: 'BracketRight', keyCode: 221, shift: true, base: ']' },
  '\\': { code: 'Backslash', keyCode: 220, shift: false, base: '\\' },
  '|': { code: 'Backslash', keyCode: 220, shift: true, base: '\\' },
  ';': { code: 'Semicolon', keyCode: 186, shift: false, base: ';' },
  ':': { code: 'Semicolon', keyCode: 186, shift: true, base: ';' },
  "'": { code: 'Quote', keyCode: 222, shift: false, base: "'" },
  '"': { code: 'Quote', keyCode: 222, shift: true, base: "'" },
  ',': { code: 'Comma', keyCode: 188, shift: false, base: ',' },
  '<': { code: 'Comma', keyCode: 188, shift: true, base: ',' },
  '.': { code: 'Period', keyCode: 190, shift: false, base: '.' },
  '>': { code: 'Period', keyCode: 190, shift: true, base: '.' },
  '/': { code: 'Slash', keyCode: 191, shift: false, base: '/' },
  '?': { code: 'Slash', keyCode: 191, shift: true, base: '/' },
  '`': { code: 'Backquote', keyCode: 192, shift: false, base: '`' },
  '~': { code: 'Backquote', keyCode: 192, shift: true, base: '`' },
  '!': { code: 'Digit1', keyCode: 49, shift: true, base: '1' },
  '@': { code: 'Digit2', keyCode: 50, shift: true, base: '2' },
  '#': { code: 'Digit3', keyCode: 51, shift: true, base: '3' },
  $: { code: 'Digit4', keyCode: 52, shift: true, base: '4' },
  '%': { code: 'Digit5', keyCode: 53, shift: true, base: '5' },
  '^': { code: 'Digit6', keyCode: 54, shift: true, base: '6' },
  '&': { code: 'Digit7', keyCode: 55, shift: true, base: '7' },
  '*': { code: 'Digit8', keyCode: 56, shift: true, base: '8' },
  '(': { code: 'Digit9', keyCode: 57, shift: true, base: '9' },
  ')': { code: 'Digit0', keyCode: 48, shift: true, base: '0' },
});

const MODIFIER_BITS = Object.freeze({
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
});

export function parseModifierMask(raw) {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > 15) {
      throw browserError('INVALID_ARGUMENT', 'modifiers bitmask must be an integer 0..15');
    }
    return raw;
  }
  if (!Array.isArray(raw)) {
    throw browserError('INVALID_ARGUMENT', 'modifiers must be an array of modifier names or bitmask');
  }
  let mask = 0;
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw browserError('INVALID_ARGUMENT', 'modifier entries must be strings');
    }
    const bit = MODIFIER_BITS[item.trim().toLowerCase()];
    if (!bit) {
      throw browserError('INVALID_ARGUMENT', `Unknown keyboard modifier: ${item}`);
    }
    mask |= bit;
  }
  return mask;
}

function isBlockedBrowserChromeShortcut(key, modifiers) {
  const hasCtrlOrMeta = Boolean(modifiers & 2) || Boolean(modifiers & 4);
  const hasAlt = Boolean(modifiers & 1);
  const hasShift = Boolean(modifiers & 8);
  const lower = key.toLowerCase();

  if (key === 'F12') return true;
  if (hasAlt && key === 'F4') return true;
  if (hasCtrlOrMeta && hasShift && (lower === 'i' || lower === 'j' || lower === 'c')) return true;
  if (hasCtrlOrMeta && (lower === 'l' || lower === 'w' || lower === 't' || lower === 'n' || lower === 'q' || lower === 'u')) {
    return true;
  }
  return false;
}

export function resolveCdpKeyDescriptor(rawKey, extraModifiers = 0) {
  if (typeof rawKey !== 'string' || rawKey.length === 0 || rawKey.length > 64) {
    throw browserError('INVALID_ARGUMENT', 'key must be a non-empty string');
  }
  let modifiers = parseModifierMask(extraModifiers);
  let keyToken = rawKey;

  if (rawKey.length > 1 && rawKey.includes('+')) {
    const parts = rawKey.split('+');
    keyToken = parts.pop();
    if (!keyToken) {
      throw browserError('INVALID_ARGUMENT', 'Invalid key chord syntax');
    }
    for (const part of parts) {
      const bit = MODIFIER_BITS[part.trim().toLowerCase()];
      if (!bit) {
        throw browserError('INVALID_ARGUMENT', `Unknown key modifier in chord: ${part}`);
      }
      modifiers |= bit;
    }
  }

  let descriptor = NAMED_KEYS[keyToken];
  if (!descriptor) {
    const alias = KEY_ALIASES[keyToken.toLowerCase()];
    if (alias) {
      descriptor = NAMED_KEYS[alias];
    } else {
      const exactCaseInsensitive = Object.keys(NAMED_KEYS).find(
        (name) => name.toLowerCase() === keyToken.toLowerCase()
      );
      if (exactCaseInsensitive) {
        descriptor = NAMED_KEYS[exactCaseInsensitive];
      }
    }
  }

  if (descriptor) {
    if (isBlockedBrowserChromeShortcut(descriptor.key, modifiers)) {
      throw browserError('BROWSER_INPUT_BLOCKED', 'Browser chrome shortcut is not permitted');
    }
    const suppressText = Boolean(modifiers & (1 | 2 | 4));
    return {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers,
      ...(descriptor.text && !suppressText
        ? { text: descriptor.text, unmodifiedText: descriptor.unmodifiedText ?? descriptor.text }
        : {}),
    };
  }

  if (keyToken.length === 1) {
    const ch = keyToken;
    const cp = ch.charCodeAt(0);
    if (cp >= 0x41 && cp <= 0x5a) {
      // A-Z
      modifiers |= 8;
      if (isBlockedBrowserChromeShortcut(ch, modifiers)) {
        throw browserError('BROWSER_INPUT_BLOCKED', 'Browser chrome shortcut is not permitted');
      }
      const suppressText = Boolean(modifiers & (1 | 2 | 4));
      return {
        key: ch,
        code: `Key${ch}`,
        windowsVirtualKeyCode: cp,
        nativeVirtualKeyCode: cp,
        modifiers,
        ...(suppressText ? {} : { text: ch, unmodifiedText: ch.toLowerCase() }),
      };
    }
    if (cp >= 0x61 && cp <= 0x7a) {
      // a-z
      const upper = ch.toUpperCase();
      if (isBlockedBrowserChromeShortcut(ch, modifiers)) {
        throw browserError('BROWSER_INPUT_BLOCKED', 'Browser chrome shortcut is not permitted');
      }
      const effectiveKey = modifiers & 8 ? upper : ch;
      const suppressText = Boolean(modifiers & (1 | 2 | 4));
      return {
        key: effectiveKey,
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        nativeVirtualKeyCode: upper.charCodeAt(0),
        modifiers,
        ...(suppressText ? {} : { text: effectiveKey, unmodifiedText: ch }),
      };
    }
    if (cp >= 0x30 && cp <= 0x39) {
      // 0-9
      if (isBlockedBrowserChromeShortcut(ch, modifiers)) {
        throw browserError('BROWSER_INPUT_BLOCKED', 'Browser chrome shortcut is not permitted');
      }
      const suppressText = Boolean(modifiers & (1 | 2 | 4));
      return {
        key: ch,
        code: `Digit${ch}`,
        windowsVirtualKeyCode: cp,
        nativeVirtualKeyCode: cp,
        modifiers,
        ...(suppressText ? {} : { text: ch, unmodifiedText: ch }),
      };
    }
    const punct = US_PUNCTUATION_KEYS[ch];
    if (punct) {
      if (punct.shift) modifiers |= 8;
      if (isBlockedBrowserChromeShortcut(ch, modifiers)) {
        throw browserError('BROWSER_INPUT_BLOCKED', 'Browser chrome shortcut is not permitted');
      }
      const suppressText = Boolean(modifiers & (1 | 2 | 4));
      return {
        key: ch,
        code: punct.code,
        windowsVirtualKeyCode: punct.keyCode,
        nativeVirtualKeyCode: punct.keyCode,
        modifiers,
        ...(suppressText ? {} : { text: ch, unmodifiedText: punct.base }),
      };
    }
  }

  throw browserError('INVALID_ARGUMENT', `Unsupported key value: ${rawKey}`);
}

export function normalizeInputText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > DESKTOP_BROWSER_MAX_INPUT_TEXT_LENGTH) {
    throw browserError(
      'INVALID_ARGUMENT',
      `input text must be a non-empty string of at most ${DESKTOP_BROWSER_MAX_INPUT_TEXT_LENGTH} characters`
    );
  }
  if (typeof text.isWellFormed === 'function' && !text.isWellFormed()) {
    throw browserError('INVALID_ARGUMENT', 'input text must be well-formed Unicode');
  }
  // Reject C0 control characters so text insertion cannot synthesize Enter/Tab form submissions.
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw browserError('INVALID_ARGUMENT', 'input text must not contain control characters; use key events instead');
  }
  return text;
}

function assertNormalizedCoord(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw browserError('INVALID_ARGUMENT', `${name} must be a finite number in [0, 1]`);
  }
  return value;
}

/**
 * Validate and normalize human takeover input events from browserControl.
 * Never logs or reflects sensitive text in thrown errors.
 */
export function normalizeHumanInputEvent(event) {
  if (!isPlainObject(event)) {
    throw browserError('INVALID_ARGUMENT', 'input event must be a plain object');
  }
  const { kind } = event;
  const modifiers = parseModifierMask(event.modifiers);

  if (kind === 'click' || kind === 'dblclick' || kind === 'move') {
    const x = assertNormalizedCoord(event.x, 'event.x');
    const y = assertNormalizedCoord(event.y, 'event.y');
    const button = event.button === undefined ? 'left' : event.button;
    if (button !== 'left' && button !== 'right' && button !== 'middle') {
      throw browserError('INVALID_ARGUMENT', "event.button must be 'left', 'right', or 'middle'");
    }
    const defaultCount = kind === 'dblclick' ? 2 : 1;
    const clickCount = event.clickCount === undefined ? defaultCount : event.clickCount;
    if (clickCount !== 1 && clickCount !== 2) {
      throw browserError('INVALID_ARGUMENT', 'event.clickCount must be 1 or 2');
    }
    return { kind, x, y, button, clickCount, modifiers };
  }

  if (kind === 'text') {
    const text = normalizeInputText(event.text);
    return { kind: 'text', text };
  }

  if (kind === 'key') {
    const descriptor = resolveCdpKeyDescriptor(event.key, modifiers);
    return { kind: 'key', descriptor };
  }

  if (kind === 'wheel') {
    const x = event.x === undefined ? 0.5 : assertNormalizedCoord(event.x, 'event.x');
    const y = event.y === undefined ? 0.5 : assertNormalizedCoord(event.y, 'event.y');
    const rawDx = event.deltaX === undefined ? 0 : event.deltaX;
    const rawDy = event.deltaY === undefined ? 0 : event.deltaY;
    if (typeof rawDx !== 'number' || !Number.isFinite(rawDx) || typeof rawDy !== 'number' || !Number.isFinite(rawDy)) {
      throw browserError('INVALID_ARGUMENT', 'event.deltaX and event.deltaY must be finite numbers');
    }
    const deltaX = Math.max(-DESKTOP_BROWSER_MAX_WHEEL_DELTA, Math.min(DESKTOP_BROWSER_MAX_WHEEL_DELTA, rawDx));
    const deltaY = Math.max(-DESKTOP_BROWSER_MAX_WHEEL_DELTA, Math.min(DESKTOP_BROWSER_MAX_WHEEL_DELTA, rawDy));
    return { kind: 'wheel', x, y, deltaX, deltaY, modifiers };
  }

  throw browserError('INVALID_ARGUMENT', `Unsupported input event kind: ${String(kind)}`);
}

// Fixed, internal read-only DOM probe executed ONLY by the provider to detect
// sensitive boundaries (password focus, OAuth Client Secret dialogs, OAuth consent,
// payment fields). It NEVER reads or returns input values, cookies, or page secrets.
export const SENSITIVE_DOM_PROBE_EXPRESSION = `(() => {
  const active = document.activeElement;
  const activeTagName = active && active.tagName ? String(active.tagName).toLowerCase() : '';
  const activeInputType = activeTagName === 'input' ? String(active.type || '').toLowerCase() : '';
  const passwordFocused = activeTagName === 'input' && activeInputType === 'password';

  let hasVisiblePasswordInput = false;
  const pwInputs = document.querySelectorAll('input[type="password"]');
  for (let i = 0; i < pwInputs.length && i < 16; i++) {
    const rect = pwInputs[i].getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      hasVisiblePasswordInput = true;
      break;
    }
  }

  let hasPaymentInput = false;
  const payInputs = document.querySelectorAll(
    'input[autocomplete*="cc-number"], input[autocomplete*="cc-csc"], input[autocomplete*="cc-exp"]'
  );
  for (let i = 0; i < payInputs.length && i < 16; i++) {
    const rect = payInputs[i].getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      hasPaymentInput = true;
      break;
    }
  }

  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]');
  let hasClientSecretModal = false;
  let hasOAuthConsentPrompt = false;
  for (let i = 0; i < dialogs.length && i < 8; i++) {
    const text = String(dialogs[i].textContent || '').slice(0, 1200);
    if (/(?:oauth\\s+client\\s+created|your\\s+client\\s+secret|client\\s+secret[\\s\\S]{0,120}download\\s+json)/i.test(text)) {
      hasClientSecretModal = true;
    }
    if (/(?:wants\\s+to\\s+access\\s+your\\s+google\\s+account|grant\\s+access|choose\\s+what\\s+.*can\\s+access)/i.test(text)) {
      hasOAuthConsentPrompt = true;
    }
  }

  if (!hasOAuthConsentPrompt) {
    const headingText = Array.from(document.querySelectorAll('h1, h2'))
      .slice(0, 6)
      .map((el) => String(el.textContent || ''))
      .join(' ')
      .slice(0, 600);
    if (/(?:wants\\s+to\\s+access\\s+your\\s+google\\s+account|choose\\s+what\\s+.*can\\s+access)/i.test(headingText)) {
      hasOAuthConsentPrompt = true;
    }
  }

  return {
    title: String(document.title || '').slice(0, 300),
    url: String(location.href || '').slice(0, 2048),
    readyState: String(document.readyState || ''),
    passwordFocused,
    hasVisiblePasswordInput,
    hasClientSecretModal,
    hasOAuthConsentPrompt,
    hasPaymentInput,
    activeTagName,
    activeInputType,
  };
})()`;

// Fixed, read-only expression used only to obtain a CDP RemoteObjectId for `document`
// so `Runtime.callFunctionOn` can invoke fixed probe functions with structured arguments.
export const INTERNAL_DOCUMENT_HANDLE_EXPRESSION = 'document';

// Fixed, reusable, read-only DOM condition check for `act.wait`.
// Invoked ONLY via `Runtime.callFunctionOn` with structured CDP arguments (never string
// interpolation of user input). Returns only bounded booleans and `document.readyState`;
// NEVER returns page text, element values, or DOM content.
export const INTERNAL_WAIT_CONDITION_FUNCTION = `function(params) {
  const doc = this && typeof this.querySelectorAll === 'function'
    ? this
    : (typeof document !== 'undefined' ? document : null);
  const win = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
  const opts = params && typeof params === 'object' ? params : {};
  const readyState = doc && typeof doc.readyState === 'string' ? doc.readyState : '';

  const isElementVisible = (el, nestedDepth = 0) => {
    if (!el || !el.isConnected || nestedDepth >= 8) return false;
    const style = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    if (style) {
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden'
      ) {
        return false;
      }
      if (parseFloat(style.opacity) === 0) return false;

      let cur = el.parentElement;
      let depth = 0;
      while (cur && depth < 64) {
        const pStyle = win.getComputedStyle(cur);
        if (pStyle) {
          if (pStyle.display === 'none' || pStyle.contentVisibility === 'hidden') return false;
          if (parseFloat(pStyle.opacity) === 0) return false;
        }
        cur = cur.parentElement;
        depth += 1;
      }

      if (style.display === 'contents') {
        const children = el.children;
        if (!children || children.length === 0) return false;
        const childLimit = Math.min(children.length, 32);
        for (let i = 0; i < childLimit; i++) {
          if (isElementVisible(children[i], nestedDepth + 1)) return true;
        }
        return false;
      }
    }

    const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : null;
    if (rects && rects.length === 0) return false;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };

  let selectorInvalid = false;
  let selectorMatched = true;
  if (typeof opts.selector === 'string' && opts.selector.length > 0) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      selectorMatched = false;
    } else {
      const targetState = opts.state === 'hidden' ? 'hidden' : 'visible';
      let nodes;
      try {
        nodes = doc.querySelectorAll(opts.selector);
      } catch {
        return {
          readyState,
          selectorInvalid: true,
          urlMatched: false,
          selectorMatched: false,
          textMatched: false,
        };
      }
      let anyVisible = false;
      for (let i = 0; i < nodes.length; i++) {
        if (isElementVisible(nodes[i], 0)) {
          anyVisible = true;
          break;
        }
      }
      selectorMatched = targetState === 'hidden' ? !anyVisible : anyVisible;
    }
  }

  let textMatched = true;
  if (typeof opts.text === 'string' && opts.text.length > 0) {
    const root = doc ? (doc.body || doc.documentElement) : null;
    const visibleText = root && typeof root.innerText === 'string' ? root.innerText : '';
    textMatched = visibleText.includes(opts.text);
  }

  return {
    readyState,
    selectorInvalid,
    urlMatched: opts.url === undefined || doc.URL === opts.url,
    selectorMatched,
    textMatched,
  };
}`;

// Fixed internal element helper functions (never caller-supplied JS), adapted from
// Orca's safe element fill/select semantics with password/file guards.
export const INTERNAL_FILL_ELEMENT_FUNCTION = `function(value) {
  if (!(this instanceof Element)) return 'target is not an element';
  const tag = this.tagName.toLowerCase();
  if (tag === 'input') {
    const type = String(this.type || 'text').toLowerCase();
    if (type === 'password') return 'cannot fill password input via bot';
    if (type === 'file') return 'cannot fill file input';
    if (this.disabled || this.readOnly) return 'element is disabled or read-only';
    this.focus();
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (proto && proto.set) proto.set.call(this, value);
    else this.value = value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }
  if (tag === 'textarea') {
    if (this.disabled || this.readOnly) return 'element is disabled or read-only';
    this.focus();
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (proto && proto.set) proto.set.call(this, value);
    else this.value = value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }
  if (this.isContentEditable) {
    this.focus();
    this.textContent = value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    return null;
  }
  return 'element is not fillable';
}`;

export const INTERNAL_SELECT_OPTION_FUNCTION = `function(optionValue) {
  if (!(this instanceof HTMLSelectElement)) return 'element is not a <select>';
  if (this.disabled) return 'select element is disabled';
  const target = String(optionValue);
  let matched = null;
  for (const option of Array.from(this.options)) {
    if (option.value === target || option.label === target || option.text.trim() === target) {
      matched = option;
      break;
    }
  }
  if (!matched) return 'option not found';
  if (matched.disabled) return 'option is disabled';
  this.value = matched.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return null;
}`;

export const INTERNAL_ELEMENT_META_FUNCTION = `function() {
  if (!(this instanceof Element)) return null;
  const tag = this.tagName.toLowerCase();
  const type = tag === 'input' ? String(this.type || '').toLowerCase() : '';
  const checked = tag === 'input' && (type === 'checkbox' || type === 'radio')
    ? Boolean(this.checked)
    : this.getAttribute('aria-checked') === 'true';
  const disabled = Boolean(this.disabled) || this.getAttribute('aria-disabled') === 'true';
  return { tag, type, checked, disabled };
}`;
