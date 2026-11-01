import { defineDoc } from '@earendil-works/pi-durable';

export function initialDecisionState() {
  return {
    stopped: false,
    handledLocalId: 0,
    pending: null,
    lastDecision: null,
    error: null,
  };
}

// 冻结轮来源（data.turn 同一形状）：executionNativeId 指向统一主会话执行目标；
// binding.nativeId 仍是协调/旧历史 ID，绝不互相替换。缺省字段兼容旧 pending。
export function toFrozenTurn(turn) {
  if (typeof turn !== 'object' || turn === null) return null;
  return {
    requestId: turn.requestId,
    taskId: turn.taskId ?? null,
    kind: turn.kind,
    scopeId: turn.scopeId ?? null,
    ...(turn.botId !== undefined ? { botId: turn.botId } : {}),
    ...(turn.deviceId !== undefined ? { deviceId: turn.deviceId } : {}),
    ...(turn.workNativeId !== undefined ? { workNativeId: turn.workNativeId } : {}),
    ...(turn.triggerMessageId !== undefined ? { triggerMessageId: turn.triggerMessageId } : {}),
    // 同批全部触发消息 ID（多请求合并时不止最后一个），供 codec/UI 归属。
    ...(Array.isArray(turn.triggerMessageIds) ? { triggerMessageIds: [...turn.triggerMessageIds] } : {}),
    ...(turn.replyTo !== undefined ? { replyTo: turn.replyTo } : {}),
    ...(turn.rootId !== undefined ? { rootId: turn.rootId } : {}),
    // 本轮默认回应的目标消息 ID（原始请求）：与触发消息分离持久化，多层续轮
    // 沿它续接原任务，绝不把晚到消息的 replyTo 或触发 ID 当回应目标。
    ...(turn.responseMessageId !== undefined ? { responseMessageId: turn.responseMessageId } : {}),
    // 迟到回复恢复时的原始请求 messageId；与 codec 的 turn.originRequestId 同字段。
    ...(turn.originRequestId !== undefined ? { originRequestId: turn.originRequestId } : {}),
    sender: turn.sender ?? null,
    replyTarget: turn.replyTarget ?? null,
    frozenAt: turn.frozenAt ?? new Date().toISOString(),
  };
}

export const WorkDecisionState = defineDoc({
  kind: 'host.work-decision',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: initialDecisionState,
  checkpointWhen: () => false,
});

// 已删除的 host.work-stop 代次文档：作用域取消只靠 pending requestId/submissionId 精准
// 中止（abortRequestFamily），不需要会话级额外文档，绝不中止无关共享轮。

/** 传入 tx.doc 草稿时须在 commit 内调用，逐字段复制，不能带出已结算的 overlay。 */
export function toWorkActivity(botId, scopeId, meta, state, isMember) {
  const conversationId = meta?.conversationId ?? null;
  const pending = state.pending;
  const lastDecision = state.lastDecision;
  const error = state.error;
  let status;
  if (conversationId === null) status = 'unbound';
  else if (state.stopped) status = 'stopped';
  else if (error !== null) status = 'error';
  else if (!isMember) status = 'inactive';
  else if (pending !== null) status = 'thinking';
  else status = 'idle';

  return {
    botId,
    scopeId,
    conversationId,
    isMember,
    status,
    stopped: state.stopped,
    lastImportedLocalId: meta?.lastImportedLocalId ?? 0,
    handledLocalId: state.handledLocalId,
    pending: pending === null ? null : {
      requestId: pending.requestId,
      submissionId: pending.submissionId,
      startedAt: pending.startedAt,
      preparedThroughLocalId: pending.prepared?.throughLocalId ?? null,
      // 统一执行的会话指针是内部实现细节，不在活动对外输出中暴露。
      ...(pending.executionConversationId !== undefined && pending.executionConversationId !== null
        ? { executionConversationId: pending.executionConversationId }
        : {}),
    },
    lastDecision: lastDecision === null ? null : {
      requestId: lastDecision.requestId,
      outcome: lastDecision.outcome,
      throughLocalId: lastDecision.throughLocalId,
      completedAt: lastDecision.completedAt,
    },
    error: error === null ? null : {
      code: error.code,
      message: error.message,
    },
  };
}
