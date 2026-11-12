// 模块 6：Bot 主私聊 committed live 预览（观察者）。
// 用 Durable Conversation.watch（结构视图）由 runtime-live-projection.js 投影安全状态；
// 只观察，不启动/中止/提交模型工作，外部 AbortSignal 只停止观察。
// SDK 的 watch.start 不投初始值：attach 成功先同步投影 native.value，再立即 start，
// 中间不 await，避免漏掉此间的 commit。
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getPrimaryConversation } from './runtime-docs.js';
import { BotSessionState } from './bot-session-context.js';
import { GenerationFailureState } from './generation-failure.js';
import { normalizeBotBoardParams } from './bot-board-protocol.js';
import { readBotBoardDetails, projectBotBoardItem } from './runtime-bot-board.js';
import {
  emptyLiveState,
  projectLiveState,
  diffLiveState,
  projectInboxQueuedItems,
  buildQueuedPreview,
  MAX_QUEUED_ITEMS,
} from './runtime-live-projection.js';

const CTX = BACKGROUND_CONTEXT;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNonBlank(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errWithCode(name + " must be a non-empty string", 'INVALID_ARGUMENT');
  }
}

// Turn admission statuses are Host-internal data crossing a wire boundary:
// validate structure strictly and bound every string so a status can never
// blow the per-frame budget or smuggle text/credentials into live frames.
const TURN_ADMISSION_PHASES = new Set(['queued', 'checking', 'synchronizing', 'failed']);
const MAX_TURN_REQUEST_ID_CHARS = 128;
const MAX_TURN_ERROR_CHARS = 256;
// BotActivity 统一工作状态：Host 侧合并结果写进每个 primary 快照/更新；
// 字段严格限长，activity 永远不可能把正文/凭据塞进 live 帧。
const CONTROL_PHASES = new Set(['interrupting', 'stopping', 'stopped']);
const WORK_PENDING_KINDS = new Set(['primary', 'room', 'dm']);
const MAX_ACTIVITY_CHARS = 256;

function boundText(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Validate/copy a TurnAdmissionStatus for the live wire. requestId and error
 * strings are capped; no other fields pass through. status null clears.
 */
function normalizeTurnAdmission(status) {
  if (status === null) return null;
  if (typeof status !== 'object' || Array.isArray(status)) {
    throw errWithCode('turn admission status must be an object or null', 'INVALID_ARGUMENT');
  }
  if (typeof status.requestId !== 'string' || status.requestId.trim() === '' ||
      !status.requestId.isWellFormed()) {
    throw errWithCode('turn admission requestId must be a non-empty well-formed string', 'INVALID_ARGUMENT');
  }
  if (!TURN_ADMISSION_PHASES.has(status.phase)) {
    throw errWithCode('turn admission phase must be queued, checking, synchronizing or failed', 'INVALID_ARGUMENT');
  }
  const normalized = { requestId: boundText(status.requestId, MAX_TURN_REQUEST_ID_CHARS), phase: status.phase };
  if (status.source !== undefined) {
    if (status.source !== 'primary' && status.source !== 'background') {
      throw errWithCode('turn admission source must be primary or background', 'INVALID_ARGUMENT');
    }
    normalized.source = status.source;
  }
  if (status.error !== undefined) {
    const error = status.error;
    if (typeof error !== 'object' || error === null || Array.isArray(error) ||
        typeof error.code !== 'string' || typeof error.message !== 'string' ||
        !error.code.isWellFormed() || !error.message.isWellFormed()) {
      throw errWithCode('turn admission error must be {code, message} strings', 'INVALID_ARGUMENT');
    }
    normalized.error = { code: boundText(error.code, MAX_TURN_ERROR_CHARS), message: boundText(error.message, MAX_TURN_ERROR_CHARS) };
  }
  return normalized;
}

function normalizeQueuedTurnItems(items) {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw errWithCode('queuedItems must be an array', 'INVALID_ARGUMENT');
  }
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw errWithCode('queuedItem must be an object', 'INVALID_ARGUMENT');
    }
    if (
      typeof item.requestId !== 'string' ||
      item.requestId.trim() === '' ||
      !item.requestId.isWellFormed() ||
      /\s/.test(item.requestId)
    ) {
      throw errWithCode('queuedItem requestId must be a non-empty well-formed id', 'INVALID_ARGUMENT');
    }
    const requestId = boundText(item.requestId, MAX_TURN_REQUEST_ID_CHARS);
    if (seen.has(requestId)) continue;
    seen.add(requestId);
    const delivery = item.delivery === 'steer' ? 'steer' : 'followUp';
    const preview = buildQueuedPreview(typeof item.preview === 'string' ? item.preview : '');
    const attachmentCount = Number.isSafeInteger(item.attachmentCount) && item.attachmentCount > 0
      ? Math.min(16, item.attachmentCount)
      : 0;
    out.push({ requestId, delivery, preview, attachmentCount });
    if (out.length >= MAX_QUEUED_ITEMS) break;
  }
  return out;
}

function mergeQueuedItems(inboxItems, hostItems) {
  const steer = [];
  const followUp = [];
  const seen = new Set();
  for (const list of [inboxItems, hostItems]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || seen.has(item.requestId)) continue;
      seen.add(item.requestId);
      if (item.delivery === 'steer') steer.push(item);
      else followUp.push(item);
    }
  }
  return [...steer, ...followUp].slice(0, MAX_QUEUED_ITEMS);
}

/**
 * Merge the Host-side turn admission into a projected state for a primary
 * watch. queuedCount = pi.inbox items (projected) + Host-queued inputs, which
 * are disjoint sets — an input leaves the Host queue the moment it is
 * submitted to the SDK, so the sum never double counts.
 */
function withTurnAdmission(projected, admission, inboxQueuedItems = []) {
  // turnAdmission 与 queuedItems 恒写入（null / [] 表示无等待项）：字段缺失时 diff 帧序列化会丢键，
  // 已发布的 admission / 排队摘要无法被清除。
  return {
    ...projected,
    turnAdmission: admission?.status ?? null,
    queuedCount: projected.queuedCount + (admission?.hostQueued ?? 0),
    queuedItems: mergeQueuedItems(inboxQueuedItems, admission?.queuedItems ?? []),
  };
}

function boundActivityText(value) {
  return typeof value === 'string' ? boundText(value, MAX_ACTIVITY_CHARS) : null;
}

function activity(phase, fields = {}) {
  const out = {
    phase,
    source: fields.source ?? null,
    scopeId: fields.scopeId ?? null,
    requestId: fields.requestId ?? null,
    startedAt: fields.startedAt ?? null,
  };
  if (fields.error !== undefined) out.error = fields.error;
  return out;
}

function activityFieldsOf(item) {
  return {
    source: item.source ?? null,
    scopeId: item.scopeId ?? null,
    requestId: item.requestId ?? null,
    startedAt: item.startedAt ?? null,
  };
}

// 投影 activity 经 wire/白名单形态复投：剔除 error:undefined（非 wire 键），
// 保留真实 error 诊断；返回纯净 {phase,source,scopeId,requestId,startedAt,error?}。
function stripInternal(projected) {
  const out = {
    phase: projected.phase,
    source: projected.source ?? null,
    scopeId: projected.scopeId ?? null,
    requestId: projected.requestId ?? null,
    startedAt: projected.startedAt ?? null,
  };
  if (projected.error !== undefined && projected.error !== null) out.error = projected.error;
  return out;
}

/** work lane 已固定协议：只复制存活 pending 的元数据字段，不加防御层。 */
function copyWorkSummary(summary) {
  if (summary === null) return null;
  const pending = [];
  for (const item of summary.pending) {
    if (!WORK_PENDING_KINDS.has(item.kind)) continue;
    pending.push({
      requestId: boundActivityText(item.requestId),
      kind: item.kind,
      scopeId: boundActivityText(item.scopeId),
      startedAt: boundActivityText(item.startedAt),
    });
  }
  return { pending };
}

/**
 * 按契约优先级合并此 Bot 的统一 activity：
 * control stopping/interrupting > 真实运行 runActivity（running 或阻塞
 * compacting；自动压缩不中断 startedAt 计时）> failed admission >
 * Host admission（queued/preparing，用户直接输入优先）> 存活 work pending
 * （queued）> 原生 pi.inbox 积压（queued）> 空闲/手动 compacting > stopped > idle。
 * 例外：显式 stopped 优先于残留 failed（主动停止不被过期失败覆盖），
 * 空闲/手动 compacting 优先于 stopped（进行中的后台整理仍算活跃）。
 * stopped 只在无未完成工作时透出：新的 run/pending/admission 出现时由调用方
 * 先清掉旧 stopped 再重投影，绝不靠覆盖把 stopped 留到新任务完结后。
 */
function resolveBotActivity(botId, runActivity, queuedCount, ctx) {
  const control = ctx.controlByBot.get(botId) ?? null;
  if (control === 'interrupting' || control === 'stopping') {
    return activity(control, activityFieldsOf(runActivity?.activity ?? {}));
  }
  const projected = runActivity?.activity ?? null;
  // 真实运行/阻塞压缩（hasRun 的 compacting）直接胜出；空闲/手动压缩
  // （无 run）继续参与下方 admission/pending/queue 裁决，不在这里短路。
  if (projected?.phase === 'running' ||
      (projected?.phase === 'compacting' && runActivity.hasRun === true)) {
    return stripInternal(projected);
  }
  // 真实终态失败（contract B）：runFailure + Host 诊断投影的 failed 相，
  // 与 failed admission 同位——新的运行/排队出现时已先结算或胜出；投影只
  // 在 runFailure 存活期间产出，过期 failed 绝不覆盖新成功。显式 user_stop
  // （control stopped）优先：主动停止仍显示 stopped，不被残留失败覆盖。
  if (projected?.phase === 'failed' && runActivity.isFailure === true &&
      control !== 'stopped') {
    return stripInternal(projected);
  }
  const admission = ctx.admissionByBot.get(botId) ?? null;
  if (admission?.status?.phase === 'failed') return activity('failed', {
    source: admission.status.source ?? null,
    requestId: admission.status.requestId,
    ...(admission.status.error ? { error: admission.status.error } : {}),
  });
  if (admission?.status !== null && admission?.status !== undefined) {
    return activity(admission.status.phase === 'queued' ? 'queued' : 'preparing', {
      source: admission.status.source ?? null,
      requestId: admission.status.requestId,
    });
  }
  const pending = ctx.workByBot.get(botId)?.pending ?? [];
  if (pending.length > 0) {
    const item = pending[0];
    // work summary 的 primary 是后台续轮，不是用户主聊天。
    return activity('queued', {
      source: item.kind === 'primary' ? 'background' : item.kind,
      scopeId: item.scopeId,
      requestId: item.requestId,
      startedAt: item.startedAt,
    });
  }
  // 原生 pi.inbox 已有 SDK 排队项但既无运行也无 admission/work pending：
  // 真实工作已入队，绝不能报 idle。排在空闲/手动 compacting 之前：排队的
  // 真实输入比后台压缩更贴近用户等待；计数没有归属，不猜成 primary。
  if (queuedCount > 0) return activity('queued');
  // 空闲/手动压缩低于真实排队：积压的真实输入比后台整理更贴近用户等待。
  if (projected?.phase === 'compacting') return stripInternal(projected);
  if (control === 'stopped') return activity('stopped');
  return activity('idle');
}

/** 合并统一 activity 与 learning 状态进 primary 快照（恒写入，同 turnAdmission）。 */
function withBotActivity(projected, botId, runActivity, ctx) {
  const resolved = resolveBotActivity(botId, runActivity, projected.queuedCount, ctx);
  if (ctx.webhookStopPendingByBot.has(botId)) resolved.webhookStopPending = true;
  return {
    ...projected,
    activity: resolved,
    learning: ctx.learningByBot.get(botId) ?? null,
  };
}

/** 新的真实工作/排队输入出现：清掉旧 stopped control，防止新任务完结后又误显已停止。 */
function clearStoppedOnWork(ctx, botId) {
  if (ctx.controlByBot.get(botId) === 'stopped') ctx.controlByBot.delete(botId);
}

// 投影 state 是纯 JSON 安全值：深冻结后对外暴露，防止任一消费者改写破坏后续 diff/帧。
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Bot 主私聊/远端工作上下文 live 观察控制器。
 * - watch()：Bot 主私聊。先登记待绑 watch（per-Bot map），再做只读
 *   getPrimaryConversation(create:false) 查映射：缺会话时返回空快照且保持待绑，绝不创建/
 *   启动模型。Runtime.submit 在会话解析/创建后、输入提交前调用 bind() 附着等待中的 watch。
 * - watchWork()：远端 scope 工作上下文。先登记待绑 watch（per-(bot,scope) map），再经
 *   resolveWorkContext 只读授权：未绑定 scope 发出空快照且保持待绑，绝不创建会话；
 *   syncWorkContext 提交成功后经 onBound→bindWork 附着等待中的 watch（绑定前 conversationId
 *   为 null，绑定后固定为公开 UUID）。work watch 只发 FULL snapshot 帧。
 * 两类 watch 共享同一生命周期/单飞行 attach/串行监听泵（projection 上限/深冻结/合并
 * 最新状态复用），不新增轮询。
 */
export function createRuntimeLive({ host, getHarness, resolveWorkContext }) {
  const pendingByBot = new Map(); // botId -> Set<watch>
  const pendingByWork = new Map(); // "botId\0scopeId" -> Set<watch>
  const watches = new Set(); // 全部未结束 watch，供 close 统一停止
  let closedFlag = false; // close 后拒绝新订阅逃逸
  const inflight = new Set(); // 已受理 lookup/attach/bind 异步工作，close 需要 join
  // botId -> {status, hostQueued}：最近一次的 Host 队列 admission 发布；
  // primary watch 每次投影时并入，绝不进 work watch。
  const admissionByBot = new Map();
  // botId -> 'interrupting'|'stopping'|'stopped'：Host 侧停止/让位控制阶段，
  // 由 setBotControl 显式写入/清除；stopping/interrupting 不由投影自动解除。
  const controlByBot = new Map();
  // botId -> {pending:[…]}：work lane 推送的存活 pending 元数据快照；
  // 只投影进 primary watch 的统一 activity，绝不进 work watch（保持原历史）。
  const workByBot = new Map();
  const webhookStopPendingByBot = new Set();
  const learningByBot = new Map();
  const activityCtx = { controlByBot, workByBot, admissionByBot, webhookStopPendingByBot, learningByBot };

  function track(task) {
    inflight.add(task);
    task.then(() => inflight.delete(task), () => inflight.delete(task));
    return task;
  }

  function workKey(botId, scopeId) {
    return botId + '\u0000' + scopeId;
  }

  function createWatch(bot, signal, work, board = false) {
    const botId = bot.botId;
    const state = {
      kind: 'pending', // 'pending' | 'attaching' | 'attached' | 'ended'
      native: null,
      attachPromise: null,
      // 未并入 admission 的 pi.inbox 计数基线：admission 重算 queuedCount 时以此为底，
      // 避免把已并入的 hostQueued 再累加一遍。
      inboxQueued: 0,
      inboxQueuedItems: [],
      current: deepFreeze(
        work ? emptyLiveState()
          : withBotActivity(
            withTurnAdmission(emptyLiveState(), admissionByBot.get(botId) ?? null, []),
            botId, null, activityCtx,
          ),
      ),
      // 最近一次投影的真实运行/失败 activity：{activity, hasRun, isFailure}。
      // hasRun 区分阻塞压缩（真实运行）与空闲/手动压缩；isFailure 标记
      // runFailure 投影的 failed 相——优先级由 resolveBotActivity 统一裁决。
      runActivity: null,
      delivered: null, // null = 尚未投递首个快照
      seq: 0,
      dirty: false,
      pumping: false,
      started: false,
      listener: null,
      endReason: null,
      settleEnd: null,
      closed: null,
      removeAbort: null,
      forceFrame: false, // work 绑定后即使状态未变化也强制发一帧快照
      conversationId: work ? null : bot.primaryConversationId,
      // 该 watch 绑定的 native 会话 id（装载归属 doc 用）；与公开 conversationId 区分。
      nativeId: null,
      // 归属快照与待投影视图：单飞行装载循环只对最新 pendingView 取已提交
      // BotSessionState 快照后投影；首个快照落地前不发布任何帧——
      // 不先把无来源的 peer 正文当作用户消息推给客户端。
      sessionState: null,
      pendingView: null,
      attributionLoad: null,
      initialized: false,
      boardView: null,
      boardDetails: null,
    };
    state.closed = new Promise((resolve) => { state.settleEnd = resolve; });

    function end(reason, error) {
      if (state.endReason !== null) return;
      state.endReason = reason;
      state.kind = 'ended';
      state.removeAbort?.();
      state.removeAbort = null;
      watches.delete(watch);
      const key = work ? workKey(botId, work.scopeId) : botId;
      const pending = work ? pendingByWork.get(key) : pendingByBot.get(key);
      if (pending) {
        pending.delete(watch);
        if (pending.size === 0) {
          if (work) pendingByWork.delete(key);
          else pendingByBot.delete(key);
        }
      }
      state.settleEnd({ reason, ...(error !== undefined ? { error } : {}) });
    }

    function stopNative() {
      const native = state.native;
      return native ? native.stop() : Promise.resolve();
    }

    function kick() {
      if (state.pumping) return;
      state.pumping = true;
      queueMicrotask(() => void pump());
    }

    // 串行监听泵：只保留最新投影状态与已投递状态；消费者慢时合并（丢弃中间帧），
    // 无每事件无界队列。primary 帧在投递时按 diffLiveState(delivered, current) 整字段替换；
    // work 帧恒为完整快照（绑定/状态变化时都会发）。
    async function pump() {
      try {
        while (state.dirty) {
          state.dirty = false;
          if (state.endReason !== null || !state.started) break;
          let frame;
          if (state.delivered === null || state.forceFrame || (work && state.current !== state.delivered)) {
            frame = {
              type: 'snapshot',
              botId,
              ...(work ? { scopeId: work.scopeId } : {}),
              conversationId: state.conversationId,
              sequence: state.seq,
              state: state.current,
            };
            state.delivered = state.current;
            state.forceFrame = false;
          } else if (state.current !== state.delivered) {
            const changes = deepFreeze(diffLiveState(state.delivered, state.current));
            if (changes === null) { state.delivered = state.current; continue; }
            frame = { type: 'update', botId, conversationId: state.conversationId, sequence: state.seq, changes };
            state.delivered = state.current;
          } else {
            continue;
          }
          try {
            await state.listener(frame);
          } catch (err) {
            end('listener_error', err);
            void stopNative().catch(() => {});
            break;
          }
        }
      } finally {
        state.pumping = false;
      }
    }

    function start(listener) {
      if (typeof listener !== 'function') {
        throw errWithCode('listener must be a function', 'INVALID_ARGUMENT');
      }
      if (state.started) {
        throw errWithCode('start may only be called once', 'INVALID_ARGUMENT');
      }
      state.listener = listener;
      state.started = true;
      if (state.endReason !== null) return;
      state.dirty = true;
      kick();
    }

    // 结束观察并释放底层原生 watch。先落定本端 reason，再 await native.stop()，
    // 避免原生 closed 回调抢先覆盖 reason；不等待用户 listener。
    async function shutdown(reason) {
      if (state.endReason !== null) {
        await stopNative();
        return state.closed;
      }
      const native = state.native;
      end(reason);
      if (native) await native.stop();
      return state.closed;
    }

    function stop() {
      return shutdown('stopped');
    }

    // 原生 watcher 回调：只保存最新 view 并保证有且仅有一个归属装载在飞；
    // 同步返回，不调用 Session API/commit。attach 的 native.value/start 之间不 await。
    function onView(view) {
      if (state.endReason !== null) return;
      state.pendingView = view;
      if (state.attributionLoad === null) {
        const task = processAttribution();
        state.attributionLoad = task;
        track(task);
      }
    }

    // 单飞行归属装载：对最新 pendingView 先取已提交的 BotSessionState 快照再投影，
    // 保证生成/peer 条目的归属索引覆盖被投影的 view。快照期间到达的新 view 只保留
    // 最新一份，loop 再取一次快照覆盖它（新快照可归属旧帧，反向不行）。
    // 快照失败停在原地——下一次 view 重新进入装载；不在 finally 里立即重试。
    async function processAttribution() {
      try {
        while (state.endReason === null) {
          const view = state.pendingView;
          if (view === null || state.nativeId === null) return;
          let doc;
          try {
            doc = await getHarness().snapshot(BotSessionState, state.nativeId, CTX);
          } catch {
            return; // 等下一次 view 重试；Session 失败由 native.closed 收尾
          }
          if (state.endReason !== null) return;
          state.sessionState = doc ?? null;
          // contract B：runFailure 的真实终态失败读取 Host 失败诊断族文档；
          // 空闲/手动压缩读取各压缩任务的持久 startedAt。同一装载循环内完成，
          // 读取失败回落 null——投影以安全通用文案/无起点降级，绝不抛错断流。
          let extras = null;
          const live = view?.docs?.['pi.live'];
          if (live != null && state.nativeId !== null) {
            extras = {};
            // aborted 也读取族文档：Host final guard abortTask 的具体诊断
            // （如 CONTEXT_LIMIT）存于 GenerationFailureState；无 receipt 的
            // 裸 abort 才是主动停止，投影按 stopped/idle 处理。
            if (live.run == null && live.runFailure != null && live.runFailure.taskId != null) {
              try {
                extras.failureDoc = await getHarness().snapshot(
                  GenerationFailureState, state.nativeId, String(live.runFailure.taskId), CTX);
              } catch { extras.failureDoc = null; }
            }
            if (Array.isArray(live.compactions) && live.compactions.length > 0) {
              extras.compactionStarts = {};
              for (const c of live.compactions) {
                if (c?.taskId == null) continue;
                try {
                  const rec = await getHarness().getTask(c.taskId, CTX);
                  if (Number.isSafeInteger(rec?.startedAt) && rec.startedAt > 0) {
                    extras.compactionStarts[String(c.taskId)] = rec.startedAt;
                  }
                } catch { /* 任务不可读则缺该起点，由投影回 null */ }
              }
            }
          }
          if (board) {
            try {
              extras ??= {};
              extras.boardDetails = await readBotBoardDetails(getHarness(), state.nativeId, CTX);
            } catch (err) {
              end('session_failed', err);
              void stopNative().catch(() => {});
              return;
            }
          }
          if (state.endReason !== null) return;
          if (state.pendingView === view) {
            state.pendingView = null;
            publishView(view, extras);
          }
          // pendingView 在 await 期间被替换：回到循环为最新 view 重取快照。
        }
      } finally {
        state.attributionLoad = null;
      }
    }

    // 用已装载的归属快照投影并投递一帧（diff 与原串行泵一致）。
    function publishView(view, extras = null) {
      let next;
      try {
        next = projectLiveState(view, state.sessionState, extras);
        state.inboxQueued = next.queuedCount;
        if (!work) {
          state.inboxQueuedItems = projectInboxQueuedItems(view?.docs?.['pi.inbox'] ?? null);
          // 保留最近一次投影的 activity 及其来源标记（hasRun/isFailure）：
          // running/真实运行的 compacting/真实 failed/空闲手动压缩均缓存，
          // 供 resolveBotActivity 按新优先级裁决（运行>压缩>失败>…）。
          const projected = next.activity;
          state.runActivity = (projected != null && projected.phase !== 'idle')
            ? { activity: projected, hasRun: extras?.activityHasRun === true, isFailure: extras?.activityIsFailure === true }
            : null;
          // 新真实工作出现：旧 stopped 不得残留到下次完结。手动 compact 也是
          // 显式新工作，须清旧 stopped 透出压缩；失败投影不是工作，不清。
          // 压缩被停止结算时调用方重写 stopped——清标不影响停止后仍 stopped。
          const activeWork = state.runActivity !== null && state.runActivity.isFailure !== true;
          // 冻结看板 view 可能早于停止结算，不能据此清共享 stopped。
          if (!board && (activeWork || state.inboxQueued > 0)) {
            clearStoppedOnWork(activityCtx, botId);
          }
          next = withBotActivity(
            withTurnAdmission(next, admissionByBot.get(botId) ?? null, state.inboxQueuedItems),
            botId, state.runActivity, activityCtx,
          );
        }
      } catch (err) {
        end('listener_error', err);
        void stopNative().catch(() => {});
        return;
      }
      const previous = state.current;
      state.current = deepFreeze(next);
      state.initialized = true;
      if (board) {
        state.boardView = view;
        state.boardDetails = extras?.boardDetails ?? null;
      }
      if (diffLiveState(previous, next) !== null) {
        state.seq++;
        if (state.started) {
          state.dirty = true;
          kick();
        }
      }
    }

    async function doAttach(conversation, binding) {
      if (state.endReason !== null || state.kind === 'attached') return;
      state.kind = 'attaching';
      if (signal?.aborted) { end('cancelled'); return; }
      let native;
      try {
        native = await conversation.watch(signal ? withAbortSignal(signal, CTX) : CTX);
      } catch (err) {
        if (signal?.aborted) end('cancelled');
        else end('session_failed', err);
        return;
      }
      if (state.endReason !== null) {
        // attach 完成前已 stop/关闭：释放这次刚获取的 watch。
        await native.stop();
        return;
      }
      const attachedNative = native;
      state.native = native;
      state.kind = 'attached';
      const key = work ? workKey(botId, work.scopeId) : botId;
      const pending = work ? pendingByWork.get(key) : pendingByBot.get(key);
      if (pending) {
        pending.delete(watch);
        if (pending.size === 0) {
          if (work) pendingByWork.delete(key);
          else pendingByBot.delete(key);
        }
      }
      if (work) {
        // 绑定成功后固定公开 UUID，并强制发一帧快照（状态未变也通知客户端绑定结果）。
        state.conversationId = binding.conversationId;
        state.seq++;
        state.forceFrame = true;
      }
      // SDK start 不投初始值：普通聊天登记归属装载后立即 start，中间不 await，不漏 commit。
      state.nativeId = conversation.id;
      onView(native.value);
      if (work && state.forceFrame) {
        state.dirty = true;
        kick();
      }
      try {
        // 看板只读捕获的 native.value，不追逐流式更新，避免归属装载饥饿。
        // Durable 保证视图 watch 只发 value 调用：直接解构，onView 同步执行。
        if (!board) native.start(({ value }) => { onView(value); });
      } catch (err) {
        await stopNative().catch(() => {});
        end('listener_error', err);
        return;
      }
      native.closed.then((nativeEnd) => {
        if (state.endReason !== null || state.native !== attachedNative) return;
        // 新 WatchEnd.kind 映射回宿主既有 reason 词汇：control-live 的 END_REASONS 不变，
        // failed→session_failed、aborted→cancelled；stopped/ended/listener_error 原名透传。
        const kind = nativeEnd.kind;
        end(kind === 'failed' ? 'session_failed' : kind === 'aborted' ? 'cancelled' : kind, nativeEnd.error);
      }, () => {});
    }

    // 单飞行附着：并发 watch/bind 复用同一 attach promise，绝不创建重复底层 watch。
    // 入队供 close join：晚到 native handle 在 doAttach 内 stop 后才算完成。
    function attach(conversation, binding) {
      if (state.endReason !== null || state.kind === 'attached') return Promise.resolve();
      if (!state.attachPromise) {
        state.attachPromise = track(doAttach(conversation, binding).finally(() => { state.attachPromise = null; }));
      }
      return state.attachPromise;
    }

    // Host 侧 admission 发布到达：重投影当前态并入最新 admission。即使未绑
    // 原生会话（pending watch），已连接前端也能收到下一帧变化。
    function applyAdmission(targetBotId) {
      if (work || targetBotId !== botId || state.endReason !== null) return;
      const previous = state.current;
      // 以 inboxQueued / inboxQueuedItems 为底重算：previous 已含上一次并入的 Host 排队项。
      const next = deepFreeze(withBotActivity(
        withTurnAdmission(
          { ...previous, queuedCount: state.inboxQueued },
          admissionByBot.get(botId) ?? null,
          state.inboxQueuedItems,
        ),
        botId, state.runActivity, activityCtx,
      ));
      if (diffLiveState(previous, next) !== null) {
        state.current = next;
        state.seq++;
        if (state.started) {
          state.dirty = true;
          kick();
        }
      }
    }

    // 历史消息编辑分叉出新原生会话时，原地重绑已有 primary watch：
    // 公开 conversationId 与单调 seq 不变，停止旧底层 watch 后立即附着新会话。
    async function rebindWatch(targetBotId, conversation) {
      if (work || board || targetBotId !== botId || state.endReason !== null) return;
      while (state.attachPromise !== null || state.attributionLoad !== null) {
        await (state.attachPromise ?? state.attributionLoad);
      }
      if (state.endReason !== null) return;
      const previousNative = state.native;
      state.native = null;
      state.nativeId = null;
      state.pendingView = null;
      state.sessionState = null;
      state.runActivity = null;
      state.inboxQueued = 0;
      state.inboxQueuedItems = [];
      state.kind = 'pending';
      if (previousNative) {
        await previousNative.stop().catch(() => {});
      }
      if (state.endReason !== null) return;
      await attach(conversation);
      while (state.attachPromise !== null || state.attributionLoad !== null) {
        await (state.attachPromise ?? state.attributionLoad);
      }
    }

    // work pending 汇总或 Host control 阶段变化：只重投影统一 activity 字段，
    // 以最近一次真实运行 runActivity 为准，不重算历史/工具。
    function applyActivity(targetBotId) {
      if (work || targetBotId !== botId || state.endReason !== null) return;
      const previous = state.current;
      const next = deepFreeze(withBotActivity({ ...previous }, botId, state.runActivity, activityCtx));
      if (diffLiveState(previous, next) !== null) {
        state.current = next;
        state.seq++;
        if (state.started) {
          state.dirty = true;
          kick();
        }
      }
    }

    async function readBoard() {
      // watch() waits for attach, not the asynchronous attribution projection.
      // Never expose its placeholder idle value for an existing conversation.
      while (state.attachPromise !== null || state.attributionLoad !== null) {
        await (state.attachPromise ?? state.attributionLoad);
      }
      if (state.endReason !== null || (state.nativeId !== null && (!state.initialized || state.pendingView !== null))) {
        throw errWithCode('bot board snapshot is unavailable', 'BOARD_UNAVAILABLE');
      }
      return projectBotBoardItem(botId, state.conversationId, state.current, state.boardView, state.boardDetails);
    }

    const watch = {
      _readBoard: readBoard,
      _applyAdmission: applyAdmission,
      _applyActivity: applyActivity,
      _rebind: rebindWatch,
      get value() {
        return {
          type: 'snapshot',
          botId,
          ...(work ? { scopeId: work.scopeId } : {}),
          conversationId: state.conversationId,
          sequence: state.seq,
          state: state.current,
        };
      },
      get closed() { return state.closed; },
      get ended() { return state.endReason !== null; },
      start,
      stop,
      shutdown,
      attach,
    };

    if (signal) {
      const onAbort = () => { void stopNative().catch(() => {}); end('cancelled'); };
      if (signal.aborted) {
        end('cancelled');
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        state.removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
    }

    return watch;
  }

  async function bind(botId, conversation) {
    const pending = pendingByBot.get(botId);
    if (!pending || pending.size === 0) return;
    for (const w of [...pending]) {
      await w.attach(conversation);
    }
  }

  function rebind(botId, conversation) {
    return track((async () => {
      assertNonBlank(botId, 'botId');
      for (const w of [...watches]) {
        await w._rebind(botId, conversation);
      }
    })());
  }

  // 提交成功后（事务外）附着等待中的 work watch；观察失败只停止受影响 watch，不影响导入。
  // 整段列入 inflight：close 结束时已 join conversation lookup 与 attach。
  function bindWork(botId, scopeId, binding) {
    return track((async () => {
      const pending = pendingByWork.get(workKey(botId, scopeId));
      if (!pending || pending.size === 0) return;
      let conversation;
      try {
        conversation = await getHarness().conversation(binding.nativeId, CTX);
      } catch (err) {
        for (const w of [...pending]) {
          await w.shutdown('session_failed');
        }
        return;
      }
      for (const w of [...pending]) {
        await w.attach(conversation, binding);
      }
    })());
  }

  function watch(botId, options = {}, board = false) {
    return track((async () => {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode('bot not found: ' + botId, 'BOT_NOT_FOUND');
      const signal = options?.signal ?? undefined;
      const w = createWatch(bot, signal, null, board);
      if (w.ended) return w;
      if (closedFlag) {
        await w.shutdown('session_closed');
        return w;
      }
      watches.add(w);
      let pending = pendingByBot.get(botId);
      if (!pending) {
        pending = new Set();
        pendingByBot.set(botId, pending);
      }
      pending.add(w);
      let conversation;
      try {
        conversation = await getPrimaryConversation(getHarness(), bot, {}, CTX);
      } catch (err) {
        // 查映射失败：不留 watch，停止并清 pending 后再抛。
        await w.stop();
        throw err;
      }
      if (conversation) await bind(botId, conversation);
      return w;
    })());
  }

  async function getBotBoard(params, refreshActivity) {
    const { botIds } = normalizeBotBoardParams(params);
    const items = [];
    const errors = [];
    // One transient observer at a time; no permanent subscriptions or broker quota.
    for (const botId of botIds) {
      let observer;
      try {
        if (!host.getBot(botId)) throw errWithCode('bot not found', 'BOT_NOT_FOUND');
        await refreshActivity?.(botId);
        observer = await watch(botId, {}, true);
        items.push(await observer._readBoard());
      } catch (err) {
        const missing = err?.code === 'BOT_NOT_FOUND';
        errors.push({
          botId,
          code: missing ? 'BOT_NOT_FOUND' : 'BOARD_UNAVAILABLE',
          message: missing ? 'bot not found' : 'bot board snapshot is unavailable',
        });
      } finally {
        if (observer) await observer.stop();
      }
    }
    return { updatedAt: new Date().toISOString(), items, errors };
  }

  function watchWork(botId, scopeId, options = {}) {
    return track((async () => {
      assertNonBlank(botId, 'botId');
      assertNonBlank(scopeId, 'scopeId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode('bot not found: ' + botId, 'BOT_NOT_FOUND');
      const signal = options?.signal ?? undefined;
      const w = createWatch(bot, signal, { scopeId });
      if (w.ended) return w;
      if (closedFlag) {
        await w.shutdown('session_closed');
        return w;
      }
      watches.add(w);
      const key = workKey(botId, scopeId);
      let pending = pendingByWork.get(key);
      if (!pending) {
        pending = new Set();
        pendingByWork.set(key, pending);
      }
      pending.add(w);
      try {
        // 先登记 pending 再异步授权，避免并发 sync 成功绑定后漏附。
        const authorized = await resolveWorkContext(botId, scopeId);
        if (authorized?.binding) {
          await bindWork(botId, scopeId, authorized.binding);
        }
      } catch (err) {
        // 授权失败：不留 watch，停止并清 pending 后再抛；若同时正在 close，回已结束 watch。
        if (closedFlag) {
          await w.shutdown('session_closed');
          return w;
        }
        await w.stop();
        throw err;
      }
      return w;
    })());
  }

  /**
   * Publish the next waiting primary-turn admission for a Bot. status null clears
   * it. hostQueued counts ONLY Host-side queued primary inputs not yet submitted
   * to the SDK; projection adds pi.inbox items itself, so they never double count.
   * The status applies to primary watches only — work watches never carry it.
   */
  function setTurnAdmission(botId, status, hostQueued = 0, queuedItems = []) {
    assertNonBlank(botId, 'botId');
    if (!Number.isSafeInteger(hostQueued) || hostQueued < 0) {
      throw errWithCode('hostQueued must be a safe nonnegative integer', 'INVALID_ARGUMENT');
    }
    const normalized = normalizeTurnAdmission(status);
    const normalizedItems = normalizeQueuedTurnItems(queuedItems);
    if (normalized === null && hostQueued === 0 && normalizedItems.length === 0) {
      admissionByBot.delete(botId);
    } else {
      admissionByBot.set(botId, { status: normalized, hostQueued, queuedItems: normalizedItems });
      // 新 Host admission 受理/排队：旧 stopped 不得残留到下次完结。
      clearStoppedOnWork(activityCtx, botId);
    }
    for (const w of watches) {
      w._applyAdmission(botId);
    }
    for (const w of watches) {
      w._applyActivity(botId);
    }
  }

  /**
   * Work lane 推送的存活 pending 元数据快照（summary={pending:[…]}，null 清空）。
   * 只进 primary watch 的统一 activity；缓存最新并去重，不唤醒模型、不轮询。
   */
  function setWorkActivity(botId, summary) {
    assertNonBlank(botId, 'botId');
    const normalized = copyWorkSummary(summary);
    const previous = workByBot.get(botId) ?? null;
    if (JSON.stringify(previous) === JSON.stringify(normalized)) return;
    if (normalized === null || normalized.pending.length === 0) {
      workByBot.delete(botId);
    } else {
      workByBot.set(botId, normalized);
      // 新 work pending 出现：旧 stopped 不得残留到下次完结。
      clearStoppedOnWork(activityCtx, botId);
    }
    for (const w of watches) {
      w._applyActivity(botId);
    }
  }

  /**
   * Host 侧停止/让位控制阶段：'interrupting'|'stopping'|'stopped'，null 清除。
   * stopping/interrupting 由调用者显式解除；stopped 在新工作出现时自动被覆盖。
   */
  function setBotControl(botId, phase) {
    assertNonBlank(botId, 'botId');
    if (phase !== null && !CONTROL_PHASES.has(phase)) {
      throw errWithCode('control phase must be interrupting, stopping, stopped or null', 'INVALID_ARGUMENT');
    }
    if (phase === null) controlByBot.delete(botId);
    else controlByBot.set(botId, phase);
    for (const w of watches) {
      w._applyActivity(botId);
    }
  }

  function setWebhookStopPending(botId, pending) {
    if (pending) webhookStopPendingByBot.add(botId);
    else webhookStopPendingByBot.delete(botId);
    for (const w of watches) w._applyActivity(botId);
  }

  function setBotLearning(botId, learningState) {
    assertNonBlank(botId, 'botId');
    const previous = learningByBot.get(botId) ?? null;
    const normalized = learningState ? structuredClone(learningState) : null;
    if (JSON.stringify(previous) === JSON.stringify(normalized)) return;
    if (normalized === null) learningByBot.delete(botId);
    else learningByBot.set(botId, normalized);
    for (const w of watches) w._applyActivity(botId);
  }

  async function close() {
    if (closedFlag) return;
    closedFlag = true;
    // seal 后不新附着：先反复排空全部已接受 watch（含封口前已放行的并发新增），
    // 再 join 已受理 lookup/attach/bind 异步工作；晚到的 native handle 由 doAttach
    // 在 endReason 已落定时自行 stop，close 等其完成后才返回。不等外部 listener。
    while (watches.size > 0) {
      const batch = [...watches];
      await Promise.allSettled(batch.map((w) => w.shutdown('session_closed')));
    }
    await Promise.allSettled([...inflight]);
    pendingByBot.clear();
    pendingByWork.clear();
    controlByBot.clear();
    workByBot.clear();
    webhookStopPendingByBot.clear();
    learningByBot.clear();
  }

  return { watch, watchWork, getBotBoard, bind, rebind, bindWork, setTurnAdmission, setWorkActivity, setBotControl, setWebhookStopPending, setBotLearning, close };
}
