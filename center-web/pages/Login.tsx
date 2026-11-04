import { useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '../api';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <main className="page login">
      <section className="login-card">
        <div className="login-icon" aria-hidden="true">
          <Lock size={22} />
        </div>
        <h1>登录中心</h1>
        <p className="secondary">输入所有者口令以管理服务商、设备 Bot 与扩展能力</p>
        <form
          className="form"
          onSubmit={event => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void api
              .login({ password })
              .then(() => {
                setPassword('');
                window.location.assign('/providers');
              })
              .catch(err => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            所有者口令
            <input
              type="password"
              autoComplete="current-password"
              placeholder="请输入中心所有者口令"
              required
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <button className="button" type="submit" disabled={busy}>
            {busy ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}
