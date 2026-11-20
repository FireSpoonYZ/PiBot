// Adapted from stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea (MIT License, Copyright (c) 2026 Lovecast Inc.)
// Adapted for PiBot Center Web OAuth token exchange, refresh, revoke, key probe, and strict OIDC ID token checks.
//
// All Google OAuth calls go strictly to hardcoded Google endpoints with redirects disabled.
// Client-file auth_uri / token_uri values are never used.

import { createHash, randomBytes } from 'node:crypto';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_ALLOWED_ISSUERS = Object.freeze(
  new Set(['https://accounts.google.com', 'accounts.google.com'])
);

export const GOOGLE_SIGN_IN_TTL_MS = 5 * 60 * 1000;
export const GOOGLE_REFRESH_AHEAD_MS = 5 * 60 * 1000;

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const KEY_CHECK_TIMEOUT_MS = 10_000;
const ID_TOKEN_CLOCK_SKEW_SEC = 5 * 60;

const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const SUB_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CLIENT_GONE_ERRORS = new Set(['invalid_client', 'deleted_client', 'disabled_client']);

export const GRANT_ENDED_ERRORS = Object.freeze({
  invalid_grant: 'Google access ended (revoked, expired, or password changed). Reconnect this account in Center.',
  invalid_client: 'The Google OAuth client this account signed in with was deleted or changed. Reconnect this account in Center.',
  unauthorized_client: 'The Google OAuth client is no longer authorized for this grant. Reconnect this account in Center.',
  deleted_client: 'The Google OAuth client this account signed in with was deleted. Reconnect this account in Center.',
  disabled_client: 'The Google OAuth client this account signed in with was disabled. Reconnect this account in Center.',
});

export class GoogleTokenError extends Error {
  constructor(code, status, description) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'GoogleTokenError';
    this.oauthError = code;
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function combinedSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Generates fresh single-use OAuth state and RFC 7636 PKCE S256 verifier/challenge.
 */
export function createPkceSecrets() {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

/**
 * Constructs Google's authorization URL using only the hardcoded Google endpoint.
 */
export function buildGoogleAuthorizeUrl({
  clientId,
  redirectUri,
  scopes,
  state,
  codeChallenge,
  loginHint,
}) {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (loginHint) {
    url.searchParams.set('login_hint', loginHint);
  }
  return url.href;
}

async function postForm(http, url, form, timeoutMs, signal) {
  const response = await http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'error',
    signal: combinedSignal(timeoutMs, signal),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

function readErrorBody(body) {
  if (!isPlainObject(body)) return null;
  const error = nonEmptyString(body.error);
  if (!error) return null;
  const description = typeof body.error_description === 'string'
    ? body.error_description.slice(0, 200)
    : undefined;
  return { error, ...(description ? { description } : {}) };
}

function parseTokenPayload(status, ok, body) {
  if (ok && isPlainObject(body)) {
    const accessToken = nonEmptyString(body.access_token);
    const expiresIn =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
        ? body.expires_in
        : null;
    if (accessToken && expiresIn !== null) {
      const refreshToken = nonEmptyString(body.refresh_token);
      const scope = nonEmptyString(body.scope);
      const idToken = nonEmptyString(body.id_token);
      return {
        accessToken,
        expiresIn,
        ...(refreshToken ? { refreshToken } : {}),
        ...(scope ? { scope } : {}),
        ...(idToken ? { idToken } : {}),
      };
    }
  }
  const parsedError = readErrorBody(body);
  throw new GoogleTokenError(
    parsedError?.error ?? `http_${status}`,
    status,
    parsedError?.description
  );
}

/**
 * Exchanges an authorization code + PKCE verifier at Google's fixed token endpoint.
 */
export async function exchangeGoogleCode(
  http,
  client,
  { code, codeVerifier, redirectUri },
  signal
) {
  const { status, ok, body } = await postForm(
    http,
    GOOGLE_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    TOKEN_REQUEST_TIMEOUT_MS,
    signal
  );
  return parseTokenPayload(status, ok, body);
}

/**
 * Refreshes an access token at Google's fixed token endpoint.
 * Distinguishes permanently ended grants (invalid_grant / invalid_client) from transient network/HTTP errors.
 */
export async function refreshGoogleAccessToken(
  http,
  { clientId, clientSecret, refreshToken },
  signal
) {
  let result;
  try {
    result = await postForm(
      http,
      GOOGLE_TOKEN_URL,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      },
      TOKEN_REQUEST_TIMEOUT_MS,
      signal
    );
  } catch {
    return { kind: 'offline' };
  }

  if (result.ok) {
    try {
      const tokens = parseTokenPayload(result.status, true, result.body);
      return { kind: 'refreshed', tokens };
    } catch {
      return { kind: 'offline' };
    }
  }

  const parsedError = readErrorBody(result.body);
  const errorCode = parsedError?.error;
  const ended =
    errorCode !== undefined &&
    Object.hasOwn(GRANT_ENDED_ERRORS, errorCode) &&
    (result.status === 400 || (result.status === 401 && errorCode !== 'invalid_grant'));

  if (ended) {
    return {
      kind: 'ended',
      error: errorCode,
      reason: GRANT_ENDED_ERRORS[errorCode],
    };
  }
  return { kind: 'offline' };
}

/**
 * Revokes a token at Google's fixed revocation endpoint.
 * Returns `{ ok: true }` when Google confirmed or reported `invalid_token` (already revoked),
 * or `{ ok: false, reason }` when revocation could not be confirmed.
 */
export async function revokeGoogleToken(http, token, signal) {
  try {
    const { ok, status, body } = await postForm(
      http,
      GOOGLE_REVOKE_URL,
      { token },
      TOKEN_REQUEST_TIMEOUT_MS,
      signal
    );
    if (ok) return { ok: true };
    const parsedError = readErrorBody(body);
    if (parsedError?.error === 'invalid_token') {
      return { ok: true };
    }
    return {
      ok: false,
      reason: parsedError?.error ? `Google rejected revocation (${parsedError.error}).` : `Google revocation failed (HTTP ${status}).`,
    };
  } catch {
    return {
      ok: false,
      reason: "Couldn't reach Google to revoke access.",
    };
  }
}

/**
 * Probes whether Google still recognizes the configured Web OAuth client without signing anyone in.
 */
export async function checkGoogleClientKey(http, client, redirectUri, signal) {
  try {
    const { body } = await postForm(
      http,
      GOOGLE_TOKEN_URL,
      {
        grant_type: 'authorization_code',
        code: 'pibot-center-key-check',
        redirect_uri: redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
      KEY_CHECK_TIMEOUT_MS,
      signal
    );
    const parsedError = readErrorBody(body);
    if (!parsedError) return 'unknown';
    if (parsedError.error === 'invalid_grant') return 'works';
    if (CLIENT_GONE_ERRORS.has(parsedError.error)) return 'gone';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Strictly validates an OpenID Connect ID token returned directly over TLS from
 * Google's fixed token endpoint (`https://oauth2.googleapis.com/token`).
 *
 * Verifies 3-part JWS shape, `iss`, `aud` (and `azp`), `exp`, `iat`, `nbf`,
 * stable `sub`, verified `email`, and returns `{ sub, email }`.
 */
export function verifyGoogleIdToken(idToken, { expectedClientId, nowMs }) {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new Error('Google did not return an ID token.');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => !part || !BASE64URL_PART.test(part))) {
    throw new Error('Google returned a malformed ID token.');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Google returned an unreadable ID token.');
  }
  if (!isPlainObject(claims)) {
    throw new Error('Google returned an invalid ID token payload.');
  }

  if (typeof claims.iss !== 'string' || !GOOGLE_ALLOWED_ISSUERS.has(claims.iss)) {
    throw new Error('Google ID token issuer is not valid.');
  }

  const audMatches =
    typeof claims.aud === 'string'
      ? claims.aud === expectedClientId
      : Array.isArray(claims.aud) &&
        claims.aud.every((entry) => typeof entry === 'string') &&
        claims.aud.includes(expectedClientId) &&
        (claims.aud.length === 1 || claims.azp === expectedClientId);

  if (!audMatches) {
    throw new Error('Google ID token audience does not match the configured OAuth client.');
  }
  if (claims.azp !== undefined && claims.azp !== expectedClientId) {
    throw new Error('Google ID token authorized party does not match the configured OAuth client.');
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new Error('Google ID token is missing a valid expiration claim.');
  }
  if (claims.exp <= nowSec) {
    throw new Error('Google ID token is expired.');
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
      throw new Error('Google ID token has an invalid iat claim.');
    }
    if (claims.iat - ID_TOKEN_CLOCK_SKEW_SEC > nowSec) {
      throw new Error('Google ID token was issued in the future.');
    }
  }
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) {
      throw new Error('Google ID token has an invalid nbf claim.');
    }
    if (claims.nbf - ID_TOKEN_CLOCK_SKEW_SEC > nowSec) {
      throw new Error('Google ID token is not valid yet.');
    }
  }

  if (typeof claims.sub !== 'string' || !SUB_PATTERN.test(claims.sub)) {
    throw new Error('Google ID token is missing a valid subject identifier.');
  }

  if (claims.email_verified !== true) {
    throw new Error('Google account email is not verified.');
  }
  if (
    typeof claims.email !== 'string' ||
    claims.email.length > 320 ||
    !EMAIL_PATTERN.test(claims.email.trim())
  ) {
    throw new Error('Google ID token is missing a valid email address.');
  }

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
  };
}
