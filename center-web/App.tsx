import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { LogOut, Moon, Puzzle, RefreshCw, Server, Smartphone, Sun, WifiOff } from 'lucide-react';
import { api } from './api';
import type { SetupStatus } from './api';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Providers from './pages/Providers';
import Models from './pages/Models';
import Devices from './pages/Devices';
import Capabilities from './pages/Capabilities';
import Installation from './pages/Installation';
import BotCapabilities from './pages/BotCapabilities';

type ThemeMode = 'light' | 'dark';

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('center-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export default function App() {
  const [state, setState] = useState<'loading' | 'offline' | 'anonymous' | 'ready' | 'setup'>('loading');
  const stateRef = useRef(state);
  stateRef.current = state;
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  // generation cancels in-flight responses from an older bootstrap/refresh so a
  // late /api/session reply cannot overwrite the setup state.
  const generationRef = useRef(0);
  // No /api/session traffic runs until a bootstrap confirms required:false.
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

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

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

  // Unconfigured centers must go through onboarding before any session work:
  // polling /api/session against the setup listener would flash the offline card.
  const bootstrap = useCallback(async () => {
    if (bootstrapInFlightRef.current) return;
    bootstrapInFlightRef.current = true;
    const generation = ++generationRef.current;
    // Session polling stays paused until required:false is confirmed.
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
      // Only the request that still owns the generation may clear the flag; a
      // stale bootstrap must not unblock/falsely unblock newer calls.
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
      // Offline recovery always re-runs the full bootstrap (the setup listener
      // has no /api/session); this branch must precede the pollingRef check or
      // a failed initial bootstrap (pollingRef=false) could never recover.
      if (stateRef.current === 'offline') {
        void bootstrap();
        return;
      }
      if (!pollingRef.current || stateRef.current === 'setup') return;
      void refresh();
    }, 5000);
    return () => {
      // Invalidate any in-flight bootstrap/refresh so a StrictMode remount
      // cannot let a stale response write state, and release the in-flight
      // flag so the replayed effect can bootstrap again (generation guards
      // prevent the orphaned request from reclaiming it).
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
          <p className="secondary" style={{ margin: 0 }}>正在连接中心…</p>
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
          <p className="secondary" role="alert">无法连接中心，业务页面已关闭。</p>
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
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      ) : (
        <div className="shell">
          <nav className="shell-sidebar" aria-label="中心管理">
            <div className="mobile-topbar">
              <div className="brand-title">
                <span className="brand-dot" aria-hidden="true" />
                <span>E-Launcher 中心</span>
              </div>
              <div className="shell-footer">
                <button
                  type="button"
                  className="quiet-button icon-button"
                  onClick={toggleTheme}
                  aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                  title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                >
                  {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => void api.logout().then(refresh).catch(() => refresh())}
                >
                  <LogOut size={16} />
                  <span>退出登录</span>
                </button>
              </div>
            </div>
            <div className="mobile-bottom-nav">
              <NavLink
                to="/providers"
                className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
              >
                <Server size={18} />
                <span>服务商与模型</span>
              </NavLink>
              <NavLink
                to="/devices"
                className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
              >
                <Smartphone size={18} />
                <span>设备与 Bot</span>
              </NavLink>
              <NavLink
                to="/capabilities"
                className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
              >
                <Puzzle size={18} />
                <span>插件、MCP 与 Skill</span>
              </NavLink>
            </div>
          </nav>
          <Routes>
            <Route path="/login" element={<Navigate to="/providers" replace />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/providers/:providerId/models" element={<Models />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/capabilities" element={<Capabilities />} />
            <Route path="/capabilities/:installationId" element={<Installation />} />
            <Route path="/devices/:deviceId/bots/:botId/capabilities" element={<BotCapabilities />} />
            <Route path="*" element={<Navigate to="/providers" replace />} />
          </Routes>
        </div>
      )}
    </BrowserRouter>
  );
}
