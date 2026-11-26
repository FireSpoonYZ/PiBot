import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  ANTIGRAVITY_CANCEL_PATH,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_RUN_PATH,
  ANTIGRAVITY_STEER_PATH,
  ANTIGRAVITY_TOOL_RESULT_PATH,
} from '../../center-contract/antigravity.js';
import { registerAntigravityRoutes } from '../../center-server/antigravity-routes.js';
import { errorStatus } from '../../center-server/server.js';

const requireCenter = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = requireCenter('fastify');

const DEVICE_ID = 'http-run-device';
const DEVICE_TOKEN = 'http-run-test-token-'.repeat(3);
const MODEL_ID = 'gemini-4-hydrogen';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=';

async function openHttpFixture(t, {
  providerEnabled = true,
  assignedModelRef = `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}`,
  models = [{ id: MODEL_ID, enabled: true }],
  antigravity = {},
} = {}) {
  // Mirror server.js 1 MiB default bodyLimit so route-level >32 MiB overrides are genuinely verified.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  app.decorateRequest('centerDevice', null);
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}` || req.headers['x-device-id'] !== DEVICE_ID) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid test device' } });
    }
    req.centerDevice = { deviceId: DEVICE_ID, token: DEVICE_TOKEN };
  });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (error.statusCode === 413) code = 'PAYLOAD_TOO_LARGE';
    else if (error.statusCode === 400 && !Object.hasOwn(errorStatus, code)) code = 'INVALID_ARGUMENT';
    if (!Object.hasOwn(errorStatus, code)) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({ error: { code, message: error.message } });
  });

  const state = { providerEnabled, assignedModelRef, models };
  const routes = registerAntigravityRoutes({
    store: {
      getProvider: (id) => (id === ANTIGRAVITY_PROVIDER_ID ? { id, enabled: state.providerEnabled } : null),
      listDeviceBots: () => (state.assignedModelRef ? [{ botId: 'bot-1' }] : []),
      getBotModelConfig: () => ({ effective: { modelRef: state.assignedModelRef } }),
      listModels: () => state.models,
    },
    bridge: { registry: { authenticate: () => true } },
    catalog: { apply: async () => {} },
    changed: (value) => value,
    antigravity,
    host(method, url, handler, bodyLimit) {
      app.route({
        method,
        url,
        ...(bodyLimit !== undefined ? { bodyLimit } : {}),
        handler,
      });
    },
  });

  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    routes.close();
    await app.close();
  });

  const postRaw = (url, body) =>
    fetch(new URL(url, baseUrl), {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEVICE_TOKEN}`,
        'X-Device-Id': DEVICE_ID,
      },
      body: JSON.stringify(body),
    });

  const postJson = async (url, body) => {
    const res = await postRaw(url, body);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };

  return { baseUrl, state, postRaw, postJson };
}

test('POST /api/host/antigravity/run accepts >32MiB payload and streams NDJSON text_delta + turn_done', { timeout: 30_000 }, async (t) => {
  const received = [];
  const fixture = await openHttpFixture(t, {
    antigravity: {
      run(params) {
        received.push(params);
        return (async function* () {
          yield { type: 'text_delta', delta: 'large-' };
          yield { type: 'text_delta', delta: 'ok' };
          yield {
            type: 'turn_done',
            conversationId: 'conv-large-1',
            usage: { input: 100, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 112 },
          };
        })();
      },
    },
  });

  const oversizedImageData = 'A'.repeat(33 * 1024 * 1024);
  const res = await fixture.postRaw(ANTIGRAVITY_RUN_PATH, {
    sessionId: 'sess-large',
    runId: 'run-large-1',
    modelId: MODEL_ID,
    reasoning: 'high',
    initialSystemPrompt: 'Base prompt',
    tools: [{ name: 'codemode', description: 'Run code', parameters: { type: 'object', properties: {} } }],
    sections: [{ key: 'env', value: 'win32' }],
    routeNote: 'primary',
    inputs: [{ text: 'Inspect big image', images: [{ data: oversizedImageData, mimeType: 'image/png' }], source: 'dm' }],
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/x-ndjson/i);
  const raw = await res.text();
  const events = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { type: 'text_delta', delta: 'large-' },
    { type: 'text_delta', delta: 'ok' },
    {
      type: 'turn_done',
      conversationId: 'conv-large-1',
      usage: { input: 100, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 112 },
    },
  ]);
  assert.equal(received.length, 1);
  assert.equal(received[0].deviceId, DEVICE_ID);
  assert.equal(received[0].inputs[0].images[0].data.length, 33 * 1024 * 1024);
});

test('POST /api/host/antigravity/tool-result validates and forwards text + image content', { timeout: 10_000 }, async (t) => {
  const forwarded = [];
  let failState = false;
  const fixture = await openHttpFixture(t, {
    antigravity: {
      async submitToolResult(params) {
        forwarded.push(params);
        if (failState) {
          throw Object.assign(new Error('run closed'), { code: 'INVALID_STATE' });
        }
        return { ok: true };
      },
    },
  });

  const ok = await fixture.postJson(ANTIGRAVITY_TOOL_RESULT_PATH, {
    sessionId: 'sess-1',
    runId: 'run-1',
    callId: 'call-1',
    content: [
      { type: 'text', text: 'read succeeded' },
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
    ],
    isError: false,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.deepEqual(forwarded, [{
    deviceId: DEVICE_ID,
    sessionId: 'sess-1',
    runId: 'run-1',
    callId: 'call-1',
    content: [
      { type: 'text', text: 'read succeeded' },
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
    ],
    isError: false,
  }]);

  failState = true;
  const stale = await fixture.postJson(ANTIGRAVITY_TOOL_RESULT_PATH, {
    sessionId: 'sess-1',
    runId: 'run-1',
    callId: 'call-2',
    content: [{ type: 'text', text: 'late' }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'INVALID_STATE');

  failState = false;
  const countBeforeBad = forwarded.length;
  for (const badBody of [
    { sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', content: [{ type: 'audio', data: 'abc' }] },
    { sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', content: [{ type: 'image', data: '', mimeType: 'image/png' }] },
    { sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: 'no' },
    { sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', content: [], unexpected: true },
  ]) {
    const res = await fixture.postJson(ANTIGRAVITY_TOOL_RESULT_PATH, badBody);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(forwarded.length, countBeforeBad);
});

test('POST /api/host/antigravity/steer forwards live steers and maps ended run to HTTP 409 INVALID_STATE', { timeout: 10_000 }, async (t) => {
  const steers = [];
  let runEnded = false;
  const fixture = await openHttpFixture(t, {
    antigravity: {
      async steer(params) {
        steers.push(params);
        if (runEnded) {
          throw Object.assign(new Error('Active Antigravity run has already ended'), { code: 'INVALID_STATE' });
        }
        return { ok: true };
      },
    },
  });

  const ok = await fixture.postJson(ANTIGRAVITY_STEER_PATH, {
    sessionId: 'sess-steer',
    runId: 'run-steer-1',
    sections: [{ key: 'instructions', value: 'Updated' }, { key: 'old', value: null }],
    routeNote: 'dm-steer',
    inputs: [{ text: 'add BANANA', images: [{ data: PNG_1X1, mimeType: 'image/png' }], source: 'dm' }],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.deepEqual(steers, [{
    deviceId: DEVICE_ID,
    sessionId: 'sess-steer',
    runId: 'run-steer-1',
    sections: [{ key: 'instructions', value: 'Updated' }, { key: 'old', value: null }],
    routeNote: 'dm-steer',
    inputs: [{ text: 'add BANANA', images: [{ data: PNG_1X1, mimeType: 'image/png' }], source: 'dm' }],
  }]);

  runEnded = true;
  const ended = await fixture.postJson(ANTIGRAVITY_STEER_PATH, {
    sessionId: 'sess-steer',
    runId: 'run-steer-1',
    inputs: [{ text: 'too late' }],
  });
  assert.equal(ended.status, 409);
  assert.equal(ended.body.error.code, 'INVALID_STATE');

  const countBeforeInvalid = steers.length;
  for (const badBody of [
    { sessionId: 'sess-steer', runId: 'run-steer-1', inputs: [] },
    { sessionId: 'sess-steer', runId: 'run-steer-1', inputs: [{ text: 'x' }], extra: 1 },
    { sessionId: 'sess-steer', runId: ' ', inputs: [{ text: 'x' }] },
  ]) {
    const res = await fixture.postJson(ANTIGRAVITY_STEER_PATH, badBody);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(steers.length, countBeforeInvalid);
});

test('POST /api/host/antigravity/cancel forwards optional runId scope and rejects invalid runId with 400', { timeout: 10_000 }, async (t) => {
  const cancels = [];
  const fixture = await openHttpFixture(t, {
    antigravity: {
      async cancel(params) {
        cancels.push(params);
      },
    },
  });

  const scoped = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, {
    sessionId: 'sess-cancel',
    runId: 'run-42',
  });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body, { ok: true });
  assert.deepEqual(cancels[0], { deviceId: DEVICE_ID, sessionId: 'sess-cancel', runId: 'run-42' });

  const sessionWide = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: 'sess-cancel' });
  assert.equal(sessionWide.status, 200);
  assert.deepEqual(sessionWide.body, { ok: true });
  assert.deepEqual(cancels[1], { deviceId: DEVICE_ID, sessionId: 'sess-cancel' });
  assert.equal(Object.hasOwn(cancels[1], 'runId'), false);

  for (const badRunId of ['', null, ' ', '\x00', 'x'.repeat(257), 123]) {
    const res = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: 'sess-cancel', runId: badRunId });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_ARGUMENT');
  }
  const extraKey = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: 'sess-cancel', extra: 'no' });
  assert.equal(extraKey.status, 400);
  assert.equal(extraKey.body.error.code, 'INVALID_ARGUMENT');
  assert.equal(cancels.length, 2, 'invalid cancel payloads must never reach antigravity.cancel');
});

test('POST /api/host/antigravity/run enforces device/model authorization (403) and strict schema validation (400)', { timeout: 10_000 }, async (t) => {
  let runCalls = 0;
  const fixture = await openHttpFixture(t, {
    antigravity: {
      run() {
        runCalls += 1;
        return (async function* () {
          yield { type: 'turn_done', conversationId: 'conv-1' };
        })();
      },
    },
  });

  const validBody = {
    sessionId: 'sess-auth',
    runId: 'run-auth-1',
    modelId: MODEL_ID,
    tools: [],
    inputs: [{ text: 'hello' }],
  };

  // Device not assigned antigravity-acp/*
  fixture.state.assignedModelRef = 'openai/gpt-5';
  let res = await fixture.postJson(ANTIGRAVITY_RUN_PATH, validBody);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  // Provider disabled
  fixture.state.assignedModelRef = `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}`;
  fixture.state.providerEnabled = false;
  res = await fixture.postJson(ANTIGRAVITY_RUN_PATH, validBody);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  // Model disabled
  fixture.state.providerEnabled = true;
  fixture.state.models = [{ id: MODEL_ID, enabled: false }];
  res = await fixture.postJson(ANTIGRAVITY_RUN_PATH, validBody);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  // Restore valid authorization and test schema validation errors -> 400 INVALID_ARGUMENT
  fixture.state.models = [{ id: MODEL_ID, enabled: true }];
  for (const badBody of [
    { ...validBody, messages: [] }, // legacy field rejected
    { ...validBody, delta: {} }, // legacy field rejected
    { ...validBody, reasoning: 'turbo' },
    { ...validBody, inputs: [] },
    { ...validBody, tools: [{ name: 'bad', parameters: 'not-object' }] },
    { ...validBody, sections: [{ key: 'k', value: 42 }] },
    { sessionId: 'sess-auth', modelId: MODEL_ID, tools: [], inputs: [{ text: 'missing runId' }] },
  ]) {
    const rejected = await fixture.postJson(ANTIGRAVITY_RUN_PATH, badBody);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'INVALID_ARGUMENT');
  }

  assert.equal(runCalls, 0, 'rejected requests must never invoke antigravity.run');
});
