import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, ExternalLink } from 'lucide-react';
import { GrokBotAvatar, JARVIS_AVATAR_PRESET } from '../../../web/src/GrokBotAvatar';
import { ErrorNotice, errorText, useText } from '../../../web/src/ui';
import type { DesktopClientStatus } from '../../../host-core/desktop-client.js';
import { hostAdopt, hostConnectLocal, hostControl, hostErrorCode, hostErrorText, hostPair, hostPairCode, hostStatus, hostWarningText, rawMessage, type HostPairResult, type HostStatus } from './hostService';
import { readPaste } from './pairingCode';
import { ClientUpdateProvider } from '../../../web/src/ClientUpdateProvider';
import type { ClientUpdateOp, ClientUpdateParams, ClientUpdateStatus } from '../../../web/src/ClientUpdate';
import './CenterGate.css';

/** 桌面更新命令适配：语义操作 → desktop_update_* Tauri 命令（原生侧负责节流/验签/安装）。 */
const desktopUpdateRequest = (op: ClientUpdateOp, params?: ClientUpdateParams): Promise<ClientUpdateStatus> => {
  const command = 'desktop_update_' + op;
  if (op === 'check') return invoke<ClientUpdateStatus>(command, { automatic: Boolean(params?.automatic) });
  if (op === 'install') return invoke<ClientUpdateStatus>(command, { stopActive: Boolean(params?.stopActive) });
  return invoke<ClientUpdateStatus>(command);
};

type SavedConnection = { url: string; deviceId: string; ca: string };
/** center_connect 入参；手动连接、自动重连与首次配对共用。 */
type ConnectInput = { url: string; deviceId: string; deviceToken: string; ca?: string };

const centerOrigin = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
};

const matchesHostConnection = (host: HostStatus, url: string, deviceId: string): boolean => {
  const origin = centerOrigin(url);
  return Boolean(origin && origin === centerOrigin(host.centerUrl) && deviceId.trim() && host.deviceId === deviceId.trim());
};

const isNewHost = (host: HostStatus): boolean =>
  host.configured === false && !host.centerUrl && !host.deviceId && !host.configError;

/** 本机 Host 已配对且配置完好：其身份可直接交给客户端使用。 */
const isPairedHost = (host: HostStatus): boolean =>
  host.configured === true && Boolean(host.centerUrl) && Boolean(host.deviceId) && !host.configError;

/**
 * 用户点过“断开中心”：之后不再自动用本机身份重连，只显示按钮。
 * 断开会清掉客户端已存凭据，本机 Host 却仍是已配对状态，没有这个标记就会在下次启动时悄悄连回去。
 * 任何一次成功连接都会清除它。
 */
const USER_DISCONNECTED_KEY = 'center-user-disconnected';
const userDisconnected = (): boolean => localStorage.getItem(USER_DISCONNECTED_KEY) === '1';

/**
 * 门页错误。字符串交给 ErrorNotice 做通用归类；本机 Host 流程的失败已经是写好的指引，按原样显示。
 * 否则通用归类见到“证书 / certificate”就会换成泛泛的“在设置里填写 CA”，把真正的处理办法藏进详情。
 */
type GateError = string | { title: string; description: string; detail?: string };

/** 首次配对进度：pairing=启动器登录/注册/启动 Host（单次调用），connecting=客户端连接中心。 */
type PairPhase = 'idle' | 'pairing' | 'connecting';

/** 配对四步：0 登记设备，1 登录自启动，2 本机 Host 启动并就绪，3 客户端连接。 */
type StepState = 'pending' | 'active' | 'done' | 'error';
/** 配对成功后保留的设备凭据（仅存内存）：saved=是否已写入本机凭据存储。 */
type PairedCreds = { result: HostPairResult; ca: string; saved: boolean };
export type CenterStatus = {
  state: 'disconnected' | 'connecting' | 'ready';
  centerUrl: string;
  clientId: string;
  savedConnection?: SavedConnection;
  /** center ready 时随轮询附带的 broker transport 快照（phase/generation/connection）；
   * 前端只采纳，不据此自动 connect。 */
  broker?: DesktopClientStatus;
};
type Props = { children: ReactNode; onInterrupted(): void; onDisconnected(): void };
type WorkspaceConnection = { key: string; centerUrl: string; clientId: string; deviceId?: string };

const request = <T,>(op: string, params: object = {}) =>
  invoke<T>('desktop_request', { request: { op, params } });

/** RPC 拥塞（host 忙）不是断线：poll/probe 遇 BUSY 保留已确认 status 继续原节奏。 */
const isBusyCenterError = (error: unknown) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'RPC_BUSY' || code === 'BUSY';
};

type CenterConnection = {
  status: CenterStatus | undefined;
  checkCenter: () => Promise<void>;
  disconnectCenter: () => Promise<void>;
};
const CenterConnectionContext = createContext<CenterConnection>({
  status: undefined,
  checkCenter: () => Promise.resolve(),
  disconnectCenter: () => Promise.resolve(),
});

export function useCenterConnection(): CenterConnection {
  return useContext(CenterConnectionContext);
}

export type DesktopTheme = 'light' | 'dark' | 'system';

const readDesktopTheme = (): DesktopTheme => {
  const value = localStorage.getItem('desktop-theme');
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
};

const applyDesktopTheme = (theme: DesktopTheme) => {
  document.documentElement.dataset.theme = theme;
};

export function useDesktopTheme(): { theme: DesktopTheme; setTheme: (theme: DesktopTheme) => void } {
  const [theme, setThemeState] = useState<DesktopTheme>(readDesktopTheme);
  const setTheme = (next: DesktopTheme) => {
    localStorage.setItem('desktop-theme', next);
    applyDesktopTheme(next);
    setThemeState(next);
  };
  return { theme, setTheme };
}

export function CenterGate({ children, onInterrupted, onDisconnected }: Props) {
  const t = useText();
  // 主题应用放在真实桌面入口挂载处：本模块会被 BotSettings -> openCenterManagement 间接导入，
  // 而 BotSettings 可被手机端引用，模块加载即写 data-theme 会污染移动端。
  useLayoutEffect(() => {
    applyDesktopTheme(readDesktopTheme());
  }, []);
  const [url, setUrl] = useState(() => localStorage.getItem('center-url') ?? '');
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('center-device-id') ?? '');
  const [token, setToken] = useState('');
  const [ca, setCa] = useState('');
  const [status, setStatus] = useState<CenterStatus>();
  const [workspace, setWorkspace] = useState<WorkspaceConnection>();
  const [saved, setSaved] = useState<SavedConnection>();
  const [error, setError] = useState<GateError>('');
  /** 本机 Host 流程的失败：标题说明哪一步，正文是启动器错误码对应的指引，原始报错放进详情。 */
  const hostFailure = (title: string, e: unknown): GateError => {
    const description = hostErrorText(e, t);
    const raw = rawMessage(e);
    return { title, description, ...(raw && raw !== description ? { detail: raw } : {}) };
  };
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** undefined=读取中；null=内置 Host 不可用（开发构建或缺组件），退回手动连接；否则为启动器 status。 */
  const [host, setHost] = useState<HostStatus | null>();
  /** 首次 center_status 轮询已结束（成功或失败），用于判断是否存在已保存连接。 */
  const [polled, setPolled] = useState(false);
  /** 所有者密码仅为输入态，提交即清空。 */
  const [password, setPassword] = useState('');
  const [pairName, setPairName] = useState('');
  const [pairForce, setPairForce] = useState(false);
  const [pairPhase, setPairPhase] = useState<PairPhase>('idle');
  /** 配对四步真实状态；未进行配对时为 undefined。 */
  const [pairSteps, setPairSteps] = useState<StepState[]>();
  /** pair 返回的非致命告警（启动/自启失败等），逐条展示，不渲染全成功。 */
  const [pairWarnings, setPairWarnings] = useState<string[]>([]);
  /** 正在局部重试的步骤下标。 */
  const [retryingStep, setRetryingStep] = useState<number>();
  const [adoptHost, setAdoptHost] = useState(true);
  /** 配对码输入框内容：只存内存，登记成功后清空。 */
  const [pairCode, setPairCode] = useState('');
  /** 本机已配到另一个中心时，用户确认“替换现有配对”后，用 force 重新提交同一配对码。 */
  const [codeForce, setCodeForce] = useState(false);
  /** 正在用本机 Host 的身份连接中心。 */
  const [localBusy, setLocalBusy] = useState(false);
  /** 本次运行已自动尝试过本机身份连接（只试一次，失败后交给用户）。 */
  const localTried = useRef(false);
  /** 配对成功后保留设备凭据与 CA，供步骤重试/连接重试，仅存内存。 */
  const pairedRef = useRef<PairedCreds | null>(null);
  const [canRetryPaired, setCanRetryPaired] = useState(false);
  /** Windows 原生虚拟屏配置（setup-shower）进度与结果。 */
  const [showerBusy, setShowerBusy] = useState(false);
  const [showerOutcome, setShowerOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const epoch = useRef(0);
  const statusRead = useRef(0);
  const autoAttempted = useRef(false);
  const disconnecting = useRef(false);
  const lastProbeAt = useRef(0);
  const probeInFlight = useRef(false);
  const statusRef = useRef(status);
  const workspaceRef = useRef(workspace);

  /** 暂态保留工作区，收到断线状态时先封住旧 transport，再发布 UI 状态。 */
  const applyStatus = (next: CenterStatus | undefined, connectedDeviceId?: string): void => {
    let active = workspaceRef.current;
    const savedDeviceId = next?.savedConnection && centerOrigin(next.savedConnection.url) === next.centerUrl
      ? next.savedConnection.deviceId
      : undefined;
    const nextDeviceId = connectedDeviceId ?? savedDeviceId;
    if (active && next && (
      active.clientId !== next.clientId ||
      (next.centerUrl && active.centerUrl !== next.centerUrl) ||
      (active.deviceId && nextDeviceId && active.deviceId !== nextDeviceId)
    )) {
      onDisconnected();
      active = undefined;
      workspaceRef.current = undefined;
      setWorkspace(undefined);
    }
    if (next?.state === 'ready' && !active) {
      const connection = {
        key: JSON.stringify([next.centerUrl, next.clientId, nextDeviceId]),
        centerUrl: next.centerUrl,
        clientId: next.clientId,
        deviceId: nextDeviceId,
      };
      workspaceRef.current = connection;
      setWorkspace(connection);
    } else if (active && next?.state !== 'ready' && statusRef.current?.state === 'ready') {
      onInterrupted();
    }
    statusRef.current = next;
    setStatus(next);
    if (next) setSaved(next.savedConnection);
  };

  /** center ready 时顺带读取 broker transport 快照（仅多一次本地 sidecar 读）。 */
  const readStatus = async (params: object = {}): Promise<CenterStatus> => {
    const next = await request<CenterStatus>('center_status', params);
    if (next.state !== 'ready') return next;
    try {
      const broker = await request<DesktopClientStatus>('status');
      return { ...next, broker };
    } catch {
      return next;
    }
  };

  /** 显式探测：复用 broker center_status({probe:true})——ready 时验证双链路，
   * connecting 时绕过退避立即重试；不发起 UI 侧 connect，不违背显式断开。 */
  const probe = async (): Promise<void> => {
    if (disconnecting.current) return;
    const issued = epoch.current;
    const read = ++statusRead.current;
    lastProbeAt.current = Date.now();
    try {
      const next = await readStatus({ probe: true });
      if (issued === epoch.current && read === statusRead.current) applyStatus(next);
    } catch (failure) {
      if (!isBusyCenterError(failure) && issued === epoch.current && read === statusRead.current) applyStatus(undefined);
    }
  };

  /** 统一的中心连接：调用 center_connect，成功且仍为当前尝试时保存 localStorage 并更新状态。 */
  const connectCenter = async (input: ConnectInput, isCurrent: () => boolean = () => true): Promise<CenterStatus | undefined> => {
    const next = await request<CenterStatus>('center_connect', {
      url: input.url,
      deviceId: input.deviceId,
      deviceToken: input.deviceToken,
      ...(input.ca ? { ca: input.ca } : {}),
    });
    if (!isCurrent()) return undefined;
    statusRead.current += 1;
    localStorage.setItem('center-url', input.url);
    localStorage.setItem('center-device-id', input.deviceId);
    applyStatus(next, input.deviceId);
    localStorage.removeItem(USER_DISCONNECTED_KEY);
    return next;
  };

  /** 读取内置 Host 状态；不可用时退回仅手动连接。 */
  const refreshHost = async (): Promise<HostStatus | null> => {
    try {
      const next = await hostStatus();
      setHost(next);
      setPairName((prev) => prev || next.hostname?.trim() || t('我的电脑', 'My computer'));
      return next;
    } catch {
      setHost(null);
      return null;
    }
  };

  useEffect(() => {
    void refreshHost();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!url || !deviceId) {
      void request<{ state?: { profiles?: Array<{ kind?: string; url?: string; deviceId?: string; expectedDeviceId?: string }> } }>('ui_get')
        .then((snap) => {
          const profiles = snap?.state?.profiles ?? [];
          const relayProf = profiles.find((p) => p.kind === 'relay' && p.url && p.deviceId);
          const localProf = profiles.find((p) => p.kind === 'local' && p.expectedDeviceId);
          if (!url && relayProf?.url) {
            try {
              const u = new URL(relayProf.url);
              const centerOrigin = `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}`;
              setUrl((prev) => prev || centerOrigin);
            } catch { /* ignore */ }
          }
          const fallbackDevId = relayProf?.deviceId || localProf?.expectedDeviceId || '';
          if (!deviceId && fallbackDevId) setDeviceId((prev) => prev || fallbackDevId);
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (disconnecting.current) {
        timer = setTimeout(poll, 1000);
        return;
      }
      const issued = epoch.current;
      const read = ++statusRead.current;
      try {
        const next = await readStatus();
        if (live && issued === epoch.current && read === statusRead.current) {
          const conn = !autoAttempted.current && !workspaceRef.current ? next.savedConnection : undefined;
          applyStatus(next);
          if (conn) {
            setUrl((prev) => prev || conn.url);
            setDeviceId((prev) => prev || conn.deviceId);
            setCa((prev) => prev || conn.ca);
            if (next.state !== 'ready') {
              autoAttempted.current = true;
              const attempt = ++epoch.current;
              setBusy(true);
              try {
                await connectCenter(
                  { url: conn.url, deviceId: conn.deviceId, deviceToken: '', ca: conn.ca },
                  () => live && attempt === epoch.current,
                );
              } catch (e) {
                if (live && attempt === epoch.current) {
                  setError(t('自动连接中心失败，请核对已保存凭据或重新输入令牌。', 'Auto-connect to the center failed. Check the saved credentials or re-enter the token.') + ' ' + errorText(e));
                }
              } finally {
                if (live && attempt === epoch.current) setBusy(false);
              }
            }
          }
        }
      } catch (failure) {
        if (!isBusyCenterError(failure) && live && issued === epoch.current && read === statusRead.current) applyStatus(undefined);
      }
      if (live) setPolled(true);
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  // 窗口回到前台探测一次（节流 10s、单飞）：ready 也探测——休眠期 cached-ready 的
  // 半开连接只能靠 probe 暴露。显式断开或已切到直连档案时不探测中心中继。
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || disconnecting.current || probeInFlight.current || Date.now() - lastProbeAt.current < 10000) return;
      probeInFlight.current = true;
      void (async () => {
        const issued = epoch.current;
        try {
          const cur = statusRef.current;
          if (cur?.state === 'ready') {
            try {
              const broker = await request<DesktopClientStatus>('status');
              if (issued !== epoch.current) return;
              if (broker.phase === 'disconnected' || broker.connection?.kind === 'local') return;
            } catch { /* status 读失败仍走 probe 判定 */ }
          }
          await probe();
        } finally {
          probeInFlight.current = false;
        }
      })();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 配对完成后清理步骤，显式更换连接时显示当前表单。
  useEffect(() => {
    if (status?.state !== 'ready') return;
    pairedRef.current = null;
    setPairSteps(undefined);
    setPairWarnings([]);
    setCanRetryPaired(false);
    setPairPhase('idle');
  }, [status?.state]);

  const matchesSaved = Boolean(
    saved &&
    saved.url === url.trim() &&
    saved.deviceId === deviceId.trim() &&
    saved.ca === ca.trim(),
  );

  /** 首次运行：内置 Host 可用、未配对且客户端无已保存连接时显示配对表单；配对流程中保持显示。 */
  const firstRun = Boolean(host && isNewHost(host) && !saved && polled);
  const showPair = firstRun || pairPhase !== 'idle' || pairSteps !== undefined;
  /** 内置 Host 可用：主入口是配对码；开发构建或缺组件时为 false，退回手动连接。 */
  const hostAvailable = Boolean(host);
  /** 本机 Host 已配对：其身份可直接交给客户端，免去任何输入。 */
  const pairedHost = Boolean(host && isPairedHost(host));
  const paste = readPaste(pairCode);
  /** 手动连接时可让内置 Host 接管该设备：未配对，或已配对的正是同一设备（刷新令牌）。 */
  const offerAdopt = Boolean(host && (isNewHost(host) || matchesHostConnection(host, url, deviceId)));

  /**
   * 配对码误填进手动表单（设备令牌 / 设备身份）：它不是凭据，拿去直连只会得到看不懂的 TLS 或认证错误。
   * 有内置 Host 时转交配对码流程；没有时说明原因。返回 true 表示已按配对码处理。
   */
  const takeMisplacedCode = (value: string): boolean => {
    if (readPaste(value).kind !== 'code') return false;
    if (hostAvailable) {
      setToken('');
      onPairCodeChange(value);
    } else {
      setError(t('这是配对码，不是设备令牌。配对码需要带内置 Host 的 PiBot 客户端；当前客户端只能用设备 ID 和令牌连接。', 'That is a pairing code, not a device token. Pairing codes need a PiBot client with the built-in Host; this client can only connect with a device ID and token.'));
    }
    return true;
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || showerBusy) return;
    if ([token, deviceId].some(takeMisplacedCode)) return;
    const attempt = ++epoch.current;
    autoAttempted.current = true;
    setBusy(true);
    setError('');
    setCanRetryPaired(false);
    setPairSteps(undefined);
    setPairWarnings([]);
    pairedRef.current = null;
    const input: ConnectInput = { url: url.trim(), deviceId: deviceId.trim(), deviceToken: token.trim(), ca: ca.trim() };
    /** adopt 成功但收尾步骤（enable/start/凭据保存）未全部完成时的如实提示。 */
    let adoptNotes: string[] = [];
    try {
      // adopt 会启用自启动；只在首次配置时调用，已配置 Host 的普通重连绝不调用。
      const currentHost = host && isNewHost(host) && offerAdopt && adoptHost && input.deviceToken ? await refreshHost() : null;
      if (currentHost && isNewHost(currentHost)) {
        try {
          const adoptResult = await hostAdopt({ centerUrl: input.url, deviceId: input.deviceId, deviceToken: input.deviceToken, centerCa: input.ca });
          adoptNotes = (adoptResult.warnings ?? []).map(hostWarningText);
          if (adoptResult.clientCredentialsSaved === false) {
            adoptNotes.push(
              t('客户端凭据未能保存到本机。', 'Client credentials could not be stored locally.') +
                (adoptResult.storeError?.message ? ' ' + adoptResult.storeError.message : ''),
            );
          }
          if (adoptNotes.length > 0) {
            setError(
              t('本机 Host 已接管，但部分收尾步骤未完成：', 'The local Host took over the device, but some wrap-up steps did not finish: ') +
                adoptNotes.join('；'),
            );
          }
        } catch (e) {
          setError(
            t('本机 Host 接管失败；可重试或在连接页显式重新配对。若只连接客户端，可取消首次配置选项。', 'The local Host could not take over this device. Retry or re-pair explicitly; uncheck first-time setup to connect the client only.') +
              ' ' + hostErrorText(e, t),
          );
          return;
        } finally {
          void refreshHost();
        }
      }
      await connectCenter(input, () => attempt === epoch.current);
    } catch (e) {
      if (attempt !== epoch.current) return;
      applyStatus(undefined);
      setError(
        t('中心连接失败，请检查地址、设备身份、令牌与证书。', 'Failed to connect to the center. Check the address, device identity, token and certificate.') +
          (adoptNotes.length > 0 ? ' ' + t('本机 Host 收尾警告：', 'Host wrap-up warnings: ') + adoptNotes.join('；') : '') +
          ' ' + errorText(e),
      );
    } finally {
      setToken('');
      setBusy(false);
    }
  };

  /** 配对完成后以启动器返回的设备凭据连接客户端（与手动连接同一路径，含可选 CA）。 */
  const connectPaired = async (paired: PairedCreds, attempt: number) => {
    setCanRetryPaired(false);
    setPairPhase('connecting');
    setPairSteps((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[3] = 'active';
      return next;
    });
    try {
      // 凭据未持久化时先经同一 center_store 重试保存（无网络）；失败仍继续连接，
      // 连接成功本身也会写凭据——绝不因保存失败而重新登记。
      if (!paired.saved) {
        try {
          await request('center_store', {
            url: paired.result.centerUrl,
            deviceId: paired.result.deviceId,
            deviceToken: paired.result.deviceToken,
            ca: paired.ca,
          });
          paired.saved = true;
        } catch { /* 连接成功后凭据同样会写入，忽略本次保存失败 */ }
      }
      await connectCenter(
        { url: paired.result.centerUrl, deviceId: paired.result.deviceId, deviceToken: paired.result.deviceToken, ca: paired.ca },
        () => attempt === epoch.current,
      );
      // 只清掉自己这份凭据：期间若已有更新的配对结果，保留它。
      if (pairedRef.current === paired) pairedRef.current = null;
    } catch (e) {
      if (attempt !== epoch.current) return;
      setPairSteps((prev) => {
        if (!prev) return prev;
        const next = prev.slice();
        next[3] = 'error';
        return next;
      });
      setUrl(paired.result.centerUrl);
      setDeviceId(paired.result.deviceId);
      setCanRetryPaired(true);
      setError(t('设备已配对，但客户端连接中心失败。', 'The device is paired, but the client could not connect to the center.') + ' ' + hostErrorText(e, t));
    } finally {
      if (attempt === epoch.current) setPairPhase('idle');
    }
  };

  /** Host 已启动但未就绪时短轮询等待就绪（约 12s）；超时或停止返回 false。 */
  const awaitHostReady = async (attempt: number): Promise<boolean> => {
    for (let i = 0; i < 12; i += 1) {
      if (attempt !== epoch.current) return false;
      const st = await refreshHost();
      if (!st?.running) return false;
      if (st.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  };

  /** 把某步失败原因并入告警列表（去重）；步骤本身标 error，不阻断后续。 */
  const noteStepFailure = (text: string) =>
    setPairWarnings((prev) => (prev.includes(text) ? prev : [...prev, text]));

  /**
   * 登记成功后的自动顺序执行（接口 B：pair 只登记，不再隐式 enable/start）：
   * 步1 登录自启（hostControl enable）→ 步2 启动并就绪（start/restart + 真实 ready）→ 步3 客户端连接。
   * 失败步标 error 并可独立重试，但流程继续：enable 失败仍可 start/仅连接客户端，不渲染全成功。
   */
  const runSteps = async (
    paired: PairedCreds,
    initial: StepState[],
    attempt: number,
    fromIndex = 1,
  ) => {
    const steps = initial.slice();
    for (let i = Math.max(1, fromIndex); i <= 3; i += 1) {
      if (attempt !== epoch.current) return;
      if (steps[i] === 'done') continue;
      steps[i] = 'active';
      setPairSteps(steps.slice());
      if (i === 1) {
        let done = false;
        try {
          await hostControl('enable');
          const fresh = await refreshHost();
          if (attempt !== epoch.current) return;
          done = fresh?.autostart === true;
          if (!done) noteStepFailure(t('登录自启动未启用。', 'Run at login was not enabled.'));
        } catch (e) {
          if (attempt !== epoch.current) return;
          noteStepFailure(t('登录自启动失败：', 'Run at login failed: ') + hostErrorText(e, t));
        }
        steps[i] = done ? 'done' : 'error';
      } else if (i === 2) {
        let ready = false;
        try {
          const current = await refreshHost();
          if (attempt !== epoch.current) return;
          // restartRequired=true 表示旧进程尚未退出，start 会见锁空操作，必须 restart。
          const needsRestart = paired.result.restartRequired === true || current?.running === true;
          await hostControl(needsRestart ? 'restart' : 'start');
          ready = await awaitHostReady(attempt);
          if (!ready) noteStepFailure(t('本机 Host 已启动但未就绪。', 'The local Host started but is not ready.'));
        } catch (e) {
          if (attempt !== epoch.current) return;
          noteStepFailure(t('本机 Host 启动失败：', 'The local Host failed to start: ') + hostErrorText(e, t));
        }
        if (attempt !== epoch.current) return;
        steps[i] = ready ? 'done' : 'error';
      } else {
        // 设备已登记：客户端连接独立于本机 Host，始终尝试。
        await connectPaired(paired, attempt);
        return;
      }
      setPairSteps(steps.slice());
    }
  };

  /** 局部重试：从指定步骤起重跑未完成的剩余步骤（enable→start/ready→connect），不做二次 pair。 */
  const retryStep = async (index: number) => {
    const paired = pairedRef.current;
    if (!paired || !pairSteps || busy || showerBusy) return;
    const attempt = ++epoch.current;
    setBusy(true);
    setError('');
    setRetryingStep(index);
    try {
      const steps = pairSteps.slice();
      steps[index] = 'pending';
      await runSteps(paired, steps, attempt, index);
    } finally {
      setRetryingStep(undefined);
      if (attempt === epoch.current) setBusy(false);
    }
  };

  /** 原生虚拟屏配置：仅 Windows 显示；用户显式触发，可能弹 UAC/凭据框并短暂停止本机 Host。 */
  const setupShower = async () => {
    // 与 pair/start/restart 串行：setup-shower 会短暂停止本机 Host。
    if (showerBusy || busy) return;
    setShowerBusy(true);
    setShowerOutcome(null);
    try {
      const result = await hostControl('setup-shower');
      const configured = result.configured === true;
      const verified = result.verified === true;
      setShowerOutcome(
        configured && verified
          ? { ok: true, text: t('虚拟屏已配置并通过验证。', 'Virtual display configured and verified.') }
          : { ok: false, text: t('虚拟屏配置已结束，但未完成验证。', 'Virtual display setup finished without completing verification.') },
      );
    } catch (e) {
      setShowerOutcome({ ok: false, text: hostErrorText(e, t) });
    } finally {
      setShowerBusy(false);
      void refreshHost();
    }
  };

  /**
   * 配对公共流程：登记（所有者密码或配对码）→ 自启动 → 启动并就绪 Host → 连接客户端。
   * 两种登记方式只差 register 本身与 CA 的来源（密码流程来自表单，配对码流程来自码本身）。
   */
  const runPairFlow = async (
    register: () => Promise<HostPairResult>,
    caOf: (result: HostPairResult) => string,
    onAlreadyConfigured: () => void,
    onRegistered: () => void,
  ) => {
    const attempt = ++epoch.current;
    autoAttempted.current = true;
    setBusy(true);
    setError('');
    setCanRetryPaired(false);
    setPairWarnings([]);
    setPairSteps(['active', 'pending', 'pending', 'pending']);
    setPairPhase('pairing');
    try {
      let result: HostPairResult;
      try {
        result = await register();
      } catch (e) {
        // 登记是单次调用；失败统一标在登记步。
        setPairSteps(['error', 'pending', 'pending', 'pending']);
        setPairPhase('idle');
        if (hostErrorCode(e) === 'ALREADY_CONFIGURED') {
          onAlreadyConfigured();
        } else {
          setError(hostFailure(t('配对失败', 'Pairing failed'), e));
        }
        void refreshHost();
        return;
      }
      setPairForce(false);
      setCodeForce(false);
      onRegistered();
      setPairWarnings((result.warnings ?? []).map(hostWarningText));
      const paired: PairedCreds = { result, ca: caOf(result), saved: result.clientCredentialsSaved === true };
      pairedRef.current = paired;
      if (!paired.saved) {
        noteStepFailure(
          t('客户端凭据未能保存到本机，若现在关闭窗口可能需要重新登记。', 'Client credentials could not be stored locally; closing the window now may require re-pairing.') +
            (result.storeError?.message ? ' ' + result.storeError.message : ''),
        );
      }
      if (attempt !== epoch.current) {
        setPairPhase('idle');
        return;
      }
      const fresh = await refreshHost();
      if (attempt !== epoch.current) {
        setPairPhase('idle');
        return;
      }
      // pair 只登记+持久化；步1/步2 由启动器汇报的真实状态决定是否可跳过。
      const steps: StepState[] = [
        'done',
        (fresh?.autostart ?? result.autostart ?? false) ? 'done' : 'pending',
        (fresh?.ready ?? result.ready ?? false) ? 'done' : 'pending',
        'pending',
      ];
      await runSteps(paired, steps, attempt);
    } finally {
      setBusy(false);
    }
  };

  const defaultPairName = () => pairName.trim() || host?.hostname?.trim().slice(0, 64) || t('我的电脑', 'My computer');

  /** 所有者密码配对（折叠在“其他连接方式”里）。 */
  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || showerBusy) return;
    // 冻结提交时输入：异步完成只认这份 URL/CA，busy 期间输入框已禁用。
    const frozenUrl = url.trim();
    const frozenCa = ca.trim();
    const frozenName = defaultPairName();
    const secret = password;
    setPassword('');
    const force = pairForce;
    await runPairFlow(
      () => hostPair({ centerUrl: frozenUrl, password: secret, displayName: frozenName, centerCa: frozenCa, force }),
      () => frozenCa,
      () => {
        setPairForce(true);
        setError(t('本机已配对过中心。重新输入所有者密码并点击“重新配对”将覆盖现有配置。', 'This computer is already paired. Re-enter the owner password and click “Re-pair” to replace the existing pairing.'));
      },
      () => {},
    );
  };

  /** 配对码配对：地址、一次性密钥和私有 CA 都在码里，用户无需再输入任何内容。 */
  const pairWithCode = async (text: string, force: boolean) => {
    if (busy || showerBusy) return;
    const frozenName = defaultPairName();
    await runPairFlow(
      () => hostPairCode({ code: text, displayName: frozenName, force }),
      (result) => result.centerCa ?? '',
      () => {
        // 同一个中心的配对码不需要确认：已存在的设备 ID 只有专属码才接得回，通用码由中心拒绝；走到这里说明本机已配到另一个中心，需要用户明确确认。
        setCodeForce(true);
        setError(t('本机已配对到另一个中心。再次点击“替换现有配对”将覆盖本机现有配置。', 'This computer is paired with a different center. Click “Replace existing pairing” to overwrite it.'));
      },
      // 配对码用过即废，登记成功后不再保留在输入框里。
      () => setPairCode(''),
    );
  };

  /** 输入框变化：识别出完整配对码就立即开始配对，其余输入只给出提示。 */
  const onPairCodeChange = (value: string) => {
    setPairCode(value);
    setCodeForce(false);
    setError('');
    if (readPaste(value).kind === 'code' && !busy && !showerBusy) void pairWithCode(value, false);
  };

  /**
   * 用本机 Host 的身份连接中心：已配对的 Host 把自己的身份交给客户端，无需输入任何内容。
   * 令牌始终留在 Rust 侧；这里只拿到地址、设备 ID 和（公开的）CA。
   */
  const connectLocal = async () => {
    if (busy || showerBusy) return;
    const attempt = ++epoch.current;
    autoAttempted.current = true;
    setBusy(true);
    setLocalBusy(true);
    setError('');
    try {
      const stored = await hostConnectLocal();
      if (attempt !== epoch.current) return;
      if (stored.clientCredentialsSaved === false) {
        throw new Error(t('无法保存本机身份到客户端。', 'Could not store the local identity for the client.') + (stored.storeError?.message ? ' ' + stored.storeError.message : ''));
      }
      // 凭据已在 Rust 侧存好：令牌留空，由客户端用已存凭据重连（地址、设备 ID、CA 须与所存一致）。
      await connectCenter(
        { url: stored.centerUrl, deviceId: stored.deviceId, deviceToken: '', ca: stored.centerCa ?? '' },
        () => attempt === epoch.current,
      );
    } catch (e) {
      if (attempt !== epoch.current) return;
      setError(hostFailure(t('无法用本机身份连接中心', 'Could not connect with this computer’s identity'), e));
    } finally {
      if (attempt === epoch.current) {
        setBusy(false);
        setLocalBusy(false);
      }
    }
  };

  // 已配对的本机 Host + 客户端没有已存连接：启动后自动用本机身份连接一次，什么都不用填。
  // 用户主动断开过则不自动连，只显示按钮。失败后留给用户（按钮或配对码），不循环重试。
  useEffect(() => {
    if (localTried.current || !polled || !host || !isPairedHost(host) || saved || workspaceRef.current) return;
    if (status?.state === 'ready' || status?.state === 'connecting' || userDisconnected()) return;
    localTried.current = true;
    void connectLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polled, host, saved, status?.state]);

  const retryPaired = () => {
    const paired = pairedRef.current;
    if (!paired || busy || showerBusy) return;
    const attempt = ++epoch.current;
    setBusy(true);
    setError('');
    void connectPaired(paired, attempt).finally(() => setBusy(false));
  };

  const disconnectCenter = async () => {
    if (disconnecting.current) return;
    disconnecting.current = true;
    localStorage.setItem(USER_DISCONNECTED_KEY, '1');
    epoch.current += 1;
    autoAttempted.current = true;
    onInterrupted();
    statusRef.current = undefined;
    setStatus(undefined);
    try {
      const next = await request<CenterStatus>('center_disconnect');
      onDisconnected();
      workspaceRef.current = undefined;
      setWorkspace(undefined);
      applyStatus(next);
    } finally {
      disconnecting.current = false;
    }
  };

  if (workspace) {
    return (
      <CenterConnectionContext.Provider value={{ status, checkCenter: probe, disconnectCenter }}>
        <ClientUpdateProvider key={workspace.key} request={desktopUpdateRequest} ready={status?.state === 'ready'} centerKey={workspace.key}>
          {children}
        </ClientUpdateProvider>
      </CenterConnectionContext.Provider>
    );
  }

  const copyClientId = () => {
    if (!status?.clientId) return;
    void navigator.clipboard?.writeText(status.clientId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const connecting = busy || status?.state === 'connecting';

  const pairStepLabels = [
    t('登记设备', 'Register device'),
    host?.autostartScope === 'system-boot' || host?.platform === 'linux'
      ? t('开机时自动运行', 'Run automatically at startup')
      : t('登录后自动运行', 'Run automatically at login'),
    t('启动并就绪本机 Host', 'Start and ready the local Host'),
    t('连接客户端', 'Connect client'),
  ];
  const pairStepState = (index: number): StepState => pairSteps?.[index] ?? 'pending';
  const showPairSteps = pairPhase !== 'idle' || pairSteps !== undefined;

  const manualForm = (
    <form className="gate-form" onSubmit={connect}>
      <label className="gate-field">
        <span>{t('中心 HTTPS 地址', 'Center HTTPS URL')}</span>
        <input required type="url" value={url} disabled={busy || showerBusy} onChange={e => setUrl(e.target.value)} placeholder="https://center.example.com" />
      </label>
      <label className="gate-field">
        <span>{t('设备身份', 'Device identity')}</span>
        <input required value={deviceId} disabled={busy || showerBusy} onChange={e => setDeviceId(e.target.value)} />
      </label>
      <label className="gate-field">
        <span>
          {t('设备令牌', 'Device token')}
          {matchesSaved && <em className="gate-saved-badge">{t('已保存，留空即可重连', 'Saved — leave blank to reconnect')}</em>}
        </span>
        <input
          required={!matchesSaved}
          type="password"
          autoComplete="off"
          value={token}
          disabled={busy || showerBusy}
          onChange={e => { setToken(e.target.value); takeMisplacedCode(e.target.value); }}
          placeholder={matchesSaved ? t('已保存凭据，留空使用已存令牌', 'Saved credentials — leave blank to reuse') : ''}
        />
      </label>
      <details className="gate-advanced">
        <summary>{t('高级 TLS / 自签 CA 证书（可选）', 'Advanced TLS / self-signed CA certificate (optional)')}</summary>
        <textarea value={ca} disabled={busy || showerBusy} onChange={e => setCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" rows={4} />
      </details>
      {host && isNewHost(host) && offerAdopt && (
        <label className="gate-check">
          <input type="checkbox" checked={adoptHost} disabled={busy || showerBusy} onChange={e => setAdoptHost(e.target.checked)} />
          <span>{t('同时在本机运行 Host', 'Also run the Host on this computer')}</span>
        </label>
      )}
      <button disabled={busy || showerBusy} type="submit" className="primary-button gate-submit">
        {connecting ? t('连接中…', 'Connecting…') : t('连接中心', 'Connect')}
      </button>
    </form>
  );

  const hostLabel = (value: string | null | undefined): string => {
    try {
      return value ? new URL(value).host : '';
    } catch {
      return '';
    }
  };
  const pairedHostLabel = hostLabel(host?.centerUrl);
  /** 打开中心管理页：优先用表单里的地址，其次是本机 Host 已配对的中心。 */
  const managementUrl = url.trim() || host?.centerUrl?.trim() || '';

  const pasteErrorCode =
    paste.kind === 'not-code' ? 'NOT_A_PAIRING_CODE'
      : paste.kind === 'damaged' ? 'INVALID_PAIRING_CODE'
        : paste.kind === 'unsupported' ? 'UNSUPPORTED_PAIRING_CODE'
          : '';
  const pasteHint = paste.kind === 'code'
    ? t(`将连接到 ${paste.centerHost}`, `Will connect to ${paste.centerHost}`)
    : pasteErrorCode ? hostErrorText({ code: pasteErrorCode }, t) : '';

  /** 配对进度与告警：所有者密码和配对码两种方式共用，放在表单之外以便折叠时仍可见。 */
  const pairProgress = showPairSteps && (
    <>
      <ol className="gate-steps" aria-live="polite">
        {pairStepLabels.map((label, index) => {
          const state = pairStepState(index);
          return (
            <li key={label} className={`gate-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <span className="gate-step-dot" aria-hidden />
              <span className="gate-step-label">{label}</span>
              {state === 'error' && index > 0 && pairedRef.current && (
                <button
                  type="button"
                  className="gate-step-retry"
                  disabled={busy || showerBusy}
                  onClick={() => void retryStep(index)}
                >
                  {retryingStep === index
                    ? index === 1
                      ? t('等待授权…', 'Awaiting approval…')
                      : t('重试中…', 'Retrying…')
                    : t('重试', 'Retry')}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {pairWarnings.length > 0 && (
        <ul className="gate-warnings">
          {pairWarnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  );

  /** 主入口：粘贴中心管理页签发的配对码；识别出完整的码就立即配对。 */
  const pairCodeForm = (
    <form
      className="gate-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (paste.kind === 'code') void pairWithCode(pairCode, codeForce);
      }}
    >
      <label className="gate-field">
        <span>{t('配对码', 'Pairing code')}</span>
        <textarea
          className="gate-code"
          rows={3}
          value={pairCode}
          disabled={busy || showerBusy}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder={t('在中心管理页的“设备与 Bot”点击“添加设备”，复制配对码后粘贴到这里', 'On the center’s Devices page click “Add device”, copy the pairing code and paste it here')}
          onChange={(event) => onPairCodeChange(event.target.value)}
        />
      </label>
      {pasteHint && <p className={`gate-hint${pasteErrorCode ? ' gate-hint-warn' : ''}`} role="status">{pasteHint}</p>}
      <button disabled={busy || showerBusy || paste.kind !== 'code'} type="submit" className="primary-button gate-submit">
        {busy
          ? (pairPhase === 'connecting' ? t('连接中…', 'Connecting…') : t('配对中…', 'Pairing…'))
          : codeForce ? t('替换现有配对', 'Replace existing pairing') : t('配对并连接', 'Pair and connect')}
      </button>
    </form>
  );

  /** 所有者密码配对：旧版中心（没有配对码）的退路，折叠在“其他连接方式”里。 */
  const passwordForm = (
    <form className="gate-form" onSubmit={pair}>
      {pairForce && <p className="gate-subtitle">{t('重新配对会替换本机 Host 的中心配置。', 'Re-pairing replaces the local Host center configuration.')}</p>}
      <label className="gate-field">
        <span>{t('中心地址', 'Center URL')}</span>
        <input required type="url" value={url} disabled={busy || showerBusy} onChange={e => setUrl(e.target.value)} placeholder="https://center.example.com" />
      </label>
      <label className="gate-field">
        <span>{t('所有者密码', 'Owner password')}</span>
        <input required type="password" autoComplete="off" value={password} disabled={busy || showerBusy} onChange={e => setPassword(e.target.value)} />
      </label>
      <button disabled={busy || showerBusy} type="submit" className="primary-button gate-submit">
        {busy
          ? (pairPhase === 'connecting' ? t('连接中…', 'Connecting…') : t('配对中…', 'Pairing…'))
          : pairForce ? t('重新配对', 'Re-pair') : t('配对并连接', 'Pair and connect')}
      </button>
      <details className="gate-advanced">
        <summary>{t('本机名称与证书', 'Computer name and certificate')}</summary>
        <div className="gate-advanced-fields">
          <label className="gate-field">
            <span>{t('本机名称（可选）', 'Computer name (optional)')}</span>
            <input maxLength={64} value={pairName} disabled={busy || showerBusy} onChange={e => setPairName(e.target.value)} />
          </label>
          <label className="gate-field">
            <span>{t('自签 CA 证书（可选）', 'Self-signed CA certificate (optional)')}</span>
            <textarea value={ca} disabled={busy || showerBusy} onChange={e => setCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" rows={4} />
          </label>
        </div>
      </details>
    </form>
  );

  /** 已配对的本机 Host：把它的身份直接交给客户端，免去任何输入。 */
  // 配对流程进行中（或刚失败、步骤还显示着）不出现：此时 Host 虽已变成“已配对”，提示“无需再输入”只会误导。
  const localConnect = hostAvailable && pairedHost && !showPairSteps && (
    <div className="gate-local">
      {localBusy ? (
        <p className="gate-hint" role="status">
          {t('正在使用本机身份连接', 'Connecting with this computer’s identity')}
          {pairedHostLabel ? ` · ${pairedHostLabel}` : ''}…
        </p>
      ) : (
        <button type="button" className="primary-button gate-submit" disabled={busy || showerBusy} onClick={() => void connectLocal()}>
          {t('用本机身份连接', 'Connect with this computer’s identity')}
          {pairedHostLabel ? ` · ${pairedHostLabel}` : ''}
        </button>
      )}
      <p className="gate-hint">{t('本机已配对，无需再输入。也可以粘贴新的配对码。', 'This computer is already paired. You can also paste a new pairing code.')}</p>
    </div>
  );

  /** 内置 Host 状态读取中：不渲染任何表单，避免先闪一下手动连接再切换。 */
  const hostPending = host === undefined || !polled;
  const primary = hostPending
    ? <p className="gate-hint" role="status">{t('正在读取本机状态…', 'Checking this computer…')}</p>
    : hostAvailable
      ? <>{localConnect}{pairCodeForm}</>
      : manualForm;

  return (
    <main className="desktop-shell gate-shell">
      <section className="gate-card">
        <div className="gate-hero">
          <GrokBotAvatar preset={JARVIS_AVATAR_PRESET} busy={connecting} size={72} />
          <h1>{t('连接 pibot 中心', 'Connect to pibot Center')}</h1>
          <p className="gate-subtitle">
            {hostAvailable
              ? t('在中心管理页添加设备并粘贴配对码，本机将自动注册并在后台运行 Host', 'Add a device on the center’s admin page and paste the pairing code; this computer registers itself and runs the Host in the background')
              : t('统一管理多端智能体、模型、插件与记忆', 'Manage agents, models, plugins and memory across devices')}
          </p>
        </div>
        {primary}
        {pairProgress}
        <ErrorNotice
          {...(typeof error === 'string' ? { error } : error)}
          onDismiss={() => setError('')}
          actionLabel={canRetryPaired ? t('重试连接', 'Retry connection') : undefined}
          onAction={canRetryPaired ? retryPaired : undefined}
        />
        <details className="gate-advanced">
          <summary>{t('其他连接方式', 'Other ways to connect')}</summary>
          <div className="gate-advanced-fields">
            {hostAvailable && (
              <details className="gate-advanced">
                <summary>{t('使用所有者密码配对', 'Pair with the owner password')}</summary>
                {passwordForm}
              </details>
            )}
            {hostAvailable && (
              <details className="gate-advanced">
                <summary>{t('使用已有设备 ID 和令牌', 'Use an existing device ID and token')}</summary>
                {manualForm}
              </details>
            )}
            {showPair && host?.platform === 'windows' && (
              <div className="gate-shower">
                <button
                  type="button"
                  className="secondary-button gate-manage"
                  disabled={busy || showerBusy}
                  onClick={() => void setupShower()}
                >
                  {showerBusy ? t('等待授权或配置中…', 'Awaiting approval or configuring…') : t('配置原生虚拟屏', 'Configure native virtual display')}
                </button>
                <p className="gate-hint">
                  {t('供桌面智能体在独立虚拟屏中运行；需要管理员授权与本机凭据，若本机 Host 已运行会短暂暂停。', 'Lets desktop agents run in a separate virtual display; needs admin approval and local credentials, and briefly pauses a running local Host.')}
                </p>
                {showerOutcome && (
                  <p className={showerOutcome.ok ? 'gate-shower-result ok' : 'gate-shower-result error'} role="status">
                    {showerOutcome.text}
                  </p>
                )}
              </div>
            )}
            <button type="button" className="secondary-button gate-manage" disabled={busy} onClick={() => void probe()}>
              {t('检查连接', 'Check connection')}
            </button>
            <button
              type="button"
              className="secondary-button gate-manage"
              disabled={!managementUrl}
              onClick={() => void invoke('desktop_open_center', { url: managementUrl }).catch((e) => setError(t('无法打开中心管理页面。', 'Could not open the center management page.') + ' ' + errorText(e)))}
            >
              <ExternalLink size={14} />
              {t('在浏览器打开中心管理', 'Open center management in browser')}
            </button>
            {status?.clientId && (
              <div className="gate-client-id">
                <span className="gate-client-label">{t('本客户端标识', 'Client ID')}</span>
                <code>{status.clientId}</code>
                <button type="button" className="icon-button" onClick={copyClientId} title={t('复制', 'Copy')}>
                  <Copy size={14} />
                </button>
                {copied && <span className="gate-copied">{t('已复制', 'Copied')}</span>}
              </div>
            )}
          </div>
        </details>
      </section>
    </main>
  );
}

export async function openCenterManagement(centerUrl?: string): Promise<void> {
  const url = centerUrl || localStorage.getItem('center-url');
  if (url) await invoke('desktop_open_center', { url });
}
