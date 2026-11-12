// host-core/pending-client.js
// Module 14: 客户端待发送调度。enqueue 人类意图（primary bot 提交与 room
// 消息），持久化在 pending-store，经注入的固定操作传输发送。
//
// 注入 call 契约：
//   call(targetDeviceId, method, params, { signal }) -> Promise<any>
// 允许的方法（固定业务协议，不可扩展）：
//   'submit'              params {botId, requestId, text, attachments?}     -> 受理回执
//   'getSubmission'       params {botId, requestId}                         -> 回执 | null
//   'publishUserMessage'  params {scopeId, input:{messageId,text,replyTo}}   -> 消息信封
//   'getScopeMessage'     params {scopeId, messageId}                       -> 信封 | null
// 传输错误 reject 为 {code, outcome, status?}：outcome ∈ not-sent/unconfirmed/responded；
// code 非 CONTROL_ERROR_CODES∪REPLACED 白名单一律按 INTERNAL 过滤；本机
// ControlApiError status 4xx 且 code 属明确拒绝/missing 集合时视为 responded。
import { openPendingStore, assertUuid } from './pending-store.js';
import { messageError, normalizeEnvelope, assertId } from './message-protocol.js';
import { CONTROL_ERROR_CODES } from './remote-control-protocol.js';

// 固定本机连接码（relay 4409 REPLACED 替换关闭）并入白名单；其余非白名单码一律 INTERNAL。
const STABLE_CODES = new Set([...CONTROL_ERROR_CODES, 'REPLACED']);

const DEFINITIVE_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_CWD',
  'REQUEST_CONFLICT',
  'BOT_NOT_FOUND',
  'SCOPE_NOT_FOUND',
  'SCOPE_FORBIDDEN',
  'MODEL_REQUIRED',
  'MODEL_NOT_FOUND',
]);
const MISSING_CODES = new Set(['SUBMISSION_NOT_FOUND', 'MESSAGE_NOT_FOUND']);
const PRIMARY_STATUSES = new Set(['queued', 'placed', 'done', 'unanswered']);
const TURN_ADMISSION_PHASES = new Set(['queued', 'checking', 'synchronizing', 'failed']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocallyCancelled(record) {
  return (
    record.state === 'rejected' &&
    record.receipt === null &&
    record.lastError?.code === 'CANCELLED' &&
    record.lastError?.outcome === 'not-sent'
  );
}

function isTerminalRejected(record) {
  return (
    (record.state === 'rejected' && record.lastError?.code === 'REQUEST_CONFLICT') ||
    isLocallyCancelled(record)
  );
}

function classifyTransportError(err) {
  let rawCode = null;
  if (isPlainObject(err) && typeof err.code === 'string' && err.code !== '') {
    rawCode = err.code;
  }
  const code = rawCode !== null && STABLE_CODES.has(rawCode) ? rawCode : 'INTERNAL';
  let outcome = 'unconfirmed';
  if (isPlainObject(err) && typeof err.outcome === 'string' &&
      (err.outcome === 'not-sent' || err.outcome === 'responded')) {
    outcome = err.outcome;
  } else if (isPlainObject(err) && Number.isInteger(err.status) && err.status >= 400 && err.status <= 499) {
    if (DEFINITIVE_CODES.has(rawCode) || MISSING_CODES.has(rawCode)) outcome = 'responded';
  }
  return { rawCode, code, outcome };
}

// primary 回执：先完整验证公开必需字段/类型，全部合法才比较业务 ID 判矛盾；
// 任何缺失/类型错/未 well-formed 均属畸形不确定响应，不得判永久冲突。
function idValid(value) {
  if (typeof value !== 'string') return false;
  try {
    assertId(value, 'receipt field');
    return true;
  } catch {
    return false;
  }
}

function textValid(value) {
  return typeof value === 'string' && value.isWellFormed();
}

// Host queued receipt 可回显附件元数据（无 base64）；缺失合法，形状坏使整条回执畸形。
const ATTACHMENT_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
function attachmentMetaValid(value) {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id)) return false;
  if (!textValid(value.name)) return false;
  if (!ATTACHMENT_MIME_TYPES.has(value.mimeType)) return false;
  for (const field of ['size', 'width', 'height']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return false;
  }
  return true;
}
function attachmentsValid(value) {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) && value.length <= 16 && value.every(attachmentMetaValid);
}

// Host-queued turn admission on the receipt: id/phase/可选 error 的严格形状，
// 不带文本或凭据。缺失/形状坏使整条回执畸形（读路径保留 unconfirmed，不永久拒绝）。
function admissionValid(value) {
  if (!isPlainObject(value)) return false;
  if (!idValid(value.requestId)) return false;
  if (!TURN_ADMISSION_PHASES.has(value.phase)) return false;
  if (value.error !== undefined) {
    const error = value.error;
    if (!isPlainObject(error) || !textValid(error.code) || !textValid(error.message)) return false;
  }
  return true;
}

function validatePrimaryReceipt(result, record) {
  if (!isPlainObject(result)) return { kind: 'malformed' };
  if (
    !idValid(result.botId) ||
    !idValid(result.requestId) ||
    // Host 排队回执可无 conversationId/submissionId（会话/原生提交尚不存在）；
    // 原生提交后两者恒为非空 id/正整数。
    !(result.conversationId === null || idValid(result.conversationId)) ||
    !(result.submissionId === null ||
      (typeof result.submissionId === 'number' &&
        Number.isSafeInteger(result.submissionId) &&
        result.submissionId >= 1)) ||
    !PRIMARY_STATUSES.has(result.status) ||
    (result.admission !== undefined && result.admission !== null && !admissionValid(result.admission)) ||
    !attachmentsValid(result.attachments) ||
    !(result.answerText === null || textValid(result.answerText)) ||
    !(result.reason === null || textValid(result.reason))
  ) {
    return { kind: 'malformed' };
  }
  if (result.botId !== record.botId || result.requestId !== record.requestId) {
    return { kind: 'contradiction' };
  }
  return {
    kind: 'accepted',
    receipt: {
      botId: result.botId,
      conversationId: result.conversationId,
      requestId: result.requestId,
      submissionId: result.submissionId,
      status: result.status,
      ...(result.admission !== undefined && result.admission !== null ? { admission: result.admission } : {}),
      ...(result.attachments !== undefined && result.attachments !== null ? { attachments: result.attachments } : {}),
      answerText: result.answerText,
      reason: result.reason,
    },
  };
}

// room 回执校验：从 StoredMessage.message 或直接 Envelope 经 normalizeEnvelope 严格校验，
// 再比较 source/scope/message/作者/类别/text/replyTo。
function validateRoomReceipt(result, record) {
  const candidate = isPlainObject(result) && isPlainObject(result.message) ? result.message : result;
  let env;
  try {
    env = normalizeEnvelope(candidate);
  } catch {
    return { kind: 'malformed' };
  }
  const matches =
    env.sourceDeviceId === record.targetDeviceId &&
    env.scopeId === record.scopeId &&
    env.messageId === record.messageId &&
    env.author.kind === 'user' &&
    env.category === 'public' &&
    env.text === record.text &&
    (env.replyTo ?? null) === record.replyTo;
  return matches ? { kind: 'accepted', receipt: env } : { kind: 'contradiction' };
}

export function openPendingClient({ dataRoot, deviceId, call }) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw new TypeError('openPendingClient: dataRoot must be a non-blank string');
  }
  if (typeof call !== 'function') {
    throw new TypeError('openPendingClient: call must be a function');
  }
  const store = openPendingStore(dataRoot, deviceId);
  let closed = false;
  let closePromise = null;
  const locks = new Map();
  const controllers = new Set();
  const active = new Set();

  function assertOpen() {
    if (closed) throw new Error('pending client is closed');
  }

  // 每行串行，并发 send/reconcile 排队执行，杜绝首个受理前重复派发。
  function scheduleRowOperation(id, task) {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(() => task());
    const guarded = run.catch(() => {});
    locks.set(id, guarded);
    const tracked = guarded.finally(() => {
      if (locks.get(id) === guarded) locks.delete(id);
      active.delete(tracked);
    });
    active.add(tracked);
    return run;
  }

  // 控制器覆盖请求与落库全程；await 前不清理，外部 signal/close 中止才有效。
  async function withSignal(signal, fn) {
    const controller = new AbortController();
    controllers.add(controller);
    let onAbort = null;
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (signal && signal.aborted) controller.abort();
    try {
      return await fn(controller.signal);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  }

  // 只读对账：missing 仅 null 返回或该方法对应码明确 responded；undefined/畸形返回
  // 与失败均为读失败，保留原状态且绝不触发变更。
  async function readRemote(record, signal) {
    if (record.kind === 'primary') {
      let result;
      try {
        result = await call(
          record.targetDeviceId,
          'getSubmission',
          { botId: record.botId, requestId: record.requestId },
          { signal }
        );
      } catch (err) {
        const t = classifyTransportError(err);
        // primary 仅接受 SUBMISSION_NOT_FOUND 且 responded/local404 判定 missing。
        if (t.rawCode === 'SUBMISSION_NOT_FOUND' && t.outcome === 'responded') return { action: 'missing' };
        return { action: 'failure', error: { code: t.code, outcome: t.outcome } };
      }
      if (result === null) return { action: 'missing' };
      if (result === undefined) {
        return { action: 'failure', error: { code: 'BAD_RESPONSE', outcome: 'responded' } };
      }
      const v = validatePrimaryReceipt(result, record);
      if (v.kind === 'accepted') return { action: 'accepted', receipt: v.receipt };
      if (v.kind === 'contradiction') return { action: 'contradiction' };
      return { action: 'failure', error: { code: 'BAD_RESPONSE', outcome: 'responded' } };
    }

    let result;
    try {
      result = await call(
        record.targetDeviceId,
        'getScopeMessage',
        { scopeId: record.scopeId, messageId: record.messageId },
        { signal }
      );
    } catch (err) {
      const t = classifyTransportError(err);
      // room 仅接受 MESSAGE_NOT_FOUND 且 responded/local404 判定 missing。
      if (t.rawCode === 'MESSAGE_NOT_FOUND' && t.outcome === 'responded') return { action: 'missing' };
      return { action: 'failure', error: { code: t.code, outcome: t.outcome } };
    }
    if (result === null) return { action: 'missing' };
    if (result === undefined) {
      return { action: 'failure', error: { code: 'BAD_RESPONSE', outcome: 'responded' } };
    }
    const v = validateRoomReceipt(result, record);
    if (v.kind === 'accepted') return { action: 'accepted', receipt: v.receipt };
    if (v.kind === 'contradiction') return { action: 'contradiction' };
    return { action: 'failure', error: { code: 'BAD_RESPONSE', outcome: 'responded' } };
  }

  // 应用一次只读对账结果；missing 保留状态，失败写安全错误元数据。
  async function reconcileOnce(record, signal) {
    const res = await readRemote(record, signal);
    if (res.action === 'accepted') {
      return {
        action: 'accepted',
        record: store.transition(record.id, { state: 'accepted', receipt: res.receipt, lastError: null }),
      };
    }
    if (res.action === 'contradiction') {
      return {
        action: 'contradiction',
        record: store.transition(record.id, {
          state: 'rejected',
          receipt: null,
          lastError: { code: 'REQUEST_CONFLICT', outcome: 'responded' },
        }),
      };
    }
    if (res.action === 'failure') {
      return {
        action: 'failure',
        record: store.transition(record.id, { state: record.state, receipt: null, lastError: res.error }),
      };
    }
    return { action: 'missing', record };
  }

  async function doReconcile(id, signal) {
    if (closed) throw new Error('pending client is closed');
    const record = store.get(id);
    if (!record) throw messageError('INVALID_ARGUMENT', 'pending record not found');
    if (record.state === 'accepted' || isTerminalRejected(record) || signal.aborted) return record;
    const { record: updated } = await reconcileOnce(record, signal);
    return updated;
  }

  async function doSend(id, signal) {
    if (closed) throw new Error('pending client is closed');
    let record = store.get(id);
    if (!record) throw messageError('INVALID_ARGUMENT', 'pending record not found');
    // accepted 永不再次 mutation；REQUEST_CONFLICT 与本机已取消 rejected 保持（其余 rejected 可显式重试）。
    if (record.state === 'accepted' || isTerminalRejected(record) || signal.aborted) return record;

    // sending 与本机 transition 失败后的同进程残留同样先只读对账，匹配/失败保留，
    // 仅明确 missing 才允许显式重发，避免未重启恢复时直接重复 mutation。
    if (record.state === 'unconfirmed' || record.state === 'sending') {
      const { action, record: reconciled } = await reconcileOnce(record, signal);
      record = reconciled;
      if (action !== 'missing') return record;
    }
    if (closed || signal.aborted) return record;

    // 先持久化 sending 再派发；崩溃后重开将 sending 归为 unconfirmed。
    record = store.markSending(record.id);

    let dispatched;
    try {
      if (record.kind === 'primary') {
        dispatched = await call(
          record.targetDeviceId,
          'submit',
          {
            botId: record.botId,
            requestId: record.requestId,
            text: record.text,
            ...(record.attachments !== undefined ? { attachments: record.attachments } : {}),
            ...(record.delivery === 'steer' ? { delivery: 'steer' } : {}),
          },
          { signal }
        );
      } else {
        dispatched = await call(
          record.targetDeviceId,
          'publishUserMessage',
          {
            scopeId: record.scopeId,
            input: { messageId: record.messageId, text: record.text, replyTo: record.replyTo },
          },
          { signal }
        );
      }
    } catch (err) {
      // 本机 store 失败不在 try 内，不会被误判为远端错误。
      const t = classifyTransportError(err);
      if (t.outcome === 'not-sent') {
        return store.transition(record.id, { state: 'pending', receipt: null, lastError: { code: t.code, outcome: t.outcome } });
      }
      if (t.outcome === 'responded' && DEFINITIVE_CODES.has(t.code)) {
        return store.transition(record.id, { state: 'rejected', receipt: null, lastError: { code: t.code, outcome: t.outcome } });
      }
      return store.transition(record.id, { state: 'unconfirmed', receipt: null, lastError: { code: t.code, outcome: t.outcome } });
    }

    const v = record.kind === 'primary'
      ? validatePrimaryReceipt(dispatched, record)
      : validateRoomReceipt(dispatched, record);
    if (v.kind === 'accepted') {
      return store.transition(record.id, { state: 'accepted', receipt: v.receipt, lastError: null });
    }
    if (v.kind === 'contradiction') {
      return store.transition(record.id, {
        state: 'rejected',
        receipt: null,
        lastError: { code: 'REQUEST_CONFLICT', outcome: 'responded' },
      });
    }
    return store.transition(record.id, {
      state: 'unconfirmed',
      receipt: null,
      lastError: { code: 'BAD_RESPONSE', outcome: 'responded' },
    });
  }

  async function doCancel(id) {
    if (closed) throw new Error('pending client is closed');
    const record = store.get(id);
    if (!record) throw messageError('INVALID_ARGUMENT', 'pending record not found');
    if (isLocallyCancelled(record)) return record;
    if (record.state !== 'pending') {
      throw messageError('REQUEST_CONFLICT', `cannot cancel pending record in state ${record.state}`);
    }
    return store.transition(record.id, {
      state: 'rejected',
      receipt: null,
      lastError: { code: 'CANCELLED', outcome: 'not-sent' },
    });
  }

  function close() {
    // 缓存同一 promise：重复 close 等同一次 join。
    if (!closePromise) {
      closePromise = (async () => {
        closed = true;
        for (const controller of controllers) controller.abort();
        await Promise.allSettled([...active]);
        controllers.clear();
        locks.clear();
        store.close();
      })();
    }
    return closePromise;
  }

  return {
    async enqueue(input) {
      assertOpen();
      return store.enqueue(input);
    },
    async get(id) {
      assertOpen();
      assertUuid(id, 'id');
      return store.get(id);
    },
    async list(options = {}) {
      assertOpen();
      return store.list(options);
    },
    async send(id, options = {}) {
      assertOpen();
      assertUuid(id, 'id');
      return scheduleRowOperation(id, () => withSignal(options?.signal, (sig) => doSend(id, sig)));
    },
    async reconcile(id, options = {}) {
      assertOpen();
      assertUuid(id, 'id');
      return scheduleRowOperation(id, () => withSignal(options?.signal, (sig) => doReconcile(id, sig)));
    },
    async cancel(id) {
      assertOpen();
      assertUuid(id, 'id');
      return scheduleRowOperation(id, () => doCancel(id));
    },
    close,
  };
}
