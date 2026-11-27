import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openHost } from '../../host-core/host.js';
import { openRuntime } from '../../host-core/runtime.js';
import { getPrimaryConversation } from '../../host-core/runtime-docs.js';
import { createRuntimeLive } from '../../host-core/runtime-live.js';
import { createTurnAdmission } from '../../host-core/runtime-turns.js';
import { WorkContextState, ensureWorkBinding } from '../../host-core/work-context-docs.js';
import { createWorkInput } from '../../host-core/work-decision-codec.js';
import { WorkDecisionState } from '../../host-core/work-decision-state.js';

import { BACKGROUND_CONTEXT as context } from '../../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { registerApiProvider } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/compat.js';
import { createModels } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';
import { Harness, createRegistry } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';
import { openNodeSqliteStorage } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(read, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    `Timed out waiting for ${label}; last=${JSON.stringify(last)}${lastErr ? `; err=${lastErr.message}` : ''}`,
  );
}

function makeMockStreamFactory(handler) {
  return (model, request, options) => {
    const events = createAssistantMessageEventStream();
    const usage = {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const buildMessage = (content, reason, errorMessage) => ({
      role: 'assistant',
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: reason,
      timestamp: Date.now(),
      ...(errorMessage ? { errorMessage } : {}),
    });
    let finished = false;
    let textStarted = false;
    let streamedText = '';
    const emitTextDelta = (delta) => {
      if (finished || options?.signal?.aborted) return;
      if (!textStarted) {
        textStarted = true;
        events.push({ type: 'start', partial: buildMessage([], 'stop') });
        events.push({
          type: 'text_start',
          contentIndex: 0,
          partial: buildMessage([{ type: 'text', text: '' }], 'stop'),
        });
      }
      streamedText += delta;
      events.push({
        type: 'text_delta',
        contentIndex: 0,
        delta,
        partial: buildMessage([{ type: 'text', text: streamedText }], 'stop'),
      });
    };
    const finish = (content, reason, errorMessage) => {
      if (finished) return;
      finished = true;
      if (textStarted && reason !== 'error' && reason !== 'aborted') {
        events.push({
          type: 'text_end',
          contentIndex: 0,
          content: streamedText,
          partial: buildMessage([{ type: 'text', text: streamedText }], 'stop'),
        });
      }
      const message = buildMessage(content, reason, errorMessage);
      events.push(
        reason === 'error' || reason === 'aborted'
          ? { type: 'error', reason, error: message }
          : { type: 'done', reason, message },
      );
      events.end(message);
    };
    const abort = () => finish([], 'aborted', 'Fixture invocation aborted');
    queueMicrotask(async () => {
      if (options?.signal?.aborted) {
        abort();
        return;
      }
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const content = await handler(request, model, options, { emitTextDelta });
        if (options?.signal?.aborted) abort();
        else finish(content, content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop');
      } catch (error) {
        finish([], 'error', error instanceof Error ? error.message : String(error));
      } finally {
        options?.signal?.removeEventListener('abort', abort);
      }
    });
    return events;
  };
}

async function openRuntimeFixture(t, { extraBots = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pibot-primary-live-bind-'));
  const dataRoot = join(root, 'host');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const api = `primary-live-bind-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = {
    handler: async () => [{ type: 'text', text: 'completed' }],
    prepareErrorForBot: new Map(),
  };
  const stream = makeMockStreamFactory((request, model, options, controls) =>
    state.handler(request, model, options, controls),
  );
  registerApiProvider({ api, stream, streamSimple: stream }, api);

  const storedHost = openHost({ dataRoot });
  const { deviceId } = storedHost;
  storedHost.close();

  let snapshot = {
    protocol: 1,
    deviceId,
    revision: 1,
    providers: [{ id: 'fixture-provider', name: 'Fixture', api, baseUrl: 'http://127.0.0.1:9', enabled: true, credentialRef: null }],
    models: {
      'fixture-provider': [{
        id: 'fixture-model',
        name: 'Fixture',
        api,
        contextWindow: 128_000,
        maxTokens: 4_096,
        input: ['text'],
        reasoning: false,
        enabled: true,
        revision: 1,
      }],
    },
    credentials: {},
    bots: [],
  };
  const centerClient = {
    providerAuth: async () => ({ auth: { apiKey: 'fixture-key' }, source: 'center' }),
  };
  const centerRuntime = {
    snapshot: { protocol: 1 },
    installer: {},
    getClient: () => centerClient,
    prepareTurn: async ({ botId }) => {
      const configuredError = state.prepareErrorForBot.get(botId);
      if (configuredError) throw configuredError;
      return { setId: `set-${snapshot.revision}`, snapshot };
    },
    confirmTurn: async ({ requestId, setId }) => ({ admissionId: `admission-${requestId}`, setId }),
    restoreTurn: async () => ({ setId: `set-${snapshot.revision}`, snapshot }),
  };

  const runtime = await openRuntime({
    dataRoot,
    nativeBridge: async () => ({}),
    centerRuntime,
  });
  const watches = [];
  t.after(async () => {
    for (const handle of watches) {
      await handle.stop().catch(() => {});
    }
    await runtime.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const initialApplied = await runtime.applyCenterSnapshot(snapshot);
  assert.equal(initialApplied.status, 'applied', JSON.stringify(initialApplied));
  await runtime.restoreTurns();
  await runtime.setCenterOnline(true);
  runtime.resume();

  const botA = await runtime.createBot({
    requestId: 'create-bot-a',
    role: 'Coordinator Bot',
    cwd,
    makePrimary: true,
  });
  const peerBots = [];
  for (let i = 0; i < extraBots; i += 1) {
    peerBots.push(
      await runtime.createBot({
        requestId: `create-peer-${i}`,
        role: `Fresh Peer Bot ${i}`,
        cwd,
        makePrimary: false,
      }),
    );
  }
  const allBots = [botA, ...peerBots];
  snapshot = {
    ...snapshot,
    revision: 2,
    bots: allBots.map((bot) => ({
      botId: bot.botId,
      cwd: bot.cwd,
      model: {
        modelRef: 'fixture-provider/fixture-model',
        thinkingLevel: 'off',
        codemode: false,
        codemodeOnly: false,
      },
      capabilities: [],
    })),
  };
  const applied = await runtime.applyCenterSnapshot(snapshot);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));

  async function watchBot(botId) {
    const handle = await runtime.watch(botId);
    watches.push(handle);
    const frames = [];
    let current = null;
    let sawBusyTrue = false;
    let sawBusyFalseAfterTrue = false;
    handle.start((frame) => {
      frames.push(frame);
      if (frame.type === 'snapshot') {
        current = frame.state;
      } else if (frame.type === 'update' && current) {
        current = { ...current, ...frame.changes };
      }
      if (current?.busy === true) {
        sawBusyTrue = true;
      } else if (sawBusyTrue && current?.busy === false) {
        sawBusyFalseAfterTrue = true;
      }
    });
    await until(() => frames.length >= 1 && frames[0].type === 'snapshot', `initial snapshot for ${botId}`);
    return {
      frames,
      get state() { return current; },
      get sawBusyTrue() { return sawBusyTrue; },
      get sawBusyFalseAfterTrue() { return sawBusyFalseAfterTrue; },
      stop: () => handle.stop(),
    };
  }

  return { deviceId, runtime, botA, peerBots, state, watchBot };
}

test('openRuntime: pending live.watch on a fresh Bot attaches when DM creates its primary conversation via sessions.getPrimary / admitWorkDecision', async (t) => {
  const f = await openRuntimeFixture(t, { extraBots: 1 });
  const botA = f.botA;
  const botB = f.peerBots[0];

  // Fresh peer Bot has no primary conversation yet.
  assert.deepEqual((await f.runtime.history(botB.botId)).items, []);

  // Open live.watch BEFORE primary conversation exists -> sits in pendingByBot with emptyLiveState().
  const watchB = await f.watchBot(botB.botId);
  assert.equal(watchB.state.busy, false);
  assert.deepEqual(watchB.state.history, []);
  assert.equal(watchB.state.lastEntryId, null);

  const dmCreated = await f.runtime.createScope({
    requestId: 'create-dm-live-bind-1',
    kind: 'dm',
    members: [
      { deviceId: f.deviceId, botId: botA.botId },
      { deviceId: f.deviceId, botId: botB.botId },
    ],
  });
  const dmScopeId = dmCreated.scope.scopeId;

  const botBRunning = createDeferred();
  const releaseBotB = createDeferred();
  t.after(() => releaseBotB.resolve());

  let callSeq = 0;
  f.state.handler = async (request, _model, _options, { emitTextDelta }) => {
    callSeq += 1;
    const messages = request?.messages ?? [];
    const lastIsToolResult = messages[messages.length - 1]?.role === 'toolResult';
    const systemParts = [];
    if (typeof request?.systemPrompt === 'string') systemParts.push(request.systemPrompt);
    for (const msg of messages) {
      if (msg?.role !== 'system') continue;
      if (typeof msg.content === 'string') systemParts.push(msg.content);
      if (msg.sections && typeof msg.sections === 'object') {
        for (const val of Object.values(msg.sections)) {
          if (typeof val === 'string') systemParts.push(val);
        }
      }
    }
    const systemText = systemParts.join('\n');
    const serialized = JSON.stringify(request ?? {});
    const isBotB = systemText.includes(`your Bot ID is ${JSON.stringify(botB.botId)}`);

    if (!isBotB) {
      if (serialized.includes('Health check green.')) {
        return [{ type: 'text', text: 'Fresh Peer Bot reported: Health check green.' }];
      }
      if (!lastIsToolResult) {
        return [{
          type: 'toolCall',
          id: `call_a_dm_${callSeq}`,
          name: 'send_to',
          arguments: { scopeId: dmScopeId, text: 'Please check health and reply.' },
        }];
      }
      return [{ type: 'text', text: 'Dispatched health check to Fresh Peer Bot.' }];
    }

    if (!lastIsToolResult) {
      // Emit a real streaming delta after sessions.beforeRequest committed BotSessionState.turnByTask,
      // so pi.live.generation updates and the live watcher projects streaming text + DM activity mid-turn.
      emitTextDelta('Checking health...');
      botBRunning.resolve();
      await releaseBotB.promise;
      return [
        { type: 'text', text: 'Checking health...' },
        {
          type: 'toolCall',
          id: `call_b_reply_${callSeq}`,
          name: 'send_to',
          arguments: { scopeId: dmScopeId, text: 'Health check green.' },
        },
      ];
    }
    return [{ type: 'text', text: 'Reported health check green to Coordinator Bot.' }];
  };

  await f.runtime.submit(botA.botId, {
    requestId: 'req-dm-live-bind-1',
    text: 'Ask Fresh Peer Bot 0 to check health.',
  });

  // While Bot B is actively executing the DM turn, its previously-pending watcher must have attached
  // and emitted live update frames with streaming generation text and DM activity (never stuck on emptyLiveState()).
  await botBRunning.promise;
  await until(
    () =>
      watchB.frames.some((frame) => frame.type === 'update') &&
      watchB.state?.busy === true &&
      watchB.state?.generation?.text?.includes('Checking health...') &&
      watchB.state?.activity?.phase === 'running' &&
      watchB.state?.activity?.source === 'dm' &&
      watchB.state?.activity?.scopeId === dmScopeId &&
      watchB.state?.history?.some((entry) =>
        entry.kind === 'host.scope-message' &&
        (entry.messages ?? []).some((m) => String(m.text ?? '').includes('Please check health and reply.')),
      ),
    'pending live watcher attached and emitted running DM frame for Bot B',
  );

  releaseBotB.resolve();

  // After Bot B finishes, live watcher must transition busy: true -> false and show settled DM output.
  await until(
    () =>
      watchB.sawBusyTrue &&
      watchB.sawBusyFalseAfterTrue &&
      watchB.state?.busy === false &&
      (watchB.state?.lastEntryId ?? 0) > 0 &&
      watchB.state?.history?.some((entry) =>
        (entry.messages ?? []).some(
          (m) => m.role === 'assistant' && String(m.text ?? '').includes('Reported health check green to Coordinator Bot.'),
        ),
      ),
    'live watcher emitted busy true -> false transition and settled DM turn for Bot B',
  );

  const scopePage = await f.runtime.scopeHistory(dmScopeId, { order: 'ascending', limit: 20 });
  assert.ok(
    scopePage.items.some((item) => item.message?.text === 'Health check green.'),
    'DM reply from Bot B should be recorded in scope history',
  );
});

test('openRuntime: pending live.watch on a fresh Bot attaches when ensurePrimaryConversationForBot creates primary via submitTaskDispatch', async (t) => {
  const f = await openRuntimeFixture(t, { extraBots: 1 });
  const freshBot = f.peerBots[0];

  assert.deepEqual((await f.runtime.history(freshBot.botId)).items, []);
  const watch = await f.watchBot(freshBot.botId);
  assert.equal(watch.state.busy, false);
  assert.deepEqual(watch.state.history, []);
  assert.equal(watch.state.lastEntryId, null);

  // Force prepareTurn to fail so admitItem never reaches its own live.bind(botId, conversation);
  // ensurePrimaryConversationForBot in persistTaskDispatchContext must create + bind primary on its own.
  f.state.prepareErrorForBot.set(
    freshBot.botId,
    Object.assign(new Error('center temporarily offline'), { code: 'CENTER_OFFLINE' }),
  );
  const receipt = await f.runtime.submitTaskDispatch(freshBot.botId, {
    requestId: 'task-dispatch-live-bind-1',
    text: 'Run delegated global task step',
    dispatchContext: {
      taskId: 'global-task-live-bind-1',
      stepId: 'step-1',
      executionRevision: 1,
    },
  });
  assert.equal(receipt.status, 'queued');

  await until(
    () => watch.state?.turnAdmission?.phase === 'failed',
    'queued task dispatch reached failed admission while prepareTurn is offline',
  );
  await f.runtime.cancelTaskDispatch(freshBot.botId, 'task-dispatch-live-bind-1');
  await until(
    () => watch.state?.turnAdmission === null && watch.state?.queuedCount === 0,
    'cancelled task dispatch cleared queue',
  );

  // clearHistory on a created primary conversation appends a pi.reset entry (clearedThroughEntryId > 0);
  // the bound watcher must observe the reset frame immediately.
  const cleared = await f.runtime.clearHistory(freshBot.botId);
  assert.ok(cleared.clearedThroughEntryId > 0, 'ensurePrimaryConversationForBot should have created primary conversation');
  await until(
    () =>
      watch.frames.some((frame) => frame.type === 'update') &&
      watch.state?.lastEntryId === cleared.clearedThroughEntryId &&
      watch.state?.history?.some((entry) => entry.kind === 'pi.reset' && entry.id === cleared.clearedThroughEntryId),
    'watcher attached to primary conversation emitted pi.reset live update',
  );
});

test('admitWorkDecision: binds pending primary live watcher for unifiedExecution, skips legacy work, and ignores live.bind failures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-admit-work-live-bind-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const host = openHost({ dataRoot: join(root, 'host') });
  const bot = host.createBot({
    requestId: 'create-admit-work-bot',
    role: 'Worker Bot',
    cwd,
    makePrimary: true,
  });

  const models = createModels();
  const modelDef = {
    id: 'mock-work-model',
    name: 'Mock Work Model',
    provider: 'mock-work',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:0',
    contextWindow: 128_000,
    maxTokens: 4_096,
    input: ['text'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let gateFirstCall = true;
  const workGenStarted = createDeferred();
  const releaseWorkGen = createDeferred();
  const makeStream = makeMockStreamFactory(async () => {
    if (gateFirstCall) {
      gateFirstCall = false;
      workGenStarted.resolve();
      await releaseWorkGen.promise;
      return [{ type: 'text', text: 'Unified work turn completed.' }];
    }
    return [{ type: 'text', text: 'Subsequent work turn completed.' }];
  });
  models.setProvider({
    id: 'mock-work',
    name: 'Mock Work',
    auth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'mock-key' }, source: 'mock' }) } },
    getModels: () => [modelDef],
    stream: makeStream,
    streamSimple: makeStream,
  });

  const registry = createRegistry();
  const storage = await openNodeSqliteStorage(join(root, 'host', 'durable.sqlite'));
  const harness = await Harness.open(storage, { registry, models }, context);
  const live = createRuntimeLive({
    host,
    getHarness: () => harness,
    resolveWorkContext: async () => null,
  });
  const createdTurns = [];
  let watch = null;
  t.after(async () => {
    releaseWorkGen.resolve();
    for (const instance of createdTurns) instance.close();
    if (watch) await watch.stop().catch(() => {});
    await live.close().catch(() => {});
    await harness.close(context).catch(() => {});
    host.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // 1. Start live.watch BEFORE the Bot has a primary conversation.
  watch = await live.watch(bot.botId);
  const frames = [];
  let liveState = null;
  let sawBusyTrue = false;
  let sawBusyFalseAfterTrue = false;
  watch.start((frame) => {
    frames.push(frame);
    if (frame.type === 'snapshot') liveState = frame.state;
    else if (frame.type === 'update' && liveState) liveState = { ...liveState, ...frame.changes };
    if (liveState?.busy === true) sawBusyTrue = true;
    else if (sawBusyTrue && liveState?.busy === false) sawBusyFalseAfterTrue = true;
  });
  await until(() => frames.length >= 1 && frames[0].type === 'snapshot', 'initial empty snapshot');
  assert.equal(liveState.busy, false);
  assert.deepEqual(liveState.history, []);
  assert.equal(liveState.lastEntryId, null);

  // 2. Create primary conversation directly WITHOUT calling live.bind so watch remains pending.
  const primaryConv = await getPrimaryConversation(
    harness,
    { ...bot, modelRef: 'mock-work/mock-work-model' },
    {
      create: true,
      defaultModel: 'mock-work/mock-work-model',
      thinkingLevel: 'off',
      instructions: 'You are Worker Bot.',
    },
    context,
  );

  // 3. Prepare unified work decision targeting primaryConv (executionNativeId = primaryConv.id).
  const dmScope = { scopeId: 'scope-dm-unit-1', kind: 'dm' };
  const unifiedReqId = 'work-req-unified-1';
  const unifiedBinding = await harness.commit(async (tx) => {
    const bound = await ensureWorkBinding(tx, host.deviceId, bot, dmScope, {
      model: { provider: 'mock-work', modelId: 'mock-work-model' },
      thinkingLevel: 'off',
      instructions: 'Work coord',
      selectedExtensions: [],
    });
    const decision = await tx.doc(WorkDecisionState, bound.nativeId);
    decision.pending = {
      requestId: unifiedReqId,
      submissionId: null,
      startedAt: new Date().toISOString(),
      startedThroughLocalId: 1,
      prepared: null,
      published: false,
      publishedCount: 0,
      passed: false,
      replyRequired: false,
      nudgeCount: 0,
      wakeContext: null,
      replan: false,
      executionNativeId: primaryConv.id,
      executionConversationId: bot.primaryConversationId,
      turn: {
        requestId: unifiedReqId,
        taskId: null,
        kind: 'dm',
        scopeId: dmScope.scopeId,
        workNativeId: bound.nativeId,
        sender: { kind: 'bot', botId: 'peer-bot', deviceId: host.deviceId },
        replyTarget: { kind: 'dm', scopeId: dmScope.scopeId, botId: 'peer-bot' },
        frozenAt: new Date().toISOString(),
      },
    };
    return bound;
  }, context);

  const bindCalls = [];
  const spiedLive = {
    ...live,
    bind: async (botId, conv) => {
      bindCalls.push({ botId, nativeId: conv?.id });
      return live.bind(botId, conv);
    },
  };

  let botModels = { [bot.botId]: { modelRef: 'mock-work/mock-work-model', thinkingLevel: 'off' } };
  const snapshot = {
    protocol: 1,
    deviceId: host.deviceId,
    revision: 1,
    credentials: {},
    bots: [{
      botId: bot.botId,
      cwd: bot.cwd,
      model: { modelRef: 'mock-work/mock-work-model', thinkingLevel: 'off' },
      capabilities: [],
    }],
  };
  const makeTurns = (liveDep) => {
    const instance = createTurnAdmission({
      host,
      getHarness: () => harness,
      context,
      sessions: null, // Intentionally null so admitWorkDecision itself must call live.bind.
      centerRuntime: {
        prepareTurn: async () => ({ setId: 'set-1', snapshot }),
        confirmTurn: async ({ requestId, setId }) => ({ admissionId: `adm-${requestId}`, setId }),
        restoreTurn: async () => ({ setId: 'set-1', snapshot }),
      },
      plugins: {
        applyBot: async () => ({ capabilityErrors: [] }),
        hasActiveExecutions: () => false,
      },
      models,
      getBotModels: () => botModels,
      setBotModels: (next) => { botModels = next; },
      profileFor: () => ({}),
      botExecutionFingerprint: () => 'fp-1',
      applyBotCwd: async (b) => b,
      setBotAppliedRevision: () => {},
      setBotFingerprint: () => {},
      live: liveDep,
      admitBot: (_botId, fn) => fn(),
      getEpoch: () => 1,
      canAdmit: () => true,
      trackSubmission: () => {},
      recordCompletedSubmission: () => {},
      initializeBot: async () => {},
      attachments: null,
    });
    createdTurns.push(instance);
    return instance;
  };
  const turns = makeTurns(spiedLive);

  await harness.resume(context);
  const unifiedMeta = await harness.snapshot(WorkContextState, unifiedBinding.nativeId, context);
  const unifiedInput = createWorkInput(
    unifiedMeta,
    unifiedReqId,
    {
      requestId: unifiedReqId,
      taskId: null,
      kind: 'dm',
      scopeId: dmScope.scopeId,
      sender: { kind: 'bot', botId: 'peer-bot', deviceId: host.deviceId },
      replyTarget: { kind: 'dm', scopeId: dmScope.scopeId, botId: 'peer-bot' },
    },
    { peerName: 'Peer Bot', category: 'request', triggerText: 'Verify admitWorkDecision live.bind.' },
  );

  const unifiedSubmission = await turns.admitWorkDecision(unifiedBinding, bot, unifiedInput);
  assert.ok(unifiedSubmission, 'unified admitWorkDecision should submit to primary conversation');
  assert.deepEqual(bindCalls, [{ botId: bot.botId, nativeId: primaryConv.id }]);

  await workGenStarted.promise;
  await until(
    () => frames.some((frame) => frame.type === 'update') && liveState?.busy === true,
    'pending watcher attached via admitWorkDecision and emitted busy=true',
  );

  releaseWorkGen.resolve();
  await until(
    () =>
      sawBusyTrue &&
      sawBusyFalseAfterTrue &&
      liveState?.busy === false &&
      (liveState?.lastEntryId ?? 0) > 0 &&
      liveState.history.some((entry) =>
        (entry.messages ?? []).some(
          (m) => m.role === 'assistant' && String(m.text ?? '').includes('Unified work turn completed.'),
        ),
      ),
    'watcher emitted busy=false and settled unified work reply',
  );
  await until(async () => {
    const inspection = await harness.inspect(context);
    return inspection.submissions.length === 0 && inspection.tasks.length === 0;
  }, 'harness idle after unified work turn');

  // 4. Legacy non-unified work (executionNativeId = null) must NOT call live.bind.
  const legacyScope = { scopeId: 'scope-dm-legacy-1', kind: 'dm' };
  const legacyReqId = 'work-req-legacy-1';
  const legacyBinding = await harness.commit(async (tx) => {
    const bound = await ensureWorkBinding(tx, host.deviceId, bot, legacyScope, {
      model: { provider: 'mock-work', modelId: 'mock-work-model' },
      thinkingLevel: 'off',
      instructions: 'Legacy work coord',
      selectedExtensions: [],
    });
    const decision = await tx.doc(WorkDecisionState, bound.nativeId);
    decision.pending = {
      requestId: legacyReqId,
      submissionId: null,
      startedAt: new Date().toISOString(),
      startedThroughLocalId: 1,
      prepared: null,
      published: false,
      publishedCount: 0,
      passed: false,
      replyRequired: false,
      nudgeCount: 0,
      wakeContext: null,
      replan: false,
      executionNativeId: null,
      executionConversationId: null,
      turn: null,
    };
    return bound;
  }, context);

  bindCalls.length = 0;
  const legacyMeta = await harness.snapshot(WorkContextState, legacyBinding.nativeId, context);
  const legacyInput = createWorkInput(legacyMeta, legacyReqId, null, null);
  const legacySubmission = await turns.admitWorkDecision(legacyBinding, bot, legacyInput);
  assert.ok(legacySubmission, 'legacy admitWorkDecision should submit to legacy work conversation');
  assert.deepEqual(bindCalls, [], 'legacy non-unified work must not bind primary live watcher');
  await until(async () => {
    const inspection = await harness.inspect(context);
    return inspection.submissions.length === 0 && inspection.tasks.length === 0;
  }, 'harness idle after legacy work turn');

  // 5. A failing live.bind must be caught and must never break unified work submission.
  let failingBindAttempts = 0;
  const turnsWithFailingLive = makeTurns({
    bind: async () => {
      failingBindAttempts += 1;
      throw new Error('simulated live.bind failure');
    },
  });
  const resilientReqId = 'work-req-unified-bind-error-1';
  await harness.commit(async (tx) => {
    const decision = await tx.doc(WorkDecisionState, unifiedBinding.nativeId);
    decision.pending = {
      requestId: resilientReqId,
      submissionId: null,
      startedAt: new Date().toISOString(),
      startedThroughLocalId: 2,
      prepared: null,
      published: false,
      publishedCount: 0,
      passed: false,
      replyRequired: false,
      nudgeCount: 0,
      wakeContext: null,
      replan: false,
      executionNativeId: primaryConv.id,
      executionConversationId: bot.primaryConversationId,
      turn: {
        requestId: resilientReqId,
        taskId: null,
        kind: 'dm',
        scopeId: dmScope.scopeId,
        workNativeId: unifiedBinding.nativeId,
        sender: { kind: 'bot', botId: 'peer-bot', deviceId: host.deviceId },
        replyTarget: { kind: 'dm', scopeId: dmScope.scopeId, botId: 'peer-bot' },
        frozenAt: new Date().toISOString(),
      },
    };
  }, context);

  const resilientInput = createWorkInput(
    unifiedMeta,
    resilientReqId,
    {
      requestId: resilientReqId,
      taskId: null,
      kind: 'dm',
      scopeId: dmScope.scopeId,
      sender: { kind: 'bot', botId: 'peer-bot', deviceId: host.deviceId },
      replyTarget: { kind: 'dm', scopeId: dmScope.scopeId, botId: 'peer-bot' },
    },
    { peerName: 'Peer Bot', category: 'request', triggerText: 'Verify live.bind failure isolation.' },
  );
  const resilientSubmission = await turnsWithFailingLive.admitWorkDecision(unifiedBinding, bot, resilientInput);
  assert.equal(failingBindAttempts, 1);
  assert.ok(resilientSubmission, 'admitWorkDecision must still submit when live.bind throws');
  await until(async () => {
    const inspection = await harness.inspect(context);
    return inspection.submissions.length === 0 && inspection.tasks.length === 0;
  }, 'harness idle after resilient unified work turn');
});
