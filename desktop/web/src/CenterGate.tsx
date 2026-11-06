import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, ExternalLink } from 'lucide-react';
import { GrokBotAvatar, JARVIS_AVATAR_PRESET } from '../../../web/src/GrokBotAvatar';
import { ErrorNotice, errorText, useText } from '../../../web/src/ui';
import type { DesktopClientStatus } from '../../../host-core/desktop-client.js';
import { hostAdopt, hostControl, hostErrorCode, hostErrorText, hostPair, hostStatus, hostWarningText, type HostPairResult, type HostStatus } from './hostService';
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
type Props = { children: ReactNode; onDisconnected(): void };

const request = <T,>(op: string, params: object = {}) =>
  invoke<T>('desktop_request', { request: { op, params } });

/** RPC 拥塞（host 忙）不是断线：poll/probe 遇 BUSY 保留已确认 status 继续原节奏。 */
const isBusyCenterError = (error: unknown) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'RPC_BUSY' || code === 'BUSY';
};

type CenterConnection = { status: CenterStatus | undefined; disconnectCenter: () => Promise<void> };
const CenterConnectionContext = createContext<CenterConnection>({ status: undefined, disconnectCenter: () => Promise.resolve() });

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

export function CenterGate({ children, onDisconnected }: Props) {
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
  const [saved, setSaved] = useState<SavedConnection>();
  const [error, setError] = useState('');
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
  const [reconfigure, setReconfigure] = useState(false);
  const [pairPhase, setPairPhase] = useState<PairPhase>('idle');
  /** 配对四步真实状态；未进行配对时为 undefined。 */
  const [pairSteps, setPairSteps] = useState<StepState[]>();
  /** pair 返回的非致命告警（启动/自启失败等），逐条展示，不渲染全成功。 */
  const [pairWarnings, setPairWarnings] = useState<string[]>([]);
  /** 正在局部重试的步骤下标。 */
  const [retryingStep, setRetryingStep] = useState<number>();
  const [adoptHost, setAdoptHost] = useState(true);
  /** 配对成功后保留设备凭据与 CA，供步骤重试/连接重试，仅存内存。 */
  const pairedRef = useRef<PairedCreds | null>(null);
  const [canRetryPaired, setCanRetryPaired] = useState(false);
  /** Windows 原生虚拟屏配置（setup-shower）进度与结果。 */
  const [showerBusy, setShowerBusy] = useState(false);
  const [showerOutcome, setShowerOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const epoch = useRef(0);
  const autoAttempted = useRef(false);
  const wasReady = useRef(false);
  const lastProbeAt = useRef(0);
  const probeInFlight = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

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
    const issued = epoch.current;
    lastProbeAt.current = Date.now();
    try {
      const next = await readStatus({ probe: true });
      if (issued === epoch.current) {
        setStatus(next);
        setSaved(next.savedConnection);
      }
    } catch (failure) {
      if (!isBusyCenterError(failure) && issued === epoch.current) setStatus(undefined);
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
    localStorage.setItem('center-url', input.url);
    localStorage.setItem('center-device-id', input.deviceId);
    setStatus(next);
    setSaved(next.savedConnection);
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
      const issued = epoch.current;
      try {
        const next = await readStatus();
        if (live && issued === epoch.current) {
          setStatus(next);
          setSaved(next.savedConnection);
          if (next.savedConnection && !autoAttempted.current) {
            const conn = next.savedConnection;
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
        if (!isBusyCenterError(failure) && live && issued === epoch.current) setStatus(undefined);
      }
      if (live) setPolled(true);
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  // 窗口回到前台探测一次（节流 10s、单飞）：ready 也探测——休眠期 cached-ready 的
  // 半开连接只能靠 probe 暴露。broker 显式 disconnected 时不探，避免后台触发重连。
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || probeInFlight.current || Date.now() - lastProbeAt.current < 10000) return;
      probeInFlight.current = true;
      void (async () => {
        const issued = epoch.current;
        try {
          const cur = statusRef.current;
          if (cur?.state === 'ready') {
            try {
              const broker = await request<DesktopClientStatus>('status');
              if (issued !== epoch.current) return;
              if (broker.phase === 'disconnected') return;
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

  useEffect(() => {
    if (wasReady.current && status?.state !== 'ready') onDisconnected();
    wasReady.current = status?.state === 'ready';
  }, [status, onDisconnected]);

  // 连接成功后清理配对进度：断线回到连接页时应显示手动连接而非已完成的旧步骤。
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
  const showPair = firstRun || reconfigure || pairPhase !== 'idle' || pairSteps !== undefined;
  /** 手动连接时可让内置 Host 接管该设备：未配对，或已配对的正是同一设备（刷新令牌）。 */
  const hasHostConfiguration = Boolean(host && (host.configured || host.centerUrl || host.deviceId || host.configError));
  const offerAdopt = Boolean(host && (isNewHost(host) || matchesHostConnection(host, url, deviceId)));

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || showerBusy) return;
    epoch.current += 1;
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
      await connectCenter(input);
    } catch (e) {
      setStatus(undefined);
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
      if (attempt === epoch.current) setReconfigure(false);
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

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || showerBusy) return;
    // 冻结提交时输入：异步完成只认这份 URL/CA，busy 期间输入框已禁用。
    const frozenUrl = url.trim();
    const frozenCa = ca.trim();
    const frozenName = pairName.trim();
    const secret = password;
    setPassword('');
    const force = pairForce;
    const attempt = ++epoch.current;
    setBusy(true);
    setError('');
    setCanRetryPaired(false);
    setPairWarnings([]);
    setPairSteps(['active', 'pending', 'pending', 'pending']);
    setPairPhase('pairing');
    try {
      let result: HostPairResult;
      try {
        result = await hostPair({ centerUrl: frozenUrl, password: secret, displayName: frozenName, centerCa: frozenCa, force });
      } catch (e) {
        // hostPair 单次调用涵盖登记；失败统一标在登记步。
        setPairSteps(['error', 'pending', 'pending', 'pending']);
        setPairPhase('idle');
        if (hostErrorCode(e) === 'ALREADY_CONFIGURED') {
          setPairForce(true);
          setError(t('本机已配对过中心。重新输入所有者密码并点击“重新配对”将覆盖现有配置。', 'This computer is already paired. Re-enter the owner password and click “Re-pair” to replace the existing pairing.'));
        } else {
          setError(t('配对失败：', 'Pairing failed: ') + hostErrorText(e, t));
        }
        void refreshHost();
        return;
      }
      setPairForce(false);
      setPairWarnings((result.warnings ?? []).map(hostWarningText));
      const paired: PairedCreds = { result, ca: frozenCa, saved: result.clientCredentialsSaved === true };
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

  const retryPaired = () => {
    const paired = pairedRef.current;
    if (!paired || busy || showerBusy) return;
    const attempt = ++epoch.current;
    setBusy(true);
    setError('');
    void connectPaired(paired, attempt).finally(() => setBusy(false));
  };

  const disconnectCenter = async () => {
    epoch.current += 1;
    const next = await request<CenterStatus>('center_disconnect');
    setStatus(next);
    setSaved(next.savedConnection);
  };

  if (status?.state === 'ready') {
    const centerKey = status.centerUrl + '|' + (status.savedConnection?.deviceId ?? status.clientId);
    return (
      <CenterConnectionContext.Provider value={{ status, disconnectCenter }}>
        <ClientUpdateProvider request={desktopUpdateRequest} ready centerKey={centerKey}>
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
    t('登录后自动运行', 'Run automatically at login'),
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
          onChange={e => setToken(e.target.value)}
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

  return (
    <main className="desktop-shell gate-shell">
      <section className="gate-card">
        <div className="gate-hero">
          <GrokBotAvatar preset={JARVIS_AVATAR_PRESET} busy={connecting} size={72} />
          <h1>{t('连接 e-助手中心', 'Connect to e-Assistant Center')}</h1>
          <p className="gate-subtitle">
            {showPair
              ? t('输入中心地址与所有者密码，本机将自动注册并在后台运行 Host', 'Enter the center URL and owner password; this computer registers itself and runs the Host in the background')
              : t('统一管理多端智能体、模型、插件与记忆', 'Manage agents, models, plugins and memory across devices')}
          </p>
        </div>
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
        {showPair ? (
          <>
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
              <label className="gate-field">
                <span>{t('本机名称', 'Computer name')}</span>
                <input required maxLength={64} value={pairName} disabled={busy || showerBusy} onChange={e => setPairName(e.target.value)} />
              </label>
              <details className="gate-advanced">
                <summary>{t('高级 TLS / 自签 CA 证书（可选）', 'Advanced TLS / self-signed CA certificate (optional)')}</summary>
                <textarea value={ca} disabled={busy || showerBusy} onChange={e => setCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" rows={4} />
              </details>
              {showPairSteps && (
                <>
                  <ol className="gate-steps" aria-live="polite">
                    {pairStepLabels.map((label, index) => {
                      const state = pairStepState(index);
                      return (
                        <li key={label} className={`gate-step ${state}`}>
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
              )}
              <button disabled={busy || showerBusy} type="submit" className="primary-button gate-submit">
                {busy
                  ? (pairPhase === 'connecting' ? t('连接中…', 'Connecting…') : t('配对中…', 'Pairing…'))
                  : pairForce ? t('重新配对', 'Re-pair') : t('配对并连接', 'Pair and connect')}
              </button>
            </form>
            <details className="gate-advanced">
              <summary>{t('高级：使用已有设备 ID 和令牌', 'Advanced: use an existing device ID and token')}</summary>
              {manualForm}
            </details>
            {host?.platform === 'windows' && (
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
          </>
        ) : manualForm}
        {!showPair && hasHostConfiguration && (
          <button type="button" className="secondary-button gate-manage" disabled={busy} onClick={() => {
            setPairForce(true);
            setReconfigure(true);
            setPairSteps(undefined);
            setError('');
          }}>
            {t('重新配对本机 Host', 'Re-pair local Host')}
          </button>
        )}
        <button
          type="button"
          className="secondary-button gate-manage"
          disabled={busy}
          onClick={() => {
            if (status?.broker?.phase === 'disconnected' || status?.state === 'disconnected') {
              setError(t('已显式断开：请在上方重新连接中心。', 'Explicitly disconnected — reconnect above.'));
              return;
            }
            void probe();
          }}
        >
          {t('检查连接', 'Check connection')}
        </button>
        <button
          type="button"
          className="secondary-button gate-manage"
          disabled={!url}
          onClick={() => void invoke('desktop_open_center', { url: url.trim() }).catch((e) => setError(t('无法打开中心管理页面。', 'Could not open the center management page.') + ' ' + errorText(e)))}
        >
          <ExternalLink size={14} />
          {t('在浏览器打开中心管理', 'Open center management in browser')}
        </button>
        <ErrorNotice
          error={error}
          onDismiss={() => setError('')}
          actionLabel={canRetryPaired ? t('重试连接', 'Retry connection') : undefined}
          onAction={canRetryPaired ? retryPaired : undefined}
        />
      </section>
    </main>
  );
}

export function openCenterManagement() {
  const url = localStorage.getItem('center-url');
  if (url) void invoke('desktop_open_center', { url });
}
