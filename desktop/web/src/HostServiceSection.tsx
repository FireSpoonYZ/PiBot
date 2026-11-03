// 设置弹窗“本机 Host”分区：展示内置 Host 运行状态，提供重启/启动与开机自启开关。
// 仅在挂载（设置弹窗常规页可见）且窗口可见时每 10s 轮询一次启动器 status。
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useText } from '../../../web/src/ui';
import { hostControl, hostErrorText, hostStatus, type HostControlAction, type HostStatus } from './hostService';

const POLL_MS = 10_000;

export function HostServiceSection() {
  const t = useText();
  /** undefined=读取中；null=不可用（见 loadError）。 */
  const [host, setHost] = useState<HostStatus | null>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<HostControlAction | null>(null);
  const inFlight = useRef(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await hostStatus();
      if (!live.current) return;
      setHost(next);
      setLoadError('');
    } catch (e) {
      if (!live.current) return;
      setHost(null);
      setLoadError(hostErrorText(e, t));
    } finally {
      inFlight.current = false;
    }
  }, [t]);

  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const run = async (action: HostControlAction) => {
    if (busy) return;
    setBusy(action);
    setActionError('');
    try {
      await hostControl(action);
    } catch (e) {
      if (live.current) setActionError(hostErrorText(e, t));
    } finally {
      if (live.current) setBusy(null);
      void load();
    }
  };

  const configured = Boolean(host?.configured);
  const running = Boolean(host?.running);
  const name = host?.displayName || host?.deviceId || '';

  return (
    <div className="settings-section">
      <div className="section-head">
        <h4>{t('本机 Host', 'Local Host')}</h4>
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy !== null}>
          <RefreshCw size={13} aria-hidden /> {t('刷新', 'Refresh')}
        </button>
      </div>
      {host === undefined ? (
        <p className="status">{t('正在读取本机 Host 状态…', 'Reading local Host status…')}</p>
      ) : host === null ? (
        <p className="status">{t('本机 Host 不可用：', 'Local Host unavailable: ') + loadError}</p>
      ) : !configured ? (
        <p className="empty-state">{t('本机 Host 尚未配对；断开中心后可在连接页配对。', 'The local Host is not paired yet; pair it from the connect screen.')}</p>
      ) : (
        <>
          <div className="card-row">
            <span className={'conn-dot ' + (running ? 'online' : 'offline')} />
            <span className="profile-title">{running ? t('运行中', 'Running') : t('已停止', 'Stopped')}</span>
            {name && <span className="metadata">{name}</span>}
          </div>
          <div className="card-row">
            <span className="metadata">{t('开机自启', 'Start at login')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={host.autostart}
              aria-label={t('开机自启', 'Start at login')}
              className={'grok-toggle-switch' + (host.autostart ? ' checked' : '')}
              disabled={busy !== null}
              onClick={() => void run(host.autostart ? 'disable' : 'enable')}
            >
              <span className="grok-toggle-knob" />
            </button>
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== null}
              onClick={() => void run(running ? 'restart' : 'start')}
            >
              {busy === 'restart' || busy === 'start'
                ? t('处理中…', 'Working…')
                : running ? t('重启', 'Restart') : t('启动', 'Start')}
            </button>
          </div>
        </>
      )}
      {actionError && (
        <div className="error-banner" role="alert">
          {actionError}
          <button type="button" onClick={() => setActionError('')}>{t('关闭', 'Dismiss')}</button>
        </div>
      )}
    </div>
  );
}
