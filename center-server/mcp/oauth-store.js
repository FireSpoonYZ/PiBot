import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const MCP_OAUTH_PATHS = Object.freeze({
  protectedResourceMetadata: '/.well-known/oauth-protected-resource/mcp',
  protectedResourceMetadataRoot: '/.well-known/oauth-protected-resource',
  authorizationServerMetadata: '/.well-known/oauth-authorization-server',
  authorize: '/oauth/mcp/authorize',
  token: '/oauth/mcp/token',
  revoke: '/oauth/mcp/revoke',
});

export const DEFAULT_TTL_MS = Object.freeze({
  consent: 5 * 60 * 1000,
  authCode: 60 * 1000,
  accessToken: 15 * 60 * 1000,
  refreshToken: 7 * 24 * 60 * 60 * 1000,
});

export const DEFAULT_LIMITS = Object.freeze({
  consents: 256,
  authCodes: 512,
  consumedAuthCodes: 1024,
  accessTokens: 2048,
  refreshTokens: 2048,
  usedRefreshTokens: 4096,
});

export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
export const FORM_BODY_LIMIT_BYTES = 16 * 1024;
const MAX_FORM_PARAMS = 64;

const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const PRINTABLE_ASCII_NO_WS_RE = /^[\x21-\x7E]+$/;
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const ACCESS_TOKEN_RE = /^pbmcp_at_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_RE = /^pbmcp_rt_[A-Za-z0-9_-]{43}$/;
const AUTH_CODE_RE = /^pbmcp_ac_[A-Za-z0-9_-]{43}$/;
const DUMMY_SECRET_HASH = sha256Buffer('pbmcp-dummy-client-secret-placeholder');

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Buffer(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function constantTimeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(sha256Buffer(a), sha256Buffer(b));
}

export function isValidAccessTokenSyntax(value) {
  return typeof value === 'string' && ACCESS_TOKEN_RE.test(value);
}

export function isValidRefreshTokenSyntax(value) {
  return typeof value === 'string' && REFRESH_TOKEN_RE.test(value);
}

export function isValidAuthCodeSyntax(value) {
  return typeof value === 'string' && AUTH_CODE_RE.test(value);
}

export function isValidPkceS256Challenge(value) {
  return typeof value === 'string' && PKCE_S256_CHALLENGE_RE.test(value);
}

export function verifyPkceS256(codeVerifier, expectedChallenge) {
  if (typeof codeVerifier !== 'string' || !PKCE_VERIFIER_RE.test(codeVerifier)) return false;
  if (!isValidPkceS256Challenge(expectedChallenge)) return false;
  const computed = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return timingSafeEqual(Buffer.from(computed, 'ascii'), Buffer.from(expectedChallenge, 'ascii'));
}

export function isValidState(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL_CHAR_RE.test(value);
}

export function normalizePublicOrigin(publicUrl) {
  if (typeof publicUrl !== 'string' || publicUrl.length === 0 || publicUrl.length > 2048 || publicUrl.trim() !== publicUrl) {
    throw new Error('publicUrl must be a non-empty HTTPS origin string');
  }
  let parsed;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error('publicUrl must be a valid HTTPS origin URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error('publicUrl must be an HTTPS origin (scheme, host and optional port only)');
  }
  const issuer = parsed.origin;
  return Object.freeze({
    issuer,
    origin: parsed.origin,
    resource: `${issuer}/mcp`,
    resourceMetadataUrl: `${issuer}${MCP_OAUTH_PATHS.protectedResourceMetadata}`,
    authServerMetadataUrl: `${issuer}${MCP_OAUTH_PATHS.authorizationServerMetadata}`,
    authorizationEndpoint: `${issuer}${MCP_OAUTH_PATHS.authorize}`,
    tokenEndpoint: `${issuer}${MCP_OAUTH_PATHS.token}`,
    revocationEndpoint: `${issuer}${MCP_OAUTH_PATHS.revoke}`,
  });
}

export function validateSupportedScopes(supportedScopes) {
  if (supportedScopes === undefined) {
    return { list: Object.freeze([]), set: new Set() };
  }
  if (!Array.isArray(supportedScopes)) {
    throw new Error('supportedScopes must be an array of scope strings');
  }
  const seen = new Set();
  const list = [];
  for (const raw of supportedScopes) {
    if (typeof raw !== 'string' || !SCOPE_TOKEN_RE.test(raw)) {
      throw new Error('supportedScopes contains an invalid OAuth scope token');
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      list.push(raw);
    }
  }
  return { list: Object.freeze(list), set: seen };
}

function validateRedirectUri(raw, clientId) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || raw.trim() !== raw || CONTROL_CHAR_RE.test(raw)) {
    throw new Error(`Invalid redirectUri for client "${clientId}"`);
  }
  if (raw.includes('*')) {
    throw new Error(`Wildcard redirectUri is not allowed for client "${clientId}"`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid redirectUri URL for client "${clientId}"`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`redirectUri must not contain credentials or fragment for client "${clientId}"`);
  }
  const isHttps = parsed.protocol === 'https:';
  const isLoopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) {
    throw new Error(`redirectUri must use https or loopback http for client "${clientId}"`);
  }
  return raw;
}

function validateIdentifier(value, fieldName, clientId) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || value.trim() !== value
    || CONTROL_CHAR_RE.test(value)
  ) {
    throw new Error(`Invalid ${fieldName} in botTargets for client "${clientId}"`);
  }
  return value;
}

function validateBotTargets(botTargets, clientId) {
  if (botTargets === undefined) return Object.freeze([]);
  if (!Array.isArray(botTargets)) {
    throw new Error(`botTargets must be an array for client "${clientId}"`);
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of botTargets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid botTarget entry for client "${clientId}"`);
    }
    const deviceId = validateIdentifier(entry.deviceId, 'deviceId', clientId);
    const botId = validateIdentifier(entry.botId, 'botId', clientId);
    const key = `${deviceId}\0${botId}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(Object.freeze({ deviceId, botId }));
    }
  }
  return Object.freeze(normalized);
}

export function validateClients(clients, supportedScopeSet) {
  if (clients === undefined || clients === null) {
    return new Map();
  }
  if (!Array.isArray(clients)) {
    throw new Error('clients must be an array');
  }
  const registry = new Map();
  for (const raw of clients) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Each OAuth client entry must be an object');
    }
    const clientId = raw.clientId;
    if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
      throw new Error('OAuth clientId must match ^[A-Za-z0-9._~-]{1,128}$');
    }
    if (registry.has(clientId)) {
      throw new Error(`Duplicate OAuth clientId "${clientId}"`);
    }
    const clientSecret = raw.clientSecret;
    if (
      typeof clientSecret !== 'string'
      || clientSecret.length < 16
      || clientSecret.length > 512
      || !PRINTABLE_ASCII_NO_WS_RE.test(clientSecret)
      || clientSecret === clientId
    ) {
      throw new Error(`Invalid clientSecret for client "${clientId}"`);
    }
    if (!Array.isArray(raw.redirectUris) || raw.redirectUris.length === 0) {
      throw new Error(`redirectUris must be a non-empty array for client "${clientId}"`);
    }
    const redirectUriSet = new Set();
    for (const uri of raw.redirectUris) {
      redirectUriSet.add(validateRedirectUri(uri, clientId));
    }
    if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
      throw new Error(`scopes must be a non-empty array for client "${clientId}"`);
    }
    const configuredScopes = [];
    const configuredScopeSet = new Set();
    for (const scope of raw.scopes) {
      if (typeof scope !== 'string' || !SCOPE_TOKEN_RE.test(scope)) {
        throw new Error(`Invalid scope in client "${clientId}"`);
      }
      if (!configuredScopeSet.has(scope)) {
        configuredScopeSet.add(scope);
        configuredScopes.push(scope);
      }
    }
    const allowedScopes = configuredScopes.filter((scope) => supportedScopeSet.has(scope));
    const botTargets = validateBotTargets(raw.botTargets, clientId);
    registry.set(clientId, Object.freeze({
      clientId,
      secretHash: sha256Buffer(clientSecret),
      redirectUris: redirectUriSet,
      allowedScopes: Object.freeze(allowedScopes),
      allowedScopeSet: new Set(allowedScopes),
      botTargets,
    }));
  }
  return registry;
}

export function verifyClientSecret(client, candidateSecret) {
  const actualHash = typeof candidateSecret === 'string' && candidateSecret.length > 0 && candidateSecret.length <= 512
    ? sha256Buffer(candidateSecret)
    : DUMMY_SECRET_HASH;
  const expectedHash = client ? client.secretHash : DUMMY_SECRET_HASH;
  const match = timingSafeEqual(actualHash, expectedHash);
  return Boolean(client) && typeof candidateSecret === 'string' && candidateSecret.length > 0 && candidateSecret.length <= 512 && match;
}

export function parseRequestedScopes(rawScope, allowedScopeList, allowedScopeSet) {
  if (rawScope === undefined) {
    if (allowedScopeList.length === 0) return { ok: false };
    return { ok: true, scopes: [...allowedScopeList] };
  }
  if (typeof rawScope !== 'string' || rawScope.length === 0 || rawScope.length > 2048 || CONTROL_CHAR_RE.test(rawScope)) {
    return { ok: false };
  }
  const parts = rawScope.split(' ').filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false };
  const scopes = [];
  const seen = new Set();
  for (const part of parts) {
    if (!SCOPE_TOKEN_RE.test(part) || !allowedScopeSet.has(part)) {
      return { ok: false };
    }
    if (!seen.has(part)) {
      seen.add(part);
      scopes.push(part);
    }
  }
  return { ok: true, scopes };
}

function decodeFormComponent(raw) {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

export function parseStrictFormUrlEncoded(rawBody) {
  const out = Object.create(null);
  if (typeof rawBody !== 'string') {
    throw Object.assign(new Error('Invalid form body'), { statusCode: 400, oauthError: 'invalid_request' });
  }
  if (rawBody.length === 0) return out;
  const pairs = rawBody.split('&');
  if (pairs.length > MAX_FORM_PARAMS) {
    throw Object.assign(new Error('Too many form parameters'), { statusCode: 400, oauthError: 'invalid_request' });
  }
  for (const pair of pairs) {
    if (pair.length === 0) {
      throw Object.assign(new Error('Malformed form encoding'), { statusCode: 400, oauthError: 'invalid_request' });
    }
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    let key;
    let value;
    try {
      key = decodeFormComponent(rawKey);
      value = decodeFormComponent(rawVal);
    } catch {
      throw Object.assign(new Error('Malformed percent-encoding in form body'), { statusCode: 400, oauthError: 'invalid_request' });
    }
    if (key.length === 0 || key.length > 128) {
      throw Object.assign(new Error('Invalid form parameter name'), { statusCode: 400, oauthError: 'invalid_request' });
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw Object.assign(new Error('Duplicate form parameter'), { statusCode: 400, oauthError: 'invalid_request' });
    }
    out[key] = value;
  }
  return out;
}

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function createOAuthStateStore({
  now = () => Date.now(),
  ttl = {},
  limits = {},
  cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
} = {}) {
  const resolvedTtl = {
    consent: positiveInt(ttl.consent, DEFAULT_TTL_MS.consent, 'ttl.consent'),
    authCode: positiveInt(ttl.authCode, DEFAULT_TTL_MS.authCode, 'ttl.authCode'),
    accessToken: positiveInt(ttl.accessToken, DEFAULT_TTL_MS.accessToken, 'ttl.accessToken'),
    refreshToken: positiveInt(ttl.refreshToken, DEFAULT_TTL_MS.refreshToken, 'ttl.refreshToken'),
  };
  const resolvedLimits = {
    consents: positiveInt(limits.consents, DEFAULT_LIMITS.consents, 'limits.consents'),
    authCodes: positiveInt(limits.authCodes, DEFAULT_LIMITS.authCodes, 'limits.authCodes'),
    consumedAuthCodes: positiveInt(limits.consumedAuthCodes, DEFAULT_LIMITS.consumedAuthCodes, 'limits.consumedAuthCodes'),
    accessTokens: positiveInt(limits.accessTokens, DEFAULT_LIMITS.accessTokens, 'limits.accessTokens'),
    refreshTokens: positiveInt(limits.refreshTokens, DEFAULT_LIMITS.refreshTokens, 'limits.refreshTokens'),
    usedRefreshTokens: positiveInt(limits.usedRefreshTokens, DEFAULT_LIMITS.usedRefreshTokens, 'limits.usedRefreshTokens'),
  };
  const resolvedSweepMs = positiveInt(cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS, 'cleanupIntervalMs');

  const consents = new Map();
  const authCodes = new Map();
  const consumedAuthCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const usedRefreshTokens = new Map();
  let closed = false;

  function pruneMap(map, maxEntries, ts) {
    for (const [key, entry] of map) {
      if (entry.expiresAtMs <= ts) map.delete(key);
    }
    while (map.size >= maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function sweep() {
    const ts = now();
    for (const map of [consents, authCodes, consumedAuthCodes, accessTokens, refreshTokens, usedRefreshTokens]) {
      for (const [key, entry] of map) {
        if (entry.expiresAtMs <= ts) map.delete(key);
      }
    }
  }

  const timer = setInterval(sweep, resolvedSweepMs);
  if (typeof timer.unref === 'function') timer.unref();

  function revokeGrant(grantId) {
    if (!grantId) return;
    for (const [key, entry] of accessTokens) {
      if (entry.grantId === grantId) accessTokens.delete(key);
    }
    for (const [key, entry] of refreshTokens) {
      if (entry.grantId === grantId) refreshTokens.delete(key);
    }
  }

  return {
    now,
    ttl: resolvedTtl,
    isClosed() {
      return closed;
    },
    sweep,
    createConsent(data) {
      if (closed) return null;
      const ts = now();
      pruneMap(consents, resolvedLimits.consents, ts);
      const consentId = randomBytes(24).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const entry = {
        ...data,
        consentId,
        csrfToken,
        createdAtMs: ts,
        expiresAtMs: ts + resolvedTtl.consent,
      };
      consents.set(consentId, entry);
      return entry;
    },
    getConsent(consentId) {
      if (closed || typeof consentId !== 'string' || !consentId) return null;
      const entry = consents.get(consentId);
      if (!entry) return null;
      if (entry.expiresAtMs <= now()) {
        consents.delete(consentId);
        return null;
      }
      return entry;
    },
    deleteConsent(consentId) {
      consents.delete(consentId);
    },
    issueAuthCode(data) {
      if (closed) return null;
      const ts = now();
      pruneMap(authCodes, resolvedLimits.authCodes, ts);
      const code = `pbmcp_ac_${randomBytes(32).toString('base64url')}`;
      const codeHash = sha256Hex(code);
      authCodes.set(codeHash, {
        ...data,
        createdAtMs: ts,
        expiresAtMs: ts + resolvedTtl.authCode,
      });
      return code;
    },
    consumeAuthCode(code) {
      if (closed || !isValidAuthCodeSyntax(code)) return { status: 'missing' };
      const ts = now();
      const codeHash = sha256Hex(code);
      const replayed = consumedAuthCodes.get(codeHash);
      if (replayed) {
        if (replayed.expiresAtMs <= ts) {
          consumedAuthCodes.delete(codeHash);
        } else {
          revokeGrant(replayed.grantId);
          return { status: 'replayed', grantId: replayed.grantId };
        }
      }
      const entry = authCodes.get(codeHash);
      if (!entry) return { status: 'missing' };
      authCodes.delete(codeHash);
      if (entry.expiresAtMs <= ts) {
        return { status: 'expired' };
      }
      return { status: 'ok', codeHash, entry };
    },
    recordConsumedAuthCode(codeHash, grantId, expiresAtMs) {
      if (closed) return;
      const ts = now();
      pruneMap(consumedAuthCodes, resolvedLimits.consumedAuthCodes, ts);
      consumedAuthCodes.set(codeHash, { grantId, expiresAtMs });
    },
    issueTokenPair({ grantId = randomUUID(), clientId, scopes, resource }) {
      if (closed) return null;
      const ts = now();
      pruneMap(accessTokens, resolvedLimits.accessTokens, ts);
      pruneMap(refreshTokens, resolvedLimits.refreshTokens, ts);
      const accessToken = `pbmcp_at_${randomBytes(32).toString('base64url')}`;
      const refreshToken = `pbmcp_rt_${randomBytes(32).toString('base64url')}`;
      const accessExpiresAtMs = ts + resolvedTtl.accessToken;
      const refreshExpiresAtMs = ts + resolvedTtl.refreshToken;
      const frozenScopes = Object.freeze([...scopes]);
      accessTokens.set(sha256Hex(accessToken), {
        grantId,
        clientId,
        scopes: frozenScopes,
        resource,
        createdAtMs: ts,
        expiresAtMs: accessExpiresAtMs,
      });
      refreshTokens.set(sha256Hex(refreshToken), {
        grantId,
        clientId,
        scopes: frozenScopes,
        resource,
        createdAtMs: ts,
        expiresAtMs: refreshExpiresAtMs,
      });
      return {
        grantId,
        accessToken,
        refreshToken,
        expiresIn: Math.max(1, Math.floor(resolvedTtl.accessToken / 1000)),
        scopes: [...frozenScopes],
      };
    },
    lookupAccessToken(token) {
      if (closed || !isValidAccessTokenSyntax(token)) return null;
      const hash = sha256Hex(token);
      const entry = accessTokens.get(hash);
      if (!entry) return null;
      if (entry.expiresAtMs <= now()) {
        accessTokens.delete(hash);
        return null;
      }
      return entry;
    },
    consumeRefreshToken(token) {
      if (closed || !isValidRefreshTokenSyntax(token)) return { status: 'missing' };
      const ts = now();
      const hash = sha256Hex(token);
      const used = usedRefreshTokens.get(hash);
      if (used) {
        if (used.expiresAtMs <= ts) {
          usedRefreshTokens.delete(hash);
        } else {
          revokeGrant(used.grantId);
          return { status: 'reused', grantId: used.grantId };
        }
      }
      const entry = refreshTokens.get(hash);
      if (!entry) return { status: 'missing' };
      if (entry.expiresAtMs <= ts) {
        refreshTokens.delete(hash);
        return { status: 'expired' };
      }
      return { status: 'ok', hash, entry };
    },
    markRefreshTokenRotated(hash, entry) {
      refreshTokens.delete(hash);
      if (closed) return;
      const ts = now();
      pruneMap(usedRefreshTokens, resolvedLimits.usedRefreshTokens, ts);
      usedRefreshTokens.set(hash, {
        grantId: entry.grantId,
        clientId: entry.clientId,
        expiresAtMs: entry.expiresAtMs,
      });
    },
    revokeToken(token, clientId, tokenTypeHint) {
      if (closed || typeof token !== 'string' || !token) return false;
      const hash = sha256Hex(token);
      const checkAccess = () => {
        const entry = accessTokens.get(hash);
        if (!entry || entry.clientId !== clientId) return false;
        accessTokens.delete(hash);
        return true;
      };
      const checkRefresh = () => {
        const entry = refreshTokens.get(hash);
        if (!entry || entry.clientId !== clientId) return false;
        refreshTokens.delete(hash);
        revokeGrant(entry.grantId);
        return true;
      };
      if (tokenTypeHint === 'refresh_token') {
        return checkRefresh() || checkAccess();
      }
      return checkAccess() || checkRefresh();
    },
    revokeGrant,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      consents.clear();
      authCodes.clear();
      consumedAuthCodes.clear();
      accessTokens.clear();
      refreshTokens.clear();
      usedRefreshTokens.clear();
    },
  };
}
