import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operations, SAFE_CAPABILITY_ACTIONS } from '../../center-contract/operations/capabilities.js';
import { createHandlers } from '../../center-server/operations/capabilities.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { GOOGLE_WORKSPACE_INSTALLATION_ID } from '../../center-contract/google-workspace.js';

const HINDSIGHT_SCHEMA = JSON.parse(
  fs.readFileSync(new URL('../../plugins/hindsight/config.schema.json', import.meta.url), 'utf8'),
);
const WEBFOX_SCHEMA = JSON.parse(
  fs.readFileSync(new URL('../../plugins/webfox/config.schema.json', import.meta.url), 'utf8'),
);
const MCP_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    url: { type: 'string' },
    command: { type: 'string' },
    bin: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    timeoutMs: { type: 'number' },
    transport: { type: 'string', enum: ['stdio', 'http'] },
    oauth: { type: 'boolean', default: false },
    apiKeyRef: { type: 'string', format: 'credential-ref' },
    envRefs: { type: 'object', additionalProperties: { type: 'string', format: 'credential-ref' } },
    headerRefs: { type: 'object', additionalProperties: { type: 'string', format: 'credential-ref' } },
  },
  additionalProperties: false,
};

const ALLOWED_OWNER_ROUTES = new Set([
  'GET /api/capabilities',
  'GET /api/installations/:id',
  'PATCH /api/installations/:id',
  'DELETE /api/installations/:id',
  'GET /api/installations/:id/skill-files',
  'PUT /api/installations/:id/skill-files',
  'GET /api/installations/:id/config',
  'PUT /api/installations/:id/config',
  'GET /api/installations/:id/bot-bindings',
  'GET /api/installations/:id/actions',
  'POST /api/installations/:id/tools/list',
  'POST /api/installations/:id/validate',
  'POST /api/installations/:id/updates/check',
  'POST /api/installations/:id/enable',
  'POST /api/installations/:id/disable',
  'POST /api/installations/:id/update',
  'GET /api/installations/:id/deployments',
  'GET /api/operations/:id',
  'GET /api/devices/:deviceId/bots/:botId/capabilities',
  'GET /api/devices/:deviceId/bots/:botId/capabilities/:id',
  'PUT /api/devices/:deviceId/bots/:botId/capabilities/:id',
  'POST /api/devices/:deviceId/bots/:botId/skills',
  'POST /api/devices/:deviceId/bots/:botId/skill-reviews',
  'POST /api/devices/:deviceId/bots/:botId/learning',
  'POST /api/devices/:deviceId/bots/:botId/installations',
]);

const BOT_A = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-a' };
const BOT_B = { kind: 'bot', deviceId: 'dev-2', botId: 'bot-b' };
const OAUTH_ADMIN = { kind: 'oauth', clientId: 'oauth-client-1' };

function openFixture() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-cap-ops-test-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(9) });
  store.upsertDeviceBot('dev-1', { botId: 'bot-a', name: 'Alpha', primary: true });
  store.upsertDeviceBot('dev-2', { botId: 'bot-b', name: 'Beta', primary: true });

  // Seed real encrypted credentials.
  store.putCredential('cred-hindsight', { expectedRevision: null, value: 'hs-secret-value-123' });
  store.putCredential('cred-tavily', { expectedRevision: null, value: 'tv-secret-value-456' });
  store.putCredential('cred-mcp-api', { expectedRevision: null, value: 'mcp-secret-value-789' });

  // Package versions.
  store.putPackageVersion({
    packageId: 'e-launcher.hindsight',
    version: '1.0.0',
    kind: 'plugin',
    digest: 'sha256:hindsight',
    artifactRef: null,
    manifest: {
      id: 'e-launcher.hindsight',
      actions: [
        { id: 'probe', title: 'Probe', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'retainMemory', title: 'Retain', inputSchema: { type: 'object' } },
      ],
    },
    configSchema: HINDSIGHT_SCHEMA,
  });
  store.putPackageVersion({
    packageId: 'e-launcher.webfox',
    version: '1.0.0',
    kind: 'plugin',
    digest: 'sha256:webfox',
    artifactRef: null,
    manifest: {
      id: 'e-launcher.webfox',
      actions: [
        { id: 'probe', title: 'Probe', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'readLearningSource', title: 'Internal', inputSchema: { type: 'object' } },
      ],
    },
    configSchema: WEBFOX_SCHEMA,
  });
  store.putPackageVersion({
    packageId: '@example/demo-mcp',
    version: '1.2.0',
    kind: 'mcp',
    digest: 'sha256:mcp',
    artifactRef: null,
    manifest: {
      actions: [
        { id: 'validate', title: 'Validate', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'listTools', title: 'List tools', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ],
    },
    configSchema: MCP_SCHEMA,
  });
  store.putPackageVersion({
    packageId: 'center-skill-private-a',
    version: '0.0.0-h111111111111',
    kind: 'skill',
    digest: 'sha256:skill-a',
    artifactRef: null,
    manifest: { actions: [] },
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
  });

  // Installations.
  store.putInstallation({
    installationId: 'inst-hindsight',
    packageId: 'e-launcher.hindsight',
    displayName: 'Hindsight Memory',
    kind: 'plugin',
    source: { type: 'artifact', artifactRef: 'art-hindsight' },
    target: 'host',
    targetVersion: '1.0.0',
    enabled: true,
    activation: { status: 'enabled', error: null, updatedAt: '2026-11-20T00:00:00.000Z' },
    revision: 0,
  }, null);
  store.putInstallationConfig('inst-hindsight', {
    expectedRevision: 0,
    globalConfig: {
      baseUrl: 'http://internal-hindsight:8888',
      apiKeyRef: 'cred-hindsight',
      projectId: 'proj-alpha',
      mode: 'read-write',
      timeoutMs: 15000,
    },
  });

  store.putInstallation({
    installationId: 'inst-webfox',
    packageId: 'e-launcher.webfox',
    displayName: 'Webfox Search',
    kind: 'plugin',
    source: { type: 'artifact', artifactRef: 'art-webfox' },
    target: 'host',
    targetVersion: '1.0.0',
    enabled: true,
    activation: { status: 'enabling', error: null, updatedAt: '2026-11-20T00:00:00.000Z' },
    revision: 0,
  }, null);
  store.putInstallationConfig('inst-webfox', {
    expectedRevision: 0,
    globalConfig: {
      capabilities: { search: { provider: 'tavily', maxResults: 5 } },
      providers: { tavily: { baseUrl: 'https://secret-tavily-proxy.internal', options: { search: { apiTag: 'secret' } } } },
      credentials: { tavily: 'cred-tavily' },
      timeoutMs: 30000,
      retries: 1,
    },
  });

  store.putInstallation({
    installationId: 'inst-mcp-npm',
    packageId: '@example/demo-mcp',
    displayName: 'Demo NPM MCP',
    kind: 'mcp',
    source: { type: 'npm', spec: '@example/demo-mcp@1.2.0' },
    target: 'center',
    targetVersion: '1.2.0',
    enabled: true,
    activation: { status: 'enabled', error: null, updatedAt: '2026-11-20T00:00:00.000Z' },
    revision: 0,
  }, null);
  store.putInstallationConfig('inst-mcp-npm', {
    expectedRevision: 0,
    globalConfig: {
      url: 'https://mcp.internal.example/sse?token=secret-query',
      command: '/usr/local/bin/demo-mcp',
      args: ['--secret-flag'],
      env: { SECRET_ENV: 'super-secret-env-val' },
      headers: { Authorization: 'Bearer super-secret-header' },
      apiKeyRef: 'cred-mcp-api',
      envRefs: { UPSTREAM_KEY: 'cred-mcp-api' },
      timeoutMs: 10000,
    },
  });

  store.putInstallation({
    installationId: 'inst-skill-a',
    packageId: 'center-skill-private-a',
    displayName: 'Alpha Private Skill',
    kind: 'skill',
    source: { type: 'artifact', artifactRef: 'art-skill-a' },
    target: 'host',
    targetVersion: '0.0.0-h111111111111',
    enabled: true,
    activation: { status: 'enabled', error: null, updatedAt: '2026-11-20T00:00:00.000Z' },
    revision: 0,
    ownerBot: {
      deviceId: 'dev-1',
      botId: 'bot-a',
      skillId: 'skill-a-1',
      skillName: 'alpha-skill',
    },
    visibilityScope: 'private',
  }, null);

  const calls = [];
  const customResponses = new Map();
  const execution = {
    hasBuiltin: (id) => id === GOOGLE_WORKSPACE_INSTALLATION_ID,
  };

  async function owner(method, routePattern, { params = {}, body, query = {} } = {}) {
    const key = `${method} ${routePattern}`;
    assert.ok(ALLOWED_OWNER_ROUTES.has(key), `Unexpected owner route: ${key}`);
    calls.push({ method, routePattern, params, body, query });

    if (customResponses.has(key)) {
      return customResponses.get(key)({ params, body, query });
    }

    if (key === 'GET /api/capabilities') return store.listInstallations();
    if (key === 'GET /api/installations/:id') {
      const inst = store.getInstallation(params.id);
      if (!inst) throw Object.assign(new Error('Installation not found'), { code: 'NOT_FOUND' });
      return inst;
    }
    if (key === 'PATCH /api/installations/:id') return store.renameInstallation(params.id, body);
    if (key === 'GET /api/installations/:id/config') return store.getInstallationConfig(params.id);
    if (key === 'PUT /api/installations/:id/config') return store.putInstallationConfig(params.id, body);
    if (key === 'GET /api/installations/:id/bot-bindings') {
      const bindings = {};
      for (const deviceId of ['dev-1', 'dev-2']) {
        for (const bot of store.listDeviceBots(deviceId)) {
          bindings[`${deviceId}:${bot.botId}`] = store.getBotCapability(deviceId, bot.botId, params.id);
        }
      }
      return { bindings };
    }
    if (key === 'GET /api/installations/:id/actions') {
      const inst = store.getInstallation(params.id);
      const pkg = store.getPackageVersion(inst.packageId, inst.targetVersion);
      return pkg?.manifest?.actions ?? [];
    }
    if (key === 'GET /api/installations/:id/deployments') return store.listDeploymentReceipts(params.id);
    if (key === 'GET /api/operations/:id') {
      const op = store.getOperation(params.id);
      if (!op) throw Object.assign(new Error('Operation not found'), { code: 'NOT_FOUND' });
      return op;
    }
    if (key === 'GET /api/devices/:deviceId/bots/:botId/capabilities') {
      return store.listBotCapabilities(params.deviceId, params.botId);
    }
    if (key === 'GET /api/devices/:deviceId/bots/:botId/capabilities/:id') {
      return store.getBotCapability(params.deviceId, params.botId, params.id);
    }
    if (key === 'PUT /api/devices/:deviceId/bots/:botId/capabilities/:id') {
      return store.putBotCapability(params.deviceId, params.botId, params.id, body);
    }
    if (key === 'POST /api/installations/:id/enable'
      || key === 'POST /api/installations/:id/disable'
      || key === 'POST /api/installations/:id/update'
      || key === 'DELETE /api/installations/:id') {
      const action = key.startsWith('DELETE') ? 'uninstall' : routePattern.split('/').pop();
      const opId = `op-${action}-${body.requestId}`;
      store.putOperation({
        operationId: opId,
        requestId: body.requestId,
        action,
        installationId: params.id,
        target: store.getInstallation(params.id)?.target ?? 'host',
        deviceIds: ['dev-1'],
        phase: 'queued',
        error: null,
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      }, `fp:${opId}`);
      return { operationId: opId };
    }

    throw new Error(`Unhandled fixture route: ${key}`);
  }

  const handlers = createHandlers({ owner, store, execution });
  return {
    store,
    handlers,
    calls,
    customResponses,
    close() {
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('capabilities contract descriptors align 1-to-1 with handlers and enforce narrow read/write separation', () => {
  assert.ok(Array.isArray(operations) && operations.length > 0);
  const names = operations.map((op) => op.name);
  assert.equal(new Set(names).size, names.length, 'Operation names must be unique');

  const handlers = createHandlers({ owner: async () => ({}) });
  assert.deepEqual(Object.keys(handlers).sort(), [...names].sort());

  for (const op of operations) {
    assert.match(op.name, /^capability_/, `${op.name} must carry business prefix`);
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 10);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    assert.equal(op.inputSchema?.type, 'object');
    if (op.readOnly) {
      assert.equal(op.destructive, false, `${op.name} cannot be both readOnly and destructive`);
    }
    const propNames = Object.keys(op.inputSchema?.properties ?? {});
    for (const forbidden of ['actor', 'source', 'url', 'baseUrl', 'env', 'headers', 'command', 'credentialRef', 'apiKeyRef']) {
      assert.ok(!propNames.includes(forbidden), `${op.name} must not declare forbidden top-level arg '${forbidden}'`);
    }
  }

  const destructiveNames = operations.filter((op) => op.destructive).map((op) => op.name).sort();
  assert.deepEqual(destructiveNames, ['capability_installation_uninstall', 'capability_skill_delete']);
  assert.deepEqual([...SAFE_CAPABILITY_ACTIONS], ['listTools', 'validate', 'probe']);
});

test('actor authentication rejects missing/spoofed actors and enforces bot defaults vs oauth explicit targets', async () => {
  const fx = openFixture();
  try {
    await assert.rejects(() => fx.handlers.capability_installation_list({}, null), { code: 'UNAUTHENTICATED' });
    await assert.rejects(() => fx.handlers.capability_installation_list({}, { kind: 'owner' }), { code: 'UNAUTHENTICATED' });

    // OAuth must explicitly provide deviceId and botId for Bot-scoped tools.
    await assert.rejects(() => fx.handlers.capability_bot_list({}, OAUTH_ADMIN), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(() => fx.handlers.capability_bot_list({ deviceId: 'dev-1' }, OAUTH_ADMIN), { code: 'INVALID_ARGUMENT' });

    // Spoofing args.actor must NEVER elevate a Bot actor into OAuth visibility.
    const listAsBotB = await fx.handlers.capability_installation_list(
      { actor: { kind: 'oauth', clientId: 'spoofed' } },
      BOT_B,
    );
    const idsForBotB = listAsBotB.installations.map((item) => item.installationId);
    assert.ok(!idsForBotB.includes('inst-skill-a'), 'Bot B must not see Bot A private skill even with spoofed args.actor');

    // Bot A omits deviceId/botId and defaults to its own identity.
    const botList = await fx.handlers.capability_bot_list({}, BOT_A);
    assert.equal(botList.deviceId, 'dev-1');
    assert.equal(botList.botId, 'bot-a');
  } finally {
    fx.close();
  }
});

test('reads never leak raw configs, URLs, credentials, env, headers, or commands; safe writes preserve restricted fields', async () => {
  const fx = openFixture();
  try {
    const forbiddenSubstrings = [
      'internal-hindsight:8888',
      'cred-hindsight',
      'hs-secret-value-123',
      'secret-tavily-proxy',
      'cred-tavily',
      'tv-secret-value-456',
      'mcp.internal.example',
      'secret-query',
      'super-secret-env-val',
      'super-secret-header',
      'cred-mcp-api',
      'mcp-secret-value-789',
      '/usr/local/bin/demo-mcp',
      '--secret-flag',
    ];

    const listOut = await fx.handlers.capability_installation_list({}, OAUTH_ADMIN);
    const hsDetail = await fx.handlers.capability_installation_get(
      { installationId: 'inst-hindsight', includeBindings: true },
      OAUTH_ADMIN,
    );
    const wfDetail = await fx.handlers.capability_installation_get(
      { installationId: 'inst-webfox' },
      OAUTH_ADMIN,
    );
    const mcpDetail = await fx.handlers.capability_installation_get(
      { installationId: 'inst-mcp-npm' },
      OAUTH_ADMIN,
    );

    const serialized = JSON.stringify({ listOut, hsDetail, wfDetail, mcpDetail });
    for (const secret of forbiddenSubstrings) {
      assert.ok(!serialized.includes(secret), `Sanitized read leaked restricted value: ${secret}`);
    }

    assert.deepEqual(hsDetail.safeGlobalConfig, {
      projectId: 'proj-alpha',
      mode: 'read-write',
      timeoutMs: 15000,
    });
    assert.deepEqual(hsDetail.restrictedFields, ['apiKeyRef', 'baseUrl']);
    assert.deepEqual(hsDetail.configuredRestrictedFields, ['apiKeyRef', 'baseUrl']);
    assert.deepEqual(hsDetail.credentialSlots, [
      { path: '/apiKeyRef', refSet: true, configured: true, revision: 0 },
    ]);
    assert.deepEqual(hsDetail.safeActions, ['probe']);
    assert.deepEqual(wfDetail.safeActions, ['probe']);
    assert.deepEqual(mcpDetail.safeActions, ['validate', 'listTools']);
    assert.deepEqual(wfDetail.safeGlobalConfig, {
      capabilities: { search: { provider: 'tavily', maxResults: 5 } },
      timeoutMs: 30000,
      retries: 1,
    });

    // Reject restricted config fields on global write (even null).
    for (const badPatch of [
      { baseUrl: 'https://evil.example' },
      { baseUrl: null },
      { apiKeyRef: 'cred-hindsight' },
      { apiKeyRef: null },
    ]) {
      await assert.rejects(
        () => fx.handlers.capability_installation_config_set(
          { installationId: 'inst-hindsight', expectedRevision: 1, safeConfigPatch: badPatch },
          OAUTH_ADMIN,
        ),
        { code: 'FORBIDDEN' },
      );
    }
    await assert.rejects(
      () => fx.handlers.capability_installation_config_set(
        { installationId: 'inst-webfox', expectedRevision: 1, safeConfigPatch: { providers: { tavily: { baseUrl: 'https://evil' } } } },
        OAUTH_ADMIN,
      ),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      () => fx.handlers.capability_installation_config_set(
        { installationId: 'inst-mcp-npm', expectedRevision: 1, safeConfigPatch: { env: { A: '1' } } },
        OAUTH_ADMIN,
      ),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      () => fx.handlers.capability_installation_config_set(
        { installationId: 'inst-hindsight', expectedRevision: 1, safeConfigPatch: { unknownField: 'x' } },
        OAUTH_ADMIN,
      ),
      { code: 'VALIDATION_FAILED' },
    );

    // CAS mismatch is rejected.
    await assert.rejects(
      () => fx.handlers.capability_installation_config_set(
        { installationId: 'inst-hindsight', expectedRevision: 99, safeConfigPatch: { mode: 'read-only' } },
        OAUTH_ADMIN,
      ),
      { code: 'REVISION_CONFLICT' },
    );

    // Safe global patch updates safe fields and preserves existing restricted fields untouched.
    const updatedGlobal = await fx.handlers.capability_installation_config_set(
      { installationId: 'inst-hindsight', expectedRevision: 1, safeConfigPatch: { mode: 'read-only', projectId: 'proj-beta' } },
      OAUTH_ADMIN,
    );
    assert.equal(updatedGlobal.revision, 2);
    assert.deepEqual(updatedGlobal.safeGlobalConfig, {
      projectId: 'proj-beta',
      mode: 'read-only',
      timeoutMs: 15000,
    });
    assert.ok(!JSON.stringify(updatedGlobal).includes('internal-hindsight:8888'));
    assert.ok(!JSON.stringify(updatedGlobal).includes('cred-hindsight'));

    const rawStored = fx.store.getInstallationConfig('inst-hindsight').globalConfig;
    assert.equal(rawStored.baseUrl, 'http://internal-hindsight:8888');
    assert.equal(rawStored.apiKeyRef, 'cred-hindsight');
    assert.equal(rawStored.mode, 'read-only');
    assert.equal(rawStored.projectId, 'proj-beta');
  } finally {
    fx.close();
  }
});

test('distinguishes globalEnabled, globallyEffective, botEnabled, effectivelyEnabled, and runtimeApplied', async () => {
  const fx = openFixture();
  try {
    // inst-webfox is enabled=true but activation.status='enabling' => NOT globallyEffective!
    const wfDetail = await fx.handlers.capability_installation_get({ installationId: 'inst-webfox' }, OAUTH_ADMIN);
    assert.equal(wfDetail.installation.globalEnabled, true);
    assert.equal(wfDetail.installation.activationStatus, 'enabling');
    assert.equal(wfDetail.installation.globallyEffective, false);

    // Enable inst-hindsight for Bot A via capability_bot_binding_set with safe override.
    const bound = await fx.handlers.capability_bot_binding_set(
      {
        deviceId: 'dev-1',
        botId: 'bot-a',
        installationId: 'inst-hindsight',
        expectedRevision: 0,
        enabled: true,
        safeOverridesPatch: { mode: 'read-only' },
      },
      OAUTH_ADMIN,
    );
    assert.equal(bound.globalEnabled, true);
    assert.equal(bound.globallyEffective, true);
    assert.equal(bound.botEnabled, true);
    assert.equal(bound.effectivelyEnabled, true);
    assert.equal(bound.deploymentStatus, 'not-deployed');
    assert.equal(bound.runtimeApplied, false);
    assert.deepEqual(bound.safeOverrides, { mode: 'read-only' });

    // Record matching deployment plan + applied receipt + matching runtime receipt.
    fx.store.putDeploymentPlan({
      protocol: 1,
      target: 'host',
      deviceId: 'dev-1',
      operationId: 'op-hs-1',
      installationId: 'inst-hindsight',
      packageId: 'e-launcher.hindsight',
      kind: 'plugin',
      action: 'install',
      planId: 'plan-hs-1',
      desiredRevision: 1,
      targetVersion: '1.0.0',
      artifactRef: 'art-hindsight',
      digest: 'sha256:hindsight',
      manifest: {},
      lockfile: null,
    });
    fx.store.putDeploymentReceipt({
      deviceId: 'dev-1',
      installationId: 'inst-hindsight',
      operationId: 'op-hs-1',
      planId: 'plan-hs-1',
      desiredRevision: 1,
      appliedRevision: 1,
      actualVersion: '1.0.0',
      phase: 'applied',
      health: 'ready',
      error: null,
    });
    const desired = fx.store.getDeviceRuntimeStatus('dev-1', true).desiredRevision;
    fx.store.putRuntimeReceipt({
      deviceId: 'dev-1',
      revision: desired,
      appliedRevision: desired,
      status: 'applied',
      error: null,
      bots: [{ botId: 'bot-a', desiredRevision: desired, appliedRevision: desired, status: 'applied', error: null }],
      capabilityErrors: [],
    });

    const listAfter = await fx.handlers.capability_bot_list({}, BOT_A);
    const hsItem = listAfter.capabilities.find((item) => item.installation.installationId === 'inst-hindsight');
    assert.equal(hsItem.effectivelyEnabled, true);
    assert.equal(hsItem.deploymentStatus, 'deployed');
    assert.equal(hsItem.runtimeApplied, true);

    // Shared built-in capability cannot be toggled per Bot.
    await assert.rejects(
      () => fx.handlers.capability_bot_binding_set(
        {
          deviceId: 'dev-1',
          botId: 'bot-a',
          installationId: GOOGLE_WORKSPACE_INSTALLATION_ID,
          expectedRevision: 0,
          enabled: false,
        },
        OAUTH_ADMIN,
      ),
      { code: 'FORBIDDEN' },
    );
  } finally {
    fx.close();
  }
});

test('diagnostics allowlist only listTools, validate, and probe; learning rejects learn/sources; update rejects source', async () => {
  const fx = openFixture();
  try {
    fx.customResponses.set('POST /api/installations/:id/tools/list', ({ params }) => ({
      tools: [{ name: params.id === GOOGLE_WORKSPACE_INSTALLATION_ID ? 'google_mail_search' : 'demo_tool' }],
    }));
    fx.customResponses.set('POST /api/installations/:id/validate', () => ({ ok: true }));
    fx.customResponses.set('POST /api/devices/:deviceId/bots/:botId/installations', ({ body }) => {
      if (body.action === 'probe') {
        return {
          installation: { installationId: body.installationId, packageId: 'e-launcher.hindsight', enabled: true },
          configured: true,
          configuration: {
            schemaValid: true,
            globalRevision: 1,
            bindingRevision: 1,
            enabled: true,
            credentialRefs: [{ path: '/apiKeyRef', credentialRef: 'cred-hindsight', configured: true, revision: 0 }],
            desiredRevision: 2,
            appliedRevision: 2,
            receipt: null,
          },
          deployment: { status: 'deployed', desiredRevision: 1, planId: 'plan-1', receipt: null },
          probe: { status: 'verified', version: '1.0.0', operation: 'health' },
        };
      }
      return { plans: [], receipts: [] };
    });

    // Safe diagnostic actions succeed and sanitize probe credentialRefs.
    const builtinTools = await fx.handlers.capability_installation_diagnose(
      { deviceId: 'dev-1', botId: 'bot-a', installationId: GOOGLE_WORKSPACE_INSTALLATION_ID, action: 'listTools' },
      OAUTH_ADMIN,
    );
    assert.equal(builtinTools.result.tools[0].name, 'google_mail_search');

    const validated = await fx.handlers.capability_installation_diagnose(
      { deviceId: 'dev-1', botId: 'bot-a', installationId: 'inst-mcp-npm', action: 'validate' },
      OAUTH_ADMIN,
    );
    assert.equal(validated.result.ok, true);

    const probed = await fx.handlers.capability_installation_diagnose(
      { deviceId: 'dev-1', botId: 'bot-a', installationId: 'inst-hindsight', action: 'probe' },
      OAUTH_ADMIN,
    );
    assert.equal(probed.result.probe.status, 'verified');
    assert.ok(!JSON.stringify(probed).includes('cred-hindsight'));
    assert.deepEqual(probed.result.configuration.credentialSlots, [
      { path: '/apiKeyRef', refSet: true, configured: true, revision: 0 },
    ]);

    // Arbitrary plugin actions are forbidden.
    for (const badAction of ['readLearningSource', 'retainMemory', 'answerQuestionnaire', 'exec']) {
      await assert.rejects(
        () => fx.handlers.capability_installation_diagnose(
          { deviceId: 'dev-1', botId: 'bot-a', installationId: 'inst-webfox', action: badAction },
          OAUTH_ADMIN,
        ),
        { code: 'FORBIDDEN' },
      );
    }

    // Learning run allows review/curate and forbids learn/sources.
    fx.customResponses.set('POST /api/devices/:deviceId/bots/:botId/learning', ({ body }) => ({
      jobId: 'job-1',
      action: body.action,
      status: 'queued',
    }));
    const reviewJob = await fx.handlers.capability_learning_run(
      { deviceId: 'dev-1', botId: 'bot-a', mode: 'review', focus: 'recent errors' },
      OAUTH_ADMIN,
    );
    assert.equal(reviewJob.jobId, 'job-1');

    await assert.rejects(
      () => fx.handlers.capability_learning_run(
        { deviceId: 'dev-1', botId: 'bot-a', mode: 'learn' },
        OAUTH_ADMIN,
      ),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      () => fx.handlers.capability_learning_run(
        { deviceId: 'dev-1', botId: 'bot-a', mode: 'review', sources: ['/etc/passwd'] },
        OAUTH_ADMIN,
      ),
      { code: 'FORBIDDEN' },
    );

    // Update rejects arbitrary source and non-npm installations; accepts version update on existing npm installation.
    await assert.rejects(
      () => fx.handlers.capability_installation_update(
        { installationId: 'inst-mcp-npm', requestId: 'req-1', source: { type: 'http', url: 'https://evil.example' } },
        OAUTH_ADMIN,
      ),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      () => fx.handlers.capability_installation_update(
        { installationId: 'inst-hindsight', requestId: 'req-2' },
        OAUTH_ADMIN,
      ),
      { code: 'INVALID_STATE' },
    );
    const updAccepted = await fx.handlers.capability_installation_update(
      { installationId: 'inst-mcp-npm', requestId: 'req-3', targetVersion: '1.3.0' },
      OAUTH_ADMIN,
    );
    assert.equal(updAccepted.accepted, true);
    assert.equal(updAccepted.action, 'update');
    assert.equal(updAccepted.operation.phase, 'queued');

    const polled = await fx.handlers.capability_operation_get({ operationId: updAccepted.operationId }, OAUTH_ADMIN);
    assert.equal(polled.operation.operationId, updAccepted.operationId);
  } finally {
    fx.close();
  }
});

test('skill sharing and bot scope enforce isolation for non-owning bots and allow CAS sharing updates', async () => {
  const fx = openFixture();
  try {
    // Bot B cannot share Bot A's private skill; Bot A can share its own skill.
    await assert.rejects(
      () => fx.handlers.capability_installation_sharing_set(
        { installationId: 'inst-skill-a', expectedRevision: 0, visibilityScope: 'global' },
        BOT_B,
      ),
      { code: 'NOT_FOUND' },
    );

    const shared = await fx.handlers.capability_installation_sharing_set(
      { installationId: 'inst-skill-a', expectedRevision: 0, visibilityScope: 'assigned', displayName: 'Shared Alpha Skill' },
      BOT_A,
    );
    assert.equal(shared.installation.visibilityScope, 'assigned');
    assert.equal(shared.installation.displayName, 'Shared Alpha Skill');
    assert.equal(shared.installation.revision, 1);

    // Once shared, Bot B can see it, but STILL cannot change sharing or globally disable it.
    const listB = await fx.handlers.capability_installation_list({}, BOT_B);
    assert.ok(listB.installations.some((inst) => inst.installationId === 'inst-skill-a'));

    await assert.rejects(
      () => fx.handlers.capability_installation_sharing_set(
        { installationId: 'inst-skill-a', expectedRevision: 1, visibilityScope: 'private' },
        BOT_B,
      ),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      () => fx.handlers.capability_installation_toggle(
        { installationId: 'inst-skill-a', action: 'disable', requestId: 'req-dis-b' },
        BOT_B,
      ),
      { code: 'FORBIDDEN' },
    );

    // OAuth admin can toggle global enable/disable and uninstall with explicit requestId.
    const disabled = await fx.handlers.capability_installation_toggle(
      { installationId: 'inst-skill-a', action: 'disable', requestId: 'req-dis-oauth' },
      OAUTH_ADMIN,
    );
    assert.equal(disabled.accepted, true);
    assert.equal(disabled.action, 'disable');

    const uninstalled = await fx.handlers.capability_installation_uninstall(
      { installationId: 'inst-skill-a', requestId: 'req-uninst-oauth' },
      OAUTH_ADMIN,
    );
    assert.equal(uninstalled.accepted, true);
    assert.equal(uninstalled.action, 'uninstall');
  } finally {
    fx.close();
  }
});

test('covers skill CRUD/lifecycle/files, learning status/configure/cancel, updates check, and deployments routes', async () => {
  const fx = openFixture();
  try {
    const skillBodies = [];
    fx.customResponses.set('POST /api/devices/:deviceId/bots/:botId/skills', ({ body }) => {
      skillBodies.push(body);
      if (body.action === 'list') {
        return {
          skills: [{ skillId: 'skill-a-1', name: 'alpha-skill', state: 'active', installationId: 'inst-skill-a' }],
          installed: [{ name: 'ext-skill', enabled: true, activated: false, installationId: 'inst-ext' }],
        };
      }
      if (body.action === 'read') {
        return { skillId: 'skill-a-1', name: 'alpha-skill', state: 'active', installationId: 'inst-skill-a', files: { 'SKILL.md': '---\nname: alpha-skill\n---\nbody' } };
      }
      if (body.action === 'delete') {
        return { deleted: true, skillId: body.skillId ?? 'skill-a-1', name: body.name ?? 'alpha-skill' };
      }
      return { skillId: 'skill-a-1', name: body.name ?? 'alpha-skill', state: body.action === 'archive' ? 'archived' : 'active', installationId: 'inst-skill-a' };
    });
    fx.customResponses.set('POST /api/devices/:deviceId/bots/:botId/skill-reviews', () => ({
      items: [{
        skillId: 'skill-a-1',
        name: 'alpha-skill',
        state: 'active',
        visibilityScope: 'private',
        useCount: 3,
        deployment: { status: 'queued' },
      }],
    }));
    fx.customResponses.set('GET /api/installations/:id/skill-files', ({ params }) => ({
      installationId: params.id,
      editable: true,
      files: { 'SKILL.md': '---\nname: alpha-skill\n---\nhello' },
      skills: [{ dir: '.', name: 'alpha-skill', description: null, files: ['SKILL.md'] }],
    }));
    fx.customResponses.set('PUT /api/installations/:id/skill-files', ({ params, body }) => ({
      installationId: params.id,
      editable: true,
      files: body.files,
      skills: [{ dir: '.', name: 'alpha-skill', description: null, files: Object.keys(body.files) }],
    }));
    fx.customResponses.set('POST /api/devices/:deviceId/bots/:botId/learning', ({ body }) => {
      if (body.action === 'status') return { deviceId: 'dev-1', botId: 'bot-a', settings: { revision: 2 }, activeJob: null, lastJob: null };
      if (body.action === 'configure') return { settings: { ...body.config, revision: body.expectedRevision + 1 } };
      if (body.action === 'cancel') return { jobId: body.jobId, status: 'cancelled' };
      return { jobId: 'job-2', status: 'queued' };
    });
    fx.customResponses.set('POST /api/installations/:id/updates/check', () => ([
      { packageId: '@example/demo-mcp', version: '1.3.0', kind: 'mcp', digest: 'sha256:new' },
    ]));
    fx.customResponses.set('POST /api/devices/:deviceId/bots/:botId/installations', ({ body }) => ({
      installationId: body.installationId,
      plans: [{ planId: 'plan-1', installationId: body.installationId, desiredRevision: 1 }],
      receipts: [],
    }));

    const skillList = await fx.handlers.capability_skill_list({}, BOT_A);
    assert.equal(skillList.managed[0].useCount, 3);
    assert.equal(skillList.managed[0].deploymentApplied, false);
    assert.equal(skillList.installed[0].botEnabled, true);
    assert.equal(skillList.installed[0].globallyEffective, false);
    assert.equal(skillList.installed[0].effectivelyEnabled, false);

    const skillRead = await fx.handlers.capability_skill_read({ name: 'alpha-skill' }, BOT_A);
    assert.equal(skillRead.name, 'alpha-skill');

    await fx.handlers.capability_skill_create({ name: 'new-skill', content: '---\nname: new-skill\n---\nhi', requestId: 'req-c1' }, BOT_A);
    await fx.handlers.capability_skill_edit({ mode: 'update', name: 'new-skill', description: 'Use when testing.', requestId: 'req-e1' }, BOT_A);
    await fx.handlers.capability_skill_edit({ mode: 'patch', name: 'new-skill', oldText: 'hi', newText: 'hello', requestId: 'req-e2' }, BOT_A);
    await fx.handlers.capability_skill_adopt({ installationId: 'inst-skill-a', newName: 'adopted-skill' }, BOT_A);
    await fx.handlers.capability_skill_lifecycle({ action: 'pin', name: 'alpha-skill', pinned: true }, BOT_A);
    await fx.handlers.capability_skill_lifecycle({ action: 'lock', name: 'alpha-skill', locked: true }, BOT_A);
    await fx.handlers.capability_skill_lifecycle({ action: 'archive', name: 'alpha-skill', forceUnshare: true }, BOT_A);
    await fx.handlers.capability_skill_lifecycle({ action: 'restore', name: 'alpha-skill' }, BOT_A);
    const delRes = await fx.handlers.capability_skill_delete({ skillId: 'skill-a-1' }, BOT_A);
    assert.equal(delRes.deleted, true);

    assert.equal(skillBodies.some((b) => b.action === 'archive' && b.forceUnshare === true), true);

    // Skill-files read/write respects private skill isolation for Bot B and works for Bot A / OAuth.
    await assert.rejects(
      () => fx.handlers.capability_installation_skill_files_read({ installationId: 'inst-skill-a' }, BOT_B),
      { code: 'NOT_FOUND' },
    );
    const sfRead = await fx.handlers.capability_installation_skill_files_read({ installationId: 'inst-skill-a' }, BOT_A);
    assert.equal(sfRead.editable, true);
    const sfWrite = await fx.handlers.capability_installation_skill_files_write(
      { installationId: 'inst-skill-a', files: { 'SKILL.md': '---\nname: alpha-skill\n---\nupdated' }, requestId: 'req-sf1' },
      OAUTH_ADMIN,
    );
    assert.match(sfWrite.files['SKILL.md'], /updated/);

    // Learning status/configure/cancel.
    const lStatus = await fx.handlers.capability_learning_status({}, BOT_A);
    assert.equal(lStatus.settings.revision, 2);
    const lCfg = await fx.handlers.capability_learning_configure(
      { expectedRevision: 2, config: { review: { memoryEvery: 5 }, curator: { consolidate: true } } },
      BOT_A,
    );
    assert.equal(lCfg.settings.revision, 3);
    const lCancel = await fx.handlers.capability_learning_cancel({ jobId: 'job-2' }, BOT_A);
    assert.equal(lCancel.status, 'cancelled');

    // Updates check & deployments.
    const updCheck = await fx.handlers.capability_installation_updates_check({ installationId: 'inst-mcp-npm' }, OAUTH_ADMIN);
    assert.equal(updCheck.updates[0].version, '1.3.0');
    const depsOut = await fx.handlers.capability_installation_deployments(
      { installationId: 'inst-hindsight', deviceId: 'dev-1', botId: 'bot-a' },
      OAUTH_ADMIN,
    );
    assert.equal(depsOut.plans[0].planId, 'plan-1');
  } finally {
    fx.close();
  }
});
