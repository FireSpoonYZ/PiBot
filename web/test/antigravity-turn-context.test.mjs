import { acceptHistoryDelta } from '../../center-contract/antigravity-delta.js';
import { createAntigravityHistoryTransport, projectAntigravityHistory } from '../../host-core/antigravity-delta.js';
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
import { openAntigravity as openNativeAntigravity } from '../../center-server/antigravity/index.js';
import { buildThinkingProfile, resolveSessionThoughtLevel } from '../../center-server/antigravity/catalog.ts';
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
import { createControlledAcpDriverHarness as sharedDriverHarness } from './helpers/antigravity-sync-harness.mjs';
import { registerApiProvider } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/compat.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';

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

// Use the same dispatch-intent and outcome lifecycle as the integration fixture.
// Only the native image hook is replaced here; Pi Durable still executes tools.
function createControlledAcpDriverHarness(t) {
  const harness = sharedDriverHarness(t);
  const imageDeliveries = [];
  t.mock.method(AcpDriver.prototype, 'queueToolResultImages', function (toolCallId, images) {
    const state = harness.getDriverState(this);
    assert.ok(state.active, 'images must target the original live native prompt');
    imageDeliveries.push({ toolCallId, turnId: state.active.id, images: structuredClone(images) });
  });
  return { ...harness, imageDeliveries };
}

function wireInput(payload) {
  return payload.delta.messages[payload.turnContext.inputIndex - payload.delta.offset];
}

function assertHistoryChanged(result) {
  assert.equal(result.terminal?.type, 'error', JSON.stringify(result.terminal));
  assert.match(result.terminal.error.errorMessage, /AGY_HISTORY_CHANGED/);
  assert.match(result.terminal.error.errorMessage, /\/clear/);
}

function openAntigravity(options) {
  const service = openNativeAntigravity(options);
  const hosts = new Map();
  return { ...service, async *stream(params, options) {
    if (params.delta) {
      yield* service.stream(params, options);
      return;
    }
    let host = hosts.get(params.deviceId);
    if (!host) { host = createAntigravityHistoryTransport(); hosts.set(params.deviceId, host); }
    try {
      const prepared = host.prepare(params);
      for await (const event of service.stream({ ...prepared.payload, deviceId: params.deviceId,
        ...(params.requestId ? { requestId: params.requestId } : {}) }, options)) {
        if (event.type === 'history_ack') prepared.acknowledge(event);
        else yield event;
      }
    } catch (error) {
      yield { type: 'error', reason: 'error', error: {
        ...asstText('', Date.now()), stopReason: 'error', errorMessage: error.message,
      } };
    }
  } };
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
      const record = (event) => { if (cfg?.recordFile) fs.appendFileSync(cfg.recordFile, event + '\\n'); };
      record('forBot');
      const tools = cfg?.enableProbeTool ? [host.sdk.defineTool({
        name: cfg?.toolName ?? 'ping_probe_tool',
        description: 'Dynamic test probe tool.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        replay: 'safe', deferred: true,
        async execute(args) { return { output: [{ type: 'text', text: 'probe:' + String(args?.query ?? '') }] }; },
      })] : [];
      if (cfg?.enableModelOnlyProbe) tools.push(host.sdk.defineTool({
        name: 'model_only_probe', description: 'Deferred model-only probe.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        callers: ['model'], deferred: true, replay: 'safe',
        async execute() { record('model-only-execute'); return { output: [{ type: 'text', text: 'model-only-ok' }] }; },
      }));
      const bot = {
        durableContributions: { tools },
        requestContributions: {
          async prepareContext(request) {
            record('prepareContext');
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
        async prepare() { record('prepare'); }, async activate() { record('activate'); }, async quiesce() {}, async close() { bots.delete(bot); },
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
    ['test-bc-context', { version: '1.0.0', packageRoot: bcDir, dataDir: path.join(bcDir, 'data'), manifest: { id: 'e-launcher.billion-context', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } } }],
    ['test-context-rewriter', { version: '1.0.0', packageRoot: bcDir, dataDir: path.join(bcDir, 'rewriter-data'), manifest: { id: 'test.context-rewriter', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } } }],
    ['test-probe-tools', { version: '1.0.0', packageRoot: bcDir, dataDir: path.join(bcDir, 'probe-data'), manifest: { id: 'test.probe-tools', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } } }],
    ['test-hindsight-recall', { version: hindsightManifest.version, packageRoot: hindsightRoot, dataDir: path.join(rootDir, 'hindsight-data'), manifest: hindsightManifest }],
  ]);
  const questionnaireRoot = fileURLToPath(new URL('../../plugins/ask-user-question/', import.meta.url));
  const questionnaireManifest = JSON.parse(fs.readFileSync(path.join(questionnaireRoot, 'capability.json'), 'utf8'));
  installed.set('test-questionnaire', { version: questionnaireManifest.version, packageRoot: questionnaireRoot,
    dataDir: path.join(rootDir, 'questionnaire-data'), manifest: questionnaireManifest });
  return { async getInstalled(id, opts) { const e = installed.get(id); return !e || (opts?.version && e.version !== opts.version) ? null : e; } };
}

async function openTestHostRuntime({ rootDir, antigravity, capturedPayloads, callOperation, fixtureApi }) {
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
          ...(payload.delta ? { delta: payload.delta } : { messages: payload.messages }),
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
    providers: [{ id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', api: ANTIGRAVITY_API, baseUrl: '', enabled: true, credentialRef: null, native: true, authMode: 'oauth' },
      ...(fixtureApi ? [{ id: 'fixture', name: 'Fixture', api: fixtureApi, baseUrl: 'http://127.0.0.1:9', enabled: true, credentialRef: null }] : [])],
    models: { [ANTIGRAVITY_PROVIDER_ID]: [MODEL_ID, 'second-model'].map(id => ({ id, name: id, api: ANTIGRAVITY_API, contextWindow: 128_000, maxTokens: 8_192, input: ['text', 'image'], reasoning: true, enabled: true, revision: 1 })),
      ...(fixtureApi ? { fixture: [{ id: 'model', name: 'Fixture', api: fixtureApi, contextWindow: 128_000, maxTokens: 4096, input: ['text'], reasoning: false, enabled: true, revision: 1 }] } : {}) },
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

// Real Runtime, plugins, SQLite and Pi Durable; only remote AGY/Hindsight are fixtures.
test('Real Host keeps BC inactive and Hindsight auto-retain, explicit recall, images and native tool continuation working', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const recalledText = 'Verified memory ALPHA-7.';
  const requests = [];
  const retained = [];
  const banks = new Set();
  const operations = new Set();
  const memoryServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const bank = parts[3];
    requests.push({ method: req.method, path: url.pathname, body });
    let status = 200;
    let result;
    if (req.method === 'GET' && url.pathname.endsWith('/banks')) {
      result = { banks: [...banks].map(bank_id => ({ bank_id })), total: banks.size };
    } else if (req.method === 'PUT' && parts.length === 4) {
      banks.add(bank); result = { bank_id: bank };
    } else if (req.method === 'GET' && parts[4] === 'operations') {
      result = { operation_id: parts[5], status: operations.has(parts[5]) ? 'completed' : 'not_found' };
    } else if (req.method === 'POST' && parts[4] === 'memories' && parts.length === 5) {
      retained.push({ bank, body }); operations.add(body.operation_id);
      result = { success: true, bank_id: bank, async: true, operation_id: body.operation_id };
    } else if (req.method === 'POST' && url.pathname.endsWith('/memories/recall')) {
      result = { results: [{ id: 'qa-memory', text: recalledText, type: 'observation' }], source_facts: {} };
    } else {
      status = 404; result = { error: 'Unexpected fixture request' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => memoryServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { memoryServer.close(resolve); memoryServer.closeAllConnections(); }));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-memory-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  let runtime;
  try {
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'memory-bot', role: 'Acp Assistant', cwd, makePrimary: true });
    const bcRecord = path.join(rootDir, 'bc-activity.txt');
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [
      makeCapability('test-bc-context', { recordFile: bcRecord, enableProbeTool: true, toolName: 'bc_probe_tool', injectBcSummary: true, injectBcNudge: true }),
      makeCapability('test-probe-tools', { enableProbeTool: true }),
      { ...makeCapability('test-hindsight-recall', { baseUrl: `http://127.0.0.1:${memoryServer.address().port}`, mode: 'read-write' }), targetVersion: hindsightManifest.version },
    ] }]));
    assert.equal(hindsightManifest.version, '1.2.2');
    const memoryTool = 'hindsight_' + createHash('sha256').update(JSON.stringify(['test-hindsight-recall', bot.botId])).digest('hex').slice(0, 32) + '_recall';
    const image = await runtime.uploadAttachment(bot.botId, { name: 'p.png', mimeType: 'image/png', data: PNG_1X1 });
    let toolReply;
    driver.setOnRun(async ctx => {
      let response = 'received';
      if (driver.runs.length === 2) {
        toolReply = await ctx.mcp.handler.onToolCall('memory-code', 'codemode', {
          code: `
            const [probe] = await searchTools("ping_probe_tool", { limit: 1 });
            if (probe?.name !== "ping_probe_tool") throw new Error("Missing ordinary tool");
            if ((await searchTools("bc_probe_tool", { limit: 20 })).some(tool => tool.name === "bc_probe_tool")) throw new Error("BC was activated");
            text(await tools[probe.name]({ query: "acp-check" }));
            if (!(await describeTool(${JSON.stringify(memoryTool)}))) throw new Error("Missing memory tool");
            text(await tools[${JSON.stringify(memoryTool)}]({ query: "ALPHA-7" }));
          `,
        }, ctx.signal);
        assert.equal(toolReply.isError, false, JSON.stringify(toolReply));
        response = messageText(toolReply);
      }
      ctx.emit({ type: 'text', delta: response });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response, finished: true, aborted: false });
    });
    const send = async (requestId, text, attachments) => {
      await runtime.submit(bot.botId, { requestId, text, ...(attachments ? { attachments } : {}), origin: USER_ORIGIN });
      const receipt = await env.waitForSubmission(bot.botId, requestId);
      if (driver.runs.at(-1)?.error) throw driver.runs.at(-1).error;
      assert.equal(receipt.status, 'done', JSON.stringify(receipt));
    };
    await send('memory-first', '请记住暗号 ALPHA-7');
    assert.equal(captured[0].delta.offset, 0);
    assert.equal(wireInput(captured[0]).role, 'user');
    assert.match(messageText(wireInput(captured[0])), /ALPHA-7/);
    assert.equal(captured[0].delta.messages.some(m => m.role === 'system' || m.hindsightRecall || m.bcSummaryMaterial || m.bcContextMaterial), false);
    assert.equal(fs.existsSync(bcRecord), false, 'BC must not create/activate its per-Bot instance');
    assert.equal(requests.filter(r => r.path.endsWith('/memories/recall')).length, 0, 'no automatic recall before the model asks');
    await waitUntil(() => retained.some(r => JSON.stringify(r.body).includes('ALPHA-7')), { label: 'automatic transcript retention' });
    const initialBank = retained.find(r => JSON.stringify(r.body).includes('ALPHA-7')).bank;
    assert.ok(retained.some(r => r.body.items.some(item => typeof item.document_id === 'string' && item.metadata)), 'retain keeps source attribution');

    await send('memory-image', '请看图并查询刚才的记忆', [image.id]);
    assert.equal(driver.runs.length, 2, 'the codemode result resumes the original ACP run');
    assert.equal(captured.length, 3);
    assert.equal(wireInput(captured[2]).role, 'toolResult');
    assert.match(messageText(toolReply), /probe:acp-check/);
    assert.match(messageText(toolReply), /Verified memory ALPHA-7/);
    assert.equal(requests.filter(r => r.path.endsWith('/memories/recall')).length, 1, 'only the explicit memory tool recalls');
    const second = driver.runs[1];
    assert.equal(second.request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal(second.request.contextBlock, undefined);
    assert.equal(second.request.turnRecall, undefined);
    assert.doesNotMatch(second.request.prompt, /请记住暗号 ALPHA-7|Verified memory|BC summary|BC nudge/);
    assert.deepEqual(second.request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    assert.ok(second.driverState.reentryCalls >= 1);
    assert.equal(hasImage(wireInput(captured[1])), true);
    assert.equal(second.mcpTools.some(tool => tool.name === 'ping_probe_tool' || tool.name === memoryTool || tool.name === 'bc_probe_tool'), false);

    await send('memory-image-only', '', [image.id]);
    assert.equal(messageText(wireInput(captured[3])), '');
    assert.equal(hasImage(wireInput(captured[3])), true);
    assert.deepEqual(driver.runs[2].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }], 'old pictures are not replayed');
    assert.ok(captured.slice(1).every(p => p.delta.configHash === captured[0].delta.configHash));
    assert.ok(captured.slice(1).every(p => p.delta.config === undefined));
    assert.equal(requests.filter(r => r.path.endsWith('/memories/recall')).length, 1);

    await waitUntil(async () => {
      try { return await runtime.clearHistory(bot.botId); }
      catch (error) { if (error.code === 'RUNTIME_BUSY') return false; throw error; }
    }, { label: 'clear after background retain' });
    await send('memory-after-clear', '新会话记住 BETA-9');
    assert.notEqual(captured.at(-1).sessionId, captured[0].sessionId);
    assert.equal(driver.runs.at(-1).request.conversationId, null);
    await waitUntil(() => retained.some(r => JSON.stringify(r.body).includes('BETA-9')), { label: 'retain after clear' });
    assert.equal(retained.find(r => JSON.stringify(r.body).includes('BETA-9')).bank, initialBank);
    assert.equal(requests.filter(r => r.path.endsWith('/memories/recall')).length, 1);
  } finally { await closeAndRemove({ runtime, antigravity, rootDir }); }
});

test('ACP forces Code Mode only while directly exposing deferred model-only tools and preserving nested discovery', async (t) => {
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
      botId: bot.botId, cwd, model: BASE_MODEL_SEL, // Both flags are false: AGY must still enforce codemodeOnly.
      capabilities: [makeCapability('test-probe-tools', { enableModelOnlyProbe: true }),
        { ...makeCapability('test-questionnaire', {}), targetVersion: '1.1.0' }],
    }]));

    driver.setOnRun(async (ctx) => {
      const declared = captured[0].delta.config.tools;
      assert.deepEqual(ctx.mcp.handler.listTools(), declared.map(({ name, description, parameters }) => ({
        name, description, inputSchema: parameters,
      })));
      assert.ok(declared.some((tool) => tool.name === 'ask_user_question'));
      assert.ok(declared.some((tool) => tool.name === 'model_only_probe'), 'deferred model-only tools are reachable on the very first prompt');
      assert.ok(declared.some((tool) => tool.name === 'bridge_poll_result'));
      assert.ok(!declared.some((tool) => tool.name === 'tool_search' || tool.name === 'automation_schedule_list'));
      const stale = await ctx.mcp.handler.onToolCall('stale', 'automation_schedule_list', {}, ctx.signal);
      assert.equal(stale.isError, true);

      const direct = await ctx.mcp.handler.onToolCall('direct-model-only', 'model_only_probe', {}, ctx.signal);
      assert.equal(direct.isError, false, JSON.stringify(direct));
      assert.match(messageText(direct), /model-only-ok/);
      const result = await ctx.mcp.handler.onToolCall('code-mode', 'codemode', {
        code: `
          if ((await searchTools("model_only_probe", { limit: 20 })).some(tool => tool.name === "model_only_probe")) throw new Error("model-only leaked into codemode");
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
    assert.equal(captured.length, 3);
    assert.ok(captured.slice(1).every(p => p.delta.configHash === captured[0].delta.configHash));
    assert.ok(captured.slice(1).every(p => p.delta.config === undefined));
    assert.ok(captured.slice(1).every(p => wireInput(p).role === 'toolResult'));
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
    const liveInput = wireInput(resumed);
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

// Keep provenance guards for all providers; AGY must never enter the rewriting stage.
test('Host provenance rejects spoofed input and AGY bypasses destructive context preparation in the real Runtime', async (t) => {
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

  // BC's codec remains valid for other providers; its rewritten view is not accepted by AGY.
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
    assert.throws(() => projectAntigravityHistory(rewrittenMsgs, { inputIndex: 1, auxiliaryIndices: [2] }), /AGY_HISTORY_CHANGED/);
  }

  // The plugin is activated, but its destructive prepareContext hooks are never called.
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-projection-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  let runtime;
  try {
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const a = await runtime.createBot({ requestId: 'projection-a', role: 'A', cwd, makePrimary: true });
    const b = await runtime.createBot({ requestId: 'projection-b', role: 'B', cwd });
    const recordA = path.join(rootDir, 'rewrite-a.txt');
    const recordB = path.join(rootDir, 'rewrite-b.txt');
    await env.applySnapshot(env.makeSnapshot(2, [
      { botId: a.botId, cwd, model: BASE_MODEL_SEL, capabilities: [makeCapability('test-context-rewriter', { mode: 'drop-current-leave-earlier-user', recordFile: recordA })] },
      { botId: b.botId, cwd, model: BASE_MODEL_SEL, capabilities: [makeCapability('test-context-rewriter', { mode: 'drop-current-replace-with-containing-aux', recordFile: recordB })] },
    ]));
    for (const [bot, requestId, text] of [[a, 'same-1', '重复探针消息'], [a, 'same-2', '重复探针消息'], [b, 'replace', '原输入关键词-BETA']]) {
      await runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      assert.equal((await env.waitForSubmission(bot.botId, requestId)).status, 'done');
      assert.equal(messageText(wireInput(captured.at(-1))), text);
    }
    for (const record of [recordA, recordB]) {
      const events = fs.readFileSync(record, 'utf8');
      assert.match(events, /activate/);
      assert.doesNotMatch(events, /prepareContext|called/);
    }
    assert.equal(captured.length, 3);
    assert.equal(driver.runs.length, 3);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal((driver.runs[1].request.prompt.match(/重复探针消息/g) ?? []).length, 1, 'only the newly appended identical input is dispatched');
    assert.doesNotMatch(driver.runs[2].request.prompt, /辅助上下文包装/);
  } finally { await closeAndRemove({ runtime, antigravity, rootDir }); }
});

// Timestamp-zero user content is valid; flags and authoritative provenance define its role.
test('Append-only matrix accepts text/image and per-turn routing but rejects history, tools, fixed routing and legacy replay', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-matrix-'));
  const antigravity = openIsolatedAntigravity(rootDir);
  const route = text => ({ role: 'system', content: '', sections: { 'host-turn-routing': text }, timestamp: 0 });
  const extra = { role: 'system', content: '', toolsAdded: [{ name: 'inspect_tool', description: 'Inspect.', parameters: { type: 'object', properties: {} } }], timestamp: 12 };
  const text = '<hindsight_memories>Genuine timestamp:0 user asking about host-turn-routing.</hindsight_memories>';
  const firstInput = { role: 'user', content: text, timestamp: 0 };
  const send = (messages, inputIndex, options = {}) => drainEventStream(antigravity.stream({
    deviceId: 'dev', sessionId: 'matrix', modelId: MODEL_ID, messages,
    turnContext: { inputIndex, auxiliaryIndices: [], routingPolicy: 'fixed-routing-v1' }, ...options,
  }));
  try {
    const first = await send([route('Source: peer A; request: 1; target: DM A.'), BASE_SYSTEM, firstInput, extra], 2);
    assert.equal(first.terminal?.reason, 'stop');
    assert.match(driver.runs[0].request.prompt, /Source: peer A/);
    assert.ok(driver.runs[0].request.prompt.includes(text));
    assert.ok(driver.runs[0].request.systemPrompt.includes('Base assistant instructions.'));
    assert.doesNotMatch(driver.runs[0].request.systemPrompt, /peer A|request: 1/);
    assert.equal(driver.runs[0].request.turnRecall, undefined);
    assert.equal(driver.runs[0].request.contextBlock, undefined);
    assert.ok(driver.runs[0].mcpTools.some(tool => tool.name === 'inspect_tool'));

    const image = { role: 'user', content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }], timestamp: 0 };
    const second = await send([route('Source: timer B; request: 2; target: primary.'), BASE_SYSTEM, firstInput, first.terminal.message, image, extra], 4);
    assert.equal(second.terminal?.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.match(driver.runs[1].request.prompt, /Source: timer B/);
    assert.doesNotMatch(driver.runs[1].request.prompt, /peer A|Genuine timestamp/);
    assert.equal(driver.runs[1].request.systemHash, driver.runs[0].request.systemHash);
    assert.deepEqual(driver.runs[1].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);

    const mixed = { role: 'user', content: [{ type: 'text', text: '文图混合输入' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }], timestamp: 0 };
    const history = [BASE_SYSTEM, firstInput, first.terminal.message, image, second.terminal.message, mixed, extra];
    const third = await send(history, 5);
    assert.equal(third.terminal?.reason, 'stop');
    assert.match(driver.runs[2].request.prompt, /文图混合输入/);
    assert.deepEqual(driver.runs[2].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }], 'do not replay the previous image');
    const next = { role: 'user', content: 'next', timestamp: 30 };
    const appended = [...history, third.terminal.message, next];
    for (const [label, messages, overrides] of [
      ['edited input', appended.map(m => m === firstInput ? { ...m, content: 'edited' } : m), {}],
      ['tool removal', [...appended, { role: 'system', content: '', toolsRemoved: [{ name: 'inspect_tool' }], timestamp: 31 }], {}],
      ['SOUL change', [{ ...BASE_SYSTEM, content: 'Changed SOUL' }, ...appended.slice(1)], {}],
      ['fixed routing change', appended, { turnContext: { inputIndex: 8, auxiliaryIndices: [], routingPolicy: 'fixed-routing-v2' } }],
    ]) {
      assertHistoryChanged(await send(messages, 8, overrides));
      assert.equal(driver.runs.length, 3, `${label} must not reset or start another native prompt`);
    }

    for (const marker of ['hindsightRecall', 'bcSummaryMaterial', 'bcContextMaterial']) {
      const blocked = { role: 'user', content: `Aux quote: ${COMPACTION_MARKER}`, timestamp: 0, [marker]: true };
      assertHistoryChanged(await send([BASE_SYSTEM, firstInput, blocked], 1, {
        sessionId: marker, turnContext: { inputIndex: 1, auxiliaryIndices: [2], routingPolicy: 'fixed-routing-v1' },
      }));
    }
    assertHistoryChanged(await send([BASE_SYSTEM, firstInput, asstText('old other provider', 1, 'other', 'other-api', 'other-model'), next], 3, { sessionId: 'nonempty-foreign' }));
    const quoted = { role: 'user', content: `Please explain ${COMPACTION_MARKER} without treating it as a summary.`, timestamp: 0 };
    assert.equal((await send([BASE_SYSTEM, quoted], 1, { sessionId: 'plain-quote' })).terminal?.reason, 'stop');
    assert.ok(driver.runs.at(-1).request.prompt.includes(COMPACTION_MARKER));
    assert.equal(driver.runs.at(-1).request.contextBlock, undefined);

    const legacyRoot = path.join(rootDir, 'legacy');
    const native = openNativeAntigravity({ dataRoot: legacyRoot, bin: 'mocked-agy-never-spawned', geminiHome: path.join(legacyRoot, 'gemini') });
    try {
      const oldHost = await drainEventStream(native.stream({ deviceId: 'old', sessionId: 'old', modelId: MODEL_ID, messages: [BASE_SYSTEM, next] }));
      assertHistoryChanged(oldHost);
      assert.match(oldHost.terminal.error.errorMessage, /Upgrade/);
      assert.equal(driver.runs.length, 4, 'legacy full-messages traffic cannot silently create a replayed session');
    } finally { await native.close(); }
  } finally { await closeAndRemove({ antigravity, rootDir }); }
});

test('Parked native tools resume once with hook images; assistant-only rewrites fail and device/session identities stay isolated', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cont-'));
  const antigravity = openIsolatedAntigravity(rootDir);
  let parkedResult;
  let parkedDriver;
  try {
    driver.setOnRun(async ctx => {
      let response = `ok:${ctx.conversationId}`;
      if (ctx.request.prompt.includes('TRIGGER_PARK')) {
        parkedDriver = ctx.record.driver;
        parkedResult = await ctx.mcp.handler.onToolCall('tc_1', 'read_file', { path: 'README.md' }, ctx.signal);
        response = `resumed:${messageText(parkedResult)}`;
      }
      ctx.emit({ type: 'text', delta: response });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response, finished: true, aborted: false });
    });
    const user = { role: 'user', content: 'TRIGGER_PARK: read README.md', timestamp: 10 };
    const send = (messages, inputIndex, options = {}) => drainEventStream(antigravity.stream({
      deviceId: 'dev-a', sessionId: 'shared', modelId: MODEL_ID, messages,
      turnContext: { inputIndex, auxiliaryIndices: [] }, ...options,
    }));
    const first = await send([BASE_SYSTEM, user], 1);
    assert.equal(first.terminal?.reason, 'toolUse');
    const result = toolResult('tc_1', 'read_file', [{ type: 'text', text: 'readme-ok' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }], 12);
    const history = [BASE_SYSTEM, user, first.terminal.message, result];
    const continued = await send([...history, { role: 'system', content: '', timestamp: 13 }], 3);
    assert.equal(continued.terminal?.reason, 'stop');
    assert.equal(driver.runs.length, 1);
    assert.ok(driver.getDriverState(parkedDriver).reentryCalls >= 1);
    assert.equal(parkedResult.isError, false);
    assert.equal(parkedResult.content.some(block => block.type === 'image'), false, 'MCP must not duplicate hook image blocks');
    assert.deepEqual(driver.imageDeliveries.map(({ toolCallId, images }) => ({ toolCallId, images })), [
      { toolCallId: 'tc_1', images: [{ data: PNG_1X1, mimeType: 'image/png' }] },
    ]);
    assert.match(messageText(continued.terminal.message), /resumed:readme-ok/);

    const withReply = [...history, continued.terminal.message];
    assertHistoryChanged(await send(withReply, 4));
    assert.equal(driver.runs.length, 1, 'an assistant-only resume must not invent a replay prompt');
    const next = await send([...withReply, { role: 'user', content: 'A new user turn', timestamp: 20 }], 5);
    assert.equal(next.terminal?.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.doesNotMatch(driver.runs[1].request.prompt, /TRIGGER_PARK|readme-ok/);
    assert.equal(driver.runs[1].request.contextBlock, undefined);
    assert.equal(driver.runs[1].request.images, undefined);
    await send([BASE_SYSTEM, { role: 'user', content: 'from dev-b', timestamp: 20 }], 1, { deviceId: 'dev-b' });
    await send([BASE_SYSTEM, { role: 'user', content: 'from other session', timestamp: 21 }], 1, { sessionId: 'other' });
    assert.equal(driver.runs[2].request.conversationId, null);
    assert.equal(driver.runs[3].request.conversationId, null);
    assert.notEqual(driver.runs[2].assignedConversationId, driver.runs[3].assignedConversationId);
  } finally { await closeAndRemove({ antigravity, rootDir }); }
});

test('Legacy native bindings require clear; new bindings load after restart without replay or automatic recall', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-legacy-'));
  const deviceId = 'dev-recall';
  const sessionsPath = path.join(rootDir, 'center', 'antigravity', 'sessions.json');
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  fs.writeFileSync(sessionsPath, JSON.stringify({
    [makeSessionKey(deviceId, 'legacy')]: { conversationId: 'legacy-conversation', lastStepIdx: -1, lastMessageCount: 2 },
  }));
  let antigravity = openIsolatedAntigravity(rootDir);
  const send = (sessionId, messages) => drainEventStream(antigravity.stream({
    deviceId, sessionId, modelId: MODEL_ID, messages,
    turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] },
  }));
  try {
    const prior = { role: 'user', content: 'Ordinary earlier request', timestamp: 10 };
    const current = { role: 'user', content: 'First message after upgrading', timestamp: 12 };
    assertHistoryChanged(await send('legacy', [BASE_SYSTEM, prior, asstText('Ordinary earlier answer', 11), current]));
    assert.equal(driver.runs.length, 0, 'upgrading must not synthesize a replayed native context');
    const first = await send('cleared', [BASE_SYSTEM, current]);
    assert.equal(first.terminal?.reason, 'stop');
    assert.equal(driver.runs[0].request.conversationId, null);
    assert.equal(driver.runs[0].request.turnRecall, undefined);
    assert.equal(driver.runs[0].request.contextBlock, undefined);
    await antigravity.close();
    antigravity = openIsolatedAntigravity(rootDir);
    const genuineLookalike = { role: 'user', content: '<hindsight_memories>Real user text after restart</hindsight_memories>', timestamp: 0 };
    const second = await send('cleared', [BASE_SYSTEM, current, first.terminal.message, genuineLookalike]);
    assert.equal(second.terminal?.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.ok(driver.runs[1].request.prompt.includes(genuineLookalike.content));
    assert.doesNotMatch(driver.runs[1].request.prompt, /First message after upgrading|Ordinary earlier/);
    assert.equal(driver.runs[1].request.turnRecall, undefined);
    assert.equal(driver.runs[1].request.contextBlock, undefined);
  } finally { await closeAndRemove({ antigravity, rootDir }); }
});

test('Persists separate received-history and native-dispatch states when another binding arrives during a write', async (t) => {
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
  const delta = createAntigravityHistoryTransport().prepare({ sessionId: 'first', modelId: MODEL_ID,
    messages: [BASE_SYSTEM, { role: 'user', content: 'received', timestamp: 1 }] }).payload.delta;
  const { history } = acceptHistoryDelta(null, delta);
  store.set(firstKey, { conversationId: 'first-native', lastStepIdx: -1, history, phase: 'uncertain', attemptedThrough: 1, consumedUserIndices: [0] });
  try {
    await writing;
    store.set(secondKey, { conversationId: '', lastStepIdx: -1, history, phase: 'new', attemptedThrough: 0, consumedUserIndices: [] });
  } finally {
    releaseWrite();
    await store.flush();
  }
  const reopened = new SessionStore(sessionsPath);
  assert.equal(reopened.get(firstKey)?.phase, 'uncertain');
  assert.deepEqual(reopened.get(firstKey)?.consumedUserIndices, [0]);
  assert.equal(reopened.get(secondKey)?.phase, 'new');
  assert.deepEqual(reopened.get(secondKey)?.consumedUserIndices, []);
  assert.equal(reopened.get(secondKey)?.history.messages.length, 1, 'received history is durable without marking native consumption');
});

test('Missing input and unbound continuations fail; HTTP accepts only canonical delta turnContext and rejects legacy full messages', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-reject-'));
  const antigravity = openIsolatedAntigravity(rootDir);
  let routes;
  try {
    const user = { role: 'user', content: 'valid user', timestamp: 100 };
    for (const [label, messages, turnContext] of [
      ['pure system', [BASE_SYSTEM], { inputIndex: null, auxiliaryIndices: [] }],
      ['aux only', [BASE_SYSTEM, { role: 'user', content: 'auxiliary', timestamp: 0 }], { inputIndex: null, auxiliaryIndices: [1] }],
      ['unbound result', [BASE_SYSTEM, user, asstToolCall('tc1', 'read_file', { path: 'x' }, 101), toolResult('tc1', 'read_file', 'r', 102)], { inputIndex: 3, auxiliaryIndices: [] }],
      ['unbound assistant', [BASE_SYSTEM, user, asstText('answer', 101)], { inputIndex: 2, auxiliaryIndices: [] }],
    ]) {
      const response = await drainEventStream(antigravity.stream({ deviceId: 'd', sessionId: label, modelId: MODEL_ID, messages, turnContext }));
      assertHistoryChanged(response);
    }
    assert.equal(driver.runs.length, 0);

    const handlers = new Map();
    const forwarded = [];
    routes = registerAntigravityRoutes({
      store: {
        getProvider: id => id === ANTIGRAVITY_PROVIDER_ID ? { id, enabled: true } : null,
        listDeviceBots: () => [{ botId: 'bot-1' }],
        getBotModelConfig: () => ({ effective: { modelRef: MODEL_REF } }),
        listModels: () => [{ id: MODEL_ID, enabled: true }],
      },
      bridge: { registry: { authenticate: () => true } }, catalog: { apply: async () => {} },
      host: (method, url, handler) => handlers.set(`${method} ${url}`, handler),
      antigravity: { stream: (params, options) => { forwarded.push(params); return antigravity.stream(params, options); }, cancel: async () => {} },
      changed: value => value,
    });
    const handler = handlers.get(`POST ${ANTIGRAVITY_STREAM_PATH}`);
    const prepared = createAntigravityHistoryTransport().prepare({
      sessionId: 'valid', modelId: MODEL_ID, messages: [BASE_SYSTEM, user],
      turnContext: { inputIndex: 1, auxiliaryIndices: [], routingPolicy: 'rules-v1' },
    }).payload;
    const request = body => ({ centerDevice: { deviceId: 'd', token: 't' }, body,
      raw: { aborted: false, destroyed: false, on() {}, off() {} } });
    for (const [label, turnContext] of [
      ['null', null], ['array', []], ['missing index', {}],
      ['extra field', { inputIndex: 0, extra: true }],
      ['obsolete auxiliary indices', { inputIndex: 0, auxiliaryIndices: [] }],
      ['negative', { inputIndex: -1 }], ['fractional', { inputIndex: 0.5 }],
      ['out of bounds', { inputIndex: 1 }], ['bad route data', { inputIndex: 0, routeNote: {} }],
    ]) {
      await assert.rejects(() => handler(request({ ...prepared, turnContext }), { raw: { destroyed: false } }),
        error => error.code === 'INVALID_ARGUMENT', label);
    }
    await assert.rejects(() => handler(request({ sessionId: 'legacy', modelId: MODEL_ID, messages: [BASE_SYSTEM, user] }), { raw: { destroyed: false } }),
      error => error.code === 'AGY_HISTORY_CHANGED' && /\/clear/.test(error.message));
    await assert.rejects(() => handler(request({ ...prepared, delta: { ...prepared.delta, messages: [BASE_SYSTEM] } }), { raw: { destroyed: false } }),
      error => error.code === 'INVALID_ARGUMENT', 'system messages cannot masquerade as history');
    assert.equal(forwarded.length, 0);
    assert.equal(driver.runs.length, 0);

    const lines = [];
    await handler(request({ ...prepared, turnContext: { inputIndex: 0, routeNote: 'Current request: timer-22' } }),
      { hijack() {}, raw: { destroyed: false, writableEnded: false, writeHead() {}, flushHeaders() {}, write(line) { lines.push(line); return true; }, end() { this.writableEnded = true; }, on() {}, off() {} } });
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0].turnContext, { inputIndex: 0, routeNote: 'Current request: timer-22' });
    assert.equal(driver.runs.length, 1);
    assert.ok(lines.some(line => JSON.parse(line).type === 'history_ack'));
    assert.ok(lines.some(line => JSON.parse(line).type === 'done'));
    assert.match(driver.runs[0].request.prompt, /timer-22/);
  } finally { await closeAndRemove({ routes, antigravity, rootDir }); }
});

test('Standalone createAntigravityProvider projects the canonical append-only tail without fabricated memory provenance', async () => {
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
  assert.deepEqual(sent[0].turnContext, { inputIndex: 0 });
  assert.equal(Object.hasOwn(sent[0], 'messages'), false);
  assert.equal(sent[0].delta.messages.length, 1);
  assert.equal(messageText(wireInput(sent[0])), 'standalone');
  assert.equal(sent[0].delta.config.routingPolicy, '');
});


test('Real Runtime rejects entering or switching AGY with history before mutation; edit/compact stay blocked until clear', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-policy-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  const ordinaryCalls = [];
  const fixtureApi = `agy-policy-${path.basename(rootDir)}`;
  const ordinaryStream = (model, context) => {
    ordinaryCalls.push(structuredClone(context));
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = asstText('ordinary provider reply', Date.now(), model.provider, model.api, model.id);
      events.push({ type: 'done', reason: 'stop', message });
      events.end(message);
    });
    return events;
  };
  registerApiProvider({ api: fixtureApi, stream: ordinaryStream, streamSimple: ordinaryStream }, fixtureApi);
  let runtime;
  try {
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured, fixtureApi });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'policy-bot', role: 'Policy', cwd, makePrimary: true });
    const ordinary = { modelRef: 'fixture/model', thinkingLevel: 'off', codemode: false, codemodeOnly: false };
    const alt = { ...BASE_MODEL_SEL, modelRef: `${ANTIGRAVITY_PROVIDER_ID}/second-model` };
    const snapshot = (revision, model) => env.makeSnapshot(revision, [{ botId: bot.botId, cwd, model, capabilities: [] }]);
    const done = async (requestId, text) => {
      await runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      const receipt = await env.waitForSubmission(bot.botId, requestId);
      assert.equal(receipt.status, 'done', JSON.stringify(receipt));
    };
    const guarded = error => error.code === 'AGY_HISTORY_CHANGED' && /\/clear/.test(error.message);
    assert.deepEqual(await runtime.assertModelSelectionAllowed(bot.botId, MODEL_REF), { botId: bot.botId, allowed: true });
    await env.applySnapshot(snapshot(2, ordinary));
    await done('ordinary-first', 'Existing non-AGY history');
    await done('ordinary-second', 'Another ordinary-provider input');
    for (const ref of [MODEL_REF, alt.modelRef]) await assert.rejects(() => runtime.assertModelSelectionAllowed(bot.botId, ref), guarded);
    const rejected = await runtime.applyCenterSnapshot(snapshot(3, BASE_MODEL_SEL));
    assert.equal(rejected.status, 'failed');
    assert.match(JSON.stringify(rejected), /AGY_HISTORY_CHANGED/);
    // This guard reads the selected provider before turn preparation can reapply a snapshot.
    // It must still allow ordinary-provider edits immediately after the rejected mutation.
    const oldEntry = (await runtime.history(bot.botId, { limit: 50 })).items.find(entry => entry.data?.requestId === 'ordinary-second');
    assert.ok(oldEntry);
    await runtime.editMessage(bot.botId, { entryId: oldEntry.id, requestId: 'ordinary-edited', text: 'Edited with the ordinary provider' });
    assert.equal((await env.waitForSubmission(bot.botId, 'ordinary-edited')).status, 'done');
    await env.applySnapshot(snapshot(4, ordinary));
    await done('ordinary-still-selected', 'Continue with the existing provider');
    assert.equal(ordinaryCalls.length, 4);
    assert.equal(captured.length, 0);
    await runtime.clearHistory(bot.botId);
    assert.deepEqual(await runtime.assertModelSelectionAllowed(bot.botId, MODEL_REF), { botId: bot.botId, allowed: true });
    await env.applySnapshot(snapshot(5, BASE_MODEL_SEL));
    await done('agy-first', 'AGY established input');
    assert.equal(driver.runs.length, 1);
    await assert.rejects(() => runtime.assertModelSelectionAllowed(bot.botId, alt.modelRef), guarded);
    const rejectedInternal = await runtime.applyCenterSnapshot(snapshot(6, alt));
    assert.equal(rejectedInternal.status, 'failed');
    assert.match(JSON.stringify(rejectedInternal), /AGY_HISTORY_CHANGED/);
    await env.applySnapshot(snapshot(7, BASE_MODEL_SEL));
    const history = await runtime.history(bot.botId, { limit: 50 });
    const entry = history.items.find(item => item.data?.requestId === 'agy-first');
    assert.ok(entry);
    await assert.rejects(() => runtime.editMessage(bot.botId, { entryId: entry.id, requestId: 'blocked-edit', text: 'Changed input' }), guarded);
    await assert.rejects(() => runtime.compact(bot.botId), guarded);
    assert.deepEqual((await runtime.history(bot.botId, { limit: 50 })).items, history.items, 'rejected mutations do not write or fork history');
    await done('agy-continues', 'Continue original AGY model');
    assert.equal(driver.runs[1].request.model, MODEL_ID);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);

    await runtime.clearHistory(bot.botId);
    await runtime.assertModelSelectionAllowed(bot.botId, alt.modelRef);
    await env.applySnapshot(snapshot(8, alt));
    await done('agy-after-clear', 'Fresh alternate AGY model');
    assert.equal(driver.runs[2].request.model, 'second-model');
    assert.equal(driver.runs[2].request.conversationId, null);
    assert.notEqual(captured.at(-1).sessionId, captured[0].sessionId);
    assert.doesNotMatch(driver.runs[2].request.prompt, /AGY established input|Existing non-AGY history/);

    // Switching away must not erase the fact that this history was submitted to AGY.
    await env.applySnapshot(snapshot(9, ordinary));
    const protectedEntry = (await runtime.history(bot.botId, { limit: 50 })).items.find(item => item.data?.requestId === 'agy-after-clear');
    await assert.rejects(() => runtime.editMessage(bot.botId, { entryId: protectedEntry.id, requestId: 'blocked-away', text: 'Rewrite old AGY input' }), guarded);
    await assert.rejects(() => runtime.compact(bot.botId), guarded);
    await runtime.clearHistory(bot.botId);
    await done('ordinary-after-clear', 'Ordinary provider remains usable after clear');
  } finally { await closeAndRemove({ runtime, antigravity, rootDir }); }
});

test('Real Runtime accepts changing user/scheduled routing, but SOUL and outer tool changes require clear', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-config-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  let runtime;
  try {
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'config-bot', role: 'Config', cwd, makePrimary: true });
    const config = capabilities => [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities }];
    await env.applySnapshot(env.makeSnapshot(2, config([])));
    const send = async (requestId, text, scheduled = false) => {
      if (scheduled) await runtime.submitScheduled(bot.botId, { requestId, text, stopEpoch: 0 });
      else await runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      return env.waitForSubmission(bot.botId, requestId);
    };
    assert.equal((await send('human-first', 'Human question')).status, 'done');
    assert.equal((await send('timer-second', 'Scheduled observation', true)).status, 'done');
    assert.equal((await send('human-third', 'Another human question')).status, 'done');
    assert.equal(driver.runs.length, 3);
    assert.equal(captured[0].turnContext.routeNote, undefined);
    assert.match(captured[1].turnContext.routeNote, /Host scheduled run or signal/);
    assert.equal(captured[2].turnContext.routeNote, undefined);
    assert.ok(captured.every(payload => payload.delta.configHash === captured[0].delta.configHash));
    assert.ok(driver.runs.slice(1).every(run => run.request.conversationId === driver.runs[0].assignedConversationId));
    assert.ok(captured[0].delta.config.routingPolicy.length > 0);

    const soul = await runtime.getBotSoul(bot.botId);
    await runtime.setBotSoul(bot.botId, { expectedRevision: soul.revision, text: soul.text + '\nNEW_FIXED_SOUL_RULE' });
    const beforeSoul = captured.length;
    assert.notEqual((await send('changed-soul', 'Please continue')).status, 'done');
    assert.equal(captured.length, beforeSoul, 'Host refuses changed stable config before contacting Center');
    assert.equal(driver.runs.length, 3);
    assert.match(JSON.stringify(await runtime.history(bot.botId, { limit: 50 })), /AGY_HISTORY_CHANGED.*\/clear/);
    await runtime.clearHistory(bot.botId);
    assert.equal((await send('new-soul', 'Use the new instructions')).status, 'done');
    assert.match(driver.runs.at(-1).request.systemPrompt, /NEW_FIXED_SOUL_RULE/);
    assert.equal(driver.runs.at(-1).request.conversationId, null);

    await env.applySnapshot(env.makeSnapshot(3, config([makeCapability('test-probe-tools', { enableModelOnlyProbe: true })])));
    const beforeTools = captured.length;
    assert.notEqual((await send('changed-tools', 'Use the new direct tool')).status, 'done');
    assert.equal(captured.length, beforeTools);
    assert.equal(driver.runs.length, 4);
    assert.match(JSON.stringify(await runtime.history(bot.botId, { limit: 50 })), /AGY_HISTORY_CHANGED.*\/clear/);
    await runtime.clearHistory(bot.botId);
    assert.equal((await send('new-tools', 'Start with the new tools')).status, 'done');
    assert.ok(captured.at(-1).delta.config.tools.some(tool => tool.name === 'model_only_probe'));
    assert.equal(driver.runs.at(-1).request.conversationId, null);
    assert.equal(driver.runs.length, 5);
  } finally { await closeAndRemove({ runtime, antigravity, rootDir }); }
});

test('Real Runtime does not rewrite AGY history for threshold or provider-overflow compaction', async (t) => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-no-compact-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  const antigravity = openIsolatedAntigravity(rootDir);
  const captured = [];
  let runtime;
  try {
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'no-compact-bot', role: 'Compact', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        ctx.emit({ type: 'usage', usage: { input_tokens: 127_000, output_tokens: 20 } });
        ctx.emit({ type: 'text', delta: 'Keep the full original history.' });
        ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'Keep the full original history.', finished: true, aborted: false });
      } else {
        ctx.finish({ conversationId: ctx.conversationId, status: 'ERROR', response: '', error: 'maximum context length exceeded', finished: true, aborted: false });
      }
    });
    await runtime.submit(bot.botId, { requestId: 'near-threshold', text: 'Original immutable input' });
    assert.equal((await env.waitForSubmission(bot.botId, 'near-threshold')).status, 'done');
    const firstReply = (await runtime.history(bot.botId, { limit: 50 })).items
      .flatMap(entry => entry.model ?? []).find(message => message.role === 'assistant');
    assert.equal(firstReply?.usage.input, 127_000, 'the fixture must actually cross the SDK compaction threshold');
    await runtime.submit(bot.botId, { requestId: 'overflow', text: 'Next user input' });
    assert.notEqual((await env.waitForSubmission(bot.botId, 'overflow')).status, 'done');
    assert.equal(driver.runs.length, 2, 'threshold and overflow must not schedule an extra summarization or replay call');
    assert.equal(captured.length, 2);
    assert.equal(captured[1].sessionId, captured[0].sessionId);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal(driver.runs[1].request.contextBlock, undefined);
    assert.match(driver.runs[1].request.prompt, /Next user input/);
    assert.doesNotMatch(driver.runs[1].request.prompt, /Original immutable input|summarization assistant/);
    const history = JSON.stringify((await runtime.history(bot.botId, { limit: 100 })).items);
    assert.match(history, /Original immutable input/);
    assert.doesNotMatch(history, /compacted into the following summary/);
  } finally { await closeAndRemove({ runtime, antigravity, rootDir }); }
});
