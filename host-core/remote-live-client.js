// host-core/remote-live-client.js
//
// 远程控制连接的实时订阅辅助：管理 live 订阅生命周期、帧语义校验、每订阅
// 最新单个完整快照缓存与拉式迭代器。不创建模型会话；取消只发送 live-cancel，
// 绝不向 Host 透传自由错误字符串。
import { randomUUID } from 'node:crypto';
import { assertId } from './message-protocol.js';
import {
  LIVE_MAX_CLIENT_SUBSCRIPTIONS,
  LIVE_OPEN_TIMEOUT_MS,
  normalizeLiveTarget,
  normalizeLiveSnapshot,
} from './remote-live-protocol.js';

function isAbortSignal(signal) {
  return (
    signal &&
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  );
}

/**
 * 把实时订阅管理挂到 openRemoteControl 返回的 client 上。hooks 由
 * remote-control-client.js 注入：error(code,outcome) 构造 RemoteControlError，
 * send(frame) 发送已序列化帧，violate() 触发连接级协议违规终结。
 * 返回 { live, handleFrame, terminateAll }。
 */
export function installRemoteLive(client, hooks) {
  const { error: makeError, send: sendFrame, violate: protocolViolation } = hooks;

  const subscriptions = new Map(); // watchId -> sub（仅 active/opening 流）

  // 释放连接侧资源（timer/listener/订阅槽位），保留迭代器自有的缓冲供消费。
  function releaseConnection(sub) {
    if (sub.openTimer) {
      clearTimeout(sub.openTimer);
      sub.openTimer = null;
    }
    if (sub.onAbort) {
      sub.signal.removeEventListener('abort', sub.onAbort);
      sub.onAbort = null;
    }
    subscriptions.delete(sub.watchId);
  }

  function clearBuffers(sub) {
    sub.pendingSnapshot = null;
    sub.endPayload = null;
  }

  function rejectWaiting(sub, err) {
    if (sub.waitingReject) {
      const reject = sub.waitingReject;
      sub.waitingReject = null;
      sub.waitingResolve = null;
      reject(err);
    }
  }

  // 终态终结：设置 terminalError、清理全部资源与缓冲，可选发送 live-cancel，
  // 并拒绝正在等待 next 的消费者（绝不挂到下个远端快照）。
  function terminateSub(sub, err, sendCancel) {
    if (sub.finished) return;
    sub.finished = true;
    sub.terminalError = err;
    clearBuffers(sub);
    releaseConnection(sub);
    if (sendCancel) sendFrame({ type: 'live-cancel', watchId: sub.watchId });
    rejectWaiting(sub, err);
  }

  function consumeNext(sub) {
    if (sub.terminalError) return Promise.reject(sub.terminalError);
    if (sub.finished) return Promise.resolve({ done: true });
    if (sub.pendingSnapshot !== null) {
      const snapshot = sub.pendingSnapshot;
      sub.pendingSnapshot = null;
      return Promise.resolve({ value: snapshot, done: false });
    }
    if (sub.endPayload !== null) {
      const end = sub.endPayload;
      sub.endPayload = null;
      sub.finished = true;
      return Promise.resolve({ value: end, done: false });
    }
    if (sub.state === 'ended') {
      return Promise.resolve({ done: true });
    }
    if (sub.waitingResolve !== null) {
      return Promise.reject(makeError('INVALID_ARGUMENT', 'not-sent'));
    }
    return new Promise((resolve, reject) => {
      sub.waitingResolve = resolve;
      sub.waitingReject = reject;
    });
  }

  function consumeReturn(sub) {
    if (sub.terminalError || sub.finished) {
      return Promise.resolve({ done: true });
    }
    if (sub.state === 'ended') {
      // 已结束：清缓冲并置 finished，之后 next 只回 done，不再吐旧帧。
      clearBuffers(sub);
      sub.finished = true;
      return Promise.resolve({ done: true });
    }
    terminateSub(sub, makeError('CANCELLED', 'unconfirmed'), true);
    return Promise.resolve({ done: true });
  }

  function onLiveFrame(frame) {
    const sub = subscriptions.get(frame.watchId);
    if (!sub || sub.terminalError || sub.state === 'ended' || sub.state === 'finished') return;
    if (frame.targetDeviceId !== sub.targetDeviceId) {
      protocolViolation();
      return;
    }
    let snapshot;
    try {
      snapshot = normalizeLiveSnapshot(frame.frame, sub.target);
    } catch {
      protocolViolation();
      return;
    }
    if (sub.lastSeq !== null && snapshot.sequence <= sub.lastSeq) {
      protocolViolation();
      return;
    }
    if (sub.convId !== null) {
      if (snapshot.conversationId !== sub.convId) {
        protocolViolation();
        return;
      }
    } else if (snapshot.conversationId !== null) {
      sub.convId = snapshot.conversationId;
    }
    sub.lastSeq = snapshot.sequence;
    if (sub.openTimer) {
      clearTimeout(sub.openTimer);
      sub.openTimer = null;
    }
    sub.receivedSnapshot = true;
    if (sub.waitingResolve !== null) {
      // 交付给 waiter 时必须清空 pending，单快照只能交付一次。
      sub.pendingSnapshot = null;
      const resolve = sub.waitingResolve;
      sub.waitingResolve = null;
      sub.waitingReject = null;
      resolve({ value: snapshot, done: false });
    } else {
      // 慢消费者合并：只保留最新一个完整快照。
      sub.pendingSnapshot = snapshot;
    }
  }

  function onLiveEnd(frame) {
    const sub = subscriptions.get(frame.watchId);
    if (!sub || sub.terminalError || sub.state === 'ended' || sub.state === 'finished') return;
    // active watch 必须精确匹配目标设备；error end 同样先核对身份。
    if (frame.targetDeviceId !== sub.targetDeviceId) {
      protocolViolation();
      return;
    }
    if (frame.reason === 'error') {
      terminateSub(sub, makeError(frame.code, 'unconfirmed'), false);
      return;
    }
    if (!sub.receivedSnapshot) {
      terminateSub(sub, makeError('BAD_RESPONSE', 'unconfirmed'), false);
      return;
    }
    sub.state = 'ended';
    sub.endPayload = { type: 'end', reason: frame.reason };
    // 正常 end 一到即释放连接槽位/timer/listener，不依赖消费者再次 next。
    releaseConnection(sub);
    if (sub.waitingResolve !== null) {
      if (sub.pendingSnapshot !== null) {
        const snapshot = sub.pendingSnapshot;
        sub.pendingSnapshot = null;
        const resolve = sub.waitingResolve;
        sub.waitingResolve = null;
        sub.waitingReject = null;
        resolve({ value: snapshot, done: false });
      } else {
        const end = sub.endPayload;
        sub.endPayload = null;
        sub.finished = true;
        const resolve = sub.waitingResolve;
        sub.waitingResolve = null;
        sub.waitingReject = null;
        resolve({ value: end, done: false });
      }
    }
  }

  function live(targetDeviceId, target, options) {
    if (client.closed || client.violated) throw makeError('NOT_CONNECTED', 'not-sent');
    let liveSignal;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw makeError('INVALID_ARGUMENT', 'not-sent');
      }
      liveSignal = options.signal;
      if (liveSignal !== undefined && !isAbortSignal(liveSignal)) {
        throw makeError('INVALID_ARGUMENT', 'not-sent');
      }
    }
    if (liveSignal && liveSignal.aborted) {
      throw makeError('CANCELLED', 'not-sent');
    }
    try {
      assertId(targetDeviceId, 'targetDeviceId');
    } catch {
      throw makeError('INVALID_ARGUMENT', 'not-sent');
    }
    let norm;
    try {
      norm = normalizeLiveTarget(target);
    } catch {
      throw makeError('INVALID_ARGUMENT', 'not-sent');
    }
    if (subscriptions.size >= LIVE_MAX_CLIENT_SUBSCRIPTIONS) {
      throw makeError('RPC_BUSY', 'not-sent');
    }

    const watchId = randomUUID();
    const sub = {
      watchId,
      targetDeviceId,
      target: norm,
      state: 'opening',
      finished: false,
      terminalError: null,
      pendingSnapshot: null,
      endPayload: null,
      receivedSnapshot: false,
      lastSeq: null,
      convId: null,
      openTimer: null,
      signal: liveSignal,
      onAbort: null,
      waitingResolve: null,
      waitingReject: null,
    };
    if (liveSignal) {
      sub.onAbort = () => terminateSub(sub, makeError('CANCELLED', 'unconfirmed'), true);
      liveSignal.addEventListener('abort', sub.onAbort, { once: true });
    }
    const sent = sendFrame({ type: 'live-open', watchId, targetDeviceId, target: norm });
    if (!sent.ok) {
      terminateSub(sub, makeError(sent.code, 'not-sent'), false);
      throw makeError(sent.code, 'not-sent');
    }
    subscriptions.set(watchId, sub);
    sub.openTimer = setTimeout(() => {
      if (sub.openTimer) terminateSub(sub, makeError('TIMEOUT', 'unconfirmed'), true);
    }, LIVE_OPEN_TIMEOUT_MS);

    const iterator = {
      next: () => consumeNext(sub),
      return: () => consumeReturn(sub),
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  return {
    live,
    handleFrame(frame) {
      if (frame.type === 'live-frame') onLiveFrame(frame);
      else if (frame.type === 'live-end') onLiveEnd(frame);
    },
    terminateAll(err) {
      for (const sub of [...subscriptions.values()]) {
        terminateSub(sub, err, false);
      }
      subscriptions.clear();
    },
  };
}
