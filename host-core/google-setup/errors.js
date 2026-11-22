// host-core/google-setup/errors.js
// Typed errors and secret-boundary validation for the PiBot Google setup wizard.
// No credential, OAuth callback code, refresh token, or raw page body may ever
// enter setup state, persistence, logs, or error reflections.

export const SETUP_ERROR_CODES = Object.freeze([
  'INVALID_ARGUMENT',
  'BOT_NOT_FOUND',
  'BOT_ARCHIVED',
  'BOT_CONTEXT_REQUIRED',
  'SETUP_FORBIDDEN',
  'SETUP_NOT_RUNNING',
  'SETUP_ADMIN_REQUIRED',
  'SETUP_MODE_UNAVAILABLE',
  'SETUP_REVISION_CONFLICT',
  'SETUP_STALE_CARD',
  'SETUP_PROJECT_ID_REQUIRED',
  'SETUP_SENSITIVE_LOCKED',
  'SETUP_CENTER_UNAVAILABLE',
  'SETUP_NOT_READY',
  'SETUP_SECRET_REJECTED',
  'SETUP_CLOSED',
  'STORE_FAILED',
]);

export const SETUP_ERROR_CODE_SET = new Set(SETUP_ERROR_CODES);

export class GoogleSetupError extends Error {
  constructor(code, message, extra = undefined) {
    super(message);
    this.name = 'GoogleSetupError';
    this.code = SETUP_ERROR_CODE_SET.has(code) ? code : 'INVALID_ARGUMENT';
    if (extra && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) this[key] = value;
      }
    }
  }
}

export function setupError(code, message, extra = undefined) {
  return new GoogleSetupError(code, message, extra);
}

// Patterns that indicate OAuth credentials, tokens, or callback URLs which must
// never be accepted or persisted in the setup wizard state.
const SECRET_PATTERNS = [
  /\bGOCSPX-[A-Za-z0-9_-]{8,}\b/,
  /\bya29\.[A-Za-z0-9._-]{16,}\b/,
  /\b1\/\/[A-Za-z0-9._-]{16,}\b/,
  /["']?client_secret["']?\s*[:=]\s*["']?[^\s"',}]{4,}/i,
  /["']?refresh_token["']?\s*[:=]\s*["']?[^\s"',}]{4,}/i,
  /["']?access_token["']?\s*[:=]\s*["']?[^\s"',}]{4,}/i,
  /[?&](?:code|access_token|id_token|refresh_token|client_secret)=[^&\s]{4,}/i,
  /\/api\/oauth\/google\/callback\?[^\s]*\b(?:code|state)=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function containsSecretMaterial(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertNoSecretMaterial(value, fieldName = 'input') {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) {
      throw setupError('INVALID_ARGUMENT', `${fieldName} contains malformed UTF-16 surrogates`);
    }
    if (containsSecretMaterial(value)) {
      throw setupError(
        'SETUP_SECRET_REJECTED',
        `Credentials, OAuth tokens, and callback URLs must not be submitted through ${fieldName}. Use the private Center configuration control or system browser instead.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretMaterial(item, fieldName);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      if (
        lowered === 'clientsecret' ||
        lowered === 'client_secret' ||
        lowered === 'refreshtoken' ||
        lowered === 'refresh_token' ||
        lowered === 'accesstoken' ||
        lowered === 'access_token' ||
        lowered === 'authorizationcode' ||
        lowered === 'codeverifier' ||
        lowered === 'code_verifier' ||
        lowered === 'callbackurl' ||
        lowered === 'callback_url' ||
        lowered === 'pagebody' ||
        lowered === 'pagehtml' ||
        lowered === 'cookies'
      ) {
        throw setupError(
          'SETUP_SECRET_REJECTED',
          `Field "${key}" is not allowed in setup progress. Credentials and OAuth callbacks stay on the trusted Center channel.`,
        );
      }
      assertNoSecretMaterial(item, `${fieldName}.${key}`);
    }
  }
}

export function scrubNonSensitiveText(value, maxLength = 500) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.isWellFormed()) return undefined;
  if (containsSecretMaterial(trimmed)) return '[redacted]';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function assertNonEmptyString(value, fieldName, maxLength = 320) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw setupError(
      'INVALID_ARGUMENT',
      `${fieldName} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value.trim();
}
