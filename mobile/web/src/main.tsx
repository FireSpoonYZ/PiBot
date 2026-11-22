// Android Tauri 主界面入口：统一承载极简 Bot Hub（置顶主 Bot + 本机/远程统一 Bot 列表 + 左右隐藏侧边栏）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopClientStatus } from '../../../host-core/desktop-client';
import { HashRouter } from 'react-router-dom';
import { HostPage } from '../../../web/src/Host';
import { CenterGate, isTransientCenterError, useCenterConnection, type CenterStatus } from '../../../web/src/native/CenterGate';
import { LanguageOverride, errorText, humanizeError, useText } from '../../../web/src/ui';
import { NoticeProvider, useNotice } from '../../../web/src/notice';
import { ConnectionPhaseProvider } from '../../../web/src/connection';
import { ClientUpdateProvider } from '../../../web/src/ClientUpdateProvider';
import type { ClientUpdateOp, ClientUpdateParams, ClientUpdateStatus } from '../../../web/src/ClientUpdate';
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

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const UI_THEME_STORAGE_KEY = 'pibot.ui-theme.v1';
const UI_LANGUAGE_STORAGE_KEY = 'pibot.ui-language.v1';
const SAFE_AREA_STORAGE_KEY = 'pibot.safe-area-insets.v1';
const REMOTE_BOTS_CACHE_KEY = 'bot-hub-remote-bots-cache-v1';
const MOBILE_SHELL_NOTICE_ID = 'mobile-shell-notice';

const darkMediaQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_SCHEME_QUERY)
    : null;

const normalizeAppearance = (value: unknown): MobileUiSettings['appearance'] =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'system';

const normalizeLanguage = (value: unknown): MobileUiSettings['language'] =>
  value === 'zh' || value === 'en' || value === 'system' ? value : 'system';

const readCachedUiSettings = (): MobileUiSettings => {
  try {
    return {
      language: normalizeLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)),
      appearance: normalizeAppearance(localStorage.getItem(UI_THEME_STORAGE_KEY)),
    };
  } catch {
    return { language: 'system', appearance: 'system' };
  }
};

const writeCachedUiSettings = (ui: MobileUiSettings) => {
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, ui.appearance);
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, ui.language);
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
};

const readHasCachedRemoteBots = (): boolean => {
  try {
    const raw = localStorage.getItem(REMOTE_BOTS_CACHE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
};

const THEME_COLOR_LIGHT = '#F7F6F2';
const THEME_COLOR_DARK = '#141614';

const resolveTheme = (appearance: MobileUiSettings['appearance']): 'light' | 'dark' => {
  if (appearance === 'dark' || appearance === 'light') return appearance;
  return darkMediaQuery()?.matches ? 'dark' : 'light';
};

const syncMetaThemeColor = (resolved: 'light' | 'dark') => {
  if (typeof document === 'undefined') return;
  const color = resolved === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head?.appendChild(meta);
  }
  if (meta.getAttribute('content') !== color) {
    meta.setAttribute('content', color);
  }
};

const applyTheme = (appearance: MobileUiSettings['appearance']) => {
  const resolved = resolveTheme(appearance);
  document.documentElement.dataset.themePref = appearance;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  syncMetaThemeColor(resolved);
};

const applyUi = (ui: MobileUiSettings) => {
  applyTheme(ui.appearance);
  document.documentElement.lang = ui.language === 'system' ? navigator.language : ui.language;
};

const hydrateCachedSafeArea = () => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.insetsReady === '1') return;
  try {
    const raw = localStorage.getItem(SAFE_AREA_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { top?: unknown; bottom?: unknown };
    if (
      typeof parsed?.top === 'number' &&
      Number.isFinite(parsed.top) &&
      parsed.top >= 0 &&
      typeof parsed?.bottom === 'number' &&
      Number.isFinite(parsed.bottom) &&
      parsed.bottom >= 0
    ) {
      root.style.setProperty('--safe-area-inset-top', `${Math.round(parsed.top)}px`);
      root.style.setProperty('--safe-area-inset-bottom', `${Math.round(parsed.bottom)}px`);
      root.style.setProperty('--ime-bottom', '0px');
      root.dataset.insetsReady = '1';
    }
  } catch {
    // Ignore malformed or inaccessible safe-area cache.
  }
};

// 模块顶层同步兜底应用缓存主题、语言与安全区，与 index.html 同步启动脚本互补。
applyUi(readCachedUiSettings());
hydrateCachedSafeArea();

const readImeBottomCssPx = (): number => {
  if (typeof document === 'undefined') return 0;
  const raw = document.documentElement.style.getPropertyValue('--ime-bottom').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isEditableField = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    return (
      type !== 'checkbox' &&
      type !== 'radio' &&
      type !== 'button' &&
      type !== 'submit' &&
      type !== 'reset' &&
      type !== 'range' &&
      type !== 'file' &&
      type !== 'hidden'
    );
  }
  return el.isContentEditable;
};

/** F3：WebView 不再随软键盘缩放后，监听 --ime-bottom 增长与 focusin，确保表单输入框滚入可视区，
 *  并兜底归零外层文档与未缩放 visualViewport 的纵向偏移，杜绝与 --ime-bottom 叠加形成双倍上移。 */
function useImeFocusScrollIntoView() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let lastImeBottom = readImeBottomCssPx();
    let rafId = 0;

    const resetRootViewportScroll = () => {
      const vv = window.visualViewport;
      if (vv && Number.isFinite(vv.scale) && vv.scale > 1.01) return;
      const docEl = document.documentElement;
      const body = document.body;
      if (
        window.scrollY !== 0 ||
        window.scrollX !== 0 ||
        (docEl && (docEl.scrollTop !== 0 || docEl.scrollLeft !== 0)) ||
        (body && (body.scrollTop !== 0 || body.scrollLeft !== 0)) ||
        (vv && (vv.offsetTop > 0 || vv.offsetLeft > 0))
      ) {
        if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
        if (docEl) {
          docEl.scrollTop = 0;
          docEl.scrollLeft = 0;
        }
        if (body) {
          body.scrollTop = 0;
          body.scrollLeft = 0;
        }
      }
    };

    const scheduleScroll = (preferredTarget?: Element | null) => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        resetRootViewportScroll();
        const activeEl =
          preferredTarget && preferredTarget.isConnected
            ? preferredTarget
            : document.activeElement;
        if (!isEditableField(activeEl)) return;
        // 聊天输入区与主页底栏已紧贴 #root 的 --ime-bottom 底部让位上方，无需 scrollIntoView。
        if (activeEl.closest('.grok-chat-composer-area, .hub-bottom-bar')) return;
        if (typeof activeEl.scrollIntoView === 'function') {
          activeEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          resetRootViewportScroll();
        }
      });
    };

    const onImeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ imeBottom?: unknown }>).detail;
      const nextIme =
        typeof detail?.imeBottom === 'number' && Number.isFinite(detail.imeBottom)
          ? Math.max(0, detail.imeBottom)
          : readImeBottomCssPx();
      const increased = nextIme > lastImeBottom;
      lastImeBottom = nextIme;
      resetRootViewportScroll();
      if (increased && nextIme > 0) {
        scheduleScroll();
      }
    };

    const onInsetsReady = (event: Event) => {
      const detail = (event as CustomEvent<{ imeBottom?: unknown }>).detail;
      if (typeof detail?.imeBottom === 'number' && Number.isFinite(detail.imeBottom)) {
        lastImeBottom = Math.max(0, detail.imeBottom);
      } else {
        lastImeBottom = readImeBottomCssPx();
      }
      resetRootViewportScroll();
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (!isEditableField(target)) return;
      resetRootViewportScroll();
      const currentIme = Math.max(lastImeBottom, readImeBottomCssPx());
      if (currentIme > 0) {
        scheduleScroll(target);
      }
    };

    const vv = window.visualViewport;
    window.addEventListener('pibot:ime-change', onImeChange);
    window.addEventListener('pibot:insets-ready', onInsetsReady);
    document.addEventListener('focusin', onFocusIn);
    vv?.addEventListener('scroll', resetRootViewportScroll);
    vv?.addEventListener('resize', resetRootViewportScroll);
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      window.removeEventListener('pibot:ime-change', onImeChange);
      window.removeEventListener('pibot:insets-ready', onInsetsReady);
      document.removeEventListener('focusin', onFocusIn);
      vv?.removeEventListener('scroll', resetRootViewportScroll);
      vv?.removeEventListener('resize', resetRootViewportScroll);
    };
  }, []);
}

/** G1 桥接：把外壳级错误路由到 F1 浮层 NoticeLayer（同 id 原地更新，零布局位移）。 */
function MobileShellNoticeBridge({ text, seq }: { text: string; seq: number }) {
  const { notify, dismiss } = useNotice();
  const t = useText();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      dismiss(MOBILE_SHELL_NOTICE_ID);
      return;
    }
    const humanized = humanizeError(trimmed, tRef.current);
    const title = humanized?.title || trimmed;
    const detailParts = [humanized?.description, humanized?.detail].filter(Boolean);
    notify({
      id: MOBILE_SHELL_NOTICE_ID,
      tone: 'error',
      title,
      detail: detailParts.length > 0 ? detailParts.join('\n') : undefined,
    });
  }, [text, seq, notify, dismiss]);

  useEffect(() => () => { dismiss(MOBILE_SHELL_NOTICE_ID); }, [dismiss]);

  return null;
}

/** F2：在 CenterGate 内挂载统一连接状态机，合并 IPC/中心/远端状态供 HostPage 及子页读取。 */
function MobileConnectionPhaseBoundary({
  ipcReconnecting,
  centerReconnecting,
  remoteConnected,
  detail,
  children,
}: {
  ipcReconnecting: boolean;
  centerReconnecting: boolean;
  remoteConnected: boolean;
  detail: string | null;
  children: ReactNode;
}) {
  const conn = useCenterConnection();
  const [hasCachedRemoteBots, setHasCachedRemoteBots] = useState<boolean>(() => readHasCachedRemoteBots());

  useEffect(() => {
    setHasCachedRemoteBots(readHasCachedRemoteBots());
  }, [conn.ready, conn.hasSavedCenter, remoteConnected]);

  return (
    <ConnectionPhaseProvider
      ipcReconnecting={ipcReconnecting}
      centerReconnecting={centerReconnecting || conn.reconnecting}
      centerConnecting={conn.connecting}
      centerReady={conn.ready}
      centerError={conn.error || null}
      hasConfiguredCenter={conn.hasSavedCenter}
      hasCachedRemoteBots={hasCachedRemoteBots}
      remoteConnected={remoteConnected}
      detail={conn.error || detail}
    >
      {children}
    </ConnectionPhaseProvider>
  );
}

function MobileShell() {
  useImeFocusScrollIntoView();
  const [ui, setUi] = useState<MobileUiSettings>(() => readCachedUiSettings());
  const [noticeState, setNoticeState] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const noticeSeqRef = useRef(0);
  const setNotice = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setNoticeState(prev => (prev.text ? { text: '', seq: 0 } : prev));
      return;
    }
    noticeSeqRef.current += 1;
    setNoticeState({ text: trimmed, seq: noticeSeqRef.current });
  }, []);
  const [ipcReconnecting, setIpcReconnecting] = useState(false);
  const [centerReconnecting, setCenterReconnecting] = useState(false);
  const [remoteConnected, setRemoteConnected] = useState(false);
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
    setRemoteConnected(false);
    setCenterReconnecting(false);
  }, []);

  const getOrCreateRemoteClient = useCallback(() => {
    if (!remoteRef.current) {
      remoteRef.current = createMobileRemoteClient();
      const api = remoteRef.current.api;
      unsubscribeRemote.current = api.subscribe(() => {
        setRemoteConnected(api.transportConnected);
        if (!api.transportConnected && !adopting.current) scheduleAdopt.current();
      });
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
      setCenterReconnecting(false);
      setNotice('');
    })();
    adopting.current = run;
    const settled = () => { if (adopting.current === run) adopting.current = null; };
    void run.then(() => {
      settled();
      if (remoteRef.current && !remoteRef.current.api.transportConnected) scheduleAdopt.current();
    }, settled);
    return run;
  }, [getOrCreateRemoteClient, setNotice]);

  useEffect(() => {
    applyTheme(ui.appearance);
    if (ui.appearance !== 'system') return;
    const media = darkMediaQuery();
    if (!media) return;
    const onChange = () => {
      applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [ui.appearance]);

  useEffect(() => {
    let live = true;
    let seq = 0;
    const syncUi = (reportError: boolean) => {
      const current = ++seq;
      mobileUiSettings().then(
        raw => {
          if (!live || current !== seq) return;
          const next: MobileUiSettings = {
            language: normalizeLanguage(raw?.language),
            appearance: normalizeAppearance(raw?.appearance),
          };
          writeCachedUiSettings(next);
          applyUi(next);
          setUi(prev =>
            prev.language === next.language && prev.appearance === next.appearance ? prev : next,
          );
        },
        error => {
          if (live && current === seq && reportError) setNotice(errorText(error));
        },
      );
    };
    syncUi(connectionEpoch === 0);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncUi(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connectionEpoch, setNotice]);

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
          setIpcReconnecting(false);
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
      setIpcReconnecting(true);
      setNotice('');
      repairIpc.current = attempt;
      void attempt().catch(() => {});
    };
    const stop = onMobileStreamFailure(recover);
    return () => { live = false; repairIpc.current = null; stop(); if (timer) clearTimeout(timer); };
  }, [centerDisconnected, setNotice]);
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
            setCenterReconnecting(false);
            setNotice('');
            delay = 1000;
          } else {
            if (remoteRef.current?.api.transportConnected) centerDisconnected();
            retry = center.state === 'connecting';
            setCenterReconnecting(retry);
            setNotice(retry ? '' : center.savedConnectionError || (center.error ? errorText(center.error) : ''));
          }
        } catch (error) {
          if (!live || revision !== connectionRevision.current) return;
          retry = isTransientCenterError(error);
          setCenterReconnecting(retry);
          setNotice(retry ? '' : errorText(error));
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
  }, [centerReady, centerDisconnected, setNotice]);
  useEffect(() => () => { unsubscribeRemote.current?.(); remoteRef.current?.dispose(); }, []);

  return (
    <LanguageOverride.Provider value={ui.language}>
      <NoticeProvider>
        <MobileShellNoticeBridge text={noticeState.text} seq={noticeState.seq} />
        <div className="mobile-shell">
          <div className="mobile-body">
            <CenterGate onDisconnected={centerDisconnected} onReady={centerReady} recoveryEpoch={connectionEpoch + adoptEpoch}>
              <MobileConnectionPhaseBoundary
                ipcReconnecting={ipcReconnecting}
                centerReconnecting={centerReconnecting}
                remoteConnected={remoteConnected}
                detail={noticeState.text || null}
              >
                <MobileUpdateBoundary>
                  <HostPage
                    onBack={() => void mobileHide()}
                    persistentPending
                    connectionEpoch={connectionEpoch}
                    active
                    getOrCreateRemoteClient={getOrCreateRemoteClient}
                    onRefreshConnection={checkConnection}
                    onOpenSystemSettings={() => void mobileLocalRequest('openSystemSettings').catch(error => setNotice(errorText(error)))}
                  />
                </MobileUpdateBoundary>
              </MobileConnectionPhaseBoundary>
            </CenterGate>
          </div>
        </div>
      </NoticeProvider>
    </LanguageOverride.Provider>
  );
}

/** Android 更新命令适配：语义操作 → mobileLocalRequest update*（原生侧负责节流/验签/安装）。 */
const mobileUpdateRequest = (op: ClientUpdateOp, params?: ClientUpdateParams): Promise<ClientUpdateStatus> => {
  const method = 'update' + op[0].toUpperCase() + op.slice(1);
  return mobileLocalRequest<ClientUpdateStatus>(method, { ...(params ?? {}) });
};

/** CenterGate ready 后挂载更新 provider：centerKey 变化/断开即作废旧查询结果。 */
function MobileUpdateBoundary({ children }: { children: ReactNode }) {
  const conn = useCenterConnection();
  const ready = conn.ready;
  const centerKey = ready
    ? (conn.status?.centerUrl ?? '') + '|' + (conn.saved?.deviceId ?? conn.status?.clientId ?? '')
    : '';
  return (
    <ClientUpdateProvider request={mobileUpdateRequest} ready={ready} centerKey={centerKey} nativeCheck>
      {children}
    </ClientUpdateProvider>
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
