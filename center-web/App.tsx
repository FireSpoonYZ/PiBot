import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Loader2, LogOut, Monitor, Moon, RefreshCw, Sun, WifiOff } from 'lucide-react';
import { CenterAdminPanel } from '../web/src/center-admin';
import type { CenterAdminTab } from '../web/src/center-admin';
import { useText } from '../web/src/ui';
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
  if (pathname.startsWith('/google')) return 'google';
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
  themeShortLabel,
  onCycleTheme,
  onLogout,
}: {
  theme: ThemeMode;
  themeLabel: string;
  themeShortLabel: string;
  onCycleTheme: () => void;
  onLogout: () => void;
}) {
  const t = useText();
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

  const logoutLabel = t('退出登录', 'Sign out');

  return (
    <div className="cw-shell">
      <header className="cw-topbar">
        <div className="cw-topbar-inner">
          <div className="cw-brand">
            <span className="cw-brand-dot" aria-hidden="true" />
            <span className="cw-brand-name">{t('中心管理', 'Center Admin')}</span>
          </div>
          <div className="cw-topbar-actions">
            <button
              type="button"
              className="cw-icon-btn"
              onClick={onCycleTheme}
              aria-label={themeLabel}
              title={themeLabel}
            >
              {theme === 'system' ? (
                <Monitor size={15} aria-hidden="true" />
              ) : theme === 'dark' ? (
                <Moon size={15} aria-hidden="true" />
              ) : (
                <Sun size={15} aria-hidden="true" />
              )}
              <span className="cw-topbar-label">{themeShortLabel}</span>
            </button>
            <button
              type="button"
              className="cw-icon-btn"
              aria-label={logoutLabel}
              title={logoutLabel}
              onClick={onLogout}
            >
              <LogOut size={15} aria-hidden="true" />
              <span className="cw-topbar-label">{logoutLabel}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="cw-shell-main">
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
  const t = useText();
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
      ? t('主题：跟随系统（点击切换浅色）', 'Theme: System (click for Light)')
      : theme === 'light'
        ? t('主题：浅色（点击切换深色）', 'Theme: Light (click for Dark)')
        : t('主题：深色（点击跟随系统）', 'Theme: Dark (click for System)');

  const themeShortLabel =
    theme === 'system'
      ? t('自动', 'Auto')
      : theme === 'light'
        ? t('浅色', 'Light')
        : t('深色', 'Dark');

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

  const handleLogout = useCallback(() => {
    void api.logout().then(refresh).catch(() => refresh());
  }, [refresh]);

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
      <main className="cw-auth-page">
        <div className="cw-auth-card cw-auth-card--centered" role="status" aria-live="polite">
          <div className="cw-auth-loading">
            <Loader2 size={16} className="cw-spin" aria-hidden="true" />
            <span>{t('正在连接中心…', 'Connecting to center…')}</span>
          </div>
        </div>
      </main>
    );
  }

  if (state === 'offline') {
    return (
      <main className="cw-auth-page">
        <section className="cw-auth-card cw-auth-card--centered">
          <div className="cw-auth-header">
            <div className="cw-auth-mark cw-auth-mark--danger" aria-hidden="true">
              <WifiOff size={20} />
            </div>
            <h1 className="cw-auth-title">{t('中心不可用', 'Center unavailable')}</h1>
            <p className="cw-auth-desc" role="alert">
              {t(
                '无法连接中心服务，请确认服务已启动或检查网络连接后重试。',
                'Unable to reach the center service. Verify it is running and check your network connection, then retry.',
              )}
            </p>
          </div>
          <div className="cw-auth-actions">
            <button type="button" className="cw-btn cw-btn--primary" onClick={() => void bootstrap()}>
              <RefreshCw size={15} aria-hidden="true" />
              <span>{t('重试连接', 'Retry connection')}</span>
            </button>
          </div>
        </section>
      </main>
    );
  }

  const readyElement = (
    <ReadyShell
      theme={theme}
      themeLabel={themeLabel}
      themeShortLabel={themeShortLabel}
      onCycleTheme={cycleTheme}
      onLogout={handleLogout}
    />
  );

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
          <Route path="/providers" element={readyElement} />
          <Route path="/capabilities" element={readyElement} />
          <Route path="/google" element={readyElement} />
          <Route path="/google/*" element={<Navigate to="/google" replace />} />
          <Route path="/devices" element={readyElement} />
          <Route path="/vault" element={readyElement} />
          <Route path="/ops" element={readyElement} />
          <Route path="*" element={<Navigate to="/providers" replace />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
