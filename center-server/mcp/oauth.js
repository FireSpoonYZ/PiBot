import { randomBytes } from 'node:crypto';
import {
  FORM_BODY_LIMIT_BYTES,
  MCP_OAUTH_PATHS,
  constantTimeEqualText,
  createOAuthStateStore,
  isValidPkceS256Challenge,
  isValidState,
  normalizePublicOrigin,
  parseRequestedScopes,
  parseStrictFormUrlEncoded,
  validateClients,
  validateSupportedScopes,
  verifyClientSecret,
  verifyPkceS256,
} from './oauth-store.js';
import {
  renderConsentPage,
  renderErrorPage,
  renderLoginRequiredPage,
  setHtmlSecurityHeaders,
  setNoStoreHeaders,
} from './oauth-html.js';

export { MCP_OAUTH_PATHS };

const BASIC_AUTH_RE = /^Basic\s+([A-Za-z0-9+/=]{4,4096})$/i;
const BEARER_AUTH_RE = /^Bearer\s+([^\s]+)$/i;

function singleParam(container, name) {
  if (!container || typeof container !== 'object' || !Object.prototype.hasOwnProperty.call(container, name)) {
    return { present: false, valid: true, value: undefined };
  }
  const value = container[name];
  if (typeof value !== 'string') {
    return { present: true, valid: false, value: undefined };
  }
  return { present: true, valid: true, value };
}

function isFormUrlEncodedContentType(req) {
  const raw = req.headers['content-type'];
  if (typeof raw !== 'string') return false;
  const mime = raw.split(';', 1)[0].trim().toLowerCase();
  return mime === 'application/x-www-form-urlencoded';
}

function decodeBasicComponent(raw) {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

function buildRedirectLocation(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

function sendRedirect(reply, location) {
  setNoStoreHeaders(reply);
  return reply.code(302).header('Location', location).send();
}

function sendOAuthJsonError(reply, statusCode, error, errorDescription, extraHeaders) {
  setNoStoreHeaders(reply);
  if (extraHeaders) {
    for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
      reply.header(headerName, headerValue);
    }
  }
  return reply.code(statusCode).send({
    error,
    error_description: errorDescription,
  });
}

function sendHtmlError(reply, statusCode, title, message) {
  setHtmlSecurityHeaders(reply);
  return reply.code(statusCode).send(renderErrorPage({ title, message }));
}

function getAuthenticatedOwnerSession(req) {
  if (req.headers.authorization !== undefined) {
    return { ok: false, statusCode: 401, reason: 'bearer_forbidden' };
  }
  if (!req.session || typeof req.session.get !== 'function' || req.session.get('owner') !== true) {
    return { ok: false, statusCode: 401, reason: 'unauthenticated' };
  }
  const ownerSessionId = req.session.get('ownerSessionId');
  return {
    ok: true,
    ownerSessionId: typeof ownerSessionId === 'string' && ownerSessionId.length > 0 ? ownerSessionId : null,
  };
}

/**
 * Registers PiBot Center MCP OAuth 2.1 endpoints (RFC 9728, RFC 8414, RFC 7636 S256,
 * RFC 8707 resource binding, RFC 7009 revocation) on the given Fastify instance.
 *
 * Tokens, authorization codes, and consent transactions are stored in bounded,
 * actively-expiring in-memory maps; restarting Center invalidates active MCP OAuth
 * grants and requires re-authorization.
 */
export function registerMcpOAuth(app, options = {}) {
  if (!app || typeof app.register !== 'function') {
    throw new Error('Fastify app instance is required');
  }
  const { publicUrl, clients, supportedScopes, now, ttl, limits, cleanupIntervalMs } = options;
  const endpoints = normalizePublicOrigin(publicUrl);
  const supported = validateSupportedScopes(supportedScopes);
  const clientRegistry = validateClients(clients, supported.set);
  const store = createOAuthStateStore({ now, ttl, limits, cleanupIntervalMs });

  const protectedResourceMetadata = Object.freeze({
    resource: endpoints.resource,
    authorization_servers: [endpoints.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...supported.list],
  });

  const authorizationServerMetadata = Object.freeze({
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    revocation_endpoint: endpoints.revocationEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: [...supported.list],
    authorization_response_iss_parameter_supported: true,
  });

  function buildWwwAuthenticate({ error, errorDescription, includeScope = false }) {
    const parts = [`resource_metadata="${endpoints.resourceMetadataUrl}"`];
    if (includeScope && supported.list.length > 0) {
      parts.push(`scope="${supported.list.join(' ')}"`);
    }
    if (error) {
      parts.push(`error="${error}"`);
    }
    if (errorDescription) {
      parts.push(`error_description="${errorDescription.replace(/["\\]/g, '')}"`);
    }
    return `Bearer ${parts.join(', ')}`;
  }

  function authenticateClientRequest(req, body) {
    const authHeader = req.headers.authorization;
    const bodyClientId = singleParam(body, 'client_id');
    const bodyClientSecret = singleParam(body, 'client_secret');
    if (!bodyClientId.valid || !bodyClientSecret.valid) {
      return { ok: false, statusCode: 400, error: 'invalid_request', description: 'Duplicate client credentials parameter' };
    }

    if (authHeader !== undefined) {
      if (bodyClientSecret.present) {
        return { ok: false, statusCode: 400, error: 'invalid_request', description: 'Multiple client authentication methods are not allowed' };
      }
      if (typeof authHeader !== 'string') {
        return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication failed', usedBasic: true };
      }
      const match = BASIC_AUTH_RE.exec(authHeader.trim());
      if (!match) {
        return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication failed', usedBasic: true };
      }
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon <= 0) {
        return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication failed', usedBasic: true };
      }
      const rawId = decoded.slice(0, colon);
      const rawSecret = decoded.slice(colon + 1);
      let clientId;
      try {
        clientId = decodeBasicComponent(rawId);
      } catch {
        return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication failed', usedBasic: true };
      }
      if (bodyClientId.present && bodyClientId.value !== clientId) {
        return { ok: false, statusCode: 400, error: 'invalid_request', description: 'Conflicting client_id values' };
      }
      const client = clientRegistry.get(clientId);
      let secretOk = false;
      try {
        const decodedSecret = decodeBasicComponent(rawSecret);
        secretOk = verifyClientSecret(client, decodedSecret)
          || (decodedSecret !== rawSecret && verifyClientSecret(client, rawSecret));
      } catch {
        secretOk = verifyClientSecret(client, rawSecret);
      }
      if (!secretOk) {
        return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication failed', usedBasic: true };
      }
      return { ok: true, client };
    }

    if (!bodyClientId.present || !bodyClientSecret.present) {
      return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication required', usedBasic: false };
    }
    const client = clientRegistry.get(bodyClientId.value);
    if (!verifyClientSecret(client, bodyClientSecret.value)) {
      return { ok: false, statusCode: 401, error: 'invalid_client', description: 'Client authentication failed', usedBasic: false };
    }
    return { ok: true, client };
  }

  async function authenticate(req, reply) {
    function reject({ error, errorDescription, includeScope = false }) {
      setNoStoreHeaders(reply);
      reply.header('WWW-Authenticate', buildWwwAuthenticate({ error, errorDescription, includeScope }));
      reply.code(401).send({
        error: error || 'unauthorized',
        error_description: errorDescription,
      });
      return null;
    }

    if (store.isClosed()) {
      return reject({ error: 'invalid_token', errorDescription: 'OAuth service is unavailable' });
    }

    const header = req.headers?.authorization;
    if (typeof header !== 'string' || header.trim() === '') {
      return reject({ errorDescription: 'Bearer access token required', includeScope: true });
    }
    const match = BEARER_AUTH_RE.exec(header.trim());
    if (!match) {
      return reject({ error: 'invalid_token', errorDescription: 'Malformed Authorization header' });
    }
    const entry = store.lookupAccessToken(match[1]);
    if (!entry || entry.resource !== endpoints.resource) {
      return reject({ error: 'invalid_token', errorDescription: 'Access token is invalid or expired' });
    }
    const client = clientRegistry.get(entry.clientId);
    if (!client) {
      return reject({ error: 'invalid_token', errorDescription: 'Access token is no longer valid' });
    }
    const scopes = entry.scopes.filter((scope) => client.allowedScopeSet.has(scope));
    if (scopes.length === 0) {
      return reject({ error: 'invalid_token', errorDescription: 'Access token has no permitted scopes' });
    }
    return {
      kind: 'oauth',
      clientId: client.clientId,
      scopes,
      botTargets: client.botTargets.map((target) => ({
        deviceId: target.deviceId,
        botId: target.botId,
      })),
    };
  }

  function close() {
    store.close();
  }

  app.register(function mcpOAuthPlugin(scoped, _opts, done) {
    if (!scoped.hasContentTypeParser('application/x-www-form-urlencoded')) {
      scoped.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT_BYTES },
        (_req, body, parserDone) => {
          try {
            parserDone(null, parseStrictFormUrlEncoded(body));
          } catch (error) {
            parserDone(error);
          }
        },
      );
    }

    scoped.setErrorHandler((error, req, reply) => {
      const urlPath = (req.url || '').split('?', 1)[0];
      if (urlPath === MCP_OAUTH_PATHS.authorize) {
        if (error?.statusCode === 429) {
          return sendHtmlError(reply, 429, 'Too Many Requests', 'Too many authorization requests. Please wait and try again.');
        }
        if (error?.statusCode === 413 || error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
          return sendHtmlError(reply, 413, 'Request Too Large', 'Authorization request body is too large.');
        }
        return sendHtmlError(reply, 400, 'Invalid Authorization Request', 'The authorization request could not be processed.');
      }
      if (error?.statusCode === 429) {
        return sendOAuthJsonError(reply, 429, 'temporarily_unavailable', 'Too many requests');
      }
      if (error?.statusCode === 413 || error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return sendOAuthJsonError(reply, 413, 'invalid_request', 'Request body too large');
      }
      if (error?.oauthError === 'invalid_request' || error?.statusCode === 400 || error?.statusCode === 415) {
        return sendOAuthJsonError(reply, 400, 'invalid_request', 'Malformed OAuth request');
      }
      return sendOAuthJsonError(reply, 500, 'server_error', 'Internal OAuth error');
    });

    scoped.addHook('onClose', (_instance, closeDone) => {
      close();
      closeDone();
    });

    scoped.get(MCP_OAUTH_PATHS.protectedResourceMetadata, (_req, reply) => {
      setNoStoreHeaders(reply);
      return protectedResourceMetadata;
    });

    scoped.get(MCP_OAUTH_PATHS.protectedResourceMetadataRoot, (_req, reply) => {
      setNoStoreHeaders(reply);
      return protectedResourceMetadata;
    });

    scoped.get(MCP_OAUTH_PATHS.authorizationServerMetadata, (_req, reply) => {
      setNoStoreHeaders(reply);
      return authorizationServerMetadata;
    });

    scoped.get(
      MCP_OAUTH_PATHS.authorize,
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      (req, reply) => {
        if (store.isClosed()) {
          return sendHtmlError(reply, 503, 'Service Unavailable', 'MCP OAuth service is closed.');
        }

        const query = req.query;
        const clientIdParam = singleParam(query, 'client_id');
        const redirectUriParam = singleParam(query, 'redirect_uri');
        if (!clientIdParam.present || !clientIdParam.valid || !redirectUriParam.present || !redirectUriParam.valid) {
          return sendHtmlError(reply, 400, 'Invalid Authorization Request', 'Missing or malformed client_id or redirect_uri.');
        }
        const client = clientRegistry.get(clientIdParam.value);
        if (!client || !client.redirectUris.has(redirectUriParam.value)) {
          return sendHtmlError(reply, 400, 'Invalid Authorization Request', 'Unknown client_id or unregistered redirect_uri.');
        }
        const redirectUri = redirectUriParam.value;

        const stateParam = singleParam(query, 'state');
        const safeState = stateParam.present && stateParam.valid && isValidState(stateParam.value) ? stateParam.value : undefined;

        function redirectError(error, errorDescription) {
          return sendRedirect(reply, buildRedirectLocation(redirectUri, {
            error,
            error_description: errorDescription,
            state: safeState,
            iss: endpoints.issuer,
          }));
        }

        const responseTypeParam = singleParam(query, 'response_type');
        const codeChallengeParam = singleParam(query, 'code_challenge');
        const codeChallengeMethodParam = singleParam(query, 'code_challenge_method');
        const scopeParam = singleParam(query, 'scope');
        const resourceParam = singleParam(query, 'resource');

        if (
          !stateParam.valid
          || !responseTypeParam.valid
          || !codeChallengeParam.valid
          || !codeChallengeMethodParam.valid
          || !scopeParam.valid
          || !resourceParam.valid
        ) {
          return redirectError('invalid_request', 'Duplicate query parameters are not allowed');
        }

        if (!responseTypeParam.present || responseTypeParam.value !== 'code') {
          return redirectError('unsupported_response_type', 'Only response_type=code is supported');
        }

        if (!safeState) {
          return redirectError('invalid_request', 'A valid state parameter is required');
        }

        if (codeChallengeMethodParam.value !== 'S256' || !isValidPkceS256Challenge(codeChallengeParam.value)) {
          return redirectError('invalid_request', 'PKCE S256 code_challenge is required');
        }

        if (resourceParam.present && resourceParam.value !== endpoints.resource) {
          return redirectError('invalid_target', 'Requested resource is not supported by this authorization server');
        }

        const parsedScopes = parseRequestedScopes(
          scopeParam.present ? scopeParam.value : undefined,
          client.allowedScopes,
          client.allowedScopeSet,
        );
        if (!parsedScopes.ok) {
          return redirectError('invalid_scope', 'Requested scope is not permitted for this client');
        }

        const ownerCheck = getAuthenticatedOwnerSession(req);
        if (!ownerCheck.ok) {
          if (ownerCheck.reason === 'bearer_forbidden') {
            return sendHtmlError(
              reply,
              401,
              'Owner Browser Session Required',
              'Bearer authentication cannot be used to authorize MCP OAuth access. Sign in as the Center owner in your browser.',
            );
          }
          const continueParams = new URLSearchParams();
          continueParams.set('response_type', 'code');
          continueParams.set('client_id', client.clientId);
          continueParams.set('redirect_uri', redirectUri);
          continueParams.set('state', safeState);
          continueParams.set('code_challenge', codeChallengeParam.value);
          continueParams.set('code_challenge_method', 'S256');
          if (scopeParam.present) continueParams.set('scope', parsedScopes.scopes.join(' '));
          if (resourceParam.present) continueParams.set('resource', endpoints.resource);
          setHtmlSecurityHeaders(reply);
          return reply.code(401).send(renderLoginRequiredPage({
            clientId: client.clientId,
            continueHref: `${MCP_OAUTH_PATHS.authorize}?${continueParams.toString()}`,
          }));
        }

        let ownerSessionId = ownerCheck.ownerSessionId;
        if (!ownerSessionId) {
          ownerSessionId = randomBytes(16).toString('base64url');
          req.session.set('ownerSessionId', ownerSessionId);
        }

        const consent = store.createConsent({
          ownerSessionId,
          clientId: client.clientId,
          redirectUri,
          scopes: parsedScopes.scopes,
          state: safeState,
          codeChallenge: codeChallengeParam.value,
          codeChallengeMethod: 'S256',
          resource: endpoints.resource,
        });
        if (!consent) {
          return sendHtmlError(reply, 503, 'Service Unavailable', 'MCP OAuth service is closed.');
        }

        const redirectOrigin = new URL(redirectUri).origin;
        setHtmlSecurityHeaders(reply, { formAction: `'self' ${redirectOrigin}` });
        return reply.code(200).send(renderConsentPage({
          authorizePath: MCP_OAUTH_PATHS.authorize,
          clientId: client.clientId,
          redirectUri,
          resource: endpoints.resource,
          scopes: parsedScopes.scopes,
          botTargets: client.botTargets,
          consentId: consent.consentId,
          csrfToken: consent.csrfToken,
        }));
      },
    );

    scoped.post(
      MCP_OAUTH_PATHS.authorize,
      { bodyLimit: FORM_BODY_LIMIT_BYTES, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      (req, reply) => {
        if (store.isClosed()) {
          return sendHtmlError(reply, 503, 'Service Unavailable', 'MCP OAuth service is closed.');
        }

        const ownerCheck = getAuthenticatedOwnerSession(req);
        if (!ownerCheck.ok) {
          return sendHtmlError(
            reply,
            401,
            'Owner Browser Session Required',
            'Owner browser session authentication is required to submit authorization consent.',
          );
        }
        if (!ownerCheck.ownerSessionId) {
          return sendHtmlError(reply, 403, 'CSRF Verification Failed', 'Missing owner session binding.');
        }

        if (req.headers.origin !== undefined && req.headers.origin !== endpoints.origin) {
          return sendHtmlError(reply, 403, 'CSRF Verification Failed', 'Cross-origin authorization submission is not allowed.');
        }

        if (!isFormUrlEncodedContentType(req)) {
          return sendHtmlError(reply, 400, 'Invalid Request', 'Consent submission must use application/x-www-form-urlencoded.');
        }

        const body = req.body;
        const consentIdParam = singleParam(body, 'consent_id');
        const csrfTokenParam = singleParam(body, 'csrf_token');
        const decisionParam = singleParam(body, 'decision');

        if (!consentIdParam.present || !consentIdParam.valid || !csrfTokenParam.valid || !decisionParam.valid) {
          return sendHtmlError(reply, 400, 'Invalid Request', 'Malformed consent form submission.');
        }

        const consent = store.getConsent(consentIdParam.value);
        if (!consent) {
          return sendHtmlError(reply, 400, 'Authorization Expired', 'Authorization consent request is invalid or expired.');
        }

        if (
          !csrfTokenParam.present
          || !constantTimeEqualText(consent.ownerSessionId, ownerCheck.ownerSessionId)
          || !constantTimeEqualText(consent.csrfToken, csrfTokenParam.value)
        ) {
          return sendHtmlError(reply, 403, 'CSRF Verification Failed', 'Invalid consent CSRF token or session.');
        }

        store.deleteConsent(consent.consentId);

        if (decisionParam.value === 'deny') {
          return sendRedirect(reply, buildRedirectLocation(consent.redirectUri, {
            error: 'access_denied',
            error_description: 'The owner denied the authorization request',
            state: consent.state,
            iss: endpoints.issuer,
          }));
        }

        if (decisionParam.value !== 'approve') {
          return sendHtmlError(reply, 400, 'Invalid Decision', 'Consent decision must be approve or deny.');
        }

        const client = clientRegistry.get(consent.clientId);
        if (!client || !client.redirectUris.has(consent.redirectUri)) {
          return sendHtmlError(reply, 400, 'Invalid Client', 'Configured OAuth client is no longer valid.');
        }
        if (consent.scopes.length === 0 || consent.scopes.some((scope) => !client.allowedScopeSet.has(scope))) {
          return sendRedirect(reply, buildRedirectLocation(consent.redirectUri, {
            error: 'invalid_scope',
            error_description: 'Requested scope is no longer permitted',
            state: consent.state,
            iss: endpoints.issuer,
          }));
        }

        const code = store.issueAuthCode({
          clientId: client.clientId,
          redirectUri: consent.redirectUri,
          scopes: consent.scopes,
          resource: consent.resource,
          codeChallenge: consent.codeChallenge,
          codeChallengeMethod: consent.codeChallengeMethod,
        });
        if (!code) {
          return sendHtmlError(reply, 503, 'Service Unavailable', 'MCP OAuth service is closed.');
        }

        return sendRedirect(reply, buildRedirectLocation(consent.redirectUri, {
          code,
          state: consent.state,
          iss: endpoints.issuer,
        }));
      },
    );

    scoped.post(
      MCP_OAUTH_PATHS.token,
      { bodyLimit: FORM_BODY_LIMIT_BYTES, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      (req, reply) => {
        setNoStoreHeaders(reply);
        if (store.isClosed()) {
          return sendOAuthJsonError(reply, 503, 'temporarily_unavailable', 'MCP OAuth service is closed');
        }
        if (!isFormUrlEncodedContentType(req)) {
          return sendOAuthJsonError(reply, 400, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
        }

        const body = req.body;
        const authResult = authenticateClientRequest(req, body);
        if (!authResult.ok) {
          const extraHeaders = authResult.statusCode === 401 && authResult.usedBasic
            ? { 'WWW-Authenticate': 'Basic realm="mcp-oauth"' }
            : undefined;
          return sendOAuthJsonError(reply, authResult.statusCode, authResult.error, authResult.description, extraHeaders);
        }
        const { client } = authResult;

        const grantTypeParam = singleParam(body, 'grant_type');
        if (!grantTypeParam.present || !grantTypeParam.valid || !grantTypeParam.value) {
          return sendOAuthJsonError(reply, 400, 'invalid_request', 'grant_type is required');
        }

        if (grantTypeParam.value === 'authorization_code') {
          const codeParam = singleParam(body, 'code');
          const redirectUriParam = singleParam(body, 'redirect_uri');
          const codeVerifierParam = singleParam(body, 'code_verifier');
          const resourceParam = singleParam(body, 'resource');

          if (
            !codeParam.present || !codeParam.valid || !codeParam.value
            || !redirectUriParam.present || !redirectUriParam.valid || !redirectUriParam.value
            || !codeVerifierParam.present || !codeVerifierParam.valid || !codeVerifierParam.value
            || !resourceParam.valid
          ) {
            return sendOAuthJsonError(reply, 400, 'invalid_request', 'code, redirect_uri, and code_verifier are required');
          }

          const consumed = store.consumeAuthCode(codeParam.value);
          if (consumed.status !== 'ok') {
            return sendOAuthJsonError(reply, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used');
          }
          const { entry, codeHash } = consumed;
          if (entry.clientId !== client.clientId) {
            return sendOAuthJsonError(reply, 400, 'invalid_grant', 'Authorization code was not issued to this client');
          }
          if (redirectUriParam.value !== entry.redirectUri) {
            return sendOAuthJsonError(reply, 400, 'invalid_grant', 'redirect_uri does not match authorization request');
          }
          if (resourceParam.present && resourceParam.value !== entry.resource) {
            return sendOAuthJsonError(reply, 400, 'invalid_target', 'Requested resource does not match authorization request');
          }
          if (!verifyPkceS256(codeVerifierParam.value, entry.codeChallenge)) {
            return sendOAuthJsonError(reply, 400, 'invalid_grant', 'PKCE code_verifier verification failed');
          }
          if (entry.scopes.length === 0 || entry.scopes.some((scope) => !client.allowedScopeSet.has(scope))) {
            return sendOAuthJsonError(reply, 400, 'invalid_scope', 'Authorized scopes are no longer permitted');
          }

          const issued = store.issueTokenPair({
            clientId: client.clientId,
            scopes: entry.scopes,
            resource: entry.resource,
          });
          if (!issued) {
            return sendOAuthJsonError(reply, 503, 'temporarily_unavailable', 'MCP OAuth service is closed');
          }
          const consumedAtMs = store.now();
          store.recordConsumedAuthCode(
            codeHash,
            issued.grantId,
            Math.max(
              entry.expiresAtMs,
              consumedAtMs + store.ttl.accessToken,
              consumedAtMs + store.ttl.refreshToken,
            ),
          );

          return reply.code(200).send({
            access_token: issued.accessToken,
            token_type: 'Bearer',
            expires_in: issued.expiresIn,
            refresh_token: issued.refreshToken,
            scope: issued.scopes.join(' '),
          });
        }

        if (grantTypeParam.value === 'refresh_token') {
          const refreshTokenParam = singleParam(body, 'refresh_token');
          const scopeParam = singleParam(body, 'scope');
          const resourceParam = singleParam(body, 'resource');

          if (
            !refreshTokenParam.present || !refreshTokenParam.valid || !refreshTokenParam.value
            || !scopeParam.valid
            || !resourceParam.valid
          ) {
            return sendOAuthJsonError(reply, 400, 'invalid_request', 'refresh_token is required');
          }

          const lookedUp = store.consumeRefreshToken(refreshTokenParam.value);
          if (lookedUp.status !== 'ok') {
            return sendOAuthJsonError(reply, 400, 'invalid_grant', 'Refresh token is invalid, expired, or revoked');
          }
          const { hash, entry } = lookedUp;
          if (entry.clientId !== client.clientId) {
            return sendOAuthJsonError(reply, 400, 'invalid_grant', 'Refresh token was not issued to this client');
          }
          if (resourceParam.present && resourceParam.value !== entry.resource) {
            return sendOAuthJsonError(reply, 400, 'invalid_target', 'Requested resource does not match grant');
          }

          const grantAllowedScopes = entry.scopes.filter((scope) => client.allowedScopeSet.has(scope));
          const parsedScopes = parseRequestedScopes(
            scopeParam.present ? scopeParam.value : undefined,
            grantAllowedScopes,
            new Set(grantAllowedScopes),
          );
          if (!parsedScopes.ok) {
            return sendOAuthJsonError(reply, 400, 'invalid_scope', 'Requested scope exceeds granted scope');
          }

          store.markRefreshTokenRotated(hash, entry);
          const issued = store.issueTokenPair({
            grantId: entry.grantId,
            clientId: client.clientId,
            scopes: parsedScopes.scopes,
            resource: entry.resource,
          });
          if (!issued) {
            return sendOAuthJsonError(reply, 503, 'temporarily_unavailable', 'MCP OAuth service is closed');
          }

          return reply.code(200).send({
            access_token: issued.accessToken,
            token_type: 'Bearer',
            expires_in: issued.expiresIn,
            refresh_token: issued.refreshToken,
            scope: issued.scopes.join(' '),
          });
        }

        return sendOAuthJsonError(reply, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token grants are supported');
      },
    );

    scoped.post(
      MCP_OAUTH_PATHS.revoke,
      { bodyLimit: FORM_BODY_LIMIT_BYTES, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      (req, reply) => {
        setNoStoreHeaders(reply);
        if (store.isClosed()) {
          return sendOAuthJsonError(reply, 503, 'temporarily_unavailable', 'MCP OAuth service is closed');
        }
        if (!isFormUrlEncodedContentType(req)) {
          return sendOAuthJsonError(reply, 400, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
        }

        const body = req.body;
        const authResult = authenticateClientRequest(req, body);
        if (!authResult.ok) {
          const extraHeaders = authResult.statusCode === 401 && authResult.usedBasic
            ? { 'WWW-Authenticate': 'Basic realm="mcp-oauth"' }
            : undefined;
          return sendOAuthJsonError(reply, authResult.statusCode, authResult.error, authResult.description, extraHeaders);
        }

        const tokenParam = singleParam(body, 'token');
        const hintParam = singleParam(body, 'token_type_hint');
        if (!tokenParam.present || !tokenParam.valid || !tokenParam.value || !hintParam.valid) {
          return sendOAuthJsonError(reply, 400, 'invalid_request', 'token is required');
        }

        store.revokeToken(tokenParam.value, authResult.client.clientId, hintParam.value);
        return reply.code(200).send();
      },
    );

    done();
  });

  return {
    authenticate,
    close,
  };
}
