import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centerServerOptions, hashOwnerPassword, resolveCenterPlan } from '../../center-server/config.js';
import {
  assertRemoteMcpOptions,
  isRemoteMcpPath,
  openCenterServer,
  registerCenterSpaFallback,
  registerRemoteMcpIfEnabled,
} from '../../center-server/server.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerClientReleaseRoutes } from '../../center-server/client-releases.js';
import { registerRoutes } from '../../center-server/routes.js';
import { openOperations } from '../../center-server/operations/index.js';
import { MCP_OAUTH_PATHS } from '../../center-server/mcp/oauth.js';

const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const PUBLIC_URL = 'https://center.example.test';
const OWNER_HASH = hashOwnerPassword('owner-password-for-opt-in-test');
const ENCRYPTION_HEX = '11'.repeat(32);
const SESSION_HEX = '22'.repeat(32);

function makeValidClient() {
  return {
    clientId: 'opt-in-client',
    clientSecret: randomBytes(32).toString('base64url'),
    redirectUris: ['https://mcp-client.example.test/oauth/callback'],
    scopes: ['pibot:center:read'],
  };
}

function baseEnv(dataRoot, extra = {}) {
  return {
    CENTER_DATA_ROOT: dataRoot,
    CENTER_LISTEN_HOST: '127.0.0.1',
    CENTER_PORT: '0',
    CENTER_PUBLIC_URL: PUBLIC_URL,
    CENTER_ENCRYPTION_KEY_HEX: ENCRYPTION_HEX,
    CENTER_SESSION_KEY_HEX: SESSION_HEX,
    CENTER_OWNER_PASSWORD_HASH: OWNER_HASH,
    ...extra,
  };
}

function writeJson(dir, name, value) {
  const filePath = join(dir, name);
  writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return filePath;
}

async function createAppHarness({ mcpEnabled, mcpClients, enableSpa = true }) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pibot-mcp-opt-in-app-'));
  const webRoot = enableSpa ? mkdtempSync(join(tmpdir(), 'pibot-mcp-opt-in-web-')) : undefined;
  if (webRoot) {
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><div id="app">center-spa</div>', 'utf8');
  }
  const store = openCenterStore({ dataRoot, encryptionKey: randomBytes(32) });
  const bridge = openHostBridge({ dataRoot, store, relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify({ logger: false });
  let completedOAuth = null;
  let routes;
  let mcpOAuth = null;
  try {
    app.setErrorHandler((err, _req, reply) => reply.code(
      ({ FORBIDDEN: 403, INVALID_ARGUMENT: 400, NOT_FOUND: 404 })[err.code] ?? 500,
    ).send({ error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message || 'Internal error' } }));
    await registerAuth(app, { ownerPasswordHash: OWNER_HASH, sessionKey: randomBytes(32) });
    const { listReleases } = registerClientReleaseRoutes(app, {
      store,
      dataRoot,
      registry: bridge.registry,
      internalDeviceId: bridge.deviceId,
      publicUrl: PUBLIC_URL,
    });
    routes = registerRoutes(app, {
      store,
      bridge,
      packages: {},
      execution: {},
      oauth: {
        complete: async (input) => { completedOAuth = input; },
      },
      linkUrl: 'wss://center.example.test/v1/link',
      turns: {},
      catalog: { status: () => ({ source: 'test' }) },
      publicUrl: PUBLIC_URL,
      listReleases,
      createOperations: openOperations,
    });
    if (mcpEnabled !== undefined) {
      mcpOAuth = await registerRemoteMcpIfEnabled(app, {
        mcpEnabled,
        mcpClients,
        publicOrigin: PUBLIC_URL,
        operations: routes.operations,
      });
    }
    if (webRoot) {
      await registerCenterSpaFallback(app, webRoot);
    }
    await app.ready();
    return {
      app,
      store,
      bridge,
      routes,
      mcpOAuth,
      getCompletedOAuth: () => completedOAuth,
      async close() {
        routes?.close();
        mcpOAuth?.close?.();
        await app.close();
        bridge.close();
        store.close();
        rmSync(dataRoot, { recursive: true, force: true });
        if (webRoot) rmSync(webRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    routes?.close();
    mcpOAuth?.close?.();
    await app.close();
    bridge.close();
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
    if (webRoot) rmSync(webRoot, { recursive: true, force: true });
    throw error;
  }
}

test('CENTER_MCP_ENABLED defaults to off and does not read CENTER_MCP_CLIENTS_FILE when disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-mcp-opt-in-off-'));
  try {
    const validFile = writeJson(dir, 'clients.json', [makeValidClient()]);
    const corruptFile = writeJson(dir, 'corrupt.json', '{not-json');
    const missingFile = join(dir, 'does-not-exist.json');

    for (const extra of [
      { CENTER_MCP_CLIENTS_FILE: validFile },
      { CENTER_MCP_ENABLED: '', CENTER_MCP_CLIENTS_FILE: validFile },
      { CENTER_MCP_ENABLED: 'false', CENTER_MCP_CLIENTS_FILE: validFile },
      { CENTER_MCP_CLIENTS_FILE: missingFile },
      { CENTER_MCP_ENABLED: 'false', CENTER_MCP_CLIENTS_FILE: corruptFile },
      { CENTER_MCP_ENABLED: 'false', CENTER_MCP_CLIENTS_FILE: 'relative/clients.json' },
    ]) {
      const plan = resolveCenterPlan(baseEnv(dir, extra));
      assert.equal(plan.mcpEnabled, false);
      assert.deepEqual(plan.mcpClients, []);
      const options = centerServerOptions(plan, plan.config);
      assert.equal(options.mcpEnabled, false);
      assert.deepEqual(options.mcpClients, []);
    }

    const planWithSuppliedClients = {
      ...resolveCenterPlan(baseEnv(dir)),
      mcpEnabled: false,
      mcpClients: [makeValidClient()],
    };
    const options = centerServerOptions(planWithSuppliedClients, planWithSuppliedClients.config);
    assert.equal(options.mcpEnabled, false);
    assert.deepEqual(options.mcpClients, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid CENTER_MCP_ENABLED values fail closed without reading client secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-mcp-opt-in-invalid-'));
  try {
    const validFile = writeJson(dir, 'clients.json', [makeValidClient()]);
    const missingFile = join(dir, 'missing-clients.json');

    for (const invalidSwitch of ['1', '0', 'yes', 'no', 'TRUE', 'False', 'on', 'off', 'true ', ' true', 'invalid']) {
      assert.throws(
        () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: invalidSwitch, CENTER_MCP_CLIENTS_FILE: validFile })),
        /CENTER_MCP_ENABLED/,
        `expected invalid switch ${JSON.stringify(invalidSwitch)} to fail closed`,
      );
      assert.throws(
        () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: invalidSwitch, CENTER_MCP_CLIENTS_FILE: missingFile })),
        /CENTER_MCP_ENABLED/,
        `expected invalid switch ${JSON.stringify(invalidSwitch)} to fail before reading clients file`,
      );
    }

    const validPlan = resolveCenterPlan(baseEnv(dir));
    for (const nonBoolean of ['true', 1, 'yes', null]) {
      assert.throws(
        () => centerServerOptions({ ...validPlan, mcpEnabled: nonBoolean }, validPlan.config),
        /mcpEnabled must be a boolean/,
      );
      assert.throws(
        () => assertRemoteMcpOptions({ mcpEnabled: nonBoolean, mcpClients: [makeValidClient()] }),
        /mcpEnabled must be a boolean/,
      );
      await assert.rejects(
        () => openCenterServer({
          dataRoot: dir,
          encryptionKey: randomBytes(32),
          sessionKey: randomBytes(32),
          ownerPasswordHash: OWNER_HASH,
          publicUrl: PUBLIC_URL,
          mcpEnabled: nonBoolean,
          mcpClients: [makeValidClient()],
        }),
        /mcpEnabled must be a boolean/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit CENTER_MCP_ENABLED=true still requires a valid non-empty client config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-mcp-opt-in-on-'));
  try {
    const emptyArrayFile = writeJson(dir, 'empty.json', []);
    const objectFile = writeJson(dir, 'object.json', {});
    const corruptFile = writeJson(dir, 'corrupt.json', '{bad');
    const badSecretFile = writeJson(dir, 'bad-secret.json', [{ ...makeValidClient(), clientSecret: 'short' }]);
    const unsupportedScopeFile = writeJson(dir, 'unsupported-scope.json', [{
      ...makeValidClient(),
      scopes: ['pibot:nonexistent:read'],
    }]);
    const validClient = makeValidClient();
    const validFile = writeJson(dir, 'valid.json', [validClient]);

    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true' })),
      /CENTER_MCP_CLIENTS_FILE is required/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: 'relative/clients.json' })),
      /absolute path/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: join(dir, 'absent.json') })),
      /readable JSON file/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: corruptFile })),
      /readable JSON file/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: objectFile })),
      /client array/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: emptyArrayFile })),
      /at least one OAuth client/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: badSecretFile })),
      /clientSecret/,
    );
    assert.throws(
      () => resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: unsupportedScopeFile })),
      /supported scope/,
    );

    await assert.rejects(
      () => openCenterServer({
        dataRoot: dir,
        encryptionKey: randomBytes(32),
        sessionKey: randomBytes(32),
        ownerPasswordHash: OWNER_HASH,
        publicUrl: PUBLIC_URL,
        mcpEnabled: true,
        mcpClients: [],
      }),
      /at least one valid MCP OAuth client/,
    );
    await assert.rejects(
      () => openCenterServer({
        dataRoot: dir,
        encryptionKey: randomBytes(32),
        sessionKey: randomBytes(32),
        ownerPasswordHash: OWNER_HASH,
        publicUrl: PUBLIC_URL,
        mcpEnabled: true,
        mcpClients: [{ ...validClient, clientSecret: 'short' }],
      }),
      /clientSecret/,
    );

    const plan = resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: validFile }));
    assert.equal(plan.mcpEnabled, true);
    assert.equal(plan.mcpClients.length, 1);
    assert.equal(plan.mcpClients[0].clientId, validClient.clientId);
    const options = centerServerOptions(plan, plan.config);
    assert.equal(options.mcpEnabled, true);
    assert.equal(options.mcpClients.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled remote MCP returns true 404 (not SPA HTML) while preserving SPA pages, Bot tools, and upstream OAuth', async () => {
  const harness = await createAppHarness({
    mcpEnabled: false,
    mcpClients: [makeValidClient()],
    enableSpa: true,
  });
  try {
    assert.equal(harness.mcpOAuth, null);

    const blockedRequests = [
      { method: 'GET', url: '/mcp' },
      { method: 'POST', url: '/mcp', payload: {} },
      { method: 'GET', url: '/mcp/' },
      { method: 'GET', url: '/mcp/sub?x=1' },
      { method: 'GET', url: '//mcp' },
      { method: 'GET', url: '/oauth/mcp' },
      { method: 'GET', url: `${MCP_OAUTH_PATHS.authorize}?response_type=code&client_id=opt-in-client` },
      { method: 'POST', url: MCP_OAUTH_PATHS.authorize },
      { method: 'GET', url: MCP_OAUTH_PATHS.token },
      { method: 'POST', url: MCP_OAUTH_PATHS.token },
      { method: 'GET', url: MCP_OAUTH_PATHS.revoke },
      { method: 'POST', url: MCP_OAUTH_PATHS.revoke },
      { method: 'GET', url: MCP_OAUTH_PATHS.protectedResourceMetadataRoot },
      { method: 'GET', url: MCP_OAUTH_PATHS.protectedResourceMetadata },
      { method: 'GET', url: MCP_OAUTH_PATHS.authorizationServerMetadata },
    ];
    for (const req of blockedRequests) {
      const res = await harness.app.inject(req);
      assert.equal(res.statusCode, 404, `${req.method} ${req.url} should be 404, got ${res.statusCode}: ${res.body}`);
      assert.equal(res.json().error.code, 'NOT_FOUND', `${req.method} ${req.url} should return JSON NOT_FOUND`);
      assert.ok(!res.body.includes('center-spa'), `${req.method} ${req.url} must not return SPA HTML`);
    }

    for (const spaPath of ['/', '/devices', '/capabilities', '/mcp-help', '/oauth-help', '/oauth/other']) {
      assert.equal(isRemoteMcpPath(spaPath), false, `${spaPath} should not be treated as remote MCP path`);
      const res = await harness.app.inject({ method: 'GET', url: spaPath });
      assert.equal(res.statusCode, 200, `GET ${spaPath} should still serve SPA`);
      assert.ok(res.body.includes('center-spa'), `GET ${spaPath} should return SPA HTML`);
    }

    // Built-in Bot operation call remains available when remote MCP is off.
    const deviceId = 'host-opt-in';
    const botId = 'bot-opt-in';
    const deviceToken = randomBytes(32).toString('base64url');
    harness.bridge.registry.register({ deviceId, token: deviceToken, displayName: 'Opt-in Host' });
    harness.store.replaceDeviceBots(deviceId, [{ deviceId, botId, name: 'Opt-in Bot' }]);
    const botOp = await harness.app.inject({
      method: 'POST',
      url: '/api/host/operations/call',
      headers: { authorization: `Bearer ${deviceToken}`, 'x-device-id': deviceId },
      payload: { botId, name: 'center_get_model_config', args: {} },
    });
    assert.equal(botOp.statusCode, 200, botOp.body);

    // Existing upstream MCP OAuth callback remains available when remote MCP is off.
    const upstreamCallback = await harness.app.inject({
      method: 'GET',
      url: '/api/oauth/mcp/callback?state=upstream-state&code=upstream-code',
    });
    assert.equal(upstreamCallback.statusCode, 200, upstreamCallback.body);
    assert.equal(harness.getCompletedOAuth()?.state, 'upstream-state');
    assert.equal(harness.getCompletedOAuth()?.code, 'upstream-code');
  } finally {
    await harness.close();
  }
});

test('enabled remote MCP refuses empty clients without exposing routes, and exposes routes with valid clients', async () => {
  const emptyHarness = await createAppHarness({ mcpEnabled: undefined, enableSpa: true });
  try {
    await assert.rejects(
      () => registerRemoteMcpIfEnabled(emptyHarness.app, {
        mcpEnabled: true,
        mcpClients: [],
        publicOrigin: PUBLIC_URL,
        operations: emptyHarness.routes.operations,
      }),
      /at least one valid MCP OAuth client/,
    );
    for (const url of ['/mcp', MCP_OAUTH_PATHS.authorize, MCP_OAUTH_PATHS.protectedResourceMetadata, MCP_OAUTH_PATHS.authorizationServerMetadata]) {
      const res = await emptyHarness.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `GET ${url} must remain 404 when empty client config fails`);
    }
  } finally {
    await emptyHarness.close();
  }

  const dir = mkdtempSync(join(tmpdir(), 'pibot-mcp-opt-in-live-'));
  let liveHarness;
  try {
    const validFile = writeJson(dir, 'clients.json', [makeValidClient()]);
    const plan = resolveCenterPlan(baseEnv(dir, { CENTER_MCP_ENABLED: 'true', CENTER_MCP_CLIENTS_FILE: validFile }));
    const opts = centerServerOptions(plan, plan.config);
    liveHarness = await createAppHarness({
      mcpEnabled: opts.mcpEnabled,
      mcpClients: opts.mcpClients,
      enableSpa: true,
    });
    assert.ok(liveHarness.mcpOAuth);

    const prm = await liveHarness.app.inject({ method: 'GET', url: MCP_OAUTH_PATHS.protectedResourceMetadata });
    assert.equal(prm.statusCode, 200, prm.body);
    assert.equal(prm.json().resource, `${PUBLIC_URL}/mcp`);

    const asMeta = await liveHarness.app.inject({ method: 'GET', url: MCP_OAUTH_PATHS.authorizationServerMetadata });
    assert.equal(asMeta.statusCode, 200, asMeta.body);
    assert.equal(asMeta.json().issuer, PUBLIC_URL);

    const authorize = await liveHarness.app.inject({ method: 'GET', url: MCP_OAUTH_PATHS.authorize });
    assert.equal(authorize.statusCode, 400, authorize.body);

    const token = await liveHarness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.token,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    assert.equal(token.statusCode, 401, token.body);
    assert.equal(token.json().error, 'invalid_client');

    const revoke = await liveHarness.app.inject({
      method: 'POST',
      url: MCP_OAUTH_PATHS.revoke,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    assert.equal(revoke.statusCode, 401, revoke.body);
    assert.equal(revoke.json().error, 'invalid_client');

    const mcp = await liveHarness.app.inject({ method: 'POST', url: '/mcp', payload: {} });
    assert.equal(mcp.statusCode, 401, mcp.body);
    assert.match(String(mcp.headers['www-authenticate'] || ''), /resource_metadata=/);
  } finally {
    await liveHarness?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
