// 模块 12：管理作用域元数据投递泵（新建，非根导出）。驱动持久 pending
// scope 交付行（message_scope_deliveries）经已认证 relay 连接对外发送
// scope-offer，并处理 ack/reject/unavailable。泵自身状态全部易失
// （inflight/cursor/backoff/诊断），绝不直接改写账本；账本仅由
// acceptScopeOffer/acknowledgeScope/recordScopeError 授权写入。
import { digest } from './message-protocol.js';
import { SCOPE_SYNC_ERROR_CODES } from './scope-wire.js';

const OFFER_PAGE_LIMIT = 200;
const MAX_IN_FLIGHT = 16;
const ACK_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const BACKOFF_ENTRIES_MAX = 256;
const SCAN_INTERVAL_MS = 1000;

export function createScopeDelivery({ messageLog, send, onChange }) {
  let online = false;
  let closed = false;
  let draining = false;
  let scanTimer = null;
  let wakeTimer = null;
  let cursor = null;
  let lastProblem = null;
  const inFlight = [];
  const backoff = new Map();

  const status = () => ({
    online,
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

  const noteProblem = (code, scopeId, targetDeviceId) => {
    lastProblem = { scopeId, targetDeviceId, code };
  };

  const delayTarget = (target) => {
    const entry = backoff.get(target);
    const delay = entry ? entry.nextDelay : BACKOFF_BASE_MS;
    backoff.set(target, {
      retryAt: Date.now() + delay,
      nextDelay: Math.min(delay * 2, BACKOFF_MAX_MS),
    });
    if (backoff.size > BACKOFF_ENTRIES_MAX) {
      // 只淘汰最旧 backoff 元数据，绝不触碰 DB 交付行。
      backoff.delete(backoff.keys().next().value);
    }
  };

  const findFlight = (target, scopeId, revision, flightDigest) =>
    inFlight.findIndex(
      (f) =>
        f.target === target &&
        f.scopeId === scopeId &&
        f.revision === revision &&
        f.digest === flightDigest
    );

  const addFlight = (target, scopeId, revision, flightDigest) => {
    inFlight.push({
      target,
      scopeId,
      revision,
      digest: flightDigest,
      deadline: Date.now() + ACK_TIMEOUT_MS,
    });
    notify();
  };

  const dropFlight = (target, scopeId, revision, flightDigest) => {
    const index = findFlight(target, scopeId, revision, flightDigest);
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
      noteProblem('ACK_TIMEOUT', flight.scopeId, flight.target);
      expired = true;
    }
    if (expired) notify();
  };

  const sendFrame = (frame) => {
    try {
      return send(frame);
    } catch {
      // send 异常视为未接受，目标退避后重发再生。
      return false;
    }
  };

  const deriveAck = (record) => ({
    scopeId: record.scope.scopeId,
    revision: record.scope.revision,
    digest: digest(record),
  });

  const handleScopeOffer = (frame) => {
    if (closed || !online) return;
    let derivedAck = null;
    try {
      derivedAck = deriveAck(frame.record);
    } catch {
      // 无法构成合法 ack/reject，忽略（结构非法应由 readServerFrame 拦截）。
      return;
    }
    let ack;
    try {
      ack = messageLog.acceptScopeOffer({ deviceId: frame.fromDeviceId }, frame.record);
    } catch (err) {
      const code =
        err && typeof err.code === 'string' && SCOPE_SYNC_ERROR_CODES.has(err.code)
          ? err.code
          : 'STORAGE_ERROR';
      sendFrame({ type: 'scope-reject', targetDeviceId: frame.fromDeviceId, ack: derivedAck, code });
      return;
    }
    // acceptScopeOffer 直接返回 ScopeAck；提交成功（含重复 offer）稳定回 ACK，
    // 发送失败只丢弃，源端超时重发再生。
    sendFrame({ type: 'scope-ack', targetDeviceId: frame.fromDeviceId, ack });
  };

  const handleScopeAck = (frame) => {
    if (closed || !online) return;
    const ack = frame.ack;
    if (!ack || typeof ack !== 'object') return;
    // 迟到合法 ACK 也写账本；存储失败不算成功——保留 flight 等超时/重投。
    try {
      messageLog.acknowledgeScope({ deviceId: frame.fromDeviceId }, ack);
    } catch (err) {
      const code =
        err && typeof err.code === 'string' && SCOPE_SYNC_ERROR_CODES.has(err.code)
          ? err.code
          : 'STORAGE_ERROR';
      noteProblem(code, ack.scopeId, frame.fromDeviceId);
      notify();
      return;
    }
    // 只有落账成功才允许按 scopeId/revision/digest/target 精确匹配并清对应
    // flight，绝不误清此 target 其它 scope/revision 的当前 flight。
    const index = findFlight(frame.fromDeviceId, ack.scopeId, ack.revision, ack.digest);
    if (index !== -1) {
      const target = inFlight[index].target;
      inFlight.splice(index, 1);
      backoff.delete(target);
      notify();
    }
  };

  const correlateFlight = (target, ack) => {
    if (!ack || typeof ack !== 'object') return -1;
    return findFlight(target, ack.scopeId, ack.revision, ack.digest);
  };

  const handleScopeReject = (frame) => {
    if (closed || !online) return;
    const index = correlateFlight(frame.fromDeviceId, frame.ack);
    if (index === -1) return;
    const flight = inFlight[index];
    inFlight.splice(index, 1);
    delayTarget(flight.target);
    try {
      messageLog.recordScopeError({ deviceId: frame.fromDeviceId }, frame.ack, frame.code);
    } catch {
      // 诊断写入失败不阻断传输退避。
    }
    noteProblem(frame.code, flight.scopeId, flight.target);
    notify();
  };

  const handleScopeUnavailable = (frame) => {
    if (closed || !online) return;
    const index = correlateFlight(frame.targetDeviceId, frame.ack);
    if (index === -1) return;
    const flight = inFlight[index];
    inFlight.splice(index, 1);
    delayTarget(flight.target);
    try {
      messageLog.recordScopeError({ deviceId: frame.targetDeviceId }, frame.ack, frame.code);
    } catch {
      // 诊断写入失败不阻断传输退避。
    }
    noteProblem(frame.code, flight.scopeId, flight.target);
    notify();
  };

  const handle = (frame) => {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return false;
    switch (frame.type) {
      case 'scope-offer':
        handleScopeOffer(frame);
        break;
      case 'scope-ack':
        handleScopeAck(frame);
        break;
      case 'scope-reject':
        handleScopeReject(frame);
        break;
      case 'scope-unavailable':
        handleScopeUnavailable(frame);
        break;
      default:
        return false;
    }
    return true;
  };

  const drain = () => {
    if (!online || closed || draining) return;
    draining = true;
    try {
      expireFlights();
      let page;
      try {
        page = messageLog.scopeOffers({ limit: OFFER_PAGE_LIMIT, cursor });
      } catch {
        noteProblem('STORAGE_ERROR', null, null);
        notify();
        return;
      }
      for (const item of page.items) {
        if (inFlight.length >= MAX_IN_FLIGHT) break;
        if (inFlight.some((f) => f.target === item.targetDeviceId)) continue;
        const entry = backoff.get(item.targetDeviceId);
        if (entry && entry.retryAt > Date.now()) continue;
        const target = item.targetDeviceId;
        const scopeId = item.record.scope.scopeId;
        const revision = item.record.scope.revision;
        const flightDigest = item.digest;
        // 先登记 flight 再 send：同步 send 适配器内回调的 ACK 能匹配上。
        addFlight(target, scopeId, revision, flightDigest);
        if (
          !sendFrame({ type: 'scope-offer', targetDeviceId: target, record: item.record })
        ) {
          // send false 只精确撤销该 flight 并退避该 target，不丢其他 target。
          dropFlight(target, scopeId, revision, flightDigest);
          delayTarget(target);
        }
      }
      // 无论发送/跳过多少都轮转游标：阻塞项在游标回绕后重访，避免永久饥饿。
      cursor = page.nextCursor;
    } finally {
      draining = false;
    }
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
    online = false;
    stopTimers();
    inFlight.length = 0;
    cursor = null;
    backoff.clear();
    lastProblem = null;
    // 不关闭 messageLog：归调用方所有。
  };

  return { setOnline, wake, handle, getStatus: status, close };
}
