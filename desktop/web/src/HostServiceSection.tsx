// 设置弹窗“本机 Host”分区：展示内置 Host 运行/就绪状态，提供重启/启动、登录自启开关，
// 以及 Windows 原生虚拟屏凭据的配置入口。仅在挂载且窗口可见时每 10s 轮询一次启动器 status。
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useText } from '../../../web/src/ui';
import { hostControl, hostErrorText, hostStatus, hostWarningText, type HostControlAction, type HostStatus } from './hostService';

const POLL_MS = 10_000;

export function HostServiceSection() {
  const t = useText();
  /** undefined=读取中；null=不可用（见 loadError）。 */
  const [host, setHost] = useState<HostStatus | null>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<HostControlAction | null>(null);
  const [showerOutcome, setShowerOutcome] = useState('');
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

  /** 重新录入虚拟屏凭据：原生侧会弹 UAC/凭据框并短暂停止本机 Host，结束后恢复。 */
  const runSetupShower = async () => {
    if (busy) return;
    setBusy('setup-shower');
    setActionError('');
    setShowerOutcome('');
    try {
      const result = await hostControl('setup-shower');
      const ok = result.configured === true && result.verified === true;
      if (live.current) {
        setShowerOutcome(
          ok
            ? t('虚拟屏已配置并通过验证。', 'Virtual display configured and verified.')
            : t('虚拟屏配置已结束，但未完成验证。', 'Virtual display setup finished without completing verification.'),
        );
      }
    } catch (e) {
      if (live.current) setActionError(hostErrorText(e, t));
    } finally {
      if (live.current) setBusy(null);
      void load();
    }
  };

  const configured = Boolean(host?.configured);
  const running = Boolean(host?.running);
  const ready = Boolean(host?.ready);
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
            <span className={'conn-dot' + (ready ? ' online' : running ? '' : ' offline')} />
            <span className="profile-title">
              {ready ? t('运行中', 'Running') : running ? t('启动中…', 'Starting…') : t('已停止', 'Stopped')}
            </span>
            {name && <span className="metadata">{name}</span>}
          </div>
          <div className="card-row">
            <span className="metadata">{t('登录后自动运行', 'Run at login')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={host.autostart}
              aria-label={t('登录后自动运行', 'Run at login')}
              className={'grok-toggle-switch' + (host.autostart ? ' checked' : '')}
              disabled={busy !== null}
              onClick={() => void run(host.autostart ? 'disable' : 'enable')}
            >
              <span className="grok-toggle-knob" />
            </button>
          </div>
          <p className="metadata">
            {t('仅安装本机的用户登录后运行；关闭窗口不会停止本机 Host。', 'Runs only after the installing user signs in; closing the window does not stop the local Host.')}
          </p>
          {host.autostartError && (
            <p className="metadata">{t('登录自启动异常：', 'Run-at-login issue: ') + hostWarningText(host.autostartError)}</p>
          )}
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
            {host.platform === 'windows' && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => void runSetupShower()}
              >
                {busy === 'setup-shower' ? t('等待授权或配置中…', 'Awaiting approval or configuring…') : t('重新配置虚拟屏凭据', 'Reconfigure virtual display credentials')}
              </button>
            )}
          </div>
          {host.platform === 'windows' && (
            <p className="metadata">
              {t('虚拟屏供桌面智能体在独立会话中运行；重新配置需要管理员授权，期间会短暂停止本机 Host。', 'The virtual display runs desktop agents in a separate session; reconfiguring needs admin approval and briefly stops the local Host.')}
            </p>
          )}
          {showerOutcome && <p className="metadata">{showerOutcome}</p>}
          {(busy === 'enable' || busy === 'disable' || busy === 'setup-shower') && (
            <p className="metadata">{t('正在等待管理员授权或操作完成，可能需要几分钟…', 'Waiting for administrator approval or completion — this may take a few minutes…')}</p>
          )}
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
