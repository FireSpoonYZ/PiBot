import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { builtinProviders } = await import(new URL('../../host-core/node_modules/@earendil-works/pi-ai/dist/providers/all.js', import.meta.url));
import { nativeCenterProvider } from '../../host-core/native-center-providers.js';
import { applyCenterModels, discoverCenterProviderModels } from '../../host-core/runtime-models.js';
import { setupPiHttpRuntime } from '../../center-server/http-dispatcher.js';
import { centerPiCredentialStore, openModelCatalog } from '../../center-server/model-catalog.js';
import { openProviderAuth } from '../../center-server/provider-auth.js';
import { openCenterStore } from '../../center-server/data/index.js';

function catalogProvider(id) {
  const provider = builtinProviders().find(entry => entry.id === id);
  assert.ok(provider, 'Pi built-in provider must exist: ' + id);
  return provider;
}

test('native Center registry keeps Pi provider-specific API and model metadata', async () => {
  const native = catalogProvider('openai-codex');
  const sample = native.getModels()[0];
  assert.ok(sample);
  const registry = nativeCenterProvider(
    { id: native.id, name: native.name, baseUrl: native.baseUrl, api: sample.api },
    [sample], undefined,
    async id => {
      assert.equal(id, 'openai-codex');
      return { auth: { apiKey: 'short-lived-token' }, source: 'center' };
    },
  );
  assert.equal(registry.getModels()[0].api, sample.api);
  assert.equal(registry.getModels()[0].contextWindow, sample.contextWindow);
  const result = await registry.auth.apiKey.resolve({ signal: AbortSignal.timeout(1000) });
  assert.equal(result.auth.apiKey, 'short-lived-token');
  assert.equal(typeof registry.stream, 'function');
});

test('native OpenRouter retains model-level protocols and selective overrides', () => {
  const native = catalogProvider('openrouter');
  const entries = native.getModels();
  assert.ok(entries.length > 1);
  const first = entries[0], second = entries.find(m => m.api !== first.api) ?? entries[1];
  const registry = nativeCenterProvider({
    id: native.id, name: native.name, baseUrl: native.baseUrl,
    headers: { 'X-PiBot-Test': 'header' },
  }, [
    { ...first, maxTokens: Math.min(500, first.maxTokens), headers: { 'X-Model': 'model' } },
    second,
  ], 'test-key');
  assert.equal(registry.getModels()[0].api, first.api);
  assert.equal(registry.getModels()[1].api, second.api);
  assert.equal(registry.getModels()[0].maxTokens, Math.min(500, first.maxTokens));
  assert.equal(registry.getModels()[0].headers['X-PiBot-Test'], 'header');
  assert.equal(registry.getModels()[0].headers['X-Model'], 'model');
});

test('custom provider supports model-specific protocol, endpoint, request configuration', async () => {
  const p = nativeCenterProvider({
    id: 'local-compatible', name: 'Local AI', baseUrl: 'http://localhost:1234/v1',
    api: 'openai-completions',
  }, [
    { id: 'local', name: 'Local', api: 'openai-completions', baseUrl: 'http://localhost:1235/v1',
      contextWindow: 32768, maxTokens: 2048, input: ['text'], reasoning: false,
      samplingParams: { temperature: 0.2 } },
  ], 'test-key');
  assert.equal(p.getModels()[0].baseUrl, 'http://localhost:1235/v1');
  assert.equal(p.getModels()[0].samplingParams.temperature, 0.2);
  assert.equal((await p.auth.apiKey.resolve()).auth.apiKey, 'test-key');
});

test('Center Pi CredentialStore serializes token rotation and never enumerates secrets', async () => {
  const secrets = new Map();
  const providers = [{ id: 'openai-codex', credentialRef: 'openai-codex-api-key' }];
  const backend = {
    listProviders: () => providers,
    getProvider: id => providers.find(p => p.id === id),
    getCredential: id => secrets.has(id) ? { configured: true, revision: secrets.get(id).revision } : null,
    resolveCredential: id => secrets.get(id).value,
    putCredential(id, { expectedRevision, value }) {
      const current = secrets.get(id);
      assert.equal(expectedRevision, current?.revision ?? null);
      secrets.set(id, { value, revision: (current?.revision ?? -1) + 1 });
    },
    deleteCredential(id, revision) {
      assert.equal(revision, secrets.get(id).revision);
      secrets.delete(id);
    },
  };
  const store = centerPiCredentialStore(backend);
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }));
  const outputs = await Promise.all([
    store.modify('openai-codex', async old => ({ ...old, access: old.access + 'b' })),
    store.modify('openai-codex', async old => ({ ...old, access: old.access + 'c' })),
  ]);
  assert.equal(outputs[1].access, 'abc');
  assert.deepEqual(await store.list(), [{ providerId: 'openai-codex', type: 'oauth' }]);
  assert.equal(JSON.stringify(await store.list()).includes('refresh'), false);
  await store.delete('openai-codex');
  assert.equal(await store.read('openai-codex'), undefined);
});

test('migration updates untouched legacy models while retaining manual edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-migration-test-'));
  const store = openCenterStore({ dataRoot: root, encryptionKey: Buffer.alloc(32, 76) });
  let catalog;
  try {
    const native = catalogProvider('openai');
    const firstTwo = native.getModels().slice(0, 2);
    assert.equal(firstTwo.length, 2);
    store.putProvider({
      id: 'openai', name: native.name, api: firstTwo[0].api,
      baseUrl: native.baseUrl, credentialRef: 'openai-api-key', enabled: false,
    }, null);
    const previousFields = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning',
      'thinkingLevelMap', 'cost', 'compat', 'inputLimits'];
    for (const [index, model] of firstTwo.entries()) {
      const previous = Object.fromEntries(previousFields.filter(key => model[key] !== undefined)
        .map(key => [key, model[key]]));
      if (index === 1) previous.contextWindow += 1; // Owner-edited legacy metadata
      store.putModel('openai', { ...previous, enabled: true }, null);
    }
    catalog = openModelCatalog({ store, dataRoot: root, onChange: () => {} });
    await catalog.ready;
    const untouched = store.listModels('openai').find(model => model.id === firstTwo[0].id);
    const modified = store.listModels('openai').find(model => model.id === firstTwo[1].id);
    assert.equal(untouched.source, 'catalog');
    assert.equal(modified.source, 'manual');
    assert.equal(modified.contextWindow, firstTwo[1].contextWindow + 1);
  } finally {
    await catalog?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('device snapshots and applyCenterModels handle catalog source metadata and disabled providers cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-snapshot-models-test-'));
  const store = openCenterStore({ dataRoot: root, encryptionKey: Buffer.alloc(32, 77) });
  let catalog;
  try {
    catalog = openModelCatalog({ store, dataRoot: root, onChange: () => {} });
    await catalog.ready;

    const openai = store.getProvider('openai');
    assert.ok(openai);
    store.putCredential('openai-api-key', { expectedRevision: null, value: 'sk-test-secret' });
    store.putProvider({ ...openai, enabled: true }, openai.revision);

    const enabledModels = store.listModels('openai').filter(m => m.enabled);
    assert.ok(enabledModels.length > 0);
    assert.equal(enabledModels[0].source, 'catalog');

    store.replaceDeviceBots('dev-1', [{
      deviceId: 'dev-1',
      botId: 'bot-1',
      name: 'Assistant',
      isPrimary: true,
    }]);
    store.putBotModelConfig('dev-1', 'bot-1', 0, {
      modelRef: `openai/${enabledModels[0].id}`,
      thinkingLevel: null,
      codemode: null,
      codemodeOnly: null,
    });

    const snapshot = store.getDeviceSnapshot('dev-1', 'wss://example.com/v1/link');
    assert.ok(snapshot.models.openai.length > 0);
    for (const model of snapshot.models.openai) {
      assert.equal('source' in model, false, 'snapshot models must omit Center-only source field');
    }
    const disabledProvider = snapshot.providers.find(p => !p.enabled);
    assert.ok(disabledProvider);
    assert.deepEqual(snapshot.models[disabledProvider.id], []);

    const turnContext = store.getBotTurnContext('dev-1', 'bot-1');
    for (const model of turnContext.models.openai) {
      assert.equal('source' in model, false, 'turn context models must omit Center-only source field');
    }

    // Apply clean snapshot on Host side
    const appliedClean = applyCenterModels(snapshot);
    assert.ok(appliedClean.models.getModel('openai', enabledModels[0].id));
    assert.equal(appliedClean.botModels['bot-1'].modelRef, `openai/${enabledModels[0].id}`);

    // Host side also tolerates snapshots from older Center builds that still carry `source`
    const legacySnapshot = {
      ...snapshot,
      models: {
        ...snapshot.models,
        openai: snapshot.models.openai.map(m => ({ ...m, source: 'catalog' })),
      },
    };
    const appliedLegacy = applyCenterModels(legacySnapshot);
    assert.ok(appliedLegacy.models.getModel('openai', enabledModels[0].id));

    // Persisted turn_sets sanitize `source` on save/read
    const savedSet = store.putTurnSet({
      setId: 'set-legacy-test',
      deviceId: 'dev-1',
      botId: 'bot-1',
      fingerprint: 'fp-1',
      snapshot: legacySnapshot,
      plans: [],
      refs: ['openai-api-key'],
      credentialRevisions: { 'openai-api-key': 0 },
    });
    assert.equal('source' in savedSet.snapshot.models.openai[0], false);
    assert.equal('source' in store.getTurnSet('set-legacy-test').snapshot.models.openai[0], false);

    // Enabled capability validation in snapshots & runtime receipts reuses cached compiled schemas
    store.putPackageVersion({
      packageId: 'e-launcher.test-plugin',
      version: '1.0.0',
      kind: 'plugin',
      manifest: {},
      configSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', default: 'https://api.example.com' },
          apiKey: { type: 'string', format: 'credential-ref' },
        },
        additionalProperties: false,
      },
    });
    store.putInstallation({
      installationId: 'inst-1',
      packageId: 'e-launcher.test-plugin',
      displayName: 'Test Plugin',
      kind: 'plugin',
      source: { type: 'artifact', artifactRef: 'art-1' },
      target: 'host',
      targetVersion: '1.0.0',
      enabled: true,
      activation: { status: 'enabled', error: null, updatedAt: new Date().toISOString() },
    }, null);
    store.putBotCapability('dev-1', 'bot-1', 'inst-1', {
      expectedRevision: 0,
      enabled: true,
      overrides: { apiKey: 'openai-api-key' },
    });

    for (let i = 0; i < 200; i += 1) {
      const snap = store.getDeviceSnapshot('dev-1', 'wss://example.com/v1/link');
      store.putRuntimeReceipt({
        deviceId: 'dev-1',
        revision: snap.revision,
        status: 'applied',
        appliedRevision: snap.revision,
        error: null,
        bots: [{ botId: 'bot-1', desiredRevision: snap.revision, appliedRevision: snap.revision, status: 'applied', error: null }],
        capabilityErrors: [],
      });
    }
    const status = store.getDeviceRuntimeStatus('dev-1', true);
    assert.equal(status.status, 'applied');
  } finally {
    await catalog?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFlowCondition(providerAuth, providerId, flowId, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = providerAuth.status(providerId, flowId);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for OAuth flow state: ${JSON.stringify(last)}`);
}

test('ChatGPT and OpenAI Codex OAuth flows match Pi Agent contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-oauth-parity-test-'));
  const store = openCenterStore({ dataRoot: root, encryptionKey: Buffer.alloc(32, 81) });
  let catalog;
  let providerAuth;
  try {
    setupPiHttpRuntime();
    assert.equal(process.env.AI_AGENT, 'pi');
    assert.equal(process.env.PI_CODING_AGENT, 'true');

    catalog = openModelCatalog({ store, dataRoot: root, onChange: () => {} });
    await catalog.ready;
    providerAuth = openProviderAuth({ store, catalog, onChange: () => {} });

    // OAuth-only provider openai-codex must not receive a bogus API-key credentialRef
    const codexStored = store.getProvider('openai-codex');
    assert.equal(codexStored.credentialRef, null);
    const codexDesc = await providerAuth.describe('openai-codex');
    assert.equal(codexDesc.oauth, true);
    assert.equal(codexDesc.apiKey, false);

    // 1. OpenAI Codex: select -> browser -> auth_url uses originator=pi (not custom agentName)
    const { flowId: codexFlowId } = await providerAuth.start('openai-codex');
    const codexSelect = await waitForFlowCondition(
      providerAuth,
      'openai-codex',
      codexFlowId,
      s => s.prompt?.type === 'select',
    );
    assert.deepEqual(
      codexSelect.prompt.options.map(o => o.id),
      ['browser', 'device_code'],
    );
    providerAuth.answer('openai-codex', codexFlowId, 'browser');
    const codexBrowser = await waitForFlowCondition(
      providerAuth,
      'openai-codex',
      codexFlowId,
      s => s.events.some(e => e.type === 'auth_url') && s.prompt?.type === 'manual_code',
    );
    const codexUrl = new URL(codexBrowser.events.find(e => e.type === 'auth_url').url);
    assert.equal(codexUrl.origin, 'https://auth.openai.com');
    assert.equal(codexUrl.searchParams.get('originator'), 'pi');
    assert.equal(codexUrl.searchParams.get('codex_cli_simplified_flow'), 'true');
    assert.equal(codexUrl.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');

    // Invalid URL without ?code= rejects non-destructively while keeping flow pending
    assert.throws(
      () => providerAuth.answer('openai-codex', codexFlowId, 'http://localhost:1455/auth/callback'),
      err => err?.code === 'INVALID_ARGUMENT',
    );
    assert.equal(providerAuth.status('openai-codex', codexFlowId).status, 'pending');
    providerAuth.cancel('openai-codex', codexFlowId);

    // 2. OpenAI ("Sign in with ChatGPT"): receives valid installation UUID via getDeviceId()
    const installationUuid = store.getInstallationId();
    assert.match(installationUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const { flowId: chatgptFlowId } = await providerAuth.start('openai');
    const chatgptReady = await waitForFlowCondition(
      providerAuth,
      'openai',
      chatgptFlowId,
      s => s.status === 'failed' || (s.events.some(e => e.type === 'auth_url') && s.prompt?.type === 'manual_code'),
    );
    // If port 1455 happens to be held on the host machine by another process, skip port-dependent assertion gracefully
    if (chatgptReady.status !== 'failed') {
      const chatgptUrl = new URL(chatgptReady.events.find(e => e.type === 'auth_url').url);
      assert.equal(chatgptUrl.searchParams.get('ext_agent_host_id'), `urn:uuid:${installationUuid.toLowerCase()}`);
      assert.equal(chatgptUrl.searchParams.get('agent_name_hint'), 'Pi');
      assert.throws(
        () => providerAuth.answer('openai', chatgptFlowId, 'not-a-url'),
        err => err?.code === 'INVALID_ARGUMENT',
      );
      assert.equal(providerAuth.status('openai', chatgptFlowId).status, 'pending');
      providerAuth.cancel('openai', chatgptFlowId);
    }
  } finally {
    providerAuth?.close();
    await catalog?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCenterProviderModels fetches /v1/models directly without a Host device', async () => {
  setupPiHttpRuntime();
  let seenAuth = '';
  let seenCustom = '';
  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') {
      seenAuth = req.headers.authorization ?? '';
      seenCustom = req.headers['x-custom-test'] ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'qwen3-coder-30b', context_window: 131072, max_output_tokens: 16384 },
          { id: 'deepseek-r1-distill', context_length: 65536 },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-large-v3' },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = upstream.address();
    const result = await discoverCenterProviderModels({
      provider: {
        id: 'local-openai',
        name: 'Local OpenAI',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        headers: { 'X-Custom-Test': 'ok' },
      },
      models: [],
      credential: 'sk-local-test',
    });
    assert.equal(seenAuth, 'Bearer sk-local-test');
    assert.equal(seenCustom, 'ok');
    assert.deepEqual(
      result.models.map(m => m.id),
      ['deepseek-r1-distill', 'qwen3-coder-30b'],
    );
    const r1 = result.models.find(m => m.id === 'deepseek-r1-distill');
    assert.equal(r1.reasoning, true);
    assert.equal(r1.contextWindow, 65536);
    const qwen = result.models.find(m => m.id === 'qwen3-coder-30b');
    assert.equal(qwen.contextWindow, 131072);
    assert.equal(qwen.maxTokens, 16384);
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('deleteProvider and deleteModel wipe credentials, clean modelRefs, and persist catalog removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-delete-provider-model-test-'));
  const store = openCenterStore({ dataRoot: root, encryptionKey: Buffer.alloc(32, 82) });
  let catalog;
  try {
    catalog = openModelCatalog({ store, dataRoot: root, onChange: () => {} });
    await catalog.ready;

    // 1. Custom provider creation + deletion cleans credentials & active modelRef
    const custom = store.putProvider({
      id: 'my-ollama',
      name: 'My Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      credentialRef: 'my-ollama-api-key',
      enabled: true,
      configured: true,
    }, null);
    assert.equal(custom.configured, true);
    store.putCredential('my-ollama-api-key', { expectedRevision: null, value: 'ollama-secret' });
    store.putModelsBatch('my-ollama', [
      { id: 'llama3.3', name: 'Llama 3.3', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false, enabled: true },
    ]);
    store.setModelStar('my-ollama/llama3.3', true);
    store.putModelConfig(0, { modelRef: 'my-ollama/llama3.3', thinkingLevel: 'medium' });

    const delCustom = store.deleteProvider('my-ollama', null);
    assert.equal(delCustom.reset, false);
    assert.equal(store.getProvider('my-ollama'), null);
    assert.equal(store.getCredential('my-ollama-api-key')?.configured, false);
    assert.throws(() => store.resolveCredential('my-ollama-api-key'));
    assert.equal(store.getModelConfig().global.modelRef, undefined);
    assert.equal(store.getModelConfig().global.thinkingLevel, 'medium');
    assert.deepEqual(store.listModelStars(), []);

    // 2. Catalog model deletion marks removed=true and survives catalog.apply() without reappearing
    const openai = store.getProvider('openai');
    store.putCredential('openai-api-key', { expectedRevision: null, value: 'sk-openai-test' });
    store.putProvider({ ...openai, enabled: true, configured: true }, openai.revision);
    const catalogModels = store.listModels('openai');
    assert.ok(catalogModels.length >= 2);
    const victim = catalogModels[0];
    store.putModelConfig(store.getModelConfig().revision, { modelRef: `openai/${victim.id}`, thinkingLevel: 'high' });

    const delModel = store.deleteModel('openai', victim.id);
    assert.equal(delModel.hiddenFromCatalog, true);
    assert.equal(store.listModels('openai').some(m => m.id === victim.id), false);
    assert.equal(store.getModelConfig().global.modelRef, undefined);

    await catalog.apply();
    assert.equal(store.listModels('openai').some(m => m.id === victim.id), false);
    const withRemoved = store.listModels('openai', { includeRemoved: true }).find(m => m.id === victim.id);
    assert.equal(withRemoved?.removed, true);
    assert.equal(withRemoved?.enabled, false);

    // Re-adding via batch restores the catalog model cleanly
    store.putModelsBatch('openai', [{ ...withRemoved, enabled: true, removed: false }]);
    assert.equal(store.listModels('openai').some(m => m.id === victim.id), true);

    // 3. Native provider deletion wipes OAuth + API Key credentials and resets configured=false
    store.putCredential('center-internal-pi-oauth-openai', {
      expectedRevision: null,
      value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60_000 }),
    });
    const resetSpec = catalog.bundledResetSpec('openai');
    const delNative = store.deleteProvider('openai', resetSpec);
    assert.equal(delNative.reset, true);
    assert.equal(store.getCredential('openai-api-key')?.configured, false);
    assert.throws(() => store.resolveCredential('openai-api-key'));
    assert.equal(store.getCredential('center-internal-pi-oauth-openai')?.configured, false);
    assert.throws(() => store.resolveCredential('center-internal-pi-oauth-openai'));
    const resetOpenai = store.getProvider('openai');
    assert.equal(resetOpenai.enabled, false);
    assert.equal(resetOpenai.configured, false);
  } finally {
    await catalog?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
