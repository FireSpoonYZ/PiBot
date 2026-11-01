import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentDoc, configure, ConversationBusy, SessionFailed } from '@earendil-works/pi-durable';
import { assertId, messageError } from './message-protocol.js';
import { inboxQueryKey } from './message-queries.js';
import { WorkIndex, WorkContextState, ensureWorkBinding, toWorkContextRecord } from './work-context-docs.js';
import { WorkDecisionState, initialDecisionState, toWorkActivity, toFrozenTurn } from './work-decision-state.js';
import { createWorkInput } from './work-decision-codec.js';
import { RequestContext } from './request-context.js';
import { parseModelRef } from './runtime-models.js';

const CONTROL_ERRORS = new Set(['INVALID_ARGUMENT', 'BOT_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'WORK_CONTEXT_INACTIVE', 'NOT_CONNECTED']);
// NOT_CONNECTED 来自 Bot 准入队列关闭（runtime 已在关闭）：只拒绝新准入，不升级为 fatal。
const AUTO_ERRORS = new Set(['WORK_CONTEXT_INACTIVE', 'NOT_CONNECTED', 'BOT_NOT_FOUND']);
const WORK_ERRORS = new Set(['WORK_STOPPED', 'WORK_CONTEXT_INACTIVE', 'STALE_INPUT', 'MODEL_REQUIRED', 'MODEL_NOT_FOUND', 'CONTEXT_LIMIT', 'WORK_GENERATION_FAILED']);
const PUBLICATION_ERRORS = new Set([...WORK_ERRORS, 'INVALID_ARGUMENT', 'BOT_CONTEXT_REQUIRED', 'BOT_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'MESSAGE_NOT_FOUND', 'REQUEST_CONFLICT']);
const SCOPE_MESSAGE_KIND = 'host.scope-message';
const WORK_TRIGGER_KIND = 'host.work-trigger';

function finishDecision(state, outcome) {
  const pending = state.pending;
  if (!pending) return;
  state.lastDecision = {
    requestId: pending.requestId,
    outcome,
    throughLocalId: pending.takeover?.throughLocalId ?? pending.prepared?.throughLocalId ?? null,
    completedAt: new Date().toISOString(),
  };
  state.pending = null;
}

function finishTakeover(state) {
  const takeover = state.pending?.takeover;
  if (!takeover || takeover.requestId !== state.pending.requestId) return;
  state.handledLocalId = Math.max(state.handledLocalId, takeover.throughLocalId);
  finishDecision(state, 'aborted');
}

function generationError(reason) {
  // Native detail can contain provider responses or credentials; only retain its small reason code.
  const safeReason = typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'unanswered';
  return { code: 'WORK_GENERATION_FAILED', message: 'work generation failed: ' + safeReason };
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
export function createWorkDecisionRuntime({ host, getHarness, getWorkContexts, models, defaultModel, context, getProfile, admitBot, admitTurn, sessions }) {
  // 无 sessions（旧线/独立测试装配）保持原行为：协调会话即执行会话，无统一轮归属。
  const unified = sessions != null;
  // 共用准入门、空闲回调与工作闸由 runtime 装配后注入（turn gate 需要在 harness/live 就位后创建）。
  // canRunWork 只读检查（排队用户优先 + 本 Bot 全部原生活动含遗留 work），不取第二条 Bot 准入通道。
  const turnGate = { fn: admitTurn ?? null, idle: null, canRunWork: null };
  let active = false;
  let closing = false;
  let timer = null;
  let pollPromise = null;
  let closePromise = null;
  let fatalError = null;
  const inflight = new Set();
  const lanes = new Map();
  const getLog = () => getWorkContexts().getMessageLog();
  const member = (scope, botId) => scope?.members.some((item) => item.deviceId === host.deviceId && item.botId === botId) === true;
  const currentMember = (meta) => member(getLog().getScope(meta.scopeId), meta.botId);

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
    const release = () => {
      inflight.delete(task);
      if (key !== undefined && lanes.get(key) === task) lanes.delete(key);
    };
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
  async function abortRequestFamily(executionId, requestId, preparedTaskId, submissionId) {
    const harness = getHarness();
    if (submissionId) {
      await harness.abortSubmission(submissionId, context, executionId).catch(() => {});
    }
    // 提交在飞/未登记 submissionId：requestId 是提交唯一标识，精准命中该 submission。
    const record = await harness.commit((tx) => tx.submissionByRequest(executionId, requestId), context);
    if (record && (record.status === 'queued' || record.status === 'placed')) {
      await harness.abortSubmission(record.id, context, executionId).catch(() => {});
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
      for (const id of targets) await harness.abortTask(id, context).catch(() => {});
      for (const id of targets) await harness.waitForTask(id, context).catch(() => {});
    }
  }

  async function abortPending(binding) {
    const harness = getHarness();
    const state = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    const executionId = executionTargetOf(state, binding);
    if (unified) {
      // 统一执行：只中止本请求的任务族/submission，绝不 Conversation.abort 整主会话。
      // 同时覆盖协调会话：带 turn 但无 executionNativeId 的 pending（含轮 0 迁移期
      // 记录在案的错误提交）原执行目标是协调会话，按同一 requestId 精准中止。
      if (state?.pending) {
        const ids = new Set([executionId, binding.nativeId]);
        for (const id of ids) {
          await abortRequestFamily(id, state.pending.requestId, state.pending.prepared?.taskId, state.pending.submissionId);
        }
      }
    } else {
      const conversation = await conversationFor({ nativeId: executionId });
      // abort() marks cancellation and waits for ordinary work quiescence, never for a natural model answer.
      await conversation.abort(context);
    }
    await harness.commit(async (tx) => {
      const doc = await tx.doc(WorkDecisionState, binding.nativeId);
      if (doc.pending?.takeover) finishTakeover(doc);
      else finishDecision(doc, 'aborted');
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
        if (!pending || state.stopped || state.error) continue;
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
          if (state.pending?.requestId !== candidate.requestId || state.stopped || state.error || state.pending.takeover) continue;
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
      await abortPending(binding);
      return activity(botId, scopeId);
    }, JSON.stringify([botId, scopeId]), CONTROL_ERRORS, botId);
    // 取消已把该 scope pending 结算并释放 Bot 准入：按 reconcile 相同方式唤醒
    // Host 用户排队泵（用户轮优先 gate 在泵内自身检查），否则 queued user 要等
    // 下一次外部驱动才被拾取。
    try { turnGate.idle?.(botId); } catch { /* 通知失败不影响 Stop 结果 */ }
    return result;
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
    nudge();
    return result;
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
      state.error = error;
      finishDecision(state, 'failed');
      return false;
    }
    if (!agent.model) {
      await configure(tx, nativeId, { model: ref });
    }
    return true;
  }

  /**
   * 统一模式的安全边界导入：canRunWork 判定本 Bot 空闲（无排队用户轮/无原生活动）后，
   * sessions.sync 在 commit 外把该 Bot 全部收件 scope 增量导入主会话一次；
   * 只为已冻结统一 turn 而缺执行目标的 pending 回填真实主会话 ID——无 turn 的
   * 旧 pending 保持原执行目标到结算/取消，绝不转换。
   */
  async function syncPrimaryImport(bot, binding) {
    if (!unified) return null;
    let result = null;
    try {
      result = await sessions.sync(bot.botId);
    } catch {
      // 主会话暂不可达（配置/模型未就绪等）：本轮放弃，下轮 poll 重试。
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
    const prepared = await harness.commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (closing || fatalError || state.stopped || state.error || !state.pending || state.pending.replan || state.pending.takeover || !currentMember(meta)) return null;
      // 统一 turn 而缺执行目标：等待下轮 syncPrimaryImport 回填，绝不在主会话/协调会话
      // 之间漂移执行目标。旧 pending（无 turn）用原协调会话到结算/取消。
      if (unified && state.pending.turn && typeof state.pending.executionNativeId !== 'number') return null;
      const executionId = state.pending.executionNativeId ?? binding.nativeId;
      if (!await selectModel(tx, executionId, meta, state, bot)) return null;
      const input = createWorkInput(toWorkContextRecord(meta), state.pending.requestId, state.pending.turn ?? null);
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
    try {
      submission = turnGate.fn
        ? await turnGate.fn(binding, bot, input)
        : await (await conversationFor({ nativeId: executionId })).submit(input, context);
    } catch (error) {
      if (error instanceof ConversationBusy) return;
      throw error;
    }
    if (!submission) return;
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
    if (snapshot.pending.takeover) {
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
    await harness.commit(async (tx) => {
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
        state.handledLocalId = Math.max(state.handledLocalId, pending.prepared.throughLocalId);
        finishDecision(state, pending.published ? 'published' : 'silent');
      } else {
        if (!state.error) {
          if (record.reason === 'no_model') {
            const agent = await tx.doc(AgentDoc, executionTargetOf(state, binding));
            state.error = agent.model
              ? { code: 'MODEL_NOT_FOUND', message: 'work model is not available' }
              : { code: 'MODEL_REQUIRED', message: 'work model is required' };
          } else state.error = generationError(record.status === 'done' ? 'missing_prepared' : record.reason);
        }
        finishDecision(state, 'failed');
      }
    }, context);
    // 决策落定为安全切换边界：唤醒该 Bot 的 Host 排队轮泵。
    try { turnGate.idle?.(bot.botId); } catch { /* 通知失败不影响结算 */ }
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

  async function startDecision(binding, bot) {
    // 统一执行：canRunWork 空闲边界后才做 sessions.sync（commit 外、Bot 准入内一次）；
    // 不通过表示排队用户轮/原生工作优先，下轮 poll 重试。scope/legacy 导入仍走
    // syncWorkContext（archive 历史），不推进主会话水位。
    let primary = null;
    if (unified) {
      if (turnGate.canRunWork && !(await turnGate.canRunWork(bot.botId))) return;
      primary = await syncPrimaryImport(bot, binding);
      if (primary === null || typeof primary.nativeId !== 'number') return;
    }
    // 迟到 DM 回复寻源在 commit 外做（replyOrigin 走 snapshot，绝不嵌进写事务）；
    // 只按当前未处理窗口查 replyTo 键。提交内重新导出的新回复若没预查过，
    // 按未知回复被动处理，下轮 poll 再判，绝不阻塞水位。
    const harness = getHarness();
    let replyOrigins = null;
    if (unified) {
      const metaSnap = await harness.snapshot(WorkContextState, binding.nativeId, context);
      const stateSnap = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
      if (metaSnap?.kind === 'dm' && !stateSnap?.pending && !stateSnap?.stopped && !stateSnap?.error) {
        replyOrigins = new Map();
        const items = inboxAfter(metaSnap.botId, metaSnap.scopeId, stateSnap?.handledLocalId ?? 0).items
          .filter((item) => item.localId <= metaSnap.lastImportedLocalId);
        for (const item of items) {
          const message = item.message ?? {};
          if (message.category === 'reply' && typeof message.replyTo === 'string' && !replyOrigins.has(message.replyTo)) {
            replyOrigins.set(message.replyTo, await sessions.replyOrigin(metaSnap.botId, message));
          }
        }
      }
    }
    const created = await harness.commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (closing || fatalError || state.pending || state.stopped || state.error || !currentMember(meta)) return false;
      // A receive after sync can add another page; do not start on a knowingly incomplete import.
      if (inboxAfter(meta.botId, meta.scopeId, meta.lastImportedLocalId, 1).items.length) return false;
      const items = inboxAfter(meta.botId, meta.scopeId, state.handledLocalId).items
        .filter((item) => item.localId <= meta.lastImportedLocalId);
      if (!items.length) return false;
      const { trigger, batchThrough } = collectTrigger(meta, items, replyOrigins);
      if (!trigger) {
        // 屏障前的被动条目已判定消费；屏障项与未判定的回复不越过。
        if (batchThrough > 0) state.handledLocalId = batchThrough;
        return false;
      }
      if (!await selectModel(tx, binding.nativeId, meta, state, bot)) return false;
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
      state.pending = {
        requestId,
        submissionId: null,
        startedAt: new Date().toISOString(),
        startedThroughLocalId: batchThrough,
        prepared: null,
        published: false,
        replan: false,
        // 统一执行：冻结 commit 外 sessions.sync 返回的真实主会话 nativeId/conversationId；
        // 绝不在 commit 内再调 Session 读或 tx.conversation 公共 ID 查询。
        executionNativeId: primary?.nativeId ?? null,
        executionConversationId: primary?.conversationId ?? null,
        turn,
        // 迟到回复恢复时记录原始请求 messageId（审计/寻源，入 turn 供 codec 标注）。
        ...(trigger.originRequestId !== undefined ? { originRequestId: trigger.originRequestId } : {}),
      };
      return true;
    }, context);
    // Persist the request identity before admission; crash recovery resubmits this exact request, not another turn.
    if (created && !closing && !fatalError) await submitPending(binding, bot);
  }

  async function advance(botId, scopeId) {
    if (!active || closing) return;
    let resolved;
    try { resolved = await getWorkContexts().resolveWorkContext(botId, scopeId); }
    catch (error) {
      // Membership can disappear between discovery and authorization of an as-yet unbound scope;
      // BOT_NOT_FOUND covers a Bot deleted between poll discovery and authorize.
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
    await reconcile(binding, bot);
    if (!imported.hasMore && !closing && !fatalError) await startDecision(binding, bot);
  }

  async function poll() {
    if (!active || closing || !existsSync(join(host.dataRoot, 'messages.sqlite'))) return;
    const pairs = new Map();
    for (const scope of getLog().listScopes()) {
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
    const tasks = [];
    for (const [key, [botId, scopeId]] of pairs) {
      if (!active || closing) break;
      // 跳过本机已删除的 Bot：旧 scope 成员与 WorkIndex 绑定保留为历史，
      // 不删除数据，但已不存在的 Bot 不调度工作（authorize 只会 BOT_NOT_FOUND）。
      if (!host.getBot(botId)) continue;
      if (!lanes.has(key)) tasks.push(admit(() => advance(botId, scopeId), key, AUTO_ERRORS, botId));
    }
    await Promise.all(tasks);
  }

  function nudge() {
    if (!active || closing || fatalError || pollPromise) return;
    pollPromise = admit(poll, undefined, AUTO_ERRORS);
    const clear = () => { pollPromise = null; };
    pollPromise.then(clear, clear);
  }

  function resume() {
    assertOpen();
    if (active) return;
    active = true;
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
      // 冻结本轮触发：按协调 pending.requestId 精确匹配本提交的 host.work-trigger，
      // 不是最新可见触发（compaction 可能已裁掉旧触发，pending.requestId 仍是要核对的身份）。
      let requestId = null;
      let triggerScopeId = null;
      for (const entry of view.entries) {
        if (entry.kind !== WORK_TRIGGER_KIND) continue;
        if (expectedRequestId !== null && entry.data?.requestId === expectedRequestId) {
          requestId = expectedRequestId;
          triggerScopeId = entry.data?.scopeId ?? entry.data?.turn?.scopeId ?? null;
        }
      }
      // 只统计本批次的 scope 来源水位：同一协调 scope、且不超过 pending
      // startedThroughLocalId（其它 scope/下一批次的同 scope 消息不计入）。
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
      const inactive = await harness.commit(async (tx) => {
        const current = await tx.doc(WorkContextState, coordNativeId);
        const state = await tx.doc(WorkDecisionState, coordNativeId);
        toolContext.abortSignal?.throwIfAborted();
        const error = checkWork(current, state, state.pending?.requestId === requestId);
        if (error) return error;
        // Native retries may re-prepare the same task with a new cutoff; capture the actual view each time.
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
          state.error = failure;
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
      const result = await api.commit(async (tx) => {
        const coordNativeId = coordinationIdFor(turn) ?? api.conversationId;
        const meta = await tx.doc(WorkContextState, coordNativeId);
        const state = await tx.doc(WorkDecisionState, coordNativeId);
        assertHealthy();
        toolContext.abortSignal?.throwIfAborted();
        if (!meta.scopeId || meta.deviceId !== host.deviceId || publication.author?.kind !== 'bot' || publication.author.botId !== meta.botId) {
          throw messageError('BOT_CONTEXT_REQUIRED', 'publication requires the actual local work bot');
        }
        const log = getLog();
        if (log.getMessage(publication.messageId)) {
          const stored = log.publish(publication);
          if (state.pending) state.pending.published = true;
          return stored;
        }
        if (state.stopped) throw messageError('WORK_STOPPED', 'work context is stopped');
        if (!state.pending?.prepared || state.error) throw messageError('WORK_CONTEXT_INACTIVE', 'work context has no prepared decision');
        if (state.pending.replan || state.pending.takeover) throw messageError('STALE_INPUT', 'work decision needs newer input');
        // 来源成员撤销对所有 scope 生效（与 log guard 同一语义，publishWork 内部
        // 执行，不依赖发送目标）；异步 DM 不做“存在更新入站消息”的新鲜度 guard——
        // 冻结轮只处理本轮关联消息，其后到达的 DM 留给后续决策轮，不使当前
        // 待发布稿件失效；room 仍沿用来源 scopeId/afterLocalId 新鲜度 guard。
        const guard = meta.kind === 'dm'
          ? undefined
          : { scopeId: meta.scopeId, afterLocalId: state.pending.prepared.throughLocalId };
        try {
          if (!currentMember(meta)) {
            throw messageError('SCOPE_FORBIDDEN', 'publisher bot must be a current member of the origin scope');
          }
          const stored = log.publish(publication, guard);
          state.pending.published = true;
          return stored;
        } catch (error) {
          if (error?.code !== 'STALE_INPUT' && !(error?.code === 'SCOPE_FORBIDDEN' && !currentMember(meta))) throw error;
          state.pending.replan = true;
          return { failure: error };
        }
      }, toolContext);
      // Throwing inside commit would roll back replan and permit another provider call on the stale request.
      if (result.failure) throw result.failure;
      return result;
    }, PUBLICATION_ERRORS, toolContext);
  }

  function close() {
    if (!closePromise) {
      closing = true;
      active = false;
      clearInterval(timer);
      timer = null;
      closePromise = (async () => {
        await Promise.allSettled([...inflight]);
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

  return { resume, close, beforeRequest, checkBudget, publishWork, getWorkActivity, stopWork, resumeWork, takeoverShower,
    coordinationSelector,
    setTurnGate: (fn, onIdle, canRunWork = null) => {
      turnGate.fn = fn;
      turnGate.idle = onIdle ?? null;
      turnGate.canRunWork = canRunWork ?? null;
    } };
}
