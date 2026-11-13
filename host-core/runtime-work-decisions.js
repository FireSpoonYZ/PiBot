import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentDoc, configure, ConversationBusy, LiveDoc, SessionFailed } from '@earendil-works/pi-durable';
import { GenerationFailureState } from './generation-failure.js';
import { assertId, messageError } from './message-protocol.js';
import { inboxQueryKey } from './message-queries.js';
import { WorkIndex, WorkContextState, ensureWorkBinding, toWorkContextRecord } from './work-context-docs.js';
import { WorkDecisionState, initialDecisionState, toWorkActivity, toFrozenTurn } from './work-decision-state.js';
import { createWorkInput } from './work-decision-codec.js';
import {
  GROUP_MAX_MESSAGES_PER_TURN,
  GROUP_MAX_REDRIVE_ATTEMPTS,
  GROUP_PROMPT_HISTORY_LIMIT,
  MAX_REPLY_NUDGES,
  clampBlock,
  evaluateGroupTurnEligibility,
  isHostFailureReceiptText,
  messagesSinceMemberLastSpoke,
} from './group-chat.js';
import { GroupChatOrchestrator, RoomTurnScheduler } from './group-chat-orchestrator.js';
import { RequestContext } from './request-context.js';
import { parseModelRef } from './runtime-models.js';

const CONTROL_ERRORS = new Set(['INVALID_ARGUMENT', 'BOT_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'SCOPE_DELETED', 'WORK_CONTEXT_INACTIVE', 'NOT_CONNECTED']);
// NOT_CONNECTED 来自 Bot 准入队列关闭（runtime 已在关闭）：只拒绝新准入，不升级为 fatal。
const AUTO_ERRORS = new Set(['WORK_CONTEXT_INACTIVE', 'NOT_CONNECTED', 'BOT_NOT_FOUND', 'SCOPE_DELETED']);
const WORK_ERRORS = new Set(['WORK_STOPPED', 'WORK_CONTEXT_INACTIVE', 'STALE_INPUT', 'MODEL_REQUIRED', 'MODEL_NOT_FOUND', 'CONTEXT_LIMIT', 'WORK_GENERATION_FAILED']);
// 已知的确定模型配置失败：可立即请求级结算并回执；离线/忙碌/SessionFailed/未知仍按暂不可达处理。
const DETERMINATE_CONFIG_CODES = new Set(['MODEL_REQUIRED', 'MODEL_NOT_FOUND']);
const PUBLICATION_ERRORS = new Set([...WORK_ERRORS, 'INVALID_ARGUMENT', 'BOT_CONTEXT_REQUIRED', 'BOT_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'SCOPE_DELETED', 'MESSAGE_NOT_FOUND', 'REQUEST_CONFLICT']);
const SCOPE_MESSAGE_KIND = 'host.scope-message';
const WORK_TRIGGER_KIND = 'host.work-trigger';

function finishDecision(state, outcome) {
  const pending = state.pending;
  if (!pending) return;
  // 主动取消不写 generationError：user_stop 结算为主动取消（aborted），
  // 不是 WORK_GENERATION_FAILED；preempted 不推进 handled——未消费的触发
  // 消息留待用户队列排空后按相同原始消息重新触发；已 published 的轮按
  // prepared 水位结算消费，绝不用新 requestId 重触发再发重复消息。
  const interruption = pending.interruption ?? null;
  if (interruption?.reason === 'user_stop') {
    state.handledLocalId = Math.max(state.handledLocalId, interruption.throughLocalId);
    state.preemptedAttempts = 0;
  } else if (interruption?.reason === 'preempted' && pending.published) {
    // 已产生发布的被抢占轮：prepared 记录的本批来源水位即已消费边界，
    // 结算推进到它，余下未消费消息留给下轮触发（不重复已发布内容）。
    state.handledLocalId = Math.max(state.handledLocalId, pending.prepared?.throughLocalId ?? 0);
    state.preemptedAttempts = 0;
  } else if (interruption?.reason === 'preempted' && !pending.published) {
    state.preemptedAttempts = (state.preemptedAttempts ?? 0) + 1;
  } else {
    state.preemptedAttempts = 0;
  }
  state.lastDecision = {
    requestId: pending.requestId,
    outcome,
    throughLocalId: interruption?.reason === 'user_stop'
      ? interruption.throughLocalId
      : pending.takeover?.throughLocalId ?? pending.prepared?.throughLocalId ?? null,
    completedAt: new Date().toISOString(),
  };
  state.pending = null;
}

function finishTakeover(state) {
  const pending = state.pending;
  const takeover = pending?.takeover;
  if (!takeover || takeover.requestId !== pending.requestId) return;
  // 标记中断的 takeover 按中断结算：handled 推进由 interruption 水位决定，
  // 不再取 takeover 水位（preempted 不推进，user_stop 用捕获边界）。
  if (pending.interruption) {
    finishDecision(state, 'aborted');
    return;
  }
  state.handledLocalId = Math.max(state.handledLocalId, takeover.throughLocalId);
  finishDecision(state, 'aborted');
}

function generationError(reason) {
  // Native detail can contain provider responses or credentials; only retain its small reason code.
  const safeReason = typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'unanswered';
  return { code: 'WORK_GENERATION_FAILED', message: 'work generation failed: ' + safeReason };
}

// 请求级失败结算（contract C）：具体诊断保留在 lastError 供状态/ LIVE 展示，
// 绝不写 scope 级 error 闸门；消费边界只推进到本决策已消费水位（本批不再
// 重放，其后新到消息正常触发下轮）。同时按冻结 replyTarget 落一条 Host 执行
// 失败回执草稿（稳定 messageId 幂等）；primary/无目标不伪造账本消息。
function settleFailedDecision(state, meta, failure) {
  const pending = state.pending;
  if (!pending) return;
  const safe = {
    code: typeof failure?.code === 'string' && failure.code !== '' ? failure.code.slice(0, 64) : 'WORK_GENERATION_FAILED',
    message: typeof failure?.message === 'string' && failure.message !== '' ? failure.message.slice(0, 200) : 'work generation failed',
  };
  // 请求级失败只记 lastError（可见诊断）；state.error 恒为 null——它是遗留
  // scope 闸门，绝不再由本路径写入，后续新请求不被旧失败拦截。
  state.lastError = safe;
  state.handledLocalId = Math.max(
    state.handledLocalId,
    pending.prepared?.throughLocalId ?? pending.startedThroughLocalId ?? 0);
  const turn = pending.turn ?? null;
  const target = turn?.replyTarget ?? null;
  if (target && (target.kind === 'dm' || target.kind === 'room') &&
      typeof target.scopeId === 'string' && typeof meta?.botId === 'string') {
    const replyTo = typeof turn.responseMessageId === 'string' ? turn.responseMessageId
      : (typeof turn.triggerMessageId === 'string' ? turn.triggerMessageId : null);
    state.notices[pending.requestId] = {
      // 稳定持久化 ID：失败结算只跑一次，重启/重复 reconcile 重放同一草稿；
      // 账本按 messageId+fingerprint 幂等去重，绝不发第二条。
      messageId: 'host-failure-' + pending.requestId,
      requestId: pending.requestId,
      provenance: 'host-execution-failure',
      author: { kind: 'bot', botId: meta.botId },
      target: {
        kind: target.kind, scopeId: target.scopeId,
        ...(typeof target.botId === 'string' ? { botId: target.botId } : {}),
      },
      code: safe.code,
      text: '[Host 执行失败] ' + safe.code + ': ' + safe.message,
      replyTo,
      published: false,
      createdAt: new Date().toISOString(),
    };
  }
  finishDecision(state, 'failed');
}

/** 账本消息作者 -> 冻结轮 sender（真实封套作者/设备，非 host 占位）。 */
function triggerSender(message) {
  const author = message?.author ?? {};
  const kind = author.kind === 'user' || author.kind === 'host' ? author.kind : 'bot';
  return {
    kind,
    ...(kind === 'bot' && typeof author.botId === 'string' ? { botId: author.botId } : {}),
    ...(typeof message?.sourceDeviceId === 'string' ? { deviceId: message.sourceDeviceId } : {}),
  };
}

/** Inert until resume(); ledger import, policy consumption and the frozen model view have separate watermarks. */
export function createWorkDecisionRuntime({ host, getHarness, getWorkContexts, models, defaultModel, context, getProfile, admitBot, admitTurn, sessions, collaboration = null }) {
  // 无 sessions（旧线/独立测试装配）保持原行为：协调会话即执行会话，无统一轮归属。
  const unified = sessions != null;
  // 共用准入门、空闲回调与工作闸由 runtime 装配后注入（turn gate 需要在 harness/live 就位后创建）。
  // canRunWork 只读检查（排队用户优先 + 本 Bot 全部原生活动含遗留 work），不取第二条 Bot 准入通道。
  const turnGate = { fn: admitTurn ?? null, idle: null, canRunWork: null };
  let learningHooks = null;
  let active = false;
  let closing = false;
  let timer = null;
  let pollPromise = null;
  let pollAgain = false;
  let commitObservation = null;
  let closePromise = null;
  let fatalError = null;
  const inflight = new Set();
  const lanes = new Map();
  const roomScheduler = new RoomTurnScheduler();
  const scheduledRooms = new Set();
  const roomRescanNeeded = new Set();
  const activeRoomEpochs = new Map(); // scopeId -> { epoch, baselineLocalId, publishedIds }
  const roomWaiters = new Set();

  function wakeRoomWaiters() {
    for (const wake of [...roomWaiters]) {
      roomWaiters.delete(wake);
      wake();
    }
  }

  function waitForRoomSignal(timeoutMs = 250) {
    if (closing || !active || fatalError) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        roomWaiters.delete(done);
        resolve();
      };
      const fallback = setTimeout(done, timeoutMs);
      fallback.unref?.();
      roomWaiters.add(done);
    });
  }
  const getLog = () => getWorkContexts().getMessageLog();
  // 墓碑 scope 一律视为无成员资格：已删除群不再触发/提交/恢复任何工作。
  const member = (scope, botId) => scope?.deletedAt === undefined && scope?.members.some((item) => item.deviceId === host.deviceId && item.botId === botId) === true;
  const currentMember = (meta) => member(getLog().getScope(meta.scopeId), meta.botId);

  const DIRECTORY_TTL_MS = 15_000;
  let directoryCache = { fetchedAt: 0, byKey: new Map(), byBotId: new Map() };

  function resolveBotMeta(deviceId, botId) {
    if (typeof botId !== 'string' || !botId) return { name: '', description: '' };
    if (!deviceId || deviceId === host.deviceId) {
      const local = host.getBot(botId);
      if (local) return { name: local.role ?? '', description: local.description ?? '' };
    }
    if (deviceId) {
      const exact = directoryCache.byKey.get(`${deviceId}:${botId}`);
      if (exact) return exact;
    }
    return directoryCache.byBotId.get(botId) ?? { name: '', description: '' };
  }

  async function warmBotDirectoryIfNeeded(scope) {
    if (!collaboration || typeof collaboration.listBots !== 'function' || !scope?.members) return;
    const hasRemote = scope.members.some((m) => m.deviceId !== host.deviceId);
    if (!hasRemote) return;
    const now = Date.now();
    if (now - directoryCache.fetchedAt <= DIRECTORY_TTL_MS && directoryCache.byKey.size > 0) return;
    try {
      const snap = await collaboration.listBots();
      const byKey = new Map();
      const byBotId = new Map();
      for (const item of snap?.bots ?? []) {
        if (!item?.botId) continue;
        const meta = { name: item.role ?? '', description: item.description ?? '' };
        if (item.deviceId) byKey.set(`${item.deviceId}:${item.botId}`, meta);
        if (!byBotId.has(item.botId)) byBotId.set(item.botId, meta);
      }
      directoryCache = { fetchedAt: now, byKey, byBotId };
    } catch {
      // Directory lookup is best-effort for display/@mention; never fail work decisions.
    }
  }

  function assertHealthy() {
    if (fatalError) throw fatalError;
  }

  function assertOpen() {
    assertHealthy();
    if (closing) throw messageError('WORK_CONTEXT_INACTIVE', 'work decision runtime is closing');
  }

  function fail(error) {
    if (!fatalError) {
      fatalError = error?.code === 'UNSUPPORTED_SCHEMA'
        ? messageError('UNSUPPORTED_SCHEMA', 'work decision runtime schema is unsupported')
        : messageError('WORK_DRIVER_FAILED', 'work decision runtime failed; close and reopen the runtime');
      fatalError.cause = error;
      active = false;
      clearInterval(timer);
      timer = null;
      console.error('Work decision runtime failed; close and reopen the runtime.');
    }
    return fatalError;
  }

  async function guarded(operation, expected, callContext = context) {
    try {
      return await operation();
    } catch (error) {
      if (error === fatalError) throw error;
      if (!(error instanceof SessionFailed) && error?.code !== 'UNSUPPORTED_SCHEMA') {
        if (callContext.abortSignal?.aborted || expected?.has(error?.code)) throw error;
      }
      throw fail(error);
    }
  }

  // botId 非空时在现有 scope lane 之后取得 Bot 准入：同一 Bot 的发送/设置/工作操作串行，
  // 且不重复取同一 lane（决策内部的 syncWorkContext 走 raw 实现）。
  function admit(operation, key, expected = CONTROL_ERRORS, botId = null) {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    const previous = key === undefined ? undefined : lanes.get(key);
    const start = () => {
      assertOpen();
      return botId === null ? operation() : admitBot(botId, operation);
    };
    const task = guarded(() => previous ? previous.then(start, start) : Promise.resolve().then(start), expected);
    inflight.add(task);
    if (key !== undefined) lanes.set(key, task);
    let settledBot = null;
    const release = () => {
      inflight.delete(task);
      if (key !== undefined && lanes.get(key) === task) lanes.delete(key);
      // 每条 scope lane 操作落定后发布一次活动汇总：pending 创建/结算/取消/暂停
      // 都在 admit 序列内完成，此处即变更边界；代次防迟到旧结果覆盖终态。
      if (settledBot !== null) publishActivity(settledBot);
    };
    if (botId !== null) settledBot = botId;
    task.then(release, release);
    return task;
  }

  function inboxAfter(botId, scopeId, afterLocalId, limit = 200) {
    return getLog().inbox(botId, {
      scopeId,
      limit,
      ...(afterLocalId > 0 ? { cursor: {
        deviceId: host.deviceId,
        kind: 'inbox',
        key: inboxQueryKey(botId, scopeId),
        afterLocalId,
      } } : {}),
    });
  }

  // 手停边界：该 scope 当前收件的最高 localId（含尚未导入页；其后到达的新消息不受影响）。
  function inboxWatermark(botId, scopeId) {
    let watermark = 0;
    let afterLocalId = 0;
    for (;;) {
      const page = inboxAfter(botId, scopeId, afterLocalId);
      for (const item of page.items) watermark = Math.max(watermark, item.localId);
      if (!page.nextCursor) return watermark;
      afterLocalId = page.nextCursor.afterLocalId;
    }
  }

  async function activity(botId, scopeId) {
    const { binding } = await getWorkContexts().resolveWorkContext(botId, scopeId);
    const harness = getHarness();
    const meta = binding ? await harness.snapshot(WorkContextState, binding.nativeId, context) : null;
    const state = binding ? await harness.snapshot(WorkDecisionState, binding.nativeId, context) : null;
    assertHealthy();
    return toWorkActivity(botId, scopeId, meta ?? null, state ?? initialDecisionState(), member(getLog().getScope(scopeId), botId));
  }

  function getWorkActivity(botId, scopeId) {
    return admit(() => activity(botId, scopeId));
  }

  // 活动汇总（contract：纯元数据快照，只含存活 pending；kind primary 的轮
  // 由 live 侧识别为 source background）。pending.interruption 标记的请求
  // 已转入取消终态流程，与 stopped/error 终态同样不算存活工作。
  function pendingSummary(state, meta) {
    const pending = state?.pending ?? null;
    if (!pending || pending.interruption || state.stopped || state.error) return { pending: [] };
    // 统一 pending 用冻结轮 kind；legacy 无 turn，回退协调 scope kind。
    const rawKind = pending.turn?.kind ?? meta?.kind ?? 'room';
    const kind = rawKind === 'dm' || rawKind === 'primary' ? rawKind : 'room';
    return {
      pending: [{
        requestId: pending.requestId,
        kind,
        scopeId: kind === 'primary' ? null : (meta?.scopeId ?? null),
        startedAt: pending.startedAt ?? null,
      }],
    };
  }

  // contract：单 listener 注册；per-Bot generation 丢弃迟到旧汇总结果，
  // 在飞汇总与更新结算并发时绝不拿旧快照覆盖较新的终态。
  let activityListener = null;
  const activityGeneration = new Map(); // botId -> 最新发出的汇总序号
  const activityCache = new Map();      // botId -> 已发布 signature（去重）
  const activityLoads = new Map();      // botId -> 最新被动汇总，供看板等待初始化

  // 汇总签名即结构化 JSON：内容不变不重复发布，避免每次 settle 都投影。
  function summarySignature(summary) {
    return JSON.stringify(summary.pending);
  }

  function bumpActivity(botId) {
    const generation = (activityGeneration.get(botId) ?? 0) + 1;
    activityGeneration.set(botId, generation);
    return generation;
  }

  // 在飞汇总完成时只有 generation 仍是当前最新才发布；内容不变也不重复发。
  function emitActivity(botId, generation, summary) {
    if (activityListener === null) return;
    if (activityGeneration.get(botId) !== generation) return;
    const signature = summarySignature(summary);
    if (activityCache.get(botId) === signature) return;
    activityCache.set(botId, signature);
    try { activityListener(botId, summary); } catch { /* listener 失败不影响决策 */ }
  }

  function loadActivity(botId) {
    if (activityListener === null) return Promise.resolve();
    const generation = bumpActivity(botId);
    const task = workSummary(botId)
      .then((summary) => emitActivity(botId, generation, summary))
      .finally(() => {
        if (activityLoads.get(botId) === task) activityLoads.delete(botId);
      });
    activityLoads.set(botId, task);
    return task;
  }

  async function refreshActivity(botId) {
    await loadActivity(botId);
    // A newer publication superseded this read: await it rather than expose an empty map.
    while (activityLoads.has(botId)) await activityLoads.get(botId);
  }

  function publishActivity(botId) {
    void loadActivity(botId).catch(() => {});
  }

  function setActivityListener(listener) {
    if (typeof listener !== 'function') throw messageError('INVALID_ARGUMENT', 'activity listener must be a function');
    activityListener = listener;
    // 注册即为已有 Bot 发布：逐 Bot bump 代次后汇总（host.getBot 校验本地身份）。
    (async () => {
      const harness = getHarness();
      const index = await harness.snapshot(WorkIndex, context).catch(() => null);
      const seen = new Set();
      for (const key of Object.keys(index?.byKey ?? {})) {
        let pair = null;
        try { pair = JSON.parse(key); } catch { pair = null; }
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some((id) => typeof id !== 'string')) continue;
        if (seen.has(pair[0])) continue;
        seen.add(pair[0]);
        if (!host.getBot(pair[0])) continue;
        publishActivity(pair[0]);
      }
    })().catch(() => {});
  }

  // 该 Bot 全部 scope 工作 pending 的当前存活快照（metadata-only）。
  async function workSummary(botId) {
    const harness = getHarness();
    const index = await harness.snapshot(WorkIndex, context);
    const pending = [];
    for (const [key, binding] of Object.entries(index?.byKey ?? {})) {
      let pair = null;
      try { pair = JSON.parse(key); } catch { pair = null; }
      if (!Array.isArray(pair) || pair[0] !== botId) continue;
      const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
      const meta = await harness.snapshot(WorkContextState, binding.nativeId, context);
      pending.push(...pendingSummary(state, meta).pending);
    }
    return { pending };
  }


  async function conversationFor(binding) {
    const conversation = await getHarness().conversation(binding.nativeId, context);
    if (!conversation) throw new Error('work conversation is missing');
    return conversation;
  }

  // 执行会话 ID：统一 pending 记 executionNativeId（主会话）；旧 pending（无 executionNativeId）
  // 与 legacy 路径回退协调 nativeId——旧执行目标保留到结算/取消，绝不转换、绝不双执行。
  function executionTargetOf(state, binding) {
    if (typeof state?.pending?.executionNativeId === 'number') return state.pending.executionNativeId;
    return binding.nativeId;
  }

  // 中止该 pending 请求的任务族：先按持久化 submissionId/requestId 精准 abortSubmission，
  // 再 abortTask prepared 任务族（含 owned 工具后代）。绝不中止同主会话无关轮。
  // quiesce=false（离线/恢复未完的手停）只提交取消标记，不 waitForTask——wait 会隐式 resume 调度器。
  // strict（主动 stop/preempt）：真实取消错误上抛——取消确认前不得把失败伪装成
  // 成功、让另一轮争用 Bot 资源；只有确认目标已终态/不存在可忽略。非 strict
  // （恢复/兜底路径）保持旧的全吞语义。
  // submissionId 只属于其登记 executionId 的提交索引：按 pending.executionNativeId
  // 归属的目标传 id；另一目标（协调/遗留会话）只按 requestId 查询命中，
  // 绝不把别会话的 submissionId 传进去（SDK abortSubmission 对 conversationId
  // 不匹配返回 "not_found"——可忽略，但按归属传参避免误判真实错误）。
  // SDK 语义（pi-durable）：abortSubmission 永不抛——"not_found"/"settled" 即
  // 终态/不存在可忽略；abortTask 对不存在 id 抛错、terminal 返回 "terminal"。
  async function abortRequestFamily(executionId, requestId, preparedTaskId, submissionId, quiesce = true, strict = false) {
    const harness = getHarness();
    const ignore = (error) => {
      // 确认目标终态/不存在可忽略；其余真实取消错误 strict 下上抛。
      if (strict && typeof error?.message === 'string' && /does not exist$/.test(error.message)) return undefined;
      if (!strict) return undefined;
      throw error;
    };
    if (submissionId) {
      await harness.abortSubmission(submissionId, context, executionId).catch(ignore);
    }
    // 提交在飞/未登记 submissionId：requestId 是提交唯一标识，精准命中该 submission。
    const record = await harness.commit((tx) => tx.submissionByRequest(executionId, requestId), context);
    if (record && (record.status === 'queued' || record.status === 'placed')) {
      await harness.abortSubmission(record.id, context, executionId).catch(ignore);
    }
    if (preparedTaskId) {
      const inspection = await harness.inspect(context);
      const live = new Map();
      for (const t of inspection.tasks) live.set(String(t.record.id), t.record);
      const targets = [];
      const seen = new Set();
      const visit = (id) => {
        const key = String(id);
        if (seen.has(key)) return;
        seen.add(key);
        const rec = live.get(key);
        if (!rec) return;
        targets.push(rec.id);
        // TaskRecord.owner 是 TaskId（工具/子任务的 owner 边），不是 {taskId} 对象。
        for (const candidate of live.values()) {
          if (candidate.owner !== undefined && String(candidate.owner) === key) visit(candidate.id);
        }
      };
      visit(preparedTaskId);
      for (const id of targets) await harness.abortTask(id, context).catch(ignore);
      if (quiesce) for (const id of targets) await harness.waitForTask(id, context).catch(ignore);
    }
  }

  async function abortPending(binding, quiesce = true, strict = false) {
    const harness = getHarness();
    const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    if (unified) {
      // 统一执行：只中止本请求的任务族/submission，绝不 Conversation.abort 整主会话。
      // 同时覆盖协调会话：带 turn 但无 executionNativeId 的 pending（含轮 0 迁移期
      // 记录在案的错误提交）原执行目标是协调会话，按同一 requestId 精准中止。
      if (state?.pending) {
        const pending = state.pending;
        const executionId = executionTargetOf(state, binding);
        for (const id of new Set([executionId, binding.nativeId])) {
          // submissionId 只传给其登记目标（pending.executionNativeId 归属的
          // 会话，缺省即 binding 自身）；另一目标按 requestId 查询命中。
          const submissionId = id === executionId ? pending.submissionId : null;
          await abortRequestFamily(id, pending.requestId, pending.prepared?.taskId, submissionId, quiesce, strict);
        }
      }
    } else {
      const executionId = executionTargetOf(state, binding);
      const conversation = await conversationFor({ nativeId: executionId });
      // abort() marks cancellation and waits for ordinary work quiescence, never for a natural model answer.
      // quiesce=false 时不能用该路径：它会隐式 resume 调度器、唤醒未知旧任务（与 runtime.abort 同约束）。
      if (!quiesce) {
        await abortRequestFamily(executionId, state?.pending?.requestId ?? null, state?.pending?.prepared?.taskId, state?.pending?.submissionId ?? null, false, strict);
      } else {
        await conversation.abort(context);
      }
    }
    await harness.commit(async (tx) => {
      const doc = await tx.doc(WorkDecisionState, binding.nativeId);
      // 并发窗口：取消期间新 pending 可能已落位——按快照 requestId 比对，
      // 只结算被取消的那一轮，绝不覆盖新 pending（被覆盖会吞新轮）。
      if (doc.pending?.requestId !== state?.pending?.requestId) return;
      if (doc.pending?.takeover) finishTakeover(doc);
      else finishDecision(doc, 'aborted');
      // 结算移除 pending（interruption 标记随之一并清除）：poll/reconcile
      // 之后不再走取消路径，preempted 未消费消息由触发重选恢复。
    }, context);
  }

  /** 接管与工作准入串行；仅给取消前确有在运行提交的决策记录本轮及水位。 */
  function takeoverShower(botId, cancel, abortConversations) {
    return admit(async () => {
      const harness = getHarness();
      const index = await harness.snapshot(WorkIndex, context);
      const candidates = [];
      for (const [key, binding] of Object.entries(index?.byKey ?? {})) {
        const pair = JSON.parse(key);
        if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== botId || typeof pair[1] !== 'string') continue;
        const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
        const pending = state?.pending;
        // 已标中断的 pending 由中断/reconcile 结算，takeover 不再二次接管。
        if (!pending || pending.interruption || state.stopped || state.error) continue;
        if (pending.takeover) {
          candidates.push({ nativeId: binding.nativeId, requestId: pending.requestId, takeover: pending.takeover });
          continue;
        }
        const record = await harness.commit((tx) => tx.submissionByRequest(binding.nativeId, pending.requestId), context);
        if (record?.status !== 'queued' && record?.status !== 'placed') continue;
        const meta = await harness.snapshot(WorkContextState, binding.nativeId, context);
        candidates.push({
          nativeId: binding.nativeId,
          requestId: pending.requestId,
          takeover: {
            requestId: pending.requestId,
            // 旧版尚无起始水位；Bot 准入阻止并发导入，此时已导入水位是安全的上界。
            throughLocalId: Math.max(pending.startedThroughLocalId ?? meta.lastImportedLocalId, pending.prepared?.throughLocalId ?? 0),
          },
        });
      }
      // 同步重新校验屏幕并取消在途工具；此前只读，错误/过期 ID 不改变决策。
      cancel();
      // shortcut: 取消后原因落盘前崩溃仍按普通生成失败恢复，需用户显式恢复；需崩溃原子性时升级跨层协调。
      await harness.commit(async (tx) => {
        for (const candidate of candidates) {
          const state = await tx.doc(WorkDecisionState, candidate.nativeId);
          if (state.pending?.requestId !== candidate.requestId || state.stopped || state.error || state.pending.takeover || state.pending.interruption) continue;
          const record = await tx.submissionByRequest(candidate.nativeId, candidate.requestId);
          if (record?.status === 'queued' || record?.status === 'placed' ||
              (record?.status === 'unanswered' && record.reason === 'aborted')) {
            state.pending.takeover = {
              ...candidate.takeover,
              throughLocalId: Math.max(candidate.takeover.throughLocalId, state.pending.prepared?.throughLocalId ?? 0),
            };
          }
        }
      }, context);
      await abortConversations();
      await harness.commit(async (tx) => {
        for (const candidate of candidates) {
          const state = await tx.doc(WorkDecisionState, candidate.nativeId);
          if (state.pending?.requestId === candidate.requestId) finishTakeover(state);
        }
      }, context);
      wakeRoomWaiters();
      nudge();
    }, undefined, new Set([...CONTROL_ERRORS, 'SHOWER_SESSION_NOT_FOUND', 'SHOWER_SESSION_MISMATCH']), botId);
  }

  async function stopWork(botId, scopeId) {
    assertId(botId, 'botId');
    assertId(scopeId, 'scopeId');
    const result = await admit(async () => {
      const { bot, scope } = await getWorkContexts().resolveWorkContext(botId, scopeId);
      const profile = getProfile(botId, { botId, scopeId, kind: scope.kind });
      const binding = await getHarness().commit(async (tx) => {
        const bound = await ensureWorkBinding(tx, host.deviceId, bot, scope, profile);
        (await tx.doc(WorkDecisionState, bound.nativeId)).stopped = true;
        return bound;
      }, context);
      // strict：显式暂停此处工作的取消失败同样上抛——不得伪装成功。
      await abortPending(binding, true, true);
      return activity(botId, scopeId);
    }, JSON.stringify([botId, scopeId]), CONTROL_ERRORS, botId);
    wakeRoomWaiters();
    // 取消已把该 scope pending 结算并释放 Bot 准入：按 reconcile 相同方式唤醒
    // Host 用户排队泵（用户轮优先 gate 在泵内自身检查），否则 queued user 要等
    // 下一次外部驱动才被拾取。
    try { turnGate.idle?.(botId); } catch { /* 通知失败不影响 Stop 结果 */ }
    return result;
  }

  /**
   * stopScopeWork(scopeId)：群删除/墓碑接收后的整 scope 停止——只结算该 scope
   * 下已绑定的工作 pending（标记 stopped + 精准取消任务族），不 abort 该 Bot
   * 其它 scope 或主聊天工作。不走 scope/Bot 准入 lane（与 interruptBotWork 同
   * 约束）：直接持久 commit + abortPending。绑定此后因墓碑 member 检查不再
   * 被 reconcile/poll 重新调度；未绑定成员的积压由墓碑授权拦截在 authorize。
   */
  async function stopScopeWork(scopeId) {
    assertId(scopeId, 'scopeId');
    const harness = getHarness();
    const index = await harness.snapshot(WorkIndex, context);
    const bindings = [];
    for (const [key, binding] of Object.entries(index?.byKey ?? {})) {
      let pair = null;
      try { pair = JSON.parse(key); } catch { pair = null; }
      if (!Array.isArray(pair) || pair.length !== 2 || pair[1] !== scopeId) continue;
      bindings.push({ botId: pair[0], nativeId: binding.nativeId });
    }
    for (const entry of bindings) {
      await harness.commit(async (tx) => {
        const state = await tx.doc(WorkDecisionState, entry.nativeId);
        state.stopped = true;
      }, context);
      // abortPending 按快照 requestId 比对结算：并发落位的新 pending 不被误结算，
      // 且墓碑 member 检查已阻止后续触发，无需水位捕获。
      await abortPending({ nativeId: entry.nativeId }, true, false);
      // 结算后清理该 scope 的工作持久记录：WorkIndex 解除绑定、协调会话的
      // WorkContextState/WorkDecisionState 退休（pi-durable 无会话删除 API，
      // 不可变 entries/tasks 属 SDK 账本不可删）；主会话/其它 scope 绑定不动。
      await harness.commit(async (tx) => {
        const idx = await tx.doc(WorkIndex);
        for (const k of Object.keys(idx.byKey)) {
          let pair = null;
          try { pair = JSON.parse(k); } catch { pair = null; }
          if (Array.isArray(pair) && pair.length === 2 && pair[1] === scopeId) {
            delete idx.byKey[k];
          }
        }
        await tx.retireDoc(WorkContextState, entry.nativeId);
        await tx.retireDoc(WorkDecisionState, entry.nativeId);
      }, context);
      publishActivity(entry.botId);
    }
    wakeRoomWaiters();
  }

  async function resumeWork(botId, scopeId) {
    assertId(botId, 'botId');
    assertId(scopeId, 'scopeId');
    const result = await admit(async () => {
      const { bot, scope } = await getWorkContexts().resolveWorkContext(botId, scopeId);
      if (!member(getLog().getScope(scopeId), botId)) {
        throw messageError('SCOPE_FORBIDDEN', 'work requires current scope membership');
      }
      const profile = getProfile(botId, { botId, scopeId, kind: scope.kind });
      const binding = await getHarness().commit((tx) => ensureWorkBinding(tx, host.deviceId, bot, scope, profile), context);
      const state = await getHarness().snapshot(WorkDecisionState, binding.nativeId, context);
      const requestId = state?.pending?.requestId;
      // Keep the persistent stop/error fence up until pre-resume native work is fully cancelled.
      if (state?.stopped || (state?.error && state.pending)) await abortPending(binding);
      const record = requestId
        ? await getHarness().commit((tx) => tx.submissionByRequest(executionTargetOf(state, binding), requestId), context)
        : null;
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(WorkDecisionState, binding.nativeId);
        assertOpen();
        if (!member(getLog().getScope(scopeId), botId)) {
          throw messageError('SCOPE_FORBIDDEN', 'work requires current scope membership');
        }
        if (record?.status === 'unanswered' && record.reason === 'aborted' && doc.pending?.requestId === record.requestId) {
          finishDecision(doc, 'aborted');
        }
        doc.stopped = false;
        doc.error = null;
      }, context);
      return activity(botId, scopeId);
    }, JSON.stringify([botId, scopeId]), CONTROL_ERRORS, botId);
    // 显式取消旧 stopped/error 任务后同样唤醒 Host 用户泵：resume 路径在 admit
    // 完成后释放 Bot 准入，queued user 应立刻可泵（用户优先 gate 在泵内）。
    try { turnGate.idle?.(botId); } catch { /* 通知失败不影响 resume 结果 */ }
    wakeRoomWaiters();
    nudge();
    return result;
  }

  /**
   * interruptBotWork(botId, {reason, quiesce})：该 Bot 全部 scope 工作决策的
   * 持久中断标记 + 任务族取消（contract：preempted 只选已有非用户 pending，
   * 不动主聊天/Host 用户队列/scope.stopped；user_stop 覆盖各 scope 待处理积压
   * ——含尚未创建 pending 的已收消息——与已有 pending，捕获停止水位到
   * pending.interruption.throughLocalId，scope.stopped 原值保留）。
   * 本方法绝不取第二条 Bot admission lane（preempt 在 Bot lane 内被准入侧
   * 调用，再取即自锁），也不走 scope lane——只发持久 commit + 精准取消：
   * 先一次性标记全部目标的 interruption（user_stop 同时一次性捕获各 scope
   * 收件水位），再按捕获 requestId 取消任务族，最后按同 requestId 比对结算。
   * 在飞准入以 interruption 标记为 fence（submitPending/beforeRequest/
   * publishWork 均拒绝已标记请求），新提交由既有 Bot stop/pump 门阻止。
   * quiesce=false 只落取消标记/abortSubmission/abortTask，不用会隐式 resume 的
   * conversation.abort/wait（离线或恢复未完的手停路径）。
   * 返回前先完成取消并提交结算：确认前绝不放另一轮争用 Bot 资源，失败抛错可见。
   */
  async function interruptBotWork(botId, { reason = 'user_stop', quiesce = true } = {}) {
    assertId(botId, 'botId');
    if (reason !== 'preempted' && reason !== 'user_stop') {
      throw messageError('INVALID_ARGUMENT', 'interruption reason must be preempted or user_stop');
    }
    const bot = host.getBot(botId);
    if (!bot) throw messageError('BOT_NOT_FOUND', 'bot not found: ' + botId);
    const harness = getHarness();
    const index = await harness.snapshot(WorkIndex, context);
    const targets = [];
    for (const [key, binding] of Object.entries(index?.byKey ?? {})) {
      let pair = null;
      try { pair = JSON.parse(key); } catch { pair = null; }
      if (!Array.isArray(pair) || pair[0] !== botId || typeof pair[1] !== 'string') continue;
      targets.push({ scopeId: pair[1], nativeId: binding.nativeId, key });
    }
    // contract：本方法不取第二条 Bot admission lane——preempt 已在 Bot lane
    // 内被准入侧调用，user_stop 与在飞准入并发；再走 admit(...,botId) 会自
    // 锁，等待排队的 scope chain 也会把迟取消错当已确认。改为：先一次持久
    // commit 标记全部目标 pending 的 interruption（含无 pending 绑定的
    // user_stop 水位推进），再按标记时捕获的 requestId/taskId/submissionId
    // 精准取消任务族，最后 commit 内按同 requestId 比对结算 aborted——
    // 在飞 admit 链若在标记后写入/替换 pending，requestId 比对即落空，
    // 取消标记录重走的 reconcile/interrupt 兜底，绝不吞新轮。
    // user_stop 先一次性捕获全部相关 scope 当前 inbox 水位（绑定/未绑定），
    // 不等前一个 scope 取消完才捕获后者，否则后者晚捕获会吞掉其间新到消息。
    const watermarks = new Map(); // scopeId -> localId（停止边界）
    if (reason === 'user_stop') {
      for (const scopeEntry of getLog().listScopes()) {
        if (!member(scopeEntry, botId)) continue;
        watermarks.set(scopeEntry.scopeId, inboxWatermark(botId, scopeEntry.scopeId));
      }
    }
    const marked = [];
    for (const target of targets) {
      const scope = getLog().getScope(target.scopeId);
      const profile = getProfile(botId, { botId, scopeId: target.scopeId, kind: scope?.kind });
      const captured = await harness.commit(async (tx) => {
        const bound = await ensureWorkBinding(tx, host.deviceId, bot, scope, profile);
        const state = await tx.doc(WorkDecisionState, bound.nativeId);
        const pending = state.pending;
        if (!pending) {
          // 无 pending 的绑定 scope：user_stop 直接把消费边界推进到停止水位，
          // 尚未创建 pending 的积压消息一并结算，之后新到消息正常唤醒。
          if (reason === 'user_stop') {
            state.handledLocalId = Math.max(state.handledLocalId, watermarks.get(target.scopeId) ?? 0);
          }
          return null;
        }
        if (pending.interruption) {
          // 已有标记仍要幂等完成取消：上次失败中断留下标记未结算，
          // reconcile 可能没在跑——捕获同一 requestId 继续取消。user_stop
          // 在已标 preempted 之上升级水位/原因（更强终态），不让旧工作重跑。
          if (reason === 'user_stop' && pending.interruption.reason === 'preempted') {
            pending.interruption = {
              reason: 'user_stop',
              throughLocalId: Math.max(
                watermarks.get(target.scopeId) ?? 0,
                pending.interruption.throughLocalId,
                pending.prepared?.throughLocalId ?? 0,
                pending.startedThroughLocalId ?? 0),
            };
          }
        } else {
          // preempted 不抢占同 Bot 主会话用户轮：pending.turn.sender.kind=user 的
          // 群用户任务与 primary 轮都免疫；Host 来源计划任务不免疫（非用户轮）。
          if (reason === 'preempted' && pending.turn?.sender?.kind === 'user') return null;
          const throughLocalId = reason === 'user_stop'
            ? watermarks.get(target.scopeId) ?? 0
            : 0;
          pending.interruption = {
            reason,
            throughLocalId: Math.max(throughLocalId, pending.prepared?.throughLocalId ?? 0, pending.startedThroughLocalId ?? 0),
          };
        }
        return {
          nativeId: bound.nativeId,
          requestId: pending.requestId,
          submissionId: pending.submissionId ?? null,
          taskId: pending.prepared?.taskId ?? null,
          executionId: typeof pending.executionNativeId === 'number' ? pending.executionNativeId : bound.nativeId,
        };
      }, context);
      if (captured !== null) marked.push(captured);
    }
    // user_stop 覆盖未绑定 scope：先前已一次性捕获水位，此处只建绑定落水位。
    if (reason === 'user_stop') {
      for (const scopeEntry of getLog().listScopes()) {
        const scopeId = scopeEntry.scopeId;
        if (targets.some((t) => t.scopeId === scopeId)) continue;
        if (!member(scopeEntry, botId)) continue;
        const watermark = watermarks.get(scopeId) ?? 0;
        if (watermark === 0) continue;
        const profile = getProfile(botId, { botId, scopeId, kind: scopeEntry.kind });
        await harness.commit(async (tx) => {
          const bound = await ensureWorkBinding(tx, host.deviceId, bot, scopeEntry, profile);
          const state = await tx.doc(WorkDecisionState, bound.nativeId);
          if (state.pending) return; // 新 pending 留给常规路径
          state.handledLocalId = Math.max(state.handledLocalId, watermark);
        }, context);
      }
    }
    // 持久标记完成后精准取消已捕获 requestId 的任务族：取消确认前不允许
    // 另一轮争用 Bot 资源；失败抛错可见（不得把取消失败伪装成功）。
    for (const captured of marked) {
      const ids = unified ? new Set([captured.executionId, captured.nativeId]) : new Set([captured.executionId]);
      for (const id of ids) {
        // submissionId 只传给其登记目标；另一目标按 requestId 查询命中。
        // strict：主动 stop/preempt 的真实取消错误上抛——取消确认前不得把
        // 失败伪装成功放另一轮争用 Bot 资源；标记已持久，调用方可见重试。
        const submissionId = id === captured.executionId ? captured.submissionId : null;
        await abortRequestFamily(id, captured.requestId, captured.taskId, submissionId, quiesce, true);
      }
    }
    // 结算：同 requestId 比对——在飞操作若在标记后替换 pending，不吞新轮；
    // 结算失败/竞态落空时标记仍在，reconcile/恢复路径重走取消+结算。
    for (const captured of marked) {
      await harness.commit(async (tx) => {
        const state = await tx.doc(WorkDecisionState, captured.nativeId);
        if (state.pending?.requestId !== captured.requestId) return;
        finishDecision(state, 'aborted');
      }, context);
    }
    // 中断落定后唤醒 Host 用户泵与 poll：preempted 的存活触发消息下轮重走
    // 相同原始消息路径（handled 不推进，已 published 按 prepared 水位结算）；
    // user_stop 的边界外新消息正常唤醒。代次化发布：旧的在飞汇总结果
    // 晚到时因 generation 过期被丢弃，不会覆盖本结算的终态。
    try { turnGate.idle?.(botId); } catch { /* 通知失败不影响中断结果 */ }
    wakeRoomWaiters();
    if (reason === 'preempted') nudge();
    publishActivity(botId);
  }

  // 执行目标会话选择模型。统一执行时模型/人格/工具由准入管线（Center prepare→
  // applyPreparation）在提交前原子切换，本处不预检——新创建主会话此刻可能还没有
  // 模型，那是准入要解决的临时状态，不是决策失败。legacy 协调会话保持原有
  // 首次选择语义（ensureWorkBinding 写人格/工具，此处仅配置模型）。
  async function selectModel(tx, nativeId, meta, state, bot) {
    if (unified) return true;
    const agent = await tx.doc(AgentDoc, nativeId);
    let ref = agent.model;
    let error = null;
    if (!ref) {
      const configured = bot.modelRef ?? defaultModel;
      if (!configured) error = { code: 'MODEL_REQUIRED', message: 'work model is required' };
      else {
        try { ref = parseModelRef(configured); }
        catch (failure) {
          if (failure?.code !== 'INVALID_ARGUMENT') throw failure;
          error = { code: 'MODEL_NOT_FOUND', message: 'work model reference is invalid' };
        }
      }
    }
    if (!error && !models.getModel(ref.provider, ref.modelId)) {
      error = { code: 'MODEL_NOT_FOUND', message: 'work model is not available' };
    }
    if (error) {
      // 配置/模型缺失是可见失败但非 scope 闸门：记 lastError，绝不再写
      // state.error——否则旧 setup 失败会永久拦截之后到的新消息。有 pending
      // 时按请求级失败结算；无 pending（startDecision 预检）只留可见诊断。
      state.lastError = { code: error.code, message: error.message };
      if (state.pending) settleFailedDecision(state, meta, error);
      return false;
    }
    if (!agent.model) {
      await configure(tx, nativeId, { model: ref });
    }
    return true;
  }

  /**
   * 统一模式的安全边界导入：sessions.sync 把该 Bot 全部收件 scope 增量导入主会话。
   * 返回真实主会话 {nativeId,conversationId}；null 表示暂不可达（离线/忙碌），下轮重试；
   * {configFailure:{code,message}} 表示确定的模型配置失败，可立即请求级结算。
   */
  async function syncPrimaryImport(bot, binding) {
    if (!unified) return null;
    let result = null;
    try {
      result = await sessions.sync(bot.botId);
    } catch (error) {
      // 致命会话/Schema 故障必须上抛，不伪装成暂不可达。
      if (error instanceof SessionFailed || error?.code === 'UNSUPPORTED_SCHEMA') throw error;
      if (error?.code && DETERMINATE_CONFIG_CODES.has(error.code)) {
        // 固定安全文案与已定错误契约一致，不回传原始 error.message。
        return { configFailure: {
          code: error.code,
          message: error.code === 'MODEL_REQUIRED' ? 'center model is required' : 'work model is not available',
        } };
      }
      // 主会话暂不可达（离线/忙碌/其它瞬时错误）：本轮放弃，下轮 poll 重试。
      return null;
    }
    if (!result?.nativeId) return null;
    await getHarness().commit(async (tx) => {
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (state.pending?.turn && typeof state.pending.executionNativeId !== 'number') {
        state.pending.executionNativeId = result.nativeId;
        state.pending.executionConversationId = result.conversationId ?? state.pending.executionConversationId ?? null;
      }
    }, context);
    return result;
  }

  async function submitPending(binding, bot) {
    const harness = getHarness();
    // 已有 pending 缺执行目标的回填/结算：统一 turn 无 executionNativeId 时先尝试
    // syncPrimaryImport；确定的模型配置失败按同一 settleFailedDecision 结算（含
    // notices 回执），暂不可达仍保留下轮重试，SessionFailed 继续上抛。
    if (unified) {
      const snap = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
      if (snap?.pending?.turn && typeof snap.pending.executionNativeId !== 'number') {
        const imported = await syncPrimaryImport(bot, binding);
        if (imported?.configFailure) {
          await harness.commit(async (tx) => {
            const meta = await tx.doc(WorkContextState, binding.nativeId);
            const state = await tx.doc(WorkDecisionState, binding.nativeId);
            if (state.pending?.requestId === snap.pending.requestId) {
              settleFailedDecision(state, meta, imported.configFailure);
            }
          }, context);
          return;
        }
      }
    }
    const prepared = await harness.commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (closing || fatalError || state.stopped || state.error || !state.pending || state.pending.replan || state.pending.takeover || state.pending.interruption || !currentMember(meta)) return null;
      // 统一 turn 而缺执行目标：等待下轮 syncPrimaryImport 回填，绝不在主会话/协调会话
      // 之间漂移执行目标。旧 pending（无 turn）用原协调会话到结算/取消。
      if (unified && state.pending.turn && typeof state.pending.executionNativeId !== 'number') return null;
      const executionId = state.pending.executionNativeId ?? binding.nativeId;
      if (!await selectModel(tx, executionId, meta, state, bot)) return null;
      const wakeContext = state.pending.wakeContext
        ? JSON.parse(JSON.stringify(state.pending.wakeContext))
        : null;
      const input = createWorkInput(
        toWorkContextRecord(meta),
        state.pending.requestId,
        state.pending.turn ?? null,
        wakeContext,
      );
      return { input, executionId };
    }, context);
    if (!prepared) return;
    const { input, executionId } = prepared;
    if (closing || fatalError || !member(getLog().getScope(input.entry.data.scopeId), bot.botId)) return;
    // 新决策与已提交 pending 决策的重投都先过共用准入门：admitWorkDecision 内部
    // 对已有 admissionId 的 pending 走 restoreTurn，否则 prepare/apply/confirm；执行
    // 目标由 pending.executionNativeId（缺省协调会话）决定。返回 null 表示本 Bot 有
    // 原生工作在跑或准入暂不可达，保 pending 下轮重试。
    let submission;
    try { learningHooks?.onWorkStart?.(bot.botId); } catch { /* 学习抢占通知失败不影响工作提交 */ }
    try {
      submission = turnGate.fn
        ? await turnGate.fn(binding, bot, input)
        : await (await conversationFor({ nativeId: executionId })).submit(input, context);
    } catch (error) {
      if (error instanceof ConversationBusy) return;
      throw error;
    }
    if (!submission) return;
    // 提交在飞期间的迟到 stop/preempt：pending 已标中断时立即中止刚提交的
    // submission，绝不出现「中断后新执行」；结算由 reconcile/interrupt 完成。
    const after = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    if (after?.pending?.requestId === input.requestId && after.pending.interruption) {
      await abortRequestFamily(executionId, input.requestId, after.pending.prepared?.taskId, submission.id, false).catch(() => {});
      return;
    }
    await harness.commit(async (tx) => {
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (state.pending?.requestId === input.requestId) {
        state.pending.submissionId = submission.id;
      }
    }, context);
  }

  async function reconcile(binding, bot) {
    const harness = getHarness();
    const snapshot = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    if (!snapshot?.pending) return;
    const requestId = snapshot.pending.requestId;
    // 重启恢复/迟到 reconcile：中断标记先完成取消与结算（abort 幂等，
    // quiesce 默认 true——在线 poll 路径可安全等待），绝不重投被取消请求。
    if (snapshot.pending.interruption || snapshot.pending.takeover) {
      await abortPending(binding);
      return;
    }
    const meta = await harness.snapshot(WorkContextState, binding.nativeId, context);
    if (snapshot.stopped || !currentMember(meta)) {
      await abortPending(binding);
      return;
    }
    const record = await harness.commit((tx) => tx.submissionByRequest(executionTargetOf(snapshot, binding), requestId), context);
    if (!record) {
      await submitPending(binding, bot);
      return;
    }
    // 读取执行会话的 runFailure + Host 失败诊断族（contract A）的具体原因，
    // 在结算提交外完成，失败读不阻塞本地终态。
    const executionNativeId = executionTargetOf(snapshot, binding);
    const live = await harness.snapshot(LiveDoc, executionNativeId, context).catch(() => null);
    const preparedTaskKey = snapshot.pending?.prepared?.taskId != null
      ? String(snapshot.pending.prepared.taskId) : null;
    const runFailure = live?.runFailure ?? null;
    // contract A：优先 LiveDoc.runFailure 记录的失败任务，回落本决策已持久化的
    // prepared.taskId（字符串）。族文档在生成任务终结后仍存活，新一轮启动覆盖
    // runFailure 后仍可按 prepared.taskId 找回本请求诊断。
    // runFailure 只在其 inputs 含本提交 record.id 时才归属本 pending；
    // 同 Bot 之后用户轮/别 scope 的新失败绝不能记到本请求头上。
    const runFailureOwnsRecord = runFailure !== null &&
      (runFailure.inputs ?? []).some((id) => String(id) === String(record.id));
    const failureTaskKey = runFailureOwnsRecord && runFailure.taskId != null
      ? String(runFailure.taskId) : preparedTaskKey;
    const failureDoc = failureTaskKey !== null
      ? await harness.snapshot(GenerationFailureState, executionNativeId, failureTaskKey, context).catch(() => null)
      : null;
    const diagnosed = failureDoc?.failure ?? null;
    let shouldSubmitNudge = false;
    let completedWorkInfo = null;
    await harness.commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      const pending = state.pending;
      if (pending?.requestId !== requestId) return;
      pending.submissionId = record.id;
      if (record.status === 'queued' || record.status === 'placed') return;
      if (state.stopped) {
        finishDecision(state, 'aborted');
      } else if (pending.replan) {
        finishDecision(state, 'replan');
      } else if (record.status === 'done' && pending.prepared && !state.error) {
        if (
          pending.replyRequired === true &&
          !pending.published &&
          !pending.passed &&
          !pending.interruption &&
          !pending.takeover &&
          currentMember(meta) &&
          (pending.nudgeCount ?? 0) < MAX_REPLY_NUDGES
        ) {
          const nextNudge = (pending.nudgeCount ?? 0) + 1;
          const nextRequestId = randomUUID();
          pending.startedThroughLocalId = Math.max(
            pending.startedThroughLocalId ?? 0,
            pending.prepared.throughLocalId ?? 0,
          );
          pending.requestId = nextRequestId;
          pending.submissionId = null;
          pending.admissionId = null;
          pending.setId = null;
          pending.prepared = null;
          pending.nudgeCount = nextNudge;
          if (pending.turn) {
            const baseTurn = JSON.parse(JSON.stringify(pending.turn));
            pending.turn = toFrozenTurn({
              ...baseTurn,
              requestId: nextRequestId,
              taskId: null,
              nudgeCount: nextNudge,
            });
          }
          const prevWake = pending.wakeContext
            ? JSON.parse(JSON.stringify(pending.wakeContext))
            : {};
          pending.wakeContext = { ...prevWake, nudgeCount: nextNudge };
          shouldSubmitNudge = true;
          return;
        }
        state.handledLocalId = Math.max(state.handledLocalId, pending.prepared.throughLocalId);
        finishDecision(state, pending.published ? 'published' : 'silent');
        completedWorkInfo = { botId: bot.botId, unified, submissionId: record.id };
      } else {
        // 请求级失败（contract C）：优先 contract A 的具体诊断；缺失时回落
        // record/LiveDoc 安全原因，绝不读模型正文猜失败。
        let failure = diagnosed !== null && typeof diagnosed === 'object' ? diagnosed : null;
        if (failure === null) {
          if (record.reason === 'no_model') {
            const agent = await tx.doc(AgentDoc, executionTargetOf(state, binding));
            failure = agent.model
              ? { code: 'MODEL_NOT_FOUND', message: 'work model is not available' }
              : { code: 'MODEL_REQUIRED', message: 'work model is required' };
          } else {
            failure = generationError(record.status === 'done' ? 'missing_prepared' : record.reason);
          }
        }
        settleFailedDecision(state, meta, failure);
      }
    }, context);
    if (shouldSubmitNudge) {
      if (!closing && !fatalError) await submitPending(binding, bot);
      return;
    }
    // 决策落定为安全切换边界：唤醒该 Bot 的 Host 排队轮泵。
    try { turnGate.idle?.(bot.botId); } catch { /* 通知失败不影响结算 */ }
    if (completedWorkInfo) {
      try { learningHooks?.onWorkCompleted?.(completedWorkInfo); } catch { /* 学习通知失败不影响结算 */ }
    }
  }

  // 分批键：同一批只合并同一回复来源（迟到回复按原始请求 originRequestId；
  // 新请求/public 按目标 scope）。同 DM 的不同入站请求按各自 responseMessageId
  // 分批（回复必须回到正确原任务）；room public 仍按 scope 合批；不同
  // originRequestId 的迟到回复绝不并入同一 pending。
  function batchKeyOf(origin) {
    if (origin.originRequestId !== undefined) return 'reply:' + origin.originRequestId;
    // 同 DM 的多个不同入站请求不再合批：单条回复只挂其原始请求，跨请求来源
    // 必须分批，保证每条回信回到正确原任务；room public 继续按 scope 合批。
    if (origin.kind === 'dm' && origin.responseMessageId !== undefined) {
      return 'dm:' + origin.responseMessageId;
    }
    const t = origin.replyTarget ?? {};
    return 'new:' + (t.kind ?? '') + ':' + (t.scopeId ?? '') + ':' + (t.botId ?? '');
  }

  /** DM scope 的默认回复目标（对端成员）。 */
  function dmReplyTarget(meta) {
    const scope = getLog().getScope(meta.scopeId);
    const peer = scope?.members?.find((m) => !(m.deviceId === host.deviceId && m.botId === meta.botId));
    return { kind: 'dm', scopeId: meta.scopeId, ...(peer ? { botId: peer.botId } : {}) };
  }

  /**
   * 从本 scope 未处理条目选出本轮触发批次与冻结来源。
   * 触发资格（真实封套 author/category，绝不看正文）：
   *   room: category 'public' 且非 selfEcho；
   *   dm:   category 'request' 且非 selfEcho；
   *   dm:   category 'reply' 且 sessions.replyOrigin 命中本 Bot 原始 request，
   *         并且 localId > observedThroughLocalId（迟到回复恢复其发起轮）。
   * 未知回复/notice/selfEcho 保持被动。首个触发项确定本轮 replyTarget；
   * 不同回复目标/来源 scope 的触发项不并入本批——留给下一决策轮，
   * 不在同一 pending 里吞掉另一来源的轮。
   * 未在预查 Map 中出现的 reply（预查与 commit 之间新到的回复）视作屏障：
   * 本批截止且 handled 水位绝不跨过它，留待下轮 poll 重新寻源。已寻源为未知
   * 回复（Map 值为 null）或已观察回复按被动上下文处理，可并入批内。
   * 返回 {trigger: {kind, scopeId, triggerMessageId, triggerMessageIds, replyTo,
   * rootId, sender, replyTarget, responseMessageId?, originRequestId?} | null,
   * batchThrough}；responseMessageId 是本轮默认回应的原始请求消息 ID
   * （DM request 触发即该请求自身；迟到回复沿 outgoing 记录逐跳还原），
   * 发送侧只认它，绝不用触发消息或其 replyTo 冒充。
   * batchThrough 是本批最后消费的 localId（含批内被动条目），屏障/换批项不计入。
   */
  function collectTrigger(meta, items, replyOrigins) {
    let trigger = null;
    let batchThrough = 0;
    for (const item of items) {
      const message = item.message ?? {};
      let origin = null;
      let barrier = false;
      if (!item.selfEcho) {
        if (meta.kind === 'room' && message.category === 'public') {
          origin = {
            kind: 'room',
            scopeId: meta.scopeId,
            sender: triggerSender(message),
            replyTarget: { kind: 'room', scopeId: meta.scopeId },
          };
        } else if (meta.kind === 'dm' && message.category === 'request') {
          origin = {
            kind: 'dm',
            scopeId: meta.scopeId,
            sender: triggerSender(message),
            replyTarget: dmReplyTarget(meta),
            // 本轮默认回应的目标消息 = 该请求自身；与触发消息同值但语义独立，
            // 续轮/嵌套委派只沿 responseMessageId 续接，不用触发消息或其 replyTo 冒充。
            responseMessageId: typeof message.messageId === 'string' ? message.messageId : undefined,
          };
        } else if (meta.kind === 'dm' && message.category === 'reply') {
          const key = typeof message.replyTo === 'string' ? message.replyTo : undefined;
          if (replyOrigins === null || key === undefined || !replyOrigins.has(key)) {
            // 未寻源过的回复不是可判定的被动项：留待下轮，不越过它推进水位。
            barrier = true;
          } else {
            const rec = replyOrigins.get(key);
            if (rec !== null && item.localId > (rec.observedThroughLocalId ?? 0)) {
              // 迟到回复回到原始请求的发起轮；workNativeId 仍是本 scope 协调绑定。
              const target = rec.replyTarget ?? { kind: 'primary' };
              origin = {
                kind: target.kind === 'primary' ? 'primary' : (target.kind === 'dm' ? 'dm' : 'room'),
                scopeId: target.kind === 'primary' ? null : (target.scopeId ?? meta.scopeId),
                sender: triggerSender(message),
                replyTarget: target,
                // 多层续轮沿持久化原始目标消息传递：A->B->C 时 B 的回应仍回
                // A 的原请求消息，与本次触发消息（C 的回复）及其 replyTo 无关。
                responseMessageId: rec.responseMessageId,
                originRequestId: rec.requestId,
              };
            }
          }
        }
      }
      if (barrier) break;
      if (origin !== null) {
        const messageId = typeof message.messageId === 'string' ? message.messageId : undefined;
        origin.triggerMessageId = messageId;
        origin.replyTo = typeof message.replyTo === 'string' ? message.replyTo : undefined;
        origin.rootId = typeof message.rootId === 'string' ? message.rootId : undefined;
        const key = batchKeyOf(origin);
        if (trigger === null) {
          trigger = { ...origin, batchKey: key, triggerMessageIds: messageId !== undefined ? [messageId] : [] };
        } else if (trigger.batchKey === key) {
          if (messageId !== undefined) trigger.triggerMessageIds.push(messageId);
        } else {
          // 不同回复来源/目标的触发留给下一轮；本批截止，不越过未处理请求推进水位。
          break;
        }
      }
      batchThrough = item.localId;
    }
    return { trigger, batchThrough };
  }

  const memberKey = (deviceId, botId) => `${deviceId ?? ''}:${botId ?? ''}`;

  function toGroupMessage(storedItem, scopeMembersByBotId) {
    const msg = storedItem?.message ?? {};
    const author = msg.author ?? {};
    if (author.kind === 'user') {
      return {
        id: msg.messageId ?? String(storedItem.localId ?? ''),
        content: typeof msg.text === 'string' ? msg.text : '',
        speaker: {
          kind: 'user',
          ...(typeof author.name === 'string' && author.name ? { name: author.name } : {}),
        },
      };
    }
    const botId = typeof author.botId === 'string' ? author.botId : '';
    const deviceId = typeof msg.sourceDeviceId === 'string' && msg.sourceDeviceId
      ? msg.sourceDeviceId
      : (scopeMembersByBotId.get(botId) ?? '');
    const meta = resolveBotMeta(deviceId, botId);
    return {
      id: msg.messageId ?? String(storedItem.localId ?? ''),
      content: typeof msg.text === 'string' ? msg.text : '',
      speaker: {
        kind: 'member',
        id: memberKey(deviceId, botId),
        name: meta.name || botId || 'Peer Bot',
      },
    };
  }

  function readRoomPublicStored(scopeId, maxLocalId = null) {
    const collectedPublic = [];
    let historyCursor = Number.isSafeInteger(maxLocalId) && maxLocalId >= 0
      ? {
          deviceId: host.deviceId,
          kind: 'history-before',
          key: scopeId,
          beforeLocalId: maxLocalId + 1,
        }
      : null;
    let upperLocalId = Number.isSafeInteger(maxLocalId) ? maxLocalId : Infinity;
    for (let page = 0; page < 4 && collectedPublic.length < GROUP_PROMPT_HISTORY_LIMIT; page += 1) {
      const historyPage = getLog().history(scopeId, {
        order: 'descending',
        limit: GROUP_PROMPT_HISTORY_LIMIT + 8,
        ...(historyCursor ? { cursor: historyCursor } : {}),
      });
      let progressed = false;
      for (const it of historyPage.items) {
        if (it.localId > upperLocalId) continue;
        upperLocalId = it.localId - 1;
        progressed = true;
        if (it.message?.category === 'public') {
          collectedPublic.push(it);
          if (collectedPublic.length >= GROUP_PROMPT_HISTORY_LIMIT) break;
        }
      }
      if (!historyPage.nextCursor || !progressed) break;
      historyCursor = historyPage.nextCursor;
    }
    return collectedPublic.reverse();
  }

  async function startDecision(binding, bot, options = null) {
    const harness = getHarness();
    const metaSnap = await harness.snapshot(WorkContextState, binding.nativeId, context);
    const stateSnap = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    if (!metaSnap || stateSnap?.pending || stateSnap?.stopped || stateSnap?.error) {
      return { started: false, deferred: false };
    }
    const unreadPeek = inboxAfter(metaSnap.botId, metaSnap.scopeId, stateSnap?.handledLocalId ?? 0, 1);
    if (unreadPeek.items.length === 0) {
      return { started: false, deferred: false };
    }
    // 统一执行：canRunWork 空闲边界后才做 sessions.sync（commit 外、Bot 准入内一次）；
    // 不通过表示排队用户轮/原生工作优先，下轮 poll 重试。scope/legacy 导入仍走
    // syncWorkContext（archive 历史），不推进主会话水位。
    let primary = null;
    let configFailure = null;
    if (unified) {
      if (turnGate.canRunWork && !(await turnGate.canRunWork(bot.botId))) {
        return { started: false, deferred: true };
      }
      const imported = await syncPrimaryImport(bot, binding);
      if (imported?.configFailure) {
        // 确定的模型配置失败：仍要冻结本请求再请求级结算——只消费当前批，
        // 回执经 notices 回原 DM；绝不当暂不可达无限等待，也不吞 SessionFailed。
        configFailure = imported.configFailure;
      } else {
        primary = imported;
        if (primary === null || typeof primary.nativeId !== 'number') {
          return { started: false, deferred: true };
        }
      }
    }
    // 迟到 DM 回复寻源与远端目录预热在 commit 外做（绝不把 snapshot/网络读嵌进写事务）。
    let replyOrigins = null;
    {
      const warmedScopes = new Set();
      const warmScope = async (scopeId) => {
        if (typeof scopeId !== 'string' || !scopeId || warmedScopes.has(scopeId)) return;
        warmedScopes.add(scopeId);
        await warmBotDirectoryIfNeeded(getLog().getScope(scopeId));
      };
      await warmScope(metaSnap.scopeId);
      if (unified && metaSnap.kind === 'dm') {
        replyOrigins = new Map();
        const items = inboxAfter(metaSnap.botId, metaSnap.scopeId, stateSnap?.handledLocalId ?? 0).items
          .filter((item) => item.localId <= metaSnap.lastImportedLocalId);
        for (const item of items) {
          // selfEcho（本 Bot 自己的 Host 失败回执等）与 collectTrigger 同样排除：
          // 只对真实入站 peer reply 寻源，避免对无需寻源的自回执调用 replyOrigin。
          if (item.selfEcho) continue;
          const message = item.message ?? {};
          if (message.category === 'reply' && typeof message.replyTo === 'string' && !replyOrigins.has(message.replyTo)) {
            const originRec = await sessions.replyOrigin(metaSnap.botId, message);
            replyOrigins.set(message.replyTo, originRec);
            if (typeof originRec?.replyTarget?.scopeId === 'string') {
              await warmScope(originRec.replyTarget.scopeId);
            }
          }
        }
      }
    }
    const maxAllowedLocalId = Number.isSafeInteger(options?.maxLocalId) ? options.maxLocalId : null;
    const commitOutcome = await harness.commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (closing || fatalError || state.pending || state.stopped || state.error || !currentMember(meta)) {
        return { created: false };
      }
      // A receive after sync can add another page; do not start on a knowingly incomplete import.
      if (maxAllowedLocalId === null && inboxAfter(meta.botId, meta.scopeId, meta.lastImportedLocalId, 1).items.length) {
        return { created: false, needsResync: true };
      }
      const ceiling = maxAllowedLocalId !== null
        ? Math.min(meta.lastImportedLocalId, maxAllowedLocalId)
        : meta.lastImportedLocalId;
      const items = inboxAfter(meta.botId, meta.scopeId, state.handledLocalId).items
        .filter((item) => item.localId <= ceiling);
      if (!items.length) return { created: false };
      const { trigger, batchThrough } = collectTrigger(meta, items, replyOrigins);
      if (!trigger) {
        // 屏障前的被动条目已判定消费；屏障项与未判定的回复不越过。
        if (batchThrough > 0) state.handledLocalId = batchThrough;
        return { created: false };
      }

      let wakeContext = null;
      if (meta.kind === 'room') {
        const redriveAttempts = state.preemptedAttempts ?? 0;
        if (redriveAttempts >= GROUP_MAX_REDRIVE_ATTEMPTS) {
          state.preemptedAttempts = 0;
          state.handledLocalId = Math.max(state.handledLocalId, batchThrough);
          return { created: false };
        }
        const scope = getLog().getScope(meta.scopeId);
        const scopeMembers = scope?.members ?? [];
        const scopeMembersByBotId = new Map(scopeMembers.map((m) => [m.botId, m.deviceId]));
        const groupMembers = scopeMembers.map((m) => {
          const info = resolveBotMeta(m.deviceId, m.botId);
          return {
            id: memberKey(m.deviceId, m.botId),
            name: info.name || m.botId,
            description: info.description || '',
          };
        });
        const selfMemberId = memberKey(host.deviceId, meta.botId);
        const selfInfo = resolveBotMeta(host.deviceId, meta.botId);
        const recentStored = readRoomPublicStored(meta.scopeId, batchThrough);
        const recentHistory = recentStored.map((it) => toGroupMessage(it, scopeMembersByBotId));
        const unreadMessages = items
          .filter((it) => it.localId <= batchThrough && !it.selfEcho && it.message?.category === 'public')
          .map((it) => toGroupMessage(it, scopeMembersByBotId));
        const eligibility = evaluateGroupTurnEligibility({
          memberId: selfMemberId,
          members: groupMembers,
          recentHistory,
          unreadMessages,
        });
        if (!eligibility.eligible) {
          state.preemptedAttempts = 0;
          state.handledLocalId = Math.max(state.handledLocalId, batchThrough);
          return { created: false };
        }
        const firstUnreadIdx = recentStored.findIndex(
          (it, idx) => it.localId > state.handledLocalId && recentHistory[idx]?.speaker?.id !== selfMemberId,
        );
        const newMessages = firstUnreadIdx >= 0
          ? recentHistory.slice(firstUnreadIdx)
          : messagesSinceMemberLastSpoke(recentHistory, selfMemberId);
        wakeContext = {
          selfName: selfInfo.name || bot.role || meta.botId,
          selfMemberId,
          groupTitle: scope?.title ?? '',
          peers: groupMembers
            .filter((m) => m.id !== selfMemberId)
            .map((m) => ({ name: m.name, description: m.description })),
          newMessages,
          ...(redriveAttempts > 0 ? { redrive: true } : {}),
        };
      } else if (meta.kind === 'dm') {
        if (trigger.replyTarget?.kind === 'room' && typeof trigger.replyTarget.scopeId === 'string') {
          const roomScope = getLog().getScope(trigger.replyTarget.scopeId);
          const roomMembers = roomScope?.members ?? [];
          const dmScope = getLog().getScope(meta.scopeId);
          const membersByBotId = new Map([
            ...roomMembers.map((m) => [m.botId, m.deviceId]),
            ...(dmScope?.members ?? []).map((m) => [m.botId, m.deviceId]),
          ]);
          const selfMemberId = memberKey(host.deviceId, meta.botId);
          const selfInfo = resolveBotMeta(host.deviceId, meta.botId);
          const triggerIds = new Set(trigger.triggerMessageIds ?? []);
          const dmReplyMessages = items
            .filter((it) =>
              it.localId <= batchThrough &&
              !it.selfEcho &&
              (triggerIds.size > 0 ? triggerIds.has(it.message?.messageId) : it.message?.category === 'reply'),
            )
            .map((it) => {
              const gm = toGroupMessage(it, membersByBotId);
              if (gm.speaker?.kind === 'member' && gm.speaker.name) {
                return {
                  ...gm,
                  speaker: { ...gm.speaker, name: `${gm.speaker.name} (DM reply)` },
                };
              }
              return gm;
            });
          wakeContext = {
            selfName: selfInfo.name || bot.role || meta.botId,
            selfMemberId,
            groupTitle: roomScope?.title ?? '',
            peers: roomMembers
              .filter((m) => memberKey(m.deviceId, m.botId) !== selfMemberId)
              .map((m) => {
                const info = resolveBotMeta(m.deviceId, m.botId);
                return { name: info.name || m.botId, description: info.description || '' };
              }),
            newMessages: dmReplyMessages,
          };
        } else {
          const peerInfo = resolveBotMeta(trigger.sender?.deviceId, trigger.sender?.botId);
          const replyTargetInfo = trigger.replyTarget?.kind === 'dm'
            ? resolveBotMeta(undefined, trigger.replyTarget?.botId)
            : { name: '', description: '' };
          const triggerIds = new Set(trigger.triggerMessageIds ?? []);
          const triggerTexts = items
            .filter((it) => it.localId <= batchThrough && !it.selfEcho && triggerIds.has(it.message?.messageId))
            .map((it) => (typeof it.message?.text === 'string' ? it.message.text : ''))
            .filter(Boolean);
          wakeContext = {
            peerName: peerInfo.name || trigger.sender?.botId || '',
            replyTargetName: replyTargetInfo.name || peerInfo.name || trigger.replyTarget?.botId || '',
            category: trigger.originRequestId !== undefined ? 'reply' : 'request',
            triggerText: clampBlock(triggerTexts.join('\n\n'), 2_000),
            nudgeCount: 0,
          };
        }
      }

      const replyRequired = Boolean(
        unified &&
        trigger.replyTarget?.kind === 'dm' &&
        typeof trigger.responseMessageId === 'string',
      );
      const requestId = randomUUID();
      const turn = unified
        ? toFrozenTurn({
            requestId,
            taskId: null,
            kind: trigger.kind,
            scopeId: trigger.scopeId,
            workNativeId: binding.nativeId,
            triggerMessageId: trigger.triggerMessageId,
            triggerMessageIds: trigger.triggerMessageIds,
            replyTo: trigger.replyTo,
            rootId: trigger.rootId,
            responseMessageId: trigger.responseMessageId,
            sender: trigger.sender,
            replyTarget: trigger.replyTarget,
            botId: bot.botId,
            deviceId: host.deviceId,
            originRequestId: trigger.originRequestId,
          })
        : null;
      // 新一轮开始即清掉上一轮的请求级失败诊断：旧 lastError 不覆盖新成功。
      state.lastError = null;
      state.pending = {
        requestId,
        submissionId: null,
        startedAt: new Date().toISOString(),
        startedThroughLocalId: batchThrough,
        prepared: null,
        published: false,
        publishedCount: 0,
        passed: false,
        replyRequired,
        nudgeCount: 0,
        wakeContext,
        replan: false,
        // 统一执行：冻结 commit 外 sessions.sync 返回的真实主会话 nativeId/conversationId；
        // 绝不在 commit 内再调 Session 读或 tx.conversation 公共 ID 查询。
        executionNativeId: primary?.nativeId ?? null,
        executionConversationId: primary?.conversationId ?? null,
        turn,
        // 迟到回复恢复时记录原始请求 messageId（审计/寻源，入 turn 供 codec 标注）。
        ...(trigger.originRequestId !== undefined ? { originRequestId: trigger.originRequestId } : {}),
      };
      // 确定的模型配置失败：pending 已冻结，立即请求级结算（settleFailedDecision
      // 推进 handled 到本批边界、落 lastError、按冻结 replyTarget 写 notices 回执），
      // 不投 native、不阻塞后续新请求。legacy selectModel 同样移到冻结后判定。
      if (configFailure !== null) {
        settleFailedDecision(state, meta, configFailure);
        return { created: false };
      }
      if (!await selectModel(tx, binding.nativeId, meta, state, bot)) return { created: false };
      return { created: true, requestId };
    }, context);
    // Persist the request identity before admission; crash recovery resubmits this exact request, not another turn.
    if (commitOutcome?.created && !closing && !fatalError) {
      await submitPending(binding, bot);
      return { started: true, requestId: commitOutcome.requestId };
    }
    return {
      started: false,
      deferred: false,
      ...(commitOutcome?.needsResync ? { needsResync: true } : {}),
    };
  }

  /**
   * 升级遗留 fence（contract C）：v1 的 scope 级 error 会无限阻断新请求。
   * 首次见到 state.error 时一次性捕获迁移边界：failureWatermark 记为已导入
   * 水位，其前所有未消费 backlog 随 handledLocalId 一并结算、绝不自动重放
   * （旧购物/用药任务不会复活）；失败本体经 lastError 保留可见，error 闸门
   * 清除，其后新到消息正常进入触发评估。若 error 是本轮代码新写的请求级
   * 值以外的残留（理论上 v2 不再写），同样只作一次性边界处理。
   */
  async function fenceLegacyError(binding, meta) {
    const harness = getHarness();
    const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    if (!state?.error || (state.failureWatermark ?? 0) > 0) return;
    await harness.commit(async (tx) => {
      const doc = await tx.doc(WorkDecisionState, binding.nativeId);
      if (!doc.error || (doc.failureWatermark ?? 0) > 0) return;
      const boundary = Math.max(meta?.lastImportedLocalId ?? 0, doc.handledLocalId ?? 0);
      // 保留可见失败：error 的具体 code/message 转入 lastError 供活动/ LIVE 展示。
      doc.lastError = { code: doc.error.code, message: doc.error.message };
      doc.error = null;
      doc.failureWatermark = boundary;
      doc.handledLocalId = boundary;
    }, context);
  }

  /**
   * 把 state.notices 中尚未发布的 Host 执行失败回执落账本（contract D）。
   * 每条一次 publish 即标记 published；账本按稳定 messageId+fingerprint 幂等，
   * 重放安全（重启/重复 poll 不重复发）。room 目标发 category public（其协议只
   * 允许 public），dm 目标发 reply 挂原请求 replyTo；primary/无目标不伪造。
   * 只结算本 scope 的回执；publish 失败保留草稿下轮重试。
   */
  async function drainFailureNotices(botId, binding) {
    const harness = getHarness();
    const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    const drafts = Object.entries(state?.notices ?? {})
      .filter(([, n]) => n && n.published !== true && n.delivery !== 'failed');
    if (!drafts.length) return;
    for (const [requestId, draft] of drafts) {
      const target = draft.target ?? {};
      if (target.kind !== 'dm' && target.kind !== 'room') continue;
      if (typeof target.scopeId !== 'string') continue;
      const scope = getLog().getScope(target.scopeId);
      const isDm = scope?.kind === 'dm';
      const mark = async (fields) => {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(WorkDecisionState, binding.nativeId);
          const notice = doc.notices?.[requestId];
          if (notice && notice.messageId === draft.messageId) Object.assign(notice, fields);
        }, context);
      };
      // scope 暂未安装/不可见：临时态，记 lastDeliveryError 下轮重试，绝不吞。
      if (!scope) { await mark({ delivery: 'pending', lastDeliveryError: 'SCOPE_NOT_FOUND' }); continue; }
      const category = isDm ? 'reply' : 'public';
      const replyTo = isDm && typeof draft.replyTo === 'string' ? draft.replyTo : null;
      try {
        getLog().publish({
          messageId: draft.messageId,
          scopeId: target.scopeId,
          author: { kind: 'bot', botId },
          category,
          text: draft.text,
          replyTo,
        });
        // publish 返回即成功（新插入或同 messageId+fingerprint 幂等命中）。
        await mark({ published: true, delivery: 'sent', lastDeliveryError: null });
      } catch (error) {
        const code = error?.code ?? 'PUBLISH_FAILED';
        // MESSAGE_NOT_FOUND = 回复目标未入库（迟到历史），SCOPE_FORBIDDEN = 成员
        // 资格/类别不符：均保留草稿+原因下轮重试，绝不伪装已送达。
        // REQUEST_CONFLICT = 同 messageId 不同内容（稳定 ID 与原文一致时不应发生）：
        // 记 failed 终态对账，不重试以免每轮无效写。
        if (code === 'REQUEST_CONFLICT') {
          await mark({ delivery: 'failed', lastDeliveryError: code });
        } else {
          await mark({ delivery: 'pending', lastDeliveryError: code });
        }
      }
    }
  }

  async function advance(botId, scopeId) {
    if (!active || closing) return;
    let resolved;
    try { resolved = await getWorkContexts().resolveWorkContext(botId, scopeId); }
    catch (error) {
      // Membership can disappear between discovery and authorization of an as-yet unbound scope;
      // BOT_NOT_FOUND covers a Bot deleted between poll discovery and authorize;
      if (error?.code === 'SCOPE_DELETED') {
        // 墓碑已安装（含 peer 接收路径）：结算该 scope 已绑定的排队/运行工作，
        // 不 abort 同 Bot 其它 scope 或主聊天；失败下轮重试，不阻塞 poll。
        await stopScopeWork(scopeId).catch(() => {});
        return;
      }
      if (error?.code === 'SCOPE_FORBIDDEN' || error?.code === 'BOT_NOT_FOUND') return;
      throw error;
    }
    if (!resolved.binding && !inboxAfter(botId, scopeId, 0, 1).items.length) return;
    const imported = await getWorkContexts().syncWorkContext(botId, scopeId, { limit: 200 });
    let second;
    try { second = await getWorkContexts().resolveWorkContext(botId, scopeId); }
    catch (error) {
      // Bot deleted between sync and the second authorize: same expected expiry.
      if (error?.code === 'BOT_NOT_FOUND') return;
      throw error;
    }
    const { bot, binding } = second;
    if (!binding) throw new Error('work import did not create a binding');
    if (closing || fatalError) return;
    const meta = await getHarness().snapshot(WorkContextState, binding.nativeId, context);
    await fenceLegacyError(binding, meta);
    await drainFailureNotices(botId, binding);
    await reconcile(binding, bot);
    if (!imported.hasMore && !closing && !fatalError) await startDecision(binding, bot);
  }

  function latestRoomPublicLocalId(scopeId) {
    const page = getLog().history(scopeId, { order: 'descending', limit: 32 });
    for (const item of page.items) {
      if (item.message?.category === 'public') return item.localId;
    }
    return 0;
  }

  function hasExternalPublicSince(scopeId, baselineLocalId, publishedIds) {
    let cursor = null;
    let upperLocalId = Infinity;
    for (let page = 0; page < 4; page += 1) {
      const historyPage = getLog().history(scopeId, {
        order: 'descending',
        limit: 32,
        ...(cursor ? { cursor } : {}),
      });
      let reachedBaseline = false;
      for (const item of historyPage.items) {
        if (item.localId > upperLocalId) continue;
        upperLocalId = item.localId - 1;
        if (item.localId <= baselineLocalId) {
          reachedBaseline = true;
          break;
        }
        const msg = item.message;
        if (msg?.category !== 'public') continue;
        if (isHostFailureReceiptText(msg.text)) continue;
        if (publishedIds.has(msg.messageId)) continue;
        return true;
      }
      if (reachedBaseline || !historyPage.nextCursor || historyPage.items.length === 0) break;
      cursor = historyPage.nextCursor;
    }
    return false;
  }

  function bumpActiveRoomEpochsOnExternal() {
    if (!existsSync(join(host.dataRoot, 'messages.sqlite'))) return;
    for (const [scopeId, tracker] of activeRoomEpochs.entries()) {
      if (
        tracker.windowCeiling === null &&
        roomScheduler.currentTurnEpoch(scopeId) === tracker.epoch &&
        hasExternalPublicSince(scopeId, tracker.baselineLocalId, tracker.publishedIds)
      ) {
        roomScheduler.nextTurnEpoch(scopeId);
        roomRescanNeeded.add(scopeId);
      }
    }
  }

  async function waitForRoomMemberPending(botId, scopeId, requestId) {
    const key = JSON.stringify([botId, scopeId]);
    while (active && !closing && !fatalError) {
      const outcome = await admit(async () => {
        let resolved;
        try {
          resolved = await getWorkContexts().resolveWorkContext(botId, scopeId);
        } catch (error) {
          if (error?.code === 'SCOPE_DELETED') {
            await stopScopeWork(scopeId).catch(() => {});
            return { done: true };
          }
          if (error?.code === 'SCOPE_FORBIDDEN' || error?.code === 'BOT_NOT_FOUND') {
            return { done: true };
          }
          throw error;
        }
        const { bot, binding } = resolved;
        if (!binding) return { done: true };
        const harness = getHarness();
        const meta = await harness.snapshot(WorkContextState, binding.nativeId, context);
        await fenceLegacyError(binding, meta);
        await drainFailureNotices(botId, binding);
        await reconcile(binding, bot);
        const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
        if (!state?.pending || state.pending.requestId !== requestId) {
          return {
            done: true,
            preempted: (state?.preemptedAttempts ?? 0) > 0,
          };
        }
        // If submission could not be placed (e.g. Bot became busy or stopped before native
        // submission/admission), roll back the unsubmitted pending so other room members are
        // not blocked; handledLocalId stays untouched for later catch-up.
        if (state.pending.submissionId === null && !state.pending.admissionId) {
          const executionId = executionTargetOf(state, binding);
          const record = await harness.commit(
            (tx) => tx.submissionByRequest(executionId, requestId),
            context,
          );
          if (!record) {
            await harness.commit(async (tx) => {
              const doc = await tx.doc(WorkDecisionState, binding.nativeId);
              if (
                doc.pending?.requestId === requestId &&
                doc.pending.submissionId === null &&
                !doc.pending.admissionId
              ) {
                doc.pending = null;
              }
            }, context);
            return { done: true, deferred: true };
          }
        }
        return { done: false };
      }, key, AUTO_ERRORS, botId);
      if (outcome?.done) return outcome;
      await waitForRoomSignal(250);
    }
    return { done: true };
  }

  async function runRoomScope(scopeId) {
    while (active && !closing && !fatalError) {
      if (!existsSync(join(host.dataRoot, 'messages.sqlite'))) return;
      const scope = getLog().getScope(scopeId);
      if (!scope || scope.kind !== 'room') return;
      if (scope.deletedAt !== undefined) {
        await stopScopeWork(scopeId).catch(() => {});
        return;
      }

      // 1. Drain failure notices and reconcile/await any persisted in-flight pending turns
      //    one-by-one before starting a new round-robin pass (concurrency = 1 per room).
      const candidateBotIds = new Set();
      for (const m of scope.members ?? []) {
        if (m.deviceId === host.deviceId && host.getBot(m.botId)) {
          candidateBotIds.add(m.botId);
        }
      }
      const index = await getHarness().snapshot(WorkIndex, context);
      for (const key of Object.keys(index?.byKey ?? {})) {
        let pair = null;
        try { pair = JSON.parse(key); } catch { pair = null; }
        if (Array.isArray(pair) && pair.length === 2 && pair[1] === scopeId && host.getBot(pair[0])) {
          candidateBotIds.add(pair[0]);
        }
      }
      if (candidateBotIds.size === 0) return;

      for (const botId of candidateBotIds) {
        if (!active || closing || fatalError) return;
        const key = JSON.stringify([botId, scopeId]);
        const activePendingId = await admit(async () => {
          let resolved;
          try {
            resolved = await getWorkContexts().resolveWorkContext(botId, scopeId);
          } catch (error) {
            if (error?.code === 'SCOPE_DELETED') {
              await stopScopeWork(scopeId).catch(() => {});
              return null;
            }
            if (error?.code === 'SCOPE_FORBIDDEN' || error?.code === 'BOT_NOT_FOUND') return null;
            throw error;
          }
          const { bot, binding } = resolved;
          if (!binding) return null;
          const harness = getHarness();
          const meta = await harness.snapshot(WorkContextState, binding.nativeId, context);
          await fenceLegacyError(binding, meta);
          await drainFailureNotices(botId, binding);
          await reconcile(binding, bot);
          const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
          return state?.pending?.requestId ?? null;
        }, key, AUTO_ERRORS, botId);
        if (activePendingId !== null) {
          await waitForRoomMemberPending(botId, scopeId, activePendingId);
        }
      }
      if (!active || closing || fatalError) return;

      // 2. Sync unread room pages for current local members, settle passive/unmentioned
      //    batches without model calls, and identify eligible candidates for orchestration.
      const freshScope = getLog().getScope(scopeId);
      if (!freshScope || freshScope.kind !== 'room') return;
      if (freshScope.deletedAt !== undefined) {
        await stopScopeWork(scopeId).catch(() => {});
        return;
      }
      await warmBotDirectoryIfNeeded(freshScope);
      const scopeMembers = freshScope.members ?? [];
      const scopeMembersByBotId = new Map(scopeMembers.map((m) => [m.botId, m.deviceId]));
      const groupMembers = scopeMembers.map((m) => {
        const info = resolveBotMeta(m.deviceId, m.botId);
        return {
          id: memberKey(m.deviceId, m.botId),
          deviceId: m.deviceId,
          botId: m.botId,
          name: info.name || m.botId,
          description: info.description || '',
        };
      });

      let settledPassiveWithMore = false;
      const eligibleCandidates = [];
      for (const m of scopeMembers) {
        if (!active || closing || fatalError) return;
        if (m.deviceId !== host.deviceId || !host.getBot(m.botId)) continue;
        const botId = m.botId;
        const key = JSON.stringify([botId, scopeId]);
        const inspection = await admit(async () => {
          let resolved;
          try {
            resolved = await getWorkContexts().resolveWorkContext(botId, scopeId);
          } catch (error) {
            if (error?.code === 'SCOPE_DELETED') {
              await stopScopeWork(scopeId).catch(() => {});
              return null;
            }
            if (error?.code === 'SCOPE_FORBIDDEN' || error?.code === 'BOT_NOT_FOUND') return null;
            throw error;
          }
          if (!resolved.binding && !inboxAfter(botId, scopeId, 0, 1).items.length) return null;
          let imported;
          do {
            imported = await getWorkContexts().syncWorkContext(botId, scopeId, { limit: 200 });
          } while (imported.hasMore && active && !closing && !fatalError);
          let second;
          try {
            second = await getWorkContexts().resolveWorkContext(botId, scopeId);
          } catch (error) {
            if (error?.code === 'SCOPE_DELETED') {
              await stopScopeWork(scopeId).catch(() => {});
              return null;
            }
            if (error?.code === 'SCOPE_FORBIDDEN' || error?.code === 'BOT_NOT_FOUND') return null;
            throw error;
          }
          const { binding } = second;
          if (!binding || closing || fatalError) return null;
          const harness = getHarness();
          const metaSnap = await harness.snapshot(WorkContextState, binding.nativeId, context);
          await fenceLegacyError(binding, metaSnap);
          await drainFailureNotices(botId, binding);
          return harness.commit(async (tx) => {
            const meta = await tx.doc(WorkContextState, binding.nativeId);
            const state = await tx.doc(WorkDecisionState, binding.nativeId);
            if (closing || fatalError || state.pending || state.stopped || state.error || !currentMember(meta)) {
              return null;
            }
            const page = inboxAfter(meta.botId, meta.scopeId, state.handledLocalId);
            const items = page.items.filter((item) => item.localId <= meta.lastImportedLocalId);
            if (!items.length) return null;
            const { trigger, batchThrough } = collectTrigger(meta, items, null);
            const hasMoreAfterBatch = Boolean(page.nextCursor) || items.some((it) => it.localId > batchThrough);
            if (!trigger) {
              if (batchThrough > 0) state.handledLocalId = Math.max(state.handledLocalId, batchThrough);
              return { eligible: false, settledPassive: batchThrough > 0, hasMoreAfterBatch };
            }
            if ((state.preemptedAttempts ?? 0) >= GROUP_MAX_REDRIVE_ATTEMPTS) {
              state.preemptedAttempts = 0;
              state.handledLocalId = Math.max(state.handledLocalId, batchThrough);
              return { eligible: false, settledPassive: true, hasMoreAfterBatch };
            }
            const selfMemberId = memberKey(host.deviceId, meta.botId);
            const recentStored = readRoomPublicStored(meta.scopeId, batchThrough);
            const recentHistory = recentStored.map((it) => toGroupMessage(it, scopeMembersByBotId));
            const unreadMessages = items
              .filter((it) => it.localId <= batchThrough && !it.selfEcho && it.message?.category === 'public')
              .map((it) => toGroupMessage(it, scopeMembersByBotId));
            const eligibility = evaluateGroupTurnEligibility({
              memberId: selfMemberId,
              members: groupMembers,
              recentHistory,
              unreadMessages,
            });
            if (!eligibility.eligible) {
              state.preemptedAttempts = 0;
              state.handledLocalId = Math.max(state.handledLocalId, batchThrough);
              return { eligible: false, settledPassive: true, hasMoreAfterBatch };
            }
            return {
              eligible: true,
              botId,
              memberId: selfMemberId,
              batchThrough,
              hasMoreAfterBatch,
            };
          }, context);
        }, key, AUTO_ERRORS, botId);
        if (!inspection) continue;
        if (inspection.eligible) {
          eligibleCandidates.push(inspection);
        } else if (inspection.settledPassive && inspection.hasMoreAfterBatch) {
          settledPassiveWithMore = true;
        }
      }

      if (eligibleCandidates.length === 0) {
        if (settledPassiveWithMore) continue;
        return;
      }

      if (unified && turnGate.canRunWork) {
        let anyCanRun = false;
        for (const cand of eligibleCandidates) {
          if (await turnGate.canRunWork(cand.botId)) {
            anyCanRun = true;
            break;
          }
        }
        if (!anyCanRun) return;
      }

      // 3. Run sequential round-robin GroupChatOrchestrator under a room turn epoch.
      const catchingUpBacklog = eligibleCandidates.some((c) => c.hasMoreAfterBatch);
      const windowCeiling = catchingUpBacklog
        ? Math.min(...eligibleCandidates.map((c) => c.batchThrough))
        : null;

      const epoch = roomScheduler.nextTurnEpoch(scopeId);
      const baselineLocalId = latestRoomPublicLocalId(scopeId);
      const publishedIds = new Set();
      let settledThroughLocalId = windowCeiling !== null ? windowCeiling : baselineLocalId;
      activeRoomEpochs.set(scopeId, { epoch, baselineLocalId, publishedIds, windowCeiling });

      const initialHistoryStored = readRoomPublicStored(scopeId, windowCeiling);
      const initialHistory = initialHistoryStored.map((it) => toGroupMessage(it, scopeMembersByBotId));
      let lastUserIdx = -1;
      for (let i = initialHistory.length - 1; i >= 0; i -= 1) {
        if (initialHistory[i]?.speaker?.kind === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      const afterUser = lastUserIdx >= 0 ? initialHistory.slice(lastUserIdx + 1) : initialHistory;
      let initialTotalMessages = 0;
      for (const msg of afterUser) {
        if (msg?.speaker?.kind === 'member' && !isHostFailureReceiptText(msg.content)) {
          initialTotalMessages += 1;
        }
      }

      const isCurrent = () => {
        if (!active || closing || fatalError) return false;
        if (windowCeiling === null && roomScheduler.currentTurnEpoch(scopeId) === epoch) {
          if (hasExternalPublicSince(scopeId, baselineLocalId, publishedIds)) {
            roomScheduler.nextTurnEpoch(scopeId);
            return false;
          }
        }
        return roomScheduler.currentTurnEpoch(scopeId) === epoch;
      };

      const deferredBots = new Set();
      try {
        const orchestrator = new GroupChatOrchestrator({
          resolveMembers: async () => groupMembers,
          readHistory: () =>
            readRoomPublicStored(scopeId, windowCeiling).map((it) => toGroupMessage(it, scopeMembersByBotId)),
          isCurrent,
          runMemberTurn: async ({ member: groupMember }) => {
            if (groupMember.deviceId !== host.deviceId) return [];
            if (!isCurrent()) return [];
            const botId = groupMember.botId;
            if (!host.getBot(botId)) return [];
            const beforeMaxLocalId = latestRoomPublicLocalId(scopeId);
            const key = JSON.stringify([botId, scopeId]);
            const startRes = await admit(async () => {
              let resolved;
              try {
                resolved = await getWorkContexts().resolveWorkContext(botId, scopeId);
              } catch (error) {
                if (error?.code === 'SCOPE_DELETED') {
                  await stopScopeWork(scopeId).catch(() => {});
                  return { started: false };
                }
                if (error?.code === 'SCOPE_FORBIDDEN' || error?.code === 'BOT_NOT_FOUND') {
                  return { started: false };
                }
                throw error;
              }
              const { binding } = resolved;
              if (!binding && !inboxAfter(botId, scopeId, 0, 1).items.length) {
                return { started: false };
              }
              if (windowCeiling === null) {
                let imported;
                do {
                  imported = await getWorkContexts().syncWorkContext(botId, scopeId, { limit: 200 });
                } while (imported.hasMore && active && !closing && !fatalError);
              }
              let second;
              try {
                second = await getWorkContexts().resolveWorkContext(botId, scopeId);
              } catch (error) {
                if (error?.code === 'BOT_NOT_FOUND' || error?.code === 'SCOPE_FORBIDDEN') {
                  return { started: false };
                }
                if (error?.code === 'SCOPE_DELETED') {
                  await stopScopeWork(scopeId).catch(() => {});
                  return { started: false };
                }
                throw error;
              }
              if (!second.binding || closing || fatalError) return { started: false };
              const meta = await getHarness().snapshot(WorkContextState, second.binding.nativeId, context);
              await fenceLegacyError(second.binding, meta);
              await drainFailureNotices(botId, second.binding);
              await reconcile(second.binding, second.bot);
              if (closing || fatalError) return { started: false };
              let res = await startDecision(second.binding, second.bot, { maxLocalId: windowCeiling });
              if (res?.needsResync && windowCeiling === null) {
                let imported;
                do {
                  imported = await getWorkContexts().syncWorkContext(botId, scopeId, { limit: 200 });
                } while (imported.hasMore && active && !closing && !fatalError);
                res = await startDecision(second.binding, second.bot, { maxLocalId: windowCeiling });
              }
              return res;
            }, key, AUTO_ERRORS, botId);

            if (startRes?.deferred) {
              deferredBots.add(botId);
              return [];
            }
            if (startRes?.started && startRes.requestId) {
              const waitRes = await waitForRoomMemberPending(botId, scopeId, startRes.requestId);
              if (waitRes?.deferred || waitRes?.preempted) {
                deferredBots.add(botId);
                return [];
              }
            } else {
              return [];
            }

            const recentAfter = readRoomPublicStored(scopeId, null);
            const sent = [];
            for (const item of recentAfter) {
              if (item.localId <= beforeMaxLocalId) continue;
              const msg = item.message;
              if (msg?.category !== 'public') continue;
              if (msg.sourceDeviceId !== host.deviceId) continue;
              if (msg.author?.kind !== 'bot' || msg.author?.botId !== botId) continue;
              if (isHostFailureReceiptText(msg.text)) continue;
              publishedIds.add(msg.messageId);
              if (
                windowCeiling === null &&
                !hasExternalPublicSince(scopeId, baselineLocalId, publishedIds)
              ) {
                settledThroughLocalId = Math.max(settledThroughLocalId, item.localId);
              }
              if (typeof msg.text === 'string' && msg.text.trim()) {
                sent.push(msg.text);
              }
            }
            return sent;
          },
        });

        await orchestrator.run({
          group: { name: freshScope.title ?? '', description: '' },
          memberIds: groupMembers.map((m) => m.id),
          pendingResponderIds: eligibleCandidates.map((c) => c.memberId),
          initialTotalMessages,
        });
      } finally {
        if (activeRoomEpochs.get(scopeId)?.epoch === epoch) {
          activeRoomEpochs.delete(scopeId);
        }
      }

      const completedCurrentEpoch = isCurrent();
      if (completedCurrentEpoch && settledThroughLocalId > 0) {
        for (const m of scopeMembers) {
          if (!active || closing || fatalError) return;
          if (m.deviceId !== host.deviceId || !host.getBot(m.botId)) continue;
          if (deferredBots.has(m.botId)) continue;
          const botId = m.botId;
          const key = JSON.stringify([botId, scopeId]);
          await admit(async () => {
            let resolved;
            try {
              resolved = await getWorkContexts().resolveWorkContext(botId, scopeId);
            } catch (error) {
              if (
                error?.code === 'SCOPE_DELETED' ||
                error?.code === 'SCOPE_FORBIDDEN' ||
                error?.code === 'BOT_NOT_FOUND'
              ) {
                return;
              }
              throw error;
            }
            if (!resolved.binding) return;
            if (windowCeiling === null) {
              let imported;
              do {
                imported = await getWorkContexts().syncWorkContext(botId, scopeId, { limit: 200 });
              } while (imported.hasMore && active && !closing && !fatalError);
            }
            const harness = getHarness();
            await harness.commit(async (tx) => {
              const meta = await tx.doc(WorkContextState, resolved.binding.nativeId);
              const state = await tx.doc(WorkDecisionState, resolved.binding.nativeId);
              if (
                closing ||
                fatalError ||
                state.pending ||
                state.stopped ||
                state.error ||
                (state.preemptedAttempts ?? 0) > 0 ||
                !currentMember(meta)
              ) {
                return;
              }
              const target = Math.min(settledThroughLocalId, meta.lastImportedLocalId);
              if (target > state.handledLocalId) {
                state.handledLocalId = target;
              }
            }, context);
          }, key, AUTO_ERRORS, botId);
        }
      }

      if (!completedCurrentEpoch || catchingUpBacklog) {
        continue;
      }
      return;
    }
  }

  function scheduleRoomScope(scopeId) {
    if (!active || closing || fatalError) return;
    if (scheduledRooms.has(scopeId)) {
      roomRescanNeeded.add(scopeId);
      bumpActiveRoomEpochsOnExternal();
      return;
    }
    scheduledRooms.add(scopeId);
    const task = roomScheduler.enqueueExclusive(scopeId, () =>
      guarded(async () => {
        try {
          do {
            roomRescanNeeded.delete(scopeId);
            await runRoomScope(scopeId);
          } while (roomRescanNeeded.delete(scopeId) && active && !closing && !fatalError);
        } finally {
          scheduledRooms.delete(scopeId);
        }
      }, AUTO_ERRORS),
    );
    inflight.add(task);
    const release = () => {
      inflight.delete(task);
    };
    task.then(release, release);
  }

  async function poll() {
    if (!active || closing || !existsSync(join(host.dataRoot, 'messages.sqlite'))) return;
    const pairs = new Map();
    const activeRoomIds = new Set();
    for (const scope of getLog().listScopes()) {
      if (scope.kind === 'room' && scope.deletedAt === undefined) {
        activeRoomIds.add(scope.scopeId);
      }
      for (const item of scope.members) {
        if (item.deviceId === host.deviceId) pairs.set(JSON.stringify([item.botId, scope.scopeId]), [item.botId, scope.scopeId]);
      }
    }
    const index = await getHarness().snapshot(WorkIndex, context);
    for (const key of Object.keys(index?.byKey ?? {})) {
      const pair = JSON.parse(key);
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((id) => typeof id !== 'string')) {
        throw new Error('invalid work binding key');
      }
      pairs.set(key, pair);
    }
    const roomScopesToSchedule = new Set();
    const tasks = [];
    for (const [key, [botId, scopeId]] of pairs) {
      if (!active || closing) break;
      // 跳过本机已删除的 Bot：旧 scope 成员与 WorkIndex 绑定保留为历史，
      // 不删除数据，但已不存在的 Bot 不调度工作（authorize 只会 BOT_NOT_FOUND）。
      if (!host.getBot(botId)) continue;
      if (activeRoomIds.has(scopeId)) {
        roomScopesToSchedule.add(scopeId);
        continue;
      }
      if (!lanes.has(key)) tasks.push(admit(() => advance(botId, scopeId), key, AUTO_ERRORS, botId));
    }
    for (const scopeId of roomScopesToSchedule) {
      if (!active || closing) break;
      scheduleRoomScope(scopeId);
    }
    await Promise.all(tasks);
  }

  function nudge() {
    if (!active || closing || fatalError) return;
    bumpActiveRoomEpochsOnExternal();
    if (pollPromise) {
      pollAgain = true;
      return;
    }
    pollPromise = admit(poll, undefined, AUTO_ERRORS);
    const clear = () => {
      pollPromise = null;
      if (pollAgain && active && !closing && !fatalError) {
        pollAgain = false;
        nudge();
      } else {
        pollAgain = false;
      }
    };
    pollPromise.then(clear, clear);
  }

  function resume() {
    assertOpen();
    if (active) return;
    active = true;
    if (!commitObservation) {
      try {
        const harness = getHarness();
        if (harness && typeof harness.observeCommits === 'function') {
          commitObservation = harness.observeCommits({
            advance(publication) {
              if (closing || !active) return;
              if (
                publication &&
                Array.isArray(publication.changes) &&
                publication.changes.some((c) => c?.type === 'submission')
              ) {
                queueMicrotask(wakeRoomWaiters);
              }
            },
            end() {
              commitObservation = null;
            },
          });
        }
      } catch {
        // Harness closing or unavailable in unit stub; fallback timer handles wakeups.
      }
    }
    timer = setInterval(nudge, 1000);
    timer.unref?.();
    nudge();
  }

  function checkWork(meta, state, matchesRequest) {
    // Accepted native tasks drain until harness.close; driver closing only gates new admissions.
    assertHealthy();
    if (state.stopped) throw messageError('WORK_STOPPED', 'work context is stopped');
    if (!state.pending) throw messageError('WORK_CONTEXT_INACTIVE', 'work context has no pending decision');
    if (!matchesRequest) throw messageError('STALE_INPUT', 'work request does not match the pending decision');
    if (state.pending.replan || state.pending.takeover) throw messageError('STALE_INPUT', 'work decision needs newer input');
    // 中断标记是持久取消终态：迟到 beforeRequest/budget 决不让已取消请求
    // 再进模型执行；结算由 reconcile/interrupt 路径完成。
    if (state.pending.interruption) throw messageError('WORK_STOPPED', 'work decision was interrupted');
    if (meta.deviceId !== host.deviceId) throw messageError('WORK_CONTEXT_INACTIVE', 'work context is not local');
    if (!currentMember(meta)) {
      // Commit this fence before throwing, so a quick rejoin cannot turn revoked work into a model failure.
      state.pending.replan = true;
      return { code: 'WORK_CONTEXT_INACTIVE', message: 'work context is not currently active' };
    }
    if (state.error) throw messageError(state.error.code, state.error.message);
    return null;
  }

  // 冻结轮 workNativeId -> 协调 nativeId；无 workNativeId 的 primary/host 轮返回 null
  //（工作钩子对其立即放行，不扫旧 work 触发条目）。
  function coordinationIdFor(turn) {
    const workNativeId = turn?.workNativeId;
    return typeof workNativeId === 'number' ? workNativeId : null;
  }

  async function workCoordinationId(api, toolContext) {
    if (unified) return coordinationIdFor(await sessions.getTurn(api, toolContext));
    const meta = await getHarness().snapshot(WorkContextState, api.conversationId, toolContext);
    return meta?.scopeId ? api.conversationId : null;
  }

  async function beforeRequest(_request, api, toolContext) {
    return guarded(async () => {
      const harness = getHarness();
      // 统一执行先取 sessions.getTurn：primary/host 非工作轮立即放行，
      // 绝不因主会话历史里残留的旧 work 触发条目拒绝新用户轮。
      const coordNativeId = await workCoordinationId(api, toolContext);
      if (coordNativeId === null) return;
      assertHealthy();
      toolContext.abortSignal?.throwIfAborted();
      const task = await harness.getTask(api.taskId, toolContext);
      const cutoff = task?.state?.checkpoint?.cutoff;
      if (!Number.isSafeInteger(cutoff)) throw new Error('work generation has no request cutoff');
      const conversation = await harness.conversation(api.conversationId, toolContext);
      if (!conversation) throw new Error('work conversation is missing');
      const view = await conversation.context(toolContext, { at: cutoff });
      const visible = new Set(view.messages);
      const snapshot = await harness.snapshot(WorkDecisionState, coordNativeId, toolContext);
      const pending = snapshot?.pending ?? null;
      const expectedRequestId = pending?.requestId ?? null;
      const batchThrough = pending?.startedThroughLocalId;
      // 冻结本轮触发：持久化 pending.requestId/turn 是权威身份，可见 host.work-trigger
      // 仅作交叉确认——SDK 自动压缩可能把触发条目裁出可见视图，持久化身份绝不能丢。
      const frozenTurn = pending?.turn ?? null;
      let requestId = null;
      let triggerScopeId = frozenTurn?.scopeId ?? null;
      for (const entry of view.entries) {
        if (entry.kind !== WORK_TRIGGER_KIND) continue;
        if (expectedRequestId !== null && entry.data?.requestId === expectedRequestId) {
          requestId = expectedRequestId;
          triggerScopeId = entry.data?.scopeId ?? entry.data?.turn?.scopeId ?? triggerScopeId;
        }
      }
      // 视图里没有匹配触发条目（压缩裁掉/尚未落视图）：持久化冻结 turn 的
      // requestId 与 pending.requestId 一致时仍按可信 durable 身份判定，绝不靠模型正文猜。
      if (requestId === null && expectedRequestId !== null &&
          frozenTurn?.requestId === expectedRequestId) {
        requestId = expectedRequestId;
      }
      // 来源水位以持久化边界为权威，不依赖源消息仍留在可见视图：
      //   prepared.throughLocalId（重试沿用上次已算水位）
      //   > 可见 scope-message 贡献（本批、同 scope、≤ batchThrough）
      //   > startedThroughLocalId（本批已消费边界下限，压缩裁掉源消息时兜底）。
      // compaction 若保留 work-trigger 但裁掉其前源消息，仍按 startedThroughLocalId
      // 结算，绝不把已决策批次当未消费重放；新到消息永不计入本批水位。
      const preparedThrough = Number.isSafeInteger(pending?.prepared?.throughLocalId)
        ? pending.prepared.throughLocalId : 0;
      let throughLocalId = 0;
      if (requestId !== null) {
        for (let i = 0; i < view.entries.length; i++) {
          const entry = view.entries[i];
          if (entry.kind !== SCOPE_MESSAGE_KIND) continue;
          if (!(view.contributions[i] ?? []).some((message) => visible.has(message))) continue;
          if (triggerScopeId !== null && entry.data?.message?.scopeId !== triggerScopeId) continue;
          const localId = entry.data?.localId;
          if (!Number.isSafeInteger(localId) || localId < 0) throw new Error('invalid work source watermark');
          if (Number.isSafeInteger(batchThrough) && localId > batchThrough) continue;
          throughLocalId = Math.max(throughLocalId, localId);
        }
      }
      throughLocalId = Math.max(
        preparedThrough,
        throughLocalId,
        requestId !== null && Number.isSafeInteger(batchThrough) ? batchThrough : 0);
      const inactive = await harness.commit(async (tx) => {
        const current = await tx.doc(WorkContextState, coordNativeId);
        const state = await tx.doc(WorkDecisionState, coordNativeId);
        toolContext.abortSignal?.throwIfAborted();
        const error = checkWork(current, state, state.pending?.requestId === requestId);
        if (error) return error;
        // Native retries may re-prepare the same task with a new cutoff; capture the actual view each time.
        // cutoff 一并持久化：重试换 cutoff 时以最新为准，不丢失执行边界。
        state.pending.prepared = { taskId: String(api.taskId), cutoff, throughLocalId };
        return null;
      }, toolContext);
      if (inactive) throw messageError(inactive.code, inactive.message);
    }, WORK_ERRORS, toolContext);
  }

  async function checkBudget(_request, api, toolContext) {
    return guarded(async () => {
      const harness = getHarness();
      const coordNativeId = await workCoordinationId(api, toolContext);
      if (coordNativeId === null) return;
      const error = await harness.commit(async (tx) => {
        const current = await tx.doc(WorkContextState, coordNativeId);
        const state = await tx.doc(WorkDecisionState, coordNativeId);
        const prepared = (await tx.doc(RequestContext, api.conversationId)).prepared;
        toolContext.abortSignal?.throwIfAborted();
        const inactive = checkWork(current, state, state.pending?.prepared?.taskId === String(api.taskId));
        if (inactive) return inactive;
        // The manager can reuse the same task's projection when only non-contributing entries advance the cutoff.
        if (!prepared || prepared.taskId !== String(api.taskId)) {
          throw new Error('work context projection does not match the prepared request');
        }
        if (prepared.tokenCount >= prepared.contextWindow) {
          const failure = { code: 'CONTEXT_LIMIT', message: 'work context projection reaches the model context window' };
          // 请求级预算失败：只结算本 pending，不落 scope 级 error 闸门
          // （error 闸门会无限阻断后续新请求；reconcile 走 lastError/结算路径）。
          settleFailedDecision(state, current, failure);
          return failure;
        }
        return null;
      }, toolContext);
      if (error) throw messageError(error.code, error.message);
    }, WORK_ERRORS, toolContext);
  }

  /**
   * publishWork(publication, api, toolContext, turn)：协调账本发布的决策侧守卫。
   * turn 由调用方（communication lane）经 sessions.getTurn 取得；协调文档按冻结轮
   * workNativeId 解析（legacy 无冻结轮回退会话自身）。来源成员撤销检查恒在
   * 发起 scope（协调 scope）；DM 轮不用“更新入站消息”新鲜度 guard（后到消息
   * 排队给后续轮），room 沿用 scopeId/afterLocalId guard。显式 request/notice
   * 可发往其它已授权 scope，默认 response 发布走冻结 replyTarget——目标成员/
   * 作者校验由账本完成，不全局中止无关共享轮。
   */
  async function publishWork(publication, api, toolContext, turn = null) {
    return guarded(async () => {
      assertHealthy();
      let suppressedByTurnCap = false;
      const result = await api.commit(async (tx) => {
        const coordNativeId = coordinationIdFor(turn) ?? api.conversationId;
        const meta = await tx.doc(WorkContextState, coordNativeId);
        const state = await tx.doc(WorkDecisionState, coordNativeId);
        assertHealthy();
        toolContext.abortSignal?.throwIfAborted();
        if (!meta.scopeId || meta.deviceId !== host.deviceId || publication.author?.kind !== 'bot' || publication.author.botId !== meta.botId) {
          throw messageError('BOT_CONTEXT_REQUIRED', 'publication requires the actual local work bot');
        }
        const expectedScopeId = turn?.replyTarget?.scopeId ?? meta.scopeId;
        const isSameRoomTarget = meta.kind === 'room' && publication.scopeId === expectedScopeId;
        const log = getLog();
        if (log.getMessage(publication.messageId)) {
          const stored = log.publish(publication);
          if (state.pending && publication.scopeId === expectedScopeId) state.pending.published = true;
          if (isSameRoomTarget) {
            activeRoomEpochs.get(meta.scopeId)?.publishedIds.add(publication.messageId);
          }
          return stored;
        }
        if (state.stopped) throw messageError('WORK_STOPPED', 'work context is stopped');
        if (!state.pending?.prepared || state.error) throw messageError('WORK_CONTEXT_INACTIVE', 'work context has no prepared decision');
        if (state.pending.replan || state.pending.takeover) throw messageError('STALE_INPUT', 'work decision needs newer input');
        // 已中断 pending 不得再发布：已发布消息由 getMessage 幂等路径先行处理，
        // 新稿件在中断后一律拒绝（取消确认前不允许另一轮争用 Bot 资源）。
        if (state.pending.interruption) throw messageError('WORK_STOPPED', 'work decision was interrupted');
        if (isSameRoomTarget && (state.pending.publishedCount ?? 0) >= GROUP_MAX_MESSAGES_PER_TURN) {
          suppressedByTurnCap = true;
          return { suppressedByTurnCap: true };
        }
        // 来源成员撤销对所有 scope 生效；群聊并发度由 RoomTurnScheduler 串行锁 (=1)
        // 与 turnEpochs 控制，新到群消息推进 epoch 在发言人边界切换轮次，不半途以
        // STALE_INPUT 打断正在发言的成员。注意：不在工具执行中途同步调 nudge()/poll()，
        // 避免在模型 toolCall -> toolResult 之间向统一主会话导入新消息干扰当前轮。
        try {
          if (!currentMember(meta)) {
            throw messageError('SCOPE_FORBIDDEN', 'publisher bot must be a current member of the origin scope');
          }
          const stored = log.publish(publication);
          if (publication.scopeId === expectedScopeId) {
            state.pending.published = true;
            state.pending.publishedCount = (state.pending.publishedCount ?? 0) + 1;
          }
          if (isSameRoomTarget) {
            activeRoomEpochs.get(meta.scopeId)?.publishedIds.add(publication.messageId);
          } else if (activeRoomEpochs.has(publication.scopeId)) {
            bumpActiveRoomEpochsOnExternal();
          }
          return stored;
        } catch (error) {
          if (error?.code !== 'STALE_INPUT' && !(error?.code === 'SCOPE_FORBIDDEN' && !currentMember(meta))) throw error;
          state.pending.replan = true;
          return { failure: error };
        }
      }, toolContext);
      // Throwing inside commit would roll back replan and permit another provider call on the stale request.
      if (result.failure) throw result.failure;
      if (suppressedByTurnCap) return { suppressedByTurnCap: true };
      return result;
    }, PUBLICATION_ERRORS, toolContext);
  }

  async function passWork(api, toolContext, turn = null, options = null) {
    return guarded(async () => {
      assertHealthy();
      const result = await api.commit(async (tx) => {
        const coordNativeId = coordinationIdFor(turn) ?? api.conversationId;
        const meta = await tx.doc(WorkContextState, coordNativeId);
        const state = await tx.doc(WorkDecisionState, coordNativeId);
        assertHealthy();
        toolContext.abortSignal?.throwIfAborted();
        if (!meta.scopeId || meta.deviceId !== host.deviceId) {
          throw messageError('BOT_CONTEXT_REQUIRED', 'silent pass requires a local work bot');
        }
        if (state.stopped) throw messageError('WORK_STOPPED', 'work context is stopped');
        if (!state.pending?.prepared || state.error) throw messageError('WORK_CONTEXT_INACTIVE', 'work context has no prepared decision');
        if (state.pending.replan || state.pending.takeover) throw messageError('STALE_INPUT', 'work decision needs newer input');
        if (state.pending.interruption) throw messageError('WORK_STOPPED', 'work decision was interrupted');
        if (!currentMember(meta)) {
          state.pending.replan = true;
          return { failure: messageError('SCOPE_FORBIDDEN', 'publisher bot must be a current member of the origin scope') };
        }
        const expectedScopeId = turn?.replyTarget?.scopeId ?? meta.scopeId;
        if (!options?.scopeId || options.scopeId === expectedScopeId) {
          state.pending.passed = true;
        }
        return null;
      }, toolContext);
      if (result?.failure) throw result.failure;
    }, PUBLICATION_ERRORS, toolContext);
  }

  function close() {
    if (!closePromise) {
      closing = true;
      active = false;
      pollAgain = false;
      clearInterval(timer);
      timer = null;
      try { commitObservation?.detach(); } catch { /* ignore */ }
      commitObservation = null;
      roomScheduler.dispose();
      wakeRoomWaiters();
      closePromise = (async () => {
        await Promise.allSettled([...inflight, roomScheduler.drainAll()]);
        assertHealthy();
      })();
    }
    return closePromise;
  }

  // sessions.getTurn 由 runtime wiring 装配；本 lane 暴露选择器让 wiring 不必
  // 重复会话->协调映射，也不把协调 ID 猜成会话 ID。
  async function coordinationSelector(api, toolContext) {
    if (!unified) return null;
    return coordinationIdFor(await sessions.getTurn(api, toolContext));
  }

  return { resume, close, nudge, beforeRequest, checkBudget, publishWork, passWork, getWorkActivity, stopWork, resumeWork, stopScopeWork, takeoverShower,
    interruptBotWork, setActivityListener, refreshActivity,
    coordinationSelector,
    drainFailureNotices,
    setLearningHooks: (hooks) => {
      learningHooks = hooks ?? null;
    },
    setTurnGate: (fn, onIdle, canRunWork = null) => {
      turnGate.fn = fn;
      turnGate.idle = onIdle ?? null;
      turnGate.canRunWork = canRunWork ?? null;
    } };
}
