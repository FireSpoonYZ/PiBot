import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { builtinProviders } = await import(new URL('../../host-core/node_modules/@earendil-works/pi-ai/dist/providers/all.js', import.meta.url));
import { nativeCenterProvider } from '../../host-core/native-center-providers.js';
import { applyCenterModels } from '../../host-core/runtime-models.js';
import { centerPiCredentialStore, openModelCatalog } from '../../center-server/model-catalog.js';
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
