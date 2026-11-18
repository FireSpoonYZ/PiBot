import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Monitor, Moon, RefreshCw, Sun, WifiOff } from 'lucide-react';
import { CenterAdminPanel } from '../web/src/center-admin';
import type { CenterAdminTab } from '../web/src/center-admin';
import { api, webTransport } from './api';
import type { SetupStatus } from './api';
import { QrCode } from './components/QrCode';
import Login from './pages/Login';
import Setup from './pages/Setup';

type ThemeMode = 'system' | 'light' | 'dark';

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('center-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // ignore storage errors
  }
  return 'system';
}

function pathToTab(pathname: string): CenterAdminTab {
  if (pathname.startsWith('/capabilities')) return 'capabilities';
  if (pathname.startsWith('/devices')) return 'devices';
  if (pathname.startsWith('/vault')) return 'vault';
  if (pathname.startsWith('/ops') || pathname.startsWith('/webhooks') || pathname.startsWith('/releases')) {
    return 'ops';
  }
  return 'providers';
}

function ReadyShell({
  theme,
  themeLabel,
  onCycleTheme,
  onLogout,
}: {
  theme: ThemeMode;
  themeLabel: string;
  onCycleTheme: () => void;
  onLogout: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentTab = pathToTab(location.pathname);

  const handleTabChange = useCallback(
    (tab: CenterAdminTab) => {
      const targetPath = `/${tab}`;
      if (location.pathname !== targetPath) {
        navigate(targetPath);
      }
    },
    [location.pathname, navigate],
  );

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 18px',
          borderBottom: '1px solid rgba(128, 128, 128, 0.14)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14.5 }}>
          <span className="brand-dot" aria-hidden="true" />
          <span>中心管理</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="rail-action"
            onClick={onCycleTheme}
            aria-label={themeLabel}
            title={themeLabel}
          >
            {theme === 'system' ? <Monitor size={17} /> : theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button
            type="button"
            className="rail-action"
            aria-label="退出登录"
            title="退出登录"
            onClick={onLogout}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <div style={{ flex: 1 }}>
        <CenterAdminPanel
          transport={webTransport}
          activeTab={currentTab}
          onTabChange={handleTabChange}
          onOpenExternalUrl={url => {
            window.open(url, '_blank', 'noopener,noreferrer');
          }}
          renderQr={(value, label) => <QrCode value={value} label={label} />}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<'loading' | 'offline' | 'anonymous' | 'ready' | 'setup'>('loading');
  const stateRef = useRef(state);
  stateRef.current = state;
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const generationRef = useRef(0);
  const pollingRef = useRef(false);
  const bootstrapInFlightRef = useRef(false);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('center-theme', theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme(prev => (prev === 'system' ? 'light' : prev === 'light' ? 'dark' : 'system'));
  }, []);

  const themeLabel =
    theme === 'system'
      ? '主题：跟随系统（点击切换浅色）'
      : theme === 'light'
        ? '主题：浅色（点击切换深色）'
        : '主题：深色（点击跟随系统）';

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    try {
      const session = await api.session();
      if (generation === generationRef.current) {
        setState(session.authenticated ? 'ready' : 'anonymous');
      }
    } catch {
      if (generation === generationRef.current) setState('offline');
    }
  }, []);

  const bootstrap = useCallback(async () => {
    if (bootstrapInFlightRef.current) return;
    bootstrapInFlightRef.current = true;
    const generation = ++generationRef.current;
    pollingRef.current = false;
    try {
      let setup: SetupStatus;
      try {
        setup = await api.getSetup();
      } catch {
        if (generation === generationRef.current) setState('offline');
        return;
      }
      if (generation !== generationRef.current) return;
      if (setup.required) {
        setSetupStatus(setup);
        setState('setup');
        return;
      }
      pollingRef.current = true;
      void refresh();
    } finally {
      if (generation === generationRef.current) bootstrapInFlightRef.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    void bootstrap();
    const offline = () => {
      if (pollingRef.current && stateRef.current !== 'setup') setState('offline');
    };
    const unauthenticated = () => {
      if (!pollingRef.current || stateRef.current === 'setup') return;
      setState('anonymous');
      void refresh();
    };
    window.addEventListener('center-offline', offline);
    window.addEventListener('center-unauthenticated', unauthenticated);
    const timer = window.setInterval(() => {
      if (stateRef.current === 'offline') {
        void bootstrap();
        return;
      }
      if (!pollingRef.current || stateRef.current === 'setup') return;
      void refresh();
    }, 5000);
    return () => {
      generationRef.current++;
      bootstrapInFlightRef.current = false;
      pollingRef.current = false;
      window.clearInterval(timer);
      window.removeEventListener('center-offline', offline);
      window.removeEventListener('center-unauthenticated', unauthenticated);
    };
  }, [bootstrap, refresh]);

  if (state === 'setup' && setupStatus) {
    return (
      <Setup
        status={setupStatus}
        onComplete={() => {
          setState('loading');
          void bootstrap();
        }}
      />
    );
  }

  if (state === 'loading' || state === 'setup') {
    return (
      <main className="page login">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <p className="secondary" style={{ margin: 0 }}>
            正在连接中心…
          </p>
        </div>
      </main>
    );
  }

  if (state === 'offline') {
    return (
      <main className="page login">
        <div className="login-card">
          <div className="login-icon" aria-hidden="true">
            <WifiOff size={22} />
          </div>
          <h1>中心不可用</h1>
          <p className="secondary" role="alert">
            无法连接中心，业务页面已关闭。
          </p>
          <button className="button" onClick={() => void bootstrap()}>
            <RefreshCw size={16} />
            <span>重试连接</span>
          </button>
        </div>
      </main>
    );
  }

  return (
    <BrowserRouter>
      {state === 'anonymous' ? (
        <Routes>
          <Route path="/login" element={<Login onSuccess={() => void refresh()} />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/login" element={<Navigate to="/providers" replace />} />
          <Route path="/models" element={<Navigate to="/providers" replace />} />
          <Route path="/providers/:providerId/models" element={<Navigate to="/providers" replace />} />
          <Route path="/capabilities/:installationId" element={<Navigate to="/capabilities" replace />} />
          <Route path="/devices/:deviceId/bots/:botId/capabilities" element={<Navigate to="/devices" replace />} />
          <Route path="/webhooks" element={<Navigate to="/ops" replace />} />
          <Route path="/releases" element={<Navigate to="/ops" replace />} />
          <Route
            path="/providers"
            element={
              <ReadyShell
                theme={theme}
                themeLabel={themeLabel}
                onCycleTheme={cycleTheme}
                onLogout={() => void api.logout().then(refresh).catch(() => refresh())}
              />
            }
          />
          <Route
            path="/capabilities"
            element={
              <ReadyShell
                theme={theme}
                themeLabel={themeLabel}
                onCycleTheme={cycleTheme}
                onLogout={() => void api.logout().then(refresh).catch(() => refresh())}
              />
            }
          />
          <Route
            path="/devices"
            element={
              <ReadyShell
                theme={theme}
                themeLabel={themeLabel}
                onCycleTheme={cycleTheme}
                onLogout={() => void api.logout().then(refresh).catch(() => refresh())}
              />
            }
          />
          <Route
            path="/vault"
            element={
              <ReadyShell
                theme={theme}
                themeLabel={themeLabel}
                onCycleTheme={cycleTheme}
                onLogout={() => void api.logout().then(refresh).catch(() => refresh())}
              />
            }
          />
          <Route
            path="/ops"
            element={
              <ReadyShell
                theme={theme}
                themeLabel={themeLabel}
                onCycleTheme={cycleTheme}
                onLogout={() => void api.logout().then(refresh).catch(() => refresh())}
              />
            }
          />
          <Route path="*" element={<Navigate to="/providers" replace />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
