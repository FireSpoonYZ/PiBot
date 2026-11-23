// Shared controlled ACP fixture. Real Host, durable SDK and Center remain active.
import fs from 'node:fs';
import path from 'node:path';
import { openAntigravity } from '../../../center-server/antigravity/index.js';
import { SharedMcpBridge } from '../../../center-server/antigravity/mcp-bridge.ts';
import { AcpDriver } from '../../../center-server/antigravity/vendor/acp/driver.ts';
import { openHost } from '../../../host-core/host.js';
import { openRuntime } from '../../../host-core/runtime.js';
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID } from '../../../center-contract/antigravity.js';
const MODEL_ID = 'gemini-3-pro';
const MODEL_REF = `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}`;
const BASE_MODEL_SEL = { modelRef: MODEL_REF, thinkingLevel: 'off', codemode: false, codemodeOnly: false };
const USER_ORIGIN = { sender: { kind: 'user' }, replyTo: null };
const PENDING_STATUSES = new Set(['queued', 'placed', 'running', 'pending', 'admitted']);

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


async function openTestHostRuntime({ rootDir, antigravity, capturedPayloads, callOperation }) {
  const installer = { async getInstalled() { return null; } };
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



export { createControlledAcpDriverHarness, openIsolatedAntigravity, openTestHostRuntime, closeAndRemove, drainEventStream, waitUntil, asstText, asstToolCall, toolResult, messageText, BASE_SYSTEM, BASE_MODEL_SEL, MODEL_ID, USER_ORIGIN };
