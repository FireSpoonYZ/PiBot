// host-core/bot-browser/policy.js
// Security policy and Privacy Shield for Bot Browser:
// - URL scheme / destination validation (no file:, javascript:, chrome:, credentialed URLs, or internal UI origins)
// - Sensitive page detection (OAuth, MFA, Google Cloud OAuth Clients / Secret creation, password/payment, policy consent)
// - Pre-action interception before clicking Terms/Policy checkboxes or Create OAuth Client / Secret dialogs
// - Defense-in-depth secret leak scanning and URL/tab redaction
//
// Portions of the Google Cloud client-page and withheld-page-text boundary semantics are adapted from
// stablyai/orca (v1.4.265, MIT License, Copyright (c) 2026 Lovecast Inc.).
import {
  BROWSER_MAX_SNAPSHOT_TEXT_BYTES,
  browserError,
  isPlainObject,
} from './protocol.js';

const MAX_URL_BYTES = 4096;

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'tauri.localhost',
]);

const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'oauth2.googleapis.com',
  'gds.google.com',
  'signin.aws.amazon.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
]);

const GOOGLE_WEB_LOGIN_HOSTS = new Set([
  'accounts.google.com',
  'myaccount.google.com',
  'mail.google.com',
  'calendar.google.com',
  'drive.google.com',
  'docs.google.com',
]);

const PAYMENT_HOSTS = new Set([
  'pay.google.com',
  'payments.google.com',
  'checkout.stripe.com',
  'billing.stripe.com',
]);

const AUTH_PATH_RE = /\/(o\/oauth2|oauth2?\/authorize|oauth\/consent|signin|serviceLogin|v3\/signin|challenge\/|mfa|2fa|two-factor|totp|webauthn|passkey|sso|saml|api\/oauth\/google\/callback)(\/|$|\?)/i;
const GOOGLE_OAUTH_PATH_RE = /^\/(?:o\/oauth2|signin\/oauth|v\d+\/signin\/oauth|consent)(\/|$)/i;
const GOOGLE_SIGN_IN_REJECTED_PATH_RE = /^\/(?:v\d+\/)?signin\/rejected\/?$/i;
const PAYMENT_PATH_RE = /\/(checkout|billing\/pay|payment-method|payments|credit-card|card-details)(\/|$|\?)/i;
const SECRET_CONSOLE_PATH_RE = /^\/(auth\/clients|apis\/credentials|iam-admin\/serviceaccounts|security\/secret-manager)(\/|$)/i;

const POLICY_CONSENT_RE = /(user\s+data\s+policy|google\s+api\s+services.*policy|terms\s+of\s+service|terms\s+and\s+conditions|privacy\s+policy|i\s+agree|accept\s+terms|agree\s+to\s+the|用户数据政策|服务条款|隐私政策|我同意|同意条款|接受条款)/i;
const SECRET_CREATE_OR_REVEAL_RE = /(create\s+oauth|create\s+client|create\s+credentials|download\s+json|client\s+secret|show\s+secret|reveal\s+secret|copy\s+secret|generate\s+key|create\s+key|创建客户端|创建凭据|创建密钥|下载\s*json|显示密钥|复制密钥|密钥)/i;
const SENSITIVE_FIELD_RE = /(password|passcode|passphrase|one[\s-]?time|otp|2fa|mfa|verification\s+code|auth\s+code|client[\s_]?secret|api[\s_]?key|private[\s_]?key|credit\s+card|card\s+number|cvv|cvc|security\s+code|密码|口令|验证码|安全码|密钥)/i;
const OAUTH_CONSENT_ACTION_RE = /(sign\s+in\s+with\s+google|continue\s+with\s+google|grant\s+access|allow\s+access|authorize\s+app|approve\s+access|oauth\s+consent|登录\s*google|授权访问|允许访问)/i;

const SENSITIVE_QUERY_KEYS = new Set([
  'code',
  'state',
  'access_token',
  'id_token',
  'refresh_token',
  'client_secret',
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'key',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'session',
  'session_id',
  'cookie',
  'sig',
  'signature',
  'credential',
  'oauth_token',
  'oauth_verifier',
]);

// Defense-in-depth patterns for secrets that must NEVER enter model context or logs.
const SECRET_LEAK_PATTERNS = [
  /\bGOCSPX-[A-Za-z0-9_-]{12,}\b/,
  /"client_secret"\s*:\s*"[^"]{8,}"/i,
  /"refresh_token"\s*:\s*"[^"]{12,}"/i,
  /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/,
];

function parseUrlSafe(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.tauri.localhost')) return true;
  return false;
}

/**
 * Adapted from stablyai/orca `isGoogleClientsPage` (MIT, Copyright (c) 2026 Lovecast Inc.):
 * Google Cloud Console pages where OAuth clients are created and client secrets are shown.
 */
export function isGoogleClientsPage(url) {
  const parsed = parseUrlSafe(url);
  if (!parsed) return false;
  return (
    parsed.origin === 'https://console.cloud.google.com' &&
    SECRET_CONSOLE_PATH_RE.test(parsed.pathname)
  );
}

export function isGoogleCloudConsoleUrl(url) {
  const parsed = parseUrlSafe(url);
  return parsed !== null && parsed.origin === 'https://console.cloud.google.com';
}

export function isAuthOrOAuthUrl(url) {
  const parsed = parseUrlSafe(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (AUTH_HOSTS.has(host)) return true;
  if (host === 'github.com' && /^\/(login|sessions\/two-factor|login\/oauth\/authorize)(\/|$)/i.test(parsed.pathname)) {
    return true;
  }
  return AUTH_PATH_RE.test(parsed.pathname + parsed.search);
}

export function isGoogleApiOAuthUrl(url) {
  const parsed = parseUrlSafe(url);
  return parsed !== null && (
    parsed.hostname === 'oauth2.googleapis.com' ||
    (parsed.hostname === 'accounts.google.com' && GOOGLE_OAUTH_PATH_RE.test(parsed.pathname))
  );
}

function isGoogleSignInRejected(parsed) {
  return parsed?.origin === 'https://accounts.google.com' &&
    !parsed.username && !parsed.password && GOOGLE_SIGN_IN_REJECTED_PATH_RE.test(parsed.pathname);
}

export function isPaymentUrl(url) {
  const parsed = parseUrlSafe(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (PAYMENT_HOSTS.has(host)) return true;
  if (host === 'www.paypal.com' && /^\/(checkout|signin|webapps\/hermes)/i.test(parsed.pathname)) {
    return true;
  }
  return PAYMENT_PATH_RE.test(parsed.pathname);
}

/**
 * Validates navigation URLs for both bot and human actors.
 * Rejects file:, javascript:, data:, blob:, chrome:, edge:, devtools:, credentialed URLs,
 * PiBot internal UI origins, and cloud metadata endpoints.
 * For actor === 'bot', additionally blocks direct navigation to OAuth/sign-in and
 * Google Cloud secret-creation pages BEFORE navigation occurs.
 */
export function validateNavigationUrl(rawUrl, { actor = 'bot', allowBlank = false } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.isWellFormed()) {
    throw browserError('BROWSER_URL_BLOCKED', 'Navigation URL must be a well-formed string');
  }
  const trimmed = rawUrl.trim();
  if (trimmed === '' || Buffer.byteLength(trimmed, 'utf8') > MAX_URL_BYTES) {
    throw browserError('BROWSER_URL_BLOCKED', 'Navigation URL is empty or exceeds 4096 bytes');
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw browserError('BROWSER_URL_BLOCKED', 'Navigation URL must not contain control characters');
  }
  if (allowBlank && trimmed === 'about:blank') {
    return 'about:blank';
  }
  const parsed = parseUrlSafe(trimmed);
  if (!parsed) {
    throw browserError('BROWSER_URL_BLOCKED', 'Navigation URL is malformed');
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw browserError(
      'BROWSER_URL_BLOCKED',
      `URL scheme "${parsed.protocol}" is forbidden (only http: and https: are allowed)`
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw browserError('BROWSER_URL_BLOCKED', 'URLs with embedded credentials are forbidden');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw browserError('BROWSER_URL_BLOCKED', 'Navigation to internal UI or metadata hosts is forbidden');
  }

  if (actor === 'bot') {
    if (isAuthOrOAuthUrl(parsed.href)) {
      const googleSignInRejected = isGoogleSignInRejected(parsed);
      throw browserError(
        'BROWSER_SENSITIVE_BLOCKED',
        'Sign-in, MFA, and OAuth consent require human control.',
        {
          reason: googleSignInRejected ? 'google_sign_in_rejected' : 'oauth_auth_page',
          fallbackToSystemBrowser: googleSignInRejected || isGoogleApiOAuthUrl(parsed.href),
        }
      );
    }
    if (isGoogleClientsPage(parsed.href)) {
      throw browserError(
        'BROWSER_SECRET_STEP_BLOCKED',
        'Bot cannot navigate directly to Google Cloud OAuth Client / secret pages; hand off to human owner or system browser before creating secrets.',
        { reason: 'secret_creation_boundary', fallbackToSystemBrowser: true }
      );
    }
    if (isPaymentUrl(parsed.href)) {
      throw browserError(
        'BROWSER_SENSITIVE_BLOCKED',
        'Bot cannot navigate to payment or checkout pages; human takeover is required.',
        { reason: 'payment_page', fallbackToSystemBrowser: false }
      );
    }
  }

  return parsed.href;
}

/**
 * Classifies current page sensitivity and Privacy Shield restrictions.
 * Enforces:
 * - OAuth / MFA / sign-in: blocks bot observe/act, blocks handback, blocks bystanders
 * - Cloud Console Client Secret pages / dialogs: blocks bot observe/act, blocks handback, blocks bystanders,
 *   AND blocks normal frame streaming (`blockNormalFrame: true`)
 * - Policy/Terms consent: blocks bot act, blocks handback, allows owner takeover on the same page
 * - Password / OTP / Payment: blocks bot observe/act, blocks handback, blocks bystanders
 * - Web Google login vs Center Google API MCP notice (`webLoginNotApiGrant`)
 */
/**
 * Synthesizes canonical sensitivity hints from desktop-provider (`sensitiveCategory`,
 * `authUseSystemBrowser`) and android-provider (`requiresSystemBrowser`, `sensitiveReason`)
 * fields alongside any explicit `hints` object.
 */
export function mergeProviderHints(result, baseHints = null) {
  const out = isPlainObject(baseHints) ? { ...baseHints } : {};
  if (!isPlainObject(result)) return Object.keys(out).length > 0 ? out : null;
  if (isPlainObject(result.hints)) {
    Object.assign(out, result.hints);
  }
  const cat = typeof result.sensitiveCategory === 'string'
    ? result.sensitiveCategory.trim().toLowerCase()
    : '';
  if (cat === 'client_secret' || cat === 'secret_dialog' || cat === 'secret_key' || cat === 'secret') {
    out.secretDialogVisible = true;
  } else if (cat === 'oauth_consent' || cat === 'oauth_login' || cat === 'oauth' || cat === 'mfa' || cat === 'auth') {
    out.isOAuthConsent = true;
  } else if (cat === 'google_auth' || cat === 'auth_mfa') {
    out.isLoginPage = true;
  } else if (cat === 'password_input' || cat === 'password' || cat === 'otp') {
    out.hasPasswordInput = true;
  } else if (cat === 'payment' || cat === 'checkout' || cat === 'billing') {
    out.isPaymentPage = true;
  } else if (cat === 'policy_consent' || cat === 'terms' || cat === 'tos') {
    out.hasPolicyCheckbox = true;
  }
  if (typeof result.authUseSystemBrowser === 'boolean' || typeof result.requiresSystemBrowser === 'boolean') {
    out.requiresSystemBrowser = result.authUseSystemBrowser === true || result.requiresSystemBrowser === true;
  }
  if (result.sensitive === true) {
    out.sensitive = true;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function classifyPageSensitivity({
  url = '',
  title = '',
  hints = null,
  providerSensitive = false,
  botId = null,
  pageId = null,
  isPageWithheld = null,
} = {}) {
  const safeHints = isPlainObject(hints) ? hints : {};
  const parsed = parseUrlSafe(url);
  const host = parsed ? parsed.hostname.toLowerCase() : '';
  const reasons = [];

  const googleApiOAuth = isGoogleApiOAuthUrl(url);
  const googleSignInRejected = isGoogleSignInRejected(parsed);
  if (googleSignInRejected) reasons.push('google_sign_in_rejected');
  const requiresSystemBrowser = safeHints.requiresSystemBrowser === true;
  const oauthOrAuth =
    isAuthOrOAuthUrl(url) ||
    googleApiOAuth ||
    requiresSystemBrowser ||
    safeHints.isOAuthConsent === true ||
    safeHints.isMfaChallenge === true ||
    safeHints.isLoginPage === true;
  if (oauthOrAuth) reasons.push('oauth_or_auth');

  const secretRisk =
    isGoogleClientsPage(url) ||
    safeHints.secretDialogVisible === true ||
    safeHints.clientSecretVisible === true ||
    safeHints.hasSecretText === true;
  if (secretRisk) reasons.push('secret_risk');

  const policyConsent =
    safeHints.hasPolicyCheckbox === true ||
    safeHints.hasTermsConsent === true ||
    (isGoogleCloudConsoleUrl(url) && POLICY_CONSENT_RE.test(title));
  if (policyConsent) reasons.push('policy_consent');

  const passwordOrOtp =
    safeHints.hasPasswordInput === true ||
    safeHints.passwordFocused === true ||
    safeHints.hasOtpInput === true;
  if (passwordOrOtp) reasons.push('password_or_otp');

  const payment = isPaymentUrl(url) || safeHints.isPaymentPage === true || safeHints.isCheckout === true;
  if (payment) reasons.push('payment');

  let externallyWithheld = false;
  if (typeof isPageWithheld === 'function') {
    try {
      externallyWithheld = Boolean(isPageWithheld({ botId, pageId, url, title }));
    } catch {
      // Fail-closed if a registered security predicate throws.
      externallyWithheld = true;
    }
  }
  if (externallyWithheld) reasons.push('withheld_predicate');

  if (providerSensitive === true || safeHints.sensitive === true) {
    reasons.push('provider_sensitive');
  }

  const webLoginNotApiGrant =
    GOOGLE_WEB_LOGIN_HOSTS.has(host) ||
    (oauthOrAuth && host.endsWith('.google.com'));

  const sensitive =
    oauthOrAuth ||
    secretRisk ||
    policyConsent ||
    passwordOrOtp ||
    payment ||
    externallyWithheld ||
    providerSensitive === true ||
    safeHints.sensitive === true;

  // Policy consent on Cloud Console allows the owner to view and take over the same form,
  // while blocking bot clicks and handback. All other sensitive classes block bot observation too.
  const blockBotObserve =
    oauthOrAuth ||
    secretRisk ||
    passwordOrOtp ||
    payment ||
    externallyWithheld ||
    providerSensitive === true ||
    safeHints.sensitive === true;

  const blockBotAct = sensitive;
  const blockHandback = sensitive;
  const blockBystanderFrame = blockBotObserve;
  const blockNormalFrame = secretRisk;
  const fallbackToSystemBrowser = googleSignInRejected || googleApiOAuth || requiresSystemBrowser || secretRisk;

  let guidance = null;
  if (secretRisk) {
    guidance = 'Client Secret creation/display is isolated from bot observation and normal frames. Complete this step in your system browser and enter credentials via the private Center configuration card.';
  } else if (googleSignInRejected) {
    guidance = 'Google denied sign-in in this browser. Sign in to Google Cloud Console in a supported system browser, then return to setup.';
  } else if (googleApiOAuth) {
    guidance = 'Complete Google API authorization in your system browser.';
  } else if (requiresSystemBrowser) {
    guidance = 'Continue this step in your system browser.';
  } else if (oauthOrAuth) {
    guidance = 'Take over this page to sign in, verify your identity, or review consent. The Bot stays paused.';
  } else if (policyConsent) {
    guidance = 'Please take over this page to review and accept the policy/terms checkbox yourself, then hand back to the bot.';
  } else if (passwordOrOtp) {
    guidance = 'Password or verification code entry is protected by Privacy Shield and requires direct human control.';
  } else if (payment) {
    guidance = 'Payment and billing pages require direct human control.';
  } else if (sensitive) {
    guidance = 'This page is marked sensitive; bot observation and actions are paused.';
  } else if (webLoginNotApiGrant) {
    guidance = 'Web login inside the Bot browser is isolated from Center Google API grants (Google API grant != web login).';
  }

  return Object.freeze({
    sensitive,
    secretRisk,
    oauthOrAuth,
    policyConsent,
    passwordOrOtp,
    payment,
    webLoginNotApiGrant,
    reasons: Object.freeze(reasons),
    blockBotObserve,
    blockBotAct,
    blockHandback,
    blockBystanderFrame,
    blockNormalFrame,
    fallbackToSystemBrowser,
    guidance,
  });
}

function refMetadataText(refMeta) {
  if (!isPlainObject(refMeta)) return '';
  return [
    refMeta.role,
    refMeta.name,
    refMeta.label,
    refMeta.text,
    refMeta.placeholder,
    refMeta.ariaLabel,
    refMeta.inputType,
    refMeta.type,
  ]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .join(' ');
}

/**
 * Pre-action policy check run BEFORE dispatching a bot `act` to the provider.
 * Stops BEFORE clicking Terms/User Data Policy checkboxes, BEFORE clicking Create OAuth Client /
 * Download JSON / Show Secret, and BEFORE interacting with password/OTP/OAuth consent elements.
 */
export function checkBotActionSensitivity({
  act,
  pageUrl = '',
  pageTitle = '',
  hints = null,
  providerSensitive = false,
  targetRefMeta = null,
  isPageWithheld = null,
  botId = null,
  pageId = null,
}) {
  const pageSensitivity = classifyPageSensitivity({
    url: pageUrl,
    title: pageTitle,
    hints,
    providerSensitive,
    botId,
    pageId,
    isPageWithheld,
  });

  if (pageSensitivity.secretRisk) {
    return {
      allowed: false,
      code: 'BROWSER_SECRET_STEP_BLOCKED',
      reason: 'secret_creation_boundary',
      holdSession: true,
      fallbackToSystemBrowser: true,
      guidance: pageSensitivity.guidance,
    };
  }
  if (pageSensitivity.blockBotAct) {
    return {
      allowed: false,
      code: 'BROWSER_SENSITIVE_BLOCKED',
      reason: pageSensitivity.reasons[0] ?? 'sensitive_page',
      holdSession: true,
      fallbackToSystemBrowser: pageSensitivity.fallbackToSystemBrowser,
      guidance: pageSensitivity.guidance,
    };
  }

  const refText = refMetadataText(targetRefMeta);
  const inputType = typeof targetRefMeta?.inputType === 'string'
    ? targetRefMeta.inputType.toLowerCase()
    : (typeof targetRefMeta?.type === 'string' ? targetRefMeta.type.toLowerCase() : '');

  // 1. Password / OTP / Secret / Payment fields: never allow bot fill/type/click.
  if (
    inputType === 'password' ||
    ((act.kind === 'fill' || act.kind === 'type' || act.kind === 'click') && SENSITIVE_FIELD_RE.test(refText))
  ) {
    return {
      allowed: false,
      code: 'BROWSER_SENSITIVE_BLOCKED',
      reason: 'sensitive_input_field',
      holdSession: true,
      fallbackToSystemBrowser: false,
      guidance: 'Password, OTP, API key, secret, or payment fields cannot be filled or read by the bot; human takeover required.',
    };
  }

  // 2. Policy / Terms of Service / Google API Services User Data Policy checkbox or accept button.
  if (
    (act.kind === 'click' || act.kind === 'dblclick' || act.kind === 'press') &&
    POLICY_CONSENT_RE.test(refText)
  ) {
    return {
      allowed: false,
      code: 'BROWSER_SENSITIVE_BLOCKED',
      reason: 'policy_consent_required',
      holdSession: true,
      fallbackToSystemBrowser: false,
      guidance: 'Terms of service and Google API Services User Data Policy must be reviewed and checked by the human owner. Please take over this page.',
    };
  }

  // 3. Before clicking Create / Download JSON / Reveal Secret on Google Cloud Console.
  const isProjectCreateButton = typeof targetRefMeta?.name === 'string' &&
    /^create$/i.test(targetRefMeta.name.trim()) &&
    parseUrlSafe(pageUrl)?.pathname === '/projectcreate';
  if (
    isGoogleCloudConsoleUrl(pageUrl) &&
    (act.kind === 'click' || act.kind === 'dblclick' || act.kind === 'press') &&
    (SECRET_CREATE_OR_REVEAL_RE.test(refText) || (!isProjectCreateButton && /\bcreate\b/i.test(refText)))
  ) {
    return {
      allowed: false,
      code: 'BROWSER_SECRET_STEP_BLOCKED',
      reason: 'secret_creation_boundary',
      holdSession: true,
      fallbackToSystemBrowser: true,
      guidance: 'Bot stopped before creating or revealing OAuth Client Secret. Complete this step directly with bot observation disabled or in your system browser.',
    };
  }

  // 4. OAuth sign-in / consent actions anywhere.
  if (
    (act.kind === 'click' || act.kind === 'dblclick' || act.kind === 'press') &&
    OAUTH_CONSENT_ACTION_RE.test(refText)
  ) {
    return {
      allowed: false,
      code: 'BROWSER_SENSITIVE_BLOCKED',
      reason: 'oauth_consent_forbidden',
      holdSession: true,
      fallbackToSystemBrowser: isGoogleApiOAuthUrl(pageUrl),
      guidance: 'The owner must take over to sign in or approve access.',
    };
  }

  return { allowed: true };
}

/** Strips sensitive query parameters and fragment from URLs returned to models, logs, or events. */
export function sanitizeUrlForModel(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return '';
  if (rawUrl === 'about:blank') return 'about:blank';
  const parsed = parseUrlSafe(rawUrl);
  if (!parsed) return '';
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return '[redacted-url]';

  const clean = new URL(parsed.origin + parsed.pathname);
  if (isGoogleSignInRejected(parsed)) return clean.href;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      clean.searchParams.set(key, '[redacted]');
    } else {
      clean.searchParams.append(key, value);
    }
  }
  return clean.href;
}

/** Defense-in-depth scanner to ensure raw secrets never leak into model snapshots. */
export function containsSecretLeak(text) {
  if (typeof text !== 'string' || text === '') return false;
  return SECRET_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function extractSnapshotRefMap(rawRefs) {
  const map = new Map();
  if (!rawRefs) return map;
  if (Array.isArray(rawRefs)) {
    for (const entry of rawRefs) {
      if (!isPlainObject(entry) || typeof entry.ref !== 'string' || entry.ref.trim() === '') continue;
      map.set(entry.ref.trim(), {
        role: typeof entry.role === 'string' ? entry.role : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        label: typeof entry.label === 'string' ? entry.label : '',
        text: typeof entry.text === 'string' ? entry.text : '',
        inputType: typeof entry.inputType === 'string' ? entry.inputType : (typeof entry.type === 'string' ? entry.type : ''),
        placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
        ariaLabel: typeof entry.ariaLabel === 'string' ? entry.ariaLabel : '',
      });
    }
    return map;
  }
  if (isPlainObject(rawRefs)) {
    for (const [ref, entry] of Object.entries(rawRefs)) {
      if (!isPlainObject(entry) || ref.trim() === '') continue;
      map.set(ref.trim(), {
        role: typeof entry.role === 'string' ? entry.role : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        label: typeof entry.label === 'string' ? entry.label : '',
        text: typeof entry.text === 'string' ? entry.text : '',
        inputType: typeof entry.inputType === 'string' ? entry.inputType : (typeof entry.type === 'string' ? entry.type : ''),
        placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
        ariaLabel: typeof entry.ariaLabel === 'string' ? entry.ariaLabel : '',
      });
    }
  }
  return map;
}

/**
 * Validates and sanitizes a provider snapshot before returning to the bot model.
 * Withholds all DOM text/refs on sensitive pages or if defense-in-depth detects secret material.
 */
export function sanitizeSnapshotForBot(rawSnapshot, sensitivity) {
  if (sensitivity.blockBotObserve) {
    return {
      blocked: true,
      code: sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
      reason: sensitivity.reasons[0] ?? 'sensitive_page',
      fallbackToSystemBrowser: sensitivity.fallbackToSystemBrowser,
      guidance: sensitivity.guidance,
    };
  }

  const rawText = typeof rawSnapshot?.snapshot === 'string'
    ? rawSnapshot.snapshot
    : (typeof rawSnapshot?.text === 'string'
      ? rawSnapshot.text
      : (rawSnapshot?.tree !== undefined ? JSON.stringify(rawSnapshot.tree) : ''));

  if (containsSecretLeak(rawText) || containsSecretLeak(rawSnapshot?.title ?? '')) {
    return {
      blocked: true,
      code: 'BROWSER_SECRET_STEP_BLOCKED',
      reason: 'secret_material_detected',
      fallbackToSystemBrowser: true,
      guidance: 'Sensitive credential/secret text was detected on this page and withheld from the bot.',
    };
  }

  const refMap = extractSnapshotRefMap(rawSnapshot?.refs);
  for (const meta of refMap.values()) {
    if (containsSecretLeak(meta.text) || containsSecretLeak(meta.name)) {
      return {
        blocked: true,
        code: 'BROWSER_SECRET_STEP_BLOCKED',
        reason: 'secret_material_detected',
        fallbackToSystemBrowser: true,
        guidance: 'Sensitive credential/secret text was detected in page elements and withheld from the bot.',
      };
    }
  }

  let text = rawText;
  let truncated = Boolean(rawSnapshot?.truncated);
  if (Buffer.byteLength(text, 'utf8') > BROWSER_MAX_SNAPSHOT_TEXT_BYTES) {
    // Truncate cleanly on UTF-8 byte boundary.
    const buf = Buffer.from(text, 'utf8').subarray(0, BROWSER_MAX_SNAPSHOT_TEXT_BYTES - 64);
    text = buf.toString('utf8') + '\n...[truncated; use compact/depth/selector]';
    truncated = true;
  }

  return {
    blocked: false,
    text,
    truncated,
    refMap,
  };
}

/** Redacts sensitive tab titles/URLs for bots and non-privileged bystander viewers. */
export function sanitizeTabsForCaller(tabs, { isBot = false, canViewSensitive = false, isPageWithheld = null, botId = null } = {}) {
  return tabs.map((tab) => {
    const sens = classifyPageSensitivity({
      url: tab.url,
      title: tab.title,
      botId,
      pageId: tab.id,
      isPageWithheld,
    });
    if (isBot && sens.blockBotObserve) {
      return {
        id: tab.id,
        title: '[Sensitive page — hidden from bot]',
        url: sanitizeUrlForModel(tab.url).split('?')[0],
      };
    }
    if (!canViewSensitive && sens.blockBystanderFrame) {
      return {
        id: tab.id,
        title: '[Sensitive page]',
        url: sanitizeUrlForModel(tab.url).split('?')[0],
      };
    }
    return {
      id: tab.id,
      title: tab.title,
      url: isBot || sens.reasons.includes('google_sign_in_rejected') ? sanitizeUrlForModel(tab.url) : tab.url,
    };
  });
}
