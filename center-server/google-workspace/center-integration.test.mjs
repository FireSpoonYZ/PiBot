import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import Fastify from 'fastify';
import { openCenterStore } from '../data/index.js';
import { openCenterExecution } from '../execution.js';
import { registerAuth, requireOwner } from '../auth.js';
import { createGoogleWorkspaceMcpAdapter } from './mcp-server.js';
import { createGoogleRuleDispatcher } from './rule-dispatch.js';
import { registerGoogleWorkspaceRoutes, GOOGLE_ERROR_STATUS } from './routes.js';
import { GOOGLE_WORKSPACE_INSTALLATION_ID } from './constants.js';
import { createMcpDriver } from '../../host-core/capabilities/mcp.js';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'pibot-google-center-test-'));
}

function makeOwnerPasswordHash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

test('Google Workspace MCP adapter executes real MCP tools/list and tools/call with account binding and secret scrubbing', async () => {
  const seenCalls = [];
  const fakeAccounts = {
    async status() {
      return {
        client: { configured: true, clientId: 'cid-1', redirectUri: 'https://center.example/api/oauth/google/callback' },
        accounts: [
          { id: 'acc-1', email: 'alice@example.com', status: 'connected', choices: ['gmail'], services: [] },
          { id: 'acc-2', email: 'bob@example.com', status: 'connected', choices: ['gmail'], services: [] },
        ],
      };
    },
    async api(account) {
      if (!account) {
        throw Object.assign(new Error('Multiple Google accounts connected; specify account'), {
          code: 'GOOGLE_ACCOUNT_AMBIGUOUS',
        });
      }
      if (account === 'secret-err@example.com') {
        throw Object.assign(new Error('Upstream failed with Bearer ya29.secret_token_1234567890 client_secret=GOCSPX-abcdef123456'), {
          code: 'GOOGLE_API_ERROR',
        });
      }
      return { email: account };
    },
  };

  const sampleTools = [
    {
      name: 'gmail_search',
      description: 'Search Gmail threads',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      async run(args, ctx) {
        seenCalls.push({ args, ctx });
        return { account: ctx.api.email, threads: [{ id: 't1', query: args.query }] };
      },
    },
    {
      name: 'drive_download',
      description: 'Download Drive file',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      async run(args, ctx) {
        return {
          account: ctx.api.email,
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'JVBERi0xLjQKUmF3UERGQnl0ZXM=',
        };
      },
    },
  ];

  const adapter = createGoogleWorkspaceMcpAdapter({ accounts: fakeAccounts, tools: sampleTools });
  try {
    const client = await adapter.getClient();
    const listed = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name), ['gmail_search', 'drive_download']);
    assert.equal(listed[0].inputSchema.properties.account.type, 'string');

    // Strips spoofed caller/actor args and passes trusted caller metadata.
    const okResult = await adapter.runWithCaller(
      { deviceId: 'dev-1', botId: 'bot-1', callId: 'call-1' },
      () => client.callTool('gmail_search', {
        query: 'from:sam',
        account: 'alice@example.com',
        askedBy: 'spoofed-user',
        deviceId: 'spoofed-dev',
        accessToken: 'spoofed-token',
      }),
    );
    assert.notEqual(okResult.isError, true);
    assert.equal(seenCalls.length, 1);
    assert.equal(seenCalls[0].args.askedBy, undefined);
    assert.equal(seenCalls[0].args.deviceId, undefined);
    assert.equal(seenCalls[0].args.accessToken, undefined);
    assert.equal(seenCalls[0].ctx.deviceId, 'dev-1');
    assert.equal(seenCalls[0].ctx.botId, 'bot-1');
    assert.equal(seenCalls[0].ctx.callId, 'call-1');
    assert.equal(seenCalls[0].ctx.api.email, 'alice@example.com');

    // Multi-account ambiguity returns safe account list without guessing.
    const ambiguous = await client.callTool('gmail_search', { query: 'inbox' });
    assert.equal(ambiguous.isError, true);
    const ambiguousBody = JSON.parse(ambiguous.content[0].text);
    assert.equal(ambiguousBody.error.code, 'GOOGLE_ACCOUNT_AMBIGUOUS');
    assert.deepEqual(
      ambiguousBody.error.accounts.map((a) => a.email),
      ['alice@example.com', 'bob@example.com'],
    );

    // Secrets are scrubbed from tool errors.
    const errResult = await client.callTool('gmail_search', { query: 'x', account: 'secret-err@example.com' });
    assert.equal(errResult.isError, true);
    assert.doesNotMatch(errResult.content[0].text, /ya29\.secret_token/);
    assert.doesNotMatch(errResult.content[0].text, /GOCSPX-abcdef/);

    // Binary base64 is omitted from content[0].text while preserved in structuredContent for Host transfer.
    const downloadResult = await client.callTool('drive_download', { ref: 'file-1', account: 'alice@example.com' });
    assert.notEqual(downloadResult.isError, true);
    assert.doesNotMatch(downloadResult.content[0].text, /JVBERi0xLjQK/);
    assert.equal(downloadResult.structuredContent.contentBase64, 'JVBERi0xLjQKUmF3UERGQnl0ZXM=');
  } finally {
    await adapter.close();
  }
});

test('Store snapshots expose shared Google Workspace MCP to existing and future Bots without per-Bot toggles or grants', async () => {
  const dir = makeTempDir();
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  try {
    store.replaceDeviceBots('dev-1', [{ deviceId: 'dev-1', botId: 'bot-a', name: 'Alpha', isPrimary: true }], { bumpRevision: true });
    const snap1 = store.getDeviceSnapshot('dev-1', 'wss://center.example/v1/link');
    const botACap = snap1.bots[0].capabilities.find((c) => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID);
    assert.ok(botACap);
    assert.equal(botACap.kind, 'mcp');
    assert.equal(botACap.target, 'center');
    assert.equal(botACap.enabled, true);
    assert.equal(botACap.authorized, true);
    assert.deepEqual(botACap.effectiveConfig, {});
    assert.deepEqual(botACap.credentialRefs, []);
    assert.deepEqual(snap1.credentials, {});

    // Idempotent snapshot revision when nothing changed.
    const snap1Again = store.getDeviceSnapshot('dev-1', 'wss://center.example/v1/link');
    assert.equal(snap1Again.revision, snap1.revision);

    // Future Bot automatically receives Google Workspace MCP without manual binding.
    store.upsertDeviceBot('dev-1', { deviceId: 'dev-1', botId: 'bot-b', name: 'Beta', isPrimary: false });
    const snap2 = store.getDeviceSnapshot('dev-1', 'wss://center.example/v1/link');
    const botB = snap2.bots.find((b) => b.botId === 'bot-b');
    assert.ok(botB.capabilities.some((c) => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID && c.enabled && c.authorized));

    // Not listed as a per-Bot toggleable installation and cannot be toggled via putBotCapability.
    assert.equal(store.listInstallations().some((i) => i.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID), false);
    assert.throws(
      () => store.putBotCapability('dev-1', 'bot-a', GOOGLE_WORKSPACE_INSTALLATION_ID, { enabled: false, overrides: {}, expectedRevision: 0 }),
      (err) => err?.code === 'FORBIDDEN',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openCenterExecution enforces device/Bot identity and tool allowlist on builtin Google adapter', async () => {
  const dir = makeTempDir();
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [{ deviceId: 'dev-1', botId: 'bot-1', name: 'One', isPrimary: true }], { bumpRevision: true });

  const adapter = createGoogleWorkspaceMcpAdapter({
    accounts: { async api() { return { email: 'owner@example.com' }; } },
    tools: [{
      name: 'calendar_list',
      description: 'List events',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, ctx) { return { botId: ctx.botId, events: [] }; },
    }],
  });
  const execution = openCenterExecution({
    store,
    packages: { async getInstalled() { return null; } },
    oauth: {},
    builtinAdapters: new Map([[GOOGLE_WORKSPACE_INSTALLATION_ID, adapter]]),
  });

  try {
    assert.equal(execution.hasBuiltin(GOOGLE_WORKSPACE_INSTALLATION_ID), true);
    const listed = await execution.listTools('dev-1', GOOGLE_WORKSPACE_INSTALLATION_ID, { botId: 'bot-1' });
    assert.deepEqual(listed.tools.map((t) => t.name), ['calendar_list']);

    await assert.rejects(
      () => execution.listTools('dev-1', GOOGLE_WORKSPACE_INSTALLATION_ID, { botId: 'unknown-bot' }),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => execution.callTool('dev-1', GOOGLE_WORKSPACE_INSTALLATION_ID, { botId: 'bot-1', name: 'not_a_tool', args: {}, callId: 'c1' }),
      (err) => err?.code === 'FORBIDDEN',
    );
    const res = await execution.callTool('dev-1', GOOGLE_WORKSPACE_INSTALLATION_ID, { botId: 'bot-1', name: 'calendar_list', args: {}, callId: 'c2' });
    assert.equal(res.structuredContent.botId, 'bot-1');
  } finally {
    await execution.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Google rule dispatcher enqueues idempotent internal events hidden from public webhooks', async () => {
  const dir = makeTempDir();
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [{ deviceId: 'dev-1', botId: 'bot-1', name: 'One', isPrimary: true }], { bumpRevision: true });
  const notified = [];
  const dispatcher = createGoogleRuleDispatcher({ store, notify: (deviceId) => notified.push(deviceId) });
  try {
    const first = await dispatcher.dispatch({
      deviceId: 'dev-1',
      botId: 'bot-1',
      ruleId: 'rule-1',
      eventKey: 'gmail:msg:123',
      source: 'gmail',
      account: 'alice@example.com',
      instruction: 'Summarize urgent invoice emails',
      payload: { messageId: '123', subject: 'Invoice' },
    });
    assert.equal(first.created, true);
    assert.deepEqual(notified, ['dev-1']);

    // Duplicate (ruleId, eventKey) is strictly idempotent and does not re-notify.
    const dup = await dispatcher.dispatch({
      deviceId: 'dev-1',
      botId: 'bot-1',
      ruleId: 'rule-1',
      eventKey: 'gmail:msg:123',
      source: 'gmail',
      account: 'alice@example.com',
      instruction: 'Summarize urgent invoice emails',
      payload: { messageId: '123', subject: 'Invoice' },
    });
    assert.equal(dup.created, false);
    assert.equal(dup.eventId, first.eventId);
    assert.deepEqual(notified, ['dev-1']);

    // Internal route is completely hidden from public webhook listing and auth.
    assert.deepEqual(store.listWebhookRoutes(), []);
    assert.throws(
      () => store.authenticateWebhookRoute('center-internal-google-rule:rule-1', 'x'.repeat(43)),
      (err) => err?.code === 'NOT_FOUND',
    );

    // Host polls and receives event cleanly.
    const polled = store.pollWebhookEvents('dev-1');
    assert.equal(polled.items.length, 1);
    assert.equal(polled.items[0].status, 'dispatching');
    assert.equal(polled.items[0].payload.triggerType, 'google-workspace-rule');
    const done = store.reportWebhookEvent('dev-1', polled.items[0].id, { status: 'succeeded', error: null });
    assert.equal(done.status, 'succeeded');

    // Enqueue another event and verify rule removal cancels pending events.
    await dispatcher.dispatch({
      deviceId: 'dev-1',
      botId: 'bot-1',
      ruleId: 'rule-1',
      eventKey: 'gmail:msg:456',
      source: 'gmail',
      instruction: 'Handle',
      payload: { messageId: '456' },
    });
    const cancelled = dispatcher.cancelRule('rule-1');
    assert.equal(cancelled.cancelled, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Google HTTP routes enforce owner/CSRF, no-store, ownerKey binding, and public callback without echoing secrets', async () => {
  const dir = makeTempDir();
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [{ deviceId: 'dev-1', botId: 'bot-1', name: 'One', isPrimary: true }], { bumpRevision: true });

  const manageCalls = [];
  const callbackQueries = [];
  const ruleCalls = [];
  const cancelledRules = [];
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const code = error.code === 'FST_CSRF_INVALID_TOKEN' || error.code === 'FST_CSRF_MISSING_SECRET'
      ? 'CSRF_INVALID'
      : (GOOGLE_ERROR_STATUS[error.code] ? error.code : (error.code || 'INTERNAL_ERROR'));
    const httpStatus = GOOGLE_ERROR_STATUS[code]
      ?? (code === 'CSRF_INVALID' ? 403 : code === 'UNAUTHENTICATED' ? 401 : code === 'BOT_NOT_FOUND' || code === 'NOT_FOUND' ? 404 : code === 'INVALID_ARGUMENT' ? 400 : 500);
    reply.code(httpStatus).send({ error: { code, message: error.message || code } });
  });

  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: makeOwnerPasswordHash('test-owner-pass') });
  const csrfUnlessOAuth = (req, reply, done) => (req.oauthDeviceId ? done() : app.csrfProtection(req, reply, done));
  const route = (method, url, handler, write = false, bodyLimit) =>
    app.route({ method, url, onRequest: write ? [requireOwner, csrfUnlessOAuth] : [requireOwner], handler, ...(bodyLimit !== undefined ? { bodyLimit } : {}) });

  registerGoogleWorkspaceRoutes(app, {
    route,
    store,
    bridge: { deviceId: 'center-self', registry: { get: (id) => (id === 'dev-1' ? { deviceId: 'dev-1', revokedAt: null } : null) } },
    publicUrl: 'https://center.example',
    google: {
      accounts: {
        async status() {
          return { client: { configured: false, redirectUri: 'https://center.example/api/oauth/google/callback' }, accounts: [] };
        },
        async manage(action, input, ownerKey) {
          manageCalls.push({ action, input, ownerKey });
          return { ok: true, action };
        },
        async callback(searchParams) {
          callbackQueries.push(Object.fromEntries(searchParams.entries()));
          return { ok: true, phase: 'connected', account: { id: 'acc-1', email: 'alice@example.com' } };
        },
      },
      rules: {
        async manage(action, input) {
          ruleCalls.push({ action, input });
          return action === 'list' ? { items: [] } : { id: input.id || 'rule-1', ok: true };
        },
      },
      ruleDispatch: {
        cancelRule(id) { cancelledRules.push(id); },
      },
    },
  });

  try {
    // Unauthenticated owner route rejected.
    const unauth = await app.inject({ method: 'GET', url: '/api/google/status' });
    assert.equal(unauth.statusCode, 401);

    // Login as owner.
    const sessionInit = await app.inject({ method: 'GET', url: '/api/session' });
    const initCookie = sessionInit.headers['set-cookie'];
    const initCsrf = sessionInit.json().csrfToken;
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie: Array.isArray(initCookie) ? initCookie[0] : initCookie, 'x-csrf-token': initCsrf },
      payload: { password: 'test-owner-pass' },
    });
    assert.equal(login.statusCode, 200);
    const ownerCookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']).split(';')[0];
    const ownerCsrf = login.json().csrfToken;

    // Owner read succeeds with no-store.
    const statusRes = await app.inject({ method: 'GET', url: '/api/google/status', headers: { cookie: ownerCookie } });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.headers['cache-control'], 'no-store');

    // Mutation without CSRF fails.
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/google/authorize',
      headers: { cookie: ownerCookie },
      payload: { choices: ['gmail'] },
    });
    assert.equal(noCsrf.statusCode, 403);

    // Mutation with CSRF succeeds and binds stable session ownerKey.
    const authz = await app.inject({
      method: 'POST',
      url: '/api/google/authorize',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { choices: ['gmail'] },
    });
    assert.equal(authz.statusCode, 200);
    const flow = await app.inject({
      method: 'POST',
      url: '/api/google/flow',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { flowId: 'f1' },
    });
    assert.equal(flow.statusCode, 200);
    assert.equal(manageCalls.length, 2);
    assert.ok(manageCalls[0].ownerKey.startsWith('session:'));
    assert.equal(manageCalls[0].ownerKey, manageCalls[1].ownerKey);

    // Public callback does not require owner session or CSRF and never echoes code/state.
    const cb = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/callback?state=st-secret-1&code=code-secret-2',
      headers: { accept: 'text/html' },
    });
    assert.equal(cb.statusCode, 200);
    assert.equal(cb.headers['cache-control'], 'no-store');
    assert.equal(cb.headers['referrer-policy'], 'no-referrer');
    assert.doesNotMatch(cb.body, /st-secret-1/);
    assert.doesNotMatch(cb.body, /code-secret-2/);
    assert.match(cb.body, /alice@example\.com/);
    assert.deepEqual(callbackQueries[0], { state: 'st-secret-1', code: 'code-secret-2' });

    // Rules save rejects nonexistent Bot; remove triggers ruleDispatch.cancelRule.
    const badRule = await app.inject({
      method: 'POST',
      url: '/api/google/rules/save',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { deviceId: 'dev-1', botId: 'missing-bot', account: 'alice@example.com', source: 'gmail', enabled: true, instruction: 'x' },
    });
    assert.equal(badRule.statusCode, 404);

    const removeRule = await app.inject({
      method: 'POST',
      url: '/api/google/rules/remove',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { id: 'rule-99' },
    });
    assert.equal(removeRule.statusCode, 200);
    assert.deepEqual(cancelledRules, ['rule-99']);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host MCP driver invokes prepareGoogleFileCall and finishGoogleFileCall with Bot cwd and never echoes base64', async () => {
  const preparedCalls = [];
  const finishedCalls = [];
  const centerCalls = [];
  const driver = await createMcpDriver({
    installationId: GOOGLE_WORKSPACE_INSTALLATION_ID,
    version: '1.0.0',
    target: 'center',
    packageRoot: null,
    host: {
      host: { getBot: (botId) => ({ botId, cwd: '/workspace/bot-1' }) },
      assertCapabilityAllowed() {},
      async resolveConversationBot() { return 'bot-1'; },
      centerClient: {
        async listCapabilityTools() {
          return {
            tools: [{
              name: 'drive_download',
              description: 'Download Drive file',
              inputSchema: { type: 'object', properties: { ref: { type: 'string' }, out: { type: 'string' } } },
            }],
          };
        },
        async callCapabilityTool(id, botId, name, args, callId) {
          centerCalls.push({ id, botId, name, args, callId });
          return {
            content: [{ type: 'text', text: '{"filename":"a.pdf"}' }],
            structuredContent: { filename: 'a.pdf', contentBase64: 'c2VjcmV0LWJ5dGVz' },
          };
        },
      },
    },
    googleFileTransfer: {
      async prepareGoogleFileCall(name, args, opts) {
        preparedCalls.push({ name, args, opts });
        return { ...args, prepared: true };
      },
      async finishGoogleFileCall(name, result, opts) {
        finishedCalls.push({ name, result, opts });
        return { savedPath: '/workspace/bot-1/a.pdf', filename: result.filename };
      },
    },
  });

  const bot = await driver.forBot({ botId: 'bot-1', effectiveConfig: {}, credentials: {} });
  await bot.prepare();
  await bot.activate();
  try {
    const tool = bot.durableContributions.tools[0];
    const res = await tool.execute(
      { ref: 'file-1', out: 'a.pdf' },
      { conversationId: 'conv-1', callId: 'call-9' },
      {},
    );
    assert.equal(res.isError, false);
    assert.equal(preparedCalls.length, 1);
    assert.equal(preparedCalls[0].opts.cwd, '/workspace/bot-1');
    assert.equal(centerCalls[0].args.prepared, true);
    assert.equal(finishedCalls.length, 1);
    assert.equal(finishedCalls[0].result.contentBase64, 'c2VjcmV0LWJ5dGVz');
    assert.match(res.output[0].text, /savedPath/);
    assert.doesNotMatch(res.output[0].text, /c2VjcmV0LWJ5dGVz/);
  } finally {
    await bot.close();
    await driver.close();
  }
});
