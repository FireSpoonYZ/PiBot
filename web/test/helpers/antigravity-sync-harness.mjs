// Shared test harness for the native-turn Antigravity ACP architecture.
// Reusable by both Center and Host integration/unit tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID } from '../../../center-contract/antigravity.js';
import { openAntigravity } from '../../../center-server/antigravity/index.js';
import { SharedMcpBridge } from '../../../center-server/antigravity/mcp-bridge.ts';
import { AcpDriver } from '../../../center-server/antigravity/vendor/acp/driver.ts';
import { openHost } from '../../../host-core/host.js';
import { openRuntime } from '../../../host-core/runtime.js';

const PENDING_SUBMISSION_STATUSES = new Set(['queued', 'placed', 'running', 'pending', 'admitted']);
const DEFAULT_MODEL_ID = 'gemini-4-hydrogen';

export { openAntigravity };

export async function collectRunEvents(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export async function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 15, label = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createControlledHandle(id) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let resolveOutcome;
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve;
  });

  const emit = (activity) => {
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
    },
    emit,
    settle(result) {
      if (!closed) {
        closed = true;
        while (waiters.length > 0) waiters.shift()(null);
      }
      resolveOutcome(result);
    },
  };
}

/**
 * Patch AcpDriver.prototype and SharedMcpBridge.prototype.registerSession to drive
 * deterministic native turns without spawning an external `agy` binary.
 */
export function createControlledAcpDriverHarness(handler) {
  let activeHandler = handler;
  const states = new WeakMap();
  const runs = [];
  const mcpRegistrations = [];
  const closes = [];
  const steers = [];
  const toolImages = [];
  let pendingMcp = null;
  let convSeq = 1;
  let handleSeq = 1;
  let restored = false;

  const stateFor = (driver) => {
    let s = states.get(driver);
    if (!s) {
      s = {
        state: 'idle',
        alive: false,
        activeSessionId: null,
        activeHandle: null,
        activeTurn: null,
        conversationId: undefined,
        lastSessionId: undefined,
        onTurnEnd: undefined,
        mcp: null,
        timersPaused: false,
        pauseTimersCount: 0,
        resumeTimersCount: 0,
        spawns: 0,
        turns: 0,
        prompts: 0,
        reused: 0,
        sessionsCreated: 0,
        sessionsLoaded: 0,
        recycles: 0,
      };
      states.set(driver, s);
    }
    return s;
  };

  const savedDescriptors = [];
  const patchProperty = (proto, key, descriptor) => {
    savedDescriptors.push({
      proto,
      key,
      descriptor: Object.getOwnPropertyDescriptor(proto, key),
    });
    Object.defineProperty(proto, key, {
      configurable: true,
      ...descriptor,
    });
  };

  const origRegisterSession = SharedMcpBridge.prototype.registerSession;

  patchProperty(SharedMcpBridge.prototype, 'registerSession', {
    writable: true,
    value: function registerSession(mcpHandler) {
      const reg = origRegisterSession.call(this, mcpHandler);
      let active = true;
      let unregistered = false;
      const wrappedUnregister = () => {
        active = false;
        unregistered = true;
        if (pendingMcp === record) pendingMcp = null;
        return reg.unregister();
      };
      const wrappedWaitForDeliveries = (options) => reg.waitForDeliveries(options);
      const record = {
        bridge: this,
        token: reg.token,
        handler: mcpHandler,
        captureContext: () => mcpHandler?.captureContext?.(),
        unregister: wrappedUnregister,
        waitForDeliveries: wrappedWaitForDeliveries,
        get active() {
          return active;
        },
        get unregistered() {
          return unregistered;
        },
      };
      mcpRegistrations.push(record);
      pendingMcp = record;
      return {
        token: reg.token,
        unregister: wrappedUnregister,
        waitForDeliveries: wrappedWaitForDeliveries,
      };
    },
  });

  patchProperty(AcpDriver.prototype, 'state', {
    get() {
      return stateFor(this).state;
    },
  });

  patchProperty(AcpDriver.prototype, 'alive', {
    get() {
      return stateFor(this).alive;
    },
  });

  patchProperty(AcpDriver.prototype, 'activeSessionId', {
    get() {
      const s = stateFor(this);
      return s.alive ? s.activeSessionId : null;
    },
  });

  patchProperty(AcpDriver.prototype, 'activeHandle', {
    get() {
      return stateFor(this).activeHandle;
    },
  });

  patchProperty(AcpDriver.prototype, 'onTurnEnd', {
    get() {
      return stateFor(this).onTurnEnd;
    },
    set(fn) {
      stateFor(this).onTurnEnd = fn;
    },
  });

  patchProperty(AcpDriver.prototype, 'pauseTimers', {
    writable: true,
    value: function pauseTimers() {
      const s = stateFor(this);
      s.timersPaused = true;
      s.pauseTimersCount += 1;
    },
  });

  patchProperty(AcpDriver.prototype, 'resumeTimers', {
    writable: true,
    value: function resumeTimers() {
      const s = stateFor(this);
      s.timersPaused = false;
      s.resumeTimersCount += 1;
    },
  });

  patchProperty(AcpDriver.prototype, 'steer', {
    writable: true,
    value: async function steer(prompt, images) {
      const s = stateFor(this);
      const turn = s.activeTurn;
      if (!turn || turn.isSettled() || turn.isAborted() || !s.alive) {
        throw Object.assign(new Error('Cannot steer: no active native Antigravity prompt'), {
          code: 'INVALID_STATE',
        });
      }
      const entry = {
        driver: this,
        sessionId: s.activeSessionId,
        prompt,
        ...(images !== undefined ? { images } : {}),
      };
      steers.push(entry);
      turn.pushSteer(entry);
    },
  });

  patchProperty(AcpDriver.prototype, 'queueToolResultImages', {
    writable: true,
    value: function queueToolResultImages(toolCallId, images) {
      const s = stateFor(this);
      const turn = s.activeTurn;
      if (!turn || turn.isSettled() || turn.isAborted() || !s.alive) {
        throw new Error('Tool image delivery has no active native turn');
      }
      const entry = {
        driver: this,
        sessionId: s.activeSessionId,
        toolCallId,
        images: images.map((img) => ({ ...img })),
      };
      toolImages.push(entry);
      turn.pushToolImages(entry);
    },
  });

  patchProperty(AcpDriver.prototype, 'cancel', {
    writable: true,
    value: function cancel() {
      const s = stateFor(this);
      s.activeTurn?.triggerAbort();
    },
  });

  patchProperty(AcpDriver.prototype, 'close', {
    writable: true,
    value: async function close(reason = 'shutdown', cause) {
      const s = stateFor(this);
      closes.push({ driver: this, reason, ...(cause !== undefined ? { cause } : {}) });
      s.alive = false;
      s.state = 'dead';
      s.activeSessionId = null;
      s.recycles += 1;
      const turn = s.activeTurn;
      if (turn && !turn.isSettled()) {
        turn.closeDriver(reason, cause);
      }
      s.activeHandle = null;
      s.activeTurn = null;
    },
  });

  patchProperty(AcpDriver.prototype, 'snapshot', {
    writable: true,
    value: function snapshot() {
      const s = stateFor(this);
      const sessionId = s.activeSessionId ?? s.conversationId ?? s.lastSessionId;
      return {
        state: s.state,
        conversationId: sessionId,
        stats: {
          spawns: s.spawns,
          turns: s.turns,
          reused: s.reused,
          recycles: s.recycles,
          recycleReasons: {},
        },
        lifecycle: [],
        engine: 'acp',
        acp: {
          sessionId,
          prompts: s.prompts,
          sessionsCreated: s.sessionsCreated,
          sessionsLoaded: s.sessionsLoaded,
          kills: s.recycles,
          reconnects: Math.max(0, s.spawns - 1),
          usageSeen: false,
        },
      };
    },
  });

  patchProperty(AcpDriver.prototype, 'run', {
    writable: true,
    value: async function run(req) {
      const s = stateFor(this);
      if (req?.signal?.aborted) {
        throw new Error('aborted before start');
      }

      if (pendingMcp && pendingMcp.active) {
        s.mcp = pendingMcp;
        pendingMcp = null;
      } else if (s.mcp && !s.mcp.active) {
        s.mcp = null;
      }

      const ctrl = createControlledHandle(`h-${handleSeq++}`);
      const convId = req.conversationId ?? `conv-${convSeq++}`;
      const hotReuse = Boolean(req.conversationId) && s.alive && s.activeSessionId === req.conversationId;

      if (!s.alive) s.spawns += 1;
      s.alive = true;
      s.state = 'running';
      s.activeSessionId = convId;
      s.conversationId = convId;
      s.activeHandle = ctrl.handle;
      s.turns += 1;
      s.prompts += 1;
      if (hotReuse) s.reused += 1;
      else if (req.conversationId) s.sessionsLoaded += 1;
      else s.sessionsCreated += 1;

      const turnSteers = [];
      const turnToolImages = [];
      const steerWaiters = [];
      const abortWaiters = [];
      let nextSteerIndex = 0;
      let responseText = '';
      let settled = false;
      let aborted = false;

      const emit = (activity) => {
        if (settled) return;
        if (activity?.type === 'text' && typeof activity.delta === 'string') {
          responseText += activity.delta;
        }
        ctrl.emit(activity);
      };

      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        req.signal?.removeEventListener('abort', onAbort);
        if (s.activeHandle === ctrl.handle) s.activeHandle = null;
        if (s.activeTurn === turnControl) s.activeTurn = null;
        if (outcome.conversationId) {
          s.conversationId = outcome.conversationId;
          s.lastSessionId = outcome.conversationId;
          if (s.alive) s.activeSessionId = outcome.conversationId;
        }
        if (!s.alive) {
          s.activeSessionId = null;
          s.state = 'dead';
        } else {
          s.state = 'ready';
        }
        ctrl.settle(outcome);
        try {
          s.onTurnEnd?.(outcome);
        } catch {
          /* listener errors must not break settling */
        }
      };

      const finish = (outcome = {}) => {
        const extra = typeof outcome === 'string'
          ? { response: outcome }
          : (outcome && typeof outcome === 'object' ? outcome : {});
        settle({
          conversationId: convId,
          status: 'OK',
          response: responseText,
          finished: true,
          aborted: false,
          promptAttempted: true,
          promptTerminal: true,
          ...extra,
        });
      };

      const fail = (error, extra = {}) => {
        let opts;
        if (error && typeof error === 'object' && !(error instanceof Error)) {
          opts = { ...error, ...extra };
        } else {
          opts = {
            error: error instanceof Error ? error.message : String(error ?? 'Antigravity turn failed'),
            ...extra,
          };
        }
        settle({
          conversationId: convId,
          status: 'ERROR',
          response: responseText,
          error: opts.error ?? opts.message ?? 'Antigravity turn failed',
          finished: true,
          aborted: false,
          promptAttempted: !opts.sessionLoadFailed,
          promptTerminal: !opts.sessionLoadFailed,
          ...opts,
        });
      };

      const abort = (extra = {}) => {
        aborted = true;
        while (abortWaiters.length > 0) abortWaiters.shift()();
        settle({
          conversationId: convId,
          status: 'OK',
          response: responseText,
          finished: true,
          aborted: true,
          promptAttempted: true,
          promptTerminal: true,
          ...extra,
        });
      };

      const onAbort = () => {
        if (settled) return;
        aborted = true;
        if (abortWaiters.length > 0) {
          while (abortWaiters.length > 0) abortWaiters.shift()();
        } else {
          abort();
        }
      };

      const waitForAbort = () => {
        if (aborted || req.signal?.aborted) return Promise.resolve();
        return new Promise((resolve) => {
          abortWaiters.push(resolve);
        });
      };

      const waitForSteer = (index) => {
        const target = index === undefined ? nextSteerIndex++ : index;
        if (target < turnSteers.length) return Promise.resolve(turnSteers[target]);
        return new Promise((resolve) => {
          steerWaiters.push({ target, resolve });
        });
      };

      const setAlive = (value) => {
        s.alive = Boolean(value);
        if (!s.alive) {
          s.state = 'dead';
          s.activeSessionId = null;
        } else {
          s.activeSessionId = s.conversationId ?? convId;
          s.state = settled ? 'ready' : 'running';
        }
      };

      const turnControl = {
        isSettled: () => settled,
        isAborted: () => aborted,
        triggerAbort: onAbort,
        pushSteer: (entry) => {
          turnSteers.push(entry);
          for (let i = steerWaiters.length - 1; i >= 0; i -= 1) {
            if (steerWaiters[i].target < turnSteers.length) {
              const waiter = steerWaiters.splice(i, 1)[0];
              waiter.resolve(turnSteers[waiter.target]);
            }
          }
        },
        pushToolImages: (entry) => {
          turnToolImages.push(entry);
        },
        closeDriver: (reason, cause) => {
          settle({
            conversationId: convId,
            status: 'ERROR',
            response: responseText,
            error: `ACP driver ${reason === 'recycle' ? 'recycled' : 'shut down'} mid-turn${cause ? ` (${cause})` : ''}`,
            finished: true,
            aborted: false,
          });
        },
      };

      s.activeTurn = turnControl;
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const ctx = {
        req,
        conversationId: convId,
        emit,
        finish,
        fail,
        abort,
        mcp: s.mcp,
        driver: this,
        steers: turnSteers,
        toolImages: turnToolImages,
        waitForSteer,
        waitForAbort,
        setAlive,
      };
      runs.push(ctx);

      queueMicrotask(async () => {
        if (settled) return;
        try {
          await req.beforePrompt?.({ conversationId: convId });
          if (settled || aborted) {
            if (!settled) abort();
            return;
          }
          if (typeof activeHandler === 'function') {
            await activeHandler(ctx);
            if (aborted && !settled) abort();
          } else {
            const reply = `ack:${convId}:run-${runs.length}`;
            emit({ type: 'text', delta: reply });
            finish({ response: reply });
          }
        } catch (err) {
          if (aborted || err?.name === 'AbortError') {
            abort();
          } else {
            fail(err);
          }
        }
      });

      return ctrl.handle;
    },
  });

  const restore = () => {
    if (restored) return;
    restored = true;
    for (let i = savedDescriptors.length - 1; i >= 0; i -= 1) {
      const { proto, key, descriptor } = savedDescriptors[i];
      if (descriptor) {
        Object.defineProperty(proto, key, descriptor);
      } else {
        delete proto[key];
      }
    }
    savedDescriptors.length = 0;
  };

  return {
    restore,
    runs,
    mcpRegistrations,
    closes,
    steers,
    toolImages,
    setHandler(next) {
      activeHandler = next;
    },
    getDriverState: stateFor,
  };
}

function normalizeModelDef(entry, fallbackId) {
  if (typeof entry === 'string') {
    return {
      id: entry,
      name: entry,
      api: ANTIGRAVITY_API,
      contextWindow: 128_000,
      maxTokens: 8_192,
      input: ['text', 'image'],
      reasoning: true,
      enabled: true,
      revision: 1,
    };
  }
  const id = entry?.id ?? fallbackId;
  return {
    id,
    name: entry?.name ?? id,
    api: entry?.api ?? ANTIGRAVITY_API,
    contextWindow: entry?.contextWindow ?? 128_000,
    maxTokens: entry?.maxTokens ?? 8_192,
    input: entry?.input ?? ['text', 'image'],
    reasoning: entry?.reasoning ?? true,
    enabled: entry?.enabled ?? true,
    revision: entry?.revision ?? 1,
    ...(entry?.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
    ...(entry?.cost ? { cost: entry.cost } : {}),
  };
}

/**
 * Start a real openHost + openRuntime with an injected antigravityClient and a
 * pre-configured `antigravity-acp/<modelId>` test Bot.
 */
export async function openTestHostRuntime({
  antigravityClient,
  models,
  modelId,
  thinkingLevel = 'off',
  codemode = false,
  codemodeOnly = false,
  providers = [],
  extraModels = {},
  rootDir,
  cwd,
  role = 'TestBot',
  callOperation,
  nativeBridge,
} = {}) {
  const ownsRoot = !rootDir;
  const root = rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-host-'));
  const hostDataRoot = path.join(root, 'host-data');
  const workspaceDir = cwd ?? path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const agyModels = Array.isArray(models) && models.length > 0
    ? models.map((item, idx) => normalizeModelDef(item, idx === 0 ? DEFAULT_MODEL_ID : `model-${idx + 1}`))
    : [normalizeModelDef(modelId ?? DEFAULT_MODEL_ID, DEFAULT_MODEL_ID)];
  const selectedModelId = modelId ?? agyModels[0].id;

  const host = openHost({ dataRoot: hostDataRoot });
  const deviceId = host.deviceId;
  let runtime = null;
  let currentSnapshot = null;
  let closed = false;

  const client = {
    callOperation,
    providerAuth: async () => ({ auth: { apiKey: 'center-managed' }, source: 'center' }),
    antigravity: antigravityClient ?? {
      async *run() {
        yield { type: 'turn_done', conversationId: 'stub-conv' };
      },
      async toolResult() {
        return { ok: true };
      },
      async steer() {
        return { ok: true };
      },
      async cancel() {},
    },
  };

  const makeSnapshot = (revision, bots) => ({
    protocol: 1,
    deviceId,
    revision,
    providers: [
      {
        id: ANTIGRAVITY_PROVIDER_ID,
        name: 'Antigravity',
        api: ANTIGRAVITY_API,
        baseUrl: '',
        enabled: true,
        credentialRef: null,
        native: true,
        authMode: 'oauth',
      },
      ...providers,
    ],
    models: {
      [ANTIGRAVITY_PROVIDER_ID]: agyModels,
      ...extraModels,
    },
    credentials: {},
    bots,
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const fn of [() => runtime?.close(), () => host.close()]) {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    }
    if (ownsRoot) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
  };

  try {
    runtime = await openRuntime({
      dataRoot: hostDataRoot,
      nativeBridge: nativeBridge ?? (async () => ({})),
      centerRuntime: {
        snapshot: { protocol: 1 },
        installer: { async getInstalled() { return null; } },
        getClient: () => client,
        prepareTurn: async () => ({ setId: `set-rev-${currentSnapshot.revision}`, snapshot: currentSnapshot }),
        confirmTurn: async ({ requestId, setId }) => ({ admissionId: `adm-${requestId}`, setId }),
        restoreTurn: async () => ({ setId: `set-rev-${currentSnapshot.revision}`, snapshot: currentSnapshot }),
      },
    });

    const applySnapshot = async (snapshot) => {
      currentSnapshot = snapshot;
      await waitUntil(async () => {
        const res = await runtime.applyCenterSnapshot(snapshot);
        if (res.status === 'failed') {
          throw new Error(`applyCenterSnapshot failed: ${JSON.stringify(res)}`);
        }
        return res.status === 'applied';
      }, { label: `applyCenterSnapshot rev=${snapshot.revision}` });
    };

    const waitForSubmission = (botId, requestId) =>
      waitUntil(async () => {
        const sub = await runtime.getSubmission(botId, requestId);
        return sub && !PENDING_SUBMISSION_STATUSES.has(sub.status) ? sub : null;
      }, { label: `submission ${requestId}` });

    await applySnapshot(makeSnapshot(1, []));
    await runtime.setCenterOnline(true);
    await runtime.restoreTurns();
    runtime.resume();

    const bot = await runtime.createBot({
      requestId: 'create-agy-test-bot',
      role,
      cwd: workspaceDir,
      makePrimary: true,
    });
    await applySnapshot(makeSnapshot(2, [{
      botId: bot.botId,
      cwd: workspaceDir,
      model: {
        modelRef: `${ANTIGRAVITY_PROVIDER_ID}/${selectedModelId}`,
        thinkingLevel,
        codemode,
        codemodeOnly,
      },
      capabilities: [],
    }]));

    return {
      root,
      host,
      runtime,
      bot,
      close,
      deviceId,
      makeSnapshot,
      applySnapshot,
      waitForSubmission,
    };
  } catch (err) {
    try {
      await close();
    } catch {
      /* preserve startup error */
    }
    throw err;
  }
}
