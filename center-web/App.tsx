import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { LogOut, Moon, Puzzle, RefreshCw, Server, Smartphone, Sun, WifiOff } from 'lucide-react';
import { api } from './api';
import Login from './pages/Login';
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
  const [state, setState] = useState<'loading' | 'offline' | 'anonymous' | 'ready'>('loading');
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
    try {
      const session = await api.session();
      setState(session.authenticated ? 'ready' : 'anonymous');
    } catch {
      setState('offline');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offline = () => setState('offline');
    const unauthenticated = () => {
      setState('anonymous');
      void refresh();
    };
    window.addEventListener('center-offline', offline);
    window.addEventListener('center-unauthenticated', unauthenticated);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('center-offline', offline);
      window.removeEventListener('center-unauthenticated', unauthenticated);
    };
  }, [refresh]);

  if (state === 'loading') {
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
          <button className="button" onClick={() => void refresh()}>
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
