import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BotHost, openCenterUrl, type PairCenterResult } from './index';
import { mobileClientRequest, pairCenter, pairCenterWithCode, repairCenterBinding } from './tauri-host';
import { splitErrorCode, useText } from '../ui';

export type SavedConnection = { url: string; deviceId: string; ca: string };
export type CenterStatus = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; clientId?: string; savedConnection?: SavedConnection; savedConnectionError?: string; brokerGeneration?: number; error?: { code?: string; message?: string } | string | null };
const permanentCenterErrors = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED', 'CONTROL_UNAUTHORIZED', 'INVALID_ARGUMENT', 'INVALID_CREDENTIALS', 'CREDENTIALS_NOT_FOUND', 'INVALID_TOKEN', 'REVOKED', 'CREDENTIALS', 'CERTIFICATE_ERROR', 'CERTIFICATE_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']);
const transientCenterErrors = new Set(['NOT_CONNECTED', 'DISCONNECTED', 'EVENT_STREAM_CLOSED', 'RPC_BUSY', 'BUSY', 'TIMEOUT', 'TRANSPORT_RESET', 'CENTER_OFFLINE', 'CENTER_REQUEST_FAILED']);
const centerErrorCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
export const isTransientCenterError = (error: unknown) => transientCenterErrors.has(centerErrorCode(error));
/** RPC 拥塞：host 忙不是断线，轮询应保留已确认状态继续等待，不得当离线处理。 */
const isBusyCenterError = (error: unknown) => { const code = centerErrorCode(error); return code === 'RPC_BUSY' || code === 'BUSY'; };

export const ActiveCenter = createContext('');

export interface CenterConnectionContextValue {
  url: string;
  setUrl: (v: string) => void;
  deviceId: string;
  setDeviceId: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  hostToken: string;
  setHostToken: (v: string) => void;
  ca: string;
  setCa: (v: string) => void;
  status?: CenterStatus;
  saved?: SavedConnection;
  initialized: boolean;
  busy: boolean;
  preparing: boolean;
  connecting: boolean;
  reconnecting: boolean;
  ready: boolean;
  matchesSaved: boolean;
  error: string;
  errorCode: string;
  setError: (v: string) => void;
  connect: (event?: FormEvent) => Promise<void>;
  /** C7 首启配对：owner 密码换设备绑定；成功返回 PairCenterResult（被更新操作取代时 undefined）。
      失败置 error 并重新抛出原始错误，调用方可按 error.code 区分 ALREADY_CONFIGURED 等可恢复原因。 */
  pair: (password: string, options?: { displayName?: string; force?: boolean }) => Promise<PairCenterResult | undefined>;
  /** 配对码配对（扫码或粘贴）：整串配对码交给原生，成功返回 PairCenterResult（被更新操作取代时 undefined）。
      失败重新抛出原始错误（带 code 与可操作的 message），由调用方的表单展示，不写入通用 error。 */
  pairWithCode: (code: string, options?: { displayName?: string; force?: boolean }) => Promise<PairCenterResult | undefined>;
  /** C7 失败恢复：用本机已存凭据重试本机绑定/连接（无密码、不注册新设备）；语义与 pair 相同。 */
  repair: () => Promise<PairCenterResult | undefined>;
  disconnect: () => void;
  openManagement: () => void;
  stopLocalHost: () => void;
}

const defaultCenterContext: CenterConnectionContextValue = {
  url: '',
  setUrl: () => {},
  deviceId: '',
  setDeviceId: () => {},
  token: '',
  setToken: () => {},
  hostToken: '',
  setHostToken: () => {},
  ca: '',
  setCa: () => {},
  initialized: true,
  busy: false,
  preparing: false,
  connecting: false,
  reconnecting: false,
  ready: false,
  matchesSaved: false,
  error: '',
  errorCode: '',
  setError: () => {},
  connect: async () => {},
  pair: async () => undefined,
  pairWithCode: async () => undefined,
  repair: async () => undefined,
  disconnect: () => {},
  openManagement: () => {},
  stopLocalHost: () => {},
};

export const CenterConnectionContext = createContext<CenterConnectionContextValue>(defaultCenterContext);
export const useCenterConnection = () => useContext(CenterConnectionContext);

export function CenterGate({ children, onDisconnected, onReady, recoveryEpoch = 0 }: { children: ReactNode; onDisconnected?: () => void; onReady?: (centerUrl: string) => Promise<void>; recoveryEpoch?: number }) {
  const text = useText();
  const textRef = useRef(text);
  textRef.current = text;
  const t = useCallback((zh: string, en: string) => textRef.current(zh, en), []);
  const [url, setUrl] = useState('');
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('center-client-device-id') ?? '');
  const [token, setToken] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [ca, setCa] = useState('');
  const [status, setStatus] = useState<CenterStatus>();
  const [saved, setSaved] = useState<SavedConnection>();
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const autoAttempted = useRef(false);
  const autoConnection = useRef<Promise<CenterStatus> | null>(null);
  const wasReady = useRef(false);
  const [error, setErrorState] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [autoReconnecting, setAutoReconnecting] = useState(false);
  const [prepareReconnecting, setPrepareReconnecting] = useState(false);
  const [preparedCenter, setPreparedCenter] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [prepareRetry, setPrepareRetry] = useState(0);

  const clearError = useCallback(() => {
    setErrorState('');
    setErrorCode('');
  }, []);

  const reportError = useCallback((failure: unknown, fallback: string) => {
    const parsed = splitErrorCode(failure);
    const message = parsed.message || fallback || parsed.code || '';
    const code = parsed.code && parsed.code !== message ? parsed.code : '';
    setErrorState(message);
    setErrorCode(code);
  }, []);

  const setError = useCallback((v: string) => {
    if (!v) {
      clearError();
      return;
    }
    reportError(v, v);
  }, [clearError, reportError]);

  const updateStatus = (next: CenterStatus) => {
    setStatus(next);
    setSaved(next.savedConnection);
    if (next.savedConnectionError) {
      setAutoReconnecting(false);
      reportError(next.savedConnectionError, t('已保存的连接凭据异常，请重新配置。', 'Saved connection credentials are invalid. Please reconfigure.'));
    } else if (next.error && permanentCenterErrors.has(centerErrorCode(next.error))) {
      setAutoReconnecting(false);
      reportError(next.error, t('中心连接失败，请检查中心设置。', 'Center connection failed. Check center settings.'));
    } else if (next.state === 'connecting') {
      setAutoReconnecting(false);
      clearError();
    } else if (next.state === 'ready') {
      setAutoReconnecting(false);
    } else if (!next.savedConnection) {
      setAutoReconnecting(false);
    }
  };
  const readStatus = async () => {
    const next = await mobileClientRequest<CenterStatus>('center_status', {});
    if (next.state !== 'ready') return next;
    const broker = await mobileClientRequest<{ phase: string; generation: number }>('status', {});
    return { ...next, state: broker.phase === 'connected' ? 'ready' as const : 'connecting' as const,
      brokerGeneration: broker.generation };
  };

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const issued = epoch.current;
      try {
        const next = await readStatus();
        if (live && issued === epoch.current) updateStatus(next);
      } catch (failure) {
        // BUSY/RPC_BUSY 只是 host 通道拥塞：保留上次已确认 status 继续轮询，不误判断线。
        if (!isBusyCenterError(failure) && live && issued === epoch.current) setStatus(undefined);
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    const initialize = async () => {
      const issued = epoch.current;
      try {
        const value = await BotHost.centerSettings();
        if (!live || issued !== epoch.current) return;
        setUrl(localStorage.getItem('active-center-url') ?? value.url);
        setCa(value.ca);
      } catch {
        if (live && issued === epoch.current) {
          reportError('', t('无法读取中心连接设置', 'Failed to load center connection settings'));
        }
      }
      if (!live || issued !== epoch.current) return;
      try {
        const next = await readStatus();
        if (!live || issued !== epoch.current) return;
        updateStatus(next);
        if (next.savedConnection) {
          const connection = next.savedConnection;
          setUrl(connection.url);
          setDeviceId(connection.deviceId);
          setCa(connection.ca);
          if (next.state === 'disconnected' && !autoAttempted.current && !next.savedConnectionError && !permanentCenterErrors.has(centerErrorCode(next.error))) {
            autoAttempted.current = true;
            autoConnection.current = mobileClientRequest<CenterStatus>('center_connect', {
              url: connection.url, deviceId: connection.deviceId, deviceToken: '',
              ...(connection.ca ? { ca: connection.ca } : {}),
            });
          }
          if (autoConnection.current && next.state !== 'ready') {
            const attempt = ++epoch.current;
            setBusy(true);
            try {
              await autoConnection.current;
              const connected = await readStatus();
              if (live && attempt === epoch.current) updateStatus(connected);
            } catch (failure) {
              if (live && attempt === epoch.current) {
                if (permanentCenterErrors.has(centerErrorCode(failure))) {
                  setAutoReconnecting(false);
                  reportError(failure, t('自动连接失败，请检查中心设置。', 'Auto-connect failed. Check center settings.'));
                } else {
                  clearError();
                  setAutoReconnecting(true);
                }
              }
            } finally {
              autoConnection.current = null;
              if (live && attempt === epoch.current) setBusy(false);
            }
          }
        }
      } catch {
        if (live && issued === epoch.current) {
          reportError('', t('无法读取中心连接状态', 'Failed to read center connection status'));
        }
      }
      if (live) {
        setBusy(false);
        setInitialized(true);
        timer = setTimeout(poll, 1000);
      }
    };
    void initialize();
    return () => { live = false; epoch.current += 1; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (wasReady.current && status?.state !== 'ready') onDisconnected?.();
    wasReady.current = status?.state === 'ready';
  }, [status, onDisconnected]);

  useEffect(() => {
    let live = true;
    const issued = epoch.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    if (status?.state !== 'ready' || !onReady) {
      setPreparedCenter('');
      setPreparing(false);
      setPrepareReconnecting(false);
      if (status?.state === 'ready') clearError();
      return;
    }
    const preparedKey = `${status.centerUrl}:${status.brokerGeneration ?? ''}`;
    const alreadyPrepared = preparedCenter === preparedKey;
    if (!alreadyPrepared) {
      setPreparedCenter('');
      setPreparing(true);
    }
    onReady(status.centerUrl).then(() => {
      if (live && issued === epoch.current) {
        setPreparedCenter(preparedKey);
        setPrepareReconnecting(false);
        clearError();
      }
    }, failure => {
      if (live && issued === epoch.current) {
        setPreparedCenter('');
        const permanent = !isTransientCenterError(failure);
        if (permanent) {
          setPrepareReconnecting(false);
          reportError(failure, t('中心连接初始化失败，请重试。', 'Failed to initialize center connection. Please retry.'));
        } else {
          clearError();
          setPrepareReconnecting(true);
          retry = setTimeout(() => setPrepareRetry(value => value + 1), 2000);
        }
      }
    }).finally(() => { if (live) setPreparing(false); });
    return () => { live = false; if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state, status?.centerUrl, status?.brokerGeneration, onReady, prepareRetry, recoveryEpoch]);

  const connect = async (event?: FormEvent) => {
    event?.preventDefault();
    const issued = ++epoch.current;
    setBusy(true);
    clearError();
    setAutoReconnecting(false);
    setPrepareReconnecting(false);
    setPreparedCenter('');
    setStatus(undefined);
    onDisconnected?.();
    try {
      if (hostToken.trim()) {
        await BotHost.saveCenterSettings({ input: {
          url: url.trim(), deviceToken: hostToken.trim(), ca: ca.trim(),
        } });
      }
      const next = await mobileClientRequest<CenterStatus>('center_connect', {
        url: url.trim(), deviceId: deviceId.trim(), deviceToken: token.trim(),
        ...(ca.trim() ? { ca: ca.trim() } : {}),
      });
      if (issued !== epoch.current) return;
      localStorage.setItem('center-client-device-id', deviceId.trim());
      localStorage.setItem('active-center-url', url.trim());
      setSaved(next.savedConnection);
      const broker = next.state === 'ready' ? await mobileClientRequest<{ phase: string; generation: number }>('status', {}) : undefined;
      if (issued !== epoch.current) return;
      setStatus(broker ? { ...next, state: broker.phase === 'connected' ? 'ready' : 'connecting', brokerGeneration: broker.generation } : next);
    } catch (failure) {
      if (issued === epoch.current) {
        reportError(failure, t('连接失败，请检查中心设置。', 'Connection failed. Check center settings.'));
      }
    } finally {
      if (issued === epoch.current) {
        setToken('');
        setHostToken('');
        setBusy(false);
      }
    }
  };

  // C7 owner 密码配对：原生负责登记设备、保存凭据并请求连接；这里只回填身份并立即刷新一次真实状态。
  const pair = async (password: string, options?: { displayName?: string; force?: boolean }): Promise<PairCenterResult | undefined> => {
    const issued = ++epoch.current;
    setBusy(true);
    clearError();
    setAutoReconnecting(false);
    setPrepareReconnecting(false);
    try {
      const result = await pairCenter({
        url: url.trim(),
        password,
        ...(options?.displayName ? { displayName: options.displayName } : {}),
        ...(ca.trim() ? { ca: ca.trim() } : {}),
        ...(options?.force ? { force: true } : {}),
      });
      if (issued !== epoch.current) return undefined;
      await adoptPairResult(result, issued);
      return result;
    } catch (failure) {
      if (issued === epoch.current) {
        reportError(failure, t('配对失败，请检查中心地址与密码。', 'Pairing failed. Check the center URL and password.'));
      }
      throw failure;
    } finally {
      if (issued === epoch.current) setBusy(false);
    }
  };

  // 配对码配对：地址、一次性密钥与私有 CA 都在码里，由原生解码并兑换。失败不写通用 error：
  // 通用归类见到“证书”二字会换成泛泛的“在设置里填写 CA”，把真正的处理办法盖住，所以由调用方的表单自己展示。
  const pairWithCode = async (code: string, options?: { displayName?: string; force?: boolean }): Promise<PairCenterResult | undefined> => {
    const issued = ++epoch.current;
    setBusy(true);
    clearError();
    setAutoReconnecting(false);
    setPrepareReconnecting(false);
    try {
      const result = await pairCenterWithCode({
        code,
        ...(options?.displayName ? { displayName: options.displayName } : {}),
        ...(options?.force ? { force: true } : {}),
      });
      if (issued !== epoch.current) return undefined;
      await adoptPairResult(result, issued);
      return result;
    } finally {
      if (issued === epoch.current) setBusy(false);
    }
  };

  // pair/repair 共用的结果回填：只写身份与既有 localStorage 键，并立即读一次真实 status；
  // connectionRequested 非就绪，连接建立仍交给既有轮询与状态效果处理。
  const adoptPairResult = async (result: PairCenterResult, issued: number) => {
    setUrl(result.centerUrl);
    setDeviceId(result.deviceId);
    localStorage.setItem('center-client-device-id', result.deviceId);
    localStorage.setItem('active-center-url', result.centerUrl);
    try {
      const next = await readStatus();
      if (issued === epoch.current) updateStatus(next);
    } catch {
      // 状态刷新失败由既有轮询兜底，不覆盖结果。
    }
  };

  // C7 已存绑定的失败恢复：原生复用安全凭据重试 Host/client 连接，不注册新设备。
  const repair = async (): Promise<PairCenterResult | undefined> => {
    const issued = ++epoch.current;
    setBusy(true);
    clearError();
    setAutoReconnecting(false);
    setPrepareReconnecting(false);
    try {
      const result = await repairCenterBinding();
      if (issued !== epoch.current) return undefined;
      await adoptPairResult(result, issued);
      return result;
    } catch (failure) {
      if (issued === epoch.current) {
        reportError(failure, t('修复绑定失败，请重试。', 'Failed to repair binding. Please retry.'));
      }
      throw failure;
    } finally {
      if (issued === epoch.current) setBusy(false);
    }
  };

  const matchesSaved = Boolean(saved && saved.url === url.trim() && saved.deviceId === deviceId.trim() && saved.ca === ca.trim());
  const disconnect = () => {
    const issued = ++epoch.current;
    setBusy(true);
    clearError();
    setAutoReconnecting(false);
    setPrepareReconnecting(false);
    const request = mobileClientRequest<CenterStatus>('center_disconnect', {});
    void request.then(next => {
      if (issued !== epoch.current) return;
      setSaved(undefined);
      setStatus(next);
    }).catch(failure => {
      if (issued === epoch.current) {
        reportError(failure, t('断开连接失败，请重试。', 'Failed to disconnect. Please retry.'));
      }
    }).finally(() => { if (issued === epoch.current) setBusy(false); });
  };

  const openManagement = () => {
    if (!url.trim()) return;
    void openCenterUrl(url.trim()).catch(() => {
      reportError('', t('无法打开中心管理页面', 'Failed to open center management page'));
    });
  };

  const stopLocalHost = () => {
    void BotHost.stop().catch(failure => {
      reportError(failure, t('退出客户端失败', 'Failed to quit client'));
    });
  };

  const ready = Boolean(status?.state === 'ready' && (!onReady || preparedCenter === `${status.centerUrl}:${status.brokerGeneration ?? ''}`));
  const reconnecting = Boolean(!error && (status?.state === 'connecting' || autoReconnecting || prepareReconnecting));
  const connecting = Boolean(!initialized || busy || preparing || reconnecting || status?.state === 'connecting');
  const activeCenterUrl = ready && status ? status.centerUrl : '';

  const contextValue: CenterConnectionContextValue = {
    url,
    setUrl,
    deviceId,
    setDeviceId,
    token,
    setToken,
    hostToken,
    setHostToken,
    ca,
    setCa,
    status,
    saved,
    initialized,
    busy,
    preparing,
    connecting,
    reconnecting,
    ready,
    matchesSaved,
    error,
    errorCode,
    setError,
    connect,
    pair,
    pairWithCode,
    repair,
    disconnect,
    openManagement,
    stopLocalHost,
  };

  return (
    <CenterConnectionContext.Provider value={contextValue}>
      <ActiveCenter.Provider value={activeCenterUrl}>
        {children}
      </ActiveCenter.Provider>
    </CenterConnectionContext.Provider>
  );
}
