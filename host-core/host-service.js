import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { openHost } from './host.js';
import { openHostSettings, normalizeHostSettings } from './host-settings.js';
import { applyCenterModels, parseExecutionOptions } from './runtime-models.js';
import { connectCenter } from './center-client.js';
import { openManagedInstaller } from './managed-install/index.js';
import { createTurnSynchronizer } from './turn-sync.js';
import { openControlServer } from './control-server.js';
import { openDeviceLink } from './device-link.js';
import { assertDeviceToken, parseRelayUrl } from './relay-protocol.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
function invalidArgument(message) { return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); }
function offlineError() { return Object.assign(new Error('center is disconnected'), { code: 'CENTER_OFFLINE' }); }

export async function openHostService(options) {
  for (const key of Object.keys(options ?? {})) {
    if (!new Set(['dataRoot', 'token', 'port', 'initialSettings', 'nativeBridge', 'center', 'npmPath', 'displayName', 'platform', 'expectedDeviceId']).has(key)) throw invalidArgument(`unknown option: ${key}`);
  }
  const { dataRoot, token, port, initialSettings, nativeBridge, center, npmPath } = options ?? {};
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw invalidArgument('dataRoot must be an absolute path');
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalidArgument('invalid control token');
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw invalidArgument('invalid port');
  if (nativeBridge !== undefined && typeof nativeBridge !== 'function') throw invalidArgument('nativeBridge must be a function');
  if (npmPath !== undefined && (typeof npmPath !== 'string' || !path.isAbsolute(npmPath))) throw invalidArgument('npmPath must be an absolute path');
  if (!center || typeof center.url !== 'string') throw invalidArgument('center is required');
  assertDeviceToken(center.deviceToken);
  if (center.deviceToken === token) throw invalidArgument('device token must differ from control token');
  if (initialSettings !== undefined) normalizeHostSettings(initialSettings);
  const platform = options.platform ?? process.platform;
  if (typeof platform !== 'string' || !platform.trim() || (options.displayName !== undefined && typeof options.displayName !== 'string')) throw invalidArgument('displayName and platform must be strings');
  const expectedDeviceId = options.expectedDeviceId;
  if (expectedDeviceId !== undefined && (typeof expectedDeviceId !== 'string' || expectedDeviceId.trim() === '')) throw invalidArgument('expectedDeviceId must be a non-empty string');

  const probe = openHost({ dataRoot, expectedDeviceId });
  const deviceId = probe.deviceId;
  probe.close();
  const displayName = options.displayName?.trim() || (platform !== 'android' && os.hostname().trim()) || `${platform}-${deviceId.slice(0, 8)}`;
  function readBots() {
    const host = openHost({ dataRoot });
    try {
      return host.listBots().map((bot) => ({
        deviceId,
        botId: bot.botId,
        name: bot.role,
        description: bot.description ?? '',
        modelRef: bot.modelRef ?? null,
        primaryConversationId: bot.primaryConversationId,
        createdAt: bot.createdAt,
        isPrimary: Boolean(bot.isPrimary),
        lastActivityAt: bot.lastActivityAt ?? null,
        lastPreview: bot.lastPreview ?? null,
        archivedAt: bot.archivedAt ?? null,
        deviceName: displayName,
        platform,
      }));
    } finally { host.close(); }
  }

  let settingsStore, control, link, installer, client;
  let phase = 'starting';
  let closed = false;
  let state = { state: 'connecting', centerUrl: center.url, appliedRevision: null, error: null };
  let activeRevision, lastRevision, frozen, timer, retryTimer, reconcileTimer;
  let generation = 0;
  let configDirty = false;
  let bootstrapPending = false;
  let refreshQueued = null;
  // null = 无待恢复；对象 = 冷启动/刷新中 pin 恢复失败的最近有界错误（恢复成功后置回 null）。
  let pendingTurnRestore = null;
  // 初次全局 resume 是否已发生：pin 恢复失败时保持 false，恢复成功的刷新中补一次。
  let schedulerResumed = false;
  let serial = Promise.resolve();
  const RECONCILE_INTERVAL_MS = 30000;
  const RETRY_INTERVAL_MS = 1000;
  const enqueue = (fn) => {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  };
  const isOffline = (err) => err?.code === 'CENTER_OFFLINE' || err?.code === 'UNAUTHORIZED' || err?.code === 'CONTROL_UNAUTHORIZED';
  let lastReported = null;
  /** 相同回执不重复上报（30 秒核对握手时保持安静），内容变化才发。 */
  async function reportRuntime(current, receipt) {
    const body = { deviceId, ...receipt };
    const key = JSON.stringify(body);
    if (key === lastReported) return;
    await current.reportRuntime(body);
    lastReported = key;
  }
  const linkWaiters = new Set();
  function notifyLinkStatus(status) {
    for (const waiter of linkWaiters) waiter(status);
    if (phase === 'running' && !closed) {
      if (status.phase === 'blocked' || (status.phase === 'online' && state.error)) changed();
    }
  }
  function disconnect() {
    // 只有真实断线才递增 generation、关闭准入并重建连接。
    generation++;
    for (const waiter of linkWaiters) waiter({ phase: 'closed' });
    const previous = client;
    client = null;
    if (previous) void previous.close();
    clearTimeout(retryTimer);
    retryTimer = null;
    lastReported = null;
    state = { ...state, state: 'disconnected', appliedRevision: null, error: { code: 'CENTER_OFFLINE', message: 'center disconnected' } };
    if (control) void control.setCenterOnline(false).catch(() => {});
    if (!closed) scheduleReconnect();
  }
  function scheduleReconnect() {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; void enqueue(reconnect).catch(() => { if (!closed) scheduleReconnect(); }); }, 2000);
    timer.unref?.();
  }
  async function waitLinkOnline(target) {
    const initial = target.getStatus().phase;
    if (initial === 'online') return;
    if (closed || initial === 'blocked' || initial === 'closed') throw offlineError();
    let onStatus;
    const ready = new Promise((resolve, reject) => {
      onStatus = (status) => {
        if (closed || target !== link) reject(offlineError());
        else if (status.phase === 'online') resolve();
        else if (status.phase === 'blocked' || status.phase === 'closed') reject(offlineError());
      };
    });
    const timeout = setTimeout(() => onStatus({ phase: 'closed' }), 15000);
    linkWaiters.add(onStatus);
    try {
      const now = target.getStatus().phase;
      if (now === 'online') return;
      if (closed || now === 'blocked' || now === 'closed') throw offlineError();
      target.wake();
      await ready;
    } finally {
      clearTimeout(timeout);
      linkWaiters.delete(onStatus);
    }
  }
  async function ensureLinkOnline(url) {
    parseRelayUrl(url);
    const currentPhase = link?.getStatus().phase;
    if (!link || url !== linkUrl || currentPhase === 'blocked' || currentPhase === 'closed') {
      if (link) {
        const previous = link;
        link = null;
        linkUrl = undefined;
        await previous.close();
      }
      link = await openDeviceLink({
        dataRoot, url, token: center.deviceToken, ca: center.ca, displayName, platform,
        control: { url: control.url, token },
        onStatus: notifyLinkStatus,
      });
      linkUrl = url;
    }
    try {
      await waitLinkOnline(link);
    } catch (err) {
      if (link && (link.getStatus().phase === 'blocked' || link.getStatus().phase === 'closed')) {
        const failed = link;
        link = null;
        linkUrl = undefined;
        await failed.close().catch(() => {});
      }
      throw err;
    }
  }
  async function applyPlans(current) {
    let waiting = false;
    const planned = [];
    const failed = [];
    for (const plan of await current.getDeployments()) {
      if (current !== client) throw offlineError();
      planned.push(plan.installationId);
      // 失败已由 installer 按计划回报中心；单个部署失败不再令整个 Host 断线。
      const receipt = await installer.apply(plan);
      if (receipt.phase === 'waiting-idle') waiting = true;
      if (receipt.phase === 'failed') failed.push(plan.installationId);
    }
    return { waiting, planned, failed };
  }
  /** 合并在线激活阶段的能力失败：只有真的全部应用才算 applied，不伪报。 */
  function mergeActivation(result, activation) {
    const errors = activation?.capabilityErrors ?? [];
    if (errors.length === 0) return result;
    const affected = new Set(errors.map((item) => item.botId));
    const bots = result.bots.map((bot) => (affected.has(bot.botId) && bot.status === 'applied'
      ? { ...bot, appliedRevision: null, status: 'failed',
        error: { code: 'CAPABILITY_ACTIVATE_FAILED', message: 'one or more capabilities could not be activated' } }
      : bot));
    const failed = bots.some((bot) => bot.status === 'failed');
    return { ...result, bots, status: failed ? 'failed' : result.status,
      appliedRevision: failed ? null : result.appliedRevision,
      error: failed ? { code: 'RUNTIME_APPLY_FAILED', message: 'runtime configuration was only partially applied' } : result.error,
      capabilityErrors: [...result.capabilityErrors, ...errors] };
  }
  async function apply(snapshot, current, gen, { plansApplied = false, resume = false, planning = null } = {}) {
    if (snapshot.deviceId !== deviceId || snapshot.protocol !== 1) throw invalidArgument('invalid center snapshot');
    // 冷启动 pin 恢复未完成时，每次刷新先重试恢复：成功才继续普通应用。
    // 恢复暂停期间绝不 revoke/plan/apply/setCenterOnline/resume——撤销与部署同样会
    // 在未钉的旧 set 上写授权/关实例，且在线激活会重开准入并唤醒 SDK 隐式 resume。
    // 保留恢复错误可见，安排重试后直接返回：HTTP 控制存活供查看/取消，
    // 普通执行与应用维持关闭，旧 pin 不被新配置覆盖。
    if (pendingTurnRestore) {
      try {
        await control.restoreTurns();
        pendingTurnRestore = null;
      } catch (err) {
        pendingTurnRestore = {
          code: typeof err?.code === 'string' && err.code ? err.code : 'TURN_RECOVERY_REQUIRED',
          message: typeof err?.message === 'string' && err.message ? err.message.slice(0, 200) : 'turn restoration incomplete',
        };
        state = { ...state, error: pendingTurnRestore };
        scheduleRetry(true);
        return { revision: snapshot.revision, status: 'waiting', appliedRevision: state.appliedRevision,
          error: pendingTurnRestore, bots: [], capabilityErrors: [] };
      }
    }
    // 新快照已校验：在此同步撤销该撤销的授权（同步删 policy，先于部署/空闲检查）。
    void control.revokeCenterCapabilities(snapshot);
    const plans = plansApplied ? (planning ?? { waiting: false, planned: [], failed: [] }) : await applyPlans(current);
    if (gen !== generation || current !== client) throw offlineError();
    await ensureLinkOnline(snapshot.linkUrl);
    if (gen !== generation || current !== client) throw offlineError();
    const previousRevision = state.appliedRevision;
    if (previousRevision !== snapshot.revision) {
      // 进度心跳；中心可忽略，失败不影响应用。
      await reportRuntime(current, { revision: snapshot.revision, status: 'applying',
        appliedRevision: previousRevision, error: null, bots: [], capabilityErrors: [] }).catch(() => {});
    }
    const applied = await control.applyCenterSnapshot(snapshot,
      { deployment: { planned: plans.planned, failed: plans.failed } });
    if (gen !== generation || current !== client) throw offlineError();
    const activation = await control.setCenterOnline(true);
    if (gen !== generation || current !== client) throw offlineError();
    // resume 只在恢复就绪时发生一次：恢复失败的轮次保持调度暂停，
    // 之后刷新重试成功走到这里补一次 resume；绝不缺定义 resume。
    if ((resume || !schedulerResumed) && !pendingTurnRestore) { schedulerResumed = true; control.resume(); }
    const receipt = mergeActivation(applied, activation);
    await reportRuntime(current, { revision: snapshot.revision, status: receipt.status,
      appliedRevision: receipt.appliedRevision, error: receipt.error,
      bots: receipt.bots, capabilityErrors: receipt.capabilityErrors });
    if (gen !== generation || current !== client) throw offlineError();
    state = { state: 'ready', centerUrl: center.url, appliedRevision: receipt.appliedRevision, error: receipt.error ?? null };
    scheduleRetry(plans.waiting || receipt.bots.some((bot) => bot.status === 'waiting-idle'));
    return receipt;
  }
  async function refresh(bootstrap = false) {
    const current = client;
    const gen = generation;
    if (!current) throw offlineError();
    let snapshot = bootstrap ? (await current.bootstrap(readBots())).snapshot : await current.getSnapshot();
    try {
      snapshot = await initializeBotCwd(snapshot, current, gen);
      return await apply(snapshot, current, gen);
    } catch (err) {
      if (current !== client || closed) throw err;
      // 应用失败不改写已在线状态：旧执行内容仍在服务，交给核对/重试恢复。
      const error = { code: 'CENTER_APPLY_FAILED', message: 'center configuration could not be applied' };
      state = { ...state, error };
      scheduleRetry(true);
      await reportRuntime(current, { revision: snapshot?.revision ?? state.appliedRevision ?? 0,
        status: 'failed', appliedRevision: state.appliedRevision, error, bots: [], capabilityErrors: [] }).catch(() => {});
      throw Object.assign(new Error('center configuration could not be applied'), { code: 'CENTER_APPLY_FAILED', cause: err });
    }
  }
  /** 一次性 cwd 初始化：只对本次快照中缺值的本机 Bot 各尝试一次 expectedRevision:0 CAS；
   * 冲突即中心值胜出、绝不重试覆盖。发生过写入时返回一次最新快照，否则原样返回。 */
  async function initializeBotCwd(snapshot, current, gen) {
    if (gen !== generation || current !== client || closed) throw offlineError();
    if (snapshot.deviceId !== deviceId || snapshot.protocol !== 1) throw invalidArgument('invalid center snapshot');
    const pending = new Set();
    for (const bot of snapshot.bots ?? []) {
      if ((bot.cwd === undefined || bot.cwd === null) && typeof bot.botId === 'string' && bot.botId) pending.add(bot.botId);
    }
    if (pending.size === 0) return snapshot;
    const localCwds = new Map();
    const host = openHost({ dataRoot });
    try {
      for (const bot of host.listBots()) if (pending.has(bot.botId)) localCwds.set(bot.botId, bot.cwd);
    } finally { host.close(); }
    if (localCwds.size === 0) return snapshot;
    for (const [botId, cwd] of localCwds) {
      if (gen !== generation || current !== client || closed) throw offlineError();
      try {
        await current.botCwdSet(deviceId, botId, { expectedRevision: 0, value: cwd });
      } catch (err) {
        if (err?.code !== 'REQUEST_CONFLICT' && err?.code !== 'REVISION_CONFLICT') throw err;
      }
    }
    const updatedSnapshot = await current.getSnapshot();
    if (gen !== generation || current !== client || closed) throw offlineError();
    return updatedSnapshot;
  }
  /** 串行合并刷新：刷新期间的新事件只置脏，本轮结束后补拉最新一次。 */
  function requestRefresh({ bootstrap = false } = {}) {
    if (bootstrap) bootstrapPending = true;
    if (closed || !client) return Promise.resolve(null);
    if (refreshQueued) return refreshQueued;
    refreshQueued = enqueue(async () => {
      let result = null;
      try {
        do {
          configDirty = false;
          const useBootstrap = bootstrapPending;
          bootstrapPending = false;
          result = await refresh(useBootstrap);
        } while ((configDirty || bootstrapPending) && client && !closed);
        return result;
      } finally { refreshQueued = null; }
    });
    return refreshQueued;
  }
  let retryCount = 0;
  function scheduleRetry(needed) {
    if (!needed) {
      clearTimeout(retryTimer);
      retryTimer = null;
      retryCount = 0;
      return;
    }
    if (retryTimer || closed || !client) return;
    // 快重试有界：连续约 30 次后交给 30 秒核对，避免永久 1s 轮询。
    if (retryCount >= RECONCILE_INTERVAL_MS / RETRY_INTERVAL_MS) {
      retryCount = 0;
      return;
    }
    retryCount++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void requestRefresh().catch(() => { if (!closed) scheduleRetry(true); });
    }, RETRY_INTERVAL_MS);
    retryTimer.unref?.();
  }
  function startReconcile() {
    if (reconcileTimer || closed) return;
    // 30 秒低频核对：SSE 静默时也收敛；轮询不会中止运行中的任务。
    reconcileTimer = setInterval(() => { if (!closed) void requestRefresh().catch(() => {}); }, RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
  }
  function changed() {
    configDirty = true;
    void requestRefresh().catch(() => {});
  }
  async function connect() {
    const gen = ++generation;
    const current = await connectCenter({ centerUrl: center.url, deviceId, deviceToken: center.deviceToken, ca: center.ca, onDisconnect: disconnect, onChange: changed, onWebhookReady: () => control?.notifyWebhookReady() });
    if (closed || gen !== generation) { await current.close(); throw offlineError(); }
    client = current;
    return current;
  }
  async function reconnect() {
    if (closed || client) return;
    state = { ...state, state: 'connecting', error: null };
    let current;
    try {
      current = await connect();
      const connectedGeneration = generation;
      const snapshot = await initializeBotCwd((await current.bootstrap(readBots())).snapshot, current, connectedGeneration);
      await apply(snapshot, current, connectedGeneration);
    } catch (err) {
      if (!current || isOffline(err)) {
        if (current) await current.close().catch(() => {});
        disconnect();
        throw err;
      }
      // 已连上但配置应用失败：保留连接，交给核对/重试恢复，不制造新的断线。
      bootstrapPending = true;
      state = { ...state, state: 'disconnected', error: { code: 'CENTER_APPLY_FAILED', message: 'center configuration could not be applied' } };
      scheduleRetry(true);
      throw err;
    }
  }
  let linkUrl;
  try {
    settingsStore = openHostSettings({ dataRoot, deviceId, initialSettings });
    const settings = settingsStore.get();
    activeRevision = lastRevision = settings.revision;
    const current = await connect();
    const initialGeneration = generation;
    const snapshot = await initializeBotCwd((await current.bootstrap(readBots())).snapshot, current, initialGeneration);
    if (snapshot.deviceId !== deviceId || snapshot.protocol !== 1) throw invalidArgument('invalid center snapshot');
    parseRelayUrl(snapshot.linkUrl);
    let installedNpmPath = npmPath;
    if (!installedNpmPath && !nativeBridge && !process.env.ANDROID_ROOT) {
      try { installedNpmPath = path.join(path.dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin', 'npm-cli.js'); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    installer = await openManagedInstaller({
      dataRoot, npmPath: installedNpmPath,
      fetchArtifact: (ref, context) => { if (!client) throw offlineError(); return client.fetchArtifact(ref, context); },
      report: (receipt) => { if (!client) throw offlineError(); return client.reportDeployment(receipt); },
      withActivation: async (id, publish) => {
        if (!control) {
          await publish();
          return true;
        }
        // 激活失败/成功都由本次刷新随后的快照应用重建普通服务（需重建的版本差异会报 waiting-idle 等重试）。
        return control.withCapabilityActivation(id, async () => {
          state = { ...state, state: 'connecting', appliedRevision: null };
          // withCapabilityActivation 已关闭准入；重入其生命周期队列会死锁。
          await publish();
        });
      },
    });
    const bootPlans = await applyPlans(current);
    const { models } = applyCenterModels(snapshot);
    const execution = parseExecutionOptions(settings.settings.runtime);
    control = await openControlServer({
      dataRoot, token, port, models, ...execution, nativeBridge,
      settings: { store: settingsStore, activeRevision }, getServiceStatus: () => getStatus(),
      deferResume: true,
      centerRuntime: {
        snapshot,
        getClient: () => client ?? null,
        installer,
        // 每轮准入协调：只经 center client + installer.prepare，不重入快照/生命周期通道。
        // 平铺到 centerRuntime：runtime-turns 按 contract §3 直接调用 prepareTurn/confirmTurn/restoreTurn。
        ...createTurnSynchronizer({ getClient: () => client ?? null, installer }),
      },
      collaboration: { displayName, platform, relay: { url: snapshot.linkUrl, token: center.deviceToken, ...(center.ca ? { ca: center.ca } : {}) } },
      onBotsChanged: () => {
        if (!control) {
          return enqueue(async () => {
            if (!client || closed) return;
            try { await client.syncBots(readBots()); } catch { /* ignore transient sync error */ }
          });
        }
        // 新 Bot 需要中心登记；普通配置刷新走同一串行合并路径，不制造假断线。
        return requestRefresh({ bootstrap: true }).catch(() => null);
      },
      onBotsSync: () => enqueue(async () => {
        if (!client || closed) return;
        try { await client.syncBots(readBots()); } catch { /* ignore transient sync error */ }
      }),
    });
    if (current !== client) throw offlineError();
    await ensureLinkOnline(snapshot.linkUrl);
    // 冷启动恢复：先恢复上轮已准入的 turn 绑定/版本，再全局 resume。
    // 恢复失败不终止 Host：control/基础服务保持存活、调度暂停、错误可见，
    // 由 apply() 内 pendingTurnRestore 的重试链在后续刷新中恢复后再 resume。
    pendingTurnRestore = null;
    try {
      await control.restoreTurns();
    } catch (err) {
      pendingTurnRestore = {
        code: typeof err?.code === 'string' && err.code ? err.code : 'TURN_RECOVERY_REQUIRED',
        message: typeof err?.message === 'string' && err.message ? err.message.slice(0, 200) : 'turn restoration incomplete',
      };
    }
    await apply(snapshot, current, initialGeneration, { plansApplied: true, resume: true, planning: bootPlans });
    if (pendingTurnRestore) {
      state = { ...state, error: pendingTurnRestore };
      scheduleRetry(true);
    }
    phase = 'running';
    startReconcile();
  } catch (err) {
    closed = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    for (const waiter of linkWaiters) waiter({ phase: 'closed' });
    if (client) await client.close().catch(() => {});
    if (link) await link.close().catch(() => {});
    if (control) await control.close().catch(() => {});
    if (installer) await installer.close().catch(() => {});
    if (settingsStore) settingsStore.close();
    throw err;
  }
  function getStatus() {
    if (frozen) return structuredClone(frozen);
    const revision = settingsStore.get().revision;
    lastRevision = revision;
    return { deviceId, phase, control: { url: control.url, listening: true }, relay: link?.getStatus() ?? null, activeSettingsRevision: activeRevision, settingsRevision: revision, restartRequired: revision !== activeRevision, center: { ...state } };
  }
  let closePromise;
  return {
    deviceId, url: control.url, getStatus,
    close() {
      return closePromise ??= (async () => {
        closed = true;
        phase = 'closing';
        clearTimeout(timer);
        clearTimeout(retryTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        generation++;
        for (const waiter of linkWaiters) waiter({ phase: 'closed' });
        state = { ...state, state: 'disconnected' };
        const errors = [];
        try { await control.setCenterOnline(false); } catch (err) { errors.push(err); }
        try { if (client) await client.close(); } catch (err) { errors.push(err); }
        try { await serial; } catch (err) { errors.push(err); }
        try { if (link) await link.close(); } catch (err) { errors.push(err); }
        try { await control.close(); } catch (err) { errors.push(err); }
        try { await installer.close(); } catch (err) { errors.push(err); }
        try { settingsStore.close(); } catch (err) { errors.push(err); }
        frozen = { deviceId, phase: 'closed', control: { url: control.url, listening: false }, relay: link?.getStatus() ?? null, activeSettingsRevision: activeRevision, settingsRevision: lastRevision, restartRequired: lastRevision !== activeRevision, center: { ...state } };
        if (errors.length) throw new AggregateError(errors, 'host service close failed');
      })();
    },
  };
}
