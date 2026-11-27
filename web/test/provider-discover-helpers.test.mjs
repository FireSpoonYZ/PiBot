import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BATCH_SAVE_CHUNK_SIZE,
  areAllVisibleSelected,
  buildDiscoverRequest,
  chunkModelsForBatchSave,
  deselectVisibleModelIds,
  saveModelsInChunks,
  selectVisibleModelIds,
} from '../src/center-admin/providerDiscoverHelpers.ts';

test('buildDiscoverRequest passes unsaved form overrides and honors customJson precedence', () => {
  // Native provider with blank baseUrl omits baseUrl so server keeps built-in default.
  assert.deepEqual(
    buildDiscoverRequest(
      { baseUrl: '   ', api: 'openai-responses' },
      { deviceId: '', apiKey: '  sk-test  ', customJson: '{}' },
    ),
    {
      apiKey: 'sk-test',
      api: 'openai-responses',
    },
  );

  // Custom provider draft baseUrl / api / deviceId are forwarded directly.
  assert.deepEqual(
    buildDiscoverRequest(
      { baseUrl: 'https://proxy.example/v1 ', api: 'openai-completions' },
      { deviceId: 'dev-1', apiKey: '', customJson: '{}' },
    ),
    {
      deviceId: 'dev-1',
      baseUrl: 'https://proxy.example/v1',
      api: 'openai-completions',
    },
  );

  // customJson baseUrl, api, and headers take precedence over base form fields.
  assert.deepEqual(
    buildDiscoverRequest(
      { baseUrl: 'https://form.example/v1', api: 'openai-completions' },
      {
        customJson: JSON.stringify({
          baseUrl: 'https://override.example/v1',
          api: 'anthropic-messages',
          headers: { 'x-tenant': 'acme' },
        }),
      },
    ),
    {
      baseUrl: 'https://override.example/v1',
      api: 'anthropic-messages',
      headers: { 'x-tenant': 'acme' },
    },
  );

  // Malformed customJson falls back safely without throwing.
  assert.deepEqual(
    buildDiscoverRequest(
      { baseUrl: 'https://fallback.example/v1', api: 'openai-completions' },
      { customJson: '{not valid json' },
    ),
    {
      baseUrl: 'https://fallback.example/v1',
      api: 'openai-completions',
    },
  );
});

test('chunkModelsForBatchSave splits large model lists within backend 200-item limit', () => {
  assert.equal(BATCH_SAVE_CHUNK_SIZE, 200);
  assert.deepEqual(chunkModelsForBatchSave([]), []);

  const items = Array.from({ length: 450 }, (_, idx) => ({ id: `m-${idx}` }));
  const chunks = chunkModelsForBatchSave(items);
  assert.deepEqual(
    chunks.map(chunk => chunk.length),
    [200, 200, 50],
  );
  assert.equal(chunks[0][0].id, 'm-0');
  assert.equal(chunks[2][49].id, 'm-449');
});

test('saveModelsInChunks saves all chunks sequentially and reports partial progress on failure', async () => {
  const models = Array.from({ length: 5 }, (_, idx) => ({ id: `model-${idx}` }));
  const calls = [];
  const ok = await saveModelsInChunks(
    models,
    async batch => {
      calls.push(batch.map(m => m.id));
    },
    2,
  );
  assert.equal(ok.failedError, undefined);
  assert.deepEqual(ok.savedIds, ['model-0', 'model-1', 'model-2', 'model-3', 'model-4']);
  assert.deepEqual(calls, [['model-0', 'model-1'], ['model-2', 'model-3'], ['model-4']]);

  const boom = new Error('boom on second chunk');
  const partialCalls = [];
  const failed = await saveModelsInChunks(
    models,
    async batch => {
      partialCalls.push(batch.map(m => m.id));
      if (partialCalls.length === 2) throw boom;
    },
    2,
  );
  assert.equal(failed.failedError, boom);
  assert.deepEqual(failed.savedIds, ['model-0', 'model-1']);
  assert.equal(partialCalls.length, 2);
});

test('visible model selection helpers handle filtered select/deselect cleanly', () => {
  const initial = new Set(['a', 'b', 'c']);
  assert.equal(areAllVisibleSelected(initial, ['a', 'b']), true);
  assert.equal(areAllVisibleSelected(initial, ['a', 'd']), false);
  assert.equal(areAllVisibleSelected(initial, []), false);

  const afterDeselect = deselectVisibleModelIds(initial, ['a', 'b']);
  assert.deepEqual([...afterDeselect], ['c']);
  // Original set is never mutated.
  assert.deepEqual([...initial], ['a', 'b', 'c']);

  const afterSelect = selectVisibleModelIds(afterDeselect, ['a', 'd']);
  assert.deepEqual([...afterSelect].sort(), ['a', 'c', 'd']);
});
