import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { registerAuth } from '../../center-server/auth.js';
import { MCP_OAUTH_PATHS, registerMcpOAuth } from '../../center-server/mcp/oauth.js';
import { registerMcp } from '../../center-server/mcp/server.js';

const centerRequire = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = centerRequire('fastify');
const fastifyStatic = centerRequire('@fastify/static');
const { UnauthorizedError } = centerRequire('@modelcontextprotocol/sdk/client/auth.js');
const { Client } = centerRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = centerRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');

const PUBLIC_URL = 'https://center.example.com';
const VALID_BEARER = 'Bearer valid-mcp-token-for-tests';

function sampleOperations(calls = []) {
  return {
    list(actor) {
      const base = [
        {
          name: 'bots_list',
          description: 'List available bots',
          inputSchema: {
            type: 'object',
            properties: {
              includeArchived: { type: 'boolean' },
            },
          },
          readOnly: true,
          destructive: false,
        },
        {
          name: 'note_append',
          description: 'Append a note without deleting existing data',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
          readOnly: false,
          destructive: false,
        },
        {
          name: 'contradictory_flag_tool',
          description: 'Fails safe when both readOnly and destructive are true',
          inputSchema: { type: 'object', properties: {} },
          readOnly: true,
          destructive: true,
        },
        {
          name: 'unspecified_write_tool',
          description: 'Fails safe when destructive is omitted on a non-readOnly tool',
          inputSchema: { type: 'object', properties: {} },
          readOnly: false,
        },
        {
          name: 'readonly_default_tool',
          description: 'Read-only tool with destructive omitted',
          inputSchema: { type: 'object', properties: {} },
          readOnly: true,
        },
      ];
      if (actor?.role === 'admin') {
        base.push({
          name: 'bot_delete',
          description: 'Permanently delete a bot',
          inputSchema: {
            type: 'object',
            properties: {
              botId: { type: 'string' },
            },
            required: ['botId'],
          },
          readOnly: false,
          destructive: true,
        });
      }
      return base;
    },
    async call(actor, name, args) {
      calls.push({ actor, name, args });
      if (name === 'bots_list') {
        return { bots: [{ id: 'bot-1', name: 'Helper' }], actorId: actor.id };
      }
      if (name === 'note_append') {
        return { appended: args.text ?? '' };
      }
      if (name === 'bot_delete') {
        return { deleted: args.botId };
      }
      return { ok: true };
    },
  };
}

function defaultAuthenticate(req) {
  if (req.headers.authorization === VALID_BEARER) {
    return { id: 'actor-admin', role: 'admin', clientId: 'gemini-server' };
  }
  if (req.headers.authorization === 'Bearer reader-token') {
    return { id: 'actor-reader', role: 'reader', clientId: 'gemini-reader' };
  }
  return null;
}

async function createMcpApp(overrides = {}) {
  const calls = [];
  const app = Fastify({ logger: false });
  registerMcp(app, {
    publicUrl: PUBLIC_URL,
    authenticate: overrides.authenticate ?? defaultAuthenticate,
    operations: overrides.operations ?? sampleOperations(calls),
    ...overrides.extraOptions,
  });
  await app.ready();
  return { app, calls };
}

function mcpPost(app, payload, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: VALID_BEARER,
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    payload,
  });
}

test('Streamable HTTP stateless JSON/POST supports initialize, notification, tools/list annotations, and tools/call', async () => {
  const { app, calls } = await createMcpApp();
  try {
    const initRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'gemini-test', version: '1.0.0' },
      },
    });
    assert.equal(initRes.statusCode, 200);
    assert.match(initRes.headers['content-type'], /^application\/json\b/i);
    assert.equal(initRes.headers['mcp-session-id'], undefined);
    assert.equal(initRes.headers['cache-control'], 'no-store');
    assert.equal(initRes.headers['vary'], 'Origin');
    const initBody = initRes.json();
    assert.equal(initBody.jsonrpc, '2.0');
    assert.equal(initBody.id, 1);
    assert.ok(initBody.result?.capabilities?.tools);

    const notifyRes = await mcpPost(app, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notifyRes.statusCode, 202);
    assert.equal(notifyRes.body, '');

    // Also works when a JSON-only client sends Accept: application/json.
    const listRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { accept: 'application/json' },
    );
    assert.equal(listRes.statusCode, 200);
    assert.match(listRes.headers['content-type'], /^application\/json\b/i);
    const tools = listRes.json().result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    assert.deepEqual(byName.get('bots_list')?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
    });
    assert.deepEqual(byName.get('note_append')?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
    });
    assert.deepEqual(byName.get('bot_delete')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
    });
    assert.deepEqual(byName.get('contradictory_flag_tool')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
    });
    assert.deepEqual(byName.get('unspecified_write_tool')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
    });
    assert.deepEqual(byName.get('readonly_default_tool')?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
    });

    const callRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'bots_list', arguments: { includeArchived: false } },
    });
    assert.equal(callRes.statusCode, 200);
    const callBody = callRes.json();
    assert.equal(callBody.id, 3);
    assert.ok(!callBody.result.isError);
    const parsedContent = JSON.parse(callBody.result.content[0].text);
    assert.equal(parsedContent.actorId, 'actor-admin');
    assert.equal(parsedContent.bots[0].id, 'bot-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bots_list');
    assert.deepEqual(calls[0].args, { includeArchived: false });
  } finally {
    await app.close();
  }
});

test('Fastify + official MCP SDK Client and StreamableHTTPClientTransport interoperate over real HTTP', async () => {
  const { app, calls } = await createMcpApp();
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const transportErrors = [];
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: {
        headers: {
          authorization: VALID_BEARER,
        },
      },
    });
    transport.onerror = (err) => {
      transportErrors.push(err);
    };
    const client = new Client({ name: 'pibot-sdk-interop-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const botsList = listed.tools.find((tool) => tool.name === 'bots_list');
      const botDelete = listed.tools.find((tool) => tool.name === 'bot_delete');
      assert.ok(botsList);
      assert.deepEqual(botsList.annotations, { readOnlyHint: true, destructiveHint: false });
      assert.deepEqual(botDelete?.annotations, { readOnlyHint: false, destructiveHint: true });

      const called = await client.callTool({
        name: 'note_append',
        arguments: { text: 'hello over real http' },
      });
      assert.ok(!called.isError);
      assert.deepEqual(JSON.parse(called.content[0].text), { appended: 'hello over real http' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].actor.id, 'actor-admin');

      // Allow the SDK client's background GET /mcp SSE probe (expecting 405) to settle cleanly.
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(transportErrors, []);
    } finally {
      await client.close();
    }

    // Unauthenticated official SDK client must fail over real HTTP without executing operations.
    const unauthTransport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
    const unauthClient = new Client({ name: 'pibot-sdk-unauth-test', version: '1.0.0' });
    try {
      await assert.rejects(() => unauthClient.connect(unauthTransport));
      assert.equal(calls.length, 1);
    } finally {
      await unauthClient.close();
    }
  } finally {
    await app.close();
  }
});

test('Unsupported methods enforce auth before 405 Allow: POST, register without duplicate HEAD routes, and never hit static SPA fallback', async () => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-mcp-spa-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><html><body>SPA SHELL</body></html>');

  let listInvocations = 0;
  let callInvocations = 0;
  const operations = {
    list() {
      listInvocations += 1;
      return [];
    },
    async call() {
      callInvocations += 1;
      return {};
    },
  };

  // Must also register cleanly when global exposeHeadRoutes is explicitly false.
  const noHeadApp = Fastify({ logger: false, exposeHeadRoutes: false });
  registerMcp(noHeadApp, { publicUrl: PUBLIC_URL, authenticate: defaultAuthenticate, operations });
  await noHeadApp.ready();
  await noHeadApp.close();

  // Default Fastify has exposeHeadRoutes: true; registering /mcp and /mcp/* must not throw FST_ERR_DUPLICATED_ROUTE.
  const app = Fastify({ logger: false });
  try {
    registerMcp(app, {
      publicUrl: PUBLIC_URL,
      authenticate: defaultAuthenticate,
      operations,
    });
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
    await app.ready();

    // Authenticated GET (including Accept: text/event-stream used by MCP SDK) -> 405 Allow: POST
    for (const accept of [undefined, 'text/event-stream', 'text/html', 'application/json']) {
      const headers = { authorization: VALID_BEARER, ...(accept ? { accept } : {}) };
      const getRes = await app.inject({ method: 'GET', url: '/mcp', headers });
      assert.equal(getRes.statusCode, 405, `expected 405 for authenticated GET Accept=${accept}`);
      assert.equal(getRes.headers.allow, 'POST');
      assert.equal(getRes.headers['cache-control'], 'no-store');
      assert.doesNotMatch(getRes.body, /SPA SHELL/);
    }

    // Authenticated DELETE / PUT (even with non-JSON body) / PATCH / OPTIONS / HEAD -> 405 Allow: POST
    const delRes = await app.inject({ method: 'DELETE', url: '/mcp', headers: { authorization: VALID_BEARER } });
    assert.equal(delRes.statusCode, 405);
    assert.equal(delRes.headers.allow, 'POST');

    const putRes = await app.inject({
      method: 'PUT',
      url: '/mcp',
      headers: { authorization: VALID_BEARER, 'content-type': 'text/plain' },
      payload: 'not-json',
    });
    assert.equal(putRes.statusCode, 405);
    assert.equal(putRes.headers.allow, 'POST');

    const headRes = await app.inject({ method: 'HEAD', url: '/mcp', headers: { authorization: VALID_BEARER } });
    assert.equal(headRes.statusCode, 405);
    assert.equal(headRes.headers.allow, 'POST');
    assert.equal(headRes.body, '');

    // Unauthenticated GET / DELETE / HEAD / PUT / PATCH / OPTIONS -> 401 with soft WWW-Authenticate (never 405 or SPA)
    for (const method of ['GET', 'DELETE', 'HEAD', 'PUT', 'PATCH', 'OPTIONS']) {
      const unauthRes = await app.inject({ method, url: '/mcp' });
      assert.equal(unauthRes.statusCode, 401, `expected 401 for unauthenticated ${method} /mcp`);
      assert.match(
        unauthRes.headers['www-authenticate'],
        /Bearer resource_metadata="https:\/\/center\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/,
      );
      assert.doesNotMatch(unauthRes.headers['www-authenticate'], /error="invalid_token"/);
      assert.doesNotMatch(unauthRes.body, /SPA SHELL/);
      if (method === 'HEAD') {
        assert.equal(unauthRes.body, '');
      }
    }

    // Invalid Bearer token on GET -> 401 with hard invalid_token challenge
    const badTokenGetRes = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer wrong-token', accept: 'text/event-stream' },
    });
    assert.equal(badTokenGetRes.statusCode, 401);
    assert.match(badTokenGetRes.headers['www-authenticate'], /error="invalid_token"/);

    // /mcp/* subpaths (including /mcp/ and non-JSON POST) -> 404, never SPA fallback or 415
    const subpathRes = await app.inject({ method: 'GET', url: '/mcp/subpath' });
    assert.equal(subpathRes.statusCode, 404);
    assert.doesNotMatch(subpathRes.body, /SPA SHELL/);

    const subpathPostRes = await app.inject({
      method: 'POST',
      url: '/mcp/subpath',
      headers: { 'content-type': 'text/plain' },
      payload: 'raw',
    });
    assert.equal(subpathPostRes.statusCode, 404);

    const subpathHeadRes = await app.inject({ method: 'HEAD', url: '/mcp/subpath' });
    assert.equal(subpathHeadRes.statusCode, 404);
    assert.equal(subpathHeadRes.body, '');

    const trailingSlashRes = await app.inject({ method: 'GET', url: '/mcp/' });
    assert.equal(trailingSlashRes.statusCode, 404);
    assert.doesNotMatch(trailingSlashRes.body, /SPA SHELL/);

    const spaRes = await app.inject({ method: 'GET', url: '/dashboard' });
    assert.equal(spaRes.statusCode, 200);
    assert.match(spaRes.body, /SPA SHELL/);

    assert.equal(listInvocations, 0);
    assert.equal(callInvocations, 0);
  } finally {
    await app.close();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }
});

test('Authentication failure returns HTTP 401/403 (never JSON-RPC 200) and never executes operations', async () => {
  let listInvocations = 0;
  let callInvocations = 0;
  const operations = {
    list() {
      listInvocations += 1;
      return [{ name: 'bots_list', description: 'List', inputSchema: { type: 'object', properties: {} }, readOnly: true, destructive: false }];
    },
    async call() {
      callInvocations += 1;
      return { ok: true };
    },
  };

  // Case 1: authenticate returns null (soft vs hard WWW-Authenticate header)
  const app1 = Fastify({ logger: false });
  registerMcp(app1, { publicUrl: PUBLIC_URL, authenticate: () => null, operations });
  await app1.ready();
  try {
    const softRes = await app1.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} },
    });
    assert.equal(softRes.statusCode, 401);
    assert.equal(
      softRes.headers['www-authenticate'],
      'Bearer resource_metadata="https://center.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    const softBody = softRes.json();
    assert.equal(softBody.jsonrpc, undefined);
    assert.equal(softBody.error.code, 'UNAUTHENTICATED');

    const hardRes = await app1.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer invalid-token' },
      payload: { jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} },
    });
    assert.equal(hardRes.statusCode, 401);
    assert.equal(
      hardRes.headers['www-authenticate'],
      'Bearer resource_metadata="https://center.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    );
  } finally {
    await app1.close();
  }

  // Case 2: authenticate throws error with secret token
  const app2 = Fastify({ logger: false });
  registerMcp(app2, {
    publicUrl: PUBLIC_URL,
    authenticate: async () => {
      throw new Error('Token verification failed for Bearer pboauth_secret1234567890123456');
    },
    operations,
  });
  await app2.ready();
  try {
    const res = await app2.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'bots_list', arguments: {} } },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().jsonrpc, undefined);
    assert.doesNotMatch(res.body, /pboauth_secret/);
    assert.doesNotMatch(res.body, /Token verification failed/);
  } finally {
    await app2.close();
  }

  // Case 3: authenticate rejects with 403 insufficient scope (thrown and soft-returned)
  const app3 = Fastify({ logger: false });
  registerMcp(app3, {
    publicUrl: PUBLIC_URL,
    authenticate: async () => {
      throw Object.assign(new Error('missing scope internal detail'), { statusCode: 403, code: 'INSUFFICIENT_SCOPE' });
    },
    operations,
  });
  await app3.ready();
  try {
    const res = await app3.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().jsonrpc, undefined);
    assert.equal(res.json().error.code, 'INSUFFICIENT_SCOPE');
    assert.equal(
      res.headers['www-authenticate'],
      'Bearer resource_metadata="https://center.example.com/.well-known/oauth-protected-resource/mcp", error="insufficient_scope"',
    );
    assert.doesNotMatch(res.body, /internal detail/);
  } finally {
    await app3.close();
  }

  const app3b = Fastify({ logger: false });
  registerMcp(app3b, {
    publicUrl: PUBLIC_URL,
    authenticate: async () => ({
      ok: false,
      statusCode: 403,
      code: 'INSUFFICIENT_SCOPE',
      wwwAuthenticate: 'Bearer resource_metadata="https://center.example.com/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="pibot:bots:write"',
    }),
    operations,
  });
  await app3b.ready();
  try {
    const res = await app3b.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 121, method: 'tools/list', params: {} },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'INSUFFICIENT_SCOPE');
    assert.equal(
      res.headers['www-authenticate'],
      'Bearer resource_metadata="https://center.example.com/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="pibot:bots:write"',
    );
  } finally {
    await app3b.close();
  }

  // Case 4: authenticate sends reply directly
  const app4 = Fastify({ logger: false });
  registerMcp(app4, {
    publicUrl: PUBLIC_URL,
    authenticate: async (_req, reply) => {
      reply.code(401).header('WWW-Authenticate', 'Bearer error="invalid_token"').send({ error: { code: 'INVALID_TOKEN' } });
    },
    operations,
  });
  await app4.ready();
  try {
    const res = await app4.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 13, method: 'tools/list', params: {} },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer error="invalid_token"');
    assert.equal(res.json().error.code, 'INVALID_TOKEN');
  } finally {
    await app4.close();
  }

  // Case 5: real registerMcpOAuth + registerMcp preserves soft/hard OAuth WWW-Authenticate headers
  const app5 = Fastify({ logger: false });
  const mcpOAuth = registerMcpOAuth(app5, {
    publicUrl: PUBLIC_URL,
    clients: [],
    supportedScopes: ['pibot:bots:read', 'pibot:messages:write'],
  });
  registerMcp(app5, {
    publicUrl: PUBLIC_URL,
    authenticate: mcpOAuth.authenticate,
    operations,
  });
  await app5.ready();
  try {
    for (const method of ['POST', 'GET']) {
      const softOAuthRes = await app5.inject({
        method,
        url: '/mcp',
        ...(method === 'POST' ? { payload: { jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} } } : {}),
      });
      assert.equal(softOAuthRes.statusCode, 401);
      assert.equal(softOAuthRes.headers['cache-control'], 'no-store');
      assert.equal(softOAuthRes.headers['vary'], 'Origin');
      const softWwwAuth = softOAuthRes.headers['www-authenticate'];
      assert.match(softWwwAuth, /resource_metadata="https:\/\/center\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
      assert.doesNotMatch(softWwwAuth, /\bscope=/i);
      assert.doesNotMatch(softWwwAuth, /error="invalid_token"/);
    }

    for (const method of ['POST', 'GET', 'HEAD']) {
      const hardOAuthRes = await app5.inject({
        method,
        url: '/mcp',
        headers: { authorization: 'Bearer pbmcp_at_invalidtokenvalue00000000000000000000000' },
        ...(method === 'POST' ? { payload: { jsonrpc: '2.0', id: 15, method: 'tools/list', params: {} } } : {}),
      });
      assert.equal(hardOAuthRes.statusCode, 401);
      const hardWwwAuth = hardOAuthRes.headers['www-authenticate'];
      assert.match(hardWwwAuth, /resource_metadata="https:\/\/center\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
      assert.match(hardWwwAuth, /error="invalid_token"/);
      assert.doesNotMatch(hardWwwAuth, /\bscope=/i);
      if (method === 'HEAD') {
        assert.equal(hardOAuthRes.body, '');
      }
    }
  } finally {
    await app5.close();
  }

  assert.equal(listInvocations, 0);
  assert.equal(callInvocations, 0);
});

test('Origin validation allows absent Origin and configured HTTPS origins, blocks bad Origins, and ignores Host header', async () => {
  const { app, calls } = await createMcpApp({
    extraOptions: {
      allowedOrigins: ['https://gemini.google.com'],
    },
  });
  try {
    // 1. Server-side Gemini HTTPS call with NO Origin header -> allowed
    const noOriginRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    assert.equal(noOriginRes.statusCode, 200);

    // 2. Same origin as publicUrl -> allowed
    const sameOriginRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { origin: 'https://center.example.com' },
    );
    assert.equal(sameOriginRes.statusCode, 200);

    // 3. Explicitly allowed Origin -> allowed
    const configuredOriginRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { origin: 'https://gemini.google.com' },
    );
    assert.equal(configuredOriginRes.statusCode, 200);

    // 4. Spoofed Host header matching evil Origin MUST still be rejected (Host is never trusted)
    const spoofedHostRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bots_list', arguments: {} } },
      { host: 'evil.example.com', origin: 'https://evil.example.com' },
    );
    assert.equal(spoofedHostRes.statusCode, 403);
    assert.equal(spoofedHostRes.json().error.code, 'FORBIDDEN_ORIGIN');

    // 5. Disallowed / downgraded / malformed / null origins -> 403
    for (const badOrigin of [
      'null',
      'http://center.example.com',
      'https://center.example.com/',
      'https://center.example.com.evil.com',
      'https://user:pass@center.example.com',
    ]) {
      const badRes = await mcpPost(
        app,
        { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
        { origin: badOrigin },
      );
      assert.equal(badRes.statusCode, 403, `expected 403 for Origin=${badOrigin}`);
    }

    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('registerMcp rejects insecure publicUrl and allowedOrigins configuration', () => {
  const app = Fastify({ logger: false });
  assert.throws(() => registerMcp(app, {
    publicUrl: 'http://center.example.com',
    authenticate: defaultAuthenticate,
    operations: sampleOperations(),
  }));
  assert.throws(() => registerMcp(app, {
    publicUrl: PUBLIC_URL,
    authenticate: defaultAuthenticate,
    operations: sampleOperations(),
    allowedOrigins: ['*'],
  }));
  assert.throws(() => registerMcp(app, {
    publicUrl: PUBLIC_URL,
    authenticate: defaultAuthenticate,
    operations: sampleOperations(),
    allowedOrigins: ['null'],
  }));
  assert.throws(() => registerMcp(app, {
    publicUrl: PUBLIC_URL,
    authenticate: defaultAuthenticate,
    operations: sampleOperations(),
    allowedOrigins: ['http://gemini.google.com'],
  }));
});

test('Enforces bounded requests, content-type/accept checks, and rejects batch or deeply nested payloads', async () => {
  const { app, calls } = await createMcpApp({
    extraOptions: {
      maxRequestBytes: 512,
    },
  });
  try {
    // Oversized body -> 413
    const hugeRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'note_append', arguments: { text: 'a'.repeat(1024) } },
    });
    assert.equal(hugeRes.statusCode, 413);
    assert.equal(hugeRes.json().error.code, 'PAYLOAD_TOO_LARGE');

    // Wrong Content-Type -> 415
    const badCtRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'text/plain',
      },
      payload: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    assert.equal(badCtRes.statusCode, 415);

    // Non-JSON Accept (HTML, SSE-only, or JSON explicitly q=0) -> 406
    for (const badAccept of ['text/html', 'text/event-stream', 'application/json;q=0, */*;q=1']) {
      const badAcceptRes = await mcpPost(
        app,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { accept: badAccept },
      );
      assert.equal(badAcceptRes.statusCode, 406, `expected 406 for Accept=${badAccept}`);
    }

    // Absent Accept or wildcard Accept -> 200 JSON (Gemini / simple HTTPS clients)
    const noAcceptRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} },
    });
    assert.equal(noAcceptRes.statusCode, 200);

    const wildcardAcceptRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 22, method: 'tools/list', params: {} },
      { accept: '*/*' },
    );
    assert.equal(wildcardAcceptRes.statusCode, 200);

    // Invalid Mcp-Protocol-Version header -> 400
    const badProtoRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 23, method: 'tools/list', params: {} },
      { 'mcp-protocol-version': '' },
    );
    assert.equal(badProtoRes.statusCode, 400);

    // Invalid JSON syntax -> 400 safe error
    const badJsonRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
      },
      payload: '{invalid json',
    });
    assert.equal(badJsonRes.statusCode, 400);
    assert.equal(badJsonRes.json().error.code, 'INVALID_JSON');

    // JSON-RPC batch array -> rejected with 400
    const batchRes = await mcpPost(app, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    assert.equal(batchRes.statusCode, 400);

    // Deeply nested JSON (> 20 levels) -> rejected with 400
    let nested = { leaf: true };
    for (let i = 0; i < 25; i += 1) {
      nested = { child: nested };
    }
    const deepRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'note_append', arguments: nested },
    });
    assert.equal(deepRes.statusCode, 400);

    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('Bounds responses, scrubs secrets, hides internal errors, and isolates per-actor tools', async () => {
  const receivedArgs = [];
  const { app } = await createMcpApp({
    operations: {
      list(actor) {
        const list = [
          {
            name: 'huge_tool',
            description: 'Returns large data',
            inputSchema: { type: 'object', properties: {} },
            readOnly: true,
            destructive: false,
          },
          {
            name: 'leaky_tool',
            description: 'Returns object with secrets',
            inputSchema: { type: 'object', properties: {} },
            readOnly: true,
            destructive: false,
          },
          {
            name: 'failing_tool',
            description: 'Throws internal error',
            inputSchema: { type: 'object', properties: {} },
            readOnly: false,
            destructive: false,
          },
          {
            name: 'safe_code_fail_tool',
            description: 'Throws known safe code error',
            inputSchema: { type: 'object', properties: {} },
            readOnly: false,
            destructive: false,
          },
          {
            name: 'echo_args',
            description: 'Echoes args',
            inputSchema: { type: 'object', properties: {} },
            readOnly: true,
            destructive: false,
          },
          {
            name: 'domain_content_tool',
            description: 'Returns plain domain object with a content field',
            inputSchema: { type: 'object', properties: {} },
            readOnly: true,
            destructive: false,
          },
          {
            name: 'oversized_error_tool',
            description: 'Throws RESPONSE_TOO_LARGE',
            inputSchema: { type: 'object', properties: {} },
            readOnly: true,
            destructive: false,
          },
        ];
        if (actor.role === 'admin') {
          list.push({
            name: 'admin_only',
            description: 'Admin operation',
            inputSchema: { type: 'object', properties: {} },
            readOnly: false,
            destructive: true,
          });
        }
        return list;
      },
      async call(_actor, name, args) {
        receivedArgs.push({ name, args });
        if (name === 'huge_tool') {
          return { text: 'x'.repeat(20_000) };
        }
        if (name === 'leaky_tool') {
          return {
            ok: true,
            deviceToken: 'secret-device-token-value',
            ownerPasswordHash: 'scrypt$0123456789abcdef0123456789abcdef$' + 'a'.repeat(128),
            note: 'Auth header was Bearer pboauth_supersecret1234567890, pbmcp_at_secretmcpaccess1234567890, and token ya29.abcdefghijklmnop',
          };
        }
        if (name === 'failing_tool') {
          throw Object.assign(
            new Error('SQLITE_CANTOPEN /var/lib/pibot/center.db with Bearer pboauth_secret999999999999'),
            { expose: true, publicMessage: 'leaked publicMessage detail' },
          );
        }
        if (name === 'safe_code_fail_tool') {
          throw Object.assign(new Error('internal row id 42 leaked'), { code: 'NOT_FOUND' });
        }
        if (name === 'echo_args') {
          return { keys: Object.keys(args) };
        }
        if (name === 'domain_content_tool') {
          return { content: [{ type: 'text', text: 'raw-domain-item' }], extra: 42 };
        }
        if (name === 'oversized_error_tool') {
          throw Object.assign(new Error('internal size detail'), { code: 'RESPONSE_TOO_LARGE' });
        }
        return { ok: true };
      },
    },
    extraOptions: {
      maxResponseBytes: 1024,
    },
  });

  try {
    // 1. Bounded response
    const hugeRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'huge_tool', arguments: {} },
    });
    assert.equal(hugeRes.statusCode, 200);
    assert.ok(Buffer.byteLength(hugeRes.body, 'utf8') <= 1024);
    assert.match(hugeRes.json().result.content[0].text, /\[truncated\]/);

    // 2. Secret scrubbing in outputs
    const leakyRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'leaky_tool', arguments: {} },
    });
    assert.equal(leakyRes.statusCode, 200);
    assert.doesNotMatch(leakyRes.body, /secret-device-token-value/);
    assert.doesNotMatch(leakyRes.body, /pboauth_supersecret/);
    assert.doesNotMatch(leakyRes.body, /pbmcp_at_secretmcpaccess/);
    assert.doesNotMatch(leakyRes.body, /ya29\.abcdefghijklmnop/);
    assert.doesNotMatch(leakyRes.body, /scrypt\$/);

    // 3. Internal thrown error never exposed (even if expose/publicMessage are set)
    const failRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'failing_tool', arguments: {} },
    });
    assert.equal(failRes.statusCode, 200);
    const failResult = failRes.json().result;
    assert.equal(failResult.isError, true);
    assert.deepEqual(JSON.parse(failResult.content[0].text), {
      error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' },
    });
    assert.doesNotMatch(failRes.body, /SQLITE_CANTOPEN/);
    assert.doesNotMatch(failRes.body, /center\.db/);
    assert.doesNotMatch(failRes.body, /pboauth_secret/);
    assert.doesNotMatch(failRes.body, /leaked publicMessage/);

    // 4. Known safe codes expose code + generic message, never internal message
    const safeCodeRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'safe_code_fail_tool', arguments: {} },
    });
    assert.equal(safeCodeRes.statusCode, 200);
    const safeCodeResult = safeCodeRes.json().result;
    assert.equal(safeCodeResult.isError, true);
    assert.deepEqual(JSON.parse(safeCodeResult.content[0].text), {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    assert.doesNotMatch(safeCodeRes.body, /row id 42/);

    const oversizedErrRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'oversized_error_tool', arguments: {} },
    });
    assert.equal(oversizedErrRes.statusCode, 200);
    assert.deepEqual(JSON.parse(oversizedErrRes.json().result.content[0].text), {
      error: { code: 'RESPONSE_TOO_LARGE', message: 'Response exceeds size limit' },
    });

    // Domain object containing a `content` array is serialized intact (not treated as an MCP envelope)
    const domainContentRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'domain_content_tool', arguments: {} },
    });
    assert.equal(domainContentRes.statusCode, 200);
    assert.deepEqual(JSON.parse(domainContentRes.json().result.content[0].text), {
      content: [{ type: 'text', text: 'raw-domain-item' }],
      extra: 42,
    });

    // 5. Prototype pollution payloads are rejected/stripped before reaching operations.call
    const protoRejectRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"echo_args","arguments":{"safe":"ok","__proto__":{"polluted":true}}}}',
    });
    assert.equal(protoRejectRes.statusCode, 400);
    assert.equal(({}).polluted, undefined);

    const ctorStripRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 51,
      method: 'tools/call',
      params: {
        name: 'echo_args',
        arguments: { safe: 'ok', constructor: { x: 1 }, prototype: { y: 2 } },
      },
    });
    assert.equal(ctorStripRes.statusCode, 200);
    assert.deepEqual(JSON.parse(ctorStripRes.json().result.content[0].text), { keys: ['safe'] });

    // 6. Per-actor tool allowlist enforced at call time
    const countBefore = receivedArgs.length;
    const forbiddenToolRes = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'admin_only', arguments: {} } },
      { authorization: 'Bearer reader-token' },
    );
    assert.equal(forbiddenToolRes.statusCode, 200);
    assert.equal(forbiddenToolRes.json().result.isError, true);
    assert.equal(JSON.parse(forbiddenToolRes.json().result.content[0].text).error.code, 'TOOL_NOT_FOUND');
    assert.equal(receivedArgs.length, countBefore);

    // 7. Unsupported MCP protocol method (e.g. arbitrary file read) returns JSON-RPC Method Not Found
    const methodNotFoundRes = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'file:///etc/passwd' },
    });
    assert.equal(methodNotFoundRes.statusCode, 200);
    assert.equal(methodNotFoundRes.json().error.code, -32601);
  } finally {
    await app.close();
  }
});

test('operations.list internal failures do not leak error details or secrets', async () => {
  const { app } = await createMcpApp({
    operations: {
      list() {
        throw new Error('Failed reading /etc/pibot/secret.key with Bearer pboauth_leaked1234567890');
      },
      async call() {
        return {};
      },
    },
  });
  try {
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/list',
      params: {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().error.code, -32603);
    assert.doesNotMatch(res.body, /secret\.key/);
    assert.doesNotMatch(res.body, /pboauth_leaked/);
  } finally {
    await app.close();
  }
});

test('Rate limiting enforces per-window cap with 429 + Retry-After and resets after window elapses', async () => {
  let currentTime = 1_000_000;
  const { app, calls } = await createMcpApp({
    extraOptions: {
      rateLimit: { max: 2, windowMs: 30_000 },
      now: () => currentTime,
    },
  });
  try {
    const req1 = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'bots_list', arguments: {} },
    });
    assert.equal(req1.statusCode, 200);

    const req2 = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bots_list', arguments: {} },
    });
    assert.equal(req2.statusCode, 200);

    const req3 = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'bots_list', arguments: {} },
    });
    assert.equal(req3.statusCode, 429);
    assert.equal(req3.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(req3.headers['retry-after']) >= 1);
    assert.equal(calls.length, 2);

    // Advance past rate-limit window -> allowed again
    currentTime += 30_001;
    const req4 = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'bots_list', arguments: {} },
    });
    assert.equal(req4.statusCode, 200);
    assert.equal(calls.length, 3);
  } finally {
    await app.close();
  }
});

test('Official MCP SDK Client and StreamableHTTPClientTransport complete OAuth discovery and authorize via Fastify inject fetch for a subset-scoped client', async () => {
  const ownerPassword = 'owner-password-for-transport-oauth-smoke';
  const salt = randomBytes(16);
  const ownerPasswordHash = `scrypt$${salt.toString('hex')}$${scryptSync(ownerPassword, salt, 64).toString('hex')}`;
  const subsetClient = {
    clientId: 'sdk-transport-subset-client',
    clientSecret: 'super-secret-transport-subset-0001',
    redirectUris: ['http://127.0.0.1:43124/cb'],
    scopes: ['pibot:bots:read'],
  };
  const calls = [];
  const app = Fastify({ logger: false });
  await registerAuth(app, {
    sessionKey: randomBytes(32),
    ownerPasswordHash,
  });
  const mcpOAuth = registerMcpOAuth(app, {
    publicUrl: PUBLIC_URL,
    clients: [subsetClient],
    supportedScopes: ['pibot:bots:read', 'pibot:messages:write'],
    cleanupIntervalMs: 60 * 60 * 1000,
  });
  registerMcp(app, {
    publicUrl: PUBLIC_URL,
    authenticate: mcpOAuth.authenticate,
    operations: sampleOperations(calls),
  });
  await app.ready();

  const injectFetch = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    assert.equal(url.origin, PUBLIC_URL, `Unexpected remote fetch target: ${url.href}`);
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

  let clientInfo = {
    client_id: subsetClient.clientId,
    client_secret: subsetClient.clientSecret,
  };
  let savedTokens;
  let savedVerifier = '';
  let savedDiscovery;
  let capturedAuthUrl;
  const authProvider = {
    redirectUrl: subsetClient.redirectUris[0],
    clientMetadata: {
      client_name: 'sdk-transport-oauth-smoke',
      redirect_uris: [subsetClient.redirectUris[0]],
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => {
      clientInfo = info;
    },
    tokens: () => savedTokens,
    saveTokens: (next) => {
      savedTokens = next;
    },
    state: () => 'sdk-transport-state-001',
    codeVerifier: () => savedVerifier,
    saveCodeVerifier: (next) => {
      savedVerifier = next;
    },
    discoveryState: () => savedDiscovery,
    saveDiscoveryState: (next) => {
      savedDiscovery = next;
    },
    redirectToAuthorization: (url) => {
      capturedAuthUrl = url;
    },
  };

  try {
    // 1. Initial unauthenticated connect triggers 401 -> RFC 9728 / RFC 8414 discovery -> authorize redirect URL
    const transport1 = new StreamableHTTPClientTransport(new URL('/mcp', PUBLIC_URL), {
      authProvider,
      fetch: injectFetch,
    });
    const client1 = new Client({ name: 'pibot-sdk-oauth-smoke', version: '1.0.0' });
    await assert.rejects(() => client1.connect(transport1), UnauthorizedError);

    assert.ok(capturedAuthUrl instanceof URL);
    assert.equal(capturedAuthUrl.origin, PUBLIC_URL);
    assert.equal(capturedAuthUrl.pathname, MCP_OAUTH_PATHS.authorize);
    assert.equal(capturedAuthUrl.searchParams.get('client_id'), subsetClient.clientId);
    assert.equal(capturedAuthUrl.searchParams.get('resource'), `${PUBLIC_URL}/mcp`);
    assert.equal(capturedAuthUrl.searchParams.has('scope'), false);

    // 2. Owner signs in and approves the discovered authorization request without 302 invalid_scope
    const cookieOf = (res, previous = '') => {
      const raw = res.headers['set-cookie'];
      const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((value) => value.split(';')[0]);
      return cookies.length ? cookies.join('; ') : previous;
    };
    let sessionRes = await app.inject({ method: 'GET', url: '/api/session' });
    let ownerCookie = cookieOf(sessionRes);
    sessionRes = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie: ownerCookie, 'x-csrf-token': sessionRes.json().csrfToken },
      payload: { password: ownerPassword },
    });
    assert.equal(sessionRes.statusCode, 200);
    ownerCookie = cookieOf(sessionRes, ownerCookie);

    const consentRes = await app.inject({
      method: 'GET',
      url: `${capturedAuthUrl.pathname}${capturedAuthUrl.search}`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(consentRes.statusCode, 200);
    const consentId = /name="consent_id"\s+value="([^"]+)"/.exec(consentRes.body)?.[1];
    const csrfToken = /name="csrf_token"\s+value="([^"]+)"/.exec(consentRes.body)?.[1];
    assert.ok(consentId);
    assert.ok(csrfToken);

    const approveRes = await app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.authorize,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        consent_id: consentId,
        csrf_token: csrfToken,
        decision: 'approve',
      }).toString(),
    });
    assert.equal(approveRes.statusCode, 302);
    const callbackUrl = new URL(approveRes.headers.location);
    assert.equal(callbackUrl.searchParams.get('error'), null);
    assert.equal(callbackUrl.searchParams.get('state'), 'sdk-transport-state-001');
    const code = callbackUrl.searchParams.get('code');
    assert.ok(code);

    // 3. Exchange authorization code via SDK transport.finishAuth and connect authorized MCP client
    await transport1.finishAuth(code);
    assert.ok(savedTokens?.access_token);
    assert.equal(savedTokens.scope, 'pibot:bots:read');

    const transport2Errors = [];
    const transport2 = new StreamableHTTPClientTransport(new URL('/mcp', PUBLIC_URL), {
      authProvider,
      fetch: injectFetch,
    });
    transport2.onerror = (err) => {
      transport2Errors.push(err);
    };
    const client2 = new Client({ name: 'pibot-sdk-oauth-smoke', version: '1.0.0' });
    try {
      await client2.connect(transport2);
      const listed = await client2.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === 'bots_list'));

      const called = await client2.callTool({ name: 'bots_list', arguments: {} });
      assert.ok(!called.isError);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].actor.clientId, subsetClient.clientId);
      assert.deepEqual(calls[0].actor.scopes, ['pibot:bots:read']);

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(transport2Errors, []);
    } finally {
      await client2.close();
    }
  } finally {
    await app.close();
  }
});
