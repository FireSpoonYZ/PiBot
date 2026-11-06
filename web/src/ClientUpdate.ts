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

/** 需要实时轮询原生状态的阶段；其余阶段为稳定态。 */
export const CLIENT_UPDATE_LIVE_PHASES: ReadonlySet<ClientUpdatePhase> = new Set([
  'checking',
  'downloading',
  'waiting-permission',
  'waiting-install',
  'installing',
  'waiting-tasks',
]);

/** 自动检查间隔：持续连接时每 24h 最多触发一次（原生侧仍做持久节流）。 */
export const CLIENT_UPDATE_AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 活动阶段状态轮询间隔。 */
export const CLIENT_UPDATE_POLL_MS = 1500;

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
