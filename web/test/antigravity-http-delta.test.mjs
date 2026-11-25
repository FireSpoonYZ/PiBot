import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { registerAntigravityRoutes } from '../../center-server/antigravity-routes.js';
import { createAntigravityHistoryTransport } from '../../host-core/antigravity-delta.js';
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_STREAM_PATH } from '../../center-contract/antigravity.js';

const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const modelId = 'gemini-test';
const modelRef = ANTIGRAVITY_PROVIDER_ID + '/' + modelId;

test('AGY HTTP accepts a delta over 32 MiB and more than 4096 entries', { timeout: 30000 }, async (t) => {
  const app = Fastify({ logger: false });
  const received = [];
  const routes = registerAntigravityRoutes({
    store: {
      getProvider: () => ({ id: ANTIGRAVITY_PROVIDER_ID, enabled: true }),
      listDeviceBots: () => [{ botId: 'bot-a' }],
      getBotModelConfig: () => ({ effective: { modelRef } }),
      listModels: () => [{ id: modelId, enabled: true }],
    },
    bridge: { registry: { authenticate: () => true } },
    catalog: { apply: async () => {} },
    host(method, url, handler, bodyLimit) {
      app.route({ method, url, ...(bodyLimit === undefined ? {} : { bodyLimit }),
        handler(req, reply) {
          req.centerDevice = { deviceId: 'fixture-device', token: 'fixture-token' };
          return handler(req, reply);
        },
      });
    },
    antigravity: {
      async *stream(params) {
        received.push({ count: params.delta.messages.length,
          bytes: Buffer.byteLength(params.delta.messages[0].content) });
        yield { type: 'done', reason: 'stop', message: {
          role: 'assistant', content: [{ type: 'text', text: 'ok' }],
          provider: ANTIGRAVITY_PROVIDER_ID, api: ANTIGRAVITY_API, model: modelId,
          stopReason: 'stop', timestamp: 1,
        } };
      },
      cancel: async () => {},
    },
    changed: (value) => value,
  });
  t.after(async () => { await routes.close(); await app.close(); });
  const host = createAntigravityHistoryTransport();
  const messages = [{ role: 'system', content: 'stable', toolsAdded: [] },
    { role: 'user', content: 'x'.repeat(33 * 1024 * 1024) },
    ...Array.from({ length: 4100 }, (_, i) => ({ role: 'user', content: 'queued-' + i }))];
  const { payload } = host.prepare({ sessionId: 'large', modelId, messages });
  const response = await app.inject({
    method: 'POST', url: ANTIGRAVITY_STREAM_PATH, payload,
  });
  assert.equal(response.statusCode, 200, response.body.slice(0, 500));
  assert.equal(received.length, 1);
  assert.equal(received[0].count, 4101);
  assert.ok(received[0].bytes > 32 * 1024 * 1024);
  assert.ok(response.body.includes('"done"'));
});
