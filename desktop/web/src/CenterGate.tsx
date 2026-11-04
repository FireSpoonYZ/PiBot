import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, ExternalLink } from 'lucide-react';
import { GrokBotAvatar, JARVIS_AVATAR_PRESET } from '../../../web/src/GrokBotAvatar';
import { ErrorNotice, errorText, useText } from '../../../web/src/ui';
import type { DesktopClientStatus } from '../../../host-core/desktop-client.js';
import { hostAdopt, hostErrorCode, hostErrorText, hostPair, hostStatus, type HostPairResult, type HostStatus } from './hostService';
import './CenterGate.css';

type SavedConnection = { url: string; deviceId: string; ca: string };
/** center_connect 入参；手动连接、自动重连与首次配对共用。 */
type ConnectInput = { url: string; deviceId: string; deviceToken: string; ca?: string };
/** 首次配对进度：pairing=启动器登录/注册/启动 Host（单次调用），connecting=客户端连接中心。 */
type PairPhase = 'idle' | 'pairing' | 'connecting';

/** 启动器错误码对应失败步骤：0 登录中心，1 注册设备，2 启动本机 Host。 */
const pairErrorStep = (code: string): number => {
  if (['OWNER_AUTH_FAILED', 'CENTER_UNREACHABLE', 'ALREADY_CONFIGURED', 'INVALID_ARGUMENT', 'HOST_LAUNCHER_MISSING'].includes(code)) return 0;
  if (code.includes('START') || code.includes('ENABLE') || code === 'TIMEOUT') return 2;
  return 1;
};
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
  /** 主密钥仅为输入态，提交即清空。 */
  const [password, setPassword] = useState('');
  const [pairName, setPairName] = useState('');
  const [pairForce, setPairForce] = useState(false);
  const [pairPhase, setPairPhase] = useState<PairPhase>('idle');
  const [pairFailedStep, setPairFailedStep] = useState<number>();
  const [adoptHost, setAdoptHost] = useState(true);
  /** 配对成功但客户端连接失败时保留凭据供“重试连接”，仅存内存。 */
  const pairedRef = useRef<HostPairResult | null>(null);
  const [canRetryPaired, setCanRetryPaired] = useState(false);
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

  const matchesSaved = Boolean(
    saved &&
    saved.url === url.trim() &&
    saved.deviceId === deviceId.trim() &&
    saved.ca === ca.trim(),
  );

  /** 首次运行：内置 Host 可用、未配对且客户端无已保存连接时显示配对表单；配对流程中保持显示。 */
  const firstRun = Boolean(host && !host.configured && !saved && polled);
  const showPair = firstRun || pairPhase !== 'idle' || pairFailedStep !== undefined;
  /** 手动连接时可让内置 Host 接管该设备：未配对，或已配对的正是同一设备（刷新令牌）。 */
  const offerAdopt = Boolean(host && (!host.configured || host.deviceId === deviceId.trim()));

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    epoch.current += 1;
    setBusy(true);
    setError('');
    setCanRetryPaired(false);
    const input: ConnectInput = { url: url.trim(), deviceId: deviceId.trim(), deviceToken: token.trim(), ca: ca.trim() };
    try {
      if (offerAdopt && adoptHost && input.deviceToken) {
        try {
          await hostAdopt({ centerUrl: input.url, deviceId: input.deviceId, deviceToken: input.deviceToken, centerCa: input.ca });
        } catch (e) {
          setError(
            t('本机 Host 接管失败；可取消勾选“同时在本机运行 Host”后仅连接客户端。', 'The local Host could not take over this device. Uncheck “Also run the Host on this computer” to connect the client only.') +
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
      setError(t('中心连接失败，请检查地址、设备身份、令牌与证书。', 'Failed to connect to the center. Check the address, device identity, token and certificate.') + ' ' + errorText(e));
    } finally {
      setToken('');
      setBusy(false);
    }
  };

  /** 配对完成后以启动器返回的设备凭据连接客户端（与手动连接同一路径）。 */
  const connectPaired = async (result: HostPairResult, attempt: number) => {
    setPairFailedStep(undefined);
    setCanRetryPaired(false);
    setPairPhase('connecting');
    try {
      await connectCenter(
        { url: result.centerUrl, deviceId: result.deviceId, deviceToken: result.deviceToken },
        () => attempt === epoch.current,
      );
      pairedRef.current = null;
    } catch (e) {
      setPairFailedStep(3);
      setUrl(result.centerUrl);
      setDeviceId(result.deviceId);
      setCanRetryPaired(true);
      setError(t('设备已配对，但客户端连接中心失败。', 'The device is paired, but the client could not connect to the center.') + ' ' + hostErrorText(e, t));
    } finally {
      setPairPhase('idle');
    }
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    const secret = password;
    setPassword('');
    const force = pairForce;
    const attempt = ++epoch.current;
    setBusy(true);
    setError('');
    setCanRetryPaired(false);
    setPairFailedStep(undefined);
    setPairPhase('pairing');
    try {
      let result: HostPairResult;
      try {
        result = await hostPair({ centerUrl: url.trim(), password: secret, displayName: pairName.trim(), force });
      } catch (e) {
        const code = hostErrorCode(e);
        setPairFailedStep(pairErrorStep(code));
        setPairPhase('idle');
        if (code === 'ALREADY_CONFIGURED') {
          setPairForce(true);
          setError(t('本机已配对过中心。重新输入主密钥并点击“重新配对”将覆盖现有配置。', 'This computer is already paired. Re-enter the master key and click “Re-pair” to replace the existing pairing.'));
        } else {
          setError(t('配对失败：', 'Pairing failed: ') + hostErrorText(e, t));
        }
        return;
      } finally {
        void refreshHost();
      }
      setPairForce(false);
      pairedRef.current = result;
      if (attempt !== epoch.current) {
        setPairPhase('idle');
        return;
      }
      await connectPaired(result, attempt);
    } finally {
      setBusy(false);
    }
  };

  const retryPaired = () => {
    const result = pairedRef.current;
    if (!result) return;
    const attempt = ++epoch.current;
    setBusy(true);
    setError('');
    void connectPaired(result, attempt).finally(() => setBusy(false));
  };

  const disconnectCenter = async () => {
    epoch.current += 1;
    const next = await request<CenterStatus>('center_disconnect');
    setStatus(next);
    setSaved(next.savedConnection);
  };

  if (status?.state === 'ready') {
    return (
      <CenterConnectionContext.Provider value={{ status, disconnectCenter }}>
        {children}
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

  const pairSteps = [
    t('登录中心', 'Sign in to center'),
    t('注册设备', 'Register device'),
    t('启动本机 Host', 'Start local Host'),
    t('连接', 'Connect'),
  ];
  const pairStepState = (index: number): 'pending' | 'active' | 'done' | 'error' => {
    if (pairFailedStep !== undefined) {
      if (index < pairFailedStep) return 'done';
      return index === pairFailedStep ? 'error' : 'pending';
    }
    if (pairPhase === 'pairing') return index <= 2 ? 'active' : 'pending';
    if (pairPhase === 'connecting') return index <= 2 ? 'done' : 'active';
    return 'pending';
  };
  const showPairSteps = pairPhase !== 'idle' || pairFailedStep !== undefined;

  const manualForm = (
    <form className="gate-form" onSubmit={connect}>
      <label className="gate-field">
        <span>{t('中心 HTTPS 地址', 'Center HTTPS URL')}</span>
        <input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://center.example.com" />
      </label>
      <label className="gate-field">
        <span>{t('设备身份', 'Device identity')}</span>
        <input required value={deviceId} onChange={e => setDeviceId(e.target.value)} />
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
          onChange={e => setToken(e.target.value)}
          placeholder={matchesSaved ? t('已保存凭据，留空使用已存令牌', 'Saved credentials — leave blank to reuse') : ''}
        />
      </label>
      <details className="gate-advanced">
        <summary>{t('高级 TLS / 自签 CA 证书（可选）', 'Advanced TLS / self-signed CA certificate (optional)')}</summary>
        <textarea value={ca} onChange={e => setCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" rows={4} />
      </details>
      {offerAdopt && (
        <label className="gate-check">
          <input type="checkbox" checked={adoptHost} onChange={e => setAdoptHost(e.target.checked)} />
          <span>{t('同时在本机运行 Host', 'Also run the Host on this computer')}</span>
        </label>
      )}
      <button disabled={busy} type="submit" className="primary-button gate-submit">
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
              ? t('输入中心地址与主密钥，本机将自动注册并在后台运行 Host', 'Enter the center URL and master key; this computer registers itself and runs the Host in the background')
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
              <label className="gate-field">
                <span>{t('中心地址', 'Center URL')}</span>
                <input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://center.example.com" />
              </label>
              <label className="gate-field">
                <span>{t('主密钥', 'Master key')}</span>
                <input required type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} />
              </label>
              <label className="gate-field">
                <span>{t('本机名称', 'Computer name')}</span>
                <input required maxLength={64} value={pairName} onChange={e => setPairName(e.target.value)} />
              </label>
              {showPairSteps && (
                <ol className="gate-steps" aria-live="polite">
                  {pairSteps.map((label, index) => (
                    <li key={label} className={`gate-step ${pairStepState(index)}`}>
                      <span className="gate-step-dot" aria-hidden />
                      {label}
                    </li>
                  ))}
                </ol>
              )}
              <button disabled={busy} type="submit" className="primary-button gate-submit">
                {busy
                  ? (pairPhase === 'connecting' ? t('连接中…', 'Connecting…') : t('配对中…', 'Pairing…'))
                  : pairForce ? t('重新配对', 'Re-pair') : t('配对并连接', 'Pair and connect')}
              </button>
            </form>
            <details className="gate-advanced">
              <summary>{t('高级：使用已有设备 ID 和令牌', 'Advanced: use an existing device ID and token')}</summary>
              {manualForm}
            </details>
          </>
        ) : manualForm}
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
