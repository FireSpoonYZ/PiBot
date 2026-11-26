// 共享客户端更新状态协议、分级冷却纯工具与全生命周期控制器：
// 桌面（Tauri invoke）与 Android（mobileLocalRequest）由各自 CenterGate/main 注入同一组语义操作；
// 本文件不含平台调用，秘密与敏感 URL 参数绝不落 localStorage。

/** 原生更新状态机返回的统一形状；字段全部可选展示，未知不伪造。 */
export interface ClientUpdateRelease {
  id: string;
  version: string;
  notes?: string;
  size?: number;
  sha256?: string;
  versionCode?: number;
  sourceCommit?: string;
}

export type ClientUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'waiting-permission'
  | 'waiting-install'
  | 'installing'
  | 'complete'
  | 'cancelled'
  | 'error'
  | 'waiting-tasks';

export interface ClientUpdateStatus {
  phase: ClientUpdatePhase;
  currentVersion: string;
  release?: ClientUpdateRelease;
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
}

/** 自动更新检查触发来源，与桌面 Rust / Android 原生白名单严格对齐。 */
export type ClientUpdateCheckReason = 'startup' | 'foreground' | 'updates-page' | 'push' | 'periodic';

/** 语义操作；各平台适配层把它映射为桌面 invoke 或 Android mobileLocalRequest。 */
export type ClientUpdateOp = 'status' | 'check' | 'download' | 'install' | 'cancel';
export interface ClientUpdateParams {
  automatic?: boolean;
  reason?: ClientUpdateCheckReason;
  stopActive?: boolean;
}
export type ClientUpdateRequest = (
  op: ClientUpdateOp,
  params?: ClientUpdateParams,
) => Promise<ClientUpdateStatus>;

/** 需要实时轮询原生状态的阶段；其余阶段为稳定态。 */
export const CLIENT_UPDATE_LIVE_PHASES: ReadonlySet<ClientUpdatePhase> = new Set([
  'checking',
  'downloading',
  'waiting-permission',
  'waiting-install',
  'installing',
  'waiting-tasks',
]);

/** 处于下载/待安装/安装/完成等活动态时，自动检查应跳过以免打扰用户。 */
export const CLIENT_UPDATE_AUTO_SKIP_PHASES: ReadonlySet<ClientUpdatePhase> = new Set([
  'downloading',
  'downloaded',
  'waiting-permission',
  'waiting-install',
  'waiting-tasks',
  'installing',
  'complete',
]);

/** 按触发来源分级的自动检查冷却（ms）；与桌面 Rust / Android 原生保持一致。 */
export const CLIENT_UPDATE_COOLDOWN_MS: Record<ClientUpdateCheckReason, number> = {
  push: 0,
  'updates-page': 30_000,
  startup: 120_000,
  foreground: 600_000,
  periodic: 4 * 60 * 60 * 1000,
};

/** 周期保底自动检查间隔（4 小时，保持旧导出名兼容）。 */
export const CLIENT_UPDATE_AUTO_INTERVAL_MS = CLIENT_UPDATE_COOLDOWN_MS.periodic;
/** 活动阶段状态轮询间隔。 */
export const CLIENT_UPDATE_POLL_MS = 1500;
/** 回到前台触发自动检查的防抖窗口（ms）。 */
export const CLIENT_UPDATE_FOREGROUND_DEBOUNCE_MS = 300;
/** 收到发布推送后随机抖动上限（ms），防客户端惊群。 */
export const CLIENT_UPDATE_PUSH_JITTER_MAX_MS = 3000;
/** 周期保底检查的评估节拍（ms）。 */
export const CLIENT_UPDATE_PERIODIC_TICK_MS = 60_000;

export const CLIENT_UPDATE_STATUS_EVENT = 'assistant-update-changed';
export const CLIENT_UPDATE_OPEN_EVENT = 'assistant-open-update';
export const CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT = 'assistant-update-release-published';
export const CLIENT_UPDATE_FOREGROUND_EVENT = 'assistant-update-foreground';

/** 非敏感的“稍后”已忽略版本映射键（centerKey -> releaseKey）。 */
export const CLIENT_UPDATE_DISMISSED_STORAGE_KEY = 'pibot.client-update.dismissed.v1';
export const CLIENT_UPDATE_DISMISSED_MAX_ENTRIES = 32;

const DISMISSED_CENTER_KEY_MAX_CHARS = 256;
const DISMISSED_RELEASE_KEY_MAX_CHARS = 256;
const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ClientUpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function formatUpdateBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return value + ' B';
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return size.toFixed(size >= 100 ? 0 : 1) + ' ' + units[unit];
}

export function updateProgress(status: ClientUpdateStatus | undefined): number | null {
  const done = status?.downloadedBytes;
  const total = status?.totalBytes;
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/**
 * 判断单次“下载并安装”意图在收到新状态后应采取的动作：
 * - 'install'：刚完成下载（phase === 'downloaded'），立即自动衔接安装；
 * - 'keep'：仍在下载中（phase === 'downloading'），保持等待；
 * - 'clear'：未开启或已取消/出错/已是最新/进入安装与完成态，清除意图。
 */
export function resolveAutoInstallAction(
  autoInstallArmed: boolean,
  phase: ClientUpdatePhase | undefined,
): 'install' | 'keep' | 'clear' {
  if (!autoInstallArmed) return 'clear';
  if (phase === 'downloaded') return 'install';
  if (phase === 'downloading') return 'keep';
  return 'clear';
}

/** 判断自动更新检查是否应因当前处于活动/安装阶段而跳过。 */
export function shouldSkipAutoUpdateCheck(phase: ClientUpdatePhase | undefined): boolean {
  return phase !== undefined && CLIENT_UPDATE_AUTO_SKIP_PHASES.has(phase);
}

/**
 * 判断指定来源的自动更新检查是否满足前端本地冷却：
 * - `push` 冷却为 0，始终允许；
 * - 尚未成功检查过（`lastCheckedAt <= 0`）或时钟回拨（`now < lastCheckedAt`）时允许；
 * - 其余要求 `now - lastCheckedAt >= CLIENT_UPDATE_COOLDOWN_MS[reason]`。
 */
export function shouldRunAutoUpdateCheck(
  reason: ClientUpdateCheckReason,
  lastCheckedAt: number,
  now: number = Date.now(),
): boolean {
  const cooldown = CLIENT_UPDATE_COOLDOWN_MS[reason];
  if (cooldown <= 0) return true;
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;
  if (!Number.isFinite(now)) return false;
  if (now < lastCheckedAt) return true;
  return now - lastCheckedAt >= cooldown;
}

/** 计算收到 SSE 发布推送后的随机抖动延迟（0 ~ CLIENT_UPDATE_PUSH_JITTER_MAX_MS）。 */
export function computePushCheckJitterMs(randomValue: number = Math.random()): number {
  if (!Number.isFinite(randomValue) || randomValue <= 0) return 0;
  if (randomValue >= 1) return CLIENT_UPDATE_PUSH_JITTER_MAX_MS;
  return Math.floor(randomValue * CLIENT_UPDATE_PUSH_JITTER_MAX_MS);
}

/** 生成用于版本去重的 releaseKey。 */
export function clientUpdateReleaseKey(release: ClientUpdateRelease | undefined): string {
  return release ? `${release.id}:${release.versionCode ?? release.version}` : '';
}

function sanitizeCenterSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      // 仅保留协议 + 主机(:端口)，剥离 userinfo / path / query / hash，确保绝不把敏感参数写入 localStorage。
      return parsed.origin;
    } catch {
      return (trimmed.split(/[?#]/, 1)[0] ?? '').replace(/\/\/[^/@]+@/, '//');
    }
  }
  return trimmed;
}

/**
 * 规范化持久化去重使用的 centerKey：
 * - 保留多中心/多设备隔离语义；
 * - 若包含 URL，自动剥离凭据、路径、查询串与片段；
 * - 截断超长键防止异常膨胀。
 */
export function normalizeDismissedCenterKey(centerKey: string): string {
  const trimmed = (centerKey ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map(sanitizeCenterSegment)
          .filter(Boolean);
        return cleaned.length > 0 ? JSON.stringify(cleaned).slice(0, DISMISSED_CENTER_KEY_MAX_CHARS) : '';
      }
    } catch {
      // 非合法 JSON 数组时退回分段规范化
    }
  }
  if (trimmed.includes('|')) {
    return trimmed
      .split('|')
      .map(sanitizeCenterSegment)
      .filter(Boolean)
      .join('|')
      .slice(0, DISMISSED_CENTER_KEY_MAX_CHARS);
  }
  return sanitizeCenterSegment(trimmed).slice(0, DISMISSED_CENTER_KEY_MAX_CHARS);
}

function resolveClientUpdateStorage(storage?: ClientUpdateStorage | null): ClientUpdateStorage | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // 受限环境无法访问 window.localStorage
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage;
    }
  } catch {
    // 受限环境无法访问 localStorage
  }
  return null;
}

/** 解析持久化的已忽略版本映射；损坏 JSON、非法结构或超限条目均安全降级。 */
export function parseDismissedClientUpdateReleases(raw: string | null | undefined): Record<string, string> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const validEntries: Array<[string, string]> = [];
    for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (UNSAFE_RECORD_KEYS.has(rawKey) || typeof rawValue !== 'string') continue;
      const key = normalizeDismissedCenterKey(rawKey);
      const value = rawValue.trim().slice(0, DISMISSED_RELEASE_KEY_MAX_CHARS);
      if (!key || !value || UNSAFE_RECORD_KEYS.has(key)) continue;
      validEntries.push([key, value]);
    }
    const bounded = validEntries.slice(-CLIENT_UPDATE_DISMISSED_MAX_ENTRIES);
    const out: Record<string, string> = {};
    for (const [key, value] of bounded) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readDismissedClientUpdateMap(storage?: ClientUpdateStorage | null): Record<string, string> {
  const resolved = resolveClientUpdateStorage(storage);
  if (!resolved) return {};
  try {
    return parseDismissedClientUpdateReleases(resolved.getItem(CLIENT_UPDATE_DISMISSED_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function readDismissedClientUpdateRelease(
  centerKey: string,
  storage?: ClientUpdateStorage | null,
): string {
  const normalizedKey = normalizeDismissedCenterKey(centerKey);
  if (!normalizedKey || UNSAFE_RECORD_KEYS.has(normalizedKey)) return '';
  const map = readDismissedClientUpdateMap(storage);
  return Object.prototype.hasOwnProperty.call(map, normalizedKey) ? (map[normalizedKey] ?? '') : '';
}

export function writeDismissedClientUpdateRelease(
  centerKey: string,
  releaseKey: string,
  storage?: ClientUpdateStorage | null,
): boolean {
  const normalizedKey = normalizeDismissedCenterKey(centerKey);
  if (!normalizedKey || UNSAFE_RECORD_KEYS.has(normalizedKey)) return false;
  const resolved = resolveClientUpdateStorage(storage);
  if (!resolved) return false;
  const trimmedRelease = (releaseKey ?? '').trim().slice(0, DISMISSED_RELEASE_KEY_MAX_CHARS);
  try {
    const current = readDismissedClientUpdateMap(resolved);
    const entries = Object.entries(current).filter(([k]) => k !== normalizedKey);
    if (trimmedRelease) {
      entries.push([normalizedKey, trimmedRelease]);
    }
    const bounded = entries.slice(-CLIENT_UPDATE_DISMISSED_MAX_ENTRIES);
    const next: Record<string, string> = {};
    for (const [k, v] of bounded) {
      next[k] = v;
    }
    resolved.setItem(CLIENT_UPDATE_DISMISSED_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export interface MobileUpdatePromptDismissState {
  centerKey: string;
  dismissedRelease: string;
  reopened: boolean;
}

export function createMobileUpdatePromptState(
  centerKey: string,
  storage?: ClientUpdateStorage | null,
): MobileUpdatePromptDismissState {
  const normalized = normalizeDismissedCenterKey(centerKey);
  return {
    centerKey: normalized,
    dismissedRelease: readDismissedClientUpdateRelease(normalized, storage),
    reopened: false,
  };
}

export function syncMobileUpdatePromptCenter(
  state: MobileUpdatePromptDismissState,
  centerKey: string,
  storage?: ClientUpdateStorage | null,
): MobileUpdatePromptDismissState {
  const normalized = normalizeDismissedCenterKey(centerKey);
  if (state.centerKey === normalized) return state;
  return {
    centerKey: normalized,
    dismissedRelease: readDismissedClientUpdateRelease(normalized, storage),
    // 冷启动阶段在 centerKey 就绪前收到的系统通知点击需要保留到中心就绪；切换不同中心时重置。
    reopened: state.centerKey === '' ? state.reopened : false,
  };
}

export function dismissMobileUpdatePromptRelease(
  state: MobileUpdatePromptDismissState,
  centerKey: string,
  releaseKey: string,
  storage?: ClientUpdateStorage | null,
): MobileUpdatePromptDismissState {
  const normalized = normalizeDismissedCenterKey(centerKey);
  const trimmedRelease = (releaseKey ?? '').trim().slice(0, DISMISSED_RELEASE_KEY_MAX_CHARS);
  if (!trimmedRelease) return syncMobileUpdatePromptCenter(state, normalized, storage);
  writeDismissedClientUpdateRelease(normalized, trimmedRelease, storage);
  return {
    centerKey: normalized,
    dismissedRelease: trimmedRelease,
    reopened: false,
  };
}

export function reopenMobileUpdatePrompt(
  state: MobileUpdatePromptDismissState,
  centerKey: string,
  storage?: ClientUpdateStorage | null,
): MobileUpdatePromptDismissState {
  const synced = syncMobileUpdatePromptCenter(state, centerKey, storage);
  return {
    ...synced,
    reopened: true,
  };
}

export function shouldShowMobileUpdatePrompt(params: {
  active: boolean;
  visible: boolean;
  ready: boolean;
  pending: ClientUpdateOp | null;
  status: ClientUpdateStatus | undefined;
  centerKey: string;
  dismissState: MobileUpdatePromptDismissState;
  storage?: ClientUpdateStorage | null;
}): { open: boolean; release: ClientUpdateRelease | undefined; releaseKey: string } {
  const release =
    params.ready && !params.pending && params.status?.phase === 'available'
      ? params.status.release
      : undefined;
  const releaseKey = clientUpdateReleaseKey(release);
  const effectiveState = syncMobileUpdatePromptCenter(
    params.dismissState,
    params.centerKey,
    params.storage,
  );
  const dismissed = effectiveState.reopened ? '' : effectiveState.dismissedRelease;
  const open = params.active && params.visible && Boolean(releaseKey) && releaseKey !== dismissed;
  return { open, release, releaseKey };
}

export interface ClientUpdateSnapshot {
  status: ClientUpdateStatus | undefined;
  pending: ClientUpdateOp | null;
  actionError: string;
}

export interface ClientUpdateEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ClientUpdateDocumentTarget extends ClientUpdateEventTarget {
  readonly hidden: boolean;
}

export interface ClientUpdateControllerOptions {
  request: ClientUpdateRequest;
  onChange?: (snapshot: ClientUpdateSnapshot) => void;
  now?: () => number;
  random?: () => number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  windowTarget?: ClientUpdateEventTarget | null;
  documentTarget?: ClientUpdateDocumentTarget | null;
}

export interface ClientUpdateSessionConfig {
  ready: boolean;
  centerKey: string;
  nativeCheck?: boolean;
}

export interface ClientUpdateController {
  getSnapshot(): ClientUpdateSnapshot;
  subscribe(listener: (snapshot: ClientUpdateSnapshot) => void): () => void;
  start(config: ClientUpdateSessionConfig): void;
  stop(): void;
  refresh(reportError?: boolean): Promise<void>;
  dismissError(): void;
  check(): void;
  triggerAutoCheck(reason: ClientUpdateCheckReason): void;
  download(): void;
  install(stopActive: boolean): void;
  cancel(): void;
}

function clientUpdateErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** 仅当检查返回明确成功终态时才视为完成一次有效检查并刷新桌面前端本地冷却。 */
function isSuccessfulCheckTerminalPhase(phase: ClientUpdatePhase): boolean {
  return phase === 'available' || phase === 'up-to-date';
}

/**
 * 客户端更新全生命周期状态与触发编排控制器（桌面与 Android 共用）：
 * - 统一编排 startup / foreground(300ms防抖) / updates-page / push(0~3s抖动) / periodic(4h保底)；
 * - Android 端保留原生状态事件与打开事件同步刷新；
 * - 自动检查保持静默、不设置 pending='check'、不闪塌既有 available 状态，失败不锁死冷却。
 */
export function createClientUpdateController(
  options: ClientUpdateControllerOptions,
): ClientUpdateController {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const scheduleTimeout =
    options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancelTimeout =
    options.clearTimeout ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  const win =
    options.windowTarget !== undefined
      ? options.windowTarget
      : typeof window !== 'undefined'
        ? window
        : null;
  const doc =
    options.documentTarget !== undefined
      ? options.documentTarget
      : typeof document !== 'undefined'
        ? document
        : null;

  let status: ClientUpdateStatus | undefined = undefined;
  let pending: ClientUpdateOp | null = null;
  let actionError = '';
  let snapshot: ClientUpdateSnapshot = { status, pending, actionError };

  let epoch = 0;
  let connected = false;
  let nativeCheckSession = false;
  let lastCheckAt = 0;
  let lastPeriodicAt = 0;
  let opSequence = 0;
  let opInFlight: { id: number; op: ClientUpdateOp; automatic: boolean } | null = null;
  let autoInstallArmed = false;
  let statusRevision = 0;
  let pollSequence = 0;
  let appliedPoll = 0;
  let lastPolledOp = 0;
  let periodicTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let foregroundTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let foregroundAllowWhileHidden = false;
  let pushTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let cleanupListeners: (() => void) | null = null;
  const listeners = new Set<(next: ClientUpdateSnapshot) => void>();

  const emit = () => {
    if (
      Object.is(snapshot.status, status) &&
      Object.is(snapshot.pending, pending) &&
      Object.is(snapshot.actionError, actionError)
    ) {
      return;
    }
    snapshot = { status, pending, actionError };
    options.onChange?.(snapshot);
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const clearTimers = () => {
    if (periodicTimer !== undefined) {
      cancelTimeout(periodicTimer);
      periodicTimer = undefined;
    }
    if (foregroundTimer !== undefined) {
      cancelTimeout(foregroundTimer);
      foregroundTimer = undefined;
    }
    foregroundAllowWhileHidden = false;
    if (pushTimer !== undefined) {
      cancelTimeout(pushTimer);
      pushTimer = undefined;
    }
  };

  const refresh = async (reportError = true): Promise<void> => {
    if (!connected) return;
    const myEpoch = epoch;
    const revision = statusRevision;
    const poll = ++pollSequence;
    try {
      const next = await options.request('status');
      if (myEpoch !== epoch || revision !== statusRevision || poll < appliedPoll) return;
      const active = opInFlight;
      // 手动操作刚发出时原生状态可能仍是上一次的稳定态。
      if (active?.op === 'check' && !active.automatic && next.phase !== 'checking') return;
      if (
        active?.op === 'download' &&
        ['idle', 'checking', 'available', 'up-to-date'].includes(next.phase)
      ) {
        return;
      }
      if (active?.op === 'install' && next.phase === 'downloaded') return;
      appliedPoll = poll;
      if (active) lastPolledOp = active.id;
      if (
        !(
          active?.op === 'check' &&
          active.automatic &&
          status?.phase === 'available' &&
          next.phase === 'checking'
        )
      ) {
        status = next;
        emit();
      }
      // 异步下载平台（如 Android）由轮询/事件观测到 downloaded 后自动衔接安装。
      if (!active) {
        const action = resolveAutoInstallAction(autoInstallArmed, next.phase);
        if (action === 'install') {
          autoInstallArmed = false;
          void runOp('install', { stopActive: false });
        } else if (action === 'clear') {
          autoInstallArmed = false;
        }
      }
    } catch (error) {
      if (reportError && myEpoch === epoch && revision === statusRevision && poll >= appliedPoll) {
        actionError = clientUpdateErrorMessage(error);
        emit();
      }
    }
  };

  const runOp = async (
    op: Exclude<ClientUpdateOp, 'status'>,
    params?: ClientUpdateParams,
    automatic = false,
  ): Promise<void> => {
    if (!connected) return;
    const active = opInFlight;
    if (active) {
      const canCancel = op === 'cancel' && (active.op === 'download' || active.op === 'check');
      // 静默自动检查不阻塞用户显式操作（点击下载/安装/手动检查/取消）。
      const canPreemptAutoCheck = !automatic && active.automatic && active.op === 'check';
      if (!canCancel && !canPreemptAutoCheck) return;
    }
    const id = ++opSequence;
    const myEpoch = epoch;
    opInFlight = { id, op, automatic };
    if (!automatic) {
      statusRevision += 1;
      pending = op;
      actionError = '';
      if (op === 'check') {
        if (status && !CLIENT_UPDATE_LIVE_PHASES.has(status.phase)) {
          status = { ...status, phase: 'checking' };
        }
      }
      emit();
    }
    try {
      const next = await options.request(op, params);
      if (myEpoch === epoch && opInFlight?.id === id) {
        if (op === 'check' && automatic) {
          // 自动检查返回 error 态时静默丢弃，不覆盖既有稳定态，也不刷新冷却戳。
          if (next.phase !== 'error') {
            statusRevision += 1;
            if (!nativeCheckSession && isSuccessfulCheckTerminalPhase(next.phase)) {
              lastCheckAt = now();
            }
            const preserveStable =
              next.phase === 'checking' &&
              status !== undefined &&
              !CLIENT_UPDATE_LIVE_PHASES.has(status.phase);
            if (!preserveStable && (lastPolledOp !== id || next.phase !== 'checking')) {
              status = next;
              emit();
            }
          }
        } else {
          statusRevision += 1;
          if (op === 'check' && !nativeCheckSession && isSuccessfulCheckTerminalPhase(next.phase)) {
            lastCheckAt = now();
          }
          if (
            lastPolledOp !== id ||
            (op !== 'check' && op !== 'download') ||
            (next.phase !== 'checking' && next.phase !== 'downloading')
          ) {
            status = next;
            emit();
          }
        }
        if (op === 'download') {
          const action = resolveAutoInstallAction(autoInstallArmed, next.phase);
          if (action === 'install') {
            autoInstallArmed = false;
            opInFlight = { id, op: 'install', automatic: false };
            pending = 'install';
            emit();
            const installed = await options.request('install', { stopActive: false });
            if (myEpoch === epoch && opInFlight?.id === id) {
              statusRevision += 1;
              status = installed;
              emit();
            }
          } else if (action === 'clear') {
            autoInstallArmed = false;
          }
        }
      }
    } catch (error) {
      if (myEpoch === epoch && opInFlight?.id === id) {
        if (op === 'download') autoInstallArmed = false;
        if (!automatic) {
          statusRevision += 1;
          actionError = clientUpdateErrorMessage(error);
          emit();
          void refresh();
        }
      }
    } finally {
      if (myEpoch === epoch && opInFlight?.id === id) {
        opInFlight = null;
        if (!automatic) {
          pending = null;
          emit();
        }
      }
    }
  };

  const triggerAutoCheck = (reason: ClientUpdateCheckReason): void => {
    if (!connected) return;
    if (opInFlight) return;
    if (shouldSkipAutoUpdateCheck(status?.phase)) return;
    const currentNow = now();
    if (nativeCheckSession) {
      // Android 端 updateCheck 异步立即返回，5 级冷却由原生 ClientUpdater 单调时钟权威裁决；
      // 前端仅对 60s 节拍的 periodic 兜底独立维持 4h 门控，避免每分钟空刷 IPC。
      if (reason === 'periodic') {
        if (!shouldRunAutoUpdateCheck('periodic', lastPeriodicAt, currentNow)) return;
        lastPeriodicAt = currentNow;
      }
    } else if (!shouldRunAutoUpdateCheck(reason, lastCheckAt, currentNow)) {
      return;
    }
    void runOp('check', { automatic: true, reason }, true);
  };

  const stop = (): void => {
    epoch += 1;
    connected = false;
    opInFlight = null;
    autoInstallArmed = false;
    statusRevision += 1;
    clearTimers();
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }
  };

  const start = (config: ClientUpdateSessionConfig): void => {
    stop();
    const isNativeCheck = Boolean(config.nativeCheck);
    nativeCheckSession = isNativeCheck;
    lastCheckAt = 0;
    lastPeriodicAt = 0;
    status = undefined;
    pending = null;
    actionError = '';
    emit();

    if (!config.ready || !config.centerKey) return;
    connected = true;
    if (isNativeCheck) {
      lastPeriodicAt = now();
    }
    const sessionEpoch = epoch;

    const isHidden = () => Boolean(doc?.hidden);
    const syncNative = () => {
      if (!isHidden()) void refresh(false);
    };

    const scheduleForegroundCheck = (allowWhileHidden = false) => {
      if (!allowWhileHidden && isHidden()) return;
      if (foregroundTimer !== undefined) {
        cancelTimeout(foregroundTimer);
      }
      foregroundAllowWhileHidden = foregroundAllowWhileHidden || allowWhileHidden;
      foregroundTimer = scheduleTimeout(() => {
        if (sessionEpoch !== epoch) return;
        const allow = foregroundAllowWhileHidden;
        foregroundTimer = undefined;
        foregroundAllowWhileHidden = false;
        if (allow || !isHidden()) {
          triggerAutoCheck('foreground');
        }
      }, CLIENT_UPDATE_FOREGROUND_DEBOUNCE_MS);
    };

    const onVisibilityChange = () => {
      if (isHidden()) {
        if (foregroundTimer !== undefined) {
          cancelTimeout(foregroundTimer);
          foregroundTimer = undefined;
        }
        foregroundAllowWhileHidden = false;
        return;
      }
      if (isNativeCheck) syncNative();
      scheduleForegroundCheck(false);
    };

    const onFocus = () => {
      scheduleForegroundCheck(false);
    };

    const onForegroundEvent = () => {
      if (isNativeCheck) syncNative();
      scheduleForegroundCheck(true);
    };

    const onReleasePublished = () => {
      if (pushTimer !== undefined) return;
      const delay = computePushCheckJitterMs(random());
      pushTimer = scheduleTimeout(() => {
        if (sessionEpoch !== epoch) return;
        pushTimer = undefined;
        triggerAutoCheck('push');
      }, delay);
    };

    if (isNativeCheck && win) {
      win.addEventListener(CLIENT_UPDATE_STATUS_EVENT, syncNative);
      win.addEventListener(CLIENT_UPDATE_OPEN_EVENT, syncNative);
    }
    if (doc) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (win) {
      win.addEventListener('focus', onFocus);
      win.addEventListener(CLIENT_UPDATE_FOREGROUND_EVENT, onForegroundEvent);
      win.addEventListener(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT, onReleasePublished);
    }

    cleanupListeners = () => {
      if (isNativeCheck && win) {
        win.removeEventListener(CLIENT_UPDATE_STATUS_EVENT, syncNative);
        win.removeEventListener(CLIENT_UPDATE_OPEN_EVENT, syncNative);
      }
      if (doc) {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (win) {
        win.removeEventListener('focus', onFocus);
        win.removeEventListener(CLIENT_UPDATE_FOREGROUND_EVENT, onForegroundEvent);
        win.removeEventListener(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT, onReleasePublished);
      }
    };

    if (isNativeCheck) syncNative();
    triggerAutoCheck('startup');

    const tick = () => {
      if (sessionEpoch !== epoch || !connected) return;
      periodicTimer = undefined;
      triggerAutoCheck('periodic');
      if (sessionEpoch === epoch && connected) {
        periodicTimer = scheduleTimeout(tick, CLIENT_UPDATE_PERIODIC_TICK_MS);
      }
    };
    periodicTimer = scheduleTimeout(tick, CLIENT_UPDATE_PERIODIC_TICK_MS);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    refresh,
    dismissError: () => {
      actionError = '';
      emit();
    },
    check: () => {
      autoInstallArmed = false;
      void runOp('check', { automatic: false });
    },
    triggerAutoCheck,
    download: () => {
      autoInstallArmed = true;
      void runOp('download');
    },
    install: (stopActive: boolean) => {
      autoInstallArmed = false;
      void runOp('install', { stopActive });
    },
    cancel: () => {
      autoInstallArmed = false;
      void runOp('cancel');
    },
  };
}
