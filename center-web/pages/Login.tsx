import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Lock, QrCode as QrIcon, RefreshCw } from 'lucide-react';
import { useText } from '../../web/src/ui';
import { api, CenterApiError } from '../api';
import type { QrLoginChallengeResponse } from '../api';
import { QrCode } from '../components/QrCode';

type LoginMode = 'qr' | 'password';
type QrState = 'loading' | 'pending' | 'approved' | 'expired' | 'error';

interface InlineErrorState {
  message: string;
  hint: string;
}

function describePasswordError(
  err: unknown,
  t: (zh: string, en: string) => string,
): InlineErrorState {
  if (err instanceof CenterApiError) {
    if (err.status === 401 || err.code === 'INVALID_PASSWORD' || err.code === 'UNAUTHORIZED') {
      return {
        message: err.message || t('所有者口令不正确', 'Incorrect owner password'),
        hint: t(
          '请核对口令后重试，或切换至「扫码登录」免密确认。',
          'Check your password and try again, or switch to QR sign-in.',
        ),
      };
    }
    if (err.status === 429 || err.code === 'RATE_LIMITED') {
      return {
        message: err.message || t('尝试次数过多', 'Too many sign-in attempts'),
        hint: t('请稍候片刻后再试。', 'Wait a moment before trying again.'),
      };
    }
    if (err.status === 503 || err.code === 'CENTER_OFFLINE') {
      return {
        message: err.message || t('无法连接中心服务', 'Unable to reach center'),
        hint: t('请确认中心服务正在运行并检查网络连接。', 'Verify the center service is running and check your network.'),
      };
    }
    return {
      message: err.message || t('登录失败', 'Sign-in failed'),
      hint: t('请稍后重试，或切换至「扫码登录」。', 'Try again shortly, or switch to QR sign-in.'),
    };
  }
  return {
    message: err instanceof Error ? err.message : t('登录失败', 'Sign-in failed'),
    hint: t('请检查网络连接后重试。', 'Check your connection and try again.'),
  };
}

export default function Login({ onSuccess }: { onSuccess?: () => void }) {
  const t = useText();
  const [mode, setMode] = useState<LoginMode>('qr');

  // QR login state
  const [challenge, setChallenge] = useState<QrLoginChallengeResponse | null>(null);
  const [qrState, setQrState] = useState<QrState>('loading');
  const [qrError, setQrError] = useState<InlineErrorState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const challengeReqIdRef = useRef(0);

  // Password login state
  const [password, setPassword] = useState('');
  const [pwdError, setPwdError] = useState<InlineErrorState | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);

  const finishLogin = useCallback(() => {
    if (onSuccess) onSuccess();
    else window.location.assign('/providers');
  }, [onSuccess]);

  const loadChallenge = useCallback(async () => {
    const reqId = ++challengeReqIdRef.current;
    setQrState('loading');
    setQrError(null);
    try {
      const next = await api.createQrLogin();
      if (reqId !== challengeReqIdRef.current) return;
      setChallenge(next);
      setNowMs(Date.now());
      setQrState('pending');
    } catch (err) {
      if (reqId !== challengeReqIdRef.current) return;
      setChallenge(null);
      setQrState('error');
      setQrError({
        message: err instanceof Error ? err.message : t('生成登录二维码失败', 'Failed to create sign-in QR code'),
        hint: t(
          '请确认中心服务可访问，或切换至「口令登录」。',
          'Check that the center service is reachable, or switch to password sign-in.',
        ),
      });
    }
  }, [t]);

  useEffect(() => {
    if (mode !== 'qr') {
      challengeReqIdRef.current += 1;
      return;
    }
    void loadChallenge();
    return () => {
      challengeReqIdRef.current += 1;
    };
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
  const showQrCode = Boolean(challenge) && (qrState === 'pending' || qrState === 'expired' || qrState === 'approved');

  const switchMode = (nextMode: LoginMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    if (nextMode === 'password') {
      setPwdError(null);
    }
  };

  return (
    <main className="cw-auth-page">
      <section className="cw-auth-card">
        <div className="cw-auth-header">
          <div className="cw-auth-mark" aria-hidden="true">
            {mode === 'qr' ? <QrIcon size={19} /> : <Lock size={19} />}
          </div>
          <h1 className="cw-auth-title">{t('登录中心管理', 'Sign in to Center Admin')}</h1>
          <p className="cw-auth-desc">
            {mode === 'qr'
              ? t('使用已绑定此中心的手机端「扫一扫」免密确认登录。', 'Confirm sign-in with Scan in the paired mobile app.')
              : t('输入中心所有者口令以进入管理台。', 'Enter the center owner password to continue.')}
          </p>
        </div>

        <div className="cw-segmented" role="tablist" aria-label={t('登录方式', 'Sign-in method')}>
          <button
            id="cw-login-tab-qr"
            type="button"
            role="tab"
            aria-selected={mode === 'qr'}
            aria-controls="cw-login-panel-qr"
            className={`cw-segmented-btn${mode === 'qr' ? ' is-active' : ''}`}
            onClick={() => switchMode('qr')}
          >
            <QrIcon size={14} aria-hidden="true" />
            <span>{t('扫码登录', 'QR code')}</span>
          </button>
          <button
            id="cw-login-tab-password"
            type="button"
            role="tab"
            aria-selected={mode === 'password'}
            aria-controls="cw-login-panel-password"
            className={`cw-segmented-btn${mode === 'password' ? ' is-active' : ''}`}
            onClick={() => switchMode('password')}
          >
            <Lock size={14} aria-hidden="true" />
            <span>{t('口令登录', 'Password')}</span>
          </button>
        </div>

        {mode === 'qr' ? (
          <div
            id="cw-login-panel-qr"
            role="tabpanel"
            aria-labelledby="cw-login-tab-qr"
            className="cw-auth-qr"
          >
            <div className={`cw-auth-qr-frame${showQrCode ? '' : ' cw-auth-qr-frame--surface'}`}>
              {qrState === 'loading' && (
                <div className="cw-auth-qr-state" role="status" aria-live="polite">
                  <Loader2 size={18} className="cw-spin" aria-hidden="true" />
                  <span>{t('正在生成二维码…', 'Generating QR code…')}</span>
                </div>
              )}

              {qrState === 'error' && (
                <div className="cw-auth-qr-state">
                  <AlertCircle size={20} aria-hidden="true" />
                  <span>{t('二维码暂不可用', 'QR unavailable')}</span>
                  <button
                    type="button"
                    className="cw-btn cw-btn--secondary cw-btn--sm"
                    onClick={() => void loadChallenge()}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>{t('重新生成', 'Retry')}</span>
                  </button>
                </div>
              )}

              {showQrCode && challenge && (
                <QrCode value={challenge.qrCode} label={t('中心管理扫码登录二维码', 'Center Admin sign-in QR code')} />
              )}

              {qrState === 'expired' && (
                <button
                  type="button"
                  className="cw-auth-qr-overlay"
                  onClick={() => void loadChallenge()}
                >
                  <RefreshCw size={18} aria-hidden="true" />
                  <span>{t('二维码已过期', 'QR code expired')}</span>
                  <span className="cw-auth-qr-overlay-sub">{t('点击刷新', 'Click to refresh')}</span>
                </button>
              )}
            </div>

            {qrState === 'error' && qrError && (
              <div className="cw-auth-alert" role="alert">
                <span className="cw-auth-alert-title">{qrError.message}</span>
                <span className="cw-auth-alert-hint">{qrError.hint}</span>
              </div>
            )}

            {qrState === 'pending' && (
              <p className="cw-auth-qr-meta">
                {t(`有效期剩余 ${remainText} · 手机端「设置 → 扫一扫」`, `Expires in ${remainText} · Mobile Settings → Scan`)}
              </p>
            )}

            {qrState === 'approved' && (
              <div className="cw-auth-status cw-auth-status--success" role="status" aria-live="polite">
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>{t('已确认登录，正在进入…', 'Approved. Signing in…')}</span>
              </div>
            )}
          </div>
        ) : (
          <form
            id="cw-login-panel-password"
            role="tabpanel"
            aria-labelledby="cw-login-tab-password"
            className="cw-auth-form"
            onSubmit={event => {
              event.preventDefault();
              setPwdBusy(true);
              setPwdError(null);
              void api
                .login({ password })
                .then(() => {
                  setPassword('');
                  finishLogin();
                })
                .catch(err => setPwdError(describePasswordError(err, t)))
                .finally(() => setPwdBusy(false));
            }}
          >
            <div className="cw-auth-field">
              <label className="cw-auth-label" htmlFor="cw-login-password">
                <span>{t('所有者口令', 'Owner password')}</span>
              </label>
              <input
                id="cw-login-password"
                className="cw-input"
                type="password"
                autoComplete="current-password"
                placeholder={t('请输入中心所有者口令', 'Enter center owner password')}
                required
                disabled={pwdBusy}
                value={password}
                onChange={event => {
                  setPassword(event.target.value);
                  if (pwdError) setPwdError(null);
                }}
              />
            </div>

            {pwdError && (
              <div className="cw-auth-alert" role="alert">
                <span className="cw-auth-alert-title">{pwdError.message}</span>
                <span className="cw-auth-alert-hint">{pwdError.hint}</span>
              </div>
            )}

            <button className="cw-btn cw-btn--primary cw-btn--full" type="submit" disabled={pwdBusy}>
              {pwdBusy && <Loader2 size={15} className="cw-spin" aria-hidden="true" />}
              <span>{pwdBusy ? t('正在登录…', 'Signing in…') : t('登录', 'Sign in')}</span>
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
