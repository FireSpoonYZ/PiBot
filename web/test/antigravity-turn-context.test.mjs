import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_STREAM_PATH,
} from '../../center-contract/antigravity.js';
import { openAntigravity } from '../../center-server/antigravity/index.js';
import { buildThinkingProfile, resolveSessionThoughtLevel } from '../../center-server/antigravity/catalog.ts';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import { RESUME_PROMPT, toolsFromMessages } from '../../center-server/antigravity/round-trips.ts';
import { makeSessionKey, SessionStore } from '../../center-server/antigravity/sessions.ts';
import { AcpDriver } from '../../center-server/antigravity/vendor/acp/driver.ts';
import { registerAntigravityRoutes } from '../../center-server/antigravity-routes.js';
import { createAntigravityProvider } from '../../host-core/antigravity-provider.js';
import { openHost } from '../../host-core/host.js';
import {
  advanceTurnProvenance,
  createTurnProvenanceFromCutoff,
  resolveAntigravityTurnContext,
} from '../../host-core/request-context.js';
import { openRuntime } from '../../host-core/runtime.js';
import { createContextCodec } from '../../plugins/billion-context/context-codec.js';
import { renderHindsightRecall } from '../../plugins/hindsight/hindsight-format.js';

// Valid 1x1 transparent PNG (canonical base64).
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const MODEL_ID = 'gemini-3-pro';
const MODEL_REF = `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}`;
const COMPACTION_MARKER = 'compacted into the following summary';
const PENDING_STATUSES = new Set(['queued', 'placed', 'running', 'pending', 'admitted']);
const USER_ORIGIN = { sender: { kind: 'user' }, replyTo: null };
const BASE_MODEL_SEL = { modelRef: MODEL_REF, thinkingLevel: 'off', codemode: false, codemodeOnly: false };

test('ACP uses the selected model’s current thinking options for xhigh', () => {
  const thoughtOption = (...values) => ({ id: 'thought_level', options: values.map(value => ({ value })) });
  const neon = thoughtOption('low', 'medium', 'high', 'xhigh');
  const argon = thoughtOption('low', 'medium', 'high');
  assert.equal(buildThinkingProfile(neon).thinkingLevelMap.xhigh, 'xhigh');
  assert.equal(buildThinkingProfile(argon).thinkingLevelMap.xhigh, null);
  assert.equal(resolveSessionThoughtLevel('xhigh', [neon]), 'xhigh');
  assert.equal(resolveSessionThoughtLevel('xhigh', [argon]), 'high');
  assert.equal(resolveSessionThoughtLevel('xhigh', [{ id: 'model' }]), undefined);
  assert.equal(resolveSessionThoughtLevel('xhigh', undefined), 'xhigh');
});
const hindsightRoot = fileURLToPath(new URL('../../plugins/hindsight/', import.meta.url));
const hindsightManifest = JSON.parse(fs.readFileSync(path.join(hindsightRoot, 'capability.json'), 'utf8'));

const USAGE = {
  input: 12,
  output: 8,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const BASE_SYSTEM = {
  role: 'system',
  content: 'Base assistant instructions.',
  sections: { 'host-base-behavior': 'Primary and collaboration baseline.' },
  toolsAdded: [
    {
      name: 'read_file',
      description: 'Read a workspace file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
  ],
  timestamp: 1,
};

const asstText = (text, timestamp, provider = ANTIGRAVITY_PROVIDER_ID, api = ANTIGRAVITY_API, model = MODEL_ID) => ({
  role: 'assistant',
  provider,
  api,
  model,
  content: [{ type: 'text', text }],
  usage: USAGE,
  stopReason: 'stop',
  timestamp,
});

const asstToolCall = (id, name, args, timestamp) => ({
  role: 'assistant',
  provider: ANTIGRAVITY_PROVIDER_ID,
  api: ANTIGRAVITY_API,
  model: MODEL_ID,
  content: [{ type: 'toolCall', id, name, arguments: args }],
  usage: USAGE,
  stopReason: 'toolUse',
  timestamp,
});

const toolResult = (toolCallId, toolName, content, timestamp, isError = false) => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  isError,
  timestamp,
});

async function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function messageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function hasImage(msg) {
  return Array.isArray(msg?.content) && msg.content.some((b) => b?.type === 'image' && typeof b.data === 'string' && b.data.length > 0);
}

async function drainEventStream(stream) {
  const events = [];
  for await (const ev of stream) events.push(ev);
  return { events, terminal: events.at(-1) ?? null };
}

function createControlledHandle(id) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let resolveOutcome;
  const outcome = new Promise((res) => { resolveOutcome = res; });
  const push = (activity) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter(activity);
    else queue.push(activity);
  };
  return {
    handle: {
      id,
      outcome,
      next() {
        if (queue.length > 0) return Promise.resolve(queue.shift());
        if (closed) return Promise.resolve(null);
        return new Promise((resolve) => waiters.push(resolve));
      },
      pushExternal: push,
    },
    emit: push,
    settle(result) {
      if (!closed) {
        closed = true;
        while (waiters.length > 0) waiters.shift()(null);
      }
      resolveOutcome(result);
    },
  };
}

/** Controlled AcpDriver + SharedMcpBridge harness via node:test prototype mocks (never launches agy). */
function createControlledAcpDriverHarness(t) {
  const states = new WeakMap();
  const driverByListTools = new WeakMap();
  const runs = [];
  let pendingDriverForMcp = null;
  let convSeq = 1;
  let handleSeq = 1;
  let onRunHandler = null;

  const stateFor = (driver) => {
    let s = states.get(driver);
    if (!s) {
      s = { state: 'idle', active: null, conversationId: undefined, onTurnEnd: undefined, mcp: null, reentryCalls: 0, abortActive: null };
      states.set(driver, s);
    }
    return s;
  };

  const origRegister = SharedMcpBridge.prototype.registerSession;
  t.mock.setter(AcpDriver.prototype, 'onTurnEnd', function (fn) {
    stateFor(this).onTurnEnd = fn;
    pendingDriverForMcp = this;
  });
  t.mock.method(SharedMcpBridge.prototype, 'registerSession', function (handler) {
    const reg = origRegister.call(this, handler);
    const owner = pendingDriverForMcp ?? driverByListTools.get(handler.listTools);
    if (owner) {
      driverByListTools.set(handler.listTools, owner);
      // Replace the registration: prior run contexts retain their old token
      // and handler, so stale-call tests exercise the real epoch checks.
      stateFor(owner).mcp = { bridge: this, token: reg.token, handler };
    }
    pendingDriverForMcp = null;
    return reg;
  });
  t.mock.getter(AcpDriver.prototype, 'state', function () { return stateFor(this).state; });
  t.mock.getter(AcpDriver.prototype, 'activeHandle', function () { return stateFor(this).active; });
  t.mock.method(AcpDriver.prototype, 'reentry', function () { const s = stateFor(this); s.reentryCalls += 1; return s.active; });
  t.mock.method(AcpDriver.prototype, 'kickIdle', () => {});
  t.mock.method(AcpDriver.prototype, 'snapshot', function () { const s = stateFor(this); return { state: s.state, conversationId: s.conversationId }; });
  t.mock.method(AcpDriver.prototype, 'close', async function () { const s = stateFor(this); s.abortActive?.(); s.active = null; s.state = 'dead'; });
  t.mock.method(AcpDriver.prototype, 'run', async function (request) {
    const s = stateFor(this);
    if (request?.signal?.aborted) throw new Error('aborted before start');
    const ctrl = createControlledHandle(`h-${handleSeq++}`);
    const convId = request.conversationId ?? `conv-${convSeq++}`;
    s.state = 'running';
    s.active = ctrl.handle;
    s.conversationId = convId;

    const mcpTools = (s.mcp?.handler.listTools() ?? []).map((tool) => ({ name: tool.name }));
    const record = {
      driver: this,
      driverState: s,
      assignedConversationId: convId,
      request: {
        model: request.model,
        conversationId: request.conversationId ?? null,
        prompt: request.prompt,
        images: request.images ? request.images.map((img) => ({ ...img })) : undefined,
        contextBlock: request.contextBlock ? { ...request.contextBlock } : undefined,
        turnRecall: request.turnRecall,
      },
      mcpTools,
      mcp: s.mcp,
    };
    runs.push(record);

    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener('abort', onAbort);
      if (s.active === ctrl.handle) s.active = null;
      s.abortActive = null;
      s.state = 'ready';
      if (outcome.conversationId) s.conversationId = outcome.conversationId;
      s.onTurnEnd?.(outcome);
      ctrl.settle(outcome);
    };
    const onAbort = () => finish({ conversationId: s.conversationId, status: 'OK', response: '', finished: true, aborted: true });
    s.abortActive = onAbort;
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const ctx = { record, request: record.request, mcpTools, mcp: s.mcp, conversationId: convId, signal: request.signal, emit: ctrl.emit, finish };
    queueMicrotask(() => {
      if (settled) return;
      const fn = onRunHandler ?? (async (turnCtx) => {
        const reply = `ack:${turnCtx.conversationId}:turn-${runs.length}`;
        turnCtx.emit({ type: 'text', delta: reply });
        turnCtx.finish({ conversationId: turnCtx.conversationId, status: 'OK', response: reply, finished: true, aborted: false });
      });
      Promise.resolve(fn(ctx)).catch((err) => {
        record.error = err;
        finish({ conversationId: s.conversationId, status: 'ERROR', response: '', error: err instanceof Error ? err.message : String(err), finished: true, aborted: false });
      });
    });
    return ctrl.handle;
  });

  t.after(() => t.mock.restoreAll());
  return { runs, setOnRun: (fn) => { onRunHandler = fn; }, getDriverState: stateFor };
}

function openIsolatedAntigravity(rootDir) {
  const centerRoot = path.join(rootDir, 'center');
  return openAntigravity({ dataRoot: centerRoot, bin: 'mocked-agy-never-spawned', geminiHome: path.join(centerRoot, 'gemini') });
}

async function closeAndRemove({ runtime, antigravity, routes, rootDir, hadError }) {
  const errors = [];
  for (const fn of [() => routes?.close(), () => runtime?.close(), () => antigravity?.close()]) {
    try { await fn(); } catch (err) { errors.push(err); }
  }
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch (err) { errors.push(err); }
  if (!hadError && errors.length > 0) throw errors[0];
}

function makeCapability(installationId, effectiveConfig, revision = 1) {
  return { installationId, kind: 'plugin', target: 'host', targetVersion: '1.0.0', enabled: true, authorized: true, revision, effectiveConfig, credentialRefs: [] };
}

function writeTestPlugins(rootDir) {
  const bcDir = path.join(rootDir, 'plugins', 'test-bc-context');
  fs.mkdirSync(bcDir, { recursive: true });
  fs.writeFileSync(
    path.join(bcDir, 'entry.mjs'),
    `import fs from 'node:fs';
export function createPlugin({ host }) {
  const bots = new Set();
  return {
    async forBot({ effectiveConfig: cfg }) {
      const tools = cfg?.enableProbeTool ? [host.sdk.defineTool({
        name: 'ping_probe_tool',
        description: 'Dynamic test probe tool.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        replay: 'safe',
        async execute(args) { return { output: [{ type: 'text', text: 'probe:' + String(args?.query ?? '') }] }; },
      })] : [];
      const bot = {
        durableContributions: { tools },
        requestContributions: {
          async prepareContext(request) {
            const mode = cfg?.mode ?? 'bc';
            if (mode === 'passthrough') return request;
            if (mode === 'drop-current-leave-earlier-user') {
              const users = request.messages.filter((m) => m && m.role === 'user');
              const [earlier, current] = [users[0], users[users.length - 1]];
              if (cfg?.recordFile) {
                fs.writeFileSync(cfg.recordFile, JSON.stringify({
                  called: true, userCount: users.length, distinctRef: earlier !== current,
                  sameRole: earlier?.role === current?.role, sameContent: earlier?.content === current?.content,
                }));
              }
              return { messages: [request.messages[0], earlier] };
            }
            if (mode === 'drop-current-replace-with-containing-aux') {
              const current = request.messages.findLast((m) => m && m.role === 'user');
              const text = typeof current?.content === 'string' ? current.content : '';
              const aux = { role: 'user', content: '辅助上下文包装：' + text + '（仅供参考）', timestamp: current?.timestamp ?? 0 };
              if (cfg?.recordFile) {
                fs.writeFileSync(cfg.recordFile, JSON.stringify({
                  called: true, sameRole: aux.role === current?.role, sameTs: aux.timestamp === current?.timestamp,
                  containsOriginal: Boolean(text) && aux.content.includes(text), strictEqual: aux.content === text,
                }));
              }
              return { messages: [...request.messages.filter((m) => m !== current), aux] };
            }
            const cloned = JSON.parse(JSON.stringify(request.messages));
            if (cfg?.injectBcSummary) {
              const idx = cloned.findIndex((m) => m && m.role === 'assistant');
              if (idx >= 0) cloned.splice(idx + 1, 0, { role: 'user', content: [{ type: 'text', text: 'BC summary block.' }], timestamp: 0, bcSummaryMaterial: true, summaryOfBlockId: 'blk_1' });
            }
            if (cfg?.injectBcNudge) cloned.push({ role: 'user', content: 'BC nudge: keep tool output concise.', timestamp: 0 });
            return { messages: cloned };
          },
        },
        async prepare() {}, async activate() {}, async quiesce() {}, async close() { bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map((b) => b.close())); },
  };
}
`,
  );

  const installed = new Map([
    ['test-bc-context', { version: '1.0.0', packageRoot: bcDir, dataDir: path.join(bcDir, 'data'), manifest: { id: 'test.bc-context', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } } }],
    ['test-hindsight-recall', { version: hindsightManifest.version, packageRoot: hindsightRoot, dataDir: path.join(rootDir, 'hindsight-data'), manifest: hindsightManifest }],
  ]);
  const questionnaireRoot = fileURLToPath(new URL('../../plugins/ask-user-question/', import.meta.url));
  const questionnaireManifest = JSON.parse(fs.readFileSync(path.join(questionnaireRoot, 'capability.json'), 'utf8'));
  installed.set('test-questionnaire', { version: questionnaireManifest.version, packageRoot: questionnaireRoot,
    dataDir: path.join(rootDir, 'questionnaire-data'), manifest: questionnaireManifest });
  return { async getInstalled(id, opts) { const e = installed.get(id); return !e || (opts?.version && e.version !== opts.version) ? null : e; } };
}

async function openTestHostRuntime({ rootDir, antigravity, capturedPayloads, callOperation }) {
  const installer = writeTestPlugins(rootDir);
  const hostDataRoot = path.join(rootDir, 'host-data');
  const meta = openHost({ dataRoot: hostDataRoot });
  const deviceId = meta.deviceId;
  meta.close();

  let runtime = null;
  let currentSnapshot = null;

  const centerClient = {
    callOperation,
    providerAuth: async () => ({ auth: { apiKey: 'center-managed' }, source: 'center' }),
    streamAntigravity(payload, opts) {
      capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
      return antigravity.stream(
        {
          deviceId,
          sessionId: payload.sessionId,
          modelId: payload.modelId,
          messages: payload.messages,
          ...(payload.reasoning !== undefined ? { reasoning: payload.reasoning } : {}),
          ...(Object.hasOwn(payload, 'turnContext') ? { turnContext: payload.turnContext } : {}),
        },
        { signal: opts?.signal },
      );
    },
  };

  runtime = await openRuntime({
    dataRoot: hostDataRoot,
    nativeBridge: async () => ({}),
    centerRuntime: {
      snapshot: { protocol: 1 },
      installer,
      getClient: () => centerClient,
      prepareTurn: async () => ({ setId: `set-rev-${currentSnapshot.revision}`, snapshot: currentSnapshot }),
      confirmTurn: async ({ requestId, setId }) => ({ admissionId: `adm-${requestId}`, setId }),
      restoreTurn: async () => ({ setId: `set-rev-${currentSnapshot.revision}`, snapshot: currentSnapshot }),
    },
  });

  const makeSnapshot = (revision, bots) => ({
    protocol: 1,
    deviceId,
    revision,
    providers: [{ id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', api: ANTIGRAVITY_API, baseUrl: '', enabled: true, credentialRef: null, native: true, authMode: 'oauth' }],
    models: { [ANTIGRAVITY_PROVIDER_ID]: [{ id: MODEL_ID, name: 'Gemini 3 Pro', api: ANTIGRAVITY_API, contextWindow: 128_000, maxTokens: 8_192, input: ['text', 'image'], reasoning: true, enabled: true, revision: 1 }] },
    credentials: {},
    bots,
  });

  const applySnapshot = async (snapshot) => {
    currentSnapshot = snapshot;
    await waitUntil(async () => {
      const res = await runtime.applyCenterSnapshot(snapshot);
      if (res.status === 'failed') throw new Error(`applyCenterSnapshot failed: ${JSON.stringify(res)}`);
      return res.status === 'applied';
    }, { label: `applyCenterSnapshot rev=${snapshot.revision}` });
  };

  const waitForSubmission = (botId, requestId) =>
    waitUntil(async () => {
      const sub = await runtime.getSubmission(botId, requestId);
      return sub && !PENDING_STATUSES.has(sub.status) ? sub : null;
    }, { label: `submission ${requestId}` });

  try {
    await applySnapshot(makeSnapshot(1, []));
    await runtime.setCenterOnline(true);
    await runtime.restoreTurns();
    runtime.resume();
    return { runtime, makeSnapshot, applySnapshot, waitForSubmission };
  } catch (err) {
    try { await runtime.close(); } catch { /* preserve startup error */ }
    throw err;
  }
}

// 1. Real Host Runtime + pi-durable GenerationTask -> openAntigravity.stream (3 turns)
test('Real Host Runtime + Durable -> openAntigravity: trailing SDK SystemEntry (toolsAdded/toolsRemoved), BC deep-clone + recall, text+image & pure-image, and parked continuation', async (t) => {
  const driverHarness = createControlledAcpDriverHarness(t);
  const recallText = 'Verified tool probes.';
  const recallQueries = [];
  const recallServer = http.createServer(async (req, res) => {
    let result = { items: [] };
    if (req.method === 'POST' && req.url.endsWith('/memories/recall')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      recallQueries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).query);
      result = { results: [{ id: 'qa-probe', text: recallText, type: 'observation' }], source_facts: {} };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => recallServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    recallServer.close(resolve);
    recallServer.closeAllConnections();
  }));
  const recallBaseUrl = `http://127.0.0.1:${recallServer.address().port}`;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-e2e-'));
  const botCwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(botCwd, { recursive: true });

  let antigravity = null;
  let runtime = null;
  let hadError = false;
  try {
    antigravity = openIsolatedAntigravity(rootDir);
    const captured = [];
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;

    const bot = await runtime.createBot({ requestId: 'create-e2e-bot', role: 'AcpAssistant', cwd: botCwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [] }]));
    const img = await runtime.uploadAttachment(bot.botId, { name: 'p.png', mimeType: 'image/png', data: PNG_1X1 });

    let stage = 1;
    let observedToolResult = null;
    driverHarness.setOnRun(async (ctx) => {
      if (stage === 1) {
        ctx.emit({ type: 'text', delta: '第一轮已收到 ALPHA-7' });
        ctx.finish({ conversationId: 'conv-e2e', status: 'OK', response: '第一轮已收到 ALPHA-7', finished: true, aborted: false });
        return;
      }
      if (stage === 2) {
        observedToolResult = await ctx.mcp.handler.onToolCall('call_e2e_1', 'ping_probe_tool', { query: 'acp-check' }, ctx.signal ?? new AbortController().signal);
        const toolText = (observedToolResult?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const reply = `工具结果确认：${toolText}`;
        ctx.emit({ type: 'text', delta: reply });
        ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: reply, finished: true, aborted: false });
        return;
      }
      ctx.emit({ type: 'text', delta: '纯图第三轮已收到' });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: '纯图第三轮已收到', finished: true, aborted: false });
    });

    // Turn 1: initial leading SystemEntry + ACP session bind
    await runtime.submit(bot.botId, { requestId: 'e2e-t1', text: '第一轮请记住暗号 ALPHA-7', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'e2e-t1')).status, 'done');
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].turnContext.auxiliaryIndices, []);
    assert.ok(messageText(captured[0].messages[captured[0].turnContext.inputIndex]).includes('第一轮请记住暗号 ALPHA-7'));

    // Turn 2: update SOUL + add ping_probe_tool + BC deep-clone/summary/nudge + Hindsight recall + text+image + tool call
    stage = 2;
    const soul = await runtime.getBotSoul(bot.botId);
    await runtime.setBotSoul(bot.botId, { expectedRevision: soul.revision, text: `${soul.text}\nTurn 2 rule: use ping_probe_tool.` });
    const caps = (enableProbeTool, rev) => [
      makeCapability('test-bc-context', { mode: 'bc', enableProbeTool, injectBcSummary: true, injectBcNudge: true }, rev),
      { ...makeCapability('test-hindsight-recall', { baseUrl: recallBaseUrl, mode: 'read-only' }), targetVersion: hindsightManifest.version },
    ];
    await env.applySnapshot(env.makeSnapshot(3, [{ botId: bot.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: caps(true, 1) }]));
    await runtime.submit(bot.botId, { requestId: 'e2e-t2', text: '第二轮请看图并使用新工具', attachments: [img.id], origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'e2e-t2')).status, 'done');

    assert.equal(captured.length, 3); // T1, T2 Call 1, T2 Call 2 continuation
    assert.equal(driverHarness.runs.length, 2); // Call 2 uses reentry(), no second driver.run
    const tc2 = captured[1].turnContext;
    assert.ok(messageText(captured[1].messages[tc2.inputIndex]).includes('第二轮请看图并使用新工具'));
    assert.equal(hasImage(captured[1].messages[tc2.inputIndex]), true);
    assert.ok(captured[1].messages.slice(tc2.inputIndex + 1).some((m) => m.role === 'system' && (m.toolsAdded ?? []).some((x) => x.name === 'ping_probe_tool')));
    assert.ok(tc2.auxiliaryIndices.length >= 3);
    for (let i = 0; i < tc2.auxiliaryIndices.length; i += 1) {
      if (i > 0) assert.ok(tc2.auxiliaryIndices[i] > tc2.auxiliaryIndices[i - 1]);
      assert.notEqual(tc2.auxiliaryIndices[i], tc2.inputIndex);
      assert.equal(captured[1].messages[tc2.auxiliaryIndices[i]]?.role, 'user');
    }

    const run2 = driverHarness.runs[1];
    assert.equal(run2.request.conversationId, null, 'SOUL and tool changes must rebuild the native context');
    assert.ok(run2.request.contextBlock?.text.includes('第一轮请记住暗号 ALPHA-7'));
    assert.ok(run2.request.contextBlock?.text.includes('第一轮已收到 ALPHA-7'));
    assert.ok(run2.request.prompt.indexOf('BC nudge: keep tool output concise.') < run2.request.prompt.indexOf('第二轮请看图并使用新工具'));
    const projectedRecall = captured[1].messages.find((m) => m.hindsightRecall === true);
    assert.ok(projectedRecall && messageText(projectedRecall).includes(recallText));
    assert.equal(run2.request.turnRecall, messageText(projectedRecall));
    assert.ok(!run2.request.prompt.includes(recallText));
    assert.ok(!(run2.request.contextBlock?.text ?? '').includes(recallText));
    assert.ok(recallQueries.some((query) => query.includes('第二轮请看图并使用新工具')));
    assert.deepEqual(run2.request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    assert.ok(!(run2.request.contextBlock?.text ?? '').includes('第二轮请看图并使用新工具'));
    assert.ok(run2.mcpTools.some((tool) => tool.name === 'ping_probe_tool'));
    assert.equal(captured[2].messages[captured[2].turnContext.inputIndex]?.role, 'toolResult');
    assert.ok(observedToolResult && run2.driverState.reentryCalls >= 1);
    const durableHistory = JSON.stringify((await runtime.history(bot.botId, { limit: 50 })).items);
    assert.ok(durableHistory.includes('工具结果确认：probe:acp-check'));
    assert.ok(!durableHistory.includes(recallText));

    // Turn 3: remove ping_probe_tool + pure-image user
    stage = 3;
    await env.applySnapshot(env.makeSnapshot(4, [{ botId: bot.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: caps(false, 2) }]));
    await runtime.submit(bot.botId, { requestId: 'e2e-t3', text: '', attachments: [img.id], origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'e2e-t3')).status, 'done');

    const tc3 = captured[3].turnContext;
    assert.equal(messageText(captured[3].messages[tc3.inputIndex]), '');
    assert.equal(hasImage(captured[3].messages[tc3.inputIndex]), true);
    assert.ok(captured[3].messages.slice(tc3.inputIndex + 1).some((m) => m.role === 'system' && (m.toolsRemoved ?? []).some((x) => x.name === 'ping_probe_tool')));
    assert.equal(driverHarness.runs[2].request.conversationId, null, 'removing a tool must rebuild the native context');
    assert.deepEqual(driverHarness.runs[2].request.images, [
      { data: PNG_1X1, mimeType: 'image/png' }, // Retained Turn 2 image.
      { data: PNG_1X1, mimeType: 'image/png' }, // Current Turn 3 image.
    ]);
    assert.equal(driverHarness.runs[2].request.turnRecall, undefined);
    assert.ok(!driverHarness.runs[2].mcpTools.some((tool) => tool.name === 'ping_probe_tool'));
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir, hadError });
  }
});

test('ACP Code Mode only keeps the top-level catalog fixed while a nested deferred tool runs', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-codemode-'));
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  const calls = [];
  let runtime;
  try {
    const env = await openTestHostRuntime({
      rootDir, antigravity, capturedPayloads: captured,
      async callOperation(call) {
        calls.push(call);
        return { tasks: [], timeZone: 'Europe/Amsterdam' };
      },
    });
    runtime = env.runtime;
    const cwd = path.join(rootDir, 'workspace');
    fs.mkdirSync(cwd);
    const bot = await runtime.createBot({ requestId: 'create-code-mode', role: 'ACP Assistant', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{
      botId: bot.botId, cwd, model: { ...BASE_MODEL_SEL, codemodeOnly: true },
      capabilities: [{ ...makeCapability('test-questionnaire', {}), targetVersion: '1.1.0' }],
    }]));

    driver.setOnRun(async (ctx) => {
      const declared = toolsFromMessages(captured[0].messages);
      assert.deepEqual(ctx.mcp.handler.listTools(), declared.map(({ name, description, parameters }) => ({
        name, description, inputSchema: parameters,
      })));
      assert.ok(declared.some((tool) => tool.name === 'ask_user_question'));
      assert.ok(declared.some((tool) => tool.name === 'bridge_poll_result'));
      assert.ok(!declared.some((tool) => tool.name === 'tool_search' || tool.name === 'automation_schedule_list'));
      const stale = await ctx.mcp.handler.onToolCall('stale', 'automation_schedule_list', {}, ctx.signal);
      assert.equal(stale.isError, true);

      const result = await ctx.mcp.handler.onToolCall('code-mode', 'codemode', {
        code: `
          const [match] = await searchTools("automation_schedule_list", { limit: 1 });
          if (match?.name !== "automation_schedule_list") throw new Error("Missing deferred tool");
          if (!(await describeTool(match.name))) throw new Error("Missing schema");
          text(await tools[match.name]({}));
        `,
      }, ctx.signal);
      assert.equal(result.isError, false, JSON.stringify(result));
      const response = result.content.map((block) => block.text ?? '').join('');
      assert.match(response, /Europe\/Amsterdam/);
      ctx.emit({ type: 'text', delta: response });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response, finished: true, aborted: false });
    });

    await runtime.submit(bot.botId, { requestId: 'nested-list', text: 'List my schedules with Code Mode.' });
    const receipt = await env.waitForSubmission(bot.botId, 'nested-list');
    if (driver.runs[0]?.error) throw driver.runs[0].error;
    assert.equal(receipt.status, 'done', JSON.stringify(receipt));
    assert.deepEqual(calls, [{ botId: bot.botId, name: 'automation_schedule_list', args: {} }]);
    assert.equal(driver.runs.length, 1);
    assert.equal(captured.length, 2);
    assert.deepEqual(toolsFromMessages(captured[1].messages), toolsFromMessages(captured[0].messages));
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir });
  }
});

test('Antigravity sends the detached questionnaire answer as a fresh authoritative input', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-wait-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  let runtime;
  let hadError = false;
  try {
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'create-acp-wait', role: 'Acp Assistant', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [
      { ...makeCapability('test-questionnaire', {}), targetVersion: '1.1.0' },
    ] }]));
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        await ctx.mcp.handler.onToolCall('wait-question', 'ask_user_question', {
          questions: [{ header: 'Design', question: 'Pick a finish', options: [
            { label: 'Copper', description: 'Warm' }, { label: 'Steel', description: 'Cool' },
          ] }],
        }, ctx.signal ?? new AbortController().signal);
      }
      ctx.emit({ type: 'text', delta: 'ack' });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'ack', finished: true, aborted: false });
    });
    await runtime.submit(bot.botId, { requestId: 'acp-wait-input', text: 'Pick a finish first' });
    assert.equal((await env.waitForSubmission(bot.botId, 'acp-wait-input')).status, 'done');
    const history = (await runtime.history(bot.botId, { limit: 30 })).items;
    const question = history.flatMap(entry => entry.model ?? []).find(message => message.durableWait === true)?.details.presentation;
    assert.equal(question?.status, 'pending');

    const { result } = await runtime.callCapabilityAction('test-questionnaire', 'answerQuestionnaire', {
      requestId: 'acp-wait-answer', deviceId: (await runtime.getCurrentDevice()).deviceId, botId: bot.botId,
      input: { conversationId: question.conversationId, requestId: question.requestId,
        cancelled: false, answers: [{ questionIndex: 0, selectedOptions: [0] }] },
    });
    assert.equal(result.status, 'answered');
    const key = createHash('sha256').update(JSON.stringify([
      bot.primaryConversationId, question.installationId, question.conversationId, question.requestId,
    ])).digest('hex');
    const receipt = await env.waitForSubmission(bot.botId, `wait-${key.slice(0, 40)}`);
    assert.equal(receipt.status, 'done', JSON.stringify(receipt));
    assert.equal(driver.runs.length, 2, `Captured ACP requests: ${JSON.stringify(captured.map(p => p.turnContext))}`);
    const resumed = captured.at(-1);
    const liveInput = resumed.messages[resumed.turnContext.inputIndex];
    assert.equal(liveInput.role, 'user');
    assert.match(messageText(liveInput), /Pick a finish.*Copper/);
    assert.doesNotMatch(messageText(liveInput), /Pick a finish first/);
    assert.match(driver.runs[1].request.prompt, /Copper/);
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir, hadError });
  }
});

// 2. Host Fail-Closed Regressions (Real Runtime + Exact Narrow Provenance/Codec Helpers):
//    - Real Host: deleted current input leaving earlier same-text user, or replaced by same-metadata containing auxiliary
//    - Narrow helpers: exact same-timestamp A/B, in-place replace with older object, proven-earlier ref among deep-equal,
//      sideband turnProvenance cannot alter toolResult role/toolCallId, BC native marked auxiliary + legitimate tag rewrite
test('Host projection fail-closed: deleted current input (real runtime & exact provenance/codec helpers) never sends stale or spoofed input', async (t) => {
  // 2a: Exact provenance & BC codec guards (deterministic, zero clock mocking)
  const sys = { role: 'system', content: '', timestamp: 1 };
  const prior = { role: 'user', content: 'prior', timestamp: 2 };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'ack' }], timestamp: 3 };
  const current = { role: 'user', content: 'new', timestamp: 4 };

  // In-place delete current, replace with older object in beforeRequest stage
  {
    const raw = [sys, prior, reply, current];
    const proj = structuredClone(raw);
    const p = createTurnProvenanceFromCutoff(raw, raw, { messages: proj }, 10);
    proj[3] = proj[1];
    assert.throws(() => resolveAntigravityTurnContext(advanceTurnProvenance(p, proj, { allowAppendAuxiliaryUsers: true }), proj));
  }

  // Exact same-timestamp Branch A: known earlier ref or cloned earlier-only copy cannot stand in for deleted deep-equal current user
  {
    const newIdentical = { ...prior };
    const rawDup = [sys, prior, reply, newIdentical];
    assert.throws(() => createTurnProvenanceFromCutoff(rawDup, rawDup, { messages: [sys, prior, reply, prior] }, 10));
    assert.throws(() => createTurnProvenanceFromCutoff(rawDup, rawDup, { messages: [sys, prior] }, 10));
    assert.throws(() => createTurnProvenanceFromCutoff(rawDup, rawDup, { messages: [sys, structuredClone(prior)] }, 10));
  }

  // Exact same-timestamp Branch B: deleted current input replaced by same-metadata auxiliary merely containing original text
  assert.throws(() =>
    createTurnProvenanceFromCutoff(
      [sys, current],
      [sys, current],
      { messages: [sys, { role: 'user', content: `辅助上下文包装：${current.content}（仅供参考）`, timestamp: current.timestamp }] },
      10,
    ),
  );

  // Sideband turnProvenance cannot alter toolResult role or toolCallId
  {
    const rawTool = [sys, { role: 'toolResult', toolCallId: 'call1', toolName: 'read', content: [{ type: 'text', text: 'result' }], timestamp: 4 }];
    const proof = { cutoff: 10, inputIndex: 1, lostInput: false, auxiliaryIndices: [] };
    assert.throws(() => createTurnProvenanceFromCutoff(rawTool, rawTool, { messages: [sys, current], turnProvenance: proof }, 10));
    assert.throws(() => createTurnProvenanceFromCutoff(rawTool, rawTool, { messages: [sys, { ...rawTool[1], toolCallId: 'obsolete' }], turnProvenance: proof }, 10));
  }

  // BC native marked auxiliary survives codec as auxiliary after current, and legitimate BC tag rewrite resolves cleanly
  {
    const aux = { role: 'user', content: 'summary', bcContextMaterial: true, timestamp: 0 };
    const msgs = [sys, current, aux];
    const codec = createContextCodec({ messages: msgs, entries: msgs.map((_, id) => ({ id: id + 1 })), contributions: msgs.map((m) => [m]) });
    const p = codec.restoreWithProvenance(codec.messages);
    assert.equal(p.inputIndex, 1);
    assert.deepEqual(p.auxiliaryIndices, [2]);

    const bcBase = [sys, current];
    const bcCodec = createContextCodec({ messages: bcBase, entries: bcBase.map((_, id) => ({ id: id + 1 })), contributions: bcBase.map((m) => [m]) });
    const tagged = [
      bcCodec.messages[0],
      { ...bcCodec.messages[1], text: `[msg_id=e2:m0]\n${current.content}` },
      { id: 'acp_summary_1', role: 'user', contentType: 'text', text: 'BC summary block.', summaryOfBlockId: 'blk_1' },
    ];
    const rewritten = bcCodec.restoreWithProvenance(tagged);
    const rewrittenMsgs = rewritten.messages ?? bcCodec.restore(tagged);
    assert.equal(rewritten.inputIndex, 1);
    assert.deepEqual(rewritten.auxiliaryIndices, [2]);
    const bcProv = createTurnProvenanceFromCutoff(
      bcBase,
      bcBase,
      { messages: rewrittenMsgs, turnProvenance: { cutoff: 10, inputIndex: rewritten.inputIndex, lostInput: false, auxiliaryIndices: rewritten.auxiliaryIndices } },
      10,
    );
    assert.deepEqual(resolveAntigravityTurnContext(bcProv, rewrittenMsgs), { inputIndex: 1, auxiliaryIndices: [2] });
  }

  // 2b: Real Host openRuntime + prepareContext fail-closed verification (no global Date.now mock)
  const driverHarness = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-failclosed-'));
  const botCwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(botCwd, { recursive: true });

  let antigravity = null;
  let runtime = null;
  let hadError = false;
  try {
    antigravity = openIsolatedAntigravity(rootDir);
    const captured = [];
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;

    const botA = await runtime.createBot({ requestId: 'fc-bot-a', role: 'FailClosedA', cwd: botCwd, makePrimary: true });
    const botB = await runtime.createBot({ requestId: 'fc-bot-b', role: 'FailClosedB', cwd: botCwd });

    // Real Host Branch A: Turn 2 drops current input leaving only earlier same-text user
    await env.applySnapshot(env.makeSnapshot(2, [
      { botId: botA.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [makeCapability('test-bc-context', { mode: 'passthrough' }, 1)] },
      { botId: botB.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [] },
    ]));
    await runtime.submit(botA.botId, { requestId: 'fc-a-t1', text: '重复探针消息', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(botA.botId, 'fc-a-t1')).status, 'done');
    assert.equal(captured.length, 1);

    const recFileA = path.join(rootDir, 'branch-a.json');
    await env.applySnapshot(env.makeSnapshot(3, [
      { botId: botA.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [makeCapability('test-bc-context', { mode: 'drop-current-leave-earlier-user', recordFile: recFileA }, 2)] },
      { botId: botB.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [] },
    ]));
    await runtime.submit(botA.botId, { requestId: 'fc-a-t2', text: '重复探针消息', origin: USER_ORIGIN });
    const subA = await env.waitForSubmission(botA.botId, 'fc-a-t2');

    assert.deepEqual(JSON.parse(fs.readFileSync(recFileA, 'utf8')), { called: true, userCount: 2, distinctRef: true, sameRole: true, sameContent: true });
    assert.notEqual(subA.status, 'done');
    assert.equal(captured.length, 1, 'Branch A must fail closed before streamAntigravity');
    assert.equal(driverHarness.runs.length, 1);

    // Real Host Branch B: current input deleted and replaced by same-metadata auxiliary merely containing original text
    const recFileB = path.join(rootDir, 'branch-b.json');
    await env.applySnapshot(env.makeSnapshot(4, [
      { botId: botA.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [] },
      { botId: botB.botId, cwd: botCwd, model: BASE_MODEL_SEL, capabilities: [makeCapability('test-bc-context', { mode: 'drop-current-replace-with-containing-aux', recordFile: recFileB }, 1)] },
    ]));
    await runtime.submit(botB.botId, { requestId: 'fc-b-t1', text: '原输入关键词-BETA', origin: USER_ORIGIN });
    const subB = await env.waitForSubmission(botB.botId, 'fc-b-t1');

    assert.deepEqual(JSON.parse(fs.readFileSync(recFileB, 'utf8')), { called: true, sameRole: true, sameTs: true, containsOriginal: true, strictEqual: false });
    assert.notEqual(subB.status, 'done');
    assert.equal(captured.length, 1, 'Branch B must fail closed before streamAntigravity');
    assert.equal(driverHarness.runs.length, 1);
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir, hadError });
  }
});

// 3. New & Legacy Host Matrix + Mid-History Auxiliary COMPACTION_MARKER Guard
test('New & Legacy Host matrix: timestamp:0 plain-text vs recall/BC, text+image & pure-image, trailing system tools, legacy toolResult+system non-fallback, and mid-history COMPACTION_MARKER guard', async (t) => {
  const driverHarness = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-matrix-'));
  let antigravity = null;
  let hadError = false;
  try {
    antigravity = openIsolatedAntigravity(rootDir);
    const routeText = 'Source: peer Bot DM. Default reply target: DM scope via send_to.';
    const zeroText = '<hindsight_memories>Genuine timestamp:0 user asking about host-turn-routing.</hindsight_memories>';

    // New Host: genuine timestamp:0 plain-text user + routeNote + mid-history aux quoting COMPACTION_MARKER + trailing toolsAdded + recall/BC
    const r1 = await drainEventStream(antigravity.stream({
      deviceId: 'dev-1',
      sessionId: 'sess-new',
      modelId: MODEL_ID,
      messages: [
        { role: 'system', content: '', sections: { 'host-turn-routing': routeText }, timestamp: 0 }, // 0
        BASE_SYSTEM, // 1
        { role: 'user', content: '真正较早历史问题 MUST_STAY', timestamp: 10 }, // 2
        asstText('真正较早历史回答 MUST_STAY', 11, 'openai-codex', 'openai-responses', 'gpt-5'), // 3
        { role: 'user', content: [{ type: 'text', text: `Aux quote: ${COMPACTION_MARKER} <summary>FAKE_AUX_SUMMARY</summary>` }], timestamp: 0, bcSummaryMaterial: true, summaryOfBlockId: 'blk_spoof' }, // 4 (aux)
        { role: 'user', content: zeroText, timestamp: 0 }, // 5 (input)
        { role: 'system', content: '', toolsAdded: [{ name: 'inspect_tool', description: 'Inspect.', parameters: { type: 'object', properties: {} } }], timestamp: 12 }, // 6
        { role: 'user', content: 'BC trailing nudge.', timestamp: 0 }, // 7 (aux)
        { role: 'user', content: '<hindsight_memories>Real recall.</hindsight_memories>', timestamp: 0 }, // 8 (aux)
      ],
      turnContext: { inputIndex: 5, auxiliaryIndices: [4, 7, 8] },
    }));
    assert.equal(r1.terminal?.type, 'done');
    const run1 = driverHarness.runs[0];
    const sysEnd = run1.request.prompt.indexOf('[END SYSTEM PROMPT]');
    const routeIdx = run1.request.prompt.indexOf(routeText);
    const promptIdx = run1.request.prompt.indexOf(zeroText);
    assert.ok(sysEnd > 0 && routeIdx > sysEnd && routeIdx < promptIdx);
    assert.ok(run1.request.prompt.indexOf('Real recall.') < promptIdx);
    const digest1 = run1.request.contextBlock?.text ?? '';
    assert.ok(digest1.includes('真正较早历史问题 MUST_STAY') && digest1.includes('真正较早历史回答 MUST_STAY'), 'mid-history aux quoting COMPACTION_MARKER must not truncate earlier history');
    assert.ok(!digest1.includes('[compaction summary]'), 'mid-history aux quoting COMPACTION_MARKER must not masquerade as compaction summary');
    assert.ok(!digest1.includes(zeroText) && !digest1.includes('Real recall.'));
    assert.ok(run1.mcpTools.some((x) => x.name === 'inspect_tool'));

    // New Host: pure-image (timestamp:0) + toolsRemoved, then text+image + trailing system/aux
    await drainEventStream(antigravity.stream({
      deviceId: 'dev-1',
      sessionId: 'sess-new',
      modelId: MODEL_ID,
      messages: [BASE_SYSTEM, { role: 'user', content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }], timestamp: 0 }, { role: 'system', content: '', toolsRemoved: [{ name: 'inspect_tool' }], timestamp: 20 }, { role: 'user', content: 'BC nudge.', timestamp: 0 }],
      turnContext: { inputIndex: 1, auxiliaryIndices: [3] },
    }));
    assert.equal(driverHarness.runs[1].request.conversationId, null, 'removed history must not reuse the old native binding');
    assert.deepEqual(driverHarness.runs[1].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    assert.ok(!driverHarness.runs[1].mcpTools.some((x) => x.name === 'inspect_tool'));

    await drainEventStream(antigravity.stream({
      deviceId: 'dev-1',
      sessionId: 'sess-new',
      modelId: MODEL_ID,
      messages: [BASE_SYSTEM, { role: 'user', content: [{ type: 'text', text: '文图混合输入' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }], timestamp: 0 }, { role: 'system', content: '', sections: { delta: 'ok' }, timestamp: 25 }, { role: 'user', content: '<hindsight_memories>Hint.</hindsight_memories>', timestamp: 0 }],
      turnContext: { inputIndex: 1, auxiliaryIndices: [3] },
    }));
    assert.ok(driverHarness.runs[2].request.prompt.includes('文图混合输入'));
    assert.deepEqual(driverHarness.runs[2].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    assert.ok(!(driverHarness.runs[2].request.contextBlock?.text ?? '').includes('文图混合输入'));

    // Legacy Host (no turnContext): non-zero-ts user + toolsAdded; pure-image + toolsRemoved; unbound toolResult+system non-fallback; bound toolResult+system resume
    await drainEventStream(antigravity.stream({
      deviceId: 'dev-leg',
      sessionId: 'sess-leg',
      modelId: MODEL_ID,
      messages: [
        BASE_SYSTEM,
        { role: 'user', content: '老历史问题', timestamp: 100 },
        asstText('老历史回答', 101, 'openai-codex', 'openai-responses', 'gpt-5'),
        { role: 'user', content: '老 Host 用户输入', timestamp: 102 },
        { role: 'system', content: '', toolsAdded: [{ name: 'legacy_tool', description: 'L', parameters: { type: 'object', properties: {} } }], timestamp: 103 },
        { role: 'user', content: 'BC legacy.', timestamp: 0, bcContextMaterial: true },
        { role: 'user', content: '<hindsight_memories>Legacy recall.</hindsight_memories>', timestamp: 0 },
      ],
    }));
    const runLeg1 = driverHarness.runs[3];
    assert.ok(runLeg1.request.prompt.includes('老 Host 用户输入'));
    assert.ok(!(runLeg1.request.contextBlock?.text ?? '').includes('老 Host 用户输入'));
    assert.ok(runLeg1.mcpTools.some((x) => x.name === 'legacy_tool'));

    await drainEventStream(antigravity.stream({
      deviceId: 'dev-leg',
      sessionId: 'sess-leg',
      modelId: MODEL_ID,
      messages: [BASE_SYSTEM, { role: 'user', content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }], timestamp: 0 }, { role: 'system', content: '', toolsRemoved: [{ name: 'legacy_tool' }], timestamp: 110 }, { role: 'user', content: '<hindsight_memories>Recall.</hindsight_memories>', timestamp: 0 }],
    }));
    assert.deepEqual(driverHarness.runs[4].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    assert.ok(!driverHarness.runs[4].mcpTools.some((x) => x.name === 'legacy_tool'));

    const toolThenSys = [
      BASE_SYSTEM,
      { role: 'user', content: '绝不回退重发的旧输入', timestamp: 200 },
      asstToolCall('tc_leg', 'read_file', { path: 'a' }, 201),
      toolResult('tc_leg', 'read_file', 'ok', 202),
      { role: 'system', content: '', sections: { delta: 'post-tool' }, timestamp: 203 },
      { role: 'user', content: '<hindsight_memories>Recall.</hindsight_memories>', timestamp: 0 },
    ];
    const legUnbound = await drainEventStream(antigravity.stream({ deviceId: 'dev-leg', sessionId: 'sess-leg-unbound', modelId: MODEL_ID, messages: toolThenSys }));
    assert.equal(legUnbound.terminal?.type, 'error');
    assert.equal(driverHarness.runs.length, 5, 'legacy unbound toolResult+system must not fall back to older user');

    const legBound = await drainEventStream(antigravity.stream({ deviceId: 'dev-leg', sessionId: 'sess-leg', modelId: MODEL_ID, messages: toolThenSys }));
    assert.equal(legBound.terminal?.type, 'done');
    assert.equal(driverHarness.runs[5].request.conversationId, null, 'rewritten legacy history requires a new native context');
    assert.ok(driverHarness.runs[5].request.prompt.includes(RESUME_PROMPT));
    assert.ok(!driverHarness.runs[5].request.prompt.includes('绝不回退重发的旧输入'));
    assert.ok(driverHarness.runs[5].request.contextBlock?.text.includes('绝不回退重发的旧输入'));
    assert.ok(driverHarness.runs[5].request.contextBlock?.text.includes('"toolCallId":"tc_leg"'));
    assert.ok(driverHarness.runs[5].request.contextBlock?.text.includes('"text":"ok"'));
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ antigravity, rootDir, hadError });
  }
});

// 4. Parked Tool Continuation (No Prompt Resend), Bound Resume & Device+Session Isolation
test('Preserves parked tool continuation without resending prompt, bound assistant resume, and (deviceId, sessionId) isolation', async (t) => {
  const driverHarness = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cont-'));
  let antigravity = null;
  let hadError = false;
  try {
    antigravity = openIsolatedAntigravity(rootDir);
    let parkedResult = null;
    let parkedDriver = null;
    driverHarness.setOnRun(async (ctx) => {
      if (ctx.request.prompt.includes('TRIGGER_PARK')) {
        parkedDriver = ctx.record.driver;
        parkedResult = await ctx.mcp.handler.onToolCall('tc_1', 'read_file', { path: 'README.md' }, ctx.signal ?? new AbortController().signal);
        const text = (parkedResult.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        ctx.emit({ type: 'text', delta: `resumed:${text}` });
        ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: `resumed:${text}`, finished: true, aborted: false });
        return;
      }
      ctx.emit({ type: 'text', delta: `ok:${ctx.conversationId}` });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: `ok:${ctx.conversationId}`, finished: true, aborted: false });
    });

    const call1 = await drainEventStream(antigravity.stream({
      deviceId: 'dev-a',
      sessionId: 'shared',
      modelId: MODEL_ID,
      messages: [
        BASE_SYSTEM,
        { role: 'user', content: 'TRIGGER_PARK: read README.md', timestamp: 10 },
        { role: 'user', content: '<hindsight_memories>Recall.</hindsight_memories>', timestamp: 0 },
      ],
      turnContext: { inputIndex: 1, auxiliaryIndices: [2] },
    }));
    assert.equal(call1.terminal?.reason, 'toolUse');

    const call2 = await drainEventStream(antigravity.stream({
      deviceId: 'dev-a',
      sessionId: 'shared',
      modelId: MODEL_ID,
      messages: [
        BASE_SYSTEM,
        { role: 'user', content: 'TRIGGER_PARK: read README.md', timestamp: 10 },
        asstToolCall('tc_1', 'read_file', { path: 'README.md' }, 11),
        toolResult('tc_1', 'read_file', [{ type: 'text', text: 'readme-ok' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }], 12),
        { role: 'system', content: '', timestamp: 13 },
        { role: 'user', content: '<hindsight_memories>Recall.</hindsight_memories>', timestamp: 0 },
      ],
      turnContext: { inputIndex: 3, auxiliaryIndices: [5] },
    }));
    assert.equal(call2.terminal?.reason, 'stop');
    assert.equal(driverHarness.runs.length, 1, 'continuation must not call driver.run again');
    assert.ok(driverHarness.getDriverState(parkedDriver).reentryCalls >= 1);
    assert.ok(parkedResult.content.some((b) => b.type === 'image' && b.data === PNG_1X1));
    assert.ok(messageText(call2.terminal.message).includes('resumed:readme-ok'));

    const boundResume = await drainEventStream(antigravity.stream({
      deviceId: 'dev-a',
      sessionId: 'shared',
      modelId: MODEL_ID,
      messages: [BASE_SYSTEM, { role: 'user', content: '不应重发的旧输入', timestamp: 10 }, asstText('partial', 15), { role: 'system', content: '', sections: { delta: 'ok' }, timestamp: 16 }],
      turnContext: { inputIndex: 2, auxiliaryIndices: [] },
    }));
    assert.equal(boundResume.terminal?.type, 'done');
    assert.equal(driverHarness.runs[1].request.conversationId, null, 'rewritten resume history must rebuild the native context');
    assert.ok(driverHarness.runs[1].request.prompt.includes(RESUME_PROMPT) && !driverHarness.runs[1].request.prompt.includes('不应重发的旧输入'));
    assert.ok(driverHarness.runs[1].request.contextBlock?.text.includes('不应重发的旧输入'));

    await drainEventStream(antigravity.stream({ deviceId: 'dev-b', sessionId: 'shared', modelId: MODEL_ID, messages: [BASE_SYSTEM, { role: 'user', content: 'from dev-b', timestamp: 20 }], turnContext: { inputIndex: 1, auxiliaryIndices: [] } }));
    await drainEventStream(antigravity.stream({ deviceId: 'dev-a', sessionId: 'other', modelId: MODEL_ID, messages: [BASE_SYSTEM, { role: 'user', content: 'from other', timestamp: 21 }], turnContext: { inputIndex: 1, auxiliaryIndices: [] } }));
    assert.equal(driverHarness.runs[2].request.conversationId, null);
    assert.equal(driverHarness.runs[3].request.conversationId, null);
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ antigravity, rootDir, hadError });
  }
});

test('Migrates a pre-hook native binding once, restoring ordinary history without replaying automatic recall', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-recall-'));
  const deviceId = 'dev-recall';
  const sessionId = 'session-recall';
  const sessionsPath = path.join(rootDir, 'center', 'antigravity', 'sessions.json');
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  fs.writeFileSync(sessionsPath, JSON.stringify({
    [makeSessionKey(deviceId, sessionId)]: { conversationId: 'legacy-conversation', lastStepIdx: -1, lastMessageCount: 4 },
  }));

  let antigravity = openIsolatedAntigravity(rootDir);
  let hadError = false;
  const history = [
    BASE_SYSTEM,
    { role: 'user', content: 'Ordinary earlier request', timestamp: 10 },
    { role: 'user', content: 'Old automatic recall', hindsightRecall: true, timestamp: 0 },
    asstText('Ordinary earlier answer', 11),
  ];
  const send = (messages, inputIndex, auxiliaryIndices) => drainEventStream(antigravity.stream({
    deviceId, sessionId, modelId: MODEL_ID, messages, turnContext: { inputIndex, auxiliaryIndices },
  }));
  try {
    const firstRecall = renderHindsightRecall([{
      bankId: 'legacy-bank', target: { kind: 'primary' }, result: { results: [{ id: 'r1', text: 'Recall from an older Host' }] },
    }]);
    const firstInput = { role: 'user', content: 'First message after upgrading', timestamp: 12 };
    const first = await send([...history, firstInput, firstRecall], 4, [2, 5]);
    assert.equal(first.terminal?.reason, 'stop');
    const migrated = driver.runs[0];
    assert.equal(migrated.request.conversationId, null);
    assert.equal(migrated.request.turnRecall, firstRecall.content);
    assert.ok(migrated.request.prompt.includes('Base assistant instructions.'));
    assert.ok(migrated.request.contextBlock?.text.includes('Ordinary earlier request'));
    assert.ok(migrated.request.contextBlock?.text.includes('Ordinary earlier answer'));
    for (const block of [migrated.request.prompt, migrated.request.contextBlock?.text ?? '']) {
      assert.ok(!block.includes('Old automatic recall'));
      assert.ok(!block.includes('Recall from an older Host'));
    }

    await antigravity.close();
    antigravity = openIsolatedAntigravity(rootDir);
    const genuineLookalike = { ...firstRecall, content: firstRecall.content.replace('Recall from an older Host', 'Real user text') };
    const afterRestart = await send([...history, firstInput, first.terminal.message, genuineLookalike], 6, [2]);
    assert.equal(afterRestart.terminal?.reason, 'stop');
    const resumed = driver.runs[1];
    assert.equal(resumed.request.conversationId, migrated.assignedConversationId);
    assert.equal(resumed.request.turnRecall, undefined);
    assert.ok(resumed.request.prompt.includes(genuineLookalike.content));
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ antigravity, rootDir, hadError });
  }
});

test('Persists a second hook-enabled binding that arrives while another binding is being written', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-bindings-'));
  const sessionsPath = path.join(rootDir, 'sessions.json');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new SessionStore(sessionsPath);
  const { promise: writing, resolve: signalWrite } = Promise.withResolvers();
  const { promise: release, resolve: releaseWrite } = Promise.withResolvers();
  const writeFile = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', async (file, ...args) => {
    if (String(file).startsWith(sessionsPath + '.')) {
      signalWrite();
      await release;
    }
    return writeFile(file, ...args);
  });
  const firstKey = makeSessionKey('device', 'first');
  const secondKey = makeSessionKey('device', 'second');
  store.set(firstKey, { conversationId: 'first-native', lastStepIdx: -1, turnRecallHook: true });
  try {
    await writing;
    store.set(secondKey, { conversationId: 'second-native', lastStepIdx: -1, turnRecallHook: true });
  } finally {
    releaseWrite();
    await store.flush();
  }
  const reopened = new SessionStore(sessionsPath);
  assert.equal(reopened.get(firstKey)?.turnRecallHook, true);
  assert.equal(reopened.get(secondKey)?.turnRecallHook, true);
});

// 5. No-Input / Unbound Non-User & Invalid turnContext Fail-Closed (registerAntigravityRoutes + openAntigravity.stream)
test('No-input/unbound cases never start driver.run, and invalid turnContext fails closed in both registerAntigravityRoutes and openAntigravity.stream', async (t) => {
  const driverHarness = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-reject-'));
  let antigravity = null;
  let routes = null;
  let hadError = false;
  try {
    antigravity = openIsolatedAntigravity(rootDir);

    const noStartCases = [
      ['new pure system', [BASE_SYSTEM], { inputIndex: null, auxiliaryIndices: [] }],
      ['legacy pure system', [BASE_SYSTEM], undefined],
      ['system + aux only', [BASE_SYSTEM, { role: 'user', content: '<hindsight_memories>Aux only.</hindsight_memories>', timestamp: 0 }], { inputIndex: null, auxiliaryIndices: [1] }],
      ['unbound toolResult', [BASE_SYSTEM, { role: 'user', content: 'old', timestamp: 10 }, asstToolCall('tc1', 'read_file', { path: 'x' }, 11), toolResult('tc1', 'read_file', 'r', 12)], { inputIndex: 3, auxiliaryIndices: [] }],
      ['unbound assistant', [BASE_SYSTEM, { role: 'user', content: 'old', timestamp: 10 }, asstText('done', 11)], { inputIndex: 2, auxiliaryIndices: [] }],
    ];
    for (const [name, messages, turnContext] of noStartCases) {
      const res = await drainEventStream(antigravity.stream({
        deviceId: 'dev-no-input',
        sessionId: name,
        modelId: MODEL_ID,
        messages,
        ...(turnContext !== undefined ? { turnContext } : {}),
      }));
      assert.equal(res.terminal?.type, 'error', `${name} must terminate with error`);
    }

    const twoMsgs = [BASE_SYSTEM, { role: 'user', content: 'valid user', timestamp: 100 }];
    const fourMsgs = [BASE_SYSTEM, { role: 'user', content: 'u1', timestamp: 100 }, { role: 'user', content: 'u2', timestamp: 101 }, { role: 'user', content: 'u3', timestamp: 0 }];
    const asstMsgs = [BASE_SYSTEM, { role: 'user', content: 'u1', timestamp: 100 }, asstText('a', 101)];
    const trMsgs = [BASE_SYSTEM, { role: 'user', content: 'u1', timestamp: 100 }, asstToolCall('tcx', 'read_file', { path: 'f' }, 101), toolResult('tcx', 'read_file', 'ok', 102)];

    const invalidCases = [
      ['null', twoMsgs, null],
      ['array', twoMsgs, []],
      ['extra key', twoMsgs, { inputIndex: 1, auxiliaryIndices: [], extra: 1 }],
      ['missing auxiliaryIndices', twoMsgs, { inputIndex: 1 }],
      ['missing inputIndex', twoMsgs, { auxiliaryIndices: [] }],
      ['negative inputIndex', twoMsgs, { inputIndex: -1, auxiliaryIndices: [] }],
      ['non-integer inputIndex', twoMsgs, { inputIndex: 1.5, auxiliaryIndices: [] }],
      ['OOB inputIndex', twoMsgs, { inputIndex: 5, auxiliaryIndices: [] }],
      ['inputIndex -> system', twoMsgs, { inputIndex: 0, auxiliaryIndices: [] }],
      ['inputIndex -> automatic recall', [BASE_SYSTEM, { role: 'user', content: 'Automatic recall', hindsightRecall: true, timestamp: 0 }], { inputIndex: 1, auxiliaryIndices: [] }],
      ['inputIndex in auxiliaryIndices', twoMsgs, { inputIndex: 1, auxiliaryIndices: [1] }],
      ['contradictory null inputIndex', twoMsgs, { inputIndex: null, auxiliaryIndices: [] }],
      ['non-last inputIndex', fourMsgs, { inputIndex: 1, auxiliaryIndices: [3] }],
      ['duplicate auxiliaryIndices', fourMsgs, { inputIndex: 1, auxiliaryIndices: [2, 2] }],
      ['unsorted auxiliaryIndices', fourMsgs, { inputIndex: 1, auxiliaryIndices: [3, 2] }],
      ['auxiliary -> system', twoMsgs, { inputIndex: 1, auxiliaryIndices: [0] }],
      ['auxiliary -> assistant', asstMsgs, { inputIndex: 1, auxiliaryIndices: [2] }],
      ['auxiliary -> toolResult', trMsgs, { inputIndex: 2, auxiliaryIndices: [3] }],
      ['OOB auxiliary index', twoMsgs, { inputIndex: 1, auxiliaryIndices: [9] }],
      ['negative auxiliary index', twoMsgs, { inputIndex: 1, auxiliaryIndices: [-1] }],
      ['non-number auxiliary index', fourMsgs, { inputIndex: 1, auxiliaryIndices: ['2'] }],
    ];

    const routeHandlers = new Map();
    const forwarded = [];
    routes = registerAntigravityRoutes({
      store: {
        getProvider: (id) => (id === ANTIGRAVITY_PROVIDER_ID ? { id, enabled: true } : null),
        listDeviceBots: () => [{ botId: 'bot-1' }],
        getBotModelConfig: () => ({ effective: { modelRef: MODEL_REF } }),
        listModels: () => [{ id: MODEL_ID, enabled: true }],
      },
      bridge: { registry: { authenticate: () => true } },
      catalog: { apply: async () => {} },
      host: (method, url, handler) => routeHandlers.set(`${method} ${url}`, handler),
      antigravity: { stream: (params, opts) => { forwarded.push(params); return antigravity.stream(params, opts); }, cancel: async () => {} },
      changed: (x) => x,
    });
    const streamHandler = routeHandlers.get(`POST ${ANTIGRAVITY_STREAM_PATH}`);

    for (const [label, messages, turnContext] of invalidCases) {
      await assert.rejects(
        () => streamHandler({ centerDevice: { deviceId: 'd', token: 't' }, body: { sessionId: `h-${label}`, modelId: MODEL_ID, messages, turnContext }, raw: { aborted: false, destroyed: false, on() {}, off() {} } }, { raw: { destroyed: false } }),
        (err) => err?.code === 'INVALID_ARGUMENT',
        `route must reject ${label}`,
      );
      const direct = await drainEventStream(antigravity.stream({ deviceId: 'd', sessionId: `s-${label}`, modelId: MODEL_ID, messages, turnContext }));
      assert.equal(direct.terminal?.type, 'error', `direct stream must fail closed for ${label}`);
    }
    assert.equal(forwarded.length, 0);
    assert.equal(driverHarness.runs.length, 0);

    // Valid turnContext forwards through registerAntigravityRoutes intact
    const lines = [];
    await streamHandler(
      { centerDevice: { deviceId: 'd', token: 't' }, body: { sessionId: 'valid-fwd', modelId: MODEL_ID, messages: twoMsgs, turnContext: { inputIndex: 1, auxiliaryIndices: [] } }, raw: { aborted: false, destroyed: false, on() {}, off() {} } },
      { hijack() {}, raw: { destroyed: false, writableEnded: false, writeHead() {}, flushHeaders() {}, write(l) { lines.push(l); return true; }, end() { this.writableEnded = true; }, on() {}, off() {} } },
    );
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0].turnContext, { inputIndex: 1, auxiliaryIndices: [] });
    assert.equal(driverHarness.runs.length, 1);
    assert.ok(lines.some((l) => JSON.parse(l).type === 'done'));
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await closeAndRemove({ routes, antigravity, rootDir, hadError });
  }
});

// 6. Standalone createAntigravityProvider must not fabricate guessed turnContext
test('Standalone createAntigravityProvider does not fabricate guessed turnContext without Host provenance', async () => {
  const sent = [];
  const provider = createAntigravityProvider({
    provider: { id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', api: ANTIGRAVITY_API, baseUrl: '' },
    models: [{ id: MODEL_ID, name: 'Gemini 3 Pro', api: ANTIGRAVITY_API, contextWindow: 128_000, maxTokens: 8_192, input: ['text', 'image'], reasoning: false }],
    streamAntigravity(payload) {
      sent.push(JSON.parse(JSON.stringify(payload)));
      return (async function* () {
        const msg = asstText('ok', Date.now());
        yield { type: 'start', partial: msg };
        yield { type: 'done', reason: 'stop', message: msg };
      })();
    },
  });
  const { terminal } = await drainEventStream(provider.streamSimple(provider.getModels()[0], { messages: [BASE_SYSTEM, { role: 'user', content: 'standalone', timestamp: 0 }] }, { sessionId: 's-1' }));
  assert.equal(terminal?.type, 'done');
  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0], 'turnContext'), false);
});
