import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, CenterApiError } from '../api';
import type { SetupStatus } from '../api';

const WAIT_DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const MIN_PASSWORD_LENGTH = 12;

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

export default function Setup({ status, onComplete }: { status: SetupStatus; onComplete: () => void }) {
  const [setupToken, setSetupToken] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [publicUrl, setPublicUrl] = useState(() => defaultPublicUrl(status));
  const linkUrl = deriveLinkUrl(publicUrl);
  const [error, setError] = useState('');
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
    <main className="page login">
      <section className="login-card">
        <div className="login-icon" aria-hidden="true">
          <KeyRound size={22} />
        </div>
        <h1>初始化中心</h1>
        <p className="secondary">
          首次部署需要初始化码与所有者口令。初始化码输出在容器首次启动的日志中。
        </p>
        <p className="secondary">
          如通过 NAS 反向代理部署，必须启用 WebSocket 升级。
          {' HTTPS/WSS 由同一反向代理入口提供。'}
        </p>
        <form
          className="form"
          onSubmit={event => {
            event.preventDefault();
            if (ownerPassword !== confirmPassword) {
              setError('两次输入的口令不一致');
              return;
            }
            if (!publicUrl.startsWith('https://')) {
              setError('外部地址必须以 https:// 开头');
              return;
            }
            if (!linkUrl.startsWith('wss://')) {
              setError('链接地址必须以 wss:// 开头');
              return;
            }
            setBusy(true);
            setError('');
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
                  setError(err instanceof Error ? err.message : String(err));
                }
              })
              .finally(() => {
                if (mountedRef.current) setBusy(false);
              });
          }}
        >
          <label>
            初始化码
            <input
              type="text"
              autoComplete="off"
              placeholder="容器首次启动日志中的一次性初始化码"
              required
              disabled={disabled}
              value={setupToken}
              onChange={event => setSetupToken(event.target.value)}
            />
          </label>
          <label>
            所有者口令（至少 12 个字符）
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              disabled={disabled}
              value={ownerPassword}
              onChange={event => setOwnerPassword(event.target.value)}
            />
          </label>
          <label>
            确认所有者口令
            <input
              type="password"
              autoComplete="new-password"
              required
              disabled={disabled}
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
            />
          </label>
          <label>
            外部 HTTPS 地址
            <input
              type="url"
              placeholder="https://center.example.com"
              required
              disabled={disabled}
              value={publicUrl}
              onChange={event => {
                const value = event.target.value;
                setPublicUrl(value);

              }}
            />
          </label>
          <label>
            链接地址 (WebSocket)
            <input
              type="text"
              placeholder="wss://center.example.com/v1/link"
              required
              disabled={disabled}
              value={linkUrl}
              readOnly
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {finishing && (
            <p className="secondary" role="status">
              初始化已提交，正在等待中心切换至正常服务…
            </p>
          )}
          {waitFailed && (
            <p className="inline-error" role="alert">
              等待超时，中心可能仍在启动。请重试。
            </p>
          )}
          {waitFailed ? (
            <button className="button" type="button" onClick={beginWait} disabled={disabled}>
              重试等待
            </button>
          ) : (
            <button className="button" type="submit" disabled={disabled}>
              {finishing ? '正在等待中心就绪…' : busy ? '正在提交…' : '完成初始化'}
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
