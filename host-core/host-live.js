// host-core/host-live.js
//
// Module 14 Host 侧实时观察接收器：把中继转发的 live-request/live-cancel（服务端
// 形状，已由 relay-protocol/remote-live-protocol 校验）映射到本机控制服务 live 流，
// 并把规范化快照编码为 host live-frame/live-end 帧。与 createHostControlReceiver
// 完全分离；观察取消只中止本机 HTTP SSE 读取，绝不动 Runtime。每代只服务一个
// 连接，reset 后旧代回调不会发到新连接。
import {
  LIVE_MAX_HOST_SUBSCRIPTIONS,
  normalizeLiveSnapshot,
} from './remote-live-protocol.js';
import { CONTROL_ERROR_CODES } from './remote-control-protocol.js';

const STATE_KEYS = [
  'history',
  'historyTruncated',
  'lastEntryId',
  'generation',
  'tools',
  'toolsTruncated',
  'busy',
  'queuedCount',
  'queuedItems',
  'turnAdmission',
  'activity',
  'learning',
];

const END_REASONS = new Set([
  'stopped',
  'cancelled',
  'session_closed',
  'retired',
  'listener_error',
  'session_failed',
]);

function fixedCode(err) {
  return err && typeof err.code === 'string' && CONTROL_ERROR_CODES.has(err.code)
    ? err.code
    : 'INTERNAL';
}

/**
 * 创建 Host 侧 live 接收器。observe 为 (target,{signal}) => AsyncIterable（本机
 * SSE 帧），可为 null（未配置控制时）；send 接收已通过编码/尺寸校验的帧，返回
 * 是否被接受。返回对象仅暴露 handle/reset/close。
 *
 * 槽位语义：active 记录在 teardown 完全结束前一直占用容量（含取消/反压/错误中
 * 的订阅与跨 reset 代次的未收尾记录）；inflight 跨代次跟踪所有观察 promise，保证
 * reset/close 不会遗忘。
 */
export function createHostLiveReceiver({ deviceId, observe, send }) {
  let generation = 0;
  let closed = false;
  const active = new Map(); // routeId -> rec（slot 持有至 teardown 完成）
  const inflight = new Set(); // 跨代次全部观察 promise（settle 后移除）

  const canSend = (rec) =>
    !closed && !rec.done && !rec.cancelled && rec.gen === generation && active.get(rec.routeId) === rec;

  // 先缓存发送资格再 seal：seal 后 canSend 恒 false，不能随后再查。
  function finish(rec, end) {
    if (rec.done) return;
    const shouldSend = canSend(rec);
    rec.done = true;
    // 取消/旧代/closed 仍禁止发送；只在缓存通过时发唯一 end。
    if (shouldSend && end) send({ type: 'live-end', routeId: rec.routeId, ...end });
  }

  function releaseSlot(rec) {
    if (active.get(rec.routeId) === rec) active.delete(rec.routeId);
    if (rec.promise) inflight.delete(rec.promise);
  }

  // 校验 snapshot/update 帧：botId/scopeId 对齐、序号严格递增、conversationId 稳定
  // （work 允许 null->id 一次，而后恒定）。
  function validateFrame(rec, frame, target) {
    if (frame.botId !== target.botId) return 'BAD_FRAME';
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) return 'BAD_FRAME';
    if (rec.prevSequence !== null && frame.sequence <= rec.prevSequence) return 'BAD_FRAME';
    if (target.kind === 'primary') {
      if (frame.scopeId !== undefined || typeof frame.conversationId !== 'string' || frame.conversationId.length === 0) {
        return 'BAD_FRAME';
      }
    } else {
      if (frame.scopeId !== target.scopeId) return 'BAD_FRAME';
      if (
        frame.conversationId !== null &&
        (typeof frame.conversationId !== 'string' || frame.conversationId.length === 0)
      ) {
        return 'BAD_FRAME';
      }
    }
    if (rec.conversationId !== null) {
      if (frame.conversationId !== rec.conversationId) return 'BAD_FRAME';
    } else if (frame.conversationId !== null) {
      rec.conversationId = frame.conversationId;
    }
    rec.prevSequence = frame.sequence;
    return null;
  }

  // 校验 end 帧：理由白名单、身份/序号一致；identity 使用本帧字段而非先前值。
  function validateEnd(rec, frame, target) {
    if (!END_REASONS.has(frame.reason)) return false;
    if (frame.botId !== target.botId) return false;
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) return false;
    if (rec.prevSequence !== null && frame.sequence < rec.prevSequence) return false;
    if (target.kind === 'primary') {
      if (frame.scopeId !== undefined || typeof frame.conversationId !== 'string' || frame.conversationId.length === 0) {
        return false;
      }
      if (rec.conversationId !== null && frame.conversationId !== rec.conversationId) return false;
    } else {
      if (frame.scopeId !== target.scopeId) return false;
      if (frame.conversationId !== null && (typeof frame.conversationId !== 'string' || frame.conversationId.length === 0)) {
        return false;
      }
      if (rec.conversationId !== null) {
        if (frame.conversationId !== rec.conversationId) return false;
      } else if (frame.conversationId !== null) {
        rec.conversationId = frame.conversationId;
      }
    }
    return true;
  }

  function runSubscription(rec, target) {
    let controller;
    try {
      controller = new AbortController();
    } catch (err) {
      finish(rec, { reason: 'error', code: fixedCode(err) });
      releaseSlot(rec);
      return;
    }
    rec.controller = controller;
    let iter;
    try {
      iter = observe(target, { signal: controller.signal });
    } catch (err) {
      finish(rec, { reason: 'error', code: fixedCode(err) });
      releaseSlot(rec);
      return;
    }

    const promise = (async () => {
      try {
        for await (const frame of iter) {
          if (rec.done) return;
          if (frame.type === 'end') {
            // 无快照的 normal end 不得虚构成功。
            if (!rec.gotSnapshot || !validateEnd(rec, frame, target)) {
              finish(rec, { reason: 'error', code: 'BAD_RESPONSE' });
              return;
            }
            finish(rec, { reason: frame.reason });
            return;
          }
          if (frame.type !== 'snapshot' && frame.type !== 'update') {
            finish(rec, { reason: 'error', code: 'BAD_FRAME' });
            return;
          }
          if (validateFrame(rec, frame, target) !== null) {
            finish(rec, { reason: 'error', code: 'BAD_FRAME' });
            return;
          }
          let state;
          if (frame.type === 'update') {
            // update 仅 primary：先校验本帧 identity（已在上方完成），只合并允许键。
            if (target.kind !== 'primary' || rec.state === null) {
              finish(rec, { reason: 'error', code: 'BAD_FRAME' });
              return;
            }
            if (!frame.changes || typeof frame.changes !== 'object' || Array.isArray(frame.changes)) {
              finish(rec, { reason: 'error', code: 'BAD_FRAME' });
              return;
            }
            for (const key of Object.keys(frame.changes)) {
              if (!STATE_KEYS.includes(key)) {
                finish(rec, { reason: 'error', code: 'BAD_FRAME' });
                return;
              }
            }
            state = { ...rec.state, ...frame.changes };
            rec.state = state;
          } else {
            state = frame.state;
            rec.state = state;
          }
          const out = {
            type: 'snapshot',
            botId: frame.botId,
            conversationId: frame.conversationId ?? null,
            sequence: frame.sequence,
            state,
          };
          if (frame.scopeId !== undefined) out.scopeId = frame.scopeId;
          let normalized;
          try {
            normalized = normalizeLiveSnapshot(out, target);
          } catch {
            finish(rec, { reason: 'error', code: 'BAD_FRAME' });
            return;
          }
          if (!canSend(rec)) return;
          if (!send({ type: 'live-frame', routeId: rec.routeId, frame: normalized })) {
            // 反压：结束观察并 best-effort end，不无界积压。
            finish(rec, { reason: 'error', code: 'BACKPRESSURE' });
            return;
          }
          rec.gotSnapshot = true;
        }
        // 循环结束且未发送 end：正常 EOF 无 end 帧视为协议失败。
        if (!rec.done) finish(rec, { reason: 'error', code: 'BAD_RESPONSE' });
      } catch (err) {
        if (!rec.done) finish(rec, { reason: 'error', code: fixedCode(err) });
      } finally {
        // 每种退出路径（异常/反压/取消/EOF/正常 end）都最终清理 reader。
        try { rec.controller?.abort(); } catch { /* abort 已触发 */ }
        try { await iter.return?.(); } catch { /* teardown 错误不致命 */ }
      }
    })();
    // 先入 inflight/绑定 rec.promise，再挂 settlement handler 释放 slot，避免
    // 同步失败先 releaseSlot 再 add 已结束 promise 的竞态。
    rec.promise = promise;
    inflight.add(promise);
    promise.finally(() => releaseSlot(rec)).catch(() => {});
  }

  function handleRequest(frame) {
    if (closed) return;
    if (!observe) {
      send({ type: 'live-end', routeId: frame.routeId, reason: 'error', code: 'CONTROL_UNAVAILABLE' });
      return;
    }
    // 活动期重复 routeId 绝不双启动；容量 8 按仍未收尾记录计数（含跨代次）。
    if (active.has(frame.routeId)) return;
    if (active.size >= LIVE_MAX_HOST_SUBSCRIPTIONS) {
      send({ type: 'live-end', routeId: frame.routeId, reason: 'error', code: 'RPC_BUSY' });
      return;
    }
    const rec = {
      routeId: frame.routeId,
      gen: generation,
      done: false,
      cancelled: false,
      controller: null,
      promise: null,
      gotSnapshot: false,
      prevSequence: null,
      conversationId: null,
      state: null,
    };
    active.set(rec.routeId, rec);
    runSubscription(rec, frame.target);
  }

  function handleCancel(frame) {
    const rec = active.get(frame.routeId);
    if (!rec) return;
    // 只中止本机观察；槽位待观察退出后释放，避免无限 teardown。
    rec.cancelled = true;
    rec.controller?.abort();
  }

  function handle(frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
    if (frame.type === 'live-request') handleRequest(frame);
    else if (frame.type === 'live-cancel') handleCancel(frame);
  }

  // 提升代次并 abort 全部；不 clear active，未收尾旧代记录继续计容量，
  // 待各自 finally 释放。
  function reset() {
    generation += 1;
    for (const rec of active.values()) {
      rec.controller?.abort();
      if (!rec.done) finish(rec, null);
    }
  }

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      generation += 1;
      for (const rec of active.values()) {
        rec.controller?.abort();
        if (!rec.done) finish(rec, null);
      }
      // join 全部旧/当前 teardown（inflight 跨 reset 代次保留）。
      await Promise.allSettled([...inflight]);
      active.clear();
    })();
    return closePromise;
  }

  return { handle, reset, close };
}
