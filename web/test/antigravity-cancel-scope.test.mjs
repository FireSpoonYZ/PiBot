import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ANTIGRAVITY_CANCEL_PATH,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_RUN_PATH,
} from '../../center-contract/antigravity.js';
import { registerAntigravityRoutes } from '../../center-server/antigravity-routes.js';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import { makeSessionKey } from '../../center-server/antigravity/sessions.ts';
import { errorStatus } from '../../center-server/server.js';
import { connectCenter } from '../../host-core/center-client.js';
import {
  collectRunEvents,
  createControlledAcpDriverHarness,
  openAntigravity,
  waitUntil,
} from './helpers/antigravity-sync-harness.mjs';

const requireCenter = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = requireCenter('fastify');

const DEVICE_ID = 'cancel-scope-device';
const DEVICE_TOKEN = 'cancel-scope-test-token-'.repeat(3);
const SESSION_ID = 'cancel-scope-session';
const MODEL_ID = 'gemini-4-hydrogen';

async function openCancelHttpFixture(t, { holdFirstCancel = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cancel-scope-'));
  const nativeTurns = [];
  const harness = createControlledAcpDriverHarness((ctx) => {
    nativeTurns.push(ctx);
  });
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const eventResponses = new Set();
  const runRequests = [];
  const cancelRequests = [];
  const serviceRuns = [];
  const serviceCancels = [];
  const cancelGate = Promise.withResolvers();
  let heldFirstCancel = false;
  let client;
  let routes;
  let closed = false;

  app.decorateRequest('centerDevice', null);
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}` || req.headers['x-device-id'] !== DEVICE_ID) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid test device' } });
    }
    req.centerDevice = { deviceId: DEVICE_ID, token: DEVICE_TOKEN };
  });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (error.statusCode === 400 && !Object.hasOwn(errorStatus, code)) code = 'INVALID_ARGUMENT';
    if (!Object.hasOwn(errorStatus, code)) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({ error: { code, message: error.message } });
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
      getProvider: (id) => (id === ANTIGRAVITY_PROVIDER_ID ? { id, enabled: true } : null),
      listDeviceBots: () => [{ botId: 'bot-1' }],
      getBotModelConfig: () => ({ effective: { modelRef: `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}` } }),
      listModels: () => [{ id: MODEL_ID, enabled: true }],
    },
    bridge: { registry: { authenticate: () => true } },
    catalog: { apply: async () => {} },
    changed: (value) => value,
    antigravity: {
      run(params, options) {
        const source = service.run(params, options);
        const completion = Promise.withResolvers();
        serviceRuns.push({ params, finished: completion.promise });
        return {
          async *[Symbol.asyncIterator]() {
            try {
              yield* source;
            } finally {
              completion.resolve();
            }
          },
        };
      },
      submitToolResult: (params) => service.submitToolResult(params),
      steer: (params) => service.steer(params),
      cancel(params) {
        serviceCancels.push({ ...params });
        return service.cancel(params);
      },
    },
    host(method, url, handler, bodyLimit) {
      app.route({
        method,
        url,
        ...(bodyLimit !== undefined ? { bodyLimit } : {}),
        async handler(req, reply) {
          const completion = Promise.withResolvers();
          const record = { body: req.body, completed: completion.promise };
          if (url === ANTIGRAVITY_RUN_PATH) runRequests.push(record);
          if (url === ANTIGRAVITY_CANCEL_PATH) cancelRequests.push(record);
          try {
            if (url === ANTIGRAVITY_CANCEL_PATH && holdFirstCancel && !heldFirstCancel) {
              heldFirstCancel = true;
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
      for (const res of eventResponses) res.destroy();
      await app.close();
    } finally {
      try {
        await service.close();
      } finally {
        harness.restore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  };

  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    client = await connectCenter({
      centerUrl: baseUrl,
      deviceId: DEVICE_ID,
      deviceToken: DEVICE_TOKEN,
      signal: t.signal,
    });
    const postJson = async (url, body) => {
      const response = await fetch(new URL(url, baseUrl), {
        method: 'POST',
        signal: t.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEVICE_TOKEN}`,
          'X-Device-Id': DEVICE_ID,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    return {
      harness,
      service,
      client,
      runRequests,
      cancelRequests,
      serviceRuns,
      serviceCancels,
      nativeTurns,
      releaseCancel: () => cancelGate.resolve(),
      postJson,
      nativeTurn: (index) => waitUntil(() => nativeTurns[index], { timeoutMs: 3_000, label: `native turn ${index + 1}` }),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

test('delayed Run 1 cancel({ sessionId, runId: run1 }) never cancels Run 2 on the same session', { timeout: 20_000 }, async (t) => {
  const fixture = await openCancelHttpFixture(t, { holdFirstCancel: true });
  try {
    const ac1 = new AbortController();
    const run1Result = collectRunEvents(fixture.client.antigravity.run(
      {
        sessionId: SESSION_ID,
        runId: 'run-1',
        modelId: MODEL_ID,
        tools: [],
        inputs: [{ text: 'First turn' }],
      },
      { signal: AbortSignal.any([ac1.signal, t.signal]) },
    )).then((events) => ({ ok: true, events }), (error) => ({ ok: false, error }));
    const turn1 = await fixture.nativeTurn(0);

    // Abort Run 1 -> connectCenter destroys stream AND posts independent cancel({ sessionId, runId: 'run-1' }).
    ac1.abort();
    const delayedCancelPost = await waitUntil(() => fixture.cancelRequests[0], { label: 'held Run 1 cancel POST' });
    assert.deepEqual(delayedCancelPost.body, { sessionId: SESSION_ID, runId: 'run-1' });

    // Wait for Run 1's HTTP handler and underlying service run to settle while cancel POST stays held.
    await fixture.runRequests[0].completed;
    await fixture.serviceRuns[0].finished;
    const settled1 = await run1Result;
    assert.equal(settled1.ok, false, 'aborted Run 1 stream must reject');
    assert.equal(turn1.req.signal.aborted, true);
    const cancelsBeforeRelease = fixture.serviceCancels.length;

    // Start Run 2 on the exact same session.
    const run2Promise = collectRunEvents(fixture.client.antigravity.run(
      {
        sessionId: SESSION_ID,
        runId: 'run-2',
        modelId: MODEL_ID,
        tools: [],
        inputs: [{ text: 'Second turn' }],
      },
      { signal: t.signal },
    ));
    const turn2 = await fixture.nativeTurn(1);
    assert.equal(turn2.req.conversationId, turn1.conversationId);

    // Release delayed Run 1 cancel POST; it must reach the real service and leave Run 2 untouched.
    fixture.releaseCancel();
    await delayedCancelPost.completed;
    assert.equal(fixture.serviceCancels.length, cancelsBeforeRelease + 1);
    assert.equal(fixture.serviceCancels.at(-1).runId, 'run-1');
    assert.equal(turn2.req.signal.aborted, false, 'stale Run 1 cancel must never abort Run 2');

    turn2.emit({ type: 'text', delta: 'Run 2 completed' });
    turn2.finish();
    const run2Events = await run2Promise;
    assert.equal(run2Events.at(-1)?.type, 'turn_done');
    assert.equal(run2Events.filter((ev) => ev.type === 'text_delta').map((ev) => ev.delta).join(''), 'Run 2 completed');
  } finally {
    await fixture.close();
  }
});

test('session-wide cancel without runId stops the active run while invalid runId rejects with INVALID_ARGUMENT', { timeout: 15_000 }, async (t) => {
  const fixture = await openCancelHttpFixture(t);
  try {
    const runPromise = collectRunEvents(fixture.client.antigravity.run(
      {
        sessionId: SESSION_ID,
        runId: 'run-active',
        modelId: MODEL_ID,
        tools: [],
        inputs: [{ text: 'Stay alive on invalid runId' }],
      },
      { signal: t.signal },
    ));
    const turn = await fixture.nativeTurn(0);

    for (const badRunId of ['', null, ' ', '\u0000', 'x'.repeat(257), 123]) {
      const countBefore = fixture.serviceCancels.length;
      const httpRes = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: SESSION_ID, runId: badRunId });
      assert.equal(httpRes.status, 400);
      assert.equal(httpRes.body.error.code, 'INVALID_ARGUMENT');
      assert.equal(fixture.serviceCancels.length, countBefore, 'invalid runId must not forward to service');

      await assert.rejects(
        fixture.service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID, runId: badRunId }),
        (err) => err?.code === 'INVALID_ARGUMENT',
      );
      assert.equal(turn.req.signal.aborted, false, 'invalid runId must never degrade into session-wide cancel');
    }

    const cancelled = await fixture.postJson(ANTIGRAVITY_CANCEL_PATH, { sessionId: SESSION_ID });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { ok: true });
    assert.equal(Object.hasOwn(fixture.serviceCancels.at(-1), 'runId'), false);
    assert.equal(turn.req.signal.aborted, true);

    const events = await runPromise;
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(events.at(-1)?.aborted, true);
  } finally {
    await fixture.close();
  }
});

test('Stop/cancel fails pending MCP waiter before session/cancel, preserves hot process + SessionStore, and hot-reuses conversationId', { timeout: 20_000 }, async () => {
  // Part A: deterministic in-process ordering check (MCP waiter fails & timers resume synchronously before abort fires).
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cancel-order-'));
    const order = [];
    let toolCallPromise;
    let driverAliveAfterAbort;
    const harness = createControlledAcpDriverHarness(async (ctx) => {
      const state = harness.getDriverState(ctx.driver);
      const origResume = ctx.driver.resumeTimers;
      ctx.driver.resumeTimers = function () {
        order.push('waiters-failed-resume-timers');
        return origResume.call(this);
      };
      ctx.req.signal.addEventListener('abort', () => {
        order.push('driver-abort-signal');
        driverAliveAfterAbort = state.alive;
      }, { once: true });

      const captured = ctx.mcp.captureContext();
      toolCallPromise = ctx.mcp.handler.onToolCall(
        'call-order-1',
        'read_file',
        { path: 'a.txt' },
        new AbortController().signal,
        captured,
      );
      await toolCallPromise;
      ctx.abort();
    });
    const service = openAntigravity({
      dataRoot: root,
      bin: 'mocked-agy',
      geminiHome: path.join(root, 'antigravity', 'gemini'),
    });
    try {
      const stream = service.run({
        deviceId: DEVICE_ID,
        sessionId: 'order-session',
        runId: 'order-run-1',
        modelId: MODEL_ID,
        tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
        inputs: [{ text: 'Call read_file' }],
      });
      const iter = stream[Symbol.asyncIterator]();
      const first = await iter.next();
      assert.equal(first.value?.type, 'tool_request');

      await service.cancel({ deviceId: DEVICE_ID, sessionId: 'order-session', runId: 'order-run-1' });
      const rest = [];
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        rest.push(next.value);
      }
      const toolResult = await toolCallPromise;
      assert.equal(rest.at(-1)?.type, 'error');
      assert.equal(rest.at(-1)?.aborted, true);
      assert.equal(toolResult?.isError, true);
      assert.equal(driverAliveAfterAbort, true, 'cancel must not kill the hot driver');
      assert.deepEqual(order, ['waiters-failed-resume-timers', 'driver-abort-signal']);
      assert.equal(harness.closes.length, 0, 'cancel must not close/kill the driver');
    } finally {
      await service.close();
      harness.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Part B: real local Node fake ACP process end-to-end (hot PID survives cancel, SessionStore kept, next turn hot-reuses).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cancel-hot-'));
  const workspaceDir = path.join(root, 'antigravity', 'workspace');
  const logFile = path.join(workspaceDir, 'rpc-log.jsonl');
  const mcpReportFile = path.join(workspaceDir, 'mcp-cancel-result.json');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'acp'), String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

const logFile = path.join(__dirname, 'rpc-log.jsonl');
const reportFile = path.join(__dirname, 'mcp-cancel-result.json');
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');

let mcpServer = null;
let parkedPrompt = null;
let promptCount = 0;

function parseRpcBody(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const lines = text.split('\n').filter((l) => l.startsWith('data:'));
  return JSON.parse(lines.at(-1).slice('data:'.length).trim());
}

for (const rl of [createInterface({ input: process.stdin })]) {
  rl.on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, method, params }) + '\n');
    if (method === 'initialize') {
      send({ id, result: { agentInfo: { name: 'fake-acp-hot', version: '1.5.12' } } });
      return;
    }
    if (method === 'session/new') {
      mcpServer = params.mcpServers?.[0] ?? null;
      send({ id, result: { sessionId: 'hot-conv-1', configOptions: [] } });
      return;
    }
    if (method === 'session/cancel') {
      const current = parkedPrompt;
      parkedPrompt = null;
      if (current) {
        void current.mcpPromise.then((mcpResult) => {
          fs.writeFileSync(reportFile, JSON.stringify(mcpResult));
          send({ id: current.id, result: { stopReason: 'cancelled' } });
        });
      }
      return;
    }
    if (method === 'session/prompt') {
      promptCount += 1;
      if (promptCount === 1) {
        const headers = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        };
        for (const h of mcpServer?.headers ?? []) headers[h.name] = h.value;
        const mcpPromise = fetch(mcpServer.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'slow_tool', arguments: { step: 'cancel-me' } },
          }),
        }).then(async (res) => ({ status: res.status, frame: parseRpcBody(await res.text()) }));
        parkedPrompt = { id, mcpPromise };
        return;
      }
      send({
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hot-continued' } } },
      });
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } } });
      return;
    }
    if (id !== undefined) send({ id, result: {} });
  });
}
`, 'utf8');

  const service = openAntigravity({
    dataRoot: root,
    bin: process.execPath,
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });
  try {
    const stream1 = service.run({
      deviceId: DEVICE_ID,
      sessionId: 'hot-cancel-session',
      runId: 'hot-run-1',
      modelId: MODEL_ID,
      tools: [{ name: 'slow_tool', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'Start slow tool' }],
    });
    const iter1 = stream1[Symbol.asyncIterator]();
    let sawToolReq = false;
    while (!sawToolReq) {
      const step = await iter1.next();
      assert.equal(step.done, false, 'run 1 must emit tool_request before ending');
      if (step.value.type === 'tool_request') {
        assert.equal(step.value.name, 'slow_tool');
        sawToolReq = true;
      }
    }

    await service.cancel({ deviceId: DEVICE_ID, sessionId: 'hot-cancel-session', runId: 'hot-run-1' });
    const remaining1 = [];
    for (;;) {
      const step = await iter1.next();
      if (step.done) break;
      remaining1.push(step.value);
    }
    assert.equal(remaining1.at(-1)?.type, 'error');
    assert.equal(remaining1.at(-1)?.aborted, true);

    const mcpReport = JSON.parse(fs.readFileSync(mcpReportFile, 'utf8'));
    assert.equal(mcpReport.status, 200);
    assert.equal(mcpReport.frame.result.isError, true);
    assert.match(mcpReport.frame.result.content[0].text, /cancelled/i);

    const sessionsPath = path.join(root, 'antigravity', 'sessions.json');
    const saved = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const binding = saved[makeSessionKey(DEVICE_ID, 'hot-cancel-session')];
    assert.equal(binding?.conversationId, 'hot-conv-1', 'SessionStore binding must remain intact after cancel');
    assert.ok(typeof binding?.agentName === 'string' && binding.agentName.length > 0);

    const beforeTurn2Count = fs.readFileSync(logFile, 'utf8').trim().split('\n').length;
    const events2 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: 'hot-cancel-session',
      runId: 'hot-run-2',
      modelId: MODEL_ID,
      tools: [{ name: 'slow_tool', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'Continue after stop' }],
    }));
    assert.equal(events2.at(-1)?.type, 'turn_done');
    assert.equal(events2.at(-1)?.conversationId, 'hot-conv-1');
    assert.equal(events2.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), 'hot-continued');

    const allFrames = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    const turn1Pid = allFrames[0].pid;
    const turn2Frames = allFrames.slice(beforeTurn2Count);
    assert.ok(turn2Frames.length > 0);
    assert.ok(turn2Frames.every((f) => f.pid === turn1Pid), 'hot ACP child process must survive cancel without respawn');
    assert.equal(turn2Frames.some((f) => f.method === 'session/new' || f.method === 'session/resume'), false);
    assert.equal(turn2Frames.some((f) => f.method === 'session/prompt' && f.params.sessionId === 'hot-conv-1'), true);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('logout cancels active and queued runs and closes drivers; SharedMcpBridge.close waits for concurrent listen', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-logout-'));
  const started = Promise.withResolvers();
  const harness = createControlledAcpDriverHarness(() => {
    started.resolve();
  });
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    const activeRun = collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: 'logout-session',
      runId: 'logout-active',
      modelId: MODEL_ID,
      tools: [],
      inputs: [{ text: 'Active turn' }],
    }));
    await started.promise;

    const queuedRun = collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: 'logout-session',
      runId: 'logout-queued',
      modelId: MODEL_ID,
      tools: [],
      inputs: [{ text: 'Queued turn' }],
    }));

    await service.logout();
    const [activeEvents, queuedEvents] = await Promise.all([activeRun, queuedRun]);
    assert.equal(activeEvents.at(-1)?.type, 'error');
    assert.equal(activeEvents.at(-1)?.aborted, true);
    assert.equal(queuedEvents.at(-1)?.type, 'error');
    assert.equal(queuedEvents.at(-1)?.aborted, true);
    assert.equal(harness.runs.length, 1, 'queued run must be cancelled before reaching driver.run');
    assert.ok(harness.closes.some((c) => c.reason === 'recycle' && c.cause === 'oauth logout'));
    assert.equal(harness.mcpRegistrations[0]?.unregistered, true);
  } finally {
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const bridge = new SharedMcpBridge();
  try {
    const start = bridge.ensureStarted();
    await bridge.close();
    await start;
    assert.equal(bridge.port, 0);
    assert.throws(() => bridge.serverConfig('any-token'), /must be started/);
  } finally {
    await bridge.close();
  }
});
