// host-core/host-control.js
//
// 模块 9 Host 侧控制接收器：把中继转发的 control-request/control-cancel（服务端
// 形状，已由 relay-protocol/remote-control-protocol 校验）映射到本地适配器
// execute，并把结果编码为 host control-result 帧。与消息投递泵完全分离；不读写
// MessageLog/Runtime/账本，不重试、不排队。取消只中止本次 fetch 等待，绝不动
// runtime.abort。每代（generation）只服务一个连接，断线/reset 后旧代回调不会
// 发到新连接。
import {
  CONTROL_ERROR_CODES,
  CONTROL_MAX_HOST_CALLS,
  CONTROL_OUTCOMES,
  MAX_CONTROL_JSON_BYTES,
} from './remote-control-protocol.js';

function isResultShape(value) {
  return value !== null && typeof value === 'object';
}

/**
 * 创建 Host 控制接收器。execute 为本地适配器函数或 null（未配置控制时）；
 * send 接收已通过编码/尺寸校验的帧，返回是否被接受。返回对象仅暴露
 * handle/reset/close，与消息投递泵互不可见。
 */
export function createHostControlReceiver({ deviceId, execute, send }) {
  let generation = 0;
  let closed = false;
  const active = new Map();

  // active.get(routeId)===rec 确保旧完成绝不清理/覆盖同 routeId 的新记录。
  const isCurrent = (rec) =>
    !closed && !rec.done && rec.gen === generation && active.get(rec.routeId) === rec;

  function sendFailure(routeId, code, outcome) {
    send({ type: 'control-result', routeId, ok: false, code, outcome });
  }

  function finishOk(rec, result) {
    if (!isCurrent(rec)) return;
    rec.done = true;
    active.delete(rec.routeId);
    if (rec.cancelled) return;
    if (!isResultShape(result)) {
      sendFailure(rec.routeId, 'INTERNAL', 'responded');
      return;
    }
    let text;
    try {
      text = JSON.stringify(result);
    } catch {
      sendFailure(rec.routeId, 'INTERNAL', 'responded');
      return;
    }
    if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_CONTROL_JSON_BYTES) {
      sendFailure(rec.routeId, 'RESPONSE_TOO_LARGE', 'responded');
      return;
    }
    send({ type: 'control-result', routeId: rec.routeId, ok: true, result });
  }

  function finishErr(rec, err) {
    if (!isCurrent(rec)) return;
    rec.done = true;
    active.delete(rec.routeId);
    if (rec.cancelled) return;
    const code =
      err && typeof err.code === 'string' && CONTROL_ERROR_CODES.has(err.code)
        ? err.code
        : 'INTERNAL';
    const outcome =
      err && typeof err.outcome === 'string' && CONTROL_OUTCOMES.has(err.outcome)
        ? err.outcome
        : 'unconfirmed';
    sendFailure(rec.routeId, code, outcome);
  }

  function handleRequest(frame) {
    if (closed) return;
    if (!execute) {
      sendFailure(frame.routeId, 'CONTROL_UNAVAILABLE', 'not-sent');
      return;
    }
    // 活动期重复 routeId 绝不双启动；无队列，超出上限立即拒绝。
    if (active.has(frame.routeId)) return;
    if (active.size >= CONTROL_MAX_HOST_CALLS) {
      sendFailure(frame.routeId, 'RPC_BUSY', 'not-sent');
      return;
    }
    const rec = { routeId: frame.routeId, gen: generation, done: false, cancelled: false };
    rec.controller = new AbortController();
    active.set(rec.routeId, rec);
    let promise;
    try {
      promise = execute(deviceId, frame.method, frame.params, { signal: rec.controller.signal });
    } catch (err) {
      finishErr(rec, err);
      return;
    }
    Promise.resolve(promise).then(
      (result) => finishOk(rec, result),
      (err) => finishErr(rec, err)
    );
  }

  function handleCancel(frame) {
    const rec = active.get(frame.routeId);
    if (!rec) return;
    // 只停止本次 fetch 等待；完成回调只清理记录，不再发任何结果帧。
    rec.cancelled = true;
    rec.controller.abort();
  }

  function handle(frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
    if (frame.type === 'control-request') handleRequest(frame);
    else if (frame.type === 'control-cancel') handleCancel(frame);
  }

  function reset() {
    generation += 1;
    const records = [...active.values()];
    active.clear();
    for (const rec of records) rec.controller.abort();
  }

  function close() {
    if (closed) return;
    closed = true;
    reset();
  }

  return { handle, reset, close };
}
