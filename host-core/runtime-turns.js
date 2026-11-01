// 模块：每轮中心准入（contract §6 的 Host 侧实现）。
// 每条外部用户输入先持久化进 TurnQueue（session family doc，key = primaryConversationId），
// 再由 per-Bot 泵在线执行 prepare→原子切换→confirm→持久 pin→原生 submit(whenBusy:'reject')。
// 任何一步失败都留下可重试的 queued/failed 记录：绝不静默沿用旧 set 执行模型。
// 恢复：restoreTurns() 在冷启动 resume 之前按持久 pin/admissionId 重挂被钉住的旧版本。
import { createHash } from 'node:crypto';
import { ConversationBusy } from '@earendil-works/pi-durable';
import { TurnQueue, TurnPin, toTurnAdmissionStatus, toQueuedReceipt } from './runtime-turns-docs.js';
import { normalizeAttachmentIds } from './attachments.js';
import { PrimaryIndex, getPrimaryConversation, applyAgentProfile, RequestKeys } from './runtime-docs.js';
import { formatPrimarySubmission } from './runtime-history.js';
import { parseModelRef } from './runtime-models.js';
import { WorkIndex, WorkContextState } from './work-context-docs.js';
import { WorkDecisionState } from './work-decision-state.js';

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
 *  plugins, models, getBotModels, setBotModels, profileFor, botExecutionFingerprint,
 *  setBotAppliedRevision(botId, revision), setBotFingerprint(botId, fingerprint),
 *  live（protocol lane 补 setTurnAdmission；缺席时静默跳过）, admitBot,
 *  getEpoch()（断线 epoch，网络 await 期间变更即放弃提交）,
 *  trackSubmission(submissionId, info), recordCompletedSubmission(botId, formatted),
 *  initializeBot(botId), attachments({upload,load,removeBot}),
 *  sessions（可选；统一 Bot 主会话的收件导入运行时，缺席时跳过统一导入）.
 */
export function createTurnAdmission(deps) {
  const {
    host, getHarness, context, centerRuntime, plugins, models,
    getBotModels, setBotModels, profileFor, botExecutionFingerprint,
    setBotAppliedRevision, setBotFingerprint, live, admitBot, getEpoch,
    trackSubmission, recordCompletedSubmission, initializeBot, attachments, sessions,
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
    return { sender: { kind, ...(name !== null ? { name } : {}) }, replyTo };
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
    return {
      kind: 'host.user-message',
      data: {
        version: 1,
        source: 'host',
        requestId: item.requestId,
        botId: item.botId,
        attribution: {
          kind,
          deviceId: host.deviceId,
          channel: 'primary',
          messageId: item.requestId,
          direction: 'incoming',
          createdAt: item.enqueuedAt,
          ...(name !== null ? { name } : {}),
          ...(replyTo !== null ? { replyTo } : {}),
        },
        turn: {
          requestId: item.requestId,
          taskId: null,
          kind: 'primary',
          scopeId: null,
          triggerMessageId: item.requestId,
          replyTo,
          sender: { kind, deviceId: host.deviceId },
          replyTarget: { kind: 'primary' },
        },
      },
    };
  }

  const harness = () => getHarness();
  const pumpInFlight = new Set();   // botId：每会话同时至多一个泵
  const retryTimers = new Map();    // botId -> timer
  const retryAttempts = new Map();  // botId -> n（失败退避计数，成功清空）
  const appliedSetIds = new Map();  // botId -> 最近一次已确认/已恢复的完整 setId
  const workBackoff = new Map();    // nativeId -> ms epoch，工作决策准入退避
  let closing = false;

  function publishStatus(botId, item, queuedCount) {
    try {
      live?.setTurnAdmission?.(botId, toTurnAdmissionStatus(item), queuedCount);
    } catch { /* live 尚未实现 setTurnAdmission 或已关闭：不阻断准入 */ }
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
    const remaining = await queuedCount(bot);
    const head = await liveHead(bot);
    publishStatus(bot.botId, head, remaining);
    return item;
  }

  /** 对外可见的准入 head：跳过 cancelled 终态受理记录（其 receipt 为 unanswered，不占准入状态）。 */
  async function liveHead(bot) {
    const items = await readQueue(bot.primaryConversationId);
    return items.find((entry) => entry.phase !== 'cancelled') ?? null;
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
      不解除绑定，不需要等插件调用排空。 */
  async function botNativeBusy(bot, { withPluginOps = true } = {}) {
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
      不算忙/死锁——本函数只看原生活动与 Host 队列。 */
  async function canRunWork(botId) {
    if (closing) return false;
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
    if (selection) {
      const nextModels = { ...getBotModels() };
      nextModels[bot.botId] = selection;
      setBotModels(nextModels);
    }
    const applied = await plugins.applyBot(bot, capabilities, {
      deviceId: host.deviceId,
      credentials,
      atomic: true,
      setId: preparation.setId,
    });
    if ((applied?.capabilityErrors ?? []).length > 0) {
      throw errWithCode('turn capability set could not be applied', 'TURN_SYNC_FAILED');
    }
    setBotFingerprint(bot.botId, botExecutionFingerprint(selection, capabilities, credentials));
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

  /** 单条 head 条目的完整准入：prepare→（需切换时确认空闲）→原子应用→confirm→pin→提交。 */
  async function admitItem(bot, item) {
    const epoch = getEpoch();
    const scopeKey = 'primary';
    // 1. 已有 admissionId（授予后崩溃）：只恢复同一准入，不再向中心新申请。
    let preparation = null;
    let grant = null;
    if (item.admissionId) {
      await setPhase(bot, item.requestId, 'synchronizing');
      preparation = await centerRuntime.restoreTurn({ botId: bot.botId, admissionId: item.admissionId });
      grant = { admissionId: item.admissionId, setId: preparation.setId };
    } else {
      // 2. 先过实际准入边界再查中心：Busy 检查必须在任何可能签发 grant 的操作之前。
      // 过早 prepare 的 knownSetId 快路会持久化 admission——之后排队消息即使本地仍 queued，
      // 恢复时也会沿用旧 set（E2E：问卷等待期排队消息提前拿到旧版 grant）。
      // 本地 appliedSetIds 不足以证明就绪（后台 applyBot 可能已换绑定）：
      // 先用「同 set 仅需会话空闲」的保守 gate 拦住一切早授予，就绪后才真正 prepare/confirm。
      if (await botBusyForSet(bot, false)) {
        await setPhase(bot, item.requestId, 'queued');
        return null;
      }
      await setPhase(bot, item.requestId, 'checking');
      let lastError = null;
      for (let attempt = 0; attempt < MAX_PREPARE_ATTEMPTS && !preparation; attempt++) {
        if (getEpoch() !== epoch || closing) throw errWithCode('host is not connected', 'NOT_CONNECTED');
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
      // 3. 目标 set 与当前不同才要求全 Bot 原生空闲；相同 set 只要求主会话空闲。
      const needsSwitch = appliedSetIds.get(bot.botId) !== preparation.setId;
      if (needsSwitch && await botBusyForSet(bot, true)) {
        // 有原生工作在跑：保持 queued，等原生完成/下个触发点再泵。
        await setPhase(bot, item.requestId, 'queued');
        return null;
      }
      await setPhase(bot, item.requestId, 'synchronizing');
      await applyPreparation(bot, preparation);
      if (getEpoch() !== epoch || closing) throw errWithCode('host is not connected', 'NOT_CONNECTED');
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
    if (item.admissionId) await applyPreparation(bot, preparation);
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
      if (!found) throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
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
    let conversation = await getPrimaryConversation(harness(), bot, {}, context);
    if (!conversation) {
      const modelRef = getBotModels()[bot.botId]?.modelRef;
      const ref = parseModelRef(modelRef);
      if (!models.getModel(ref.provider, ref.modelId)) {
        throw errWithCode('model not found: ' + modelRef, 'TURN_SYNC_FAILED');
      }
      conversation = await getPrimaryConversation(harness(), { ...bot, modelRef }, {
        create: true,
        defaultModel: modelRef,
        thinkingLevel: profile.thinkingLevel,
        instructions: profile.instructions,
        removeTools: profile.removeTools,
        codemodeOnly: profile.codemodeOnly,
      }, context);
    }
    await applyAgentProfile(harness(), conversation.id, profile, context);
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
    if (!alive || getEpoch() !== epoch || closing) {
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
      const remaining = await queuedCount(bot);
      const head = await liveHead(bot);
      publishStatus(bot.botId, head, remaining);
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
    // 安全轮边界：提交前把该 Bot 全部收件 scope 增量导入统一主会话，
    // 迟到回复/群消息进入本轮上下文；导入水位在 sessions 内原子提交。
    if (sessions) await sessions.sync(bot.botId);
    // sync 的多个 await 期间后台工作可能已占会话：提交是最后一个 grant，
    // 提交前必须复核会话仍空闲，busy 则保持 queued 等下次泵（提交拒忙兜底）。
    if (await botNativeBusy(bot, { withPluginOps: false })) {
      await setPhase(bot, item.requestId, 'queued');
      return null;
    }
    const entry = sourceMessageEntry(item);
    if (attachmentMeta.length > 0) entry.data.attachments = attachmentMeta;
    let submission;
    try {
      submission = await conversation.submit(
        { type: 'input', content, requestId: item.requestId, whenBusy: 'reject', entry },
        context,
      );
    } catch (err) {
      if (err instanceof ConversationBusy) {
        // 空闲检查与提交之间原生工作先到：保持 queued，等下次触发再泵。
        await setPhase(bot, item.requestId, 'queued');
        return null;
      }
      throw err;
    }
    // 关闭提交竞态窗口：提交在飞期间 abort/Stop 已把条目转 cancelled——立即中止刚提交的
    // 原生工作，绝不出现「停止后新执行」。conversation.abort 幂等，abort() 随后还会再调一次。
    if (!(await itemAlive(bot, item.requestId)) || closing) {
      try { await conversation.abort(context, { background: true }); } catch { /* 中止失败不掩盖取消事实 */ }
      throw errWithCode('queued turn was cancelled', 'NOT_CONNECTED');
    }
    const statusRecord = await submission.status(context);
    trackSubmission(statusRecord.id, { botId: bot.botId, nativeId: conversation.id });
    // 7. 原生提交成功：条目出队并把 submissionId 回写 pin（同一 commit）。
    await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const index = doc.items.findIndex((entry) => entry.requestId === item.requestId);
      if (index >= 0) doc.items.splice(index, 1);
      const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
      if (pins.admissions[grant.admissionId]) {
        pins.admissions[grant.admissionId].submissionId = statusRecord.id;
      }
    }, context);
    const remaining = await queuedCount(bot);
    const head = await liveHead(bot);
    publishStatus(bot.botId, head, remaining);
    const formatted = await formatPrimarySubmission(harness(), bot, statusRecord, context);
    if (formatted.status === 'done') recordCompletedSubmission(bot.botId, formatted);
    return formatted;
  }

  /** 泵一条（可能重入下一轮 head）；每次新轮都会重新过中心确认，绝不合并 followup。
      'cancelled' 条目是对账用的终态受理记录，不是可泵的 head：跳过它们，绝不重投已取消的轮。 */
  async function pump(bot) {
    if (closing) return;
    if (bot.archivedAt !== null && bot.archivedAt !== undefined) return;
    const items = await readQueue(bot.primaryConversationId);
    const item = items.find((entry) => entry.phase !== 'cancelled') ?? null;
    if (!item) {
      publishStatus(bot.botId, null, await queuedCount(bot));
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
    if (closing || pumpInFlight.has(botId)) return;
    const bot = host.getBot(botId);
    if (!bot) return;
    pumpInFlight.add(botId);
    const task = admitBot(botId, () => pump(bot));
    const clear = () => pumpInFlight.delete(botId);
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
    const requestId = input?.requestId;
    const text = input?.text;
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw errWithCode('requestId must be a non-empty string', 'INVALID_ARGUMENT');
    }
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
    const item = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      const existing = doc.items.find((entry) => entry.requestId === requestId);
      if (existing) {
        if (existing.digest !== digest) {
          throw errWithCode('requestId already used with different text: ' + requestId, 'REQUEST_CONFLICT');
        }
        // 已取消的受理允许同 requestId/同文显式重新受理：复活为新的 queued 条目，
        // 旧的 cancelled 记录在同 commit 内被同一条目覆盖（身份/摘要/来源随之刷新）。
        if (existing.phase === 'cancelled') {
          existing.phase = 'queued';
          existing.error = null;
          existing.admissionId = null;
          existing.setId = null;
          existing.submissionId = null;
          existing.origin = origin;
          existing.updatedAt = now;
        } else if (existing.phase === 'failed') {
          // 同 requestId 的显式重试重新武装自动重试：耗尽的退避计数在重试时清零，
          // 避免这次显式尝试再失败后静默失去自动恢复。
          existing.error = null;
          existing.updatedAt = now;
          retryAttempts.delete(botId);
        }
        return { ...existing };
      }
      const next = {
        requestId,
        botId,
        primaryConversationId: bot.primaryConversationId,
        digest,
        text,
        origin,
        ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
        phase: 'queued',
        error: null,
        admissionId: null,
        setId: null,
        submissionId: null,
        enqueuedAt: now,
        updatedAt: now,
      };
      doc.items.push(next);
      return { ...next };
    }, context);
    // initializeBot 的 SOUL 回填等可失败工作必须在受理持久化之后：先落队列再初始化，
    // 失败的消息在 Host 端永远有可对账的 queued 记录，而不是无声丢失。
    await initializeBot(botId);
    const count = await queuedCount(bot);
    publishStatus(botId, item, count);
    nudge(botId);
    return toQueuedReceipt(item);
  }

  /** 队列中仍存在的条目 -> queued 回执；供 getSubmission/wait 先查。 */
  async function queuedReceipt(bot, requestId) {
    const items = await readQueue(bot.primaryConversationId);
    const item = items.find((entry) => entry.requestId === requestId);
    return item ? toQueuedReceipt(item) : null;
  }

  /**
   * abort：把该 Bot 尚未原生提交的排队条目全部转为 cancelled 终态受理（不删除唯一记录，
   * getSubmission/wait/findByRequest 之后读为 unanswered 而不是 NOT_FOUND），同时清理
   * 已授予但未提交的空 pin——取消绝不复活旧授权。
   */
  async function cancelQueued(bot) {
    const now = new Date().toISOString();
    const removed = await harness().commit(async (tx) => {
      const doc = await queueDoc(tx, bot.primaryConversationId);
      let count = 0;
      for (const entry of doc.items) {
        if (entry.phase === 'cancelled') continue;
        entry.phase = 'cancelled';
        entry.error = null;
        entry.updatedAt = now;
        count += 1;
      }
      return count;
    }, context);
    if (removed > 0) {
      // 空 submissionId 的 pin 来自已授予未提交的轮：cancel 后没有活动轮可保护，
      // 保留会让 hasActivePin 永远为真并把 Bot 钉在旧 set。与取消同事务清掉引用。
      await harness().commit(async (tx) => {
        const pins = await tx.doc(TurnPin, bot.primaryConversationId, {});
        for (const [admissionId, pin] of Object.entries(pins.admissions)) {
          if (pin.submissionId === null || pin.submissionId === undefined) delete pins.admissions[admissionId];
        }
      }, context);
      publishStatus(bot.botId, null, await queuedCount(bot));
    }
    return removed;
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
    if (!state?.pending || state.pending.requestId !== input.requestId) return null;
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
      const conversation = await h.conversation(executionNativeId, context);
      if (!conversation) throw new Error('work conversation is missing');
      const submission = await conversation.submit(input, context);
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
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  }

  return {
    enqueue,
    pump: nudge,
    nudgeAll,
    queuedReceipt,
    cancelQueued,
    hasActivePin,
    restoreTurns,
    /** 冷恢复未完成时恒为 true：禁用隐式 resume 的 SDK 路径直到下一轮成功恢复。 */
    isRecoveryPending: () => recoveryPending,
    admitWorkDecision,
    canRunWork,
    appliedSetIds,
    close,
  };
}
