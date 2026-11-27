import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AGY_HISTORY_CHANGED,
  ANTIGRAVITY_PROVIDER_ID,
} from '../../center-contract/antigravity.js';
import { registerAuth } from '../../center-server/auth.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerRoutes } from '../../center-server/routes.js';
import { errorStatus } from '../../center-server/server.js';
import { makeSessionKey, SessionStore } from '../../center-server/antigravity/sessions.ts';
import { mapStopReason, TextAccumulator } from '../../center-server/antigravity/vendor/acp/events.ts';
import {
  collectRunEvents,
  createControlledAcpDriverHarness,
  openAntigravity,
  waitUntil,
} from './helpers/antigravity-sync-harness.mjs';

const requireCenter = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = requireCenter('fastify');

const DEVICE_ID = 'adversarial-device';
const SESSION_ID = 'adversarial-session';
const MODEL_A = 'gemini-4-hydrogen';
const MODEL_B = 'gemini-4-neon';

function installFakeAcpWorkspace(rootDir, scriptSource) {
  const workspaceDir = path.join(rootDir, 'antigravity', 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'acp'), scriptSource, 'utf8');
  return workspaceDir;
}

const STANDARD_FAKE_ACP = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

const logFile = path.join(__dirname, 'rpc-log.jsonl');
const failResumeFlag = path.join(__dirname, 'fail-resume.flag');
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');

let currentModel = 'gemini-4-hydrogen';
let currentThought = 'medium';
const configOptions = () => [
  { id: 'model', currentValue: currentModel, options: [{ value: 'gemini-4-hydrogen' }, { value: 'gemini-4-neon' }] },
  { id: 'thought_level', currentValue: currentThought, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
];

for (const rl of [createInterface({ input: process.stdin })]) {
  rl.on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, method, params }) + '\n');
    if (method === 'initialize') {
      send({ id, result: { agentInfo: { name: 'fake-agy', version: '1.5.12' } } });
      return;
    }
    if (method === 'session/new') {
      send({ id, result: { sessionId: 'native-conv-1', configOptions: configOptions() } });
      return;
    }
    if (method === 'session/resume') {
      if (fs.existsSync(failResumeFlag)) {
        send({ id, error: { code: -32602, message: 'native session not found' } });
        return;
      }
      send({ id, result: { configOptions: configOptions() } });
      return;
    }
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') currentModel = params.value;
      if (params.configId === 'thought_level') currentThought = params.value;
      send({ id, result: { configOptions: configOptions() } });
      return;
    }
    if (method === 'session/prompt') {
      send({
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok:' + currentModel + ':' + currentThought } },
        },
      });
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
      return;
    }
    if (id !== undefined) send({ id, result: {} });
  });
}
`;

test('Hot reuse skips session/new + session/resume + unchanged config, and switches AGY model via set_config_option without rebuild', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-hot-switch-'));
  const workspaceDir = installFakeAcpWorkspace(root, STANDARD_FAKE_ACP);
  const logFile = path.join(workspaceDir, 'rpc-log.jsonl');
  const readLog = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);

  const service = openAntigravity({
    dataRoot: root,
    bin: process.execPath,
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    // Turn 1: cold session/new
    const events1 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'hot-1',
      modelId: MODEL_A,
      reasoning: 'high',
      initialSystemPrompt: 'SOUL V1',
      tools: [],
      inputs: [{ text: 'First turn' }],
    }));
    assert.equal(events1.at(-1)?.type, 'turn_done');
    assert.equal(events1.at(-1)?.conversationId, 'native-conv-1');
    const afterTurn1 = readLog();
    const pid1 = afterTurn1[0].pid;

    // Turn 2: same session, same model + reasoning -> hot reuse, ZERO set_config_option / session/new / session/resume!
    const events2 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'hot-2',
      modelId: MODEL_A,
      reasoning: 'high',
      tools: [],
      inputs: [{ text: 'Second turn same model' }],
    }));
    assert.equal(events2.at(-1)?.type, 'turn_done');
    assert.equal(events2.at(-1)?.conversationId, 'native-conv-1');
    const afterTurn2 = readLog();
    const turn2Frames = afterTurn2.slice(afterTurn1.length);
    assert.ok(turn2Frames.every((f) => f.pid === pid1));
    assert.deepEqual(turn2Frames.map((f) => f.method), ['session/prompt']);

    // Turn 3: same session, switch AGY model A -> B -> set_config_option without rebuilding session!
    const events3 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'hot-3',
      modelId: MODEL_B,
      reasoning: 'high',
      tools: [],
      inputs: [{ text: 'Third turn switched model' }],
    }));
    assert.equal(events3.at(-1)?.type, 'turn_done');
    assert.equal(events3.at(-1)?.conversationId, 'native-conv-1');
    assert.equal(events3.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), `ok:${MODEL_B}:high`);
    const turn3Frames = readLog().slice(afterTurn2.length);
    assert.ok(turn3Frames.every((f) => f.pid === pid1), 'switching AGY model must keep the same hot ACP process');
    assert.equal(turn3Frames.some((f) => f.method === 'session/new' || f.method === 'session/resume'), false);
    assert.deepEqual(
      turn3Frames.filter((f) => f.method === 'session/set_config_option').map((f) => [f.params.configId, f.params.value]),
      [['model', MODEL_B], ['thought_level', 'high']],
    );
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cold restart calls session/resume + re-applies model & thought_level; lost native session returns AGY_HISTORY_CHANGED without session/new', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cold-resume-'));
  const workspaceDir = installFakeAcpWorkspace(root, STANDARD_FAKE_ACP);
  const logFile = path.join(workspaceDir, 'rpc-log.jsonl');
  const readLog = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  const openSvc = () => openAntigravity({
    dataRoot: root,
    bin: process.execPath,
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  let service = openSvc();
  try {
    const events1 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'cold-1',
      modelId: MODEL_A,
      reasoning: 'low',
      initialSystemPrompt: 'SOUL COLD',
      tools: [],
      inputs: [{ text: 'Before restart' }],
    }));
    assert.equal(events1.at(-1)?.type, 'turn_done');
    const after1 = readLog();
    const pid1 = after1[0].pid;

    await service.close();
    service = openSvc();

    const events2 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'cold-2',
      modelId: MODEL_B,
      reasoning: 'high',
      tools: [],
      inputs: [{ text: 'After restart' }],
    }));
    assert.equal(events2.at(-1)?.type, 'turn_done');
    assert.equal(events2.at(-1)?.conversationId, 'native-conv-1');
    const after2 = readLog();
    const turn2Frames = after2.slice(after1.length);
    assert.notEqual(turn2Frames[0].pid, pid1, 'cold restart must launch a fresh ACP child process');
    assert.equal(turn2Frames.some((f) => f.method === 'session/load'), false);
    assert.equal(turn2Frames.some((f) => f.method === 'session/new'), false);
    assert.equal(turn2Frames.some((f) => f.method === 'session/resume' && f.params.sessionId === 'native-conv-1'), true);
    assert.deepEqual(
      turn2Frames.filter((f) => f.method === 'session/set_config_option').map((f) => [f.params.configId, f.params.value]),
      [['model', MODEL_B], ['thought_level', 'high'], ['mode', 'default']],
    );

    // Simulate lost native session on subsequent cold restart
    await service.close();
    fs.writeFileSync(path.join(workspaceDir, 'fail-resume.flag'), '1', 'utf8');
    service = openSvc();

    const events3 = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'cold-3',
      modelId: MODEL_B,
      reasoning: 'high',
      tools: [],
      inputs: [{ text: 'Missing native session' }],
    }));
    assert.equal(events3.at(-1)?.type, 'error');
    assert.equal(events3.at(-1)?.code, AGY_HISTORY_CHANGED);
    const turn3Frames = readLog().slice(after2.length);
    assert.equal(turn3Frames.some((f) => f.method === 'session/resume'), true);
    assert.equal(turn3Frames.some((f) => f.method === 'session/new'), false, 'failed resume must never silently session/new');
    assert.equal(turn3Frames.some((f) => f.method === 'session/prompt'), false);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Steer baton handoff keeps stream open when P1 ends early and merges usage1 + usage2 on P2 settlement', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-steer-baton-'));
  installFakeAcpWorkspace(root, String.raw`
const { createInterface } = require('node:readline');

const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
function parseRpcBody(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const lines = text.split('\n').filter((l) => l.startsWith('data:'));
  return JSON.parse(lines.at(-1).slice('data:'.length).trim());
}

let mcpServer = null;
let p1Id = null;
let mcpPromise = null;
let promptCount = 0;

for (const rl of [createInterface({ input: process.stdin })]) {
  rl.on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') {
      send({ id, result: { agentInfo: { name: 'fake-steer', version: '1.5.12' } } });
      return;
    }
    if (method === 'session/new') {
      mcpServer = params.mcpServers?.[0] ?? null;
      send({ id, result: { sessionId: 'steer-conv-1', configOptions: [] } });
      return;
    }
    if (method === 'session/prompt') {
      promptCount += 1;
      if (promptCount === 1) {
        p1Id = id;
        send({
          method: 'session/update',
          params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'P1:' } } },
        });
        const headers = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        };
        for (const h of mcpServer?.headers ?? []) headers[h.name] = h.value;
        mcpPromise = fetch(mcpServer.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'slow_tool', arguments: { mode: 'baton' } },
          }),
        }).then(async (res) => parseRpcBody(await res.text()));
        return;
      }

      // P2 arrived via steer while P1 tool is still parked:
      // 1) Immediately settle P1 with end_turn + usage1.
      send({
        id: p1Id,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedReadTokens: 40, totalTokens: 170 },
        },
      });
      // 2) On next tick, emit a text chunk proving the run & stream stayed open after P1 settled.
      const p2Id = id;
      const p2Text = params.prompt.at(-1).text;
      setImmediate(() => {
        send({
          method: 'session/update',
          params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HANDOFF:' } } },
        });
      });
      // 3) Wait for the parked tool result, then settle P2 with usage2.
      void mcpPromise.then((rpc) => {
        const toolText = rpc.result.content[0].text;
        send({
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: toolText + ':' + p2Text } },
          },
        });
        send({
          id: p2Id,
          result: {
            stopReason: 'end_turn',
            usage: { inputTokens: 50, outputTokens: 30, thoughtTokens: 5, cachedReadTokens: 10, totalTokens: 95 },
          },
        });
      });
      return;
    }
    if (id !== undefined) send({ id, result: {} });
  });
}
`);

  const service = openAntigravity({
    dataRoot: root,
    bin: process.execPath,
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    const stream = service.run({
      deviceId: DEVICE_ID,
      sessionId: 'steer-baton-session',
      runId: 'steer-baton-1',
      modelId: MODEL_A,
      tools: [{ name: 'slow_tool', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'Initial prompt' }],
    });
    const iter = stream[Symbol.asyncIterator]();
    const collected = [];
    let toolCallId = null;

    while (!toolCallId) {
      const step = await iter.next();
      assert.equal(step.done, false);
      collected.push(step.value);
      if (step.value.type === 'tool_request') toolCallId = step.value.callId;
    }

    // Send steer P2 while the MCP tool is suspended.
    await service.steer({
      deviceId: DEVICE_ID,
      sessionId: 'steer-baton-session',
      runId: 'steer-baton-1',
      inputs: [{ text: 'STEER_P2' }],
    });

    // Wait for HANDOFF text emitted AFTER P1 already returned end_turn + usage1.
    let sawHandoff = false;
    while (!sawHandoff) {
      const step = await iter.next();
      assert.equal(step.done, false, 'P1 end_turn must NOT close the stream while steer P2 is still in flight');
      assert.notEqual(step.value.type, 'turn_done', 'turn_done must wait for steer P2 to settle');
      collected.push(step.value);
      if (step.value.type === 'text_delta' && step.value.delta.includes('HANDOFF:')) {
        sawHandoff = true;
      }
    }

    // Resolve the parked tool so P2 can complete and merge usage1 + usage2.
    await service.submitToolResult({
      deviceId: DEVICE_ID,
      sessionId: 'steer-baton-session',
      runId: 'steer-baton-1',
      callId: toolCallId,
      content: [{ type: 'text', text: 'TOOL_OK' }],
    });

    for (;;) {
      const step = await iter.next();
      if (step.done) break;
      collected.push(step.value);
    }

    const doneEvents = collected.filter((ev) => ev.type === 'turn_done');
    assert.equal(doneEvents.length, 1);
    assert.equal(doneEvents[0].conversationId, 'steer-conv-1');
    assert.deepEqual(doneEvents[0].usage, {
      input: 150, // 100 + 50
      output: 65, // (20 + 10) + (30 + 5)
      cacheRead: 50, // 40 + 10
      cacheWrite: 0,
      totalTokens: 250, // 150 + 50 + ceil(50 / 1)
    });
    assert.equal(
      collected.filter((ev) => ev.type === 'text_delta').map((ev) => ev.delta).join(''),
      'P1:HANDOFF:TOOL_OK:STEER_P2',
    );

    // After turn_done, steer must reject with INVALID_STATE (409).
    await assert.rejects(
      service.steer({
        deviceId: DEVICE_ID,
        sessionId: 'steer-baton-session',
        runId: 'steer-baton-1',
        inputs: [{ text: 'late steer' }],
      }),
      (err) => err?.code === 'INVALID_STATE',
    );
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Legacy sessions.json binding (missing agentName) is marked legacy and run() immediately returns AGY_HISTORY_CHANGED', { timeout: 10_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-legacy-'));
  const agyDir = path.join(root, 'antigravity');
  const sessionsPath = path.join(agyDir, 'sessions.json');
  fs.mkdirSync(agyDir, { recursive: true });
  const key = makeSessionKey(DEVICE_ID, SESSION_ID);
  fs.writeFileSync(sessionsPath, JSON.stringify({
    [key]: { conversationId: 'legacy-conv-42', phase: 'ready', history: { messages: [] } },
  }), 'utf8');

  const store = new SessionStore(sessionsPath);
  assert.deepEqual(store.get(key), { conversationId: 'legacy-conv-42', agentName: '', legacy: true });

  const harness = createControlledAcpDriverHarness();
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(agyDir, 'gemini'),
  });
  try {
    const events = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      runId: 'legacy-run-1',
      modelId: MODEL_A,
      tools: [],
      inputs: [{ text: 'hello legacy' }],
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].code, AGY_HISTORY_CHANGED);
    assert.match(events[0].message, /\/clear/);
    assert.equal(harness.runs.length, 0);
  } finally {
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Persistence barrier blocks dispatch when store.flush() fails during beforePrompt', { timeout: 10_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-persist-barrier-'));
  let promptDispatched = 0;
  const harness = createControlledAcpDriverHarness((ctx) => {
    promptDispatched += 1;
    ctx.emit({ type: 'text', delta: 'dispatched' });
    ctx.finish();
  });
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  const origRename = fs.promises.rename;
  let failRename = true;
  t.mock.method(fs.promises, 'rename', async function (from, to) {
    if (failRename && path.basename(String(to)) === 'sessions.json') {
      throw new Error('ENOSPC sessions flush');
    }
    return origRename.call(this, from, to);
  });

  try {
    const failedEvents = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: 'barrier-session',
      runId: 'barrier-1',
      modelId: MODEL_A,
      tools: [],
      inputs: [{ text: 'Blocked by flush error' }],
    }));
    assert.equal(failedEvents.at(-1)?.type, 'error');
    assert.match(failedEvents.at(-1)?.message ?? '', /ENOSPC sessions flush/);
    assert.equal(promptDispatched, 0, 'failed beforePrompt flush must block prompt dispatch');
    assert.equal(fs.existsSync(path.join(root, 'antigravity', 'sessions.json')), false);

    failRename = false;
    const recovered = await collectRunEvents(service.run({
      deviceId: DEVICE_ID,
      sessionId: 'barrier-session',
      runId: 'barrier-2',
      modelId: MODEL_A,
      tools: [],
      inputs: [{ text: 'Recovered after storage frees up' }],
    }));
    assert.equal(recovered.at(-1)?.type, 'turn_done');
    assert.equal(promptDispatched, 1);
  } finally {
    failRename = false;
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MAX_IDLE_SESSIONS=64 evicts oldest idle drivers while preserving active runs, and isolates (deviceId, sessionId)', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-evict-iso-'));
  let activeCtx = null;
  const harness = createControlledAcpDriverHarness((ctx) => {
    if (ctx.req.prompt.includes('KEEP_ACTIVE_SESSION')) {
      activeCtx = ctx;
      return;
    }
    ctx.emit({ type: 'text', delta: 'ok' });
    ctx.finish();
  });
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    // 1. Strict (deviceId, sessionId) isolation
    const [eA1, eB1, eA2] = await Promise.all([
      collectRunEvents(service.run({ deviceId: 'dev-A', sessionId: 'shared-sess', runId: 'iso-1', modelId: MODEL_A, tools: [], inputs: [{ text: 'A1' }] })),
      collectRunEvents(service.run({ deviceId: 'dev-B', sessionId: 'shared-sess', runId: 'iso-2', modelId: MODEL_A, tools: [], inputs: [{ text: 'B1' }] })),
      collectRunEvents(service.run({ deviceId: 'dev-A', sessionId: 'other-sess', runId: 'iso-3', modelId: MODEL_A, tools: [], inputs: [{ text: 'A2' }] })),
    ]);
    assert.equal(eA1.at(-1)?.type, 'turn_done');
    assert.equal(eB1.at(-1)?.type, 'turn_done');
    assert.equal(eA2.at(-1)?.type, 'turn_done');
    const [r0, r1, r2] = harness.runs.slice(0, 3);
    assert.equal(new Set([r0.driver, r1.driver, r2.driver]).size, 3);
    assert.equal(new Set([r0.conversationId, r1.conversationId, r2.conversationId]).size, 3);
    assert.equal(new Set([r0.req.agentName, r1.req.agentName, r2.req.agentName]).size, 3);
    assert.equal(new Set([r0.mcp.token, r1.mcp.token, r2.mcp.token]).size, 3);

    // 2. Active session + 67 more idle sessions => 70 total idle sessions -> at least 6 oldest idle drivers evicted
    const activeRun = collectRunEvents(service.run({
      deviceId: 'dev-active',
      sessionId: 'active-sess',
      runId: 'active-1',
      modelId: MODEL_A,
      tools: [],
      inputs: [{ text: 'KEEP_ACTIVE_SESSION' }],
    }));
    await waitUntil(() => activeCtx, { label: 'active session start' });

    for (let i = 0; i < 67; i += 1) {
      const ev = await collectRunEvents(service.run({
        deviceId: 'dev-idle',
        sessionId: `idle-${i}`,
        runId: `idle-run-${i}`,
        modelId: MODEL_A,
        tools: [],
        inputs: [{ text: `idle ${i}` }],
      }));
      assert.equal(ev.at(-1)?.type, 'turn_done');
    }

    await waitUntil(
      () => harness.closes.filter((c) => c.cause === 'idle session limit').length >= 6,
      { label: 'idle drivers above MAX_IDLE_SESSIONS=64 to be evicted' },
    );

    const aliveDrivers = new Set(harness.runs.map((r) => r.driver).filter((d) => d.alive));
    assert.ok(aliveDrivers.size <= 65, `expected <= 64 idle + 1 active alive drivers, got ${aliveDrivers.size}`);
    assert.equal(activeCtx.driver.alive, true, 'idle eviction must never close the active session driver');

    activeCtx.emit({ type: 'text', delta: 'active-done' });
    activeCtx.finish();
    assert.equal((await activeRun).at(-1)?.type, 'turn_done');
  } finally {
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mapStopReason and TextAccumulator regression assertions', () => {
  assert.deepEqual(mapStopReason('end_turn'), { status: 'OK', aborted: false });
  assert.deepEqual(mapStopReason('cancelled'), { status: 'OK', aborted: true });
  for (const reason of ['max_tokens', 'refusal', 'max_turn_requests', 'unknown_stop_reason', undefined, null, '']) {
    const mapped = mapStopReason(reason);
    assert.equal(mapped.status, 'ERROR', `stop reason ${String(reason)} must fail closed`);
    assert.equal(mapped.aborted, false);
    assert.ok(typeof mapped.error === 'string' && mapped.error.length > 0);
  }

  // Repeated identical text chunks must be preserved verbatim (never deduplicated as cumulative resends).
  const repeated = new TextAccumulator();
  repeated.append('x'.repeat(32));
  repeated.append('x'.repeat(33));
  repeated.flush();
  assert.equal(repeated.text, 'x'.repeat(65));

  // <SYSTEM_MESSAGE> blocks split across chunk boundaries are stripped while keeping assistant text intact.
  const sanitized = new TextAccumulator();
  sanitized.append('Hello ');
  sanitized.append('The following is a <SYST');
  sanitized.append('EM_MESSAGE>\n<SYSTEM_MESSAGE>\n[Message] background noise\n</SYSTEM_MES');
  sanitized.append('SAGE>\nWorld!');
  sanitized.flush();
  assert.equal(sanitized.text, 'Hello World!');
});

test('center-server/routes.js allows bot and global model switches across AGY without Host preflight even when devices are offline', { timeout: 15_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-preflight-routes-'));
  const salt = randomBytes(16);
  const password = 'preflight-owner-password';
  const ownerPasswordHash = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;

  const bridgeCalls = [];
  let deviceOnline = false;
  let registeredDeviceId = '';

  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(5) });
  const relay = {
    getStatus: () => ({ onlineDeviceIds: deviceOnline && registeredDeviceId ? [registeredDeviceId] : [] }),
    async call(_from, target, method, params) {
      bridgeCalls.push({ target, method, params });
      throw Object.assign(new Error('Bridge should not be called during model switch'), { code: AGY_HISTORY_CHANGED });
    },
  };
  const bridge = openHostBridge({ dataRoot, store, relay });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 400 && !errorStatus[code]) code = 'INVALID_ARGUMENT';
    if (!errorStatus[code]) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash });
  const routes = registerRoutes(app, {
    store,
    packages: {},
    bridge,
    execution: {},
    oauth: {},
    linkUrl: 'wss://127.0.0.1:1',
    turns: {},
    publicUrl: 'https://center.example.com',
  });
  await app.ready();

  const cookieOf = (res, prev = '') => {
    const raw = res.headers['set-cookie'];
    const parts = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((v) => v.split(';')[0]);
    return parts.length ? parts.join('; ') : prev;
  };

  try {
    let res = await app.inject({ method: 'GET', url: '/api/session' });
    let cookie = cookieOf(res);
    res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie, 'x-csrf-token': res.json().csrfToken },
      payload: { password },
    });
    assert.equal(res.statusCode, 200);
    cookie = cookieOf(res, cookie);
    res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const csrf = res.json().csrfToken;
    cookie = cookieOf(res, cookie);
    const writeHeaders = { cookie, 'x-csrf-token': csrf };

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: writeHeaders,
      payload: { displayName: 'Offline Host', platform: 'windows' },
    });
    assert.equal(regRes.statusCode, 201);
    registeredDeviceId = regRes.json().deviceId;
    store.replaceDeviceBots(registeredDeviceId, [{
      deviceId: registeredDeviceId,
      botId: 'bot-1',
      name: 'Bot 1',
      isPrimary: true,
    }]);

    const putBotModel = (modelRef) => {
      const current = store.getBotModelConfig(registeredDeviceId, 'bot-1');
      return app.inject({
        method: 'PUT',
        url: `/api/devices/${registeredDeviceId}/bots/bot-1/model-config`,
        headers: writeHeaders,
        payload: { expectedRevision: current.revision, value: { modelRef } },
      });
    };

    // 1. Offline device: bot model switches across non-AGY -> AGY -> AGY -> non-AGY all succeed with 0 bridge calls.
    assert.equal((await putBotModel('openai/gpt-5')).statusCode, 200);
    assert.equal((await putBotModel(`${ANTIGRAVITY_PROVIDER_ID}/${MODEL_A}`)).statusCode, 200);
    assert.equal(
      store.getBotModelConfig(registeredDeviceId, 'bot-1').effective.modelRef,
      `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_A}`,
    );
    assert.equal((await putBotModel(`${ANTIGRAVITY_PROVIDER_ID}/${MODEL_B}`)).statusCode, 200);
    assert.equal((await putBotModel('openai/gpt-5')).statusCode, 200);
    assert.equal(bridgeCalls.length, 0, 'bot model switches must never call Host preflight');

    // 2. Online device: still no bridge preflight call (Host enforces continuation on turn execution instead).
    deviceOnline = true;
    assert.equal((await putBotModel(`${ANTIGRAVITY_PROVIDER_ID}/${MODEL_A}`)).statusCode, 200);
    assert.equal((await putBotModel('openai/gpt-5')).statusCode, 200);
    assert.equal(bridgeCalls.length, 0);

    // 3. Global default model switches: succeed even when registered device is offline and bots inherit global config.
    deviceOnline = false;
    const curBot = store.getBotModelConfig(registeredDeviceId, 'bot-1');
    store.putBotModelConfig(registeredDeviceId, 'bot-1', curBot.revision, {});
    const putGlobal = (modelRef) => {
      const cfg = store.getModelConfig();
      return app.inject({
        method: 'PUT',
        url: '/api/model-config',
        headers: writeHeaders,
        payload: { expectedRevision: cfg.revision, value: { modelRef } },
      });
    };
    assert.equal((await putGlobal(`${ANTIGRAVITY_PROVIDER_ID}/${MODEL_A}`)).statusCode, 200);
    assert.equal(store.getModelConfig().global.modelRef, `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_A}`);
    assert.equal((await putGlobal(`${ANTIGRAVITY_PROVIDER_ID}/${MODEL_B}`)).statusCode, 200);
    assert.equal((await putGlobal('openai/gpt-5')).statusCode, 200);
    assert.equal(store.getModelConfig().global.modelRef, 'openai/gpt-5');
    assert.equal(bridgeCalls.length, 0, 'global model switches must never call Host preflight');
  } finally {
    routes.close();
    await app.close();
    bridge.close();
    store.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
