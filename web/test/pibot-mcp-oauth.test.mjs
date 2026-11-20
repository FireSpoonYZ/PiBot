import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { registerAuth, setOwnerOAuthVerifier } from '../../center-server/auth.js';
import { MCP_OAUTH_PATHS, registerMcpOAuth } from '../../center-server/mcp/oauth.js';

// Fastify 和官方 MCP SDK 只安装在 center-server 包内，按该包解析。
const centerRequire = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = centerRequire('fastify');
const { auth: sdkOAuth, extractWWWAuthenticateParams } = centerRequire('@modelcontextprotocol/sdk/client/auth.js');

const OWNER_PASSWORD = 'owner-password-for-mcp-oauth-tests';
const PUBLIC_URL = 'https://center.example.com';
const RESOURCE_URL = `${PUBLIC_URL}/mcp`;
const SUPPORTED_SCOPES = ['mcp:read', 'mcp:dispatch', 'mcp:bots:list'];

const CLIENT_A = {
  clientId: 'google-connected-app-a',
  clientSecret: 'super-secret-client-a-value-0001',
  redirectUris: [
    'https://oauth.google.example/callback',
    'https://oauth.google.example/callback?mode=mcp',
  ],
  scopes: ['mcp:read', 'mcp:dispatch', 'unsupported:extra-scope'],
  botTargets: [
    { deviceId: 'device-1', botId: 'bot-alpha' },
    { deviceId: 'device-2', botId: 'bot-beta' },
  ],
};

const CLIENT_B = {
  clientId: 'google-connected-app-b',
  clientSecret: 'super-secret-client-b-value-0002',
  redirectUris: ['http://127.0.0.1:43123/cb'],
  scopes: ['mcp:read'],
};

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((value) => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function basicAuthHeader(clientId, clientSecret) {
  const encoded = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    'utf8',
  ).toString('base64');
  return `Basic ${encoded}`;
}

function formBody(params) {
  return new URLSearchParams(params).toString();
}

function extractConsentForm(html) {
  const consentId = /name="consent_id"\s+value="([^"]+)"/.exec(html)?.[1];
  const csrfToken = /name="csrf_token"\s+value="([^"]+)"/.exec(html)?.[1];
  assert.ok(consentId, 'consent_id hidden input must be present');
  assert.ok(csrfToken, 'csrf_token hidden input must be present');
  return { consentId, csrfToken };
}

function createInjectFetch(app, expectedOrigin = PUBLIC_URL) {
  return async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    assert.equal(url.origin, expectedOrigin, `Unexpected remote fetch target: ${url.href}`);
    const method = (init.method || 'GET').toUpperCase();
    const headers = {};
    for (const [key, value] of new Headers(init.headers).entries()) {
      headers[key] = value;
    }
    if (!headers.host) headers.host = url.host;
    let payload;
    if (init.body !== undefined && init.body !== null) {
      payload = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
    }
    const injected = await app.inject({
      method,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(payload !== undefined ? { payload } : {}),
    });
    const resHeaders = new Headers();
    for (const [key, value] of Object.entries(injected.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) resHeaders.append(key, String(item));
      } else if (value !== undefined) {
        resHeaders.set(key, String(value));
      }
    }
    const isNullBodyStatus = injected.statusCode === 204 || injected.statusCode === 205 || injected.statusCode === 304;
    return new Response(isNullBodyStatus ? null : injected.body, {
      status: injected.statusCode,
      headers: resHeaders,
    });
  };
}

function createSdkOAuthProvider(client, { scope, state } = {}) {
  const redirectUrl = client.redirectUris[0];
  let clientInfo = {
    client_id: client.clientId,
    client_secret: client.clientSecret,
  };
  let tokens;
  let verifier = '';
  let discoveryState;
  let authorizationUrl;

  return {
    redirectUrl,
    clientMetadata: {
      client_name: `sdk-test-${client.clientId}`,
      redirect_uris: [redirectUrl],
      ...(scope !== undefined ? { scope } : {}),
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => {
      clientInfo = info;
    },
    tokens: () => tokens,
    saveTokens: (next) => {
      tokens = next;
    },
    state: () => state || 'sdk-oauth-state-001',
    codeVerifier: () => verifier,
    saveCodeVerifier: (next) => {
      verifier = next;
    },
    discoveryState: () => discoveryState,
    saveDiscoveryState: (next) => {
      discoveryState = next;
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    getCapturedAuthorizationUrl: () => authorizationUrl,
    getDiscoveryState: () => discoveryState,
    getTokens: () => tokens,
  };
}

async function createTestHarness({
  publicUrl = PUBLIC_URL,
  clients = [CLIENT_A, CLIENT_B],
  supportedScopes = SUPPORTED_SCOPES,
  now,
  ttl,
  limits,
  cleanupIntervalMs = 60 * 60 * 1000,
} = {}) {
  const app = Fastify({ logger: false });
  await registerAuth(app, {
    sessionKey: randomBytes(32),
    ownerPasswordHash: ownerPasswordHash(OWNER_PASSWORD),
  });
  const mcpOAuth = registerMcpOAuth(app, {
    publicUrl,
    clients,
    supportedScopes,
    now,
    ttl,
    limits,
    cleanupIntervalMs,
  });

  app.post('/mcp', async (req, reply) => {
    const actor = await mcpOAuth.authenticate(req, reply);
    if (!actor) return reply;
    return { ok: true, actor };
  });
  app.get('/mcp', async (req, reply) => {
    const actor = await mcpOAuth.authenticate(req, reply);
    if (!actor) return reply;
    return { ok: true, actor };
  });

  await app.ready();

  async function loginOwner() {
    let res = await app.inject({ method: 'GET', url: '/api/session' });
    let cookie = cookieOf(res);
    res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie, 'x-csrf-token': res.json().csrfToken },
      payload: { password: OWNER_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    cookie = cookieOf(res, cookie);
    res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    assert.equal(res.json().authenticated, true);
    return { cookie: cookieOf(res, cookie) };
  }

  async function authorizeAndApprove(options = {}) {
    const {
      ownerCookie,
      client = CLIENT_A,
      redirectUri = client.redirectUris[0],
      includeScope = true,
      state = 'state-xyz-123',
      resource = RESOURCE_URL,
      includeResource = true,
      pkce = makePkce(),
    } = options;
    const hasScope = Object.prototype.hasOwnProperty.call(options, 'scope');
    const scope = hasScope ? options.scope : 'mcp:read mcp:dispatch';
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    if (includeScope && scope !== undefined) query.set('scope', scope);
    if (includeResource && resource !== undefined) query.set('resource', resource);

    const getRes = await app.inject({
      method: 'GET',
      url: `${MCP_OAUTH_PATHS.authorize}?${query.toString()}`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(getRes.statusCode, 200);
    const { consentId, csrfToken } = extractConsentForm(getRes.body);

    const postRes = await app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({
        consent_id: consentId,
        csrf_token: csrfToken,
        decision: 'approve',
      }),
    });
    assert.equal(postRes.statusCode, 302);
    const location = new URL(postRes.headers.location);
    const code = location.searchParams.get('code');
    assert.ok(code, 'authorization code must be returned on approval');
    assert.equal(location.searchParams.get('state'), state);
    assert.equal(location.searchParams.get('iss'), PUBLIC_URL);
    return { code, pkce, redirectUri, state, getRes, postRes, authorizeQuery: query };
  }

  async function exchangeCode({
    code,
    pkce,
    client = CLIENT_A,
    redirectUri = client.redirectUris[0],
    resource = RESOURCE_URL,
    includeResource = true,
    authMethod = 'basic',
  }) {
    const params = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    };
    if (includeResource && resource !== undefined) params.resource = resource;
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (authMethod === 'basic') {
      headers.authorization = basicAuthHeader(client.clientId, client.clientSecret);
    } else {
      params.client_id = client.clientId;
      params.client_secret = client.clientSecret;
    }
    return app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers,
      payload: formBody(params),
    });
  }

  return {
    app,
    mcpOAuth,
    loginOwner,
    authorizeAndApprove,
    exchangeCode,
    async close() {
      mcpOAuth.close();
      await app.close();
    },
  };
}

test('strict config validation rejects unsafe publicUrl, clients, redirectUris, secrets, scopes, and botTargets', async () => {
  const app = Fastify({ logger: false });
  try {
    assert.throws(() => registerMcpOAuth(app, { publicUrl: 'http://center.example.com', clients: [], supportedScopes: SUPPORTED_SCOPES }));
    assert.throws(() => registerMcpOAuth(app, { publicUrl: 'https://center.example.com/subpath', clients: [], supportedScopes: SUPPORTED_SCOPES }));
    assert.throws(() => registerMcpOAuth(app, { publicUrl: 'https://user:pass@center.example.com', clients: [], supportedScopes: SUPPORTED_SCOPES }));
    assert.throws(() => registerMcpOAuth(app, { publicUrl: PUBLIC_URL, clients: 'not-array', supportedScopes: SUPPORTED_SCOPES }));
    assert.throws(() => registerMcpOAuth(app, { publicUrl: PUBLIC_URL, clients: [], supportedScopes: 'mcp:read' }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [{ ...CLIENT_A, clientSecret: 'too-short' }],
    }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [{ ...CLIENT_A, redirectUris: ['http://evil.example/cb'] }],
    }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [{ ...CLIENT_A, redirectUris: ['https://oauth.google.example/cb#frag'] }],
    }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [{ ...CLIENT_A, redirectUris: ['https://oauth.google.example/*'] }],
    }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [CLIENT_A, { ...CLIENT_A }],
    }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [{ ...CLIENT_A, scopes: [] }],
    }));
    assert.throws(() => registerMcpOAuth(app, {
      publicUrl: PUBLIC_URL,
      supportedScopes: SUPPORTED_SCOPES,
      clients: [{ ...CLIENT_A, botTargets: [{ deviceId: '', botId: 'bot-1' }] }],
    }));
  } finally {
    await app.close();
  }
});

test('default deny when clients is empty and serves RFC 9728 / RFC 8414 discovery with 401 WWW-Authenticate', async () => {
  const harness = await createTestHarness({ clients: [] });
  try {
    const unauth = await harness.app.inject({ method: 'POST', url: '/mcp', payload: {} });
    assert.equal(unauth.statusCode, 401);
    assert.equal(unauth.headers['cache-control'], 'no-store');
    const wwwAuth = unauth.headers['www-authenticate'];
    assert.ok(wwwAuth.includes(`resource_metadata="${PUBLIC_URL}${MCP_OAUTH_PATHS.protectedResourceMetadata}"`));
    assert.doesNotMatch(wwwAuth, /\bscope=/i);
    assert.ok(!wwwAuth.includes('error="invalid_token"'));

    const prmRes = await harness.app.inject({ method: 'GET', url: MCP_OAUTH_PATHS.protectedResourceMetadata });
    assert.equal(prmRes.statusCode, 200);
    assert.equal(prmRes.headers['cache-control'], 'no-store');
    assert.deepEqual(prmRes.json(), {
      resource: RESOURCE_URL,
      authorization_servers: [PUBLIC_URL],
      bearer_methods_supported: ['header'],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(prmRes.json(), 'scopes_supported'), false);

    const prmRootRes = await harness.app.inject({ method: 'GET', url: MCP_OAUTH_PATHS.protectedResourceMetadataRoot });
    assert.equal(prmRootRes.statusCode, 200);
    assert.deepEqual(prmRootRes.json(), prmRes.json());

    const asRes = await harness.app.inject({ method: 'GET', url: MCP_OAUTH_PATHS.authorizationServerMetadata });
    assert.equal(asRes.statusCode, 200);
    assert.equal(asRes.headers['cache-control'], 'no-store');
    assert.deepEqual(asRes.json(), {
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}${MCP_OAUTH_PATHS.authorize}`,
      token_endpoint: `${PUBLIC_URL}${MCP_OAUTH_PATHS.token}`,
      revocation_endpoint: `${PUBLIC_URL}${MCP_OAUTH_PATHS.revoke}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: SUPPORTED_SCOPES,
      authorization_response_iss_parameter_supported: true,
    });

    const tokenRes = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'authorization_code', code: 'x', redirect_uri: CLIENT_A.redirectUris[0], code_verifier: 'y' }),
    });
    assert.equal(tokenRes.statusCode, 401);
    assert.equal(tokenRes.json().error, 'invalid_client');
  } finally {
    await harness.close();
  }
});

test('full OAuth 2.1 S256 PKCE flow with client_secret_basic and client_secret_post returns scoped actor and botTargets', async () => {
  const harness = await createTestHarness();
  try {
    const owner = await harness.loginOwner();

    // Flow 1: client_secret_basic with explicit resource and configured botTargets
    const flow1 = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      redirectUri: CLIENT_A.redirectUris[1], // preserves existing query param
      scope: 'mcp:read mcp:dispatch',
      state: 'google-state-001',
    });

    // Verify consent HTML security headers & disclosures
    assert.equal(flow1.getRes.headers['cache-control'], 'no-store');
    assert.equal(flow1.getRes.headers['x-frame-options'], 'DENY');
    assert.equal(flow1.getRes.headers['x-content-type-options'], 'nosniff');
    assert.match(flow1.getRes.headers['content-security-policy'], /default-src 'none'/);
    assert.match(flow1.getRes.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(flow1.getRes.body, /Center-wide scope/i);
    assert.match(flow1.getRes.body, /mcp:read/);
    assert.match(flow1.getRes.body, /mcp:dispatch/);
    assert.match(flow1.getRes.body, /device-1/);
    assert.match(flow1.getRes.body, /bot-alpha/);
    assert.match(flow1.getRes.body, /device-2/);
    assert.match(flow1.getRes.body, /bot-beta/);
    assert.equal(new URL(flow1.postRes.headers.location).searchParams.get('mode'), 'mcp');

    const tokenRes1 = await harness.exchangeCode({
      code: flow1.code,
      pkce: flow1.pkce,
      client: CLIENT_A,
      redirectUri: flow1.redirectUri,
      authMethod: 'basic',
    });
    assert.equal(tokenRes1.statusCode, 200);
    assert.equal(tokenRes1.headers['cache-control'], 'no-store');
    const tokens1 = tokenRes1.json();
    assert.equal(tokens1.token_type, 'Bearer');
    assert.match(tokens1.access_token, /^pbmcp_at_[A-Za-z0-9_-]{43}$/);
    assert.match(tokens1.refresh_token, /^pbmcp_rt_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokens1.scope, 'mcp:read mcp:dispatch');
    assert.equal(tokens1.expires_in, 900);

    const mcpRes1 = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens1.access_token}` },
      payload: {},
    });
    assert.equal(mcpRes1.statusCode, 200);
    assert.deepEqual(mcpRes1.json().actor, {
      kind: 'oauth',
      clientId: CLIENT_A.clientId,
      scopes: ['mcp:read', 'mcp:dispatch'],
      botTargets: [
        { deviceId: 'device-1', botId: 'bot-alpha' },
        { deviceId: 'device-2', botId: 'bot-beta' },
      ],
    });

    // Flow 2: client_secret_post omitting scope and omitting resource (Google manual config compatibility)
    const flow2 = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_B,
      scope: undefined,
      includeResource: false,
      state: 'google-state-002',
    });
    assert.equal(flow2.authorizeQuery.has('scope'), false);
    assert.equal(flow2.authorizeQuery.has('resource'), false);
    assert.match(flow2.getRes.body, /No dispatch Bots configured/i);
    const tokenRes2 = await harness.exchangeCode({
      code: flow2.code,
      pkce: flow2.pkce,
      client: CLIENT_B,
      includeResource: false,
      authMethod: 'post',
    });
    assert.equal(tokenRes2.statusCode, 200);
    const tokens2 = tokenRes2.json();
    assert.equal(tokens2.scope, 'mcp:read');

    const mcpRes2 = await harness.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens2.access_token}` },
    });
    assert.equal(mcpRes2.statusCode, 200);
    assert.deepEqual(mcpRes2.json().actor, {
      kind: 'oauth',
      clientId: CLIENT_B.clientId,
      scopes: ['mcp:read'],
      botTargets: [],
    });
  } finally {
    await harness.close();
  }
});

test('enforces owner browser session, CSRF, origin check, single-use consent, and rejects bearer-to-owner exchange', async () => {
  const harness = await createTestHarness();
  try {
    // Register an active device admin OAuth bearer (existing auth.js mechanism) to prove complete isolation
    const deviceAdminBearer = `pboauth_${randomBytes(32).toString('base64url')}`;
    setOwnerOAuthVerifier(harness.app, (token) => (token === deviceAdminBearer ? 'device-admin-1' : null));

    const pkce = makePkce();
    const authUrl = `${MCP_OAUTH_PATHS.authorize}?${new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_A.clientId,
      redirect_uri: CLIENT_A.redirectUris[0],
      scope: 'mcp:read',
      state: 'state-owner-check',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE_URL,
    }).toString()}`;

    // Unauthenticated browser GET -> 401 login-required HTML with CSP & no-store
    const unauthGet = await harness.app.inject({ method: 'GET', url: authUrl });
    assert.equal(unauthGet.statusCode, 401);
    assert.equal(unauthGet.headers['cache-control'], 'no-store');
    assert.match(unauthGet.headers['content-security-policy'], /default-src 'none'/);
    assert.match(unauthGet.body, /Continue to Consent/);

    // Device admin bearer token MUST NOT be accepted as owner on GET or POST /authorize
    const bearerGet = await harness.app.inject({
      method: 'GET',
      url: authUrl,
      headers: { authorization: `Bearer ${deviceAdminBearer}` },
    });
    assert.equal(bearerGet.statusCode, 401);

    // Device admin bearer MUST NOT authenticate against /mcp
    const bearerMcp = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${deviceAdminBearer}` },
      payload: {},
    });
    assert.equal(bearerMcp.statusCode, 401);
    assert.match(bearerMcp.headers['www-authenticate'], /error="invalid_token"/);

    // Owner session 1 obtains consent form
    const owner1 = await harness.loginOwner();
    const owner2 = await harness.loginOwner();

    const consentGet = await harness.app.inject({
      method: 'GET',
      url: authUrl,
      headers: { cookie: owner1.cookie },
    });
    assert.equal(consentGet.statusCode, 200);
    const { consentId, csrfToken } = extractConsentForm(consentGet.body);

    // Bearer header on POST /authorize fails even WITH valid owner cookie
    const bearerPost = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner1.cookie,
        authorization: `Bearer ${deviceAdminBearer}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }),
    });
    assert.equal(bearerPost.statusCode, 401);

    // Cross-origin POST fails with 403
    const crossOriginPost = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner1.cookie,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }),
    });
    assert.equal(crossOriginPost.statusCode, 403);

    // Wrong CSRF token fails with 403
    const wrongCsrfPost = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner1.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: 'wrong-csrf', decision: 'approve' }),
    });
    assert.equal(wrongCsrfPost.statusCode, 403);

    // Different owner session submitting owner1's consent fails with 403 (and does not consume owner1's consent)
    const otherSessionPost = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner2.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }),
    });
    assert.equal(otherSessionPost.statusCode, 403);

    // Owner1 denies -> 302 access_denied with state and iss
    const denyRes = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner1.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: csrfToken, decision: 'deny' }),
    });
    assert.equal(denyRes.statusCode, 302);
    const denyLoc = new URL(denyRes.headers.location);
    assert.equal(denyLoc.searchParams.get('error'), 'access_denied');
    assert.equal(denyLoc.searchParams.get('state'), 'state-owner-check');
    assert.equal(denyLoc.searchParams.get('iss'), PUBLIC_URL);
    assert.equal(denyLoc.searchParams.get('code'), null);

    // Replaying consumed consent_id fails with 400
    const replayConsent = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner1.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }),
    });
    assert.equal(replayConsent.statusCode, 400);
  } finally {
    await harness.close();
  }
});

test('rejects invalid authorize parameters, redirect mismatches, non-S256 PKCE, wrong resource, and out-of-intersection scopes', async () => {
  const harness = await createTestHarness();
  try {
    const owner = await harness.loginOwner();
    const pkce = makePkce();

    // Unknown client_id -> 400 HTML (no redirect)
    const badClient = await harness.app.inject({
      method: 'GET',
      url: `${MCP_OAUTH_PATHS.authorize}?${new URLSearchParams({
        response_type: 'code',
        client_id: 'unknown-client',
        redirect_uri: CLIENT_A.redirectUris[0],
        state: 's1',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
      }).toString()}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(badClient.statusCode, 400);
    assert.equal(badClient.headers.location, undefined);

    // Non-exact redirect_uri (extra slash / extra query param) -> 400 HTML (no redirect)
    for (const badRedirect of [
      `${CLIENT_A.redirectUris[0]}/extra`,
      `${CLIENT_A.redirectUris[0]}?extra=1`,
      'https://evil.example/callback',
    ]) {
      const res = await harness.app.inject({
        method: 'GET',
        url: `${MCP_OAUTH_PATHS.authorize}?${new URLSearchParams({
          response_type: 'code',
          client_id: CLIENT_A.clientId,
          redirect_uri: badRedirect,
          state: 's1',
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
        }).toString()}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.headers.location, undefined);
    }

    // Verified client/redirect error cases redirect with exact error codes
    const errorCases = [
      {
        name: 'unsupported response_type',
        params: { response_type: 'token', state: 's-rt', code_challenge: pkce.challenge, code_challenge_method: 'S256' },
        expectedError: 'unsupported_response_type',
      },
      {
        name: 'missing state',
        params: { response_type: 'code', code_challenge: pkce.challenge, code_challenge_method: 'S256' },
        expectedError: 'invalid_request',
      },
      {
        name: 'plain PKCE rejected',
        params: { response_type: 'code', state: 's-pkce', code_challenge: pkce.challenge, code_challenge_method: 'plain' },
        expectedError: 'invalid_request',
      },
      {
        name: 'wrong resource rejected',
        params: { response_type: 'code', state: 's-res', code_challenge: pkce.challenge, code_challenge_method: 'S256', resource: 'https://center.example.com/api' },
        expectedError: 'invalid_target',
      },
      {
        name: 'client-configured scope outside supportedScopes rejected',
        params: { response_type: 'code', state: 's-sc1', code_challenge: pkce.challenge, code_challenge_method: 'S256', scope: 'unsupported:extra-scope' },
        expectedError: 'invalid_scope',
      },
      {
        name: 'server-supported scope outside client scopes rejected',
        params: { response_type: 'code', state: 's-sc2', code_challenge: pkce.challenge, code_challenge_method: 'S256', scope: 'mcp:bots:list' },
        expectedError: 'invalid_scope',
      },
      {
        name: 'empty scope rejected fail-closed',
        params: { response_type: 'code', state: 's-sc-empty', code_challenge: pkce.challenge, code_challenge_method: 'S256', scope: '' },
        expectedError: 'invalid_scope',
      },
    ];

    for (const tc of errorCases) {
      const qs = new URLSearchParams({
        client_id: CLIENT_A.clientId,
        redirect_uri: CLIENT_A.redirectUris[0],
        ...tc.params,
      });
      const res = await harness.app.inject({
        method: 'GET',
        url: `${MCP_OAUTH_PATHS.authorize}?${qs.toString()}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(res.statusCode, 302, tc.name);
      const loc = new URL(res.headers.location);
      assert.equal(loc.searchParams.get('error'), tc.expectedError, tc.name);
      assert.equal(loc.searchParams.get('iss'), PUBLIC_URL, tc.name);
      if (tc.params.state) assert.equal(loc.searchParams.get('state'), tc.params.state, tc.name);
    }

    // Omitting scope for CLIENT_A grants ONLY the intersection (excludes unsupported:extra-scope)
    const flowDefault = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      scope: undefined,
      state: 's-intersect',
    });
    assert.equal(flowDefault.authorizeQuery.has('scope'), false);
    const tokDefault = await harness.exchangeCode({ code: flowDefault.code, pkce: flowDefault.pkce, client: CLIENT_A });
    assert.equal(tokDefault.statusCode, 200);
    assert.equal(tokDefault.json().scope, 'mcp:read mcp:dispatch');
  } finally {
    await harness.close();
  }
});

test('enforces token endpoint errors, single-use auth code replay revocation, TTL expiry, and PKCE binding', async () => {
  let clockMs = 1_700_000_000_000;
  const harness = await createTestHarness({
    now: () => clockMs,
    ttl: {
      consent: 300_000,
      authCode: 60_000,
      accessToken: 300_000,
      refreshToken: 3_600_000,
    },
  });
  try {
    const owner = await harness.loginOwner();

    // Non-form content-type rejected
    const jsonReq = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/json',
      },
      payload: { grant_type: 'authorization_code' },
    });
    assert.equal(jsonReq.statusCode, 400);
    assert.equal(jsonReq.json().error, 'invalid_request');

    // Duplicate form parameter rejected
    const dupReq = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'grant_type=authorization_code&grant_type=authorization_code',
    });
    assert.equal(dupReq.statusCode, 400);
    assert.equal(dupReq.json().error, 'invalid_request');

    // Multiple client auth methods (Basic + client_secret in body) rejected
    const dualAuth = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({
        grant_type: 'authorization_code',
        client_secret: CLIENT_A.clientSecret,
        code: 'x',
      }),
    });
    assert.equal(dualAuth.statusCode, 400);
    assert.equal(dualAuth.json().error, 'invalid_request');

    // Bad Basic client secret -> 401 invalid_client + WWW-Authenticate: Basic
    const badSecret = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, 'wrong-secret-value-0000000'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'authorization_code', code: 'x' }),
    });
    assert.equal(badSecret.statusCode, 401);
    assert.equal(badSecret.json().error, 'invalid_client');
    assert.match(badSecret.headers['www-authenticate'], /^Basic /);

    // Unsupported grant_type -> 400 unsupported_grant_type
    const badGrant = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'client_credentials' }),
    });
    assert.equal(badGrant.statusCode, 400);
    assert.equal(badGrant.json().error, 'unsupported_grant_type');

    // Wrong PKCE verifier fails AND burns the auth code
    const pkceFailFlow = await harness.authorizeAndApprove({ ownerCookie: owner.cookie, client: CLIENT_A });
    const badVerifierRes = await harness.exchangeCode({
      code: pkceFailFlow.code,
      pkce: { verifier: randomBytes(32).toString('base64url') },
      client: CLIENT_A,
    });
    assert.equal(badVerifierRes.statusCode, 400);
    assert.equal(badVerifierRes.json().error, 'invalid_grant');
    const retryRealVerifier = await harness.exchangeCode({
      code: pkceFailFlow.code,
      pkce: pkceFailFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(retryRealVerifier.statusCode, 400);
    assert.equal(retryRealVerifier.json().error, 'invalid_grant');

    // Wrong resource on token exchange -> invalid_target
    const badResFlow = await harness.authorizeAndApprove({ ownerCookie: owner.cookie, client: CLIENT_A });
    const badResourceTok = await harness.exchangeCode({
      code: badResFlow.code,
      pkce: badResFlow.pkce,
      client: CLIENT_A,
      resource: 'https://other.example/mcp',
    });
    assert.equal(badResourceTok.statusCode, 400);
    assert.equal(badResourceTok.json().error, 'invalid_target');

    // Cross-client code redemption rejected
    const crossClientFlow = await harness.authorizeAndApprove({ ownerCookie: owner.cookie, client: CLIENT_A });
    const crossClientTok = await harness.exchangeCode({
      code: crossClientFlow.code,
      pkce: crossClientFlow.pkce,
      client: CLIENT_B,
      redirectUri: CLIENT_A.redirectUris[0],
    });
    assert.equal(crossClientTok.statusCode, 400);
    assert.equal(crossClientTok.json().error, 'invalid_grant');

    // Auth code TTL expiry -> invalid_grant
    const expiryFlow = await harness.authorizeAndApprove({ ownerCookie: owner.cookie, client: CLIENT_A });
    clockMs += 60_001;
    const expiredCodeRes = await harness.exchangeCode({
      code: expiryFlow.code,
      pkce: expiryFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(expiredCodeRes.statusCode, 400);
    assert.equal(expiredCodeRes.json().error, 'invalid_grant');

    // Auth code replay revokes the previously issued grant!
    const replayFlow = await harness.authorizeAndApprove({ ownerCookie: owner.cookie, client: CLIENT_A });
    const firstExchange = await harness.exchangeCode({
      code: replayFlow.code,
      pkce: replayFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(firstExchange.statusCode, 200);
    const { access_token: at1, refresh_token: rt1 } = firstExchange.json();

    const okBeforeReplay = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at1}` },
      payload: {},
    });
    assert.equal(okBeforeReplay.statusCode, 200);

    const replayExchange = await harness.exchangeCode({
      code: replayFlow.code,
      pkce: replayFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(replayExchange.statusCode, 400);
    assert.equal(replayExchange.json().error, 'invalid_grant');

    const deniedAfterReplay = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at1}` },
      payload: {},
    });
    assert.equal(deniedAfterReplay.statusCode, 401);

    const refreshAfterReplay = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1 }),
    });
    assert.equal(refreshAfterReplay.statusCode, 400);
    assert.equal(refreshAfterReplay.json().error, 'invalid_grant');
  } finally {
    await harness.close();
  }
});

test('supports refresh rotation, downscoping, reuse detection revocation, access token expiry, query-token rejection, and RFC 7009 revocation', async () => {
  let clockMs = 1_700_000_000_000;
  const harness = await createTestHarness({
    now: () => clockMs,
    ttl: {
      consent: 300_000,
      authCode: 60_000,
      accessToken: 120_000,
      refreshToken: 3_600_000,
    },
  });
  try {
    const owner = await harness.loginOwner();
    const flow = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      scope: 'mcp:read mcp:dispatch',
    });
    const tokRes = await harness.exchangeCode({ code: flow.code, pkce: flow.pkce, client: CLIENT_A });
    assert.equal(tokRes.statusCode, 200);
    const { access_token: at1, refresh_token: rt1 } = tokRes.json();

    // Access token in query param MUST NOT authenticate (header-only)
    const queryTokRes = await harness.app.inject({
      method: 'GET',
      url: `/mcp?access_token=${encodeURIComponent(at1)}`,
    });
    assert.equal(queryTokRes.statusCode, 401);

    // Cross-client refresh rejected without consuming rt1
    const crossRefresh = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_B.clientId, CLIENT_B.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1 }),
    });
    assert.equal(crossRefresh.statusCode, 400);
    assert.equal(crossRefresh.json().error, 'invalid_grant');

    // Upscope attempt on refresh rejected
    const upscopeRefresh = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1, scope: 'mcp:read mcp:bots:list' }),
    });
    assert.equal(upscopeRefresh.statusCode, 400);
    assert.equal(upscopeRefresh.json().error, 'invalid_scope');

    // Wrong resource on refresh rejected
    const badResourceRefresh = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1, resource: 'https://evil.example/mcp' }),
    });
    assert.equal(badResourceRefresh.statusCode, 400);
    assert.equal(badResourceRefresh.json().error, 'invalid_target');

    // Valid refresh with downscope rotates refresh token
    const rotatedRes = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1, scope: 'mcp:read' }),
    });
    assert.equal(rotatedRes.statusCode, 200);
    const { access_token: at2, refresh_token: rt2, scope: scope2 } = rotatedRes.json();
    assert.notEqual(at2, at1);
    assert.notEqual(rt2, rt1);
    assert.equal(scope2, 'mcp:read');

    const mcpAt2 = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at2}` },
      payload: {},
    });
    assert.equal(mcpAt2.statusCode, 200);
    assert.deepEqual(mcpAt2.json().actor.scopes, ['mcp:read']);

    // Replaying rotated rt1 triggers reuse detection and revokes at2 + rt2
    const reuseRes = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1 }),
    });
    assert.equal(reuseRes.statusCode, 400);
    assert.equal(reuseRes.json().error, 'invalid_grant');

    const revokedAt2 = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at2}` },
      payload: {},
    });
    assert.equal(revokedAt2.statusCode, 401);

    const revokedRt2 = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt2 }),
    });
    assert.equal(revokedRt2.statusCode, 400);
    assert.equal(revokedRt2.json().error, 'invalid_grant');

    // Fresh grant to test access token expiry + RFC 7009 revocation
    const flow2 = await harness.authorizeAndApprove({ ownerCookie: owner.cookie, client: CLIENT_A, scope: 'mcp:read' });
    const tokRes2 = await harness.exchangeCode({ code: flow2.code, pkce: flow2.pkce, client: CLIENT_A });
    const { access_token: at3, refresh_token: rt3 } = tokRes2.json();

    // Unauthenticated revoke -> 401 invalid_client
    const unauthRevoke = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.revoke,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ token: at3 }),
    });
    assert.equal(unauthRevoke.statusCode, 401);
    assert.equal(unauthRevoke.json().error, 'invalid_client');

    // Cross-client revoke returns 200 per RFC 7009 but MUST NOT revoke CLIENT_A's token
    const crossRevoke = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.revoke,
      headers: {
        authorization: basicAuthHeader(CLIENT_B.clientId, CLIENT_B.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ token: rt3, token_type_hint: 'refresh_token' }),
    });
    assert.equal(crossRevoke.statusCode, 200);
    const stillValid = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at3}` },
      payload: {},
    });
    assert.equal(stillValid.statusCode, 200);

    // Access token expires after TTL
    clockMs += 120_001;
    const expiredAt3 = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at3}` },
      payload: {},
    });
    assert.equal(expiredAt3.statusCode, 401);
    assert.match(expiredAt3.headers['www-authenticate'], /error="invalid_token"/);

    // Refresh still works before refresh TTL, then owner client revokes refresh token (revokes grant family)
    const refreshed3 = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt3 }),
    });
    assert.equal(refreshed3.statusCode, 200);
    const { access_token: at4, refresh_token: rt4 } = refreshed3.json();

    const revokeRt4 = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.revoke,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({
        client_id: CLIENT_A.clientId,
        client_secret: CLIENT_A.clientSecret,
        token: rt4,
        token_type_hint: 'refresh_token',
      }),
    });
    assert.equal(revokeRt4.statusCode, 200);

    const revokedAt4 = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at4}` },
      payload: {},
    });
    assert.equal(revokedAt4.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test('bounded in-memory capacity evicts oldest tokens and close() invalidates active grants', async () => {
  const harness = await createTestHarness({
    limits: {
      accessTokens: 2,
      refreshTokens: 2,
    },
  });
  try {
    const owner = await harness.loginOwner();
    const issued = [];
    for (let i = 0; i < 3; i += 1) {
      const flow = await harness.authorizeAndApprove({
        ownerCookie: owner.cookie,
        client: CLIENT_A,
        scope: 'mcp:read',
        state: `bounded-${i}`,
      });
      const res = await harness.exchangeCode({ code: flow.code, pkce: flow.pkce, client: CLIENT_A });
      assert.equal(res.statusCode, 200);
      issued.push(res.json());
    }

    // Oldest token (0) evicted due to max capacity 2; newest (1, 2) still valid
    const evictedRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${issued[0].access_token}` },
      payload: {},
    });
    assert.equal(evictedRes.statusCode, 401);

    const activeRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${issued[2].access_token}` },
      payload: {},
    });
    assert.equal(activeRes.statusCode, 200);

    // close() clears all in-memory grants
    harness.mcpOAuth.close();
    const afterClose = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${issued[2].access_token}` },
      payload: {},
    });
    assert.equal(afterClose.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test('enforces consent expiry, refresh expiry, long-lived replay revocation, and rotated refresh revocation', async () => {
  let clockMs = 1_700_000_000_000;
  const harness = await createTestHarness({
    now: () => clockMs,
    ttl: {
      consent: 60_000,
      authCode: 60_000,
      accessToken: 120_000,
      refreshToken: 600_000,
    },
  });
  try {
    const owner = await harness.loginOwner();

    // 1. Expired consent fails closed (400 HTML, no code issued)
    const pkceConsent = makePkce();
    const consentGet = await harness.app.inject({
      method: 'GET',
      url: `${MCP_OAUTH_PATHS.authorize}?${new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_A.clientId,
        redirect_uri: CLIENT_A.redirectUris[0],
        scope: 'mcp:read',
        state: 'state-consent-expiry',
        code_challenge: pkceConsent.challenge,
        code_challenge_method: 'S256',
      }).toString()}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(consentGet.statusCode, 200);
    const { consentId, csrfToken } = extractConsentForm(consentGet.body);
    clockMs += 60_000;
    const expiredConsentPost = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }),
    });
    assert.equal(expiredConsentPost.statusCode, 400);
    assert.equal(expiredConsentPost.headers.location, undefined);

    // 2. Auth-code replay after accessToken expiry (while refreshToken is still alive) revokes the refreshToken
    const codeReplayFlow = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      scope: 'mcp:read',
      state: 'state-long-code-replay',
    });
    const codeReplayTok = await harness.exchangeCode({
      code: codeReplayFlow.code,
      pkce: codeReplayFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(codeReplayTok.statusCode, 200);
    const { refresh_token: codeReplayRt } = codeReplayTok.json();
    clockMs += 120_001;
    const lateReplay = await harness.exchangeCode({
      code: codeReplayFlow.code,
      pkce: codeReplayFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(lateReplay.statusCode, 400);
    assert.equal(lateReplay.json().error, 'invalid_grant');
    const refreshAfterLateReplay = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: codeReplayRt }),
    });
    assert.equal(refreshAfterLateReplay.statusCode, 400);
    assert.equal(refreshAfterLateReplay.json().error, 'invalid_grant');

    // 3. Refresh token TTL expiry fails closed
    const expRtFlow = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      scope: 'mcp:read',
      state: 'state-rt-expiry',
    });
    const expRtTok = await harness.exchangeCode({
      code: expRtFlow.code,
      pkce: expRtFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(expRtTok.statusCode, 200);
    clockMs += 600_000;
    const expiredRefresh = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: expRtTok.json().refresh_token }),
    });
    assert.equal(expiredRefresh.statusCode, 400);
    assert.equal(expiredRefresh.json().error, 'invalid_grant');

    // 4. Refresh reuse detection after rotating near original rt1 expiry still revokes live rt2/at2
    const nearExpiryFlow = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      scope: 'mcp:read',
      state: 'state-near-expiry-reuse',
    });
    const nearExpiryTok = await harness.exchangeCode({
      code: nearExpiryFlow.code,
      pkce: nearExpiryFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(nearExpiryTok.statusCode, 200);
    const rt1 = nearExpiryTok.json().refresh_token;
    clockMs += 590_000;
    const rotated = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1 }),
    });
    assert.equal(rotated.statusCode, 200);
    const { access_token: at2, refresh_token: rt2 } = rotated.json();
    clockMs += 20_000;
    const lateReuse = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt1 }),
    });
    assert.equal(lateReuse.statusCode, 400);
    assert.equal(lateReuse.json().error, 'invalid_grant');
    const at2AfterReuse = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${at2}` },
      payload: {},
    });
    assert.equal(at2AfterReuse.statusCode, 401);
    const rt2AfterReuse = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: rt2 }),
    });
    assert.equal(rt2AfterReuse.statusCode, 400);
    assert.equal(rt2AfterReuse.json().error, 'invalid_grant');

    // 5. Revoking a previously rotated refresh token revokes the active grant only for the owning client
    const revRotatedFlow = await harness.authorizeAndApprove({
      ownerCookie: owner.cookie,
      client: CLIENT_A,
      scope: 'mcp:read',
      state: 'state-revoke-rotated',
    });
    const revRotatedTok = await harness.exchangeCode({
      code: revRotatedFlow.code,
      pkce: revRotatedFlow.pkce,
      client: CLIENT_A,
    });
    assert.equal(revRotatedTok.statusCode, 200);
    const oldRt = revRotatedTok.json().refresh_token;
    const rotatedForRevoke = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ grant_type: 'refresh_token', refresh_token: oldRt }),
    });
    assert.equal(rotatedForRevoke.statusCode, 200);
    const { access_token: activeAt } = rotatedForRevoke.json();

    const crossRevokeOld = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.revoke,
      headers: {
        authorization: basicAuthHeader(CLIENT_B.clientId, CLIENT_B.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ token: oldRt, token_type_hint: 'refresh_token' }),
    });
    assert.equal(crossRevokeOld.statusCode, 200);
    const stillActive = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${activeAt}` },
      payload: {},
    });
    assert.equal(stillActive.statusCode, 200);

    const ownRevokeOld = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.revoke,
      headers: {
        authorization: basicAuthHeader(CLIENT_A.clientId, CLIENT_A.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ token: oldRt, token_type_hint: 'refresh_token' }),
    });
    assert.equal(ownRevokeOld.statusCode, 200);
    const revokedActive = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${activeAt}` },
      payload: {},
    });
    assert.equal(revokedActive.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test('official MCP SDK OAuth discovery and authorize succeed for subset-scoped clients and still reject explicit unauthorized scopes', async () => {
  const harness = await createTestHarness();
  try {
    const owner = await harness.loginOwner();
    const fetchFn = createInjectFetch(harness.app);

    // 1. Anonymous 401 challenge omits global scope while advertising RFC 9728 resource_metadata
    const challengeRes = await fetchFn(RESOURCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(challengeRes.status, 401);
    const wwwParams = extractWWWAuthenticateParams(challengeRes);
    assert.equal(wwwParams.resourceMetadataUrl?.href, `${PUBLIC_URL}${MCP_OAUTH_PATHS.protectedResourceMetadata}`);
    assert.equal(wwwParams.scope, undefined);
    assert.equal(wwwParams.error, undefined);

    // 2. Subset-scoped client (CLIENT_B only has ['mcp:read']) without clientMetadata.scope discovers PRM+AS and authorizes cleanly
    const subsetProvider = createSdkOAuthProvider(CLIENT_B, { state: 'sdk-subset-state-001' });
    const startResult = await sdkOAuth(subsetProvider, {
      serverUrl: RESOURCE_URL,
      resourceMetadataUrl: wwwParams.resourceMetadataUrl,
      scope: wwwParams.scope,
      fetchFn,
    });
    assert.equal(startResult, 'REDIRECT');

    const discovered = subsetProvider.getDiscoveryState();
    assert.equal(discovered?.resourceMetadata?.resource, RESOURCE_URL);
    assert.deepEqual(discovered?.resourceMetadata?.authorization_servers, [PUBLIC_URL]);
    assert.equal(discovered?.resourceMetadata?.scopes_supported, undefined);
    assert.deepEqual(discovered?.authorizationServerMetadata?.scopes_supported, SUPPORTED_SCOPES);

    const authUrl = subsetProvider.getCapturedAuthorizationUrl();
    assert.ok(authUrl instanceof URL);
    assert.equal(authUrl.origin, PUBLIC_URL);
    assert.equal(authUrl.pathname, MCP_OAUTH_PATHS.authorize);
    assert.equal(authUrl.searchParams.get('client_id'), CLIENT_B.clientId);
    assert.equal(authUrl.searchParams.get('resource'), RESOURCE_URL);
    assert.equal(authUrl.searchParams.has('scope'), false);

    const consentRes = await harness.app.inject({
      method: 'GET',
      url: `${authUrl.pathname}${authUrl.search}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(consentRes.statusCode, 200);
    assert.match(consentRes.body, /mcp:read/);
    assert.doesNotMatch(consentRes.body, /mcp:dispatch/);
    assert.doesNotMatch(consentRes.body, /mcp:bots:list/);

    const { consentId, csrfToken } = extractConsentForm(consentRes.body);
    const approveRes = await harness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: owner.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({
        consent_id: consentId,
        csrf_token: csrfToken,
        decision: 'approve',
      }),
    });
    assert.equal(approveRes.statusCode, 302);
    const callbackUrl = new URL(approveRes.headers.location);
    assert.equal(callbackUrl.searchParams.get('error'), null);
    assert.equal(callbackUrl.searchParams.get('state'), 'sdk-subset-state-001');
    assert.equal(callbackUrl.searchParams.get('iss'), PUBLIC_URL);
    const code = callbackUrl.searchParams.get('code');
    assert.ok(code);

    const finishResult = await sdkOAuth(subsetProvider, {
      serverUrl: RESOURCE_URL,
      authorizationCode: code,
      resourceMetadataUrl: wwwParams.resourceMetadataUrl,
      scope: wwwParams.scope,
      fetchFn,
    });
    assert.equal(finishResult, 'AUTHORIZED');
    const issuedTokens = subsetProvider.getTokens();
    assert.ok(issuedTokens?.access_token);
    assert.equal(issuedTokens.scope, 'mcp:read');

    const mcpRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${issuedTokens.access_token}` },
      payload: {},
    });
    assert.equal(mcpRes.statusCode, 200);
    assert.deepEqual(mcpRes.json().actor, {
      kind: 'oauth',
      clientId: CLIENT_B.clientId,
      scopes: ['mcp:read'],
      botTargets: [],
    });

    // 3. Explicit unauthorized scope in clientMetadata.scope is still rejected with 302 invalid_scope
    const badScopeProvider = createSdkOAuthProvider(CLIENT_B, {
      scope: 'mcp:read mcp:dispatch',
      state: 'sdk-bad-scope-state-001',
    });
    const badStartResult = await sdkOAuth(badScopeProvider, {
      serverUrl: RESOURCE_URL,
      resourceMetadataUrl: wwwParams.resourceMetadataUrl,
      scope: wwwParams.scope,
      fetchFn,
    });
    assert.equal(badStartResult, 'REDIRECT');
    const badAuthUrl = badScopeProvider.getCapturedAuthorizationUrl();
    assert.equal(badAuthUrl.searchParams.get('scope'), 'mcp:read mcp:dispatch');

    const badAuthorizeRes = await harness.app.inject({
      method: 'GET',
      url: `${badAuthUrl.pathname}${badAuthUrl.search}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(badAuthorizeRes.statusCode, 302);
    const badCallback = new URL(badAuthorizeRes.headers.location);
    assert.equal(badCallback.searchParams.get('error'), 'invalid_scope');
    assert.equal(badCallback.searchParams.get('state'), 'sdk-bad-scope-state-001');
    assert.equal(badCallback.searchParams.get('iss'), PUBLIC_URL);
  } finally {
    await harness.close();
  }
});
