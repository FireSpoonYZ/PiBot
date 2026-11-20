import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operations } from '../../center-contract/operations/center-admin.js';
import { createHandlers } from '../../center-server/operations/center-admin.js';
import { invokeOwnerAction } from '../../center-server/operations/owner-actions.js';
import { openCenterStore } from '../../center-server/data/index.js';

const BOT_ACTOR = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-1' };
const OAUTH_ACTOR = { kind: 'oauth', clientId: 'client-1' };

const ALLOWED_OWNER_ROUTES = new Set([
  'GET /api/devices',
  'PATCH /api/devices/:deviceId',
  'GET /api/devices/:deviceId/runtime-status',
  'GET /api/bot-sync',
  'GET /api/model-config',
  'PUT /api/model-config',
  'GET /api/model-picker',
  'GET /api/model-catalog',
  'POST /api/model-catalog/sync',
  'PUT /api/model-stars',
  'GET /api/providers',
  'GET /api/providers/:id',
  'PUT /api/providers/:id',
  'GET /api/provider-auth-status',
  'GET /api/providers/:id/auth-status',
  'POST /api/providers/:id/validate',
  'POST /api/providers/:id/discover',
  'GET /api/providers/:id/models',
  'POST /api/providers/:id/models',
  'POST /api/providers/:id/models/batch',
  'PUT /api/providers/:id/models/:modelId',
  'DELETE /api/providers/:id/models/:modelId',
  'GET /api/client-releases',
  'GET /api/operations/:id',
  'GET /api/installations/:id/deployments',
]);

function createRecorderOwner(responder) {
  const calls = [];
  const owner = async (method, routePattern, opts = {}) => {
    const key = `${method} ${routePattern}`;
    assert.ok(ALLOWED_OWNER_ROUTES.has(key), `Unexpected owner route called: ${key}`);
    calls.push({ method, routePattern, params: opts.params ?? {}, body: opts.body, query: opts.query ?? {} });
    return responder(method, routePattern, opts);
  };
  return { owner, calls };
}

test('center-admin descriptors match handlers 1:1 with valid JSON Schema and safety flags', () => {
  assert.ok(Array.isArray(operations) && operations.length === 24);
  const { owner } = createRecorderOwner(() => ({}));
  const handlers = createHandlers({ owner });

  const descriptorNames = operations.map((op) => op.name);
  const handlerNames = Object.keys(handlers);
  assert.equal(new Set(descriptorNames).size, descriptorNames.length, 'Operation names must be unique');
  assert.deepEqual([...handlerNames].sort(), [...descriptorNames].sort());

  for (const op of operations) {
    assert.ok(op.name.startsWith('center_'), `Operation name must carry center_ prefix: ${op.name}`);
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 10);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    assert.equal(op.inputSchema?.type, 'object');
    assert.equal(typeof op.inputSchema?.properties, 'object');
    assert.ok(Array.isArray(op.inputSchema?.required));
    assert.equal(typeof handlers[op.name], 'function');
    if (op.readOnly) {
      assert.equal(op.destructive, false, `Read-only operation must not be destructive: ${op.name}`);
    }
  }

  const destructiveNames = operations.filter((op) => op.destructive).map((op) => op.name);
  assert.deepEqual(destructiveNames, ['center_delete_provider_model']);
  assert.equal(operations.find((op) => op.name === 'center_validate_provider')?.readOnly, false);
  assert.equal(operations.find((op) => op.name === 'center_discover_provider_models')?.readOnly, false);
  assert.throws(() => createHandlers({}), TypeError);
});

test('devices, runtime status, and bot sync sanitize device fields and enforce argument bounds', async () => {
  const { owner, calls } = createRecorderOwner((method, route, opts) => {
    if (method === 'GET' && route === '/api/devices') {
      return [
        { deviceId: 'dev-1', name: 'Workstation', online: true, platform: 'windows', oauthAdminEnabled: true, secret: 'nope' },
      ];
    }
    if (method === 'PATCH' && route === '/api/devices/:deviceId') {
      return { deviceId: opts.params.deviceId, name: opts.body.name, online: true, oauthAdminEnabled: true };
    }
    if (method === 'GET' && route === '/api/devices/:deviceId/runtime-status') {
      return {
        deviceId: opts.params.deviceId,
        online: true,
        desiredRevision: 4,
        appliedRevision: 4,
        status: 'applied',
        updatedAt: '2026-11-20T00:00:00.000Z',
        appliedAt: '2026-11-20T00:00:01.000Z',
        error: null,
        bots: [{ botId: 'bot-1', desiredRevision: 4, appliedRevision: 4, status: 'applied', error: null }],
        capabilityErrors: [],
      };
    }
    if (method === 'GET' && route === '/api/bot-sync') {
      return {
        epoch: 'ep-1',
        seq: 12,
        mode: 'snapshot',
        devices: [{ deviceId: 'dev-1', name: 'Workstation', online: true, platform: 'windows', oauthAdminEnabled: true }],
        bots: [{ deviceId: 'dev-1', botId: 'bot-1', name: 'Assistant', online: true, seq: 12 }],
      };
    }
    throw new Error(`Unhandled ${method} ${route}`);
  });
  const handlers = createHandlers({ owner });

  const listed = await handlers.center_list_devices({}, BOT_ACTOR);
  assert.deepEqual(listed, {
    devices: [{ deviceId: 'dev-1', name: 'Workstation', online: true, platform: 'windows' }],
  });
  assert.equal('oauthAdminEnabled' in listed.devices[0], false);

  const renamed = await handlers.center_rename_device({ deviceId: 'dev-1', name: '  Studio Mac  ' }, OAUTH_ACTOR);
  assert.deepEqual(renamed, { deviceId: 'dev-1', name: 'Studio Mac', online: true });
  assert.deepEqual(calls[1].body, { name: 'Studio Mac' });

  await assert.rejects(
    () => handlers.center_rename_device({ deviceId: 'dev-1', name: 'bad\nname' }, BOT_ACTOR),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    () => handlers.center_list_devices({ actor: { kind: 'oauth', clientId: 'spoof' } }, BOT_ACTOR),
    { code: 'INVALID_ARGUMENT' },
  );

  const runtime = await handlers.center_get_device_runtime_status({ deviceId: 'dev-1' }, BOT_ACTOR);
  assert.equal(runtime.status, 'applied');
  assert.equal(runtime.appliedRevision, 4);

  const sync = await handlers.center_get_bot_sync({ epoch: 'ep-1', sinceSeq: 5 }, BOT_ACTOR);
  assert.deepEqual(calls[3].query, { epoch: 'ep-1', sinceSeq: '5' });
  assert.equal('oauthAdminEnabled' in sync.devices[0], false);
  assert.equal(sync.bots.length, 1);
});

test('provider reads, updates, validate, discover, and model management block upstream/secret leakage and mutations', async () => {
  const storedProvider = {
    id: 'custom-ai',
    name: 'Custom AI',
    api: 'openai-completions',
    baseUrl: 'https://private-gateway.internal/v1',
    credentialRef: 'custom-ai-api-key',
    enabled: true,
    native: false,
    configured: true,
    custom: {
      baseUrl: 'https://override.internal/v1',
      headers: { Authorization: 'Bearer top-secret-header' },
    },
    revision: 3,
  };
  const storedModels = [
    {
      id: 'gpt-custom',
      name: 'GPT Custom',
      api: 'openai-responses',
      baseUrl: 'https://model-private.internal/v1',
      headers: { 'x-api-key': 'model-secret-key' },
      contextWindow: 128000,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoning: true,
      enabled: true,
      source: 'manual',
      revision: 2,
    },
  ];

  const { owner, calls } = createRecorderOwner((method, route, opts) => {
    if (method === 'GET' && route === '/api/providers') return [storedProvider];
    if (method === 'GET' && route === '/api/providers/:id') return storedProvider;
    if (method === 'GET' && route === '/api/provider-auth-status') {
      return {
        openai: { providerId: 'openai', method: 'api_key', oauth: false, apiKey: true, label: 'OpenAI', subscription: false, secretLeak: 'x' },
      };
    }
    if (method === 'GET' && route === '/api/providers/:id/auth-status') {
      return { providerId: opts.params.id, method: 'oauth', oauth: true, apiKey: false, label: 'Login', subscription: true };
    }
    if (method === 'PUT' && route === '/api/providers/:id') {
      assert.equal(opts.body.expectedRevision, 3);
      assert.equal(opts.body.value.baseUrl, storedProvider.baseUrl);
      assert.equal(opts.body.value.api, storedProvider.api);
      assert.equal(opts.body.value.credentialRef, storedProvider.credentialRef);
      assert.deepEqual(opts.body.value.custom, storedProvider.custom);
      return { ...storedProvider, ...opts.body.value, revision: 4 };
    }
    if (method === 'POST' && route === '/api/providers/:id/validate') {
      assert.deepEqual(opts.body, {});
      if (opts.params.id === 'leaky-fail') {
        return { ok: false, message: 'Failed connecting to https://secret-upstream.internal with Bearer sk-secret-123' };
      }
      if (opts.params.id === 'leaky-throw') {
        throw Object.assign(new Error('Upstream https://secret-upstream.internal rejected Bearer sk-secret-123'), { code: 'INVALID_ARGUMENT' });
      }
      if (opts.params.id === 'antigravity') {
        return { ok: true, message: 'gemini-2.5-pro' };
      }
      return { ok: true, message: 'gpt-custom', rawConfig: 'must-strip' };
    }
    if (method === 'POST' && route === '/api/providers/:id/discover') {
      assert.deepEqual(opts.body, {});
      if (opts.params.id === 'leaky-throw') {
        throw Object.assign(new Error('Upstream https://secret-upstream.internal rejected Bearer sk-secret-123'), { code: 'INVALID_ARGUMENT' });
      }
      return {
        models: [
          {
            id: opts.params.id === 'antigravity' ? 'gemini-2.5-pro' : 'discovered-1',
            name: opts.params.id === 'antigravity' ? 'Gemini 2.5 Pro' : 'Discovered 1',
            baseUrl: 'https://secret.internal',
            headers: { Authorization: 'Bearer nope' },
            contextWindow: 64000,
            maxTokens: 4096,
            input: ['text'],
            reasoning: false,
            enabled: true,
            revision: 0,
          },
        ],
      };
    }
    if (method === 'GET' && route === '/api/providers/:id/models') return storedModels;
    if (method === 'POST' && route === '/api/providers/:id/models') {
      return { ...opts.body, revision: 0 };
    }
    if (method === 'POST' && route === '/api/providers/:id/models/batch') {
      return { models: opts.body.models.map((item) => ({ ...item, revision: 0 })) };
    }
    if (method === 'PUT' && route === '/api/providers/:id/models/:modelId') {
      assert.equal(opts.body.expectedRevision, 2);
      assert.equal(opts.body.value.api, 'openai-responses');
      assert.equal(opts.body.value.baseUrl, 'https://model-private.internal/v1');
      assert.deepEqual(opts.body.value.headers, { 'x-api-key': 'model-secret-key' });
      return { ...opts.body.value, revision: 3 };
    }
    if (method === 'DELETE' && route === '/api/providers/:id/models/:modelId') {
      return { deleted: true, hiddenFromCatalog: false, clearedGlobalModel: true, clearedBotModels: 1 };
    }
    throw new Error(`Unhandled ${method} ${route}`);
  });
  const handlers = createHandlers({ owner });

  const listedProviders = await handlers.center_list_providers({ configuredOnly: true, enabledOnly: true }, BOT_ACTOR);
  assert.equal(listedProviders.providers.length, 1);
  assert.equal(JSON.stringify(listedProviders).includes('private-gateway'), false);
  assert.equal(JSON.stringify(listedProviders).includes('top-secret-header'), false);
  assert.equal(JSON.stringify(listedProviders).includes('custom-ai-api-key'), false);
  assert.equal(listedProviders.providers[0].hasCredentialRef, true);
  assert.equal(listedProviders.providers[0].hasCustomOverrides, true);

  const singleProvider = await handlers.center_get_provider({ providerId: 'custom-ai' }, BOT_ACTOR);
  assert.equal('baseUrl' in singleProvider, false);
  assert.equal('custom' in singleProvider, false);
  assert.equal('credentialRef' in singleProvider, false);

  const allAuth = await handlers.center_get_provider_auth_status({}, BOT_ACTOR);
  assert.deepEqual(allAuth, {
    statuses: [{ providerId: 'openai', method: 'api_key', oauth: false, apiKey: true, label: 'OpenAI', subscription: false }],
  });
  const oneAuth = await handlers.center_get_provider_auth_status({ providerId: 'openai-codex' }, BOT_ACTOR);
  assert.equal(oneAuth.statuses[0].providerId, 'openai-codex');

  const updatedProvider = await handlers.center_update_provider(
    { providerId: 'custom-ai', expectedRevision: 3, name: 'Renamed AI', enabled: false },
    OAUTH_ACTOR,
  );
  assert.equal(updatedProvider.name, 'Renamed AI');
  assert.equal(updatedProvider.enabled, false);
  assert.equal(updatedProvider.revision, 4);
  assert.equal('custom' in updatedProvider, false);

  for (const forbidden of [
    { providerId: 'custom-ai', expectedRevision: 3, baseUrl: 'https://evil.example' },
    { providerId: 'custom-ai', expectedRevision: 3, api: 'anthropic-messages' },
    { providerId: 'custom-ai', expectedRevision: 3, credentialRef: 'other-key' },
    { providerId: 'custom-ai', expectedRevision: 3, custom: { headers: {} } },
    { providerId: 'custom-ai', expectedRevision: 3, apiKey: 'sk-evil' },
  ]) {
    await assert.rejects(
      () => handlers.center_update_provider(forbidden, BOT_ACTOR),
      { code: 'INVALID_ARGUMENT' },
    );
  }

  const validated = await handlers.center_validate_provider({ providerId: 'custom-ai' }, BOT_ACTOR);
  assert.deepEqual(validated, { ok: true, message: 'gpt-custom' });
  const leakyValidated = await handlers.center_validate_provider({ providerId: 'leaky-fail' }, BOT_ACTOR);
  assert.deepEqual(leakyValidated, { ok: false, message: 'Provider validation failed' });
  await assert.rejects(
    () => handlers.center_validate_provider({ providerId: 'leaky-throw' }, BOT_ACTOR),
    (err) => err?.code === 'INVALID_ARGUMENT' && err.message === 'Provider validation failed',
  );
  await assert.rejects(
    () => handlers.center_discover_provider_models({ providerId: 'leaky-throw' }, BOT_ACTOR),
    (err) => err?.code === 'INVALID_ARGUMENT' && err.message === 'Provider model discovery failed',
  );
  // Antigravity directly reuses owner auth-status, validate, and discover routes.
  const agyAuth = await handlers.center_get_provider_auth_status({ providerId: 'antigravity' }, BOT_ACTOR);
  assert.equal(agyAuth.statuses[0].providerId, 'antigravity');
  assert.equal(agyAuth.statuses[0].method, 'oauth');
  const agyValidated = await handlers.center_validate_provider({ providerId: 'antigravity' }, BOT_ACTOR);
  assert.deepEqual(agyValidated, { ok: true, message: 'gemini-2.5-pro' });
  const agyDiscovered = await handlers.center_discover_provider_models({ providerId: 'antigravity' }, BOT_ACTOR);
  assert.equal(agyDiscovered.providerId, 'antigravity');
  assert.equal(agyDiscovered.models[0].id, 'gemini-2.5-pro');
  await assert.rejects(
    () => handlers.center_validate_provider({ providerId: 'custom-ai', deviceId: 'dev-1' }, BOT_ACTOR),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    () => handlers.center_discover_provider_models({ providerId: 'custom-ai', baseUrl: 'https://evil.example' }, BOT_ACTOR),
    { code: 'INVALID_ARGUMENT' },
  );

  const discovered = await handlers.center_discover_provider_models({ providerId: 'custom-ai' }, BOT_ACTOR);
  assert.equal(discovered.models.length, 1);
  assert.equal('baseUrl' in discovered.models[0], false);
  assert.equal('headers' in discovered.models[0], false);
  assert.equal(discovered.models[0].hasCustomEndpoint, true);
  assert.equal(discovered.models[0].hasCustomHeaders, true);

  const listedModels = await handlers.center_list_provider_models({ providerId: 'custom-ai', includeRemoved: true }, BOT_ACTOR);
  assert.equal(JSON.stringify(listedModels).includes('model-secret-key'), false);
  assert.equal(JSON.stringify(listedModels).includes('model-private.internal'), false);
  assert.equal(listedModels.models[0].hasCustomEndpoint, true);
  assert.equal(listedModels.models[0].hasCustomHeaders, true);

  for (const forbiddenModel of [
    { providerId: 'custom-ai', id: 'm2', name: 'M2', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoning: false, baseUrl: 'https://evil.example' },
    { providerId: 'custom-ai', id: 'm2', name: 'M2', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoning: false, headers: { Authorization: 'x' } },
    { providerId: 'custom-ai', id: 'm2', name: 'M2', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoning: false, api: 'openai-completions' },
  ]) {
    await assert.rejects(
      () => handlers.center_create_provider_model(forbiddenModel, BOT_ACTOR),
      { code: 'INVALID_ARGUMENT' },
    );
  }

  await assert.rejects(
    () => handlers.center_batch_create_provider_models({
      providerId: 'custom-ai',
      models: [{ id: 'gpt-custom', name: 'Dup', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoning: false }],
    }, BOT_ACTOR),
    { code: 'REVISION_CONFLICT' },
  );

  const batchCreated = await handlers.center_batch_create_provider_models({
    providerId: 'custom-ai',
    models: [{ id: 'new-model-1', name: 'New Model 1', contextWindow: 32768, maxTokens: 4096, input: ['text'], reasoning: true }],
  }, BOT_ACTOR);
  assert.equal(batchCreated.models[0].id, 'new-model-1');

  const updatedModel = await handlers.center_update_provider_model(
    { providerId: 'custom-ai', modelId: 'gpt-custom', expectedRevision: 2, enabled: false, maxTokens: 4096 },
    BOT_ACTOR,
  );
  assert.equal(updatedModel.enabled, false);
  assert.equal(updatedModel.maxTokens, 4096);
  assert.equal(updatedModel.revision, 3);
  assert.equal('baseUrl' in updatedModel, false);
  assert.equal('headers' in updatedModel, false);

  await assert.rejects(
    () => handlers.center_update_provider_model(
      { providerId: 'custom-ai', modelId: 'gpt-custom', expectedRevision: 2, baseUrl: 'https://evil.example' },
      BOT_ACTOR,
    ),
    { code: 'INVALID_ARGUMENT' },
  );

  const deletedModel = await handlers.center_delete_provider_model(
    { providerId: 'custom-ai', modelId: 'gpt-custom' },
    OAUTH_ACTOR,
  );
  assert.deepEqual(deletedModel, {
    deleted: true,
    hiddenFromCatalog: false,
    clearedGlobalModel: true,
    clearedBotModels: 1,
  });
  assert.ok(calls.length > 0);
});

test('release and ops status read handlers project public fields and apply release filters', async () => {
  const { owner } = createRecorderOwner((method, route, opts) => {
    if (method === 'GET' && route === '/api/client-releases') {
      return {
        releases: [
          {
            id: 'rel-1',
            platform: 'windows',
            arch: 'x64',
            format: 'nsis',
            version: '0.0.25',
            size: 1000,
            sha256: 'a'.repeat(64),
            notes: 'Windows release',
            sourceCommit: 'ba1aef1',
            filename: 'pibot-0.0.25-windows-x64.exe',
            published: true,
            publishedAt: '2026-11-20T00:00:00.000Z',
            createdAt: '2026-11-20T00:00:00.000Z',
            downloadUrl: 'https://center.example/api/client-releases/rel-1/download',
          },
          {
            id: 'rel-2',
            platform: 'android',
            arch: 'arm64',
            format: 'apk',
            version: '0.0.25',
            versionCode: 25,
            size: 2000,
            sha256: 'b'.repeat(64),
            notes: 'Draft APK',
            sourceCommit: 'ba1aef1',
            filename: 'pibot-0.0.25-android-arm64.apk',
            published: false,
            publishedAt: null,
            createdAt: '2026-11-20T00:00:00.000Z',
            downloadUrl: 'https://center.example/api/client-releases/rel-2/download',
          },
        ],
      };
    }
    if (method === 'GET' && route === '/api/operations/:id') {
      return {
        operationId: opts.params.id,
        requestId: 'req-1',
        action: 'enable',
        installationId: 'inst-1',
        deviceIds: ['dev-1'],
        target: 'host',
        phase: 'applied',
        error: null,
      };
    }
    if (method === 'GET' && route === '/api/installations/:id/deployments') {
      return [
        {
          deviceId: 'dev-1',
          installationId: opts.params.id,
          operationId: 'op-1',
          planId: 'plan-1',
          desiredRevision: 2,
          appliedRevision: 2,
          actualVersion: '1.0.0',
          phase: 'applied',
          health: 'ready',
          error: null,
        },
      ];
    }
    throw new Error(`Unhandled ${method} ${route}`);
  });
  const handlers = createHandlers({ owner });

  const publishedWin = await handlers.center_list_client_releases({ platform: 'windows', publishedOnly: true }, BOT_ACTOR);
  assert.equal(publishedWin.releases.length, 1);
  assert.equal(publishedWin.releases[0].id, 'rel-1');

  const op = await handlers.center_get_operation({ operationId: 'op-1' }, BOT_ACTOR);
  assert.equal(op.phase, 'applied');

  const deployments = await handlers.center_list_installation_deployments({ installationId: 'inst-1' }, BOT_ACTOR);
  assert.equal(deployments.installationId, 'inst-1');
  assert.equal(deployments.deployments[0].health, 'ready');
});

test('integration with real openCenterStore enforces CAS, preserves hidden upstream config, and supports stars and model config', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-center-admin-ops-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(42) });
  let syncCalls = 0;
  const catalogStatus = { source: 'pi', syncedAt: '2026-11-20T00:00:00.000Z', error: null };

  try {
    store.putCredential('openai-api-key', { expectedRevision: null, value: 'sk-live-secret-token' });
    store.putProvider({
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-responses',
      baseUrl: 'https://private-openai-proxy.internal/v1',
      credentialRef: 'openai-api-key',
      enabled: true,
      native: true,
      configured: true,
      custom: { headers: { 'X-Proxy-Secret': 'proxy-secret-value' } },
    }, null);
    store.putModel('openai', {
      id: 'gpt-5',
      name: 'GPT-5',
      api: 'openai-responses',
      baseUrl: 'https://model-override.internal/v1',
      headers: { 'X-Model-Secret': 'model-secret-value' },
      contextWindow: 200000,
      maxTokens: 16384,
      input: ['text', 'image'],
      reasoning: true,
      enabled: true,
      source: 'manual',
    }, null);

    const owner = async (method, route, { params = {}, body, query = {} } = {}) => {
      if (method === 'GET' && route === '/api/providers') return store.listProviders();
      if (method === 'GET' && route === '/api/providers/:id') {
        const provider = store.getProvider(params.id);
        if (!provider) throw Object.assign(new Error('Provider not found'), { code: 'NOT_FOUND' });
        return provider;
      }
      if (method === 'PUT' && route === '/api/providers/:id') {
        return store.putProvider({ ...body.value, id: params.id }, body.expectedRevision);
      }
      if (method === 'GET' && route === '/api/providers/:id/models') {
        return store.listModels(params.id, { includeRemoved: query.includeRemoved === '1' });
      }
      if (method === 'POST' && route === '/api/providers/:id/models') {
        return store.putModel(params.id, { ...body, removed: false, revision: 0 }, null);
      }
      if (method === 'PUT' && route === '/api/providers/:id/models/:modelId') {
        return store.putModel(params.id, { ...body.value, id: params.modelId }, body.expectedRevision);
      }
      if (method === 'DELETE' && route === '/api/providers/:id/models/:modelId') {
        return store.deleteModel(params.id, params.modelId);
      }
      if (method === 'GET' && route === '/api/model-config') return store.getModelConfig();
      if (method === 'PUT' && route === '/api/model-config') {
        return store.putModelConfig(body.expectedRevision, body.value);
      }
      if (method === 'GET' && route === '/api/model-picker') {
        return { ...store.getModelPicker(), sync: catalogStatus };
      }
      if (method === 'GET' && route === '/api/model-catalog') return catalogStatus;
      if (method === 'POST' && route === '/api/model-catalog/sync') {
        syncCalls += 1;
        return { ...catalogStatus, modelsAdded: 0, modelsUpdated: 0 };
      }
      if (method === 'PUT' && route === '/api/model-stars') {
        return store.setModelStar(body.modelRef, body.starred);
      }
      throw new Error(`Unhandled ${method} ${route}`);
    };
    const handlers = createHandlers({ owner });

    const provider = await handlers.center_get_provider({ providerId: 'openai' }, BOT_ACTOR);
    assert.equal(provider.revision, 0);
    assert.equal(JSON.stringify(provider).includes('proxy-secret-value'), false);
    assert.equal(JSON.stringify(provider).includes('private-openai-proxy'), false);

    const updatedProvider = await handlers.center_update_provider(
      { providerId: 'openai', expectedRevision: 0, name: 'OpenAI Primary' },
      BOT_ACTOR,
    );
    assert.equal(updatedProvider.revision, 1);
    assert.equal(updatedProvider.name, 'OpenAI Primary');

    // Stale CAS revision fails and hidden upstream config remains intact in store.
    await assert.rejects(
      () => handlers.center_update_provider({ providerId: 'openai', expectedRevision: 0, enabled: false }, BOT_ACTOR),
      { code: 'REVISION_CONFLICT' },
    );
    const rawProvider = store.getProvider('openai');
    assert.equal(rawProvider.baseUrl, 'https://private-openai-proxy.internal/v1');
    assert.equal(rawProvider.credentialRef, 'openai-api-key');
    assert.equal(rawProvider.custom.headers['X-Proxy-Secret'], 'proxy-secret-value');

    // Model CAS update preserves hidden upstream baseUrl and headers.
    const updatedModel = await handlers.center_update_provider_model(
      { providerId: 'openai', modelId: 'gpt-5', expectedRevision: 0, maxTokens: 32768 },
      BOT_ACTOR,
    );
    assert.equal(updatedModel.revision, 1);
    assert.equal(updatedModel.maxTokens, 32768);
    assert.equal(JSON.stringify(updatedModel).includes('model-secret-value'), false);
    assert.equal(JSON.stringify(updatedModel).includes('model-override.internal'), false);
    const rawModel = store.listModels('openai').find((m) => m.id === 'gpt-5');
    assert.equal(rawModel.baseUrl, 'https://model-override.internal/v1');
    assert.equal(rawModel.headers['X-Model-Secret'], 'model-secret-value');

    await assert.rejects(
      () => handlers.center_update_provider_model(
        { providerId: 'openai', modelId: 'gpt-5', expectedRevision: 0, enabled: false },
        BOT_ACTOR,
      ),
      { code: 'REVISION_CONFLICT' },
    );

    // Default model CAS + stars + picker + catalog sync.
    const cfg0 = await handlers.center_get_model_config({}, BOT_ACTOR);
    assert.equal(cfg0.revision, 0);
    const cfg1 = await handlers.center_set_model_config(
      { expectedRevision: 0, value: { modelRef: 'openai/gpt-5', thinkingLevel: 'high' } },
      BOT_ACTOR,
    );
    assert.equal(cfg1.revision, 1);
    assert.equal(cfg1.global.modelRef, 'openai/gpt-5');
    await assert.rejects(
      () => handlers.center_set_model_config({ expectedRevision: 0, value: { modelRef: null } }, BOT_ACTOR),
      { code: 'REVISION_CONFLICT' },
    );

    const starred = await handlers.center_set_model_star({ modelRef: 'openai/gpt-5', starred: true }, BOT_ACTOR);
    assert.deepEqual(starred, { starredModels: ['openai/gpt-5'] });
    const picker = await handlers.center_get_model_picker({}, BOT_ACTOR);
    assert.equal(picker.defaultModel, 'openai/gpt-5');
    assert.deepEqual(picker.starredModels, ['openai/gpt-5']);
    assert.equal(picker.models.some((m) => m.modelRef === 'openai/gpt-5'), true);

    const catStatus = await handlers.center_get_model_catalog_status({}, BOT_ACTOR);
    assert.equal(catStatus.source, 'pi');
    const synced = await handlers.center_sync_model_catalog({}, BOT_ACTOR);
    assert.equal(syncCalls, 1);
    assert.equal(synced.modelsAdded, 0);

    // Deleting the model clears global default and stars.
    const deleted = await handlers.center_delete_provider_model({ providerId: 'openai', modelId: 'gpt-5' }, OAUTH_ACTOR);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.clearedGlobalModel, true);
    const pickerAfter = await handlers.center_get_model_picker({}, BOT_ACTOR);
    assert.deepEqual(pickerAfter.starredModels, []);
  } finally {
    store.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('production invokeOwnerAction + real openCenterStore: non-reusable routes use deps, real catalog/manual model contextWindow/maxTokens/safe fields stay editable', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-center-admin-real-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(55) });
  let catalogApplyCount = 0;
  let notifyAllCount = 0;

  try {
    store.putCredential('openai-api-key', { expectedRevision: null, value: 'sk-secret-key' });
    store.putProvider({
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: 'openai-api-key',
      enabled: true,
      native: true,
      configured: true,
      custom: { headers: { 'X-Internal': 'secret-hdr' } },
    }, null);

    // Seed a real catalog model that includes empty baseUrl (like native/antigravity models) plus hidden headers.
    store.putModel('openai', {
      id: 'gpt-5-catalog',
      name: 'GPT-5 Catalog',
      api: 'openai-responses',
      baseUrl: '',
      headers: { 'X-Model-Secret': 'keep-me-secret' },
      contextWindow: 128000,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoning: true,
      enabled: true,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      source: 'catalog',
    }, null);

    store.upsertDeviceBot('dev-1', { botId: 'bot-1', name: 'Alpha', isPrimary: true });
    store.createClientRelease({
      id: 'rel-win-1',
      platform: 'windows',
      arch: 'x64',
      format: 'nsis',
      version: '0.0.25',
      size: 1024,
      sha256: 'a'.repeat(64),
      notes: 'Release notes',
      sourceCommit: 'ae37e23',
      filename: 'pibot-0.0.25-win-x64.exe',
      published: true,
      publishedAt: '2026-11-20T00:00:00.000Z',
      createdAt: '2026-11-20T00:00:00.000Z',
    });

    // Register routes allowed by integration owner-actions.js; PUT model enforces routes.js minLength:1 for baseUrl/api.
    const routeCalls = [];
    const actions = new Map([
      ['GET /api/devices', () => [
        { deviceId: 'center-internal', name: 'Center', platform: 'linux', online: true },
        { deviceId: 'dev-1', name: 'Workstation', platform: 'linux', online: true, oauthAdminEnabled: true },
      ]],
      ['GET /api/providers', () => store.listProviders()],
      ['GET /api/providers/:id', (req) => {
        const provider = store.getProvider(req.params.id);
        if (!provider) throw Object.assign(new Error('Provider not found'), { code: 'NOT_FOUND' });
        return provider;
      }],
      ['GET /api/provider-auth-status', () => {
        routeCalls.push('GET /api/provider-auth-status');
        return {
          antigravity: {
            providerId: 'antigravity',
            method: 'oauth',
            oauth: true,
            apiKey: false,
            label: '登录 Antigravity',
            subscription: true,
          },
          openai: {
            providerId: 'openai',
            method: 'api_key',
            oauth: false,
            apiKey: true,
            label: 'OpenAI',
            subscription: false,
          },
        };
      }],
      ['GET /api/providers/:id/auth-status', (req) => {
        routeCalls.push(`GET /api/providers/${req.params.id}/auth-status`);
        if (req.params.id === 'antigravity') {
          return {
            providerId: 'antigravity',
            method: 'oauth',
            oauth: true,
            apiKey: false,
            label: '登录 Antigravity',
            subscription: true,
          };
        }
        return {
          providerId: req.params.id,
          method: 'api_key',
          oauth: false,
          apiKey: true,
          label: 'OpenAI',
          subscription: false,
        };
      }],
      ['POST /api/providers/:id/validate', (req) => {
        routeCalls.push(`POST /api/providers/${req.params.id}/validate`);
        if (req.params.id === 'antigravity') return { ok: true, message: 'gemini-2.5-pro' };
        return { ok: true, message: 'gpt-5-catalog' };
      }],
      ['POST /api/providers/:id/discover', (req) => {
        routeCalls.push(`POST /api/providers/${req.params.id}/discover`);
        return {
          models: [
            {
              id: req.params.id === 'antigravity' ? 'gemini-2.5-pro' : 'gpt-5-catalog',
              name: req.params.id === 'antigravity' ? 'Gemini 2.5 Pro' : 'GPT-5 Catalog',
              baseUrl: 'https://private-upstream.internal/v1',
              headers: { Authorization: 'Bearer upstream-secret' },
              contextWindow: 128000,
              maxTokens: 8192,
              input: ['text'],
              reasoning: true,
              enabled: true,
              revision: 0,
            },
          ],
        };
      }],
      ['GET /api/providers/:id/models', (req) => store.listModels(req.params.id, { includeRemoved: req.query?.includeRemoved === '1' })],
      ['PUT /api/providers/:id/models/:modelId', (req) => {
        const val = req.body.value;
        // Mirror routes.js modelSchema constraint: baseUrl/api, if present, must be non-empty strings.
        if ('baseUrl' in val && (typeof val.baseUrl !== 'string' || val.baseUrl.length < 1)) {
          throw Object.assign(new Error('Invalid input'), { code: 'VALIDATION_FAILED' });
        }
        if ('api' in val && (typeof val.api !== 'string' || val.api.length < 1)) {
          throw Object.assign(new Error('Invalid input'), { code: 'VALIDATION_FAILED' });
        }
        return store.putModel(req.params.id, { ...val, id: req.params.modelId }, req.body.expectedRevision);
      }],
    ]);

    const handlers = createHandlers({
      owner: (method, routePath, input) => invokeOwnerAction(actions, method, routePath, input),
      store,
      bridge: { deviceId: 'center-internal' },
      catalog: {
        async apply() { catalogApplyCount += 1; },
      },
      notifyAll() { notifyAllCount += 1; },
      publicUrl: 'https://center.example.com',
    });

    // Reject missing actor and reserved center-* devices.
    await assert.rejects(() => handlers.center_list_devices({}, null), { code: 'UNAUTHENTICATED' });
    await assert.rejects(
      () => handlers.center_rename_device({ deviceId: 'center-internal', name: 'Nope' }, OAUTH_ACTOR),
      { code: 'NOT_FOUND' },
    );

    const sync = await handlers.center_get_bot_sync({}, OAUTH_ACTOR);
    assert.equal(sync.mode, 'snapshot');
    assert.equal(sync.devices.length, 1);
    assert.equal(sync.devices[0].deviceId, 'dev-1');
    assert.equal(sync.bots.length, 1);

    // auth-status, validate, and discover reuse owner callbacks directly (including Antigravity).
    const auth = await handlers.center_get_provider_auth_status({ providerId: 'openai' }, OAUTH_ACTOR);
    assert.equal(auth.statuses[0].method, 'api_key');
    const agyAuth = await handlers.center_get_provider_auth_status({ providerId: 'antigravity' }, OAUTH_ACTOR);
    assert.equal(agyAuth.statuses[0].method, 'oauth');
    const allAuth = await handlers.center_get_provider_auth_status({}, OAUTH_ACTOR);
    assert.equal(allAuth.statuses.find((item) => item.providerId === 'antigravity')?.method, 'oauth');
    const agyValidated = await handlers.center_validate_provider({ providerId: 'antigravity' }, OAUTH_ACTOR);
    assert.deepEqual(agyValidated, { ok: true, message: 'gemini-2.5-pro' });
    const agyDiscovered = await handlers.center_discover_provider_models({ providerId: 'antigravity' }, OAUTH_ACTOR);
    assert.equal(agyDiscovered.models[0].id, 'gemini-2.5-pro');
    assert.equal(JSON.stringify(agyDiscovered).includes('upstream-secret'), false);
    assert.equal(JSON.stringify(agyDiscovered).includes('private-upstream.internal'), false);
    assert.deepEqual(routeCalls, [
      'GET /api/providers/openai/auth-status',
      'GET /api/providers/antigravity/auth-status',
      'GET /api/provider-auth-status',
      'POST /api/providers/antigravity/validate',
      'POST /api/providers/antigravity/discover',
    ]);

    const updatedProv = await handlers.center_update_provider(
      { providerId: 'openai', expectedRevision: 0, name: 'OpenAI Prod' },
      OAUTH_ACTOR,
    );
    assert.equal(updatedProv.name, 'OpenAI Prod');
    assert.equal(updatedProv.revision, 1);
    assert.equal(catalogApplyCount, 1);
    assert.equal(notifyAllCount, 1);
    assert.equal(store.getProvider('openai').custom.headers['X-Internal'], 'secret-hdr');

    const batch = await handlers.center_batch_create_provider_models(
      {
        providerId: 'openai',
        models: [
          { id: 'batch-1', name: 'Batch 1', contextWindow: 64000, maxTokens: 4096, input: ['text'], reasoning: false },
        ],
      },
      OAUTH_ACTOR,
    );
    assert.equal(batch.models.length, 1);
    assert.equal(batch.models[0].id, 'batch-1');

    const releases = await handlers.center_list_client_releases({ publishedOnly: true }, OAUTH_ACTOR);
    assert.equal(releases.releases.length, 1);
    assert.equal(releases.releases[0].downloadUrl, 'https://center.example.com/api/client-releases/rel-win-1/download');

    // Existing catalog model with empty baseUrl can update contextWindow, maxTokens, and safe fields cleanly.
    const updatedCatalogModel = await handlers.center_update_provider_model(
      {
        providerId: 'openai',
        modelId: 'gpt-5-catalog',
        expectedRevision: 0,
        contextWindow: 256000,
        maxTokens: 32768,
        name: 'GPT-5 Catalog Tuned',
        input: ['text', 'image'],
        reasoning: true,
        compat: { supportsDeveloperRole: true, maxTokensField: 'max_completion_tokens' },
        samplingParams: { temperature: 0.3 },
        thinkingLevelMap: { high: 'high' },
      },
      OAUTH_ACTOR,
    );
    assert.equal(updatedCatalogModel.revision, 1);
    assert.equal(updatedCatalogModel.contextWindow, 256000);
    assert.equal(updatedCatalogModel.maxTokens, 32768);
    assert.equal(updatedCatalogModel.name, 'GPT-5 Catalog Tuned');
    assert.deepEqual(updatedCatalogModel.compat, { supportsDeveloperRole: true, maxTokensField: 'max_completion_tokens' });
    assert.deepEqual(updatedCatalogModel.samplingParams, { temperature: 0.3 });
    assert.equal('headers' in updatedCatalogModel, false);
    assert.equal('baseUrl' in updatedCatalogModel, false);
    const persisted = store.listModels('openai').find((m) => m.id === 'gpt-5-catalog');
    assert.equal(persisted.headers['X-Model-Secret'], 'keep-me-secret');
    assert.equal(persisted.api, 'openai-responses');

    // maxTokens > contextWindow and prototype pollution keys are rejected.
    await assert.rejects(
      () => handlers.center_update_provider_model(
        { providerId: 'openai', modelId: 'gpt-5-catalog', expectedRevision: 1, maxTokens: 300000 },
        OAUTH_ACTOR,
      ),
      { code: 'INVALID_ARGUMENT' },
    );
    await assert.rejects(
      () => handlers.center_update_provider_model(
        {
          providerId: 'openai',
          modelId: 'gpt-5-catalog',
          expectedRevision: 1,
          compat: JSON.parse('{"__proto__":{"polluted":true}}'),
        },
        OAUTH_ACTOR,
      ),
      { code: 'INVALID_ARGUMENT' },
    );
  } finally {
    store.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
