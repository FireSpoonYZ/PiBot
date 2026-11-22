import { useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useText } from '../../web/src/ui';
import { api, CenterApiError } from '../api';
import type { SetupStatus } from '../api';

const WAIT_DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const MIN_PASSWORD_LENGTH = 12;

interface InlineErrorState {
  message: string;
  hint: string;
}

function deriveLinkUrl(publicUrl: string): string {
  try {
    const url = new URL(publicUrl);
    return 'wss://' + url.host + '/v1/link';
  } catch {
    return '';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

function defaultPublicUrl(status: SetupStatus): string {
  return status.publicUrl ?? (window.location.protocol === 'https:' ? window.location.origin : '');
}

function describeSetupError(
  err: unknown,
  t: (zh: string, en: string) => string,
): InlineErrorState {
  if (err instanceof CenterApiError) {
    if (err.status === 401 || err.status === 403 || err.code.includes('TOKEN')) {
      return {
        message: err.message || t('初始化码无效或已过期', 'Invalid or expired setup token'),
        hint: t(
          '请核对容器首次启动日志中的一次性初始化码，并确认未包含多余空格。',
          'Check the one-time setup token in the container startup logs and ensure there are no extra spaces.',
        ),
      };
    }
    if (err.status === 400) {
      return {
        message: err.message || t('初始化参数有误', 'Invalid setup parameters'),
        hint: t(
          '请检查所有者口令长度（至少 12 个字符）与外部 HTTPS 地址格式。',
          'Verify the owner password is at least 12 characters and the external HTTPS URL is valid.',
        ),
      };
    }
    return {
      message: err.message || t('初始化提交失败', 'Setup submission failed'),
      hint: t('请确认中心服务正常后重新提交。', 'Check the center service status and try submitting again.'),
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    hint: t('请检查网络连接后重新提交。', 'Check your network connection and try submitting again.'),
  };
}

export default function Setup({ status, onComplete }: { status: SetupStatus; onComplete: () => void }) {
  const t = useText();
  const [setupToken, setSetupToken] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [publicUrl, setPublicUrl] = useState(() => defaultPublicUrl(status));
  const linkUrl = deriveLinkUrl(publicUrl);
  const [error, setError] = useState<InlineErrorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [waitFailed, setWaitFailed] = useState(false);
  const waitAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // StrictMode replays effect setup after cleanup — reset on every setup or
    // mountedRef would stay false forever and all late callbacks be dropped.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      waitAbortRef.current?.abort();
    };
  }, []);

  // Bounded wait for the backend to swap from the setup listener to the
  // normal server: hard deadline, per-request timeout, abortable on unmount.
  const waitForReady = async (signal: AbortSignal): Promise<boolean> => {
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    while (!signal.aborted && Date.now() < deadline) {
      const request = new AbortController();
      const forwardAbort = () => request.abort();
      signal.addEventListener('abort', forwardAbort);
      const timer = setTimeout(
        () => request.abort(),
        Math.min(REQUEST_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
      );
      try {
        const setup = await api.getSetup(request.signal);
        if (!setup.required) {
          if (!signal.aborted && mountedRef.current) onComplete();
          return true;
        }
      } catch {
        // Transient failure or per-request timeout — keep polling.
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', forwardAbort);
      }
      if (!signal.aborted) {
        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
      }
    }
    return false;
  };

  const clearSecrets = () => {
    setSetupToken('');
    setOwnerPassword('');
    setConfirmPassword('');
  };

  const beginWait = () => {
    waitAbortRef.current?.abort();
    const controller = new AbortController();
    waitAbortRef.current = controller;
    setFinishing(true);
    setWaitFailed(false);
    void waitForReady(controller.signal).then(ok => {
      if (!mountedRef.current || controller.signal.aborted) return;
      setFinishing(false);
      if (!ok) setWaitFailed(true);
    });
  };

  const disabled = busy || finishing;

  return (
    <main className="cw-auth-page">
      <section className="cw-auth-card cw-auth-card--wide">
        <div className="cw-auth-header">
          <div className="cw-auth-mark" aria-hidden="true">
            <KeyRound size={19} />
          </div>
          <h1 className="cw-auth-title">{t('初始化中心', 'Initialize Center')}</h1>
          <p className="cw-auth-desc">
            {t(
              '首次部署需要一次性初始化码与所有者口令。初始化码输出在容器首次启动日志中。',
              'First-time setup requires the one-time setup token from container startup logs and an owner password.',
            )}
          </p>
        </div>

        <p className="cw-auth-note">
          {t(
            '如通过 NAS 反向代理部署，必须启用 WebSocket 升级；HTTPS 与 WSS 由同一反向代理入口提供。',
            'If deployed behind a NAS reverse proxy, enable WebSocket upgrades. HTTPS and WSS share the same reverse proxy entry point.',
          )}
        </p>

        <form
          className="cw-auth-form"
          onSubmit={event => {
            event.preventDefault();
            if (ownerPassword !== confirmPassword) {
              setError({
                message: t('两次输入的口令不一致', 'Passwords do not match'),
                hint: t('请重新核对所有者口令与确认口令。', 'Re-enter the owner password and confirmation to make sure they match.'),
              });
              return;
            }
            if (!publicUrl.startsWith('https://')) {
              setError({
                message: t('外部地址必须以 https:// 开头', 'External URL must start with https://'),
                hint: t('请填写可从客户端访问的完整 HTTPS 入口地址，例如 https://center.example.com。', 'Enter the full HTTPS origin reachable by clients, e.g. https://center.example.com.'),
              });
              return;
            }
            if (!linkUrl.startsWith('wss://')) {
              setError({
                message: t('链接地址必须以 wss:// 开头', 'Link URL must start with wss://'),
                hint: t('请填写包含有效主机名的外部 HTTPS 地址以自动派生 WebSocket 地址。', 'Provide a valid HTTPS origin with a hostname so the WebSocket link URL can be derived.'),
              });
              return;
            }
            setBusy(true);
            setError(null);
            void api
              .submitSetup({ setupToken, ownerPassword, publicUrl })
              .then(() => {
                if (!mountedRef.current) return;
                clearSecrets();
                beginWait();
              })
              .catch(err => {
                if (!mountedRef.current) return;
                clearSecrets();
                if (err instanceof CenterApiError && err.status === 409) {
                  // Already initialized concurrently — treat as a completed
                  // submit and wait for the normal server like any success.
                  beginWait();
                } else {
                  setError(describeSetupError(err, t));
                }
              })
              .finally(() => {
                if (mountedRef.current) setBusy(false);
              });
          }}
        >
          <div className="cw-auth-field">
            <label className="cw-auth-label" htmlFor="cw-setup-token">
              <span>{t('初始化码', 'Setup token')}</span>
            </label>
            <input
              id="cw-setup-token"
              className="cw-input cw-input--mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('容器首次启动日志中的一次性初始化码', 'One-time token from first container boot logs')}
              required
              disabled={disabled}
              value={setupToken}
              onChange={event => {
                setSetupToken(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>

          <div className="cw-auth-field">
            <label className="cw-auth-label" htmlFor="cw-setup-password">
              <span>{t('所有者口令', 'Owner password')}</span>
              <span className="cw-auth-label-meta">{t(`至少 ${MIN_PASSWORD_LENGTH} 个字符`, `Min. ${MIN_PASSWORD_LENGTH} chars`)}</span>
            </label>
            <input
              id="cw-setup-password"
              className="cw-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              disabled={disabled}
              value={ownerPassword}
              onChange={event => {
                setOwnerPassword(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>

          <div className="cw-auth-field">
            <label className="cw-auth-label" htmlFor="cw-setup-confirm">
              <span>{t('确认所有者口令', 'Confirm owner password')}</span>
            </label>
            <input
              id="cw-setup-confirm"
              className="cw-input"
              type="password"
              autoComplete="new-password"
              required
              disabled={disabled}
              value={confirmPassword}
              onChange={event => {
                setConfirmPassword(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>

          <div className="cw-auth-field">
            <label className="cw-auth-label" htmlFor="cw-setup-public-url">
              <span>{t('外部 HTTPS 地址', 'External HTTPS URL')}</span>
            </label>
            <input
              id="cw-setup-public-url"
              className="cw-input cw-input--mono"
              type="url"
              placeholder="https://center.example.com"
              required
              disabled={disabled}
              value={publicUrl}
              onChange={event => {
                setPublicUrl(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>

          <div className="cw-auth-field">
            <label className="cw-auth-label" htmlFor="cw-setup-link-url">
              <span>{t('链接地址 (WebSocket)', 'Link URL (WebSocket)')}</span>
              <span className="cw-auth-label-meta">{t('自动派生', 'Derived')}</span>
            </label>
            <input
              id="cw-setup-link-url"
              className="cw-input cw-input--mono"
              type="text"
              placeholder="wss://center.example.com/v1/link"
              required
              disabled={disabled}
              value={linkUrl}
              readOnly
            />
          </div>

          {error && (
            <div className="cw-auth-alert" role="alert">
              <span className="cw-auth-alert-title">{error.message}</span>
              <span className="cw-auth-alert-hint">{error.hint}</span>
            </div>
          )}

          {finishing && (
            <div className="cw-auth-status" role="status" aria-live="polite">
              <Loader2 size={15} className="cw-spin" aria-hidden="true" />
              <span>{t('初始化已提交，正在等待中心切换至正常服务…', 'Setup submitted. Waiting for center to switch to normal mode…')}</span>
            </div>
          )}

          {waitFailed && (
            <div className="cw-auth-alert" role="alert">
              <span className="cw-auth-alert-title">{t('等待超时，中心可能仍在启动', 'Timed out waiting for center')}</span>
              <span className="cw-auth-alert-hint">
                {t('请稍候点击重试，或检查容器日志与反向代理配置。', 'Retry in a moment, or check container logs and reverse proxy settings.')}
              </span>
            </div>
          )}

          {waitFailed ? (
            <button className="cw-btn cw-btn--primary cw-btn--full" type="button" onClick={beginWait} disabled={disabled}>
              <RefreshCw size={15} aria-hidden="true" />
              <span>{t('重试等待', 'Retry waiting')}</span>
            </button>
          ) : (
            <button className="cw-btn cw-btn--primary cw-btn--full" type="submit" disabled={disabled}>
              {(busy || finishing) && <Loader2 size={15} className="cw-spin" aria-hidden="true" />}
              <span>
                {finishing
                  ? t('正在等待中心就绪…', 'Waiting for center…')
                  : busy
                    ? t('正在提交…', 'Submitting…')
                    : t('完成初始化', 'Complete setup')}
              </span>
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
