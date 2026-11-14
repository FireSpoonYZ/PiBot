// 模块：每轮中心准入（contract §6 的 Host 侧实现）。
// 每条外部用户输入先持久化进 TurnQueue（session family doc，key = primaryConversationId），
// 再由 per-Bot 泵在线执行 prepare→原子切换→confirm→持久 pin→原生 submit(whenBusy:'reject')。
// 任何一步失败都留下可重试的 queued/failed 记录：绝不静默沿用旧 set 执行模型。
// 恢复：restoreTurns() 在冷启动 resume 之前按持久 pin/admissionId 重挂被钉住的旧版本。
import { createHash } from 'node:crypto';
import { ConversationBusy, ConversationIdle, LiveDoc, InboxDoc } from '@earendil-works/pi-durable';
import { TurnQueue, TurnPin, toTurnAdmissionStatus, toQueuedReceipt } from './runtime-turns-docs.js';
import { normalizeAttachmentIds } from './attachments.js';
import { PrimaryIndex, getPrimaryConversation, applyAgentProfile, RequestKeys } from './runtime-docs.js';
import { formatPrimarySubmission } from './runtime-history.js';
import { parseModelRef } from './runtime-models.js';
import { WorkIndex, WorkContextState } from './work-context-docs.js';
import { WorkDecisionState } from './work-decision-state.js';
import { clearBotBoardResult } from './runtime-bot-board.js';
import { BotSessionState, deriveEntryAttribution } from './bot-session-context.js';
import { buildQueuedPreview, extractUserTextFromContent, MAX_QUEUED_ITEMS } from './runtime-live-projection.js';

const MAX_PREPARE_ATTEMPTS = 3;
// 每条消息图片解码总字节上限（64MiB）：单张合法（≤16MiB）的图仍需满足本条消息总量限制。
const MAX_ATTACHMENTS_TOTAL_BYTES = 64 * 1024 * 1024;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;
const RETRY_MAX_ATTEMPTS = 5;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 只携带短码与短消息的可重试错误；其余按同步失败落盘。
function boundedTurnError(err) {
  const code = typeof err?.code === 'string' && err.code ? err.code : 'TURN_SYNC_FAILED';
  const retryable = new Set(['TURN_SET_CHANGED', 'TURN_SYNC_FAILED', 'CENTER_OFFLINE', 'RUNTIME_BUSY', 'NOT_CONNECTED']);
  return {
    code: retryable.has(code) ? code : 'TURN_SYNC_FAILED',
    message: (typeof err?.message === 'string' && err.message ? err.message : 'turn synchronization failed').slice(0, 200),
  };
}

/**
 * deps:
 *  host, getHarness, context, centerRuntime（含 transport 注入的 prepareTurn/confirmTurn/restoreTurn）,
 *  plugins, models, getBotModels, setBotModels, profileFor, botExecutionFingerprint, applyBotCwd,
 *  setBotAppliedRevision(botId, revision), setBotFingerprint(botId, fingerprint),
 *  live（protocol lane 补 setTurnAdmission；缺席时静默跳过）, admitBot,
 *  getEpoch()（断线 epoch，网络 await 期间变更即放弃提交）,
 *  preemptWork(botId)（用户轮 head 实际准入前抢占同 Bot 非用户来源 work，由 work lane 提供）,
 *  trackSubmission(submissionId, info), recordCompletedSubmission(botId, formatted),
 *  initializeBot(botId), attachments({upload,load,removeBot}),
 *  sessions（可选；统一 Bot 主会话的收件导入运行时，缺席时跳过统一导入）.
 */
export function createTurnAdmission(deps) {
  const {
    host, getHarness, context, centerRuntime, plugins, models,
    getBotModels, setBotModels, profileFor, botExecutionFingerprint, applyBotCwd,
    setBotAppliedRevision, setBotFingerprint, live, admitBot, getEpoch,
    trackSubmission, recordCompletedSubmission, initializeBot, attachments, sessions,
    preemptWork, canAdmit = () => true,
  } = deps;

  // 可信的发送方来源：只接受 Runtime 传入的结构化标记，deviceId 恒为本机，绝不采信正文。
  function normalizeUserOrigin(origin) {
    if (origin === undefined || origin === null) return null;
    if (typeof origin !== 'object' || Array.isArray(origin)) {
      throw errWithCode('origin must be an object', 'INVALID_ARGUMENT');
    }
    const kind = origin.sender?.kind;
    if (kind !== 'user' && kind !== 'host') {
      throw errWithCode('origin sender kind must be user or host', 'INVALID_ARGUMENT');
    }
    const name = typeof origin.sender?.name === 'string' ? origin.sender.name.slice(0, 200) : null;
    const replyTo = typeof origin.replyTo === 'string' ? origin.replyTo : null;
    return { sender: { kind, ...(name !== null ? { name } : {}),
      ...(kind === 'host' && origin.sender?.sourceType === 'webhook' ? { sourceType: 'webhook' } : {}),
    }, replyTo };
  }

  /** 受理条目在原生提交时附带的可信入口：entry.data 携带发送方归属与
      冻结轮次路由，正文仍走 content。每个实际输入（用户与计划任务等 Host
      来源）都有稳定 requestId/turn；缺席 origin 的遗留队列条目按 Host 记。
      wire 上的任意 origin/author 字段绝不采信——origin 只由可信本机边界
      （已鉴权 HTTP/control submit 记 user、计划任务记 host）注入。 */
  function sourceMessageEntry(item) {
    const kind = item.origin?.sender?.kind === 'user' ? 'user' : 'host';
    const name = typeof item.origin?.sender?.name === 'string' ? item.origin.sender.name : null;
    const replyTo = typeof item.origin?.replyTo === 'string' ? item.origin.replyTo : null;
    const source = kind === 'host' && item.origin?.sender?.sourceType === 'webhook'
      ? { sourceType: 'webhook' } : {};
    return {
      kind: 'host.user-message',
      data: {
        version: 1,
        source: 'host',
        requestId: item.requestId,
        botId: item.botId,
        ...(kind === 'user' ? { userText: item.text } : {}),
        attribution: {
          kind,
          deviceId: host.deviceId,
          channel: 'primary',
          messageId: item.requestId,
          direction: 'incoming',
          createdAt: item.enqueuedAt,
          ...(name !== null ? { name } : {}),
          ...source,
          ...(replyTo !== null ? { replyTo } : {}),
        },
        turn: {
          requestId: item.requestId,
          taskId: null,
          kind: 'primary',
          scopeId: null,
          triggerMessageId: item.requestId,
          replyTo,
          sender: { kind, deviceId: host.deviceId, ...(name !== null ? { name } : {}), ...source },
          replyTarget: { kind: 'primary' },
        },
      },
    };
  }

  const harness = () => getHarness();
  const pumpInFlight = new Set();   // botId：每会话同时至多一个泵
  const pumpAgain = new Set();      // botId：泵在飞期间收到新 nudge（如 steer 提升/新轮到达/前轮刚完结），泵尾立即补跑一轮
  const forceIdlePrep = new Set();  // `${botId}:${requestId}`：steer 遇 ConversationIdle 回退后下轮强制走完整空闲准备
  const retryTimers = new Map();    // botId -> timer
  const retryAttempts = new Map();  // botId -> n（失败退避计数，成功清空）
  const appliedSetIds = new Map();  // botId -> 最近一次已确认/已恢复的完整 setId
  const workBackoff = new Map();    // nativeId -> ms epoch，工作决策准入退避
  // 停止 gate：beginStop 在首个 await 前同步推进本进程代次并 arm gate；
  // armed 期间所有原生忙检查/canRunWork 恒忙恒否，取消确认前另一轮不争用 Bot 资源。
  // 代次跨进程单调：initializeBots 冷启动先把各 Bot 持久代次预载入本地 map，
  // beginStop 同步 ++ 即恒大于任何旧进程代次——旧进程遗留队列条目的
  // stopEpoch 恒 ≤ 当前计数，cancelQueued 按代次覆盖绝不漏取消；
  // 并发首批 submit 捕获同值（0 基线）不互相误作废。doc.stopPending 是崩溃恢复标记。
  const stopArmed = new Set();      // botId：在飞停止协调（abort 未结算）
  const stopEpochs = new Map();     // botId -> 停止代次（持久单调，预载对齐）
  const pendingWebhookStops = new Map(); // botId -> 待中心确认代次，不占本地停止 gate
  let closing = false;

  /** 该 Bot 停止 gate 是否激活：beginStop 已 arm，abort 尚未成功结算。 */
  function stopped(botId) {
    return stopArmed.has(botId);
  }

  /** 当前停止代次（恒定义整数）；runtime.submit 在任何 await/排队前捕获随受理持久化。 */
  function stopEpoch(botId) {
    return stopEpochs.get(botId) ?? 0;
  }

  function webhookStopPending(botId) {
    return pendingWebhookStops.has(botId);
  }

  async function getStopStates() {
    return host.listBots().map((bot) => ({
      botId: bot.botId,
      stopEpoch: stopEpoch(bot.botId),
      pendingStopEpoch: pendingWebhookStops.get(bot.botId) ?? null,
    }));
  }

  async function acknowledgeStop(botId, epoch) {
    const bot = host.getBot(botId);
    if (!bot || pendingWebhookStops.get(botId) !== epoch) return;
    const cleared = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      if (doc.pendingWebhookStopEpoch !== epoch || pendingWebhookStops.get(botId) !== epoch) return false;
      doc.pendingWebhookStopEpoch = null;
      return true;
    }, context);
    // 新停止可能在旧确认提交期间立 gate：旧确认不能清新代次或其 live 提示。
    if (cleared && pendingWebhookStops.get(botId) === epoch) {
      pendingWebhookStops.delete(botId);
      live?.setWebhookStopPending?.(botId, false);
    }
  }

  /** 新输入已被接受且未被停止作废：仅清掉已结算的 stopped 覆盖。
      stopping/interrupting 由停止协调与抢占窗口持有：在飞期间绝不覆盖。 */
  function clearStopped(botId) {
    if (stopped(botId) || pumpInFlight.has(botId)) return;
    try { live?.setBotControl?.(botId, null); } catch { /* live lane 尚未实现时静默跳过 */ }
  }

  /** 停止 gate 第一步：armed 标记与本地代次推进必须在首个 await 前落地——
      此后任何捕获旧代次的在飞 submit 均被同事务对账作废，在飞准入也恒见忙。
      本地计数经 pendingStops 预载已对齐持久值，同步 ++ 即跨进程单调；
      持久提交同时写本地 stopPending 与中心待确认代次。落盘失败不解除 gate。
      返回取消边界（推进前代次）：≤ 该值的受理属于停止前积压，由 cancelQueued 作废。 */
  function beginStop(bot) {
    const boundary = stopEpochs.get(bot.botId) ?? 0;
    stopEpochs.set(bot.botId, boundary + 1);
    stopArmed.add(bot.botId);
    pendingWebhookStops.set(bot.botId, boundary + 1);
    live?.setWebhookStopPending?.(bot.botId, true);
    return harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      doc.stopEpoch = stopEpochs.get(bot.botId);
      doc.stopPending = true;
      doc.pendingWebhookStopEpoch = doc.stopEpoch;
      const index = await tx.doc(PrimaryIndex);
      const nativeId = index.byPrimary[bot.primaryConversationId];
      if (nativeId !== undefined) await clearBotBoardResult(tx, nativeId);
    }, context).then(() => boundary);
  }

  /** 停止协调结算：仅取消成功才解除 gate、清持久 stopPending 并置 live stopped；
      失败保留 gate 与调用方已置的可见 stopping，绝不伪装成功/偷偷放行旧工作。
      stopPending 清理提交必须成功才释放 gate——提交失败时保持 armed 并抛错，
      持久标记留给崩溃恢复路径重试。成功后 nudge：停止期间受理的新代次输入即可泵。 */
  async function settleStop(botId, err = null) {
    if (err !== null) return;
    const bot = host.getBot(botId);
    if (bot) {
      await harness().commit(async (tx) => {
        const doc = await queueDoc(tx, bot.primaryConversationId);
        doc.stopPending = false;
        const index = await tx.doc(PrimaryIndex);
        const nativeId = index.byPrimary[bot.primaryConversationId];
        if (nativeId !== undefined) await clearBotBoardResult(tx, nativeId);
      }, context);
    }
    stopArmed.delete(botId);
    try { live?.setBotControl?.(botId, 'stopped'); } catch { /* live 缺席 */ }
    nudge(botId);
  }

  /** 冷启动恢复：进程崩溃丢失内存 gate，持久 stopPending 仍标记未完成停止。
      返回带未完成停止标记的 Bot 并 arm 本进程 gate——恢复确认前任何在飞准入/
      工作授予都恒见忙，绝不放行。调用方在任何 harness.resume 前逐个完成
      user_stop 标记与主会话取消标记（quiesce=false），成功后 settleStop 清除。
      快照失败直接抛出：绝不跳过未知停止假装干净。 */
  async function pendingStops() {
    const bots = [];
    for (const bot of host.listBots()) {
      const doc = await harness().snapshot(TurnQueue, bot.primaryConversationId, context);
      if (!stopEpochs.has(bot.botId)) {
        stopEpochs.set(bot.botId, doc?.stopEpoch ?? 0);
        if (doc?.pendingWebhookStopEpoch != null) {
          pendingWebhookStops.set(bot.botId, doc.pendingWebhookStopEpoch);
          live?.setWebhookStopPending?.(bot.botId, true);
          if (doc.stopPending !== true) live?.setBotControl?.(bot.botId, 'stopped');
        }
        const items = doc?.items ?? [];
        publishQueue(bot.botId, items);
      }
      if (doc?.stopPending === true) {
        stopArmed.add(bot.botId);
        live?.setBotControl?.(bot.botId, 'stopping');
        bots.push(bot);
      }
    }
    return bots;
  }

  function toHostQueuedItems(items) {
    const aliveUsers = items.filter((entry) => entry.phase !== 'cancelled' && entry.origin?.sender?.kind === 'user');
    const steer = aliveUsers.filter((entry) => entry.delivery === 'steer');
    const followUp = aliveUsers.filter((entry) => entry.delivery !== 'steer');
    return [...steer, ...followUp].slice(0, MAX_QUEUED_ITEMS).map((entry) => ({
      requestId: entry.requestId,
      delivery: entry.delivery === 'steer' ? 'steer' : 'followUp',
      preview: buildQueuedPreview(entry.text),
      attachmentCount: Array.isArray(entry.attachments) ? Math.min(16, entry.attachments.length) : 0,
    }));
  }

  function publishQueue(botId, items) {
    const aliveCount = items.filter((entry) => entry.phase !== 'cancelled').length;
    try {
      live?.setTurnAdmission?.(botId, toTurnAdmissionStatus(headItem(items)), aliveCount, toHostQueuedItems(items));
    } catch { /* live 尚未实现 setTurnAdmission 或已关闭：不阻断准入 */ }
  }

  async function syncPublishedQueue(bot) {
    publishQueue(bot.botId, await readQueue(bot.primaryConversationId));
  }

  function queueDoc(tx, primaryConversationId) {
    return tx.doc(TurnQueue, primaryConversationId, {});
  }

  async function readQueue(primaryConversationId) {
    const doc = await harness().snapshot(TurnQueue, primaryConversationId, context);
    return doc?.items ?? [];
  }

  // 只计仍待准入/未原生提交的受理；cancelled 终态记录保留可查但不占队列数。
  async function queuedCount(bot) {
    return (await readQueue(bot.primaryConversationId)).filter((entry) => entry.phase !== 'cancelled').length;
  }

  /** Passive board bootstrap: restore the same admission projection without pumping. */
  async function refreshActivity(botId) {
    const bot = host.getBot(botId);
    const doc = await harness().snapshot(TurnQueue, bot.primaryConversationId, context);
    const items = doc?.items ?? [];
    publishQueue(botId, items);
    if (doc?.stopPending) live.setBotControl(botId, 'stopping');
  }

  /** 更新条目阶段并广播准入状态（head 条目即对外可见状态）。 */
  async function setPhase(bot, requestId, phase, error = null) {
    const item = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const found = doc.items.find((entry) => entry.requestId === requestId);
      // cancelled 是终态：在飞泵的迟到状态更新不得把已取消受理复活为其他阶段。
      if (!found || found.phase === 'cancelled') return null;
      found.phase = phase;
      found.error = error;
      found.updatedAt = new Date().toISOString();
      return { ...found };
    }, context);
    await syncPublishedQueue(bot);
    return item;
  }

  /** 准入 head 选取（liveHead 与 pump 共用）：跳过 cancelled 终态受理记录，
      各类内 FIFO（enqueuedAt 序），用户 steer 先于用户 followUp、先于 host 来源——
      直接用户输入优先于计划任务等 Host 来源轮，绝不只取列表第一个。 */
  function headItem(items) {
    const alive = items.filter((entry) => entry.phase !== 'cancelled');
    return (
      alive.find((entry) => entry.origin?.sender?.kind === 'user' && entry.delivery === 'steer') ??
      alive.find((entry) => entry.origin?.sender?.kind === 'user') ??
      alive[0] ??
      null
    );
  }

  /** 对外可见的准入 head：与泵同一选取函数（用户优先、类内 FIFO）。 */
  async function liveHead(bot) {
    return headItem(await readQueue(bot.primaryConversationId));
  }

  /** 条目仍在队列中且未被 abort/Stop 取消（cancelled 是终态，不视为存活可提交）。 */
  async function itemAlive(bot, requestId) {
    const items = await readQueue(bot.primaryConversationId);
    const found = items.find((entry) => entry.requestId === requestId) ?? null;
    return found && found.phase !== 'cancelled' ? found : null;
  }

  /** 该 Bot 已映射的全部原生会话 ID：primary + 每个 work 绑定（协调/遗留存储目标，
      不展开统一执行目标——统一执行落在 primary，本身已在列表内）。 */
  async function mappedNativeIds(bot) {
    const h = harness();
    const nativeIds = [];
    const primaryIndex = await h.snapshot(PrimaryIndex, context);
    const primary = primaryIndex?.byPrimary?.[bot.primaryConversationId];
    if (primary !== undefined) nativeIds.push(primary);
    const workIndex = await h.snapshot(WorkIndex, context);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      let pair = null;
      try { pair = JSON.parse(key); } catch { pair = null; }
      if (Array.isArray(pair) && pair[0] === bot.botId) nativeIds.push(binding.nativeId);
    }
    return nativeIds;
  }

  /** 单个原生会话上是否有未完结任务/提交。 */
  async function nativeConversationBusy(nativeId) {
    const inspection = await harness().inspect(context);
    return inspection.submissions.some((s) => s.conversationId === nativeId) ||
           inspection.tasks.some((t) => t.record.conversationId === nativeId);
  }

  /** 该 Bot 全部映射会话上的原生未完结任务/提交（含 work 会话）。
      withPluginOps=false 时不把插件自身贡献调用算作忙：同 set 的排队轮
      不解除绑定，不需要等插件调用排空。
      取消确认前另一轮不得争用 Bot 资源：停止 gate 激活时恒报忙，绝不放行在飞提交。 */
  async function botNativeBusy(bot, { withPluginOps = true } = {}) {
    if (stopped(bot.botId)) return true;
    if (withPluginOps && plugins.hasActiveExecutions(bot.botId)) return true;
    const nativeIds = await mappedNativeIds(bot);
    if (nativeIds.length === 0) return false;
    const known = new Set(nativeIds);
    const inspection = await harness().inspect(context);
    return inspection.submissions.some((s) => known.has(s.conversationId)) ||
           inspection.tasks.some((t) => known.has(t.record.conversationId));
  }

  /** 驱动层新工作授予 gate：排队的用户轮优先于后台工作（queued 即为显式
      用户优先，无需检查 phase），且本 Bot 任一原生会话仍忙（含遗留 work
      会话上的旧执行）时不得再发 grant。仅存在 background pending 记录本身
      不算忙/死锁——本函数只看原生活动与 Host 队列。
      停止 gate 激活时恒为 false：取消确认前绝不给后台工作发新 grant。 */
  async function canRunWork(botId) {
    if (closing || !canAdmit() || stopped(botId)) return false;
    const bot = host.getBot(botId);
    if (!bot) return false;
    if ((await readQueue(bot.primaryConversationId))
        .some((entry) => entry.phase !== 'cancelled')) return false;
    return !(await botNativeBusy(bot));
  }

  /** 目标 set 与原子的 set 切换边界：不同 set 需全 Bot 原生空闲（含插件执行），
      相同 set 只要求会话本身空闲即可提交（宿主排队条目与未提交决策不算执行）。 */
  async function botBusyForSet(bot, needsSwitch) {
    if (needsSwitch) return botNativeBusy(bot, { withPluginOps: true });
    return botNativeBusy(bot, { withPluginOps: false });
  }

  /** 该 Bot 是否仍有可抢占的非用户 pending work：sender.kind=user 的群用户任务不动，
      无存活 pending 时直接跳过，不为空转 Bot 闪让位提示。 */
  async function hasPreemptableWork(botId) {
    const h = harness();
    const workIndex = await h.snapshot(WorkIndex, context);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      let pair = null;
      try { pair = JSON.parse(key); } catch { pair = null; }
      if (!Array.isArray(pair) || pair[0] !== botId) continue;
      const state = await h.snapshot(WorkDecisionState, binding.nativeId, context);
      const pending = state?.pending;
      if (!pending || pending.interruption != null || state.stopped || state.error) continue;
      if (pending.turn?.sender?.kind === 'user') continue;
      return true;
    }
    return false;
  }

  /** 用户轮 head 实际准入前的抢占边界：直接用户输入让同 Bot 非用户来源 work
      （群/DM/迟到续轮等）先停下，Host 来源轮与 pending.turn.sender.kind=user 的
      群用户任务不动。preemptWork 由 work lane 提供；缺席时静默跳过（旧装配）。
      无可抢占 work 时不置 interrupting：避免对无工作 Bot 不停闪让位提示。 */
  async function preemptForUserTurn(bot, item) {
    if (item.origin?.sender?.kind !== 'user' || !preemptWork) return;
    if (!(await hasPreemptableWork(bot.botId))) return;
    try { live?.setBotControl?.(bot.botId, 'interrupting'); } catch { /* live 缺席 */ }
    try {
      await preemptWork(bot.botId);
    } finally {
      // 仅停止 gate 未激活时才解除 interrupting：并发手停的 stopping/stopped
      // 由停止协调持有，抢占窗口绝不覆盖；取消失败如实上抛给准入失败路径。
      if (!stopped(bot.botId)) {
        try { live?.setBotControl?.(bot.botId, null); } catch { /* live 缺席 */ }
      }
    }
  }

  /** 从 TurnPreparation 提取该 Bot 的目标选择/能力/凭据并原子切换；失败抛错（不留半 set）。 */
  async function applyPreparation(bot, preparation) {
    const snapshot = preparation?.snapshot;
    if (!snapshot || snapshot.protocol !== 1) throw errWithCode('turn preparation is invalid', 'TURN_SYNC_FAILED');
    const target = (snapshot.bots ?? []).find((entry) => entry.botId === bot.botId) ?? null;
    const capabilities = target?.capabilities ?? [];
    const credentials = snapshot.credentials ?? {};
    const selection = target?.model ?? null;
    if (selection?.modelRef != null) {
      const ref = parseModelRef(selection.modelRef);
      if (!models.getModel(ref.provider, ref.modelId)) {
        throw errWithCode('center selected model is unavailable', 'TURN_SYNC_FAILED');
      }
    }
    // 目录校验在任何模型/插件/cwd 状态变化之前完成；非法 set 即同步失败。
    const pinnedCwd = typeof target?.cwd === 'string' && target.cwd !== bot.cwd ? target.cwd : null;
    if (pinnedCwd !== null) host.assertBotCwd({ cwd: pinnedCwd });
    if (selection) {
      const nextModels = { ...getBotModels() };
      nextModels[bot.botId] = selection;
      setBotModels(nextModels);
    }
    // pinned set 的目录先于插件与 profile 落地：持久化、会话 AgentDoc 与执行
    // 环境都完成后才算本 set 生效；恢复轮重放同一快照即恢复同一目录。
    const current = pinnedCwd !== null ? await applyBotCwd(bot, pinnedCwd) : bot;
    const applied = await plugins.applyBot(current, capabilities, {
      deviceId: host.deviceId,
      credentials,
      atomic: true,
      setId: preparation.setId,
    });
    if ((applied?.capabilityErrors ?? []).length > 0) {
      throw errWithCode('turn capability set could not be applied', 'TURN_SYNC_FAILED');
    }
    setBotFingerprint(bot.botId, botExecutionFingerprint(selection, capabilities, credentials, current.cwd));
    if (Number.isSafeInteger(snapshot.revision)) setBotAppliedRevision(bot.botId, snapshot.revision);
    appliedSetIds.set(bot.botId, preparation.setId);
  }

  /** 准入失败：条目转 failed、保留正文供同 requestId 重试，并按退避安排自动重试。 */
  async function failItem(bot, item, err) {
    const bounded = boundedTurnError(err);
    await setPhase(bot, item.requestId, 'failed', bounded);
    const attempts = (retryAttempts.get(bot.botId) ?? 0) + 1;
    retryAttempts.set(bot.botId, attempts);
    if (attempts <= RETRY_MAX_ATTEMPTS && !closing) {
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      const timer = setTimeout(() => {
        retryTimers.delete(bot.botId);
        nudge(bot.botId);
      }, delay);
      timer.unref?.();
      retryTimers.set(bot.botId, timer);
    }
    return bounded;
  }

  /** 判断当前是否可将本机用户主私聊输入以 steer 注入正在运行的用户主私聊轮次：
      仅当主会话存在活跃 run、无阻塞压缩、无其他映射会话活动且活跃 run 归属为用户主私聊时返回 true。 */
  async function canSteerActivePrimary(bot) {
    if (stopped(bot.botId)) return false;
    const h = harness();
    const conversation = await getPrimaryConversation(h, bot, {}, context);
    if (!conversation) return false;
    const nativeIds = await mappedNativeIds(bot);
    const otherIds = new Set(nativeIds.filter((id) => id !== conversation.id));
    if (otherIds.size > 0) {
      const inspection = await h.inspect(context);
      if (
        inspection.submissions.some((s) => otherIds.has(s.conversationId)) ||
        inspection.tasks.some((t) => otherIds.has(t.record.conversationId))
      ) {
        return false;
      }
    }
    const liveDoc = await h.snapshot(LiveDoc, conversation.id, context);
    if (liveDoc?.run?.taskId == null) return false;
    if (Array.isArray(liveDoc.compactions) && liveDoc.compactions.some((c) => c?.blocking === true)) return false;
    const sessionState = await h.snapshot(BotSessionState, conversation.id, context);
    const taskKey = String(liveDoc.run.taskId);
    const mappedRequestId = sessionState?.turnByTask?.[taskKey];
    const activeTurn = typeof mappedRequestId === 'string'
      ? (sessionState?.completedTurns?.[mappedRequestId] ??
         (sessionState?.activeTurn?.requestId === mappedRequestId ? sessionState.activeTurn : null))
      : (sessionState?.activeTurn?.taskId != null && String(sessionState.activeTurn.taskId) === taskKey
          ? sessionState.activeTurn
          : null);
    if (activeTurn) {
      return (
        activeTurn.kind === 'primary' &&
        activeTurn.sender?.kind === 'user' &&
        activeTurn.workNativeId === undefined
      );
    }
    if (Number.isSafeInteger(liveDoc.run.first) && liveDoc.run.first > 0) {
      const firstEntry = await h.commit((tx) => tx.entry(liveDoc.run.first), context).catch(() => null);
      const attr = firstEntry ? deriveEntryAttribution(firstEntry, sessionState) : null;
      return attr?.kind === 'user' && attr?.channel === 'primary';
    }
    return false;
  }

  /** 单条 head 条目的完整准入：prepare→（需切换时确认空闲）→原子应用→confirm→pin→提交。 */
  async function admitItem(bot, item) {
    const epoch = getEpoch();
    const scopeKey = 'primary';
    const idleFallbackKey = bot.botId + ':' + item.requestId;
    const forceIdle = forceIdlePrep.delete(idleFallbackKey);
    const isUserSteer = !forceIdle && item.delivery === 'steer' && item.origin?.sender?.kind === 'user';
    let steeringActiveRun = false;
    // 1. 已有 admissionId（授予后崩溃或 steer 遇空闲回退重入）：只恢复同一准入，不再向中心新申请。
    let preparation = null;
    let grant = null;
    if (item.admissionId) {
      // 恢复准入的用户 head 同样先抢占非用户 work：崩溃前的授权不豁免用户优先。
      await preemptForUserTurn(bot, item);
      await setPhase(bot, item.requestId, 'synchronizing');
      preparation = await centerRuntime.restoreTurn({ botId: bot.botId, admissionId: item.admissionId });
      grant = { admissionId: item.admissionId, setId: preparation.setId };
      const needsSwitch = appliedSetIds.get(bot.botId) !== preparation.setId;
      if (isUserSteer && !needsSwitch && await canSteerActivePrimary(bot)) {
        steeringActiveRun = true;
      } else if (await botBusyForSet(bot, needsSwitch)) {
        await setPhase(bot, item.requestId, 'queued');
        return null;
      }
    } else {
      // 2. 先过实际准入边界再查中心：Busy 检查必须在任何可能签发 grant 的操作之前。
      // 过早 prepare 的 knownSetId 快路会持久化 admission——之后排队消息即使本地仍 queued，
      // 恢复时也会沿用旧 set（E2E：问卷等待期排队消息提前拿到旧版 grant）。
      // 本地 appliedSetIds 不足以证明就绪（后台 applyBot 可能已换绑定）：
      // 先用「同 set 仅需会话空闲」的保守 gate 拦住一切早授予，就绪后才真正 prepare/confirm。
      // 用户输入在持久化后、实际准入前抢占同 Bot 非用户 work；被抢占 work 不推进
      // handled 水位，用户队列排空后由 work lane 按相同原始消息重新触发。
      await preemptForUserTurn(bot, item);
      if (await botBusyForSet(bot, false)) {
        if (isUserSteer && await canSteerActivePrimary(bot)) {
          steeringActiveRun = true;
        } else {
          await setPhase(bot, item.requestId, 'queued');
          return null;
        }
      }
      await setPhase(bot, item.requestId, 'checking');
      let lastError = null;
      for (let attempt = 0; attempt < MAX_PREPARE_ATTEMPTS && !preparation; attempt++) {
        if (getEpoch() !== epoch || closing || !canAdmit()) throw errWithCode('host is not connected', 'NOT_CONNECTED');
        try {
          preparation = await centerRuntime.prepareTurn({
            botId: bot.botId,
            requestId: item.requestId,
            scopeKey,
            inputDigest: item.digest,
          });
        } catch (err) {
          if (err?.code === 'TURN_SET_CHANGED' && attempt + 1 < MAX_PREPARE_ATTEMPTS) {
            lastError = err;
            continue;
          }
          throw err;
        }
      }
      if (!preparation) throw lastError ?? errWithCode('turn preparation did not produce a set', 'TURN_SYNC_FAILED');
      // 新准入先拒绝空模型，避免同 requestId 钉住空快照；已有 grant 保持原恢复语义。
      if (!preparation.admission) {
        const target = (preparation.snapshot.bots ?? []).find((entry) => entry.botId === bot.botId);
        if (!target?.model?.modelRef) throw errWithCode('center model is required', 'TURN_SYNC_FAILED');
      }
      // 3. 目标 set 与当前不同才要求全 Bot 原生空闲；相同 set 只要求主会话空闲（steer 允许同 set 注入活跃轮）。
      const needsSwitch = appliedSetIds.get(bot.botId) !== preparation.setId;
      if (needsSwitch && (steeringActiveRun || await botBusyForSet(bot, true))) {
        // 有原生工作在跑且需切换执行集：保持 queued，等原生完成/下个触发点再泵。
        await setPhase(bot, item.requestId, 'queued');
        return null;
      }
      await setPhase(bot, item.requestId, 'synchronizing');
      if (!steeringActiveRun) {
        await applyPreparation(bot, preparation);
      }
      if (getEpoch() !== epoch || closing || !canAdmit()) throw errWithCode('host is not connected', 'NOT_CONNECTED');
      grant = preparation.admission ?? await centerRuntime.confirmTurn({
        botId: bot.botId,
        requestId: item.requestId,
        scopeKey,
        inputDigest: item.digest,
        setId: preparation.setId,
      });
    }
    if (!grant?.admissionId) throw errWithCode('center did not grant admission', 'TURN_SYNC_FAILED');
    // 4. 原子应用（restore 路径的 apply 也在此）；随后持久 pin（grant 先于原生提交落盘）。
    if (item.admissionId && !steeringActiveRun) await applyPreparation(bot, preparation);
    const pinTarget = (preparation.snapshot?.bots ?? []).find((entry) => entry.botId === bot.botId) ?? null;
    const pinModel = pinTarget?.model ?? null;
    const pinCapabilities = (pinTarget?.capabilities ?? []).map((capability) => ({
      installationId: capability.installationId,
      kind: capability.kind,
      target: capability.target,
      targetVersion: capability.targetVersion,
      authorized: capability.authorized ?? capability.enabled === true,
      effectiveConfig: capability.effectiveConfig ?? null,
      credentialRevisions: capability.credentialRevisions ?? null,
    }));
    await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const found = doc.items.find((entry) => entry.requestId === item.requestId);
      // pin 落盘前的最后取消核对：cancelled 是终态，绝不给已取消轮持久 pin。
      if (!found || found.phase === 'cancelled') throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
      found.admissionId = grant.admissionId;
      found.setId = grant.setId ?? preparation.setId;
      const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
      pins.admissions[grant.admissionId] = {
        admissionId: grant.admissionId,
        setId: grant.setId ?? preparation.setId,
        botId: bot.botId,
        requestId: item.requestId,
        scopeKey,
        model: pinModel ? {
          modelRef: pinModel.modelRef ?? null,
          thinkingLevel: pinModel.thinkingLevel ?? null,
          codemode: pinModel.codemode ?? null,
          codemodeOnly: pinModel.codemodeOnly ?? null,
        } : null,
        capabilities: pinCapabilities,
        submissionId: null,
        admittedAt: grant.admittedAt ?? new Date().toISOString(),
      };
    }, context);

    // 5. 会话与 profile：pin 落盘后才允许任何模型执行。
    const modelRef = getBotModels()[bot.botId]?.modelRef;
    if (!modelRef) throw errWithCode('center model is required', 'TURN_SYNC_FAILED');
    {
      const ref = parseModelRef(modelRef);
      if (!models.getModel(ref.provider, ref.modelId)) {
        throw errWithCode('center model is unavailable', 'TURN_SYNC_FAILED');
      }
    }
    const profile = profileFor(bot.botId, null);
    // applyPreparation 可能已切换 cwd：会话创建与绑定一律读取持久化的最新记录。
    const current = host.getBot(bot.botId) ?? bot;
    let conversation = await getPrimaryConversation(harness(), current, {}, context);
    if (!conversation) {
      const modelRef = getBotModels()[bot.botId]?.modelRef;
      const ref = parseModelRef(modelRef);
      if (!models.getModel(ref.provider, ref.modelId)) {
        throw errWithCode('model not found: ' + modelRef, 'TURN_SYNC_FAILED');
      }
      conversation = await getPrimaryConversation(harness(), { ...current, modelRef }, {
        create: true,
        defaultModel: modelRef,
        thinkingLevel: profile.thinkingLevel,
        instructions: profile.instructions,
        removeTools: profile.removeTools,
        codemodeOnly: profile.codemodeOnly,
      }, context);
    }
    const stillSteering = isUserSteer && await canSteerActivePrimary(bot);
    if (!stillSteering) {
      await applyAgentProfile(harness(), conversation.id, profile, context);
    }
    await live.bind(bot.botId, conversation);
    // 正文摘要按会话持久化：已原生提交请求的幂等查重（含崩溃后重放）。
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(RequestKeys, conversation.id);
      const key = 'r:' + item.requestId;
      const got = doc.digests[key];
      if (got !== undefined && got !== item.digest) {
        throw errWithCode('requestId already used with different text: ' + item.requestId, 'REQUEST_CONFLICT');
      }
      doc.digests[key] = item.digest;
    }, context);

    // 6. 提交前最后一次核对条目仍存活（abort/关闭可能刚删了它）。
    const alive = await itemAlive(bot, item.requestId);
    if (!alive || getEpoch() !== epoch || closing || !canAdmit()) {
      throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
    }
    // 授予后崩溃重放：原生会话可能已记录同一 requestId 的提交（submit 成功、step7 删队列前崩溃）。
    // 命中即修复 pin/queue 链接并采用原回执，绝不向 SDK 重投产生第二次模型执行。
    const priorRecord = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, item.requestId), context);
    if (priorRecord) {
      await harness().commit(async (tx) => {
        const doc = await queueDoc(tx, bot.primaryConversationId);
        const index = doc.items.findIndex((entry) => entry.requestId === item.requestId);
        if (index >= 0) doc.items.splice(index, 1);
        const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
        if (pins.admissions[grant.admissionId]) {
          pins.admissions[grant.admissionId].submissionId = priorRecord.id;
        }
      }, context);
      await syncPublishedQueue(bot);
      if (priorRecord.status === 'queued' || priorRecord.status === 'placed') {
        trackSubmission(priorRecord.id, { botId: bot.botId, nativeId: conversation.id });
      }
      const formatted = await formatPrimarySubmission(harness(), bot, priorRecord, context);
      if (formatted.status === 'done') recordCompletedSubmission(bot.botId, formatted);
      return formatted;
    }
    const agent = await conversation.agent(context);
    const convModel = agent.model;
    const convModelRecord = convModel ? models.getModel(convModel.provider, convModel.modelId) : null;
    if (!convModel || !convModelRecord) {
      throw errWithCode('model is required', 'TURN_SYNC_FAILED');
    }
    // 带图提交前明确校验模型视觉能力与 provider inputLimits（无声明时按 Host 上限已满足）。
    const attachmentMeta = Array.isArray(item.attachments) ? item.attachments : [];
    if (attachmentMeta.length > 0) {
      const modalities = Array.isArray(convModelRecord.input) ? convModelRecord.input : ['text'];
      if (!modalities.includes('image')) {
        throw errWithCode('model does not accept image input', 'MODEL_NO_VISION');
      }
      const imageLimits = convModelRecord.inputLimits?.images ?? null;
      if (imageLimits) {
        const maxPerMessage = imageLimits.maxPerMessage;
        if (Number.isSafeInteger(maxPerMessage) && attachmentMeta.length > maxPerMessage) {
          throw errWithCode('model accepts at most ' + maxPerMessage + ' images per message', 'INVALID_ARGUMENT');
        }
        const resize = imageLimits.resize;
        // provider maxBytes 按 base64 编码长度计（resize profile 语义），不能拿解码后 size 比。
        const maxBytes = resize?.maxBytes;
        const maxWidth = resize?.maxWidth;
        const maxHeight = resize?.maxHeight;
        for (const meta of attachmentMeta) {
          if (Number.isSafeInteger(maxBytes) && 4 * Math.ceil(meta.size / 3) > maxBytes) {
            throw errWithCode('attachment exceeds model image byte limit', 'INVALID_ARGUMENT');
          }
          if (Number.isSafeInteger(maxWidth) && meta.width > maxWidth) {
            throw errWithCode('attachment exceeds model image width limit', 'INVALID_ARGUMENT');
          }
          if (Number.isSafeInteger(maxHeight) && meta.height > maxHeight) {
            throw errWithCode('attachment exceeds model image height limit', 'INVALID_ARGUMENT');
          }
        }
      }
    }
    let content = item.text;
    if (attachmentMeta.length > 0) {
      const blocks = [];
      if (item.text.trim() !== '') blocks.push({ type: 'text', text: item.text });
      for (const meta of attachmentMeta) {
        const loaded = await attachments.load(bot.botId, meta.id);
        blocks.push({
          type: 'text',
          text: 'Attached image on this Host (use this path to read or send the file): ' +
            JSON.stringify({ name: meta.name, path: attachments.path(bot.botId, meta.id) }),
        });
        blocks.push({ type: 'image', data: loaded.data, mimeType: meta.mimeType });
      }
      content = blocks;
    }
    // 停止 gate 内绝不放行在飞准入到原生提交：取消确认前无新执行。
    if (stopped(bot.botId)) {
      await setPhase(bot, item.requestId, 'queued');
      return null;
    }
    const wantSteer = (item.delivery === 'steer' || alive.delivery === 'steer') && item.origin?.sender?.kind === 'user';
    const steerNow = !forceIdle && wantSteer && await canSteerActivePrimary(bot);
    if (!steerNow) {
      // 安全轮边界：提交前把该 Bot 全部收件 scope 增量导入统一主会话，
      // 迟到回复/群消息进入本轮上下文；导入水位在 sessions 内原子提交。
      if (sessions) await sessions.sync(bot.botId);
      // sync 的多个 await 期间后台工作可能已占会话：提交是最后一个 grant，
      // 提交前必须复核会话仍空闲，busy 则保持 queued 等下次泵（提交拒忙兜底）。
      if (await botNativeBusy(bot, { withPluginOps: false })) {
        if (!(wantSteer && await canSteerActivePrimary(bot))) {
          await setPhase(bot, item.requestId, 'queued');
          return null;
        }
      }
    }
    const skippedIdlePrep = steeringActiveRun || stillSteering || steerNow;
    const entry = sourceMessageEntry(item);
    if (attachmentMeta.length > 0) entry.data.attachments = attachmentMeta;
    let submission;
    try {
      if (!(await itemAlive(bot, item.requestId)) || closing) {
        throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
      }
      if (!canAdmit()) throw errWithCode('host is preparing an update', 'RUNTIME_BUSY');
      submission = await conversation.submit(
        {
          type: 'input',
          content,
          requestId: item.requestId,
          whenBusy: wantSteer ? 'steer' : 'reject',
          ...(skippedIdlePrep ? { whenIdle: 'reject' } : {}),
          entry,
        },
        context,
      );
    } catch (err) {
      if (err instanceof ConversationBusy) {
        // 空闲检查与提交之间原生工作先到：保持 queued，等下次触发再泵。
        await setPhase(bot, item.requestId, 'queued');
        return null;
      }
      if (err instanceof ConversationIdle) {
        // steer 快路跳过了空闲期同步/准备，但活跃轮在微任务间隙刚完结：回退为 queued 并按标准空闲路径重泵。
        forceIdlePrep.add(idleFallbackKey);
        await setPhase(bot, item.requestId, 'queued');
        nudge(bot.botId);
        return null;
      }
      throw err;
    }
    // 关闭提交竞态窗口：提交在飞期间 abort/Stop 已把条目转 cancelled——按 requestId 精准
    // 中止刚提交的原生 submission，绝不 conversation.abort 误伤可能已进入的后轮。
    if (!(await itemAlive(bot, item.requestId)) || closing) {
      try {
        const h = harness();
        const record = await h.commit((tx) => tx.submissionByRequest(conversation.id, item.requestId), context);
        if (record && (record.status === 'queued' || record.status === 'placed')) {
          await h.abortSubmission(record.id, context, conversation.id);
        }
      } catch { /* 中止失败不掩盖取消事实 */ }
      throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
    }
    const statusRecord = await submission.status(context);
    // 7. 原生提交成功：条目出队并把 submissionId 回写 pin（同一 commit）。
    // 出队与 pin 链接同事务核对 cancelled：若在 itemAlive 之后至此事务前被并发撤回/取消，
    // 绝不把 submissionId 写入 pin（同时清理未绑定 pin），并在事务后补调 abortSubmission。
    const cancelledMidFlight = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const index = doc.items.findIndex((entry) => entry.requestId === item.requestId);
      const found = index >= 0 ? doc.items[index] : null;
      const cancelled = !found || found.phase === 'cancelled';
      const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
      if (!cancelled) {
        doc.items.splice(index, 1);
        if (pins.admissions[grant.admissionId]) {
          pins.admissions[grant.admissionId].submissionId = statusRecord.id;
        }
      } else if (pins.admissions[grant.admissionId]?.submissionId == null) {
        delete pins.admissions[grant.admissionId];
      }
      return cancelled;
    }, context);
    if (cancelledMidFlight) {
      if (statusRecord.status === 'queued' || statusRecord.status === 'placed') {
        await harness().abortSubmission(statusRecord.id, context, conversation.id).catch(() => {});
      }
      await syncPublishedQueue(bot);
      throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
    }
    trackSubmission(statusRecord.id, { botId: bot.botId, nativeId: conversation.id });
    await syncPublishedQueue(bot);
    const formatted = await formatPrimarySubmission(harness(), bot, statusRecord, context);
    if (formatted.status === 'done') recordCompletedSubmission(bot.botId, formatted);
    return formatted;
  }

  /** 泵一条（可能重入下一轮 head）；每次新轮都会重新过中心确认，绝不合并 followup。
      'cancelled' 条目是对账用的终态受理记录，不是可泵的 head：跳过它们，绝不重投已取消的轮。 */
  async function pump(bot) {
    if (closing || !canAdmit()) return;
    if (bot.archivedAt !== null && bot.archivedAt !== undefined) return;
    const items = await readQueue(bot.primaryConversationId);
    const item = headItem(items);
    if (!item) {
      publishQueue(bot.botId, items);
      return;
    }
    try {
      const result = await admitItem(bot, item);
      retryAttempts.delete(bot.botId);
      if (result !== null && !closing) {
        // head 已原生提交：下一条排队消息是新的轮，重新走准入（会话 busy 时自然留在队列）。
        await pump(bot);
      }
    } catch (err) {
      if (closing) return;
      const current = await itemAlive(bot, item.requestId);
      if (current) await failItem(bot, current, err);
    }
  }

  function nudge(botId) {
    if (closing) return;
    if (pumpInFlight.has(botId)) {
      pumpAgain.add(botId);
      return;
    }
    const bot = host.getBot(botId);
    if (!bot) return;
    pumpInFlight.add(botId);
    const runPump = async () => {
      do {
        pumpAgain.delete(botId);
        const latestBot = host.getBot(botId);
        if (!latestBot || closing) break;
        await pump(latestBot);
      } while (pumpAgain.has(botId) && !closing);
    };
    const task = admitBot(botId, runPump);
    const clear = () => {
      pumpInFlight.delete(botId);
      if (pumpAgain.has(botId) && !closing) {
        pumpAgain.delete(botId);
        nudge(botId);
      }
    };
    task.then(clear, clear);
    task.catch(() => {});
  }

  async function nudgeAll() {
    if (closing) return;
    for (const bot of host.listBots()) {
      try {
        if ((await readQueue(bot.primaryConversationId)).length > 0) nudge(bot.botId);
      } catch { /* 忽略单 Bot 读队列失败 */ }
    }
  }

  /**
   * runtime.submit 的新实现：先持久化受理（同 requestId 不同正文冲突；同正文幂等重试），
   * 立即返回 queued 回执；实际准入/提交由泵异步完成。
   */
  async function enqueue(botId, input) {
    // 停止代次必须在任何 await/排队前由调用方捕获（input.stopEpoch，恒定义整数）：
    // 受理晚于停止的在飞 submit 以旧代次持久化，同事务内被作废为 cancelled 回执，
    // 绝不复活。停止之后受理的新代次输入允许新运行。
    const capturedStopEpoch = Number.isSafeInteger(input?.stopEpoch) ? input.stopEpoch : 0;
    const requestId = input?.requestId;
    const text = input?.text;
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw errWithCode('requestId must be a non-empty string', 'INVALID_ARGUMENT');
    }
    const rawDelivery = input?.delivery;
    if (rawDelivery !== undefined && rawDelivery !== 'followUp' && rawDelivery !== 'steer') {
      throw errWithCode("delivery must be 'followUp' or 'steer'", 'INVALID_ARGUMENT');
    }
    const delivery = rawDelivery === 'steer' ? 'steer' : 'followUp';
    const attachmentIds = normalizeAttachmentIds(input?.attachments);
    if (typeof text !== 'string' || (text.trim() === '' && attachmentIds.length === 0)) {
      throw errWithCode('text must be a non-empty string', 'INVALID_ARGUMENT');
    }
    // 无附件沿用旧版 SHA256(text) 摘要：升级前排队的旧请求仍能按原摘要幂等/冲突。
    // 有附件则覆盖 text 与有序 id（同 id 不同 name 仍同摘要，重传幂等）。
    const turnDigest = attachmentIds.length === 0
      ? createHash('sha256').update(text).digest('hex')
      : createHash('sha256').update(JSON.stringify({ text, attachments: attachmentIds })).digest('hex');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode('bot not found: ' + botId, 'BOT_NOT_FOUND');
    if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
      throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
    }
    // 已有原生提交（重试已受理请求）：直接返回原回执，绝不产生第二条消息。
    const conversation0 = await getPrimaryConversation(harness(), bot, {}, context);
    if (conversation0) {
      const existing = await harness().commit(async (tx) => {
        const record = await tx.submissionByRequest(conversation0.id, requestId);
        if (record === undefined) return undefined;
        // 同 requestId 不同正文必须冲突，不能静默返回原回执。
        const keys = await tx.doc(RequestKeys, conversation0.id);
        const want = turnDigest;
        const got = keys.digests['r:' + requestId];
        if (got !== undefined && got !== want) {
          throw errWithCode('requestId already used with different text: ' + requestId, 'REQUEST_CONFLICT');
        }
        return record;
      }, context);
      if (existing !== undefined) {
        if (existing.status === 'queued' || existing.status === 'placed') {
          trackSubmission(existing.id, { botId, nativeId: conversation0.id });
        }
        const formatted = await formatPrimarySubmission(harness(), bot, existing, context);
        if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
        return formatted;
      }
    }
    const origin = normalizeUserOrigin(input.origin);
    const digest = turnDigest;
    // 队列只存 id+展示元数据；提交时从盘读字节，重启/重试不丢附件、不重新产生 requestId。
    const attachmentMeta = [];
    let attachmentBytes = 0;
    for (const id of attachmentIds) {
      const meta = await attachments.load(botId, id);
      attachmentBytes += meta.size;
      attachmentMeta.push({ id: meta.id, name: meta.name, mimeType: meta.mimeType, size: meta.size, width: meta.width, height: meta.height });
    }
    // 每条消息图片总字节上限：单张合法（≤16MiB）的图仍受总量限制，超限整体拒绝。
    if (attachmentBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw errWithCode('attachments exceed the 64 MiB per-message total image byte limit', 'INVALID_ARGUMENT');
    }
    const now = new Date().toISOString();
    // 回执在事务内投影为普通元数据；浅拷贝会让 origin/附件保留已结算的 overlay。
    const receipt = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      // 停止 epoch 对账与受理持久化同一事务：捕获的进程代次落后于当前计数，
      // 该受理按作废落 cancelled 终态（保留回执可答），绝不排队待泵。
      // 计数恒定义（0 基线）：并发首批 submit 捕获同值不互相误作废；
      // 持久 doc.stopEpoch 仅审计/崩溃恢复，不与本地计数比较。
      const stale = capturedStopEpoch < (stopEpochs.get(botId) ?? 0);
      const existing = doc.items.find((entry) => entry.requestId === requestId);
      if (existing) {
        if (existing.digest !== digest) {
          throw errWithCode('requestId already used with different text: ' + requestId, 'REQUEST_CONFLICT');
        }
        // 同 requestId 的重复重传：已取消终态绝不复活（真正重发用新 requestId）。
        if (existing.phase === 'cancelled') return toQueuedReceipt(existing);
        if (stale) {
          // 在飞重试撞上停止：受理作废为 cancelled，不再泵旧工作。
          existing.stopEpoch = capturedStopEpoch;
          existing.phase = 'cancelled';
          existing.error = null;
          existing.updatedAt = now;
          return toQueuedReceipt(existing);
        }
        if (delivery === 'steer' && existing.delivery !== 'steer') {
          existing.delivery = 'steer';
          existing.updatedAt = now;
        }
        if (existing.phase === 'failed') {
          // 同 requestId 的显式重试重新武装自动重试：耗尽的退避计数在重试时清零，
          // 避免这次显式尝试再失败后静默失去自动恢复。
          existing.error = null;
          existing.updatedAt = now;
          retryAttempts.delete(botId);
        }
        return toQueuedReceipt(existing);
      }
      const next = {
        requestId,
        botId,
        primaryConversationId: bot.primaryConversationId,
        digest,
        text,
        origin,
        ...(delivery === 'steer' ? { delivery: 'steer' } : {}),
        ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
        phase: stale ? 'cancelled' : 'queued',
        error: null,
        admissionId: null,
        setId: null,
        submissionId: null,
        enqueuedAt: now,
        updatedAt: now,
        // 受理时捕获的本进程停止代次：停止只作废旧代次受理，停止开始后受理的
        // 新代次输入不被 cancelQueued 一锅取消（等停止结算后泵）。
        // 持久化该值供跨进程对账：后续进程预载 TurnQueue.stopEpoch 后恒 ≥ 此值，
        // cancelQueued 按代次覆盖旧进程遗留受理。
        stopEpoch: capturedStopEpoch,
      };
      doc.items.push(next);
      return toQueuedReceipt(next);
    }, context);
    // initializeBot 的 SOUL 回填等可失败工作必须在受理持久化之后：先落队列再初始化，
    // 失败的消息在 Host 端永远有可对账的 queued 记录，而不是无声丢失。
    await initializeBot(botId);
    await syncPublishedQueue(bot);
    // 受理未被停止作废：新的真实输入允许新运行，清掉旧 stopped 覆盖后再泵。
    if (receipt.status === 'queued') {
      clearStopped(botId);
      nudge(botId);
    }
    return receipt;
  }

  /** getSubmission/wait 共用：残留 Host 队列（含 cancelled）不能遮蔽原生 done。 */
  async function queuedReceipt(bot, requestId) {
    const items = await readQueue(bot.primaryConversationId);
    const item = items.find((entry) => entry.requestId === requestId);
    if (!item) return null;
    const h = harness();
    const conversation = await getPrimaryConversation(h, bot, {}, context);
    if (conversation) {
      // 只读终态，不用会隐式 resume 的 wait/abort，也不重新提交或删除取消记录。
      const record = await h.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
      if (record?.status === 'done') {
        const formatted = await formatPrimarySubmission(h, bot, record, context);
        recordCompletedSubmission(bot.botId, formatted);
        return formatted;
      }
    }
    return toQueuedReceipt(item);
  }

  function toWithdrawnTurnItem(entry) {
    const attIds = Array.isArray(entry.attachments)
      ? entry.attachments.map((a) => a?.id).filter((id) => typeof id === 'string')
      : [];
    return {
      requestId: entry.requestId,
      delivery: entry.delivery === 'steer' ? 'steer' : 'followUp',
      text: entry.text,
      ...(attIds.length > 0 ? { attachments: attIds } : {}),
    };
  }

  /** 从主会话 pi.inbox 中精准中止尚未置入轮次的本机用户主私聊提交，并返回实际被撤回的条目。 */
  async function withdrawInboxUserItems(bot, targetRequestId = null) {
    const h = harness();
    const conversation = await getPrimaryConversation(h, bot, {}, context);
    if (!conversation) return [];
    const inbox = await h.snapshot(InboxDoc, conversation.id, context);
    const rawItems = Array.isArray(inbox?.items) ? inbox.items : [];
    const withdrawn = [];
    for (const inboxItem of rawItems) {
      if (!inboxItem || (inboxItem.mode !== 'steer' && inboxItem.mode !== 'followUp')) continue;
      if (inboxItem.entry?.kind !== 'host.user-message') continue;
      const data = inboxItem.entry?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      if (data.attribution?.kind !== 'user' || data.attribution?.channel !== 'primary') continue;
      const reqId = typeof data.requestId === 'string' ? data.requestId : null;
      if (!reqId) continue;
      if (targetRequestId !== null && reqId !== targetRequestId) continue;
      const outcome = await h.abortSubmission(inboxItem.id, context, conversation.id);
      if (outcome === 'aborted') {
        const text = typeof data.userText === 'string'
          ? data.userText
          : extractUserTextFromContent(inboxItem.content);
        const attIds = Array.isArray(data.attachments)
          ? data.attachments.map((a) => a?.id).filter((id) => typeof id === 'string')
          : [];
        withdrawn.push({
          requestId: reqId,
          delivery: inboxItem.mode === 'steer' ? 'steer' : 'followUp',
          text,
          ...(attIds.length > 0 ? { attachments: attIds } : {}),
        });
      }
    }
    return withdrawn;
  }

  /** 不停止当前运行，撤回单条（传 requestId）或全部（省略/null）尚未置入轮次的用户主私聊排队项。 */
  async function withdrawQueued(bot, requestId = null) {
    if (requestId !== null && requestId !== undefined) {
      if (typeof requestId !== 'string' || requestId.trim() === '') {
        throw errWithCode('requestId must be a non-empty string', 'INVALID_ARGUMENT');
      }
    }
    const targetRequestId = requestId ?? null;
    const now = new Date().toISOString();
    // 先置 TurnQueue 匹配项为 cancelled 以阻断在途 admitItem，再排空 InboxDoc（与 stopBotWork 顺序一致）。
    const queueWithdrawn = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const index = await tx.doc(PrimaryIndex);
      const nativeId = index.byPrimary[bot.primaryConversationId];
      const affected = new Set();
      const items = [];
      for (const entry of doc.items) {
        if (entry.phase === 'cancelled') continue;
        if (entry.origin?.sender?.kind !== 'user') continue;
        if (targetRequestId !== null && entry.requestId !== targetRequestId) continue;
        if (nativeId !== undefined) {
          const existing = await tx.submissionByRequest(nativeId, entry.requestId);
          if (existing && (existing.status === 'placed' || existing.status === 'done')) continue;
        }
        if (entry.admissionId) affected.add(entry.admissionId);
        entry.phase = 'cancelled';
        entry.error = null;
        entry.updatedAt = now;
        items.push(toWithdrawnTurnItem(entry));
      }
      if (affected.size > 0) {
        const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
        for (const admissionId of affected) {
          const pin = pins.admissions[admissionId];
          if (pin && (pin.submissionId === null || pin.submissionId === undefined)) {
            delete pins.admissions[admissionId];
          }
        }
      }
      return items;
    }, context);
    const inboxWithdrawn = await withdrawInboxUserItems(bot, targetRequestId);
    if (queueWithdrawn.length > 0 || inboxWithdrawn.length > 0) {
      await syncPublishedQueue(bot);
      if (!stopped(bot.botId) && (await queuedCount(bot)) > 0) {
        nudge(bot.botId);
      }
    }
    const withdrawn = [];
    const seen = new Set();
    for (const item of [...inboxWithdrawn, ...queueWithdrawn]) {
      if (seen.has(item.requestId)) continue;
      seen.add(item.requestId);
      withdrawn.push(item);
    }
    return { botId: bot.botId, withdrawn };
  }

  /** 将已排队的单条用户主私聊消息提升为 steer（优先在当前轮 postTools 边界注入，不影响其余 followUp 顺序）。 */
  async function steerQueued(bot, requestId) {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw errWithCode('requestId must be a non-empty string', 'INVALID_ARGUMENT');
    }
    const promotedInQueue = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const found = doc.items.find((entry) => entry.requestId === requestId);
      if (!found || found.phase === 'cancelled' || found.origin?.sender?.kind !== 'user') {
        return false;
      }
      found.delivery = 'steer';
      if (found.phase === 'failed') {
        found.phase = 'queued';
        found.error = null;
        retryAttempts.delete(bot.botId);
      }
      found.updatedAt = new Date().toISOString();
      return true;
    }, context);
    // 即使 TurnQueue 命中也继续核对主会话 InboxDoc：覆盖 admitItem 已写入 InboxDoc 但尚未从 TurnQueue 删除的迁移窗口。
    const h = harness();
    const conversation = await getPrimaryConversation(h, bot, {}, context);
    let inboxOutcome = null;
    if (conversation) {
      inboxOutcome = await conversation.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const item = (inbox.items ?? []).find(
          (entry) =>
            (entry?.mode === 'followUp' || entry?.mode === 'steer') &&
            entry?.entry?.kind === 'host.user-message' &&
            entry?.entry?.data?.attribution?.kind === 'user' &&
            entry?.entry?.data?.attribution?.channel === 'primary' &&
            entry?.entry?.data?.requestId === requestId,
        );
        if (item) {
          item.mode = 'steer';
          return 'steered';
        }
        const record = await tx.submissionByRequest(conversation.id, requestId);
        if (record && (record.status === 'placed' || record.status === 'done')) {
          return 'already_placed';
        }
        return null;
      }, context);
    }
    if (promotedInQueue || inboxOutcome) {
      await syncPublishedQueue(bot);
      const status = inboxOutcome ?? 'steered';
      if (status === 'steered' && !stopped(bot.botId)) {
        clearStopped(bot.botId);
        nudge(bot.botId);
      }
      return { botId: bot.botId, requestId, status };
    }
    throw errWithCode('submission not found: ' + requestId, 'SUBMISSION_NOT_FOUND');
  }

  /**
   * abort：把该 Bot 尚未原生提交的排队条目转为 cancelled 终态受理（不删除唯一记录，
   * getSubmission/wait 无原生 done 时读为 unanswered 而不是 NOT_FOUND），同时清理
   * 已授予但未提交的空 pin——取消绝不复活旧授权。队列取消与空 pin 清理在同一 commit：
   * 原子边界内绝不出现「条目已取消而授权 pin 仍活」的中间态。
   * throughStopEpoch 限定取消范围：只作废受理代次 ≤ 该值的条目（停止前已受理的
   * 输入与工作积压）；停止开始后受理的新代次输入保留，等停止结算后由泵处理。
   * pin 清理按本次受影响条目引用的 admissionId 精确删除（含先前已 cancelled 条目
   * 的残留空 pin——它们同属本轮取消覆盖的受理代次，恢复时不得复活旧授权）；
   * 仅清 submissionId 为空的 pin，绝不触碰停止开始后新代次轮或无关轮的 pin。
   */
  async function cancelQueued(bot, throughStopEpoch = null) {
    const now = new Date().toISOString();
    const result = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      let count = 0;
      const withdrawn = [];
      const affected = new Set();
      for (const entry of doc.items) {
        if (throughStopEpoch !== null && (entry.stopEpoch ?? 0) > throughStopEpoch) continue;
        if (entry.admissionId) affected.add(entry.admissionId);
        if (entry.phase === 'cancelled') continue;
        if (entry.origin?.sender?.kind === 'user') {
          withdrawn.push(toWithdrawnTurnItem(entry));
        }
        entry.phase = 'cancelled';
        entry.error = null;
        entry.updatedAt = now;
        count += 1;
      }
      if (affected.size > 0) {
        // 空 submissionId 的 pin 来自已授予未提交的轮：cancel 后没有活动轮可保护，
        // 保留会让 hasActivePin 永远为真并把 Bot 钉在旧 set。只清本次受影响条目
        // 引用的 admissionId；停止开始后新代次轮的 pin 不在集合内，绝不误清。
        const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
        for (const admissionId of affected) {
          const pin = pins.admissions[admissionId];
          if (pin && (pin.submissionId === null || pin.submissionId === undefined)) {
            delete pins.admissions[admissionId];
          }
        }
      }
      return { count, withdrawn };
    }, context);
    // 发布用实时 head 而非 null：停止期间受理的新代次排队条目仍是可见准入状态，
    // 不能用 null 覆盖假装队列已空。
    if (result.count > 0) {
      await syncPublishedQueue(bot);
    }
    return result;
  }

  /** 按单一 requestId 精准取消一次队列受理或已提交轮次，绝不停止同 Bot 的其他任务或聊天。 */
  async function cancelRequest(bot, requestId) {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw errWithCode('requestId must be a non-empty string', 'INVALID_ARGUMENT');
    }
    const h = harness();
    const now = new Date().toISOString();
    const cancelledInQueue = await h.commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const found = doc.items.find((entry) => entry.requestId === requestId);
      if (!found) return false;
      let changed = false;
      if (found.phase !== 'cancelled') {
        found.phase = 'cancelled';
        found.error = null;
        found.updatedAt = now;
        changed = true;
      }
      if (found.admissionId) {
        const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
        const pin = pins.admissions[found.admissionId];
        if (pin && (pin.submissionId === null || pin.submissionId === undefined)) {
          delete pins.admissions[found.admissionId];
        }
      }
      return changed;
    }, context);
    if (cancelledInQueue) await syncPublishedQueue(bot);
    const conversation = await getPrimaryConversation(h, bot, {}, context);
    if (conversation) {
      let record = await h.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
      if (record && record.status === 'queued') {
        const abortSubOutcome = await h.abortSubmission(record.id, context, conversation.id);
        if (abortSubOutcome === 'not_found') {
          throw errWithCode(`submission ${record.id} not found during cancel`, 'CANCEL_INCOMPLETE');
        }
        const submissionId = record.id;
        record = await h.commit((tx) => tx.submission(submissionId), context);
        if (!record) {
          throw errWithCode(`submission ${submissionId} missing after ${abortSubOutcome}`, 'CANCEL_INCOMPLETE');
        }
      }
      if (record && record.status === 'placed') {
        const [sessionState, liveSnapshot] = await Promise.all([
          h.snapshot(BotSessionState, conversation.id, context),
          h.snapshot(LiveDoc, conversation.id, context),
        ]);
        const inspection = await h.inspect(context);
        const convTasks = inspection.tasks.filter((task) => task.record.conversationId === conversation.id);
        const turnByTask = sessionState?.turnByTask ?? {};
        const liveRun = liveSnapshot?.run;
        const liveRunTaskId =
          liveRun &&
          Array.isArray(liveRun.inputs) &&
          liveRun.inputs.some((inputId) => inputId === record.id) &&
          liveRun.taskId !== undefined &&
          liveRun.taskId !== null
            ? String(liveRun.taskId)
            : null;
        const byTaskId = new Map(convTasks.map((task) => [String(task.record.id), task.record]));
        const resolveOwner = async (ownerId) => {
          const key = String(ownerId);
          if (byTaskId.has(key)) return byTaskId.get(key);
          return (await h.getTask(ownerId, context)) ?? null;
        };
        const matchedTaskIds = [];
        for (const task of convTasks) {
          let cur = task.record;
          let matched = false;
          let belongsToOther = false;
          for (let depth = 0; depth < 16 && cur; depth++) {
            const key = String(cur.id);
            const mappedReq = turnByTask[key];
            if (typeof mappedReq === 'string') {
              if (mappedReq === requestId) matched = true;
              else belongsToOther = true;
              break;
            }
            if (liveRunTaskId !== null && key === liveRunTaskId) {
              matched = true;
              break;
            }
            cur = cur.owner !== undefined ? await resolveOwner(cur.owner) : null;
          }
          if (matched && !belongsToOther) {
            matchedTaskIds.push(task.record.id);
          }
        }
        if (matchedTaskIds.length > 0) {
          for (const taskId of matchedTaskIds) {
            await h.abortTask(taskId, context);
          }
          for (const taskId of matchedTaskIds) {
            const after = await h.getTask(taskId, context);
            if (
              after &&
              after.state.status !== 'terminal' &&
              after.state.status !== 'completing' &&
              (!after.abortRequested || after.abortReason !== undefined)
            ) {
              throw errWithCode(`task ${taskId} did not retain abort mark`, 'CANCEL_INCOMPLETE');
            }
          }
        }
        const verified = await h.commit(async (tx) => {
          const latestRecord = await tx.submission(record.id);
          if (!latestRecord) {
            return { ok: false, reason: `submission ${record.id} missing during cancel` };
          }
          if (latestRecord.status === 'done' || latestRecord.status === 'unanswered') {
            return { ok: true };
          }
          if (latestRecord.status !== 'placed') {
            return { ok: false, reason: `submission ${record.id} returned to status ${latestRecord.status}` };
          }
          const live = await tx.doc(LiveDoc, conversation.id);
          const run = live?.run;
          if (!run || !Array.isArray(run.inputs) || !run.inputs.includes(record.id) || run.taskId == null) {
            return { ok: false, reason: `unable to confirm active run ownership for placed submission ${record.id}` };
          }
          const rootTask = await tx.task(run.taskId);
          if (!rootTask || rootTask.conversationId !== conversation.id) {
            return { ok: false, reason: `active run root task ${run.taskId} missing during cancel` };
          }
          const sessionDoc = await tx.doc(BotSessionState, conversation.id);
          const mappedRootReq = sessionDoc?.turnByTask?.[String(rootTask.id)];
          if (typeof mappedRootReq === 'string' && mappedRootReq !== requestId) {
            return { ok: false, reason: `active run root task ${rootTask.id} belongs to another request` };
          }
          if (
            rootTask.state.status !== 'terminal' &&
            rootTask.state.status !== 'completing' &&
            (!rootTask.abortRequested || rootTask.abortReason !== undefined)
          ) {
            return { ok: false, reason: `active run root task ${rootTask.id} is not aborted` };
          }
          return { ok: true };
        }, context);
        if (!verified.ok) {
          throw errWithCode(verified.reason, 'CANCEL_INCOMPLETE');
        }
      } else if (record && record.status !== 'done' && record.status !== 'unanswered') {
        throw errWithCode(`unexpected submission status ${record.status}`, 'CANCEL_INCOMPLETE');
      }
      if (!record && !cancelledInQueue) {
        const queuedNow = await readQueue(bot.primaryConversationId);
        if (queuedNow.some((entry) => entry.requestId === requestId && entry.phase !== 'cancelled')) {
          throw errWithCode(`request ${requestId} is still queued`, 'CANCEL_INCOMPLETE');
        }
      }
    }
    if (!stopped(bot.botId) && (await queuedCount(bot)) > 0) {
      nudge(bot.botId);
    }
    return { botId: bot.botId, requestId };
  }

  /** pin 是否仍覆盖活动轮：有 admissionId 的队列条目/挂起决策，或有未完结 submissionId 的 pin。 */
  async function hasActivePin(botId) {
    const bot = host.getBot(botId);
    if (!bot) return false;
    const items = await readQueue(bot.primaryConversationId);
    if (items.some((entry) => entry.admissionId && entry.phase !== 'cancelled')) return true;
    const h = harness();
    const pins = await h.snapshot(TurnPin, bot.primaryConversationId, context);
    for (const pin of Object.values(pins?.admissions ?? {})) {
      if (pin.submissionId === null || pin.submissionId === undefined) return true;
      const submission = await h.submission(pin.submissionId, context).catch(() => null);
      if (!submission) return true;
      const record = await submission.status(context);
      if (record.status === 'queued' || record.status === 'placed') return true;
    }
    // 挂起工作决策的 admissionId 也算 pin（WorkDecisionState.pending）。
    const workIndex = await h.snapshot(WorkIndex, context);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      let pair = null;
      try { pair = JSON.parse(key); } catch { pair = null; }
      if (!Array.isArray(pair) || pair[0] !== botId) continue;
      const state = await h.snapshot(WorkDecisionState, binding.nativeId, context);
      if (state?.pending?.admissionId) return true;
    }
    return false;
  }

  /** 待恢复的 pin 集合：队列条目引用的 admission + 每 Bot 最近 pin。 */
  async function pinsToRestore() {
    const needed = new Map();
    for (const bot of host.listBots()) {
      const queueItems = await readQueue(bot.primaryConversationId).catch(() => []);
      for (const item of queueItems) {
        if (item.admissionId && item.phase !== 'cancelled') needed.set(bot.botId + ' ' + item.admissionId, { bot, admissionId: item.admissionId });
      }
      const pins = await harness().snapshot(TurnPin, bot.primaryConversationId, context).catch(() => null);
      for (const pin of Object.values(pins?.admissions ?? {})) {
        let active = pin.submissionId === null || pin.submissionId === undefined;
        if (!active) {
          const submission = await harness().submission(pin.submissionId, context).catch(() => null);
          // 与 hasActivePin 同口径：done 与 unanswered 都是终态，不恢复已完结轮的旧 set。
          const status = submission ? (await submission.status(context)).status : null;
          active = !submission || (status !== 'done' && status !== 'unanswered');
        }
        if (active) needed.set(bot.botId + ' ' + pin.admissionId, { bot, admissionId: pin.admissionId });
      }
      // 挂起工作决策的 admission 也要恢复：pending.admissionId 存在且未完结。
      const workIndex = await harness().snapshot(WorkIndex, context).catch(() => null);
      for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
        let pair = null;
        try { pair = JSON.parse(key); } catch { pair = null; }
        if (!Array.isArray(pair) || pair[0] !== bot.botId) continue;
        const state = await harness().snapshot(WorkDecisionState, binding.nativeId, context).catch(() => null);
        const admissionId = state?.pending?.admissionId;
        if (admissionId) needed.set(bot.botId + ' ' + admissionId, { bot, admissionId });
      }
    }
    return [...needed.values()];
  }

  /**
   * 冷启动恢复（resume 之前由 service 调用一次）：
   * 1) 对每个仍被引用的 admission 走 centerRuntime.restoreTurn 重挂被钉住的旧 set；
   * 2) 发现有原生未完结工作却无任何 pin 覆盖的 Bot -> TURN_RECOVERY_REQUIRED（不静默当已准入）。
   */
  // 冷恢复 gate：restoreTurns 失败置位，成功/干净收敛清除。
  // runtime 用它区分「恢复未完成」与「普通离线」：前者禁止一切可能隐式唤醒调度的路径。
  let recoveryPending = false;

  async function restoreTurns() {
    // 停止元数据已在 initializeBots/pendingStops 恢复，先补停再恢复 pin。
    const restored = new Map(); // botId -> setId
    const failed = [];
    for (const { bot, admissionId } of await pinsToRestore()) {
      try {
        const preparation = await centerRuntime.restoreTurn({ botId: bot.botId, admissionId });
        await applyPreparation(bot, preparation);
        restored.set(bot.botId, preparation.setId);
      } catch (err) {
        failed.push({ botId: bot.botId, admissionId, error: boundedTurnError(err) });
      }
    }
    // 遗留未钉活动工作：不静默接纳、也不跑新代码，暴露受控恢复失败。
    const inspection = await harness().inspect(context);
    const activeNative = new Set();
    for (const submission of inspection.submissions) activeNative.add(submission.conversationId);
    for (const task of inspection.tasks) activeNative.add(task.record.conversationId);
    if (activeNative.size > 0) {
      const primaryIndex = await harness().snapshot(PrimaryIndex, context);
      const workIndex = await harness().snapshot(WorkIndex, context);
      const owners = new Map(); // nativeId -> botId
      for (const bot of host.listBots()) {
        const primary = primaryIndex?.byPrimary?.[bot.primaryConversationId];
        if (primary !== undefined) owners.set(primary, bot.botId);
      }
      for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
        let pair = null;
        try { pair = JSON.parse(key); } catch { pair = null; }
        if (Array.isArray(pair)) owners.set(binding.nativeId, pair[0]);
      }
      for (const nativeId of activeNative) {
        const botId = owners.get(nativeId);
        if (botId && !restored.has(botId) && !(await hasActivePin(botId))) {
          failed.push({ botId, admissionId: null, error: { code: 'TURN_RECOVERY_REQUIRED', message: 'active work predates turn pins' } });
        }
      }
    }
    if (failed.length > 0) {
      recoveryPending = true;
      // 首个失败原因带入消息便于诊断：boundedTurnError 已截断、不含凭据。
      const first = failed[0];
      const reason = first && first.error && first.error.message
        ? ' (first: ' + first.botId + ': ' + first.error.code + ': ' + first.error.message + ')' : '';
      const err = errWithCode('turn restoration incomplete' + reason, 'TURN_RECOVERY_REQUIRED');
      err.details = failed;
      throw err;
    }
    recoveryPending = false;
  }

  /**
   * 工作决策共用准入回调（contract：submitPending 不直投未守门的 submit）。
   * 新决策走 prepare/apply/confirm；已有 admissionId 的 pending 决策（恢复重投）走 restoreTurn。
   * 目标 set 与该 Bot 活动原生工作不同步时暂不提交（下次 poll 自然重试）。
   */
  /** pending 仍可提交：身份匹配、无 stop/preempt interruption 标记、scope 未停止。 */
  async function pendingViable(nativeId, requestId) {
    const state = await harness().snapshot(WorkDecisionState, nativeId, context);
    const pending = state?.pending;
    return !!pending && pending.requestId === requestId &&
      pending.interruption == null && !state.stopped;
  }

  async function admitWorkDecision(binding, bot, input) {
    if (closing) return null;
    const now = Date.now();
    if ((workBackoff.get(binding.nativeId) ?? 0) > now) return null;
    // 任何新 grant 之前先看真实 gate：排队用户轮优先、本 Bot 原生全忙
    // （含遗留 work 会话）不发 grant；仅存在 background pending 不拦。
    if (!(await canRunWork(bot.botId))) return null;
    const h = harness();
    const meta = await h.snapshot(WorkContextState, binding.nativeId, context);
    const state = await h.snapshot(WorkDecisionState, binding.nativeId, context);
    // stop/preempt 已在 pending 上落 interruption 或 scope stopped：绝不 resurrect pin/grant。
    if (!state?.pending || state.pending.requestId !== input.requestId ||
        state.pending.interruption != null || state.stopped) return null;
    const scopeKey = 'work:' + meta.scopeId;
    // 协调状态恒在 binding.nativeId；执行目标为 pending 记录的统一会话（缺省即遗留
    // work 会话本体，旧 pending 在结算/取消前保持原执行目标，绝不双执行）。
    const executionNativeId = state.pending.executionNativeId ?? binding.nativeId;
    const unifiedExecution = state.pending.executionNativeId !== undefined &&
                             state.pending.executionNativeId !== null;
    // Deterministic structural digest of the decision input: String(content) would collapse every
    // structured content/entry payload into '[object Object]' and void request-identity conflicts.
    const inputDigest = createHash('sha256').update(JSON.stringify({
      content: input.content ?? null, entry: input.entry ?? null,
    })).digest('hex');
    const epoch = getEpoch();
    try {
      const admissionId = state.pending.admissionId ?? null;
      if (!admissionId) {
        // grant 写盘前再复核 gate：snapshot 读与 prepare/confirm 之间已隔多个
        // await，排队用户/其他原生工作可能刚好到达——发给工作的授权绝不插队。
        if (!(await canRunWork(bot.botId))) return null;
        // 不传 knownSetId：appliedSetIds 本地缓存不证明权威就绪，且
        // prepare 快路的持久化 grant 会在忙碌等待期间钉住旧 set。
        const preparation = await centerRuntime.prepareTurn({
          botId: bot.botId,
          requestId: input.requestId,
          scopeKey,
          inputDigest,
        });
        const needsSwitch = appliedSetIds.get(bot.botId) !== preparation.setId;
        if (needsSwitch ? await botNativeBusy(bot) : await nativeConversationBusy(executionNativeId)) {
          return null; // 本 Bot 有旧 set 的原生工作在跑：保持 pending，下轮 poll 再试。
        }
        await applyPreparation(bot, preparation);
        if (getEpoch() !== epoch || closing) return null;
        const grant = preparation.admission ?? await centerRuntime.confirmTurn({
          botId: bot.botId,
          requestId: input.requestId,
          scopeKey,
          inputDigest,
          setId: preparation.setId,
        });
        const grantedId = grant?.admissionId ?? null;
        if (!grantedId) throw errWithCode('center did not grant admission', 'TURN_SYNC_FAILED');
        await h.commit(async (tx) => {
          const doc = await tx.doc(WorkDecisionState, binding.nativeId);
          if (doc.pending?.requestId === input.requestId) {
            doc.pending.admissionId = grantedId;
            doc.pending.setId = grant.setId ?? preparation.setId;
          }
        }, context);
      } else {
        const preparation = await centerRuntime.restoreTurn({ botId: bot.botId, admissionId });
        if (appliedSetIds.get(bot.botId) !== preparation.setId
            ? await botNativeBusy(bot)
            : await nativeConversationBusy(executionNativeId)) {
          return null;
        }
        await applyPreparation(bot, preparation);
      }
      // 网络 await 后核对 pending 未被 stop/preempt 作旧：迟到提交绝不复活已取消工作。
      if (!(await pendingViable(binding.nativeId, input.requestId))) return null;
      // 统一执行目标（primary）的提交前同步该 Bot 收件到主会话；遗留目标不导入，
      // 保持旧 work 会话的既有上下文边界。导入失败按暂不可达退避，保持 pending。
      if (unifiedExecution && sessions) {
        try { await sessions.sync(bot.botId); }
        catch {
          workBackoff.set(binding.nativeId, Date.now() + RETRY_BASE_MS);
          return null;
        }
      }
      // 提交前最后一次 gate 复核：上述 sync/restore 全部 await 之后，排队用户
      // 输入或原生工作可能已先到；忙即保持 pending，绝不在 grant 后硬塞 submit。
      if (!(await canRunWork(bot.botId))) return null;
      // submit 前最后一次核对 pending 身份/标记：gate 复核与提交之间不得插入已取消工作。
      if (!(await pendingViable(binding.nativeId, input.requestId))) return null;
      const conversation = await h.conversation(executionNativeId, context);
      if (!conversation) throw new Error('work conversation is missing');
      if (!canAdmit()) return null;
      const submission = await conversation.submit(input, context);
      // submit 在飞期间 stop/preempt 已作旧 pending：立即中止刚提交的原生工作，
      // 绝不出现「停止后新执行」。abortSubmission 幂等，work lane 结算时再覆盖。
      if (!(await pendingViable(binding.nativeId, input.requestId))) {
        try { await h.abortSubmission(submission.id, context, executionNativeId); } catch { /* 中止失败不掩盖取消事实 */ }
        return null;
      }
      workBackoff.delete(binding.nativeId);
      return submission;
    } catch (err) {
      // ConversationBusy 由调用方原样处理；准入失败退避，保持 pending 可重试。
      if (err instanceof ConversationBusy) throw err;
      if (err?.code === 'CENTER_OFFLINE' || err?.code === 'NOT_CONNECTED' ||
          err?.code === 'TURN_SET_CHANGED' || err?.code === 'TURN_SYNC_FAILED') {
        workBackoff.set(binding.nativeId, Date.now() + RETRY_BASE_MS);
        return null;
      }
      throw err;
    }
  }

  function close() {
    closing = true;
    pumpAgain.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  }

  return {
    enqueue,
    refreshActivity,
    pump: nudge,
    nudgeAll,
    queuedCount,
    queuedReceipt,
    withdrawInboxUserItems,
    withdrawQueued,
    steerQueued,
    cancelQueued,
    cancelRequest,
    hasActivePin,
    restoreTurns,
    /** 冷恢复未完成时恒为 true：禁用隐式 resume 的 SDK 路径直到下一轮成功恢复。 */
    isRecoveryPending: () => recoveryPending,
    admitWorkDecision,
    canRunWork,
    appliedSetIds,
    // 停止 gate：runtime.abort 先 beginStop（持久推进 TurnQueue.stopEpoch 并 arm
    // 本进程 gate）再统一取消，settleStop 结算；submit 捕获 stopEpoch 作废旧受理。
    stopEpoch,
    stopped,
    webhookStopPending,
    getStopStates,
    acknowledgeStop,
    beginStop,
    settleStop,
    // 冷启动未完成停止清单：runtime.restoreTurns 在任何 harness.resume 前处理。
    pendingStops,
    close,
  };
}
