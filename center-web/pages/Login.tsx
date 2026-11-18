import { useCallback, useEffect, useState } from 'react';
import { Lock, QrCode as QrIcon, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { QrLoginChallengeResponse } from '../api';
import { QrCode } from '../components/QrCode';

export default function Login({ onSuccess }: { onSuccess?: () => void }) {
  const [mode, setMode] = useState<'qr' | 'password'>('qr');

  // QR state
  const [challenge, setChallenge] = useState<QrLoginChallengeResponse | null>(null);
  const [qrState, setQrState] = useState<'loading' | 'pending' | 'approved' | 'expired' | 'error'>('loading');
  const [qrError, setQrError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Password state
  const [password, setPassword] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);

  const finishLogin = useCallback(() => {
    if (onSuccess) onSuccess();
    else window.location.assign('/providers');
  }, [onSuccess]);

  const loadChallenge = useCallback(async () => {
    setQrState('loading');
    setQrError('');
    try {
      const next = await api.createQrLogin();
      setChallenge(next);
      setNowMs(Date.now());
      setQrState('pending');
    } catch (err) {
      setQrState('error');
      setQrError(err instanceof Error ? err.message : '生成登录二维码失败');
    }
  }, []);

  useEffect(() => {
    if (mode !== 'qr') return;
    void loadChallenge();
  }, [loadChallenge, mode]);

  // Countdown tick
  useEffect(() => {
    if (mode !== 'qr' || qrState !== 'pending' || !challenge) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (new Date(challenge.expiresAt).getTime() <= now) {
        setQrState('expired');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [challenge, mode, qrState]);

  // Poll POST /api/session/qr/:challengeId/claim every 2s
  useEffect(() => {
    if (mode !== 'qr' || qrState !== 'pending' || !challenge) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api
        .claimQrLogin(challenge.challengeId, challenge.browserSecret)
        .then(res => {
          if (cancelled) return;
          if (res.status === 'approved') {
            setQrState('approved');
            finishLogin();
          } else if (res.status === 'expired') {
            setQrState('expired');
          }
        })
        .catch(() => {
          // Keep polling quietly on transient network hiccups
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [challenge, finishLogin, mode, qrState]);

  const remainSec = challenge
    ? Math.max(0, Math.floor((new Date(challenge.expiresAt).getTime() - nowMs) / 1000))
    : 0;
  const remainText = `${String(Math.floor(remainSec / 60)).padStart(2, '0')}:${String(remainSec % 60).padStart(2, '0')}`;

  return (
    <main className="page login">
      <section className="login-card" style={{ maxWidth: 400 }}>
        <div className="login-icon" aria-hidden="true">
          {mode === 'qr' ? <QrIcon size={20} /> : <Lock size={20} />}
        </div>
        <h1 style={{ marginBottom: 4 }}>登录中心管理</h1>
        <p className="secondary" style={{ marginBottom: 14 }}>
          {mode === 'qr'
            ? '使用已绑定此中心的手机端「扫一扫」免密确认登录'
            : '输入中心所有者口令以进入管理台'}
        </p>

        <div className="ca-root" style={{ background: 'transparent', minHeight: 0, marginBottom: 16 }}>
          <div className="ca-segmented" role="tablist" style={{ width: '100%' }}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'qr'}
              className={`ca-seg-btn ${mode === 'qr' ? 'is-active' : ''}`}
              style={{ flex: 1 }}
              onClick={() => setMode('qr')}
            >
              扫码登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'password'}
              className={`ca-seg-btn ${mode === 'password' ? 'is-active' : ''}`}
              style={{ flex: 1 }}
              onClick={() => setMode('password')}
            >
              口令登录
            </button>
          </div>
        </div>

        {mode === 'qr' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                position: 'relative',
                width: 216,
                height: 216,
                padding: 8,
                background: '#ffffff',
                border: '1px solid var(--border, rgba(15,23,42,0.12))',
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {qrState === 'loading' && (
                <span className="secondary" style={{ fontSize: 13 }}>
                  正在生成二维码…
                </span>
              )}
              {qrState === 'error' && (
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <p className="inline-error" style={{ marginBottom: 8 }}>
                    {qrError}
                  </p>
                  <button
                    type="button"
                    className="button secondary-button button-sm"
                    onClick={() => void loadChallenge()}
                  >
                    <RefreshCw size={13} />
                    <span>重试</span>
                  </button>
                </div>
              )}
              {challenge && (qrState === 'pending' || qrState === 'expired' || qrState === 'approved') && (
                <QrCode value={challenge.qrCode} label="中心管理扫码登录二维码" />
              )}

              {qrState === 'expired' && (
                <button
                  type="button"
                  onClick={() => void loadChallenge()}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    border: 'none',
                    borderRadius: 12,
                    background: 'rgba(15, 23, 42, 0.72)',
                    color: '#ffffff',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  <RefreshCw size={20} />
                  <span>二维码已过期</span>
                  <span style={{ opacity: 0.85, fontSize: 12 }}>点击刷新</span>
                </button>
              )}
            </div>

            {qrState === 'pending' && (
              <div className="secondary" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
                有效期剩余 {remainText} · 手机端「设置 → 扫一扫」
              </div>
            )}
            {qrState === 'approved' && (
              <div style={{ fontSize: 13, color: '#15803d', fontWeight: 500 }}>
                已确认登录，正在进入…
              </div>
            )}
          </div>
        ) : (
          <form
            className="form"
            onSubmit={event => {
              event.preventDefault();
              setPwdBusy(true);
              setPwdError('');
              void api
                .login({ password })
                .then(() => {
                  setPassword('');
                  finishLogin();
                })
                .catch(err => setPwdError(err instanceof Error ? err.message : String(err)))
                .finally(() => setPwdBusy(false));
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
            {pwdError && (
              <p className="inline-error" role="alert">
                {pwdError}
              </p>
            )}
            <button className="button" type="submit" disabled={pwdBusy}>
              {pwdBusy ? '正在登录…' : '登录'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
