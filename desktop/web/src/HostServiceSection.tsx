// 设置弹窗“本机 Host”分区：展示内置 Host 运行状态，提供重启/启动、自启开关与服务移除。
// 仅在挂载（设置弹窗常规页可见）且窗口可见时每 10s 轮询一次启动器 status。
// 中心认证/服务注册/进程运行/Host 在线分开显示；启动器未上报的字段不伪造。
import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useText } from '../../../web/src/ui';
import { hostControl, hostErrorText, hostStatus, type HostControlAction, type HostStatus } from './hostService';

const POLL_MS = 10_000;

/** 启动器 status 中可安全展示的布尔/文本字段；null/undefined 一律显示“未知”。 */
function hostOnlineText(host: HostStatus, t: (zh: string, en: string) => string): string {
  if (host.online === true) return t('在线', 'Online');
  if (host.online === false) return t('离线', 'Offline');
  return t('未知（以 Host 上报为准）', 'Unknown (as reported by Host)');
}
function boolText(value: boolean | null | undefined, t: (zh: string, en: string) => string): string {
  if (value === true) return t('是', 'Yes');
  if (value === false) return t('否', 'No');
  return t('未知', 'Unknown');
}

export function HostServiceSection() {
  const t = useText();
  /** undefined=读取中；null=不可用（见 loadError）。 */
  const [host, setHost] = useState<HostStatus | null>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<HostControlAction | null>(null);
  /** remove 需要二次确认：只移除服务登记，保留全部数据。 */
  const [confirmRemove, setConfirmRemove] = useState(false);
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
      if (action === 'remove') setConfirmRemove(false);
    } catch (e) {
      if (live.current) setActionError(hostErrorText(e, t));
    } finally {
      if (live.current) setBusy(null);
      void load();
    }
  };

  const configured = host?.configured;
  const running = host?.running;
  const name = host?.displayName || host?.deviceId || '';
  const autostartLabel = host?.autostartScope === 'user-login' ? t('登录后自动运行', 'Run at login') : t('开机自启', 'Start at boot');


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
      ) : configured === false ? (
        <p className="empty-state">{host.centerUrl || host.deviceId || host.configError
          ? t('本机 Host 配置不完整；可在连接页显式重新配对。', 'The local Host configuration is incomplete; re-pair it explicitly from the connect screen.')
          : t('本机 Host 尚未配对；断开中心后可在连接页配对。', 'The local Host is not paired yet; pair it from the connect screen.')}</p>
      ) : configured !== true ? (
        <p className="status">{t('本机 Host 配置状态未知。', 'Local Host configuration status is unknown.')}</p>
      ) : (
        <>
          <div className="card-row">
            <span className="profile-title">{t('中心认证', 'Center auth')}</span>
            <span className="metadata">
              {host.centerUrl
              ? t('已配对', 'Paired') + ' · ' + host.centerUrl
              : t('中心地址未知', 'Center address unknown')}
            {' · '}{host.centerState ?? t('认证状态未知', 'Auth state unknown')}
            </span>
          </div>
          <div className="card-row">
            <span className="profile-title">{t('服务注册', 'Service registration')}</span>
            <span className="metadata">{boolText(host.service?.registered, t)}</span>
            <span className="metadata">{t('状态', 'State')}: {host.service?.state ?? t('未知', 'Unknown')}</span>
            <span className="metadata">{t('启动类型', 'Start type')}: {host.service?.startType ?? t('未知', 'Unknown')}</span>
          </div>
          <div className="card-row">
            <span className={'conn-dot' + (running === true ? ' online' : running === false ? ' offline' : '')} />
            <span className="profile-title">{running === true ? t('运行中', 'Running') : running === false ? t('已停止', 'Stopped') : t('运行状态未知', 'Run state unknown')}</span>
            {name && <span className="metadata">{name}</span>}
          </div>
          <div className="card-row">
            <span className="profile-title">{t('Host 在线', 'Host online')}</span>
            <span className="metadata">{hostOnlineText(host, t)}</span>
            {host.hostPhase && <span className="metadata">{host.hostPhase}</span>}
            {host.centerState && <span className="metadata">{host.centerState}</span>}
          </div>
          <div className="card-row">
            <span className="metadata">{autostartLabel}</span>
            <button
              type="button"
              role="switch"
              aria-checked={host.autostart ?? false}
              aria-label={autostartLabel}
              className={'grok-toggle-switch' + (host.autostart ? ' checked' : '')}
              disabled={busy !== null || host.autostart == null}
              onClick={() => void run(host.autostart ? 'disable' : 'enable')}
            >
              <span className="grok-toggle-knob" />
            </button>
            {host.autostart == null && <span className="metadata">{t('未知', 'Unknown')}</span>}
          </div>
          {host.linger != null && (
            <div className="card-row">
              <span className="metadata">linger</span>
              <span className="metadata">{boolText(host.linger, t)}</span>
            </div>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== null || running == null}
              onClick={() => void run(running ? 'restart' : 'start')}
            >
              {busy === 'restart' || busy === 'start'
                ? t('处理中…', 'Working…')
                : running ? t('重启', 'Restart') : t('启动', 'Start')}
            </button>
            {running && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => void run('stop')}
              >
                {busy === 'stop' ? t('处理中…', 'Working…') : t('停止', 'Stop')}
              </button>
            )}
          </div>
          {host.platform === 'windows' && (
            <div className="dialog-actions">
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('setup-shower')}>
                {busy === 'setup-shower' ? t('等待授权或配置中…', 'Awaiting approval…') : t('重新配置虚拟屏凭据', 'Reconfigure virtual display credentials')}
              </button>
            </div>
          )}
          {confirmRemove ? (
            <div className="card-row" role="alert">
              <span className="metadata">
                {t('移除服务登记并停止 Host；保留全部配对与数据。此操作可重新配对恢复。', 'Removes the service registration and stops the Host; pairing and data are kept. You can pair again to restore.')}
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => void run('remove')}
              >
                {busy === 'remove' ? t('处理中…', 'Working…') : t('确认移除', 'Confirm remove')}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => setConfirmRemove(false)}
              >
                {t('取消', 'Cancel')}
              </button>
            </div>
          ) : (
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={13} aria-hidden /> {t('移除服务', 'Remove service')}
              </button>
            </div>
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
