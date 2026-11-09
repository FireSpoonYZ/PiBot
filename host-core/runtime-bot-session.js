// 统一 Bot 会话执行面：调用方已持有 Bot 准入与安全边界时，
// sync 把该 Bot 全部收件箱 scope 增量导入主会话；beforeRequest 按真实 run 输入冻结/恢复
// 本轮来源；发出的请求与已观察回复水位持久化在 BotSessionState，供迟到回复寻源与 UI 归属。
// 不获取第二条 Bot 准入通道，不写全局「当前频道」，崩溃/重放靠 Durable commit+memo。
import { LiveDoc } from '@earendil-works/pi-durable';
import { BotSessionState, WORK_TRIGGER_KIND, USER_MESSAGE_KIND,
  createSessionMessageEntry, senderAttribution } from './bot-session-context.js';
import { resolveBotIdentity } from './bot-identity.js';
import { inboxQueryKey } from './message-queries.js';
import { messageError } from './message-protocol.js';

const SYNC_PAGE_LIMIT = 200;
const OWNER_CHAIN_DEPTH = 8;
// 冻结轮 memo：同一生成任务的重试/重启恢复同一来源，不再重新推导。
const ORIGIN_MEMO = 'host.turn-origin';

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createBotSessionRuntime({ host, getHarness, getMessageLog, context, getPrimary }) {
  const harness = () => getHarness();
  const log = () => getMessageLog();
  const ctx = context;

  const sessionStateDoc = (tx, nativeId) => tx.doc(BotSessionState, nativeId);
  const snapshot = (nativeId) => harness().snapshot(BotSessionState, nativeId, ctx);

  /** botId -> {bot, nativeId, conversationId, conversation}；主会话缺失返回 null，不创建。 */
  async function primaryFor(botId) {
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) {
      throw messageError('BOT_NOT_FOUND', 'bot not found on this host: ' + botId);
    }
    const conversation = await getPrimary(bot);
    if (!conversation) return null;
    return { bot, nativeId: conversation.id, conversationId: bot.primaryConversationId, conversation };
  }

  function freezeTurn(origin) {
    return {
      requestId: origin.requestId,
      taskId: String(origin.taskId),
      kind: origin.kind,
      scopeId: origin.scopeId ?? null,
      // 实际执行 Bot 的本机身份（生成输出归属的作者），不是触发者。
      botId: origin.botId ?? null,
      deviceId: origin.deviceId ?? null,
      ...(origin.workNativeId !== undefined ? { workNativeId: origin.workNativeId } : {}),
      ...(origin.triggerMessageId ? { triggerMessageId: origin.triggerMessageId } : {}),
      ...(origin.replyTo ? { replyTo: origin.replyTo } : {}),
      ...(origin.rootId ? { rootId: origin.rootId } : {}),
      // 本轮默认回应的目标消息 ID（原始请求 messageId）：与触发消息分离持久化，
      // 嵌套委派续轮绝不能把晚到回复的 replyTo/触发 ID 冒充成原目标。
      ...(origin.responseMessageId !== undefined ? { responseMessageId: origin.responseMessageId } : {}),
      // 迟来回流的原始请求身份：回复仍归属发起轮，绝不改写其发起来源。
      ...(origin.originRequestId ? { originRequestId: origin.originRequestId } : {}),
      sender: origin.sender,
      replyTarget: origin.replyTarget,
      frozenAt: new Date().toISOString(),
    };
  }

  function defaultReplyTarget(identity, scope) {
    if (!scope) return { kind: 'primary' };
    if (scope.kind === 'dm') {
      // DM 回复目标是对端成员（非本 Bot）。
      const peer = scope.members?.find((m) => !(m.deviceId === identity.deviceId && m.botId === identity.botId));
      return { kind: 'dm', scopeId: scope.scopeId, ...(peer ? { botId: peer.botId } : {}) };
    }
    return { kind: 'room', scopeId: scope.scopeId };
  }

  /** host.user-message / host.work-trigger / 其他输入条目 -> 冻结轮来源字段。 */
  function originFromInput(entry, record, identity) {
    const data = isObj(entry?.data) ? entry.data : null;
    if (entry.kind === USER_MESSAGE_KIND && data) {
      const turn = isObj(data.turn) ? data.turn : {};
      return {
        kind: 'primary', scopeId: null,
        requestId: data.requestId ?? turn.requestId ?? record?.requestId ?? String(entry.id),
        triggerMessageId: data.messageId ?? turn.triggerMessageId,
        replyTo: data.replyTo ?? turn.replyTo,
        rootId: data.rootId ?? turn.rootId,
        responseMessageId: turn.responseMessageId !== undefined ? turn.responseMessageId : data.responseMessageId,
        originRequestId: turn.originRequestId ?? data.originRequestId,
        sender: senderAttribution(
          isObj(turn.sender) ? turn.sender : { kind: 'user', deviceId: host.deviceId }),
        replyTarget: isObj(turn.replyTarget) ? turn.replyTarget : { kind: 'primary' },
      };
    }
    if (entry.kind === WORK_TRIGGER_KIND && data) {
      const turn = isObj(data.turn) ? data.turn : null;
      // 有 data.turn 时它的 scopeId 是权威（含显式 null=primary/回主流）：
      // data.scopeId 是工作协调 scope，绝不能覆盖冻结的原始 room/primary。
      const scopeId = turn !== null ? (turn.scopeId ?? null) : (data.scopeId ?? null);
      const scope = scopeId ? log().getScope(scopeId) : null;
      const kind = turn?.kind ?? (scope?.kind === 'dm' ? 'dm' : scope?.kind === 'room' ? 'room' : 'host');
      return {
        kind, scopeId,
        workNativeId: data.workNativeId ?? turn?.workNativeId,
        requestId: data.requestId ?? turn?.requestId ?? record?.requestId ?? String(entry.id),
        triggerMessageId: turn?.triggerMessageId ?? data.messageId,
        replyTo: turn?.replyTo ?? data.replyTo,
        rootId: turn?.rootId ?? data.rootId,
        responseMessageId: turn?.responseMessageId !== undefined ? turn.responseMessageId : data.responseMessageId,
        originRequestId: turn?.originRequestId ?? data.originRequestId,
        sender: isObj(turn?.sender) ? senderAttribution(turn.sender, turn.sender.deviceId)
                                    : senderAttribution({ kind: 'host', deviceId: host.deviceId }),
        // identity 为已解析的本机执行 Bot：DM 默认回复目标取对端成员，不会误取成员[0]/自己。
        replyTarget: isObj(turn?.replyTarget) ? turn.replyTarget
                                              : defaultReplyTarget(identity, scope),
      };
    }
    // 其他输入（含 legacy pi.user）：requestId 用实际提交身份，绝不复用先前轮来源；
    // 发送方只认条目归属，正文不作权威。
    const attribution = isObj(data?.attribution) ? data.attribution : null;
    return {
      kind: 'primary', scopeId: null,
      requestId: record?.requestId ?? String(entry.id),
      sender: senderAttribution(
        attribution ?? { kind: entry.kind === 'pi.user' ? 'user' : 'host', deviceId: host.deviceId }),
      replyTarget: { kind: 'primary' },
    };
  }

  /**
   * 本轮原始来源 = LiveDoc.run 的 input submission（放置到真实输入条目），
   * 不再从可见历史猜最新触发：压缩丢掉触发条目、handoff 换 generation 任务后，
   * 同一 input requestId 仍解析回原始冻结轮；run 归属缺失时退回最新可见触发条目。
   */
  async function deriveOrigin(api, view, context, identity) {
    const harness_ = harness();
    const run = (await harness_.snapshot(LiveDoc, api.conversationId, context))?.run;
    if (isObj(run) && String(run.taskId) === String(api.taskId)) {
      const indexById = new Map(view.entries.map((entry, index) => [String(entry.id), index]));
      let newest = null;
      for (const id of run.inputs ?? []) {
        const submission = await harness_.submission(id, context);
        const record = submission ? await submission.status(context) : null;
        if (record?.type !== 'input' || record.entry === undefined) continue;
        const index = indexById.get(String(record.entry));
        // 视图外的条目经 tx.entry 读取：Harness/Session 无顶层 entry()，
        // 沿用 runtime-history formatPrimarySubmission 的既有公开模式。
        const entry = index !== undefined ? view.entries[index]
          : await harness_.commit((tx) => tx.entry(record.entry), context);
        if (!entry) continue;
        // 多个输入同属一轮：以视图中最新的输入条目为本轮来源。
        if (newest === null || index === undefined || index > newest.index) {
          newest = { index: index ?? Number.MAX_SAFE_INTEGER, record, entry };
        }
      }
      if (newest) return originFromInput(newest.entry, newest.record, identity);
    }
    const visible = new Set(view.messages);
    for (let i = view.entries.length - 1; i >= 0; i--) {
      const entry = view.entries[i];
      if (entry.kind !== USER_MESSAGE_KIND && entry.kind !== WORK_TRIGGER_KIND) continue;
      if (!(view.contributions[i] ?? []).some((message) => visible.has(message))) continue;
      return originFromInput(entry, null, identity);
    }
    return {
      requestId: String(api.taskId), kind: 'host', scopeId: null,
      sender: senderAttribution({ kind: 'host', deviceId: host.deviceId }),
      replyTarget: { kind: 'primary' },
    };
  }

  /**
   * sync(botId)：调用方已持有 Bot 准入与安全边界；不获取第二条准入通道。
   * 把该 Bot 全部收件箱 scope 自 lastImportedLocalId 起的新消息原子追加进主会话，
   * 同一 commit 内推进水位（账本 SELECT 不属于 Tx 表读取）。
   */
  async function sync(botId) {
    const resolved = await primaryFor(botId);
    if (!resolved) return { nativeId: null, conversationId: null, lastImportedLocalId: 0, imported: 0 };
    const { nativeId, conversationId } = resolved;
    const firstPage = (lastImportedLocalId, limit) => {
      const options = { limit };
      if (lastImportedLocalId > 0) {
        options.cursor = {
          deviceId: host.deviceId,
          kind: 'inbox',
          key: inboxQueryKey(botId, undefined),
          afterLocalId: lastImportedLocalId,
        };
      }
      return log().inbox(botId, options);
    };
    // 空轮询只读，因为获取尚不存在的事务草稿也会创建文档。
    const lastImportedLocalId = (await snapshot(nativeId))?.lastImportedLocalId ?? 0;
    if (firstPage(lastImportedLocalId, 1).items.length === 0) {
      return { nativeId, conversationId, lastImportedLocalId, imported: 0 };
    }
    return harness().commit(async (tx) => {
      const state = await sessionStateDoc(tx, nativeId);
      let imported = 0;
      let page = firstPage(state.lastImportedLocalId, SYNC_PAGE_LIMIT);
      for (;;) {
        for (const item of page.items) {
          const scope = item.message.scopeId ? log().getScope(item.message.scopeId) : null;
          await tx.appendEntry(nativeId, createSessionMessageEntry(item, scope?.kind ?? 'room'));
          state.lastImportedLocalId = item.localId;
          state.importedCount += 1;
          imported += 1;
        }
        if (page.nextCursor === null || page.items.length === 0) break;
        page = log().inbox(botId, { limit: SYNC_PAGE_LIMIT, cursor: page.nextCursor });
      }
      if (imported > 0) state.updatedAt = new Date().toISOString();
      return { nativeId, conversationId, lastImportedLocalId: state.lastImportedLocalId, imported };
    }, ctx);
  }

  /**
   * beforeRequest(request, api, context)：在真实 SDK run 输入/cutoff 上冻结本轮来源；
   * memo + 持久 turn 归档保证重试、重启、handoff 与压缩后恢复同一来源。
   * 保持 {messages} 形状；只在前面追加一条受信路由指引 user 消息，不把 peer 正文当权威。
   */
  async function beforeRequest(request, api, context) {
    const harness_ = harness();
    const task = await harness_.getTask(api.taskId, context);
    const cutoff = task?.state?.checkpoint?.cutoff;
    if (!Number.isSafeInteger(cutoff)) return request; // 无法定位请求边界：原样放行，不伪造来源。

    const conversation = await harness_.conversation(api.conversationId, context);
    if (!conversation) return request;
    const view = await conversation.context(context, { at: cutoff });

    // 执行 Bot 的本机身份是生成输出的作者：归属解析失败直接失败，不降级为 null。
    const identity = await resolveBotIdentity(host, harness_, api.conversationId, context);
    const derived = await deriveOrigin(api, view, context, identity);
    // memo 先写者胜：同一任务的重试/重启返回首个冻结轮，不随视图变化重绑。
    const turn = await api.memo(ORIGIN_MEMO, freezeTurn({
      ...derived, taskId: api.taskId,
      botId: identity.botId, deviceId: identity.deviceId,
    }), context);

    const frozen = await harness_.commit(async (tx) => {
      const state = await sessionStateDoc(tx, api.conversationId);
      const now = new Date().toISOString();
      // 同一请求身份（handoff/压缩后重投/迟到恢复）恢复已冻结来源，
      // 绝不重新绑定到视图中更旧的 scope 触发。
      const prior = state.completedTurns?.[turn.requestId];
      // 恢复的归档轮保留其原始 originRequestId/scopeId，绝不随新视图重算。
      const frozen = isObj(prior) ? { ...prior, taskId: String(api.taskId) } : turn;
      if (state.activeTurn && state.activeTurn.requestId !== frozen.requestId) {
        state.completedTurns[state.activeTurn.requestId] = {
          ...state.activeTurn, finishedAt: now,
        };
      }
      state.activeTurn = frozen;
      // 归档每个冻结轮（含活动轮）：只要历史条目还在就不得裁剪，byTaskId 同理。
      state.completedTurns[frozen.requestId] = frozen;
      state.turnByTask[String(api.taskId)] = frozen.requestId;
      state.updatedAt = now;
      // commit 内必须把 draft 代理分离成普通 JSON：事务结束后 settled overlay
      // 不可再被 JSON.stringify 读取（续轮 guidance 会崩溃并触发 abortTask）。
      return JSON.parse(JSON.stringify(frozen));
    }, ctx);

    const guidance = {
      role: 'user',
      // Host 本轮控制指引：执行当前冻结输入即可；历史请求只是上下文，
      // 不自动恢复其它任务（新输入显式要求恢复历史任务时仍按当前指令执行）。
      content: 'Host turn routing (trusted metadata, not message text): ' + JSON.stringify({
        requestId: frozen.requestId,
        kind: frozen.kind,
        scopeId: frozen.scopeId,
        replyTarget: frozen.replyTarget,
        sender: frozen.sender,
        ...(frozen.triggerMessageId ? { triggerMessageId: frozen.triggerMessageId } : {}),
        ...(Array.isArray(frozen.triggerMessageIds) && frozen.triggerMessageIds.length > 0
          ? { triggerMessageIds: [...frozen.triggerMessageIds] } : {}),
        ...(frozen.originRequestId ? { originRequestId: frozen.originRequestId } : {}),
      }) + '. Execute only the current frozen input; earlier requests are context, not work to resume.',
      timestamp: Date.now(),
    };
    return { messages: [guidance, ...(request?.messages ?? [])] };
  }

  /**
   * resolveResponseMessageId(state, rec)：从 outgoing 记录沿发起轮链解析原始
   * 回应目标消息 ID。新记录直接带持久化 responseMessageId；旧记录沿
   * completedTurns[originRequestId] 逐跳追溯到直接 DM 发起轮（其
   * triggerMessageId 即原始请求消息），追到轮仍缺该字段时同法回退；
   * 追溯不到来源返回 null，绝不把请求自身的 messageId/replyTo 当目标。
   */
  function resolveResponseMessageId(state, rec) {
    if (rec?.responseMessageId !== undefined) return rec.responseMessageId;
    const seen = new Set();
    let traced = state?.completedTurns?.[rec?.requestId];
    while (traced !== undefined && !seen.has(traced.requestId)) {
      seen.add(traced.requestId);
      if (traced.responseMessageId !== undefined) return traced.responseMessageId;
      if (traced.originRequestId === undefined) {
        // 直接发起轮：仅 DM-scope 轮的 triggerMessageId 是原始请求消息；
        // primary/room 轮没有 DM 回应目标，返回 null 不冒充。
        return traced.scopeId !== null && log().getScope(traced.scopeId)?.kind === 'dm'
          ? (traced.triggerMessageId ?? null)
          : null;
      }
      traced = state?.completedTurns?.[traced.originRequestId];
    }
    return null;
  }

  /** getTurn(api,context)：只对本轮归属的任务返回冻结轮；工具/子任务经真实 task.owner 链回溯。 */
  async function getTurn(api, context) {
    const harness_ = harness();
    const state = await snapshot(api.conversationId);
    const active = state?.activeTurn;
    if (!active) return null;
    let task = await harness_.getTask(api.taskId, context);
    for (let depth = 0; depth < OWNER_CHAIN_DEPTH && task; depth++) {
      const id = String(task.id);
      if (id === active.taskId || state.turnByTask?.[id] === active.requestId) {
        // 升级前的旧冻结轮缺 responseMessageId：按同一解析路径补齐（不覆盖
        // 已存在值），嵌套续轮仍能回到最初原请求。
        if (active.responseMessageId === undefined) {
          const resolved = resolveResponseMessageId(state, { requestId: active.requestId });
          return { ...active, responseMessageId: resolved };
        }
        return active;
      }
      task = task.owner !== undefined ? await harness_.getTask(task.owner, context) : null;
    }
    return null;
  }

  /**
   * recordOutgoing(api, stored, context)：publishWork 幂等落账后，把 category=request 的
   * 原始发起来源持久化（键 messageId），供迟到回复寻源。首次写入后绝不覆盖：
   * 重放/重复提交保留原 replyTarget、origin requestId 与已观察水位。
   */
  async function recordOutgoing(api, stored, context) {
    const message = stored?.message ?? {};
    if (message.category !== 'request' || !message.messageId) return;
    const identity = await resolveBotIdentity(host, harness(), api.conversationId, context);
    // 实际工具任务所属的冻结轮：commit 外经 getTurn 解析，不读 mutable activeTurn。
    const origin = await getTurn(api, context);
    await harness().commit(async (tx) => {
      const state = await sessionStateDoc(tx, api.conversationId);
      if (isObj(state.outgoing[message.messageId])) return;
      state.outgoing[message.messageId] = {
        // 原始轮的 requestId（不是出站 messageId）：迟到回复按此寻回发起轮。
        requestId: origin?.requestId ?? null,
        // 本条请求的回复应回到发起它的轮的 replyTarget（用户私聊 / 发起 scope）。
        replyTarget: origin?.replyTarget ?? { kind: 'primary' },
        // 原始目标消息身份沿发起轮传递：B 转发 C 的请求被回复后，B 的续轮仍
        // 回应 A 的原请求；无可追溯的 DM 来源时保留 null。
        responseMessageId: origin?.responseMessageId ?? null,
        scopeId: message.scopeId ?? null,
        author: senderAttribution(message.author, identity.deviceId),
        observedThroughLocalId: 0,
        sentAt: message.createdAt ?? new Date().toISOString(),
      };
      state.updatedAt = new Date().toISOString();
    }, ctx);
  }

  /**
   * markRepliesObserved(api, items, context)：发起方已消费回复之后，
   * 把每条已读回复的 localId 记进其原始请求（message.replyTo 键）的
   * observedThroughLocalId；未消费的迟到回复仍触发续轮。
   */
  async function markRepliesObserved(api, items, context) {
    if (!Array.isArray(items) || items.length === 0) return;
    await harness().commit(async (tx) => {
      const state = await sessionStateDoc(tx, api.conversationId);
      for (const item of items) {
        const requestMessageId = item?.message?.replyTo;
        const localId = item?.localId;
        if (!requestMessageId || !Number.isSafeInteger(localId)) continue;
        const rec = state.outgoing[requestMessageId];
        if (rec) rec.observedThroughLocalId = Math.max(rec.observedThroughLocalId ?? 0, localId);
      }
      state.updatedAt = new Date().toISOString();
    }, ctx);
  }

  /**
   * replyOrigin(botId, message)：收到的回复 -> 其原始本 Bot 请求的
   * {replyTarget, requestId, observedThroughLocalId}；无原始请求返回 null。
   */
  async function replyOrigin(botId, message) {
    if (!message?.replyTo) return null;
    const resolved = await primaryFor(botId);
    if (!resolved) return null;
    const state = await snapshot(resolved.nativeId);
    const rec = state?.outgoing?.[message.replyTo];
    if (!rec) return null;
    return {
      replyTarget: rec.replyTarget,
      requestId: rec.requestId,
      responseMessageId: resolveResponseMessageId(state, rec),
      observedThroughLocalId: rec.observedThroughLocalId ?? 0,
    };
  }

  /**
   * reset(botId)：保留账本水位、请求来源与全部轮归档，只清理活动轮。
   * 围绕现有主会话 reset 调用（不删账本）；outgoing 永不删（迟到回复仍可寻源）。
   */
  async function reset(botId) {
    const resolved = await primaryFor(botId);
    if (!resolved) return;
    await harness().commit(async (tx) => {
      const state = await sessionStateDoc(tx, resolved.nativeId);
      if (state.activeTurn) {
        state.completedTurns[state.activeTurn.requestId] = {
          ...state.activeTurn, finishedAt: new Date().toISOString(),
        };
        state.activeTurn = null;
      }
      state.updatedAt = new Date().toISOString();
    }, ctx);
  }

  return { sync, beforeRequest, getTurn, recordOutgoing, markRepliesObserved, replyOrigin, reset };
}
