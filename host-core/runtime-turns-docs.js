import { defineDocFamily } from '@earendil-works/pi-durable';

// Host 每轮准入的持久化文档，均为 session 级 doc family，key = bot.primaryConversationId
// （公开 UUID，不依赖 Durable 数字会话 ID，因此会话尚未创建时也能持久化队列/钉）。
// TurnQueue：按序保存 Host 已受理、尚未原生提交的用户输入；原生提交成功后删除条目。
// 条目可携带可信 origin（sender.kind 'user'|'host'、展示名、replyTo）：仅由可信输入边界
// 写入（已鉴权 HTTP/control submit 记 user、计划任务记 host，wire origin/author 不采信）。
// 原生提交时恒生成 host.user-message 入口归属与冻结轮（缺席 origin 的遗留条目按 Host 记）。
// TurnPin：每个已接纳轮一条 admissionId -> pin 记录，保存原准予的 setId 与安全快照引用，
// 供冷启动 restoreTurns 复用；绝不保存正文、凭据值或快照全文的敏感字段。
// TurnQueue.stopEpoch：停止此 Bot 最近一次的持久审计代次（仅记录，不作本地对账——
// 对账用进程内计数）。stopPending：在飞停止协调的崩溃恢复标记，beginStop 落盘置位、
// 取消成功结算时清除；冷启动在任何 harness.resume 前对置位 Bot 补完 user_stop 与
// 主会话取消标记（quiesce=false），绝不自动恢复漏取消工作。
// 队列条目 stopEpoch：受理时捕获的本进程停止代次；停止只作废代次 ≤ 停止值的条目，
// 受理晚于停止的在飞 submit 在持久化同事务内以旧代次落 cancelled 回执，绝不复活旧工作。
export const TurnQueue = defineDocFamily({
  kind: 'host.turn-queue',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ items: [], stopEpoch: 0, stopPending: false }),
  checkpointWhen: () => false,
});

export const TurnPin = defineDocFamily({
  kind: 'host.turn-pin',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ admissions: {} }),
  checkpointWhen: () => false,
});

// 有界阶段值；错误另行 bounded（code <=64、message <=200，绝不带回正文/凭据）。
// 'cancelled' 是本地终态（abort/Stop），不在对外 TurnAdmissionStatus 相集内，
// 仅用于区分已取消受理：queuedReceipt/wait/findByRequest 读为 unanswered 回执。
export const TURN_PHASES = new Set(['queued', 'checking', 'synchronizing', 'failed']);

const MAX_ERROR_MESSAGE = 200;

function safeError(error) {
  const code = typeof error?.code === 'string' && error.code
    ? error.code.slice(0, 64) : 'TURN_SYNC_FAILED';
  const message = typeof error?.message === 'string' && error.message
    ? error.message.slice(0, MAX_ERROR_MESSAGE) : 'turn synchronization failed';
  return { code, message };
}

/** 对外可见的准入状态：只含 requestId/phase/error，绝不带正文、快照或凭据。 */
export function toTurnAdmissionStatus(item) {
  if (!item) return null;
  return {
    requestId: item.requestId,
    phase: TURN_PHASES.has(item.phase) ? item.phase : 'queued',
    ...(item.error ? { error: safeError(item.error) } : {}),
  };
}

/** 队列条目的受理回执：status 恒为 'queued'；原生提交后由 submission 记录接管。
    字段与 PrimarySubmission 对齐（answerText/reason 为 null），另附 admission 与附件
    展示元数据（绝不带 base64 字节，图片-only 受理因此仍可渲染出待发送缩略信息）。
    phase 'cancelled' 的条目生成终态 unanswered 回执：受理被撤销，但记录仍存在、
    getSubmission/wait/findByRequest 不因唯一的 Host 记录被删而误报不存在。 */
export function toQueuedReceipt(item) {
  const cancelled = item.phase === 'cancelled';
  return {
    botId: item.botId,
    conversationId: item.primaryConversationId ?? null,
    requestId: item.requestId,
    submissionId: item.submissionId ?? null,
    status: cancelled ? 'unanswered' : 'queued',
    answerText: null,
    reason: cancelled ? 'cancelled' : null,
    ...(Array.isArray(item.attachments) && item.attachments.length > 0
      ? { attachments: item.attachments.map(({ id, name, mimeType, size, width, height }) => ({ id, name, mimeType, size, width, height })) }
      : {}),
    admission: cancelled ? null : toTurnAdmissionStatus(item),
  };
}
