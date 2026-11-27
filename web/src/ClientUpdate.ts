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

/** 所有合法客户端更新阶段集合，用于校验跨端事件推送载荷。 */
export const CLIENT_UPDATE_PHASES: ReadonlySet<ClientUpdatePhase> = new Set([
  'idle',
  'checking',
  'available',
  'up-to-date',
  'downloading',
  'downloaded',
  'waiting-permission',
  'waiting-install',
  'installing',
  'complete',
  'cancelled',
  'error',
  'waiting-tasks',
]);

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
/** 活动阶段低频兜底状态轮询间隔（正常更新由原生推送事件驱动）。 */
export const CLIENT_UPDATE_POLL_MS = 4000;
/** 手动检查最短确认展示时长（ms），避免极快返回时状态与按钮闪烁。 */
export const CLIENT_UPDATE_MIN_CHECK_MS = 320;
/** 检查阶段延迟展示“取消检查”按钮的阈值（ms），避免短检查时操作行闪烁。 */
export const CLIENT_UPDATE_CANCEL_DELAY_MS = 2500;
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

export type ClientUpdateTranslate = (zh: string, en: string) => string;

export function isClientUpdatePhase(value: unknown): value is ClientUpdatePhase {
  return typeof value === 'string' && CLIENT_UPDATE_PHASES.has(value as ClientUpdatePhase);
}

function parseClientUpdateRelease(value: unknown): ClientUpdateRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.version !== 'string') return null;
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') return null;
  if (raw.size !== undefined && raw.size !== null && (typeof raw.size !== 'number' || !Number.isFinite(raw.size))) return null;
  if (raw.sha256 !== undefined && raw.sha256 !== null && typeof raw.sha256 !== 'string') return null;
  if (
    raw.versionCode !== undefined &&
    raw.versionCode !== null &&
    (typeof raw.versionCode !== 'number' || !Number.isFinite(raw.versionCode))
  ) {
    return null;
  }
  if (raw.sourceCommit !== undefined && raw.sourceCommit !== null && typeof raw.sourceCommit !== 'string') return null;

  const release: ClientUpdateRelease = {
    id: raw.id,
    version: raw.version,
  };
  if (typeof raw.notes === 'string') release.notes = raw.notes;
  if (typeof raw.size === 'number') release.size = raw.size;
  if (typeof raw.sha256 === 'string') release.sha256 = raw.sha256;
  if (typeof raw.versionCode === 'number') release.versionCode = raw.versionCode;
  if (typeof raw.sourceCommit === 'string') release.sourceCommit = raw.sourceCommit;
  return release;
}

/**
 * 从 CLIENT_UPDATE_STATUS_EVENT 中校验并提取原生推送的 ClientUpdateStatus 快照：
 * - 桌面端 CustomEvent 携带完整合法状态时返回规范化对象，前端可直接应用而无需追加 status RPC；
 * - Android 端普通 Event（无 detail）或载荷非法时返回 null，交由 Provider 走合并刷新。
 */
export function extractClientUpdateEventStatus(
  event: Event | { detail?: unknown } | null | undefined,
): ClientUpdateStatus | null {
  if (!event || typeof event !== 'object' || !('detail' in event)) return null;
  const raw = (event as { detail?: unknown }).detail;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isClientUpdatePhase(record.phase) || typeof record.currentVersion !== 'string') {
    return null;
  }

  let release: ClientUpdateRelease | undefined;
  if (record.release !== undefined && record.release !== null) {
    const parsed = parseClientUpdateRelease(record.release);
    if (!parsed) return null;
    release = parsed;
  }

  let downloadedBytes: number | undefined;
  if (record.downloadedBytes !== undefined && record.downloadedBytes !== null) {
    if (typeof record.downloadedBytes !== 'number' || !Number.isFinite(record.downloadedBytes)) {
      return null;
    }
    downloadedBytes = record.downloadedBytes;
  }

  let totalBytes: number | undefined;
  if (record.totalBytes !== undefined && record.totalBytes !== null) {
    if (typeof record.totalBytes !== 'number' || !Number.isFinite(record.totalBytes)) {
      return null;
    }
    totalBytes = record.totalBytes;
  }

  let message: string | undefined;
  if (record.message !== undefined && record.message !== null) {
    if (typeof record.message !== 'string') return null;
    message = record.message;
  }

  const status: ClientUpdateStatus = {
    phase: record.phase,
    currentVersion: record.currentVersion,
  };
  if (release !== undefined) status.release = release;
  if (downloadedBytes !== undefined) status.downloadedBytes = downloadedBytes;
  if (totalBytes !== undefined) status.totalBytes = totalBytes;
  if (message !== undefined) status.message = message;
  return status;
}

const MIN_CHECK_DELAY_PHASES: ReadonlySet<ClientUpdatePhase> = new Set([
  'up-to-date',
  'available',
  'error',
]);

/**
 * 计算手动检查收敛到稳定结果前还需保持 checking 展示的剩余毫秒数：
 * - 自动检查（startedAt === null）不延迟，返回 0；
 * - 取消（cancelled）及非检查结果阶段立即提交，返回 0；
 * - 耗时不足 CLIENT_UPDATE_MIN_CHECK_MS 时补足剩余时长，否则返回 0。
 */
export function computeMinCheckDelayMs(
  startedAt: number | null,
  now: number,
  phase: ClientUpdatePhase | undefined,
  minDurationMs: number = CLIENT_UPDATE_MIN_CHECK_MS,
): number {
  if (startedAt === null || !Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  if (!phase || !MIN_CHECK_DELAY_PHASES.has(phase)) return 0;
  if (!Number.isFinite(minDurationMs) || minDurationMs <= 0) return 0;
  const elapsed = Math.max(0, now - startedAt);
  return elapsed < minDurationMs ? Math.ceil(minDurationMs - elapsed) : 0;
}

/** 检查已成功得出结果（已是最新或发现新版本），应刷新 lastCheckedAt。 */
export function isCheckSettledPhase(phase: ClientUpdatePhase | undefined): boolean {
  return phase === 'up-to-date' || phase === 'available';
}

/**
 * 格式化上次检查更新的相对时间文案（刚刚 / X 分钟前 / X 小时前 / X 天前）。
 * 无记录或非法时间戳返回空字符串；时钟回拨导致未来时间时按“刚刚”处理。
 */
export function formatLastChecked(
  lastCheckedAt: number | null | undefined,
  now: number,
  t: ClientUpdateTranslate,
): string {
  if (typeof lastCheckedAt !== 'number' || !Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) {
    return '';
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return '';
  }
  const diffMs = Math.max(0, now - lastCheckedAt);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return t('刚刚', 'just now');
  }
  if (minutes < 60) {
    return t(`${minutes} 分钟前`, `${minutes} min ago`);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t(`${hours} 小时前`, `${hours} hr ago`);
  }
  const days = Math.floor(hours / 24);
  return t(`${days} 天前`, `${days} d ago`);
}

/**
 * 判断当前阶段是否显示取消按钮：
 * - installing 不可取消；
 * - downloading 及移动端 waiting-permission / waiting-install 始终立即可取消；
 * - checking 仅在持续超过 delayMs（默认 2500ms）后渐显取消按钮。
 */
export function shouldShowCancelUpdateAction(params: {
  phase: ClientUpdatePhase;
  isDesktop: boolean;
  checkingElapsedMs: number;
  delayMs?: number;
}): boolean {
  const { phase, isDesktop, checkingElapsedMs, delayMs = CLIENT_UPDATE_CANCEL_DELAY_MS } = params;
  if (phase === 'installing') return false;
  if (phase === 'downloading') return true;
  if (!isDesktop && (phase === 'waiting-permission' || phase === 'waiting-install')) {
    return true;
  }
  if (phase === 'checking') {
    return Number.isFinite(checkingElapsedMs) && checkingElapsedMs > delayMs;
  }
  return false;
}

/**
 * 维护重查期间缓存的上一可用版本：
 * - available 时记住当前 release；
 * - checking 时若原生快照省略 release，则保留缓存避免新版本行与更新说明折叠闪烁；
 * - 其他阶段清空缓存。
 */
export function nextPreservedRelease(
  phase: ClientUpdatePhase,
  statusRelease: ClientUpdateRelease | undefined,
  previousPreserved: ClientUpdateRelease | undefined,
): ClientUpdateRelease | undefined {
  if (phase === 'available' && statusRelease) return statusRelease;
  if (phase === 'checking') return statusRelease ?? previousPreserved;
  return undefined;
}

/** 解析当前界面应展示的 release：优先原生 status.release，checking 缺省时回退到缓存版本。 */
export function resolveDisplayedRelease(
  phase: ClientUpdatePhase,
  statusRelease: ClientUpdateRelease | undefined,
  preservedRelease: ClientUpdateRelease | undefined,
): ClientUpdateRelease | undefined {
  if (statusRelease) return statusRelease;
  if (phase === 'checking') return preservedRelease;
  return undefined;
}

/**
 * 构造手动检查时的乐观 checking 快照：保留 currentVersion 与现有 release/totalBytes，
 * 清除上一次 error / complete / reset 遗留的 message，避免检查期间在状态副槽中误显旧消息。
 */
export function createOptimisticCheckingStatus(prev: ClientUpdateStatus): ClientUpdateStatus {
  const next: ClientUpdateStatus = {
    phase: 'checking',
    currentVersion: prev.currentVersion,
  };
  if (prev.release !== undefined) next.release = prev.release;
  if (prev.totalBytes !== undefined) next.totalBytes = prev.totalBytes;
  return next;
}

/**
 * 判断原生 op 返回值是否应覆写当前前端状态：
 * 当本次 op 执行期间已有推送或轮询观测到更新快照（polledDuringOp）时，
 * check / download / cancel 返回的 checking / downloading 中间态不得覆盖较新状态
 * （例如桌面 cancel 返回未收敛前快照，但推送已送达 cancelled；或 Android 推送已送达 downloaded）。
 */
export function shouldCommitOpResult(
  op: Exclude<ClientUpdateOp, 'status'>,
  nextPhase: ClientUpdatePhase,
  polledDuringOp: boolean,
): boolean {
  if (!polledDuringOp) return true;
  if (op !== 'check' && op !== 'download' && op !== 'cancel') return true;
  return nextPhase !== 'checking' && nextPhase !== 'downloading';
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
  lastCheckedAt: number | null;
}

export interface ClientUpdateEventTarget {
  addEventListener(type: string, listener: (event?: Event) => void): void;
  removeEventListener(type: string, listener: (event?: Event) => void): void;
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
  refresh(reportError?: boolean, fromPush?: boolean): Promise<void>;
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
 * - 消费桌面 CustomEvent 直推快照与 Android 状态广播合并刷新，降低轮询频率；
 * - 手动检查维持 >=320ms 最小确认过渡且不遗留旧错误消息；自动检查保持静默、不闪塌既有 available 状态，失败不锁死冷却。
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
  let lastCheckedAt: number | null = null;
  let snapshot: ClientUpdateSnapshot = { status, pending, actionError, lastCheckedAt };

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
  let activeRefreshId: number | null = null;
  let refreshQueued: { reportError: boolean; fromPush: boolean } | null = null;
  let manualCheckStartedAt: number | null = null;
  let awaitingCheckSettle = false;
  let pushDuringActiveOp = false;
  let settleHandle: { timer: ReturnType<typeof setTimeout>; cancel(): void } | null = null;
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
      Object.is(snapshot.actionError, actionError) &&
      Object.is(snapshot.lastCheckedAt, lastCheckedAt)
    ) {
      return;
    }
    snapshot = { status, pending, actionError, lastCheckedAt };
    options.onChange?.(snapshot);
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const clearSettleTimer = () => {
    const handle = settleHandle;
    if (!handle) return;
    settleHandle = null;
    cancelTimeout(handle.timer);
    handle.cancel();
  };

  const waitMinCheckDelay = (delayMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      clearSettleTimer();
      let settled = false;
      const timer = scheduleTimeout(() => {
        if (settled) return;
        settled = true;
        if (settleHandle?.timer === timer) {
          settleHandle = null;
        }
        resolve(true);
      }, delayMs);
      settleHandle = {
        timer,
        cancel: () => {
          if (settled) return;
          settled = true;
          resolve(false);
        },
      };
    });

  const clearTimers = () => {
    clearSettleTimer();
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

  const commitObservedNow = (next: ClientUpdateStatus, fromPush: boolean) => {
    const active = opInFlight;
    const suppressAutoCheckFlicker =
      active?.op === 'check' &&
      active.automatic &&
      status?.phase === 'available' &&
      next.phase === 'checking';
    if (!suppressAutoCheckFlicker) {
      const wasChecking = awaitingCheckSettle || status?.phase === 'checking';
      if (next.phase === 'checking') {
        awaitingCheckSettle = true;
      } else {
        manualCheckStartedAt = null;
        awaitingCheckSettle = false;
      }
      status = next;
      if (isCheckSettledPhase(next.phase) && (wasChecking || fromPush)) {
        lastCheckedAt = now();
      }
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
  };

  const applyObservedStatus = (
    next: ClientUpdateStatus,
    meta: { epoch: number; revision: number; poll: number; fromPush: boolean },
  ) => {
    const { epoch: myEpoch, revision, poll, fromPush } = meta;
    if (!connected) return;
    if (myEpoch !== epoch || revision !== statusRevision || poll < appliedPoll) return;
    const active = opInFlight;
    // 手动操作刚发出时原生状态可能仍是上一次的稳定态。
    if (active?.op === 'check' && !active.automatic && next.phase !== 'checking') {
      if (fromPush) pushDuringActiveOp = true;
      return;
    }
    if (
      active?.op === 'download' &&
      ['idle', 'checking', 'available', 'up-to-date'].includes(next.phase)
    ) {
      if (fromPush) pushDuringActiveOp = true;
      return;
    }
    if (active?.op === 'install' && next.phase === 'downloaded') return;
    appliedPoll = poll;
    if (active) lastPolledOp = active.id;

    if (!active) {
      const delayMs = computeMinCheckDelayMs(manualCheckStartedAt, now(), next.phase);
      if (delayMs > 0) {
        if (!status) {
          status = {
            phase: 'checking',
            currentVersion: next.currentVersion,
          };
          emit();
        }
        void waitMinCheckDelay(delayMs).then((completed) => {
          if (!completed) return;
          if (
            !connected ||
            myEpoch !== epoch ||
            revision !== statusRevision ||
            poll < appliedPoll ||
            opInFlight !== null
          ) {
            return;
          }
          commitObservedNow(next, fromPush);
        });
        return;
      }
      clearSettleTimer();
    }

    commitObservedNow(next, fromPush);
  };

  const refresh = async (reportError = true, fromPush = false): Promise<void> => {
    if (!connected) return;
    if (activeRefreshId !== null) {
      const prev = refreshQueued;
      refreshQueued = {
        reportError: Boolean(prev?.reportError || reportError),
        fromPush: Boolean(prev?.fromPush || fromPush),
      };
      return;
    }
    const myEpoch = epoch;
    const revision = statusRevision;
    const poll = ++pollSequence;
    activeRefreshId = poll;
    try {
      const next = await options.request('status');
      applyObservedStatus(next, { epoch: myEpoch, revision, poll, fromPush });
    } catch (error) {
      if (reportError && myEpoch === epoch && revision === statusRevision && poll >= appliedPoll) {
        actionError = clientUpdateErrorMessage(error);
        emit();
      }
    } finally {
      if (activeRefreshId === poll) {
        activeRefreshId = null;
        const queued = refreshQueued;
        if (queued) {
          refreshQueued = null;
          if (connected && myEpoch === epoch) {
            void refresh(queued.reportError, queued.fromPush);
          }
        }
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
      clearSettleTimer();
      statusRevision += 1;
      if (op === 'check') {
        manualCheckStartedAt = now();
        awaitingCheckSettle = true;
        pushDuringActiveOp = false;
      } else {
        manualCheckStartedAt = null;
        awaitingCheckSettle = false;
        pushDuringActiveOp = false;
      }
      pending = op;
      actionError = '';
      if (op === 'check') {
        if (status && !CLIENT_UPDATE_LIVE_PHASES.has(status.phase)) {
          status = createOptimisticCheckingStatus(status);
        }
      }
      emit();
    }
    let shouldFollowUpRefresh = false;
    try {
      const next = await options.request(op, params);
      if (myEpoch === epoch && opInFlight?.id === id) {
        if (op === 'check' && automatic) {
          // 自动检查返回 error 态时静默丢弃，不覆盖既有稳定态，也不刷新冷却戳。
          if (next.phase !== 'error') {
            statusRevision += 1;
            if (isSuccessfulCheckTerminalPhase(next.phase)) {
              const settledAt = now();
              if (!nativeCheckSession) {
                lastCheckAt = settledAt;
              }
              lastCheckedAt = settledAt;
            }
            const preserveStable =
              next.phase === 'checking' &&
              status !== undefined &&
              !CLIENT_UPDATE_LIVE_PHASES.has(status.phase);
            if (!preserveStable && (lastPolledOp !== id || next.phase !== 'checking')) {
              status = next;
            }
            emit();
          }
        } else {
          if (op === 'check') {
            const delayMs = computeMinCheckDelayMs(manualCheckStartedAt, now(), next.phase);
            if (delayMs > 0) {
              const completed = await waitMinCheckDelay(delayMs);
              if (!completed || myEpoch !== epoch || opInFlight?.id !== id) return;
            }
          }
          statusRevision += 1;
          const commitResult = shouldCommitOpResult(op, next.phase, lastPolledOp === id);
          if (commitResult) {
            status = next;
          }
          const effectivePhase = commitResult ? next.phase : (status?.phase ?? next.phase);
          if (op === 'check' && effectivePhase !== 'checking') {
            manualCheckStartedAt = null;
            awaitingCheckSettle = false;
            if (isSuccessfulCheckTerminalPhase(effectivePhase)) {
              const settledAt = now();
              if (!nativeCheckSession) {
                lastCheckAt = settledAt;
              }
              lastCheckedAt = settledAt;
            }
          }
          emit();
          if (
            pushDuringActiveOp &&
            (op === 'check' || op === 'download' || op === 'cancel') &&
            (effectivePhase === 'checking' || effectivePhase === 'downloading')
          ) {
            shouldFollowUpRefresh = true;
          }
          pushDuringActiveOp = false;
          if (op === 'download') {
            const action = resolveAutoInstallAction(autoInstallArmed, effectivePhase);
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
      }
    } catch (error) {
      if (myEpoch === epoch && opInFlight?.id === id) {
        if (op === 'check' && !automatic) {
          const delayMs = computeMinCheckDelayMs(manualCheckStartedAt, now(), 'error');
          if (delayMs > 0) {
            const completed = await waitMinCheckDelay(delayMs);
            if (!completed || myEpoch !== epoch || opInFlight?.id !== id) return;
          }
        }
        if (!automatic) {
          if (op === 'check') {
            manualCheckStartedAt = null;
            awaitingCheckSettle = false;
          }
          pushDuringActiveOp = false;
        }
        if (op === 'download') autoInstallArmed = false;
        if (!automatic) {
          statusRevision += 1;
          actionError = clientUpdateErrorMessage(error);
          emit();
          void refresh(true, false);
        }
      }
    } finally {
      if (myEpoch === epoch && opInFlight?.id === id) {
        opInFlight = null;
        if (!automatic) {
          pending = null;
          emit();
          if (shouldFollowUpRefresh) {
            void refresh(false, true);
          }
        }
      }
    }
  };

  const triggerAutoCheck = (reason: ClientUpdateCheckReason): void => {
    if (!connected) return;
    if (opInFlight || settleHandle !== null) return;
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
    manualCheckStartedAt = null;
    awaitingCheckSettle = false;
    pushDuringActiveOp = false;
    activeRefreshId = null;
    refreshQueued = null;
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
    lastCheckedAt = null;
    emit();

    if (!config.ready || !config.centerKey) return;
    connected = true;
    if (isNativeCheck) {
      lastPeriodicAt = now();
    }
    const sessionEpoch = epoch;

    const isHidden = () => Boolean(doc?.hidden);
    const syncNative = () => {
      if (!isHidden()) void refresh(false, false);
    };

    const handleStatusEvent = (event?: Event) => {
      if (!connected) return;
      const pushed = extractClientUpdateEventStatus(event);
      if (pushed) {
        applyObservedStatus(pushed, {
          epoch: sessionEpoch,
          revision: statusRevision,
          poll: ++pollSequence,
          fromPush: true,
        });
        return;
      }
      if (!isHidden()) {
        const active = opInFlight;
        if (
          active &&
          !active.automatic &&
          (active.op === 'check' || active.op === 'download' || active.op === 'cancel')
        ) {
          pushDuringActiveOp = true;
        }
        void refresh(false, true);
      }
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

    if (win) {
      win.addEventListener(CLIENT_UPDATE_STATUS_EVENT, handleStatusEvent);
      if (isNativeCheck) {
        win.addEventListener(CLIENT_UPDATE_OPEN_EVENT, syncNative);
      }
      win.addEventListener('focus', onFocus);
      win.addEventListener(CLIENT_UPDATE_FOREGROUND_EVENT, onForegroundEvent);
      win.addEventListener(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT, onReleasePublished);
    }
    if (doc) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    cleanupListeners = () => {
      if (win) {
        win.removeEventListener(CLIENT_UPDATE_STATUS_EVENT, handleStatusEvent);
        if (isNativeCheck) {
          win.removeEventListener(CLIENT_UPDATE_OPEN_EVENT, syncNative);
        }
        win.removeEventListener('focus', onFocus);
        win.removeEventListener(CLIENT_UPDATE_FOREGROUND_EVENT, onForegroundEvent);
        win.removeEventListener(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT, onReleasePublished);
      }
      if (doc) {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
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
