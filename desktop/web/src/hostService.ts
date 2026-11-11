// 内置本机 Host（pibot-host 启动器）的 Tauri 命令封装。
// 所有者密码与设备令牌只经 invoke 参数传给 Rust，再由 Rust 通过 stdin 交给启动器；不写 localStorage / 日志。
import { invoke } from '@tauri-apps/api/core';

/** 启动器 `status` 输出（契约 §3/C5），Rust 侧额外附带 `hostname`。 */
export interface HostStatus {
  configured: boolean;
  /** supervisor（监管进程）存活；不代表 Host 已就绪。 */
  configError?: unknown;
  running?: boolean | null;
  /** 已认证探测本机 Host 就绪（短超时 GET /v1/service）；缺省按未就绪处理。 */
  ready?: boolean;
  pid: number | null;
  hostPid: number | null;
  controlUrl: string | null;
  centerUrl: string | null;
  deviceId: string | null;
  autostart?: boolean | null;
  /** 自启动范围：仅安装用户登录后运行。 */
  autostartScope?: 'user-login' | 'system-boot';
  platform?: 'windows' | 'linux' | 'macos';
  /** 登录自启登记失败时由启动器附带的真实错误（{code,message}）；macOS 的 `AUTOSTART_STALE` 表示登录项指向旧的 App 位置。 */
  autostartError?: { code?: string; message?: string } | null;
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

/** pair/局部操作附带的非致命告警；启动器字符串与 {code,message} 形态都兼容。 */
export type HostWarning = string | { code?: string; message?: string };

/** 启动器 `pair` 输出：除设备凭据外还汇报 Host running/ready/autostart 与 warnings。 */
export interface HostPairResult {
  deviceId: string;
  deviceToken: string;
  centerUrl: string;
  displayName: string;
  controlUrl: string;
  running?: boolean;
  ready?: boolean;
  autostart?: boolean;
  /** pair 后仍 running：旧进程尚未退出，Host 步骤必须 restart（start 会空操作）。 */
  restartRequired?: boolean;
  warnings?: HostWarning[];
  /** 登记后凭据是否已通过 center_store 持久化；false 时附 storeError，可经内存凭据重试。 */
  clientCredentialsSaved?: boolean;
  storeError?: { code?: string; message?: string };
  /** 强制重新配对后重启 Host 失败时由 Rust 附带。 */
  restartError?: { code: string; message: string };
}

export interface HostAdoptResult {
  adopt: Record<string, unknown>;
  enable: Record<string, unknown>;
  start: Record<string, unknown>;
  clientCredentialsSaved?: boolean;
  storeError?: { code?: string; message?: string };
  /** enable/start 收尾失败的可重试告警（adopt 本体已成功）。 */
  warnings?: HostWarning[];
}

export type HostControlAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'setup-shower' | 'remove';

export interface HostPairInput {
  centerUrl: string;
  password: string;
  displayName?: string;
  /** 可选自签 CA PEM；Rust 暂存写入 center-ca.pem 并传 --center-ca-file，失败恢复旧文件。 */
  centerCa?: string;
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
    centerCa: input.centerCa || null,
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

export const hostWarningText = (warning: HostWarning): string => {
  if (typeof warning === 'string') return warning;
  const code = warning.code?.trim();
  const message = warning.message?.trim();
  return [code, message].filter(Boolean).join(': ') || String(warning);
};

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
      return t('所有者密码不正确', 'Incorrect owner password');
    case 'CENTER_UNREACHABLE':
      return t('无法连接中心', 'Cannot reach the center');
    case 'ALREADY_CONFIGURED':
      return t('本机已配对过中心', 'This computer is already paired with a center');
    case 'DEVICE_ID_MISMATCH':
      return t('设备身份与本机 Host 不匹配，请核对设备 ID 或重新配对', 'The device identity does not match this computer\u2019s paired Host — check the device ID or re-pair');
    case 'NOT_CONFIGURED':
      return t('本机 Host 尚未配对', 'The local Host is not paired yet');
    case 'HOST_LAUNCHER_MISSING':
      return t('未找到内置 Host 组件', 'The bundled Host component was not found');
    case 'TIMEOUT':
      return t('本机 Host 操作超时', 'The local Host operation timed out');
    case 'AUTHORIZATION_CANCELLED':
      return t('授权已取消', 'Authorization was cancelled');
    case 'INSTALL_USER_MISMATCH':
      return t('当前登录账号与安装用户不一致', 'The signed-in account differs from the installing user');
    case 'ADMIN_ACCOUNT_REQUIRED':
      return t('需要管理员账号完成此操作', 'An administrator account is required for this action');
    case 'INSTALLATION_NOT_PROTECTED':
      return t('安装目录未受保护，无法执行此操作', 'The installation is not protected for this action');
    case 'SHOWER_BUSY':
    case 'BUSY':
      return t('本机 Host 正被其他会话占用，请稍后重试', 'The local Host is busy with another session; please retry later');
    default:
      return rawMessage(error);
  }
}
