import test from 'node:test';
import assert from 'node:assert/strict';
const { builtinProviders } = await import(new URL('../../host-core/node_modules/@earendil-works/pi-ai/dist/providers/all.js', import.meta.url));
import { nativeCenterProvider } from '../../host-core/native-center-providers.js';
import { centerPiCredentialStore } from '../../center-server/model-catalog.js';

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
