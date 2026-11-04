// host-core/hindsight-service.js
// M13 Hindsight → Pi Durable 内存服务：仅做授权、规范化接入、顺序与审计。
// 网络由 client（hindsight-client.js）、本地跟踪/审计由 store（hindsight-store.js）、
// 来源采集由 sources（hindsight-sources.js）承担；协议/ID 规范化在 hindsight-protocol.js。
// 公共方法经 run()（engine 接纳/在飞跟踪）执行；内部 resolve/doX 不嵌套 run，避免死锁。

import { resolveBotIdentity } from './bot-identity.js';
import { assertId, digest, messageError } from './message-protocol.js';
import {
  memoryContextKey,
  normalizeMemoryTarget,
  normalizeMemoryStatus,
  normalizeMemoryQuery,
  normalizeMemoryRetain,
  normalizeMemoryLookup,
  normalizeMemorySource,
  normalizeMemoryCorrection,
  normalizeMemoryRetry,
} from './hindsight-protocol.js';
import { hindsightBankId, redactMemoryText } from './hindsight-format.js';

const TOOL_OPERATIONS = new Set([
  'memoryStatus',
  'recallMemory',
  'reflectMemory',
  'retainMemory',
  'getMemory',
  'getMemorySource',
  'correctMemory',
  'retryMemory',
]);

const CONTROL_ACTOR = Object.freeze({ kind: 'control' });

// 纠错错误码白名单：只暴露稳定码，不透传任意 err.code/原始错误。
const STABLE_ERROR_CODES = new Set([
  'HINDSIGHT_UNAVAILABLE',
  'HINDSIGHT_CLOSED',
  'HINDSIGHT_PROTOCOL_ERROR',
  'HINDSIGHT_INVALID_REQUEST',
  'HINDSIGHT_AUTH_FAILED',
  'HINDSIGHT_NOT_FOUND',
  'HINDSIGHT_CONFLICT',
  'HINDSIGHT_STORE_FAILED',
]);

// 网络/关闭/协议/中断均为不确定结果，不可自动重放。
const UNCERTAIN_CODES = new Set([
  'HINDSIGHT_UNAVAILABLE',
  'HINDSIGHT_CLOSED',
  'HINDSIGHT_PROTOCOL_ERROR',
]);

// 仅已知 HTTP 4xx 拒绝才是确定 rejected/responded。
const DEFINITE_REJECTION_CODES = new Set([
  'HINDSIGHT_INVALID_REQUEST',
  'HINDSIGHT_AUTH_FAILED',
  'HINDSIGHT_NOT_FOUND',
  'HINDSIGHT_CONFLICT',
]);

function notConfigured() {
  return messageError('HINDSIGHT_NOT_CONFIGURED', 'hindsight is not configured');
}

function sharedDisabled() {
  return messageError('HINDSIGHT_SHARED_DISABLED', 'shared memory is not enabled');
}

function botNotFound(botId) {
  return messageError('BOT_NOT_FOUND', 'bot not found on this host: ' + botId);
}

function stableCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && STABLE_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  return 'HINDSIGHT_UNKNOWN';
}

function uncertainNetwork(error) {
  if (error?.name === 'AbortError') return true;
  return !!error && typeof error === 'object' && typeof error.code === 'string' && UNCERTAIN_CODES.has(error.code);
}

function definiteRejection(error) {
  return !!error && typeof error === 'object' && typeof error.code === 'string' && DEFINITE_REJECTION_CODES.has(error.code);
}

function throwIfAborted(callContext) {
  callContext?.abortSignal?.throwIfAborted?.();
}

const DEFAULT_CORRECTION_TIMEOUT_MS = 30_000;

/**
 * 一次纠错的 GET+PATCH 共享 config.timeoutMs 总预算（上限由
 * normalizeHindsightConfig 保证 <=120s）。预算耗尽即 abort 本地信号，稳定映射
 * HINDSIGHT_UNAVAILABLE；caller abort 同时生效。只传本地 signal 给 client，
 * 不替换 callContext 对象。
 */
function correctionBudget(timeoutMs, callContext) {
  const caller = callContext?.abortSignal;
  const controller = new AbortController();
  let expired = false;
  const onAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer);
      if (caller) caller.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Hindsight 内存服务。config=null 表示未配置：除 status 外一律抛 HINDSIGHT_NOT_CONFIGURED，
 * 不注册工具、不建网络/存储。所有公开方法经 run() 接纳；resolve/doX 走内部实现。
 */
export function createHindsightService({
  host,
  getHarness,
  getWorkContexts,
  getWorkActivity,
  getBotPolicy,
  config,
  client,
  getStore,
  hasStore,
  run,
  wake,
  context,
  sources,
  documents,
}) {
  /** 每 Bot 策略（manager 提供）；未提供策略时不限制。 */
  function policyFor(botId) {
    return getBotPolicy ? (getBotPolicy(botId) ?? null) : null;
  }

  function assertEnabled(policy) {
    if (policy && policy.enabled !== true) {
      throw messageError('EXTENSION_DISABLED', 'hindsight is disabled for this bot');
    }
  }

  function assertWritable(policy) {
    assertEnabled(policy);
    if (policy && policy.canWrite !== true) {
      throw messageError('EXTENSION_READ_ONLY', 'hindsight is read-only for this bot');
    }
  }

  /**
   * 解析 Bot 归属与 bank 身份（不建存储、不建绑定）。
   * scope 仅复用 resolveWorkContext 读授权（当前成员或既有绑定/冻结收件）；shared 需配置开启。
   */
  async function resolve(botId, target) {
    if (!config) throw notConfigured();
    assertId(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) throw botNotFound(botId);
    // 每 Bot 策略在此拦下全部入口（含嵌套工具调用与 scope 上下文）。
    const policy = policyFor(botId);
    assertEnabled(policy);
    const normalizedTarget = normalizeMemoryTarget(target);
    if (normalizedTarget.kind === 'scope') {
      await getWorkContexts().resolveWorkContext(botId, normalizedTarget.scopeId);
    } else if (normalizedTarget.kind === 'shared') {
      if (!config.sharedMemory) throw sharedDisabled();
    }
    return {
      key: memoryContextKey(botId, normalizedTarget, config.topic),
      botId,
      target: normalizedTarget,
      bankId: hindsightBankId(host.deviceId, botId, normalizedTarget, config.topic),
      ...(config.topic ? { topic: config.topic } : {}),
      policy,
    };
  }

  /** 配置后端操作前，若已有本地跟踪文件则打开/校验绑定（端点 pin 不得被显式读取绕过）。 */
  function validateStoreBinding() {
    if (hasStore()) getStore();
  }

  async function doStatus(botId, input) {
    // 未配置也须校验本地 Bot 身份。
    assertId(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) throw botNotFound(botId);
    const normalized = normalizeMemoryStatus(input);
    const policy = policyFor(botId);
    // 未配置或本 Bot 关闭：返回正常 disabled 形状，不读写任何本地/远程数据。
    if (!config || (policy && policy.enabled !== true)) {
      return {
        botId,
        target: normalized.target,
        enabled: false,
        sharedMemory: false,
        topic: null,
        bankId: null,
        pending: null,
        accepted: null,
        completed: null,
        failed: null,
        lastErrorCode: null,
        lastRecall: null,
        jobs: null,
        nextCursor: null,
      };
    }
    const ctx = await resolve(botId, normalized.target);
    // cursor 仅作续传绑定：bankId/state 必须与派生上下文及过滤条件一致，绝不选择另一 bank。
    if (normalized.cursor) {
      if (normalized.cursor.bankId !== ctx.bankId) {
        throw messageError('INVALID_ARGUMENT', 'cursor bankId does not match the selected memory context');
      }
      if (normalized.cursor.state !== (normalized.state ?? null)) {
        throw messageError('INVALID_ARGUMENT', 'cursor state does not match the selected filter');
      }
    }
    const base = {
      botId,
      target: ctx.target,
      enabled: true,
      sharedMemory: config.sharedMemory,
      topic: config.topic ?? null,
      bankId: ctx.bankId,
    };
    // 已配置但尚无本地跟踪文件：返回 0 计数与空 jobs，不创建 DB/上下文。
    if (!hasStore()) {
      return {
        ...base,
        pending: 0,
        accepted: 0,
        completed: 0,
        failed: 0,
        lastErrorCode: null,
        lastRecall: null,
        jobs: [],
        nextCursor: null,
      };
    }
    const status = getStore().status(ctx.key);
    const page = getStore().listJobs(ctx.key, {
      state: normalized.state ?? null,
      afterOperationId: normalized.cursor?.afterOperationId ?? null,
      limit: normalized.limit,
    });
    const nextCursor = page.nextAfterOperationId === null ? null : {
      bankId: ctx.bankId,
      state: normalized.state ?? null,
      afterOperationId: page.nextAfterOperationId,
    };
    return { ...base, ...status, jobs: page.items, nextCursor };
  }

  async function doRecall(botId, input, callContext) {
    const normalized = normalizeMemoryQuery(input);
    const ctx = await resolve(botId, normalized.target);
    validateStoreBinding();
    const query = redactMemoryText(normalized.query);
    try {
      const result = await client.recall(
        ctx.bankId,
        { query, maxTokens: normalized.maxTokens },
        callContext?.abortSignal,
      );
      return { botId, target: ctx.target, bankId: ctx.bankId, result };
    } catch (error) {
      // 缺失 bank 属空结果；其余后端错误对显式查询原样传播。
      if (error?.code === 'HINDSIGHT_NOT_FOUND') {
        return { botId, target: ctx.target, bankId: ctx.bankId, result: { results: [] } };
      }
      throw error;
    }
  }

  async function doReflect(botId, input, callContext) {
    const normalized = normalizeMemoryQuery(input);
    const ctx = await resolve(botId, normalized.target);
    validateStoreBinding();
    const query = redactMemoryText(normalized.query);
    const result = await client.reflect(
      ctx.bankId,
      { query, maxTokens: normalized.maxTokens },
      callContext?.abortSignal,
    );
    return { botId, target: ctx.target, bankId: ctx.bankId, result };
  }

  async function doRetain(botId, input, actor, callContext) {
    const normalized = normalizeMemoryRetain(input);
    const ctx = await resolve(botId, normalized.target);
    // 只读 Bot 拒绝所有写入口（含工具与嵌套调用）。
    assertWritable(ctx.policy);
    const isTool = actor.kind === 'tool';
    const requestKey = isTool ? 'tool:' + actor.taskId : 'control:' + normalized.requestId;
    // 来源性质：控制注记/工具注记，携带实际 actor 身份与来源 target；shared 仅显式选择。
    const source = {
      kind: isTool ? 'tool-note' : 'control-note',
      deviceId: host.deviceId,
      botId,
      target: ctx.target,
      bankId: ctx.bankId,
      ...(isTool
        ? {
            taskId: actor.taskId,
            callId: actor.callId,
            nativeId: actor.nativeId,
            originTarget: actor.originTarget,
          }
        : { requestId: normalized.requestId }),
    };
    const jobs = sources.makeHindsightJobs(ctx, [
      { source, text: normalized.text, timestamp: new Date().toISOString() },
    ]);
    // 指纹来自规范化意图，不掺新生成的时间戳。
    const fingerprint = digest({
      kind: 'retain',
      botId,
      target: ctx.target,
      requestKey,
      text: normalized.text,
    });
    throwIfAborted(callContext);
    getStore().ensureContext(ctx);
    const receipt = getStore().enqueueManual(ctx, { requestKey, fingerprint, jobs });
    wake();
    return receipt;
  }

  async function doGet(botId, input, callContext) {
    const normalized = normalizeMemoryLookup(input);
    const ctx = await resolve(botId, normalized.target);
    validateStoreBinding();
    const result = await client.getMemory(ctx.bankId, normalized.memoryId, callContext?.abortSignal);
    return { botId, target: ctx.target, bankId: ctx.bankId, result };
  }

  async function doGetSource(botId, input, callContext) {
    const normalized = normalizeMemorySource(input);
    const ctx = await resolve(botId, normalized.target);
    validateStoreBinding();
    const document = await client.getDocument(ctx.bankId, normalized.documentId, callContext?.abortSignal);
    // 只附加本 bank 的本地来源/回执；绝不从 shared-note 来源反向解析来源 bank。
    let local = null;
    if (hasStore()) local = getStore().getSource(ctx.key, normalized.documentId);
    return {
      botId,
      target: ctx.target,
      bankId: ctx.bankId,
      document,
      source: local?.source ?? null,
      receipt: local?.receipt ?? null,
    };
  }

  async function doCorrect(botId, input, actor, callContext) {
    const normalized = normalizeMemoryCorrection(input);
    const ctx = await resolve(botId, normalized.target);
    assertWritable(ctx.policy);
    const isTool = actor.kind === 'tool';
    const requestKey = isTool ? 'tool:' + actor.taskId : 'control:' + normalized.requestId;
    // 发送给后端的文本/原因先脱敏；冲突检测用原始意图哈希。
    const text = normalized.text !== undefined ? redactMemoryText(normalized.text) : undefined;
    const reason = normalized.reason !== undefined ? redactMemoryText(normalized.reason) : undefined;
    const patch = {
      ...(text !== undefined ? { text } : {}),
      ...(normalized.state !== undefined ? { state: normalized.state } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    const fingerprint = digest({
      kind: 'correct',
      botId,
      target: ctx.target,
      requestKey,
      memoryId: normalized.memoryId,
      ...(normalized.text !== undefined ? { text: normalized.text } : {}),
      ...(normalized.state !== undefined ? { state: normalized.state } : {}),
      ...(normalized.reason !== undefined ? { reason: normalized.reason } : {}),
    });
    throwIfAborted(callContext);
    // 先持久意图/审计；同一请求返回原回执，绝不重复 PATCH。
    const { created, receipt } = getStore().beginCorrection(ctx, {
      requestKey,
      fingerprint,
      requestId: normalized.requestId,
      memoryId: normalized.memoryId,
      patch,
    });
    if (!created) return receipt;

    let before = null;
    // 两个串行调用共用同一总预算，避免 GET 与 PATCH 各自耗尽单次期限后
    // 超过外层传输静默期限（后端仍可超时完成 PATCH）。
    const budget = correctionBudget(config.timeoutMs ?? DEFAULT_CORRECTION_TIMEOUT_MS, callContext);
    try {
      try {
        before = await client.getMemory(ctx.bankId, normalized.memoryId, budget.signal);
      } catch (error) {
        // GET 失败发生在 PATCH 前：确定未发送。预算耗尽映射稳定超时。
        return getStore().finishCorrection(requestKey, {
          state: 'rejected',
          outcome: 'not-sent',
          errorCode: budget.expired() ? 'HINDSIGHT_UNAVAILABLE' : stableCode(error),
          before: null,
          after: null,
        });
      }

      // PATCH 前持久 before 快照；本地持久失败必须传播，绝不进入网络/后端拒绝分类。
      getStore().finishCorrection(requestKey, {
        state: 'pending',
        outcome: 'not-sent',
        errorCode: null,
        before,
        after: null,
      });

      // 预算已耗尽则不派发 PATCH：仍是确定未发送，保留 before 快照。
      if (budget.expired()) {
        return getStore().finishCorrection(requestKey, {
          state: 'rejected',
          outcome: 'not-sent',
          errorCode: 'HINDSIGHT_UNAVAILABLE',
          before,
          after: null,
        });
      }

      let after = null;
      try {
        // 单次 PATCH，不自动重放。
        after = await client.updateMemory(ctx.bankId, normalized.memoryId, patch, budget.signal);
      } catch (error) {
        // 网络/关闭/协议/中断或不明确响应均属未确认；仅已知 4xx 为确定拒绝。
        // PATCH 派发后超时同样保留未确认，不得当作可重放。
        const timedOut = budget.expired();
        const rejected = !timedOut && definiteRejection(error);
        return getStore().finishCorrection(requestKey, {
          state: rejected ? 'rejected' : 'unconfirmed',
          outcome: rejected ? 'responded' : 'unconfirmed',
          errorCode: timedOut ? 'HINDSIGHT_UNAVAILABLE' : stableCode(error),
          before,
          after: null,
        });
      }
      // PATCH 成功后的审计持久失败必须传播，保留可恢复的 pending/applied 意图。
      return getStore().finishCorrection(requestKey, {
        state: 'applied',
        outcome: 'responded',
        errorCode: null,
        before,
        after,
      });
    } finally {
      budget.dispose();
    }
  }

  async function doRetry(botId, input, callContext) {
    const normalized = normalizeMemoryRetry(input);
    const ctx = await resolve(botId, normalized.target);
    assertWritable(ctx.policy);
    if (!hasStore()) {
      throw messageError('HINDSIGHT_NOT_FOUND', 'memory operation is not tracked locally');
    }
    const job = getStore().getJob(ctx.key, normalized.operationId);
    if (!job) {
      throw messageError('HINDSIGHT_NOT_FOUND', 'memory operation is not tracked locally');
    }
    await client.retryOperation(ctx.bankId, normalized.operationId, callContext?.abortSignal);
    // Keep the observed state until the immediate status refresh confirms progress.
    const current = getStore().getJob(ctx.key, normalized.operationId);
    getStore().setJob(job.operationId, {
      state: current.state,
      attempts: current.attempts,
      nextAttemptAt: Date.now(),
      lastErrorCode: current.lastErrorCode,
    });
    wake();
    return {
      operationId: job.operationId,
      documentId: job.documentId,
      botId: job.botId,
      target: ctx.target,
      bankId: job.bankId,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastErrorCode: job.lastErrorCode,
    };
  }

  /** 工作会话工具写/reflect/retry 前检查工作活动：停止/非活动则拒绝接纳。 */
  async function assertWorkActive(botId, scopeId) {
    const activity = await getWorkActivity(botId, scopeId);
    if (activity?.status === 'stopped') {
      throw messageError('WORK_STOPPED', 'work context is stopped');
    }
    if (activity?.status === 'inactive') {
      throw messageError('WORK_CONTEXT_INACTIVE', 'work context is not active');
    }
  }

  /**
   * 工具入口：整个执行包在一次 run() 接纳/在飞跟踪中；resolveBotIdentity 注入实际 Bot/target，
   * 请求 ID/actor 取真实 Native 身份；拒绝模型自选 target/bank/requestId（strict 规范化器兜底）。
   */
  async function fromToolInner(api, callContext, operation, input) {
    if (typeof operation !== 'string' || !TOOL_OPERATIONS.has(operation)) {
      throw messageError('INVALID_ARGUMENT', 'unknown hindsight tool operation');
    }
    throwIfAborted(callContext);
    const identity = await resolveBotIdentity(host, getHarness(), api.conversationId, callContext, documents);
    const baseTarget = identity.kind === 'primary'
      ? { kind: 'primary' }
      : { kind: 'scope', scopeId: identity.scopeId };
    let target = baseTarget;
    let args = input;
    if (args !== undefined && args !== null) {
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw messageError('INVALID_ARGUMENT', 'tool arguments must be a plain object');
      }
      // 模型不得自选 bank/target/requestId；shared 布尔可只选本 Bot 自己的 shared bank。
      if (Object.hasOwn(args, 'target')) {
        throw messageError('INVALID_ARGUMENT', 'tool must not select a memory target');
      }
      if (Object.hasOwn(args, 'requestId')) {
        throw messageError('INVALID_ARGUMENT', 'tool must not select a requestId');
      }
      if (Object.hasOwn(args, 'shared')) {
        if (typeof args.shared !== 'boolean') {
          throw messageError('INVALID_ARGUMENT', 'shared must be a boolean');
        }
        if (args.shared) target = { kind: 'shared' };
        args = { ...args };
        delete args.shared;
      }
    } else {
      args = {};
    }

    const actor = {
      kind: 'tool',
      taskId: api.taskId,
      callId: api.callId,
      nativeId: api.conversationId,
      originTarget: baseTarget,
    };

    // 工作会话（scope 身份）写/纠错/重试/reflect 需活动检查，且以实际来源 scope 为准，与所选 target 无关。
    const callerIsWork = identity.kind !== 'primary';
    const withTarget = { ...args, target };

    if (operation === 'memoryStatus') return doStatus(identity.botId, withTarget);
    if (operation === 'recallMemory') return doRecall(identity.botId, withTarget, callContext);
    if (operation === 'reflectMemory') {
      if (callerIsWork) await assertWorkActive(identity.botId, identity.scopeId);
      return doReflect(identity.botId, withTarget, callContext);
    }
    if (operation === 'retainMemory') {
      if (callerIsWork) await assertWorkActive(identity.botId, identity.scopeId);
      return doRetain(identity.botId, { ...withTarget, requestId: 'tool-' + api.taskId }, actor, callContext);
    }
    if (operation === 'getMemory') return doGet(identity.botId, withTarget, callContext);
    if (operation === 'getMemorySource') return doGetSource(identity.botId, withTarget, callContext);
    if (operation === 'correctMemory') {
      if (callerIsWork) await assertWorkActive(identity.botId, identity.scopeId);
      return doCorrect(identity.botId, { ...withTarget, requestId: 'tool-' + api.taskId }, actor, callContext);
    }
    if (operation === 'retryMemory') {
      if (callerIsWork) await assertWorkActive(identity.botId, identity.scopeId);
      return doRetry(identity.botId, withTarget, callContext);
    }
    throw messageError('INVALID_ARGUMENT', 'unknown hindsight tool operation');
  }

  function fromTool(api, callContext, operation, input) {
    return run(() => fromToolInner(api, callContext, operation, input));
  }

  return {
    // 内部解析：不嵌套 run，避免接纳死锁；公共方法与 fromTool 直接复用。
    resolve,
    memoryStatus: (botId, input) => run(() => doStatus(botId, input)),
    recallMemory: (botId, input, callContext = context) => run(() => doRecall(botId, input, callContext)),
    reflectMemory: (botId, input, callContext = context) => run(() => doReflect(botId, input, callContext)),
    retainMemory: (botId, input, actor = CONTROL_ACTOR, callContext = context) => run(() => doRetain(botId, input, actor, callContext)),
    getMemory: (botId, input, callContext = context) => run(() => doGet(botId, input, callContext)),
    getMemorySource: (botId, input, callContext = context) => run(() => doGetSource(botId, input, callContext)),
    correctMemory: (botId, input, actor = CONTROL_ACTOR, callContext = context) => run(() => doCorrect(botId, input, actor, callContext)),
    retryMemory: (botId, input, callContext = context) => run(() => doRetry(botId, input, callContext)),
    fromTool,
  };
}
