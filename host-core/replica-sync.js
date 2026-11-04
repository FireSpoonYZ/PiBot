// 模块 12：Host 副本修复泵（内部实现，非根导出）。职责：
// 1) 认证服务端：同步响应 replica-request（inventory/history），以 replica-result 回复，
//    规范化/分页/授权全部由 MessageLog 完成，绝不泄漏原始错误文本；
// 2) 有界公平发现/修复驱动：仅针对本地已知 scope（listScopeStates 分页）与本地已知
//    对等设备（listReplicaPeers），最多 4 个活跃修复 job（不同对可共享同一对等设备，
//    但每个对等设备同时最多 1 个在途请求）；发送只由中央轮转调度器执行，响应处理器
//    只更新 job 状态并 wake 调度器，绝不递归发送/推进。
// 泵状态全部易失（jobs/req/cooldown/发现游标）；绝不制造远程完整性/在线声明，
// 绝不发原始源 ACK，绝不用模型或离线邮箱。账本写入仅走 MessageLog 授权方法。
import { randomUUID } from 'node:crypto';
import { SCOPE_SYNC_ERROR_CODES } from './scope-wire.js';

const DISCOVERY_PAGE_LIMIT = 50;
const INVENTORY_LIMIT = 50;
const HISTORY_LIMIT = 50;
const MAX_ACTIVE_PAIRS = 4;
const REQUEST_TIMEOUT_MS = 5000;
const COOLDOWN_SUCCESS_MS = 30000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const COOLDOWN_ENTRIES_MAX = 256;
const SCAN_INTERVAL_MS = 1000;
// 单次调度推进的最大局部状态转移次数：覆盖一页（≤50）全部流与区间转换，
// 保证循环有界且不依赖外部输入增长。
const STEP_ITERATIONS_MAX = 128;

const STABLE_CODE_RE = /^[A-Z0-9_]{1,64}$/;

// 对 key 用 JSON 数组元组：opaque ID 可含任意字符（含 NUL）。
const pairKey = (scopeId, peerDeviceId) => JSON.stringify([scopeId, peerDeviceId]);

// recordReplicaScan 等持久化列只接受稳定大写码；未知/非法一律降级 STORAGE_ERROR。
function stableCode(value) {
  return typeof value === 'string' && STABLE_CODE_RE.test(value) ? value : 'STORAGE_ERROR';
}

export function createReplicaSync({ messageLog, send, onChange }) {
  const deviceId = messageLog && messageLog.deviceId;
  let online = false;
  let closed = false;
  let scanTimer = null;
  let wakeTimer = null;
  let lastProblem = null;
  const activeJobs = new Map();
  const cooldown = new Map();
  let rrOffset = 0;
  // 有界发现状态：最多保留一页 (50) scope 与当前 scope 的一份 peer 列表/偏移。
  const discovery = {
    items: null,
    index: 0,
    cursor: null,
    nextCursor: null,
    peerScope: null,
    peers: null,
    peerIndex: 0,
  };

  const status = () => {
    let inFlight = 0;
    for (const job of activeJobs.values()) {
      if (job.req) inFlight += 1;
    }
    return {
      online,
      inFlight,
      activePairs: activeJobs.size,
      lastProblem: lastProblem ? { ...lastProblem } : null,
    };
  };

  const notify = () => {
    if (!onChange) return;
    try {
      onChange(status());
    } catch {
      // listener 异常不影响修复泵。
    }
  };

  const noteProblem = (scopeId, peerDeviceId, code) => {
    lastProblem = { scopeId, peerDeviceId, code: stableCode(code) };
    notify();
  };

  const coolEntry = (scopeId, peerDeviceId) => cooldown.get(pairKey(scopeId, peerDeviceId));

  const isCooling = (scopeId, peerDeviceId) => {
    const entry = coolEntry(scopeId, peerDeviceId);
    return !!entry && entry.retryAt > Date.now();
  };

  const putCooldown = (key, retryAt, nextDelay) => {
    cooldown.set(key, { retryAt, nextDelay });
    if (cooldown.size > COOLDOWN_ENTRIES_MAX) {
      // 只淘汰最旧 cooldown 元数据，绝不触碰账本。
      cooldown.delete(cooldown.keys().next().value);
    }
  };

  const coolDownError = (scopeId, peerDeviceId) => {
    const entry = coolEntry(scopeId, peerDeviceId);
    const delay = entry ? entry.nextDelay : BACKOFF_BASE_MS;
    putCooldown(pairKey(scopeId, peerDeviceId), Date.now() + delay, Math.min(delay * 2, BACKOFF_MAX_MS));
  };

  const coolDownSuccess = (scopeId, peerDeviceId) => {
    putCooldown(pairKey(scopeId, peerDeviceId), Date.now() + COOLDOWN_SUCCESS_MS, BACKOFF_BASE_MS);
  };

  const sendFrame = (frame) => {
    try {
      return send(frame);
    } catch {
      // send 异常视为未接受。
      return false;
    }
  };

  // 每对等设备同时最多 1 个在途请求（跨所有活跃 job）。
  const peerHasPending = (peerDeviceId) => {
    for (const job of activeJobs.values()) {
      if (job.req && job.peerDeviceId === peerDeviceId) return true;
    }
    return false;
  };

  // 放弃 job：可选记录扫描错误（仅 history 请求），错误退避冷却并保留稳定 lastProblem。
  const abandonJob = (job, code, scanQuery) => {
    if (scanQuery) {
      try {
        messageLog.recordReplicaScan({ deviceId: job.peerDeviceId }, scanQuery, stableCode(code));
      } catch {
        // 扫描记录失败不阻塞放弃。
      }
    }
    const key = pairKey(job.scopeId, job.peerDeviceId);
    activeJobs.delete(key);
    coolDownError(job.scopeId, job.peerDeviceId);
    noteProblem(job.scopeId, job.peerDeviceId, stableCode(code));
  };

  const finishPair = (job) => {
    activeJobs.delete(pairKey(job.scopeId, job.peerDeviceId));
    coolDownSuccess(job.scopeId, job.peerDeviceId);
    notify();
  };

  // 每个 transient 请求使用独立 randomUUID；发送失败立即放弃（请求从未发出，无扫描记录）。
  const sendRequest = (job, operation, query) => {
    const requestId = randomUUID();
    job.req = { requestId, operation, query, deadline: Date.now() + REQUEST_TIMEOUT_MS };
    if (sendFrame({ type: 'replica-request', targetDeviceId: job.peerDeviceId, requestId, operation, query })) {
      notify();
      return true;
    }
    abandonJob(job, 'TRANSPORT_FAILED');
    return false;
  };

  const dispatchInventory = (job) => {
    if (peerHasPending(job.peerDeviceId)) return;
    if (job.invIntent === 'next') {
      // 当前页流已全部处理，清空后只保留下一页流快照。
      job.streams = [];
      job.streamIdx = 0;
    }
    const query = job.invIntent === 'next'
      ? { scopeId: job.scopeId, limit: INVENTORY_LIMIT, cursor: job.invCursor }
      : { scopeId: job.scopeId, limit: INVENTORY_LIMIT, cursor: null };
    sendRequest(job, 'inventory', query);
  };

  const dispatchHistory = (job) => {
    if (peerHasPending(job.peerDeviceId)) return;
    const s = job.stream;
    const query = {
      scopeId: job.scopeId,
      revision: s.revision,
      sourceDeviceId: s.sourceDeviceId,
      afterSequence: s.rangeAfter,
      throughSequence: s.range.to,
      limit: HISTORY_LIMIT,
    };
    sendRequest(job, 'history', query);
  };

  const makeStreamProgress = (stream) => ({
    revision: stream.revision,
    sourceDeviceId: stream.sourceDeviceId,
    highest: stream.highest,
    scanAfter: 0,
    range: null,
    rangeAfter: 0,
  });

  const repairableStream = (stream) =>
    !!stream &&
    typeof stream === 'object' &&
    typeof stream.sourceDeviceId === 'string' &&
    stream.sourceDeviceId.length > 0 &&
    Number.isSafeInteger(stream.revision) &&
    stream.revision >= 1 &&
    Number.isSafeInteger(stream.highest) &&
    stream.highest >= 1;

  // 单个修复 job 的有界控制流推进：仅遍历当前 inventory 页（≤50）的流快照，
  // 所有 `continue` 都处于本 for 循环内；一旦派发请求（或放弃/完成）立即返回，
  // 绝不递归发送。派发受中央轮转调度器约束并检查对等在途占用。
  const stepJob = (job) => {
    if (closed || !online || job.req) return;
    for (let i = 0; i < STEP_ITERATIONS_MAX; i += 1) {
      if (job.req) return;
      if (job.stream) {
        if (!job.stream.range) {
          const query = {
            scopeId: job.scopeId,
            revision: job.stream.revision,
            sourceDeviceId: job.stream.sourceDeviceId,
            afterSequence: job.stream.scanAfter,
            throughSequence: job.stream.highest,
          };
          let range;
          try {
            range = messageLog.nextMissingRange(query);
          } catch (err) {
            abandonJob(job, mapErrorCode(err));
            return;
          }
          if (!range) {
            // 观察最高值以下已无本地缺口：推进流，不伪造远程扫描成功。
            job.stream = null;
            continue;
          }
          job.stream.range = range;
          job.stream.rangeAfter = Math.max(0, range.from - 1);
        }
        dispatchHistory(job);
        return;
      }
      if (job.streamIdx < job.streams.length) {
        const stream = job.streams[job.streamIdx];
        job.streamIdx += 1;
        if (!repairableStream(stream)) continue; // 无可修复序列（含空流），跳过。
        job.stream = makeStreamProgress(stream);
        continue;
      }
      if (job.invIntent) {
        dispatchInventory(job);
        return;
      }
      // 流与分页全部结束：完成本对等 pass。
      finishPair(job);
      return;
    }
  };

  const mapErrorCode = (err) => {
    const code = err && typeof err.code === 'string' ? err.code : null;
    return code && SCOPE_SYNC_ERROR_CODES.has(code) ? code : 'STORAGE_ERROR';
  };

  // 发现驱动：只填满空位（<4）；不同对即使共享对等设备也可同时活跃（每对等在途
  // 限制由中央调度执行）。一 tick 最多推进一个发现页；候选遍历越过活跃/冷却对，
  // 失败/离线对不会永久饿死其他对。
  const discoverCandidates = () => {
    if (closed || !online) return;
    while (activeJobs.size < MAX_ACTIVE_PAIRS) {
      if (!discovery.items) {
        let page;
        try {
          page = messageLog.listScopeStates({ limit: DISCOVERY_PAGE_LIMIT, cursor: discovery.cursor });
        } catch {
          noteProblem(null, null, 'STORAGE_ERROR');
          return;
        }
        discovery.items = page && Array.isArray(page.items) ? page.items : [];
        discovery.index = 0;
        discovery.nextCursor = page && page.nextCursor ? page.nextCursor : null;
      }
      if (discovery.index >= discovery.items.length) {
        discovery.cursor = discovery.nextCursor;
        discovery.nextCursor = null;
        discovery.items = null;
        discovery.peerScope = null;
        discovery.peers = null;
        discovery.peerIndex = 0;
        return; // 下一页下个 tick 再抓，避免单 tick 耗尽所有页。
      }
      const scopeId = discovery.items[discovery.index] && discovery.items[discovery.index].scope
        ? discovery.items[discovery.index].scope.scopeId
        : null;
      if (!scopeId) {
        discovery.index += 1;
        continue;
      }
      if (discovery.peerScope !== scopeId) {
        let peers;
        try {
          peers = messageLog.listReplicaPeers(scopeId) || [];
        } catch {
          noteProblem(scopeId, null, 'STORAGE_ERROR');
          discovery.peerScope = null;
          discovery.peers = null;
          discovery.index += 1;
          continue;
        }
        discovery.peers = peers;
        discovery.peerScope = scopeId;
        discovery.peerIndex = 0;
      }
      while (discovery.peerIndex < discovery.peers.length && activeJobs.size < MAX_ACTIVE_PAIRS) {
        const rawPeer = discovery.peers[discovery.peerIndex];
        discovery.peerIndex += 1;
        const peer = typeof rawPeer === 'string' ? rawPeer : rawPeer && rawPeer.deviceId;
        if (!peer || peer === deviceId) continue;
        const key = pairKey(scopeId, peer);
        if (activeJobs.has(key) || isCooling(scopeId, peer)) continue;
        const job = {
          scopeId,
          peerDeviceId: peer,
          streams: [],
          streamIdx: 0,
          stream: null,
          invIntent: 'initial', // 显式初始 inventory 请求意图。
          invCursor: null,
          req: null,
        };
        activeJobs.set(key, job); // 发送由 serviceJobs 统一派发。
      }
      if (discovery.peerIndex >= discovery.peers.length) {
        discovery.peerScope = null;
        discovery.peers = null;
        discovery.index += 1;
      }
    }
  };

  const expireRequests = () => {
    const now = Date.now();
    for (const job of [...activeJobs.values()]) {
      const req = job.req;
      if (!req || req.deadline > now) continue;
      abandonJob(job, 'REQUEST_TIMEOUT', req.operation === 'history' ? req.query : null);
    }
  };

  // 中央轮转调度器：每次 pass 轮转服务顺序；每个无在途请求的 job 至多推进一步。
  const serviceJobs = () => {
    const keys = [...activeJobs.keys()];
    const n = keys.length;
    if (!n) return;
    rrOffset += 1;
    for (let i = 0; i < n; i += 1) {
      const job = activeJobs.get(keys[(rrOffset + i) % n]);
      if (!job || job.req) continue;
      stepJob(job);
    }
  };

  const drain = () => {
    if (closed || !online) return;
    expireRequests();
    discoverCandidates();
    serviceJobs();
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
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      drain();
    }, 0);
  };

  // ---- 认证服务端：同步响应 replica-request ----
  const serveRequest = (frame) => {
    const peer = { deviceId: frame.fromDeviceId };
    const operation = frame.operation;
    let page;
    try {
      if (operation === 'inventory') {
        page = messageLog.replicaInventory(peer, frame.query);
      } else if (operation === 'history') {
        page = messageLog.replicaHistory(peer, frame.query);
      } else {
        sendFrame({
          type: 'replica-result',
          targetDeviceId: frame.fromDeviceId,
          requestId: frame.requestId,
          operation,
          ok: false,
          code: 'INVALID_ARGUMENT',
        });
        return;
      }
    } catch (err) {
      sendFrame({
        type: 'replica-result',
        targetDeviceId: frame.fromDeviceId,
        requestId: frame.requestId,
        operation,
        ok: false,
        code: mapErrorCode(err),
      });
      return;
    }
    sendFrame({
      type: 'replica-result',
      targetDeviceId: frame.fromDeviceId,
      requestId: frame.requestId,
      operation,
      ok: true,
      page,
    });
  };

  const handleResult = (frame) => {
    let hitKey = null;
    for (const key of activeJobs.keys()) {
      const job = activeJobs.get(key);
      if (
        job &&
        job.req &&
        job.req.requestId === frame.requestId &&
        job.req.operation === frame.operation &&
        job.peerDeviceId === frame.fromDeviceId
      ) {
        hitKey = key;
        break;
      }
    }
    if (!hitKey) return; // 陌生/迟到/错误对等结果一律忽略，绝不导入或误清其他请求。
    const job = activeJobs.get(hitKey);
    const req = job.req;
    job.req = null;
    if (frame.ok !== true) {
      abandonJob(job, frame.code, req.operation === 'history' ? req.query : null);
      return;
    }
    if (req.operation === 'inventory') {
      try {
        messageLog.recordReplicaInventory({ deviceId: job.peerDeviceId }, req.query, frame.page);
      } catch (err) {
        abandonJob(job, mapErrorCode(err));
        return;
      }
      const items = frame.page && Array.isArray(frame.page.items) ? frame.page.items : [];
      for (const stream of items.slice(0, INVENTORY_LIMIT)) {
        job.streams.push(stream);
      }
      if (frame.page && frame.page.nextCursor) {
        job.invIntent = 'next'; // 显式后续 inventory 意图。
        job.invCursor = frame.page.nextCursor;
      } else {
        job.invIntent = null;
        job.invCursor = null;
      }
      wake(); // 仅更新状态并唤醒调度器；发送由 serviceJobs 统一执行。
      return;
    }
    // history
    try {
      messageLog.importReplicaHistory({ deviceId: job.peerDeviceId }, req.query, frame.page);
    } catch (err) {
      abandonJob(job, mapErrorCode(err), req.query);
      return;
    }
    const s = job.stream;
    if (s && frame.page.nextAfterSequence !== null && frame.page.nextAfterSequence !== undefined) {
      // 非 null：同区间以更新后的 afterSequence 继续。
      s.rangeAfter = frame.page.nextAfterSequence;
    } else if (s) {
      // 耗尽（含稀疏空页）：记录扫描成功，推进 scanAfter 到区间终点，绝不重复请求同一缺口。
      try {
        messageLog.recordReplicaScan({ deviceId: job.peerDeviceId }, req.query, null);
      } catch {
        // 扫描记录失败不阻塞推进。
      }
      s.scanAfter = s.range.to;
      s.range = null;
    }
    wake();
  };

  const handleUnavailable = (frame) => {
    // replica-unavailable.targetDeviceId 是失败的远端对等设备。
    let hitKey = null;
    for (const key of activeJobs.keys()) {
      const job = activeJobs.get(key);
      if (
        job &&
        job.req &&
        job.req.requestId === frame.requestId &&
        job.req.operation === frame.operation &&
        job.peerDeviceId === frame.targetDeviceId
      ) {
        hitKey = key;
        break;
      }
    }
    if (!hitKey) return;
    const job = activeJobs.get(hitKey);
    const req = job.req;
    abandonJob(job, frame.code, req.operation === 'history' ? req.query : null);
  };

  const handle = (frame) => {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return false;
    // 离线/关闭状态不执行任何 DB/发送工作。
    if (closed || !online) {
      switch (frame.type) {
        case 'replica-request':
        case 'replica-result':
        case 'replica-unavailable':
          return true;
        default:
          return false;
      }
    }
    switch (frame.type) {
      case 'replica-request':
        serveRequest(frame);
        return true;
      case 'replica-result':
        handleResult(frame);
        return true;
      case 'replica-unavailable':
        handleUnavailable(frame);
        return true;
      default:
        return false;
    }
  };

  const clearVolatile = () => {
    activeJobs.clear();
    cooldown.clear();
    discovery.items = null;
    discovery.index = 0;
    discovery.cursor = null;
    discovery.nextCursor = null;
    discovery.peerScope = null;
    discovery.peers = null;
    discovery.peerIndex = 0;
    rrOffset = 0;
    lastProblem = null;
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
      clearVolatile();
      notify();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    online = false; // close 后状态必须报告 offline。
    stopTimers();
    clearVolatile();
    // 不关闭 messageLog：归调用方所有。
  };

  return { setOnline, wake, handle, getStatus: status, close };
}
