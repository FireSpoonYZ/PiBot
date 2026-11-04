// 模块 8：Host 消息投递泵（内部实现，非根导出）。驱动模块 7 持久 outbox，
// 经已认证 relay 连接对外投递。泵自身状态全部易失（inflight/cursor/backoff/
// 诊断），绝不直接改写消息账本；账本仅由 log.receive/log.acknowledge 授权写入。
import { digest, normalizeEnvelope } from './message-protocol.js';
import { DELIVERY_REJECT_CODES } from './relay-protocol.js';

const OUTBOX_PAGE_LIMIT = 200;
const MAX_IN_FLIGHT = 16;
const ACK_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const BACKOFF_ENTRIES_MAX = 256;
const SCAN_INTERVAL_MS = 1000;

export function createMessageDelivery({ messageLog, send, onChange }) {
  let online = false;
  let closed = false;
  let scanTimer = null;
  let wakeTimer = null;
  let cursor = null;
  let lastProblem = null;
  const inFlight = [];
  const backoff = new Map();

  const status = () => ({
    inFlight: inFlight.length,
    lastProblem: lastProblem ? { ...lastProblem } : null,
  });

  const notify = () => {
    if (!onChange) return;
    try {
      onChange(status());
    } catch {
      // listener 异常不影响投递泵。
    }
  };

  const noteProblem = (code, targetDeviceId, messageId) => {
    lastProblem = { code, targetDeviceId, messageId, at: new Date().toISOString() };
  };

  const delayTarget = (target) => {
    const entry = backoff.get(target);
    const delay = entry ? entry.nextDelay : BACKOFF_BASE_MS;
    backoff.set(target, {
      retryAt: Date.now() + delay,
      nextDelay: Math.min(delay * 2, BACKOFF_MAX_MS),
    });
    if (backoff.size > BACKOFF_ENTRIES_MAX) {
      // 只淘汰最旧 backoff 元数据，绝不触碰 outbox。
      backoff.delete(backoff.keys().next().value);
    }
  };

  const findFlight = (target, messageId, flightDigest) =>
    inFlight.findIndex(
      (f) => f.target === target && f.messageId === messageId && f.digest === flightDigest
    );

  const addFlight = (target, messageId, flightDigest) => {
    inFlight.push({ target, messageId, digest: flightDigest, deadline: Date.now() + ACK_TIMEOUT_MS });
    notify();
  };

  const dropFlight = (target, messageId, flightDigest) => {
    const index = findFlight(target, messageId, flightDigest);
    if (index !== -1) {
      inFlight.splice(index, 1);
      notify();
    }
  };

  const expireFlights = () => {
    const now = Date.now();
    let expired = false;
    for (let i = inFlight.length - 1; i >= 0; i -= 1) {
      const flight = inFlight[i];
      if (flight.deadline > now) continue;
      inFlight.splice(i, 1);
      delayTarget(flight.target);
      noteProblem('ACK_TIMEOUT', flight.target, flight.messageId);
      expired = true;
    }
    if (expired) notify();
  };

  const sendFrame = (frame) => {
    try {
      return send(frame);
    } catch {
      // send 异常视为未接受，源端重发再生。
      return false;
    }
  };

  const sendReject = (targetDeviceId, messageId, envelope, code) => {
    sendFrame({ type: 'reject', targetDeviceId, messageId, digest: digest(envelope), code });
  };

  const handleDeliver = (frame) => {
    let envelope;
    try {
      envelope = normalizeEnvelope(frame.message);
    } catch {
      // 结构非法应已被 readServerFrame 拦截；无法构成合法 reject，直接忽略。
      return;
    }
    let received;
    try {
      received = messageLog.receive({ deviceId: frame.fromDeviceId }, envelope);
    } catch (err) {
      const code =
        err && typeof err.code === 'string' && DELIVERY_REJECT_CODES.has(err.code)
          ? err.code
          : 'STORE_FAILED';
      sendReject(frame.fromDeviceId, envelope.messageId, envelope, code);
      return;
    }
    if (received && received.ack) {
      // 重复投递也稳定回 ACK；发送失败只丢弃，下次源端重发再生。
      sendFrame({ type: 'ack', targetDeviceId: frame.fromDeviceId, ack: received.ack });
    }
  };

  const handleAck = (frame) => {
    const ack = frame.ack;
    if (!ack || typeof ack !== 'object') return;
    // 迟到合法 ACK 也写账本；存储失败不算成功——保留 flight 等超时/重投，
    // 不当成功清掉。
    try {
      messageLog.acknowledge({ deviceId: frame.fromDeviceId }, ack);
    } catch (err) {
      const code =
        err && typeof err.code === 'string' && DELIVERY_REJECT_CODES.has(err.code)
          ? err.code
          : 'STORE_FAILED';
      noteProblem(code, ack.recipientDeviceId, ack.messageId);
      notify();
      return;
    }
    // 只有落账成功才允许按 id/digest/recipient 精确匹配并清对应 flight，
    // 绝不误清此 target 另一个 msg 的当前 flight。
    const index = findFlight(ack.recipientDeviceId, ack.messageId, ack.digest);
    if (index !== -1) {
      const target = inFlight[index].target;
      inFlight.splice(index, 1);
      backoff.delete(target);
      notify();
    }
  };

  const handleReject = (frame) => {
    const index = findFlight(frame.fromDeviceId, frame.messageId, frame.digest);
    if (index === -1) return;
    const flight = inFlight[index];
    inFlight.splice(index, 1);
    delayTarget(flight.target);
    noteProblem(frame.code, flight.target, flight.messageId);
    notify();
  };

  const handleUnavailable = (frame) => {
    const index = findFlight(frame.targetDeviceId, frame.messageId, frame.digest);
    if (index === -1) return;
    const flight = inFlight[index];
    inFlight.splice(index, 1);
    delayTarget(flight.target);
    noteProblem(frame.code, flight.target, flight.messageId);
    notify();
  };

  const handle = (frame) => {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
    switch (frame.type) {
      case 'deliver':
        handleDeliver(frame);
        break;
      case 'ack':
        handleAck(frame);
        break;
      case 'reject':
        handleReject(frame);
        break;
      case 'unavailable':
        handleUnavailable(frame);
        break;
      default:
        break;
    }
  };

  const drain = () => {
    if (!online || closed) return;
    expireFlights();
    let page;
    try {
      page = messageLog.outbox({ limit: OUTBOX_PAGE_LIMIT, cursor });
    } catch {
      noteProblem('STORE_FAILED', null, null);
      notify();
      return;
    }
    for (const item of page.items) {
      if (inFlight.length >= MAX_IN_FLIGHT) break;
      if (inFlight.some((f) => f.target === item.targetDeviceId)) continue;
      const entry = backoff.get(item.targetDeviceId);
      if (entry && entry.retryAt > Date.now()) continue;
      const target = item.targetDeviceId;
      const messageId = item.message.messageId;
      const flightDigest = digest(item.message);
      // 先登记 flight 再 send：同步 send 适配器内回调的 ACK 能匹配上。
      addFlight(target, messageId, flightDigest);
      if (!sendFrame({ type: 'deliver', targetDeviceId: target, message: item.message })) {
        // sendfalse 只精确撤销该 flight，不丢其他 target。
        dropFlight(target, messageId, flightDigest);
      }
    }
    // 无论发送/跳过多少都轮转游标：阻塞项在游标回绕后重访，避免永久饥饿。
    cursor = page.nextCursor;
  };

  const stopTimers = () => {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  };

  const wake = () => {
    if (closed || !online || wakeTimer) return;
    // 单个 coalesced timer：已挂起的不重复。
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      drain();
    }, 0);
  };

  const setOnline = (value) => {
    if (closed) return;
    const next = !!value;
    if (next === online) return;
    online = next;
    if (online) {
      scanTimer = setInterval(drain, SCAN_INTERVAL_MS);
      notify();
      wake();
    } else {
      stopTimers();
      inFlight.length = 0;
      cursor = null;
      backoff.clear();
      lastProblem = null;
      notify();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    stopTimers();
    inFlight.length = 0;
    cursor = null;
    backoff.clear();
    lastProblem = null;
    // 不关闭 messageLog：归调用方所有。
  };

  return { setOnline, handle, wake, getStatus: status, close };
}
