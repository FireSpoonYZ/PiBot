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
  /** 客户端连接中心应信任的私有 CA（公开证书，无则为空串）；配对码自带它，前端无法自己得知。 */
  centerCa?: string;
}

/** `desktop_host_connect_local`：已把本机 Host 的身份存为客户端凭据（令牌始终不出 Rust）。 */
export interface HostLocalConnectResult {
  centerUrl: string;
  deviceId: string;
  centerCa?: string;
  clientCredentialsSaved?: boolean;
  storeError?: { code?: string; message?: string };
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

/** 用中心管理页签发的一次性配对码配对：地址、密钥与私有 CA 都在码里，前端只传整串文本。 */
export const hostPairCode = (input: { code: string; displayName?: string; force?: boolean }) =>
  invoke<HostPairResult>('desktop_host_pair_code', {
    code: input.code,
    displayName: input.displayName || null,
    force: Boolean(input.force),
  });

/** 已配对的本机 Host 把自己的身份交给客户端，客户端无需再输入任何内容即可连接。 */
export const hostConnectLocal = () => invoke<HostLocalConnectResult>('desktop_host_connect_local');

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

/** 启动器/原生命令错误的原始信息（`{code, message}` 对象、Error 或字符串），用于“详情”。 */
export const rawMessage = (error: unknown): string => {
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
    case 'CENTER_CERT_UNTRUSTED':
      return t(
        '能连上中心，但本机不信任它的证书。中心使用自签或私有 CA 时，请所有者在管理页「添加设备」窗口展开「私有 CA 证书」保存中心的 CA，再重新生成配对码；用所有者密码配对时，在「本机名称与证书」里填写 CA。',
        'The center answered, but this computer does not trust its certificate. If the center uses a self-signed or private CA, the owner should save that CA under “Private CA certificate” in the center’s “Add device” window and generate a new pairing code; when pairing with the owner password, enter the CA under “Computer name and certificate”.',
      );
    case 'ALREADY_CONFIGURED':
      return t('本机已配对过中心', 'This computer is already paired with a center');
    case 'NOT_A_PAIRING_CODE':
      return t('这不是配对码。请在中心管理页的“设备与 Bot”点击“添加设备”获取。', 'That is not a pairing code. Get one from “Add device” on the center’s Devices page.');
    case 'INVALID_PAIRING_CODE':
      return t('配对码不完整或已损坏，请重新复制完整的配对码。', 'The pairing code is incomplete or damaged. Copy the whole code again.');
    case 'UNSUPPORTED_PAIRING_CODE':
      return t('此配对码来自更新版本的中心，请先更新 PiBot。', 'This pairing code comes from a newer center. Update PiBot first.');
    case 'PAIRING_CODE_INVALID':
      return t('配对码无效，请在中心重新生成。', 'The pairing code is not valid. Generate a new one on the center.');
    case 'PAIRING_CODE_USED':
      return t('配对码已被使用，请在中心重新生成。', 'The pairing code has already been used. Generate a new one on the center.');
    case 'PAIRING_CODE_EXPIRED':
      return t('配对码已过期（10 分钟有效），请在中心重新生成。', 'The pairing code has expired (it is valid for 10 minutes). Generate a new one on the center.');
    case 'PAIRING_CODE_REVOKED':
      return t(
        '配对码已作废：中心的“添加设备”窗口被关闭了。复制配对码后请保持该窗口打开，直到配对完成；需要的话重新生成一个。',
        'The pairing code was voided because the “Add device” window on the center was closed. Keep that window open until pairing finishes, and generate a new code if needed.',
      );
    case 'DEVICE_ALREADY_REGISTERED':
      return t(
        '中心上已有这台电脑的设备记录，新配对码不能顶替它。若本机仍保存着凭据，请用“用本机身份连接”；否则请所有者在中心“设备与 Bot”里点该设备的“重新配对”，并使用生成的专属配对码。',
        'The center already has a record for this computer, and a new pairing code cannot replace it. If this computer still holds its credentials, use “Connect with this computer’s identity”; otherwise the owner should click “Re-pair” on that device in the center and use the code it generates.',
      );
    case 'PAIRING_CODE_DEVICE_MISMATCH':
      return t('这个配对码是为另一台设备生成的，不能用于本机。请在中心为本机重新生成。', 'This pairing code was issued for a different device and cannot be used here. Generate one for this computer on the center.');
    case 'CENTER_UNSUPPORTED':
      return t('该中心版本尚不支持配对码，请升级中心，或展开“其他连接方式”使用所有者密码配对。', 'This center does not support pairing codes yet. Upgrade the center, or use the owner password under “Other ways to connect”.');
    case 'RATE_LIMITED':
      return t('尝试次数过多，请稍等一分钟再试。', 'Too many attempts. Wait a minute and try again.');
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
