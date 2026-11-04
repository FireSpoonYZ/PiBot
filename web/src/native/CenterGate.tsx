import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BotHost, openCenterUrl } from './index';
import { mobileClientRequest } from './tauri-host';

export type SavedConnection = { url: string; deviceId: string; ca: string };
export type CenterStatus = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; clientId?: string; savedConnection?: SavedConnection; savedConnectionError?: string; brokerGeneration?: number; error?: { code?: string; message?: string } | string | null };
const permanentCenterErrors = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED', 'CONTROL_UNAUTHORIZED', 'INVALID_ARGUMENT', 'INVALID_CREDENTIALS', 'CREDENTIALS_NOT_FOUND', 'INVALID_TOKEN', 'REVOKED', 'CREDENTIALS', 'CERTIFICATE_ERROR', 'CERTIFICATE_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']);
const transientCenterErrors = new Set(['NOT_CONNECTED', 'DISCONNECTED', 'EVENT_STREAM_CLOSED', 'RPC_BUSY', 'BUSY', 'TIMEOUT', 'TRANSPORT_RESET', 'CENTER_OFFLINE', 'CENTER_REQUEST_FAILED']);
const centerErrorCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
export const isTransientCenterError = (error: unknown) => transientCenterErrors.has(centerErrorCode(error));
/** RPC 拥塞：host 忙不是断线，轮询应保留已确认状态继续等待，不得当离线处理。 */
const isBusyCenterError = (error: unknown) => { const code = centerErrorCode(error); return code === 'RPC_BUSY' || code === 'BUSY'; };
const centerErrorMessage = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';

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
  ready: boolean;
  matchesSaved: boolean;
  error: string;
  setError: (v: string) => void;
  connect: (event?: FormEvent) => Promise<void>;
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
  ready: false,
  matchesSaved: false,
  error: '',
  setError: () => {},
  connect: async () => {},
  disconnect: () => {},
  openManagement: () => {},
  stopLocalHost: () => {},
};

export const CenterConnectionContext = createContext<CenterConnectionContextValue>(defaultCenterContext);
export const useCenterConnection = () => useContext(CenterConnectionContext);

export function CenterGate({ children, onDisconnected, onReady, recoveryEpoch = 0 }: { children: ReactNode; onDisconnected?: () => void; onReady?: (centerUrl: string) => Promise<void>; recoveryEpoch?: number }) {
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
  const [error, setError] = useState('');
  const [preparedCenter, setPreparedCenter] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [prepareRetry, setPrepareRetry] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const updateStatus = (next: CenterStatus) => {
      setStatus(next);
      setSaved(next.savedConnection);
      if (next.savedConnectionError) setError(next.savedConnectionError);
      else if (next.error && permanentCenterErrors.has(centerErrorCode(next.error))) setError(centerErrorMessage(next.error) || centerErrorCode(next.error));
      else if (next.state === 'connecting') setError('正在重连…');
    };
    const readStatus = async () => {
      const next = await mobileClientRequest<CenterStatus>('center_status', {});
      if (next.state !== 'ready') return next;
      const broker = await mobileClientRequest<{ phase: string; generation: number }>('status', {});
      return { ...next, state: broker.phase === 'connected' ? 'ready' as const : 'connecting' as const,
        brokerGeneration: broker.generation };
    };
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
        if (live && issued === epoch.current) setError('无法读取中心连接设置');
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
                setError(permanentCenterErrors.has(centerErrorCode(failure)) ? centerErrorMessage(failure) || centerErrorCode(failure) : '正在重连…');
              }
            } finally {
              autoConnection.current = null;
              if (live && attempt === epoch.current) setBusy(false);
            }
          }
        }
      } catch {
        if (live && issued === epoch.current) setError('无法读取中心连接状态');
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
    let retry: ReturnType<typeof setTimeout> | undefined;
    setPreparedCenter('');
    if (status?.state !== 'ready' || !onReady) { setPreparing(false); return; }
    const preparedKey = `${status.centerUrl}:${status.brokerGeneration ?? ''}`;
    setPreparing(true);
    onReady(status.centerUrl).then(() => {
      if (live) { setPreparedCenter(preparedKey); setError(''); }
    }, failure => {
      if (live) {
        const permanent = !isTransientCenterError(failure);
        setError(permanent ? centerErrorMessage(failure) || centerErrorCode(failure) : '正在重连…');
        if (!permanent) retry = setTimeout(() => setPrepareRetry(value => value + 1), 2000);
      }
    }).finally(() => { if (live) setPreparing(false); });
    return () => { live = false; if (retry) clearTimeout(retry); };
  }, [status?.state, status?.centerUrl, status?.brokerGeneration, onReady, prepareRetry, recoveryEpoch]);

  const connect = async (event?: FormEvent) => {
    event?.preventDefault();
    const issued = ++epoch.current;
    setBusy(true);
    setError('');
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
      if (issued === epoch.current) setError(failure instanceof Error ? failure.message : '连接失败，请检查中心设置。');
    } finally {
      if (issued === epoch.current) {
        setToken('');
        setHostToken('');
        setBusy(false);
      }
    }
  };

  const matchesSaved = Boolean(saved && saved.url === url.trim() && saved.deviceId === deviceId.trim() && saved.ca === ca.trim());
  const disconnect = () => {
    const issued = ++epoch.current;
    setBusy(true);
    setError('');
    const request = mobileClientRequest<CenterStatus>('center_disconnect', {});
    void request.then(next => {
      if (issued !== epoch.current) return;
      setSaved(undefined);
      setStatus(next);
    }).catch(failure => {
      if (issued === epoch.current) setError(failure instanceof Error ? failure.message : '断开连接失败，请重试。');
    }).finally(() => { if (issued === epoch.current) setBusy(false); });
  };

  const openManagement = () => {
    if (!url.trim()) return;
    void openCenterUrl(url.trim()).catch(() => setError('无法打开中心管理页面'));
  };

  const stopLocalHost = () => {
    void BotHost.stop().catch(failure => {
      setError(failure instanceof Error ? failure.message : '退出客户端失败');
    });
  };

  const ready = Boolean(status?.state === 'ready' && (!onReady || preparedCenter === `${status.centerUrl}:${status.brokerGeneration ?? ''}`));
  const connecting = Boolean(!initialized || busy || preparing || status?.state === 'connecting');
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
    ready,
    matchesSaved,
    error,
    setError,
    connect,
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
