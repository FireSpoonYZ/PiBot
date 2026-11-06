// 内置本机 Host（e-launcher-host 启动器）的 Tauri 命令封装。
// 主密钥与设备令牌只经 invoke 参数传给 Rust，再由 Rust 通过 stdin 交给启动器；不写 localStorage / 日志。
import { invoke } from '@tauri-apps/api/core';

/** 启动器 `status` 输出（契约 §3），Rust 侧额外附带 `hostname`。 */
export interface HostStatus {
  configured: boolean;
  configError?: unknown;
  running?: boolean | null;
  pid: number | null;
  hostPid: number | null;
  controlUrl: string | null;
  centerUrl: string | null;
  deviceId: string | null;
  autostart?: boolean | null;
  logFile: string;
  /** 启动器若输出则显示；契约未强制。 */
  displayName?: string | null;
  /** 本机主机名（Rust 读取环境），用作默认本机名称。 */
  hostname?: string | null;
  /** 启动器扩展字段：Windows 服务登记/状态/启动类型；缺省=未上报，不乱映射。 */
  service?: { registered?: boolean | null; state?: string | null; startType?: string | null } | null;
  ownerSid?: string | null;
  /** Host 进程阶段与中心连接状态（host_service 附带）；缺省=未知。 */
  hostPhase?: string | null;
  centerState?: string | null;
  online?: boolean | null;
  /** Linux linger 状态；缺省=未上报。 */
  linger?: boolean | null;
}

/** 启动器 `pair` 输出。 */
export interface HostPairResult {
  deviceId: string;
  deviceToken: string;
  centerUrl: string;
  displayName: string;
  controlUrl: string;
  /** 强制重新配对后重启 Host 失败时由 Rust 附带。 */
  restartError?: { code: string; message: string };
  /** 配对成功但个别步骤（自启/启动 Host）失败时由启动器附带；不阻断配对结果。 */
  warnings?: string[];
  running?: boolean;
  autostart?: boolean;
}

export interface HostAdoptResult {
  adopt: Record<string, unknown>;
  enable: Record<string, unknown>;
  start: Record<string, unknown>;
}

export type HostControlAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'remove';

export interface HostPairInput {
  centerUrl: string;
  password: string;
  displayName?: string;
  force?: boolean;
}

export interface HostAdoptInput {
  centerUrl: string;
  deviceId: string;
  deviceToken: string;
  /** 可选自签 CA PEM；Rust 写入 HOST_HOME/center-ca.pem 并传 --center-ca-file。 */
  centerCa?: string;
}

export const hostStatus = () => invoke<HostStatus>('desktop_host_status');

export const hostPair = (input: HostPairInput) =>
  invoke<HostPairResult>('desktop_host_pair', {
    centerUrl: input.centerUrl,
    password: input.password,
    displayName: input.displayName || null,
    force: Boolean(input.force),
  });

export const hostAdopt = (input: HostAdoptInput) =>
  invoke<HostAdoptResult>('desktop_host_adopt', {
    centerUrl: input.centerUrl,
    deviceId: input.deviceId,
    deviceToken: input.deviceToken,
    centerCa: input.centerCa || null,
  });

export const hostControl = (action: HostControlAction) =>
  invoke<Record<string, unknown>>('desktop_host_control', { action });

export const hostErrorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';

const rawMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
};

type Translate = (zh: string, en: string) => string;

/** 启动器错误码 → 用户可读文案。 */
export function hostErrorText(error: unknown, t: Translate): string {
  switch (hostErrorCode(error)) {
    case 'OWNER_AUTH_FAILED':
      return t('主密钥不正确', 'Incorrect master key');
    case 'CENTER_UNREACHABLE':
      return t('无法连接中心', 'Cannot reach the center');
    case 'ALREADY_CONFIGURED':
      return t('本机已配对过中心', 'This computer is already paired with a center');
    case 'NOT_CONFIGURED':
      return t('本机 Host 尚未配对', 'The local Host is not paired yet');
    case 'HOST_LAUNCHER_MISSING':
      return t('未找到内置 Host 组件', 'The bundled Host component was not found');
    case 'TIMEOUT':
      return t('本机 Host 操作超时', 'The local Host operation timed out');
    default:
      return rawMessage(error);
  }
}
