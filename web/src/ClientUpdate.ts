// 共享客户端更新状态协议与纯工具：桌面（Tauri invoke）与 Android（mobileLocalRequest）
// 由各自 CenterGate/main 注入同一组语义操作；本文件不含平台调用，秘密不落 localStorage。

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

/** 语义操作；各平台适配层把它映射为桌面 invoke 或 Android mobileLocalRequest。 */
export type ClientUpdateOp = 'status' | 'check' | 'download' | 'install' | 'cancel';
export interface ClientUpdateParams {
  automatic?: boolean;
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

/** 桌面自动检查间隔；Android 由原生客户端服务调度。 */
export const CLIENT_UPDATE_AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 活动阶段低频兜底状态轮询间隔（正常更新由推送事件驱动）。 */
export const CLIENT_UPDATE_POLL_MS = 4000;
/** 手动检查最短确认展示时长（ms），避免极快返回时状态与按钮闪烁。 */
export const CLIENT_UPDATE_MIN_CHECK_MS = 320;
/** 检查阶段延迟展示“取消检查”按钮的阈值（ms），避免短检查时操作行闪烁。 */
export const CLIENT_UPDATE_CANCEL_DELAY_MS = 2500;
export const CLIENT_UPDATE_STATUS_EVENT = 'assistant-update-changed';
export const CLIENT_UPDATE_OPEN_EVENT = 'assistant-open-update';

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
