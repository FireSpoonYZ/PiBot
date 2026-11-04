// host-core/device-link.js
//
// 模块 8 Host 侧链路：持有本地 MessageLog 与专属 owner 锁，通过已认证中继的
// WebSocket 传输消息。交付泵（pump/重试/入站处理）完全由兄弟模块
// message-delivery.js 承担；本文件只负责 socket 生命周期、认证顺序、分帧
// 限制、断线退避与阻塞判定，绝不读写 runtime 或模型状态。
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { normalizeDeviceName, normalizeDevicePlatform } from './device-metadata.js';
import { join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { openMessageLog } from './messages.js';
import { createMessageDelivery } from './message-delivery.js';
import { createScopeDelivery } from './scope-delivery.js';
import { createReplicaSync } from './replica-sync.js';
import { createLocalControlAdapter } from './local-control-adapter.js';
import { createHostControlReceiver } from './host-control.js';
import { createHostLiveReceiver } from './host-live.js';
import {
  assertDeviceToken,
  parseRelayUrl,
  readServerFrame,
  encodeRelayFrame,
  MAX_RELAY_FRAME_BYTES,
  RELAY_HIGH_WATER_BYTES,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_HEARTBEAT_MS,
  RELAY_CLOSE,
} from './relay-protocol.js';
import { messageError } from './message-protocol.js';

const OWNER_DB = 'device-link-owner.sqlite';
// SQLITE_BUSY (5) / SQLITE_LOCKED (6)：另一个进程已持有本 dataRoot 的链路 owner。
const BUSY_ERRCODES = new Set([5, 6]);
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const WATCHDOG_MS = RELAY_HEARTBEAT_MS * 3;
// 服务端协议关闭码 + ws 策略/超负载码：收到后永久阻塞，不再自动重连。
const BLOCKED_CLOSE_CODES = new Set([
  RELAY_CLOSE.BAD_FRAME,
  RELAY_CLOSE.UNAUTHORIZED,
  RELAY_CLOSE.REVOKED,
  RELAY_CLOSE.REPLACED,
  1008,
  1009,
]);

function linkBusy(message) {
  const err = new Error(message);
  err.code = 'LINK_BUSY';
  return err;
}

function mapOwnerError(err) {
  if (BUSY_ERRCODES.has(err?.errcode) || err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_LOCKED') {
    return linkBusy('device link owner database is locked by another process');
  }
  return err;
}

/**
 * 与 runtime-owner.js 同款真实 SQLite 独占模式，但使用独立文件，绝不借用
 * runtime 的锁：Host runtime 可照常并行运行。busy_timeout=0 使竞争快速失败，
 * 返回 LINK_BUSY；崩溃时 OS 文件锁自动释放，无需 stale/PID 清理。
 */
function acquireDeviceLinkOwner(dataRoot) {
  let db;
  try {
    db = new DatabaseSync(join(dataRoot, OWNER_DB));
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    try { db?.close(); } catch { /* close 失败不掩盖原错误 */ }
    throw mapOwnerError(err);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  return () => {
    if (closed) return;
    try {
      db.exec('ROLLBACK');
    } finally {
      close();
    }
  };
}

function validateCa(ca) {
  if (
    typeof ca !== 'string' ||
    !ca.isWellFormed() ||
    ca.trim() === '' ||
    !ca.includes('-----BEGIN CERTIFICATE-----') ||
    !ca.includes('-----END CERTIFICATE-----')
  ) {
    throw messageError('INVALID_ARGUMENT', 'ca must be a non-empty PEM certificate string');
  }
}

export async function openDeviceLink(options) {
  if (!options || typeof options !== 'object') {
    throw messageError('INVALID_ARGUMENT', 'options must be an object');
  }
  const dataRoot = options.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !isAbsolute(dataRoot)) {
    throw messageError('INVALID_ARGUMENT', 'dataRoot must be a non-empty absolute path');
  }
  // URL/token/ca 全部在写任何数据前校验；失败时不产生任何文件和连接。
  const url = parseRelayUrl(options.url);
  const token = options.token;
  assertDeviceToken(token);
  const ca = options.ca === undefined || options.ca === null ? undefined : options.ca;
  if (ca !== undefined) validateCa(ca);
  const displayName = options.displayName === undefined ? undefined : normalizeDeviceName(options.displayName);
  const platform = normalizeDevicePlatform(options.platform ?? process.platform);
  const onStatus = options.onStatus;
  if (onStatus !== undefined && typeof onStatus !== 'function') {
    throw messageError('INVALID_ARGUMENT', 'onStatus must be a function');
  }
  // control 配置未提供则保持模块 8 legacy 行为；提供时由适配器构造同步完成完整
  // 校验（url/token），坏参数在任何文件/socket 创建前失败，绝不产生数据写入。
  const control = options.control !== undefined ? createLocalControlAdapter(options.control) : null;

  mkdirSync(dataRoot, { recursive: true });
  const releaseOwner = acquireDeviceLinkOwner(dataRoot);
  let log;
  try {
    log = openMessageLog({ dataRoot });
  } catch (err) {
    try { releaseOwner(); } catch { /* 打开失败清理不掩盖原错误 */ }
    throw err;
  }

  let phase = 'connecting';
  let attempt = 0;
  let lastError = null;
  let closed = false;
  let currentGen = 0;
  let currentWs = null;
  let ready = false;
  let backoffBase = BACKOFF_MIN_MS;
  let readyTimer = null;
  let watchdogTimer = null;
  let reconnectTimer = null;

  function getStatus() {
    return {
      deviceId: log.deviceId,
      phase,
      attempt,
      lastError,
      delivery: delivery.getStatus(),
      scopeDelivery: scopeDelivery.getStatus(),
      replicaSync: replicaSync.getStatus(),
    };
  }

  function emitStatus() {
    if (!onStatus) return;
    // 监听器只同步接收元数据快照；异常被隔离，不影响链路。
    try { onStatus(getStatus()); } catch { /* 忽略监听器异常 */ }
  }

  function setPhase(next) {
    phase = next;
    emitStatus();
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearSocketTimers() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function block(code) {
    if (closed || phase === 'blocked') return;
    lastError = code;
    cancelReconnect();
    delivery.setOnline(false);
    scopeDelivery.setOnline(false);
    replicaSync.setOnline(false);
    receiver.reset();
    liveReceiver.reset();
    setPhase('blocked');
  }

  function scheduleReconnect() {
    if (closed || phase === 'blocked') return;
    if (reconnectTimer) return;
    const delay = Math.floor(backoffBase * (1 + Math.random() * 0.2));
    backoffBase = Math.min(BACKOFF_MAX_MS, backoffBase * 2);
    setPhase('backoff');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed && phase !== 'blocked') startConnect();
    }, delay);
  }

  function armWatchdog(gen, ws) {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (gen === currentGen && !closed) {
        // 中继静默（无 ping/message/ready）：按断开处理，走退避重连。
        ws.terminate();
      }
    }, WATCHDOG_MS);
  }

  // 序列化 + 尺寸检查；socket 必须 OPEN，且（除 hello 外）必须已 ready。
  // 不做任意 URL/port 发送，只走当前认证连接。返回是否被接受。
  function sendFrame(frame) {
    const ws = currentWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    let text;
    try {
      text = encodeRelayFrame(frame);
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_RELAY_FRAME_BYTES) return false;
    if (ws.bufferedAmount + bytes > RELAY_HIGH_WATER_BYTES) return false;
    ws.send(text, (err) => {
      // 发送回调出错说明 socket 正在损坏：终止以触发统一断开处理，不泄漏原始错误。
      if (err && ws === currentWs && !closed) {
        ws.terminate();
      }
    });
    return true;
  }

  function deliverySend(frame) {
    if (!ready) return false;
    return sendFrame(frame);
  }

  function sendHello() {
    const ws = currentWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const frame = { type: 'hello', protocolVersion: 1, deviceId: log.deviceId, token };
      // Module 12：scope 协议独立于 M9 control，恒发送 scopeProtocol:1（host-only）。
      frame.scopeProtocol = 1;
      const defaultName = process.platform === 'android' ? '' : hostname().trim();
      frame.displayName = displayName ?? (defaultName && defaultName.length <= 120 && defaultName.isWellFormed()
        ? defaultName : `${Array.from(platform).slice(0, 90).join('')}-${Array.from(log.deviceId).slice(0, 8).join('')}`);
      frame.platform = platform;
      if (control) {
        frame.role = 'host';
        frame.controlProtocol = 2;
      }
      sendFrame(frame);
    }
  }

  const delivery = createMessageDelivery({
    messageLog: log,
    send: deliverySend,
    onChange: () => {
      if (!closed) emitStatus();
    },
  });
  // Module 12：两个新泵共用同一 log、guarded send 与安全 status 监听器。
  const scopeDelivery = createScopeDelivery({
    messageLog: log,
    send: deliverySend,
    onChange: () => {
      if (!closed) emitStatus();
    },
  });
  const replicaSync = createReplicaSync({
    messageLog: log,
    send: deliverySend,
    onChange: () => {
      if (!closed) emitStatus();
    },
  });
  // log.deviceId 已知后再建接收器；execute 为适配器（未配置时为 null），send 只走
  // 已认证 ready 后的当前 socket。控制请求与消息投递泵完全分离。
  const receiver = createHostControlReceiver({
    deviceId: log.deviceId,
    execute: control,
    send: (frame) => (ready ? sendFrame(frame) : false),
  });
  // Module 14：live 接收器与控制接收器完全分离；observe 通过适配器 execute.live
  // 完成本机身份核对与 SSE，send 只走已认证 ready 后的当前 socket。
  const liveReceiver = createHostLiveReceiver({
    deviceId: log.deviceId,
    observe: control ? (target, { signal } = {}) => control.live(log.deviceId, target, { signal }) : null,
    send: (frame) => (ready ? sendFrame(frame) : false),
  });

  function startConnect() {
    if (closed || phase === 'blocked') return;
    const gen = ++currentGen;
    attempt += 1;
    ready = false;
    // 新连接前作废旧代控制/观察调用，旧代回调不会发到新 socket。
    receiver.reset();
    liveReceiver.reset();
    scopeDelivery.setOnline(false);
    replicaSync.setOnline(false);
    setPhase('connecting');
    let ws;
    try {
      ws = new WebSocket(url.href, {
        ...(ca !== undefined ? { ca } : {}),
        maxPayload: MAX_RELAY_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: RELAY_HELLO_TIMEOUT_MS,
      });
    } catch {
      lastError = 'CONNECT_FAILED';
      scheduleReconnect();
      return;
    }
    currentWs = ws;

    const alive = () => gen === currentGen && !closed && ws === currentWs;

    ws.on('open', () => {
      if (!alive()) return;
      // 接受 WS 后 5s 内必须收到 ready；否则按异常断开处理。
      readyTimer = setTimeout(() => {
        readyTimer = null;
        if (alive() && !ready) ws.terminate();
      }, RELAY_HELLO_TIMEOUT_MS);
      armWatchdog(gen, ws);
      sendHello();
    });

    ws.on('message', (data, isBinary) => {
      if (!alive()) return;
      armWatchdog(gen, ws);
      let frame;
      try {
        frame = readServerFrame(data, isBinary);
      } catch {
        block('BAD_FRAME');
        ws.terminate();
        return;
      }
      if (frame.type === 'ready') {
        if (ready || frame.deviceId !== log.deviceId || frame.role === 'client') {
          // ready 重复、身份不匹配或客户端角色：协议违规。
          block('BAD_FRAME');
          ws.terminate();
          return;
        }
        if (frame.scopeProtocol !== 1) {
          // Module 12：必须回显 scopeProtocol:1；否则视为中继未升级，永久阻塞。
          block('UNSUPPORTED_SCOPE_PROTOCOL');
          ws.terminate();
          return;
        }
        if (control && frame.controlProtocol !== 2) {
          // Module 14：v2 控制必须由中继回显 controlProtocol:2；legacy 不回显视为未升级。
          block('UNSUPPORTED_CONTROL_PROTOCOL');
          ws.terminate();
          return;
        }
        ready = true;
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        backoffBase = BACKOFF_MIN_MS;
        lastError = null;
        delivery.setOnline(true);
        scopeDelivery.setOnline(true);
        replicaSync.setOnline(true);
        setPhase('online');
        delivery.wake();
        scopeDelivery.wake();
        replicaSync.wake();
        return;
      }
      if (frame.type === 'hello' || !ready) {
        // 未认证前的业务帧或意外的重复 hello/ready：协议违规，永久阻塞。
        block('BAD_FRAME');
        ws.terminate();
        return;
      }
      if (frame.type === 'control-request' || frame.type === 'control-cancel') {
        try {
          receiver.handle(frame);
        } catch { /* 控制接收器内部异常不影响传输；其自身状态负责诊断 */ }
        return;
      }
      if (frame.type === 'live-request' || frame.type === 'live-cancel') {
        try {
          liveReceiver.handle(frame);
        } catch { /* live 接收器内部异常不影响传输；其自身状态负责诊断 */ }
        return;
      }
      // Module 14：客户端方向 live 帧不允许出现在 Host 侧，视为协议违规。
      if (frame.type === 'live-frame' || frame.type === 'live-end' || frame.type === 'devices-result') {
        block('BAD_FRAME');
        ws.terminate();
        return;
      }
      // Module 12：新 scope/副本帧先路由到对应泵，再走既有投递处理。
      let handled = false;
      try {
        handled = scopeDelivery.handle(frame);
      } catch { /* scope 泵内部异常不影响传输；其自身状态负责诊断 */ }
      if (!handled) {
        try {
          handled = replicaSync.handle(frame);
        } catch { /* 副本泵内部异常不影响传输；其自身状态负责诊断 */ }
      }
      if (handled && frame.type === 'scope-offer') {
        // 新元数据落地后唤醒副本泵，发现新的本地 scope。
        replicaSync.wake();
      }
      try {
        delivery.handle(frame);
      } catch { /* 交付层内部异常不影响传输；其自身状态负责诊断 */ }
      emitStatus();
    });

    ws.on('ping', () => { if (alive()) armWatchdog(gen, ws); });
    ws.on('pong', () => { if (alive()) armWatchdog(gen, ws); });
    // 吞掉原始错误，仅由 close 汇总为固定 code，绝不向外部暴露网络错误文本。
    ws.on('error', () => {});

    ws.on('close', (code) => {
      if (!alive()) return;
      currentWs = null;
      clearSocketTimers();
      if (phase === 'blocked') return;
      delivery.setOnline(false);
      scopeDelivery.setOnline(false);
      replicaSync.setOnline(false);
      receiver.reset();
      liveReceiver.reset();
      const blockedCode = BLOCKED_CLOSE_CODES.has(code)
        ? code === RELAY_CLOSE.UNAUTHORIZED ? 'UNAUTHORIZED'
          : code === RELAY_CLOSE.REVOKED ? 'REVOKED'
          : code === RELAY_CLOSE.REPLACED ? 'REPLACED'
          : 'BAD_FRAME'
        : null;
      if (blockedCode) {
        block(blockedCode);
        return;
      }
      lastError = ready ? 'DISCONNECTED' : 'CONNECT_FAILED';
      scheduleReconnect();
    });
  }

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      cancelReconnect();
      clearSocketTimers();
      setPhase('closed');
      const errors = [];
      try { delivery.close(); } catch (err) { errors.push(err); }
      try { scopeDelivery.close(); } catch (err) { errors.push(err); }
      try { replicaSync.close(); } catch (err) { errors.push(err); }
      try { receiver.close(); } catch (err) { errors.push(err); }
      // Module 14：live 接收器必须 await 其观察退出后再关 log/释放 owner。
      try { await liveReceiver.close(); } catch (err) { errors.push(err); }
      const ws = currentWs;
      currentWs = null;
      if (ws) {
        try { ws.terminate(); } catch (err) { errors.push(err); }
      }
      try { log.close(); } catch (err) { errors.push(err); }
      try { releaseOwner(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'device link close failed');
    })();
    return closePromise;
  }

  startConnect();
  return {
    deviceId: log.deviceId,
    getStatus,
    wake: () => {
      if (!closed && phase === 'backoff') {
        cancelReconnect();
        backoffBase = BACKOFF_MIN_MS;
        startConnect();
      }
      delivery.wake();
      scopeDelivery.wake();
      replicaSync.wake();
    },
    close,
  };
}
