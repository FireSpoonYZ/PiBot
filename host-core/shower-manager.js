// host-core/shower-manager.js
// Unified Shower session manager: one trusted backend per Host process (Android
// nativeBridge, Windows or Linux), strict Actor→session binding, per-owner serial
// execution, and cancel() that drops that owner's queued work and aborts its
// in-flight signal instead of queueing behind it. Backends own the real
// environments; this module never creates one for status, never invents a session
// on the backend's behalf, and never replays input. Windows/Linux sessions are
// released after 300 s of inactivity on their own FIFO; status and human frames
// do not renew the timer, in-flight operations are never preempted, and a failed
// idle release keeps ownership so status/release can still settle it.
import { randomUUID } from 'node:crypto';
import { assertId, messageError } from './message-protocol.js';
import { createAndroidShowerBackend } from './shower-android.js';
import { createLinuxShowerBackend } from './shower-linux.js';
import { createWindowsShowerBackend } from './shower-windows.js';
import { normalizeCuaRequest } from './cua-protocol.js';
import {
  normalizeShowerCreate,
  normalizeShowerFrameLimits,
  normalizeShowerInput,
  normalizeShowerLaunch,
  normalizeShowerSessionId,
} from './shower-protocol.js';

const KINDS = new Set(['primary', 'room', 'dm']);
const ACTOR_FIELDS = new Set(['deviceId', 'botId', 'conversationId', 'scopeId', 'kind']);
const SOURCES = new Set(['agent', 'human']);
const PHASES = new Set([
  'unavailable',
  'idle',
  'starting',
  'authentication-required',
  'ready',
  'closed',
  'error',
]);
const BACKEND_METHODS = ['status', 'ensure', 'frame', 'input', 'launch', 'release', 'close'];
// Windows/Linux 每会话空闲回收固定 5 分钟；Android 保留其原生服务端既有策略。
const IDLE_RELEASE_MS = 300_000;
// Windows 全机只有一块子会话，因此所有归属共用一条串行队列；取消仍按 owner 区分。
const MACHINE_QUEUE = '\u0000shower-machine';

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function backendFailure(message) {
  return messageError('SHOWER_BACKEND_FAILED', message);
}

function unavailable(message) {
  return messageError('SHOWER_UNAVAILABLE', message);
}

/** 排队中未发送的取消；在途操作的结果由后端按 not-sent/unconfirmed 语义报告。 */
function cancelled() {
  const error = messageError('CANCELLED', 'Shower 操作已取消，且未发送');
  error.outcome = 'not-sent';
  return error;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受可信 Host 身份：主会话不带 scope，工作会话必须带 scope，也不透传多余字段。 */
function normalizeActor(actor) {
  if (!isPlainObject(actor)) throw invalid('Shower actor must be a plain object');
  for (const key of Object.keys(actor)) {
    if (!ACTOR_FIELDS.has(key)) throw invalid(`Shower actor has unknown field: ${key}`);
  }
  assertId(actor.deviceId, 'actor.deviceId');
  assertId(actor.botId, 'actor.botId');
  assertId(actor.conversationId, 'actor.conversationId');
  if (!KINDS.has(actor.kind)) throw invalid("actor.kind must be 'primary', 'room' or 'dm'");
  const scopeId = actor.scopeId === undefined ? null : actor.scopeId;
  if (scopeId !== null) assertId(scopeId, 'actor.scopeId');
  if (actor.kind === 'primary' && scopeId !== null) throw invalid('primary actor must not carry a scopeId');
  if (actor.kind !== 'primary' && scopeId === null) throw invalid('work actor must carry a scopeId');
  return {
    deviceId: actor.deviceId,
    botId: actor.botId,
    conversationId: actor.conversationId,
    scopeId,
    kind: actor.kind,
  };
}

/** 与 Android ShowerToolBridge.ownerKey 同维度：每个 Bot 一块屏，主私聊、群与 DM 上下文共用。 */
function ownerKey(actor) {
  return JSON.stringify([actor.deviceId, actor.botId]);
}

/** source 只能来自可信调用方（工具 agent、UI/控制 human），模型参数无法设置。 */
function sourceOf(options) {
  if (!isPlainObject(options)) throw invalid('Shower options must be a plain object');
  const source = options.source === undefined ? 'agent' : options.source;
  if (!SOURCES.has(source)) throw invalid("options.source must be 'agent' or 'human'");
  return source;
}

/** taskId/callId 由调用方转发给原生帧；这里不发明身份，也不接受模型提供的值。 */
function callOptions(options, source, signal) {
  const forwarded = { signal, source };
  if (options.taskId !== undefined) forwarded.taskId = options.taskId;
  if (options.callId !== undefined) forwarded.callId = options.callId;
  return forwarded;
}

function assertBackend(backend) {
  if (!isPlainObject(backend)) throw backendFailure('Shower backend is not an object');
  if (backend.platform !== 'android' && backend.platform !== 'windows' && backend.platform !== 'linux') {
    throw backendFailure('Shower backend has an unknown platform');
  }
  for (const method of BACKEND_METHODS) {
    if (typeof backend[method] !== 'function') throw backendFailure(`Shower backend lacks ${method}()`);
  }
  return backend;
}

/**
 * Backend returns a partial Session with its real fields; Manager only owns the
 * identity fields (platform and the reserved sessionId). A malformed partial is a
 * boundary error, never silently coerced into a fake idle session.
 */
function sessionFrom(record, partial, platform) {
  if (!isPlainObject(partial)) throw backendFailure('Shower backend returned an invalid session');
  if (typeof partial.phase !== 'string' || !PHASES.has(partial.phase)) {
    throw backendFailure('Shower backend returned an invalid session phase');
  }
  if (!Number.isSafeInteger(partial.width) || !Number.isSafeInteger(partial.height)) {
    throw backendFailure('Shower backend returned invalid session dimensions');
  }
  if (!isPlainObject(partial.capabilities)) {
    throw backendFailure('Shower backend returned invalid session capabilities');
  }
  if (typeof partial.updatedAt !== 'string') {
    throw backendFailure('Shower backend returned an invalid session updatedAt');
  }
  const session = {
    sessionId: record.sessionId,
    platform,
    phase: partial.phase,
    width: partial.width,
    height: partial.height,
    capabilities: partial.capabilities,
    updatedAt: partial.updatedAt,
  };
  if (partial.error !== undefined) {
    session.error = {
      code: typeof partial.error?.code === 'string' ? partial.error.code : 'SHOWER_BACKEND_FAILED',
      message: typeof partial.error?.message === 'string' ? partial.error.message : '',
    };
  }
  return session;
}

/** 后端必须使用 manager 预留的 sessionId，不能自己在 ensure 时另发明一块屏。 */
function assertSameSessionId(record, snapshot) {
  if (!isPlainObject(snapshot)) throw backendFailure('Shower backend returned an invalid session');
  if (snapshot.sessionId !== record.sessionId) {
    throw backendFailure('Shower backend returned a different sessionId than the manager reserved');
  }
}

function createGate() {
  return { running: null, queue: [] };
}

function drain(gate) {
  if (gate.running || gate.queue.length === 0) return;
  const entry = gate.queue.shift();
  if (entry.settled) {
    drain(gate);
    return;
  }
  gate.running = entry;
  entry.started = true;
  Promise.resolve()
    .then(() => entry.task(entry.controller.signal))
    .then(entry.resolve, entry.reject)
    .finally(() => {
      gate.running = null;
      drain(gate);
    });
}

/**
 * 每个归属一条 FIFO：队首在途，其余排队。外部 signal 在未开始时直接拒绝且不发送，
 * 已开始时转成后端可观察的 AbortSignal。条目记录 owner，Windows 共享队列也能按归属取消。
 */
function enqueue(gates, key, owner, externalSignal, task) {
  if (externalSignal?.aborted) return Promise.reject(cancelled());
  let gate = gates.get(key);
  if (!gate) {
    gate = createGate();
    gates.set(key, gate);
  }
  const entry = { gate, owner, controller: new AbortController(), task, started: false, settled: false };
  const promise = new Promise((resolve, reject) => {
    entry.resolve = (value) => {
      if (entry.settled) return;
      entry.settled = true;
      finish();
      resolve(value);
    };
    entry.reject = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      finish();
      reject(error);
    };
  });
  function finish() {
    externalSignal?.removeEventListener('abort', onAbort);
  }
  const onAbort = () => {
    if (entry.settled) return;
    if (!entry.started) {
      const index = gate.queue.indexOf(entry);
      if (index >= 0) gate.queue.splice(index, 1);
      entry.reject(cancelled());
      return;
    }
    entry.controller.abort();
  };
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  gate.queue.push(entry);
  drain(gate);
  return promise;
}

/** cancel 只影响一个 owner：排队项立即拒绝，在途项立即请求停止，不释放环境。 */
function cancelOwner(gates, key, owner) {
  const gate = gates.get(key);
  if (!gate) return;
  const kept = [];
  for (const entry of gate.queue) {
    if (entry.owner === owner) entry.reject(cancelled());
    else kept.push(entry);
  }
  gate.queue = kept;
  if (gate.running?.owner === owner) gate.running.controller.abort();
}

/** close 才取消全部归属。 */
function cancelAll(gates) {
  for (const gate of gates.values()) {
    for (const entry of gate.queue.splice(0)) entry.reject(cancelled());
    gate.running?.controller.abort();
  }
}

export function createShowerManager({ dataRoot, nativeBridge, backend } = {}) {
  if (backend !== undefined) assertBackend(backend);
  let backendPromise = null;
  let resolvedBackend = null;
  let closePromise = null;
  let closed = false;
  const ownerRecords = new Map();
  const sessionOwners = new Map();
  const gates = new Map();
  // 会话级空闲计时：所有权属于该 sessionId 的 record，到期沿同一归属 FIFO 释放。
  const idleTimers = new Map();
  // 已接纳操作计数：close 先取消再等它们收尾，之后才关闭后端，避免在飞结果丢失归属。
  let accepted = 0;
  const idleWaiters = [];

  function begin() {
    accepted += 1;
  }

  function end() {
    accepted -= 1;
    if (accepted === 0) for (const notify of idleWaiters.splice(0)) notify();
  }

  function whenIdle() {
    if (accepted === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function createPlatformBackend() {
    if (typeof nativeBridge === 'function') return createAndroidShowerBackend({ nativeBridge });
    if (process.platform === 'win32') return createWindowsShowerBackend({ dataRoot });
    if (process.platform === 'linux') return createLinuxShowerBackend({ dataRoot });
    throw unavailable(`当前平台不支持 Shower 图形环境：${process.platform}`);
  }

  /** 工厂只创建对象；原生/进程资源由后端在首次 ensure 时才申请。 */
  function backendInstance() {
    if (closed) return Promise.reject(unavailable('Shower 管理器已关闭'));
    if (resolvedBackend) return Promise.resolve(resolvedBackend);
    if (!backendPromise) {
      backendPromise = Promise.resolve()
        .then(() => (backend ? backend : createPlatformBackend()))
        .then((created) => {
          resolvedBackend = assertBackend(created);
          return created;
        });
      backendPromise.catch(() => {
        backendPromise = null;
      });
    }
    return backendPromise;
  }

  async function liveBackend() {
    const manager = await backendInstance();
    if (closed) throw unavailable('Shower 管理器已关闭');
    return manager;
  }

  function queueKey(actor) {
    return resolvedBackend?.maxSessions === 1 ? MACHINE_QUEUE : ownerKey(actor);
  }

  /** 实际启动前再检查一次：close 之后不允许新操作进入后端。 */
  function run(actor, externalSignal, task) {
    return enqueue(gates, queueKey(actor), ownerKey(actor), externalSignal, (signal) => {
      if (closed) throw unavailable('Shower 管理器已关闭');
      if (signal.aborted) throw cancelled();
      return task(signal);
    });
  }

  function bindSession(key, record) {
    const previous = ownerRecords.get(key);
    if (previous && previous.sessionId !== record.sessionId) sessionOwners.delete(previous.sessionId);
    ownerRecords.set(key, record);
    sessionOwners.set(record.sessionId, key);
    return record;
  }

  function forget(sessionId) {
    const timer = idleTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      idleTimers.delete(sessionId);
    }
    const key = sessionOwners.get(sessionId);
    if (key === undefined) return;
    sessionOwners.delete(sessionId);
    if (ownerRecords.get(key)?.sessionId === sessionId) ownerRecords.delete(key);
  }

  /** 模型/其他身份传来的 sessionId 一律拒绝；替换后的旧 ID 视为不存在。 */
  function resolveSession(actor, sessionId) {
    const key = ownerKey(actor);
    const id = normalizeShowerSessionId(sessionId);
    const owner = sessionOwners.get(id);
    if (owner === undefined) throw messageError('SHOWER_SESSION_NOT_FOUND', 'Shower 会话不存在或已释放；先 create');
    if (owner !== key) throw messageError('SHOWER_SESSION_MISMATCH', 'Shower 会话属于其他身份，不能操作');
    const record = ownerRecords.get(key);
    if (!record || record.sessionId !== id) {
      throw messageError('SHOWER_SESSION_NOT_FOUND', 'Shower 会话已被替换；先 create 取新会话');
    }
    return record;
  }

  /** 到期沿该会话归属的 FIFO 排队释放；begin/end 让 close 等在途释放收尾后再关后端。 */
  function idleExpire(record, timer) {
    begin();
    run(record.actor, undefined, async () => {
      // 执行时复核：续期已更换计时句柄的视为未到期，归属仍须是同一 sessionId。
      if (idleTimers.get(record.sessionId) !== timer) {
        return { sessionId: record.sessionId, released: false, phase: 'closed', expired: true };
      }
      idleTimers.delete(record.sessionId);
      const key = ownerKey(record.actor);
      const current = ownerRecords.get(key);
      if (!current || current !== record || current.sessionId !== record.sessionId) {
        return { sessionId: record.sessionId, released: false, phase: 'closed', expired: true };
      }
      const manager = await liveBackend();
      let result;
      try {
        result = await manager.release(record, { source: 'agent' });
      } catch (error) {
        // 后端明确说会话已不存在时同步忘记；其他失败保留绑定与计时器，允许显式收尾。
        if (error?.code === 'SHOWER_SESSION_NOT_FOUND') forget(record.sessionId);
        else armIdleTimer(record);
        throw error;
      }
      forget(record.sessionId);
      return result;
    })
      .catch(() => {
        // 空闲释放失败不冒充成功；归属保留，status/release 可观察并显式收尾。
      })
      .finally(() => end());
  }

  /** Windows/Linux 每会话固定计时；句柄即到期令牌，续期换句柄使旧到期作废。 */
  function armIdleTimer(record) {
    if (closed) return;
    if (resolvedBackend?.platform !== 'windows' && resolvedBackend?.platform !== 'linux') return;
    clearTimeout(idleTimers.get(record.sessionId));
    const timer = setTimeout(() => idleExpire(record, timer), IDLE_RELEASE_MS);
    timer.unref?.();
    idleTimers.set(record.sessionId, timer);
  }

  function clearIdleTimer(sessionId) {
    const timer = idleTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    idleTimers.delete(sessionId);
  }

  /** 活动只发生在该归属串行操作完成后：在途操作不被打断，完成后统一续期。 */
  function touchSession(record) {
    const key = ownerKey(record.actor);
    const current = ownerRecords.get(key);
    if (!current || current !== record || current.sessionId !== record.sessionId) return;
    armIdleTimer(record);
  }

  /** 仅 Windows 需要启动授权准备；Linux/Android 无 prepare，保持惰性无资源。 */
  async function prepare(options = {}) {
    if (!isPlainObject(options)) throw invalid('Shower options must be a plain object');
    begin();
    try {
      const manager = await liveBackend();
      if (typeof manager.prepare === 'function') await manager.prepare({ signal: options.signal });
    } finally {
      end();
    }
  }

  async function status(actor, options = {}) {
    const bound = normalizeActor(actor);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      const record = ownerRecords.get(ownerKey(bound))
        ?? { sessionId: null, actor: bound, createdAt: new Date().toISOString() };
      const snapshot = await manager.status(record, callOptions(options, source, options.signal));
      return sessionFrom(record, snapshot, manager.platform);
    } finally {
      end();
    }
  }

  async function ensure(actor, createOptions = {}, options = {}) {
    const bound = normalizeActor(actor);
    const create = normalizeShowerCreate(createOptions);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      const key = ownerKey(bound);
      return await run(bound, options.signal, async (signal) => {
        if (manager.maxSessions === 1) {
          for (const owner of ownerRecords.keys()) {
            if (owner !== key) throw messageError('SHOWER_BUSY', 'Shower 环境已被其他会话占用；先释放原会话');
          }
        }
        const existing = ownerRecords.get(key);
        if (existing) {
          clearIdleTimer(existing.sessionId);
          try {
            const snapshot = await manager.ensure(existing, create, callOptions(options, source, signal));
            assertSameSessionId(existing, snapshot);
            return sessionFrom(existing, snapshot, manager.platform);
          } finally {
            touchSession(existing);
          }
        }
        // 新会话 ID 由 manager 预留，后端只使用它；ensure 前即绑定，失败结果也能被 status/release 看到。
        const record = {
          sessionId: randomUUID(),
          actor: bound,
          createdAt: new Date().toISOString(),
        };
        bindSession(key, record);
        try {
          const snapshot = await manager.ensure(record, create, callOptions(options, source, signal));
          assertSameSessionId(record, snapshot);
          touchSession(record);
          return sessionFrom(record, snapshot, manager.platform);
        } catch (error) {
          // 只有明确未发送才撤回预留；不明/已开始的结果保留归属并计时收尾。
          if (error?.outcome === 'not-sent') forget(record.sessionId);
          else armIdleTimer(record);
          throw error;
        }
      });
    } finally {
      end();
    }
  }

  async function frame(actor, sessionId, limits = {}, options = {}) {
    const bound = normalizeActor(actor);
    const normalized = normalizeShowerFrameLimits(limits);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      return await run(bound, options.signal, async (signal) => {
        const record = resolveSession(bound, sessionId);
        try {
          const result = await manager.frame(record, normalized, callOptions(options, source, signal));
          if (!isPlainObject(result)) throw backendFailure('Shower backend returned an invalid frame');
          if (result.sessionId !== record.sessionId) {
            throw messageError('SHOWER_SESSION_MISMATCH', 'Shower 帧不属于当前会话');
          }
          return result;
        } finally {
          // Agent 主动取帧算活动；人工预览（source:'human'）不续期，轮询也阻止不了到期。
          if (source === 'agent') touchSession(record);
        }
      });
    } finally {
      end();
    }
  }

  async function input(actor, sessionId, value, options = {}) {
    const bound = normalizeActor(actor);
    const normalized = normalizeShowerInput(value);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      return await run(bound, options.signal, async (signal) => {
        const record = resolveSession(bound, sessionId);
        try {
          const result = await manager.input(record, normalized, callOptions(options, source, signal));
          if (!isPlainObject(result)) throw backendFailure('Shower backend returned an invalid input receipt');
          return result;
        } finally {
          touchSession(record);
        }
      });
    } finally {
      end();
    }
  }

  /**
   * 内置 Cua：在归属/队列内转发 tools/list 与 tools/call 到该会话自己的持久 Driver。
   * 后端方法可选——Android/未实现的旧注入后端明确报 SHOWER_UNSUPPORTED；操作同样要求
   * ready 会话、走同一 FIFO 与 abort，活动续期与 input/launch 一致。取消在途由
   * 后端 abort 终止输入，manager 不为 Cua 另造队列。
   */
  async function cua(actor, sessionId, request, options = {}) {
    const bound = normalizeActor(actor);
    const normalized = normalizeCuaRequest(request);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      if (typeof manager.cua !== 'function') {
        throw messageError('SHOWER_UNSUPPORTED', 'Shower backend does not support Cua on this platform');
      }
      return await run(bound, options.signal, async (signal) => {
        const record = resolveSession(bound, sessionId);
        try {
          const result = await manager.cua(record, normalized, callOptions(options, source, signal));
          if (!isPlainObject(result)) throw backendFailure('Shower backend returned an invalid Cua result');
          return result;
        } finally {
          touchSession(record);
        }
      });
    } finally {
      end();
    }
  }

  async function launch(actor, sessionId, value, options = {}) {
    const bound = normalizeActor(actor);
    const normalized = normalizeShowerLaunch(value);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      return await run(bound, options.signal, async (signal) => {
        const record = resolveSession(bound, sessionId);
        try {
          const result = await manager.launch(record, normalized, callOptions(options, source, signal));
          if (!isPlainObject(result)) throw backendFailure('Shower backend returned an invalid launch receipt');
          return result;
        } finally {
          touchSession(record);
        }
      });
    } finally {
      end();
    }
  }

  async function release(actor, sessionId, options = {}) {
    const bound = normalizeActor(actor);
    const source = sourceOf(options);
    begin();
    try {
      const manager = await liveBackend();
      return await run(bound, options.signal, async (signal) => {
        const record = resolveSession(bound, sessionId);
        let result;
        try {
          result = await manager.release(record, callOptions(options, source, signal));
        } catch (error) {
          // 后端明确说会话已不存在时同步忘记它；其他失败保留绑定，允许显式重试。
          if (error?.code === 'SHOWER_SESSION_NOT_FOUND') forget(record.sessionId);
          throw error;
        }
        if (!isPlainObject(result)) throw backendFailure('Shower backend returned an invalid release receipt');
        forget(record.sessionId);
        return result;
      });
    } finally {
      end();
    }
  }

  /**
   * 人类接管：同步校验当前 session 后只取消同一 owner 的操作，不释放环境。
   * Windows 共享队列上也不会波及其他 bot。不排在操作之后执行。
   */
  function cancel(actor, sessionId) {
    const bound = normalizeActor(actor);
    const record = resolveSession(bound, sessionId);
    cancelOwner(gates, queueKey(bound), ownerKey(bound));
    // 人类接管本身算活动：取消后同归属 5 分钟内不再被空闲回收。
    touchSession(record);
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      cancelAll(gates);
      // 已接纳的操作（含在途 ensure）先收尾并完成绑定，再关后端；不提前清映射。
      await whenIdle();
      const pending = backendPromise;
      const manager = pending ? await pending.catch(() => null) : resolvedBackend;
      resolvedBackend = null;
      backendPromise = null;
      if (manager) await manager.close();
      gates.clear();
      ownerRecords.clear();
      sessionOwners.clear();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
    })();
    return closePromise;
  }

  return { status, ensure, frame, input, launch, release, cua, cancel, close, prepare };
}
