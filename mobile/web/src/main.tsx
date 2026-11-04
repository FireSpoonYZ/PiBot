// Android Tauri 主界面入口：统一承载极简 Bot Hub（置顶主 Bot + 本机/远程统一 Bot 列表 + 左右隐藏侧边栏）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopClientStatus } from '../../../host-core/desktop-client';
import { HashRouter } from 'react-router-dom';
import { HostPage } from '../../../web/src/Host';
import { CenterGate, isTransientCenterError, type CenterStatus } from '../../../web/src/native/CenterGate';
import { ErrorNotice, LanguageOverride, errorText } from '../../../web/src/ui';
import {
  mobileHide,
  mobileLocalRequest,
  mobileUiSettings,
  mobileClientRequest,
  mobileReconnect,
  onMobileStreamFailure,
  type MobileUiSettings,
} from '../../../web/src/native/tauri-host';
import { createMobileRemoteClient, type MobileRemoteClient } from './remote-client';
import '../../../web/src/styles.css';
import './mobile.css';
import '../../../web/src/hub/lanes.css';

const applyUi = (ui: MobileUiSettings) => {
  document.documentElement.dataset.theme = ui.appearance;
  document.documentElement.lang = ui.language === 'system' ? navigator.language : ui.language;
};

function MobileShell() {
  const [ui, setUi] = useState<MobileUiSettings>({ language: 'system', appearance: 'system' });
  const [notice, setNotice] = useState('');
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [adoptEpoch, setAdoptEpoch] = useState(0);
  const adopting = useRef<Promise<void> | null>(null);
  const adoptedGeneration = useRef<number | undefined>(undefined);
  const repairIpc = useRef<(() => Promise<void>) | null>(null);
  const connectionRevision = useRef(0);
  const recoverConnection = useRef<() => Promise<void>>(async () => {});
  const checkConnection = useCallback(() => recoverConnection.current(), []);
  const scheduleAdopt = useRef<() => void>(() => {});
  const unsubscribeRemote = useRef<(() => void) | undefined>(undefined);
  const remoteRef = useRef<MobileRemoteClient | undefined>(undefined);

  const centerDisconnected = useCallback(() => {
    connectionRevision.current += 1;
    adoptedGeneration.current = undefined;
    remoteRef.current?.invalidate();
  }, []);

  const getOrCreateRemoteClient = useCallback(() => {
    if (!remoteRef.current) {
      remoteRef.current = createMobileRemoteClient();
      const api = remoteRef.current.api;
      unsubscribeRemote.current = api.subscribe(() => { if (!api.transportConnected && !adopting.current) scheduleAdopt.current(); });
    }
    return remoteRef.current;
  }, []);

  const centerReady = useCallback((centerUrl: string): Promise<void> => {
    if (adopting.current) return adopting.current;
    const revision = connectionRevision.current;
    const run = (async () => {
      const client = getOrCreateRemoteClient();
      const status = await mobileClientRequest<DesktopClientStatus>('status', {});
      const connection = status.connection;
      if (status.phase !== 'connected' || connection?.kind !== 'relay') {
        throw Object.assign(new Error('中心已认证，但设备中继正在恢复。'), { code: 'NOT_CONNECTED' });
      }
      const api = client.api;
      if (api.transportConnected && adoptedGeneration.current === status.generation) return;
      client.invalidate();
      let snapshot = await api.init();
      let profile = snapshot.state.profiles.find(p => p.kind === 'relay' &&
        p.url === connection.url && p.deviceId === connection.deviceId);
      if (!profile) {
        const next = { id: crypto.randomUUID(), title: new URL(centerUrl).host,
          kind: 'relay' as const, url: connection.url, deviceId: connection.deviceId };
        snapshot = await api.queueWrite(state => ({ ...state, profiles: [...state.profiles, next] }));
        profile = snapshot.state.profiles.find(p => p.id === next.id)!;
      }
      const latest = await mobileClientRequest<DesktopClientStatus>('status', {});
      if (revision !== connectionRevision.current || latest.generation !== status.generation || latest.phase !== 'connected') {
        throw Object.assign(new Error('设备连接已变化，正在恢复。'), { code: 'NOT_CONNECTED' });
      }
      api.setIdentity({ profileId: profile.id, targetDeviceId: '', kind: 'relay' });
      api.setTransportConnected(true);
      adoptedGeneration.current = status.generation;
      setNotice('');
    })();
    adopting.current = run;
    const settled = () => { if (adopting.current === run) adopting.current = null; };
    void run.then(() => {
      settled();
      if (remoteRef.current && !remoteRef.current.api.transportConnected) scheduleAdopt.current();
    }, settled);
    return run;
  }, [getOrCreateRemoteClient]);

  useEffect(() => {
    let live = true;
    mobileUiSettings().then(
      next => {
        if (!live) return;
        applyUi(next);
        setUi(next);
      },
      error => {
        if (live) setNotice(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    let flight: Promise<void> | null = null;
    let failedAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const attempt = (): Promise<void> => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (flight) return flight;
      const run = (async () => {
        try {
          failedAgain = false;
          const result = await mobileReconnect();
          if (!result.connected || failedAgain) throw Object.assign(new Error('IPC unavailable'), { code: 'NOT_CONNECTED' });
          if (!live) return;
          repairIpc.current = null;
          delay = 500;
          setConnectionEpoch(value => value + 1);
        } catch (error) {
          if (!live) return;
          timer = setTimeout(() => { void attempt().catch(() => {}); }, delay);
          delay = Math.min(delay * 2, 10000);
          throw error;
        }
      })();
      flight = run;
      const settled = () => { flight = null; };
      void run.then(settled, settled);
      return run;
    };
    const recover = () => {
      if (!live) return;
      if (repairIpc.current) { failedAgain = true; return; }
      centerDisconnected();
      setNotice('正在重连…');
      repairIpc.current = attempt;
      void attempt().catch(() => {});
    };
    const stop = onMobileStreamFailure(recover);
    return () => { live = false; repairIpc.current = null; stop(); if (timer) clearTimeout(timer); };
  }, [centerDisconnected]);
  useEffect(() => {
    let live = true;
    let flight: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const schedule = () => {
      if (!live || document.hidden || timer) return;
      timer = setTimeout(() => { timer = undefined; void check().catch(() => {}); }, delay);
      delay = Math.min(delay * 2, 10000);
    };
    const check = (): Promise<void> => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (flight) return flight;
      const revision = connectionRevision.current;
      const previousGeneration = adoptedGeneration.current;
      const wasConnected = remoteRef.current?.api.transportConnected;
      let retry = false;
      const run = (async () => {
        try {
          await repairIpc.current?.();
          if (!live || revision !== connectionRevision.current) return;
          const center = await mobileClientRequest<CenterStatus>('center_status', { probe: true });
          if (!live || revision !== connectionRevision.current) return;
          if (center.state === 'ready') {
            await centerReady(center.centerUrl);
            if (!live || revision !== connectionRevision.current) return;
            if (!wasConnected || previousGeneration !== adoptedGeneration.current) setAdoptEpoch(value => value + 1);
            setNotice('');
            delay = 1000;
          } else {
            if (remoteRef.current?.api.transportConnected) centerDisconnected();
            retry = center.state === 'connecting';
            setNotice(retry ? '正在重连…' : center.savedConnectionError || (center.error ? errorText(center.error) : ''));
          }
        } catch (error) {
          if (!live || revision !== connectionRevision.current) return;
          retry = isTransientCenterError(error);
          setNotice(retry ? '正在重连…' : errorText(error));
          throw error;
        }
      })();
      flight = run;
      const settled = () => {
        flight = null;
        if (retry) schedule();
      };
      void run.then(settled, settled);
      return run;
    };
    // 用户操作跳过退避；已经在执行的检查由前台恢复与下拉刷新共用。
    recoverConnection.current = () => { delay = 1000; return check(); };
    scheduleAdopt.current = schedule;
    const foreground = () => {
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = undefined; }
      } else {
        void recoverConnection.current().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      live = false;
      connectionRevision.current += 1;
      recoverConnection.current = async () => {};
      scheduleAdopt.current = () => {};
      document.removeEventListener('visibilitychange', foreground);
      if (timer) clearTimeout(timer);
    };
  }, [centerReady, centerDisconnected]);
  useEffect(() => () => { unsubscribeRemote.current?.(); remoteRef.current?.dispose(); }, []);

  return (
    <LanguageOverride.Provider value={ui.language}>
      <div className="mobile-shell">
        <div className="mobile-body">
          <CenterGate onDisconnected={centerDisconnected} onReady={centerReady} recoveryEpoch={connectionEpoch + adoptEpoch}><HostPage
            onBack={() => void mobileHide()}
            persistentPending
            connectionEpoch={connectionEpoch}
            active
            getOrCreateRemoteClient={getOrCreateRemoteClient}
            onRefreshConnection={checkConnection}
            onOpenSystemSettings={() => void mobileLocalRequest('openSystemSettings').catch(error => setNotice(errorText(error)))}
          /></CenterGate>
        </div>
        <ErrorNotice error={notice} compact onDismiss={() => setNotice('')} />
      </div>
    </LanguageOverride.Provider>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
createRoot(container).render(
  <HashRouter>
    <MobileShell />
  </HashRouter>,
);
