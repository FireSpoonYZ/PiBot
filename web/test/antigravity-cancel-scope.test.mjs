import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectCenter } from '../../host-core/center-client.js';
import { registerAntigravityRoutes } from '../../center-server/antigravity-routes.js';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import {
  ANTIGRAVITY_CANCEL_PATH, ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_STREAM_PATH,
} from '../../center-contract/antigravity.js';
import {
  createControlledAcpDriverHarness, openIsolatedAntigravity, drainEventStream,
  waitUntil, messageText, toolResult, BASE_SYSTEM, MODEL_ID,
} from './helpers/antigravity-sync-harness.mjs';

const requireCenter = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = requireCenter('fastify');
const DEVICE_ID = 'cancel-scope-device';
const DEVICE_TOKEN = 'cancel-scope-test-token-'.repeat(3);
const SESSION_ID = 'cancel-scope-session';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function payload(text) {
  return {
    sessionId: SESSION_ID,
    modelId: MODEL_ID,
    messages: [BASE_SYSTEM, { role: 'user', content: text, timestamp: 10 }],
    turnContext: { inputIndex: 1, auxiliaryIndices: [] },
  };
}

function finishTurn(ctx, text) {
  ctx.emit({ type: 'text', delta: text });
  ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: text, finished: true, aborted: false });
}

// Keep the real Host HTTP client, Fastify request lifecycle, Center routes and
// service. Only native agy is controlled; cancellation identities are never
// invented or rewritten by the fixture.
async function openCancelFixture(t, { holdFirstCancel = false } = {}) {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cancel-scope-'));
  const service = openIsolatedAntigravity(rootDir);
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const eventResponses = new Set();
  const streamRequests = [];
  const cancelRequests = [];
  const serviceStreams = [];
  const serviceCancels = [];
  const nativeTurns = [];
  const cancelGate = Promise.withResolvers();
  let heldCancel = false;
  let client;
  let routes;
  let closed = false;

  driver.setOnRun(ctx => { nativeTurns.push(ctx); });
  app.decorateRequest('centerDevice', null);
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}` || req.headers['x-device-id'] !== DEVICE_ID) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid test device' } });
    }
    req.centerDevice = { deviceId: DEVICE_ID, token: DEVICE_TOKEN };
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.code(error.code === 'INVALID_ARGUMENT' ? 400 : 500)
      .send({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } });
  });
  app.get('/api/host/events', (_req, reply) => {
    reply.hijack();
    eventResponses.add(reply.raw);
    reply.raw.once('close', () => eventResponses.delete(reply.raw));
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
  });

  routes = registerAntigravityRoutes({
    store: {
      getProvider: id => id === ANTIGRAVITY_PROVIDER_ID ? { id, enabled: true } : null,
      listDeviceBots: () => [{ botId: 'bot-1' }],
      getBotModelConfig: () => ({ effective: { modelRef: `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}` } }),
      listModels: () => [{ id: MODEL_ID, enabled: true }],
    },
    bridge: { registry: { authenticate: () => true } },
    catalog: { apply: async () => {} },
    changed: value => value,
    antigravity: {
      stream(params, options) {
        const stream = service.stream(params, options);
        serviceStreams.push({ params, finished: stream.result() });
        return stream;
      },
      cancel(params) {
        serviceCancels.push({ ...params });
        return service.cancel(params);
      },
    },
    host(method, url, handler, bodyLimit) {
      app.route({
        method, url, ...(bodyLimit === undefined ? {} : { bodyLimit }),
        async handler(req, reply) {
          const completion = Promise.withResolvers();
          const record = { body: req.body, completed: completion.promise };
          (url === ANTIGRAVITY_STREAM_PATH ? streamRequests : cancelRequests).push(record);
          try {
            if (url === ANTIGRAVITY_CANCEL_PATH && holdFirstCancel && !heldCancel) {
              heldCancel = true;
              // Hold the independent cancel POST after real HTTP parsing but
              // before the real route/service can observe it.
              await cancelGate.promise;
            }
            return await handler(req, reply);
          } finally {
            completion.resolve();
          }
        },
      });
    },
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    cancelGate.resolve();
    routes.close();
    try {
      await client?.close();
      for (const response of eventResponses) response.destroy();
      await app.close();
    } finally {
      try { await service.close(); }
      finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
    }
  };

  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    client = await connectCenter({ centerUrl: baseUrl, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, signal: t.signal });
    const post = (url, body) => fetch(new URL(url, baseUrl), {
      method: 'POST', signal: t.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEVICE_TOKEN}`, 'X-Device-Id': DEVICE_ID },
      body: JSON.stringify(body),
    });
    return {
      driver, service, client, streamRequests, cancelRequests, serviceStreams, serviceCancels, nativeTurns, close,
      releaseCancel: () => cancelGate.resolve(),
      async postJson(url, body) {
        const response = await post(url, body);
        return { status: response.status, body: await response.json() };
      },
      async legacyStream(body) {
        const response = await post(ANTIGRAVITY_STREAM_PATH, body);
        assert.equal(response.status, 200);
        const events = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        return { events, terminal: events.at(-1) };
      },
      nativeTurn(index) {
        return waitUntil(() => nativeTurns[index], { label: `native turn ${index + 1}` });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('delayed Host cancel POST from T1 cannot cancel T2 in the same session', { timeout: 20_000 }, async t => {
  const fixture = await openCancelFixture(t, { holdFirstCancel: true });
  try {
    const controller = new AbortController();
    const forgedId = 'on-payload-must-not-control-cancellation';
    let hookCalls = 0;
    const onPayload = input => { hookCalls += 1; return { ...input, requestId: forgedId }; };
    const first = drainEventStream(fixture.client.streamAntigravity(
      { ...payload('First attempt'), requestId: 'caller-supplied-id' },
      { signal: AbortSignal.any([controller.signal, t.signal]), onPayload },
    ));
    const firstNative = await fixture.nativeTurn(0);
    const firstId = fixture.streamRequests[0].body.requestId;
    assert.match(firstId, UUID_RE);
    assert.notEqual(firstId, forgedId, 'onPayload cannot override the transport-owned ID');
    assert.notEqual(firstId, 'caller-supplied-id');

    controller.abort();
    const cancelledPost = await waitUntil(() => fixture.cancelRequests[0], { label: 'held T1 cancel POST' });
    assert.equal(cancelledPost.body.requestId, firstId);
    assert.equal(cancelledPost.body.sessionId, SESSION_ID);
    // The stream disconnect itself must finish T1 while its independent
    // cancel HTTP request is still held. T2 starts only after both the real
    // route handler and the underlying service consumer have finished.
    await fixture.streamRequests[0].completed;
    await fixture.serviceStreams[0].finished;
    const firstResult = await first;
    assert.equal(firstResult.terminal?.type, 'error');
    assert.equal(firstResult.terminal?.reason, 'aborted');
    assert.equal(firstNative.signal.aborted, true);
    assert.ok(fixture.serviceCancels.some(params => params.requestId === firstId), 'disconnect cancellation keeps T1 identity');
    const cancelsBeforeRelease = fixture.serviceCancels.length;

    const second = drainEventStream(fixture.client.streamAntigravity(payload('Second attempt'), { signal: t.signal, onPayload }));
    const secondNative = await fixture.nativeTurn(1);
    const secondId = fixture.streamRequests[1].body.requestId;
    assert.match(secondId, UUID_RE);
    assert.notEqual(secondId, firstId);
    assert.notEqual(secondId, forgedId);
    assert.equal(hookCalls, 2);
    assert.equal(fixture.serviceStreams[1].params.requestId, secondId);

    fixture.releaseCancel();
    await cancelledPost.completed;
    assert.equal(fixture.serviceCancels.length, cancelsBeforeRelease + 1, 'the stale POST reached the actual service');
    assert.equal(fixture.serviceCancels.at(-1).requestId, firstId);
    assert.equal(secondNative.signal.aborted, false, 'stale T1 cancel must leave T2 running');
    finishTurn(secondNative, 'T2 completed after the stale cancel');
    const secondResult = await second;
    assert.equal(secondResult.terminal?.type, 'done');
    assert.equal(secondResult.terminal?.reason, 'stop');
    assert.equal(messageText(secondResult.terminal.message), 'T2 completed after the stale cancel');
  } finally {
    await fixture.close();
  }
});

test('HTTP cancel with the current Host requestId stops the current native turn', { timeout: 15_000 }, async t => {
  const fixture = await openCancelFixture(t);
  try {
    const result = drainEventStream(fixture.client.streamAntigravity(payload('Cancel this current turn'), { signal: t.signal }));
    const native = await fixture.nativeTurn(0);
    const requestId = fixture.streamRequests[0].body.requestId;
    const cancelled = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: SESSION_ID, requestId });
    assert.deepEqual(cancelled, { status: 200, body: { ok: true } });
    assert.equal(native.signal.aborted, true);
    const completed = await result;
    assert.equal(completed.terminal?.type, 'error');
    assert.equal(completed.terminal?.reason, 'aborted');
    assert.equal(fixture.serviceCancels[0].requestId, requestId);
  } finally {
    await fixture.close();
  }
});

test('legacy HTTP streams and session-wide cancellation still work without requestId', { timeout: 15_000 }, async t => {
  const fixture = await openCancelFixture(t);
  try {
    const result = fixture.legacyStream(payload('Legacy Host turn'));
    const native = await fixture.nativeTurn(0);
    assert.equal(Object.hasOwn(fixture.streamRequests[0].body, 'requestId'), false);
    assert.equal(Object.hasOwn(fixture.serviceStreams[0].params, 'requestId'), false);
    const cancelled = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: SESSION_ID });
    assert.deepEqual(cancelled, { status: 200, body: { ok: true } });
    assert.equal(Object.hasOwn(fixture.serviceCancels[0], 'requestId'), false);
    assert.equal(native.signal.aborted, true);
    const completed = await result;
    assert.equal(completed.terminal?.type, 'error');
    assert.equal(completed.terminal?.reason, 'aborted');
  } finally {
    await fixture.close();
  }
});

test('invalid explicit requestIds never degrade into session-wide cancellation', { timeout: 20_000 }, async t => {
  const fixture = await openCancelFixture(t);
  try {
    const result = drainEventStream(fixture.client.streamAntigravity(payload('Keep this native turn alive'), { signal: t.signal }));
    const native = await fixture.nativeTurn(0);
    for (const requestId of ['', null, 'x'.repeat(257), ' ', '\u0000']) {
      const cancelCount = fixture.serviceCancels.length;
      const streamCount = fixture.serviceStreams.length;
      const rejectedCancel = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: SESSION_ID, requestId });
      assert.equal(rejectedCancel.status, 400);
      assert.equal(rejectedCancel.body.error.code, 'INVALID_ARGUMENT');
      assert.equal(fixture.serviceCancels.length, cancelCount, 'invalid cancel must be rejected before service forwarding');
      const rejectedStream = await fixture.postJson(ANTIGRAVITY_STREAM_PATH, { ...payload('Invalid attempt'), requestId });
      assert.equal(rejectedStream.status, 400);
      assert.equal(rejectedStream.body.error.code, 'INVALID_ARGUMENT');
      assert.equal(fixture.serviceStreams.length, streamCount, 'invalid stream must not claim the session');
      await assert.rejects(
        fixture.service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID, requestId }),
        error => error?.code === 'INVALID_ARGUMENT',
      );
      assert.equal(native.signal.aborted, false);
    }
    // Explicit undefined is distinguishable from an absent optional field in
    // direct service calls, even though JSON cannot represent it on the wire.
    await assert.rejects(
      fixture.service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID, requestId: undefined }),
      error => error?.code === 'INVALID_ARGUMENT',
    );
    assert.equal(native.signal.aborted, false);
    assert.equal(fixture.driver.runs.length, 1);
    finishTurn(native, 'Survived invalid cancellation identities');
    const completed = await result;
    assert.equal(completed.terminal?.type, 'done');
    assert.equal(completed.terminal?.reason, 'stop');
  } finally {
    await fixture.close();
  }
});

test('a semantically invalid request cannot steal a parked native turn cancellation identity', { timeout: 15_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-parked-cancel-'));
  const service = openIsolatedAntigravity(rootDir);
  let parkedNative;
  driver.setOnRun(async ctx => {
    parkedNative = ctx;
    await ctx.mcp.handler.onToolCall('parked-call', 'read_file', { path: 'README.md' }, ctx.signal);
  });
  try {
    const first = await drainEventStream(service.stream({ ...payload('Park on read_file'), deviceId: DEVICE_ID, requestId: 'first' }, { signal: t.signal }));
    assert.equal(first.terminal?.type, 'done');
    assert.equal(first.terminal?.reason, 'toolUse');
    assert.equal(parkedNative.signal.aborted, false);
    const invalid = await drainEventStream(service.stream({
      deviceId: DEVICE_ID, sessionId: SESSION_ID, requestId: 'bad', modelId: MODEL_ID,
      messages: [BASE_SYSTEM], turnContext: { inputIndex: null, auxiliaryIndices: [] },
    }, { signal: t.signal }));
    assert.equal(invalid.terminal?.type, 'error');
    assert.equal(driver.runs.length, 1);
    assert.equal(parkedNative.signal.aborted, false);
    await service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID, requestId: 'first' });
    assert.equal(parkedNative.signal.aborted, true, 'the parked native turn must still be owned by requestId first');
  } finally {
    try { await service.close(); }
    finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
  }
});

for (const abortPoint of ['before serial admission', 'during bridge startup']) {
  test(`direct continuation abort ${abortPoint} also cancels its inherited parked native turn`, { timeout: 15_000 }, async t => {
    const driver = createControlledAcpDriverHarness(t);
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-early-abort-'));
    const service = openIsolatedAntigravity(rootDir);
    const startupEntered = Promise.withResolvers();
    const startupReleased = Promise.withResolvers();
    let parkedNative;
    driver.setOnRun(async ctx => {
      parkedNative = ctx;
      await ctx.mcp.handler.onToolCall('early-abort-call', 'read_file', { path: 'README.md' }, ctx.signal);
    });
    try {
      const initial = payload('Read before the early continuation abort.');
      const first = await drainEventStream(service.stream({ ...initial, deviceId: DEVICE_ID, requestId: 'first' }, { signal: t.signal }));
      assert.equal(first.terminal?.reason, 'toolUse');
      assert.equal(parkedNative.signal.aborted, false);

      if (abortPoint === 'during bridge startup') {
        const original = SharedMcpBridge.prototype.ensureStarted;
        t.mock.method(SharedMcpBridge.prototype, 'ensureStarted', async function () {
          startupEntered.resolve();
          await startupReleased.promise;
          return original.call(this);
        });
      }
      const messages = [...initial.messages, first.terminal.message,
        toolResult('early-abort-call', 'read_file', 'ACTUAL_RESULT_AFTER_EARLY_ABORT', 12)];
      const continuation = { ...initial, messages, deviceId: DEVICE_ID,
        turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] } };
      const controller = new AbortController();
      const second = service.stream({ ...continuation, requestId: 'second' }, {
        signal: AbortSignal.any([controller.signal, t.signal]),
      });
      if (abortPoint === 'during bridge startup') await startupEntered.promise;
      controller.abort();
      startupReleased.resolve();
      const aborted = await drainEventStream(second);
      assert.equal(aborted.terminal?.reason, 'aborted');
      assert.equal(parkedNative.signal.aborted, true, 'a cancelled continuation must not leave its inherited native turn alive');
      assert.equal(driver.runs[0].driverState.active, null);
      assert.equal(driver.runs.length, 1, 'the aborted continuation must not start another native prompt');
      await assert.rejects(parkedNative.mcp.handler.onToolCall('stale-after-abort', 'read_file', { path: 'x' }, new AbortController().signal), /inactive native turn/);

      driver.setOnRun(ctx => finishTurn(ctx, 'Recovered after early cancellation'));
      const recovered = await drainEventStream(service.stream({ ...continuation, requestId: 'third' }, { signal: t.signal }));
      assert.equal(recovered.terminal?.reason, 'stop');
      assert.equal(driver.runs[1].request.conversationId, null);
      assert.ok(driver.runs[1].request.contextBlock.text.includes('ACTUAL_RESULT_AFTER_EARLY_ABORT'));
    } finally {
      startupReleased.resolve();
      try { await service.close(); }
      finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
    }
  });
}

test('SharedMcpBridge close waits for an in-flight listen and leaves no listener', { timeout: 10_000 }, async () => {
  const bridge = new SharedMcpBridge();
  try {
    const start = bridge.ensureStarted();
    await bridge.close();
    await start;
    assert.equal(bridge.port, 0);
  } finally {
    // Also close after the assertion so an unfixed startup race cannot leak
    // its late-created listener into subsequent tests.
    await bridge.close();
  }
});
