// 本机服务在常规设置挂载时查询。进程存在、任务就绪与中心在线各自取自原生状态。
import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useText } from '../../../web/src/ui';
import { hostControl, hostErrorText, hostStatus, type HostControlAction, type HostStatus } from './hostService';

const POLL_MS = 10_000;
type Translate = (zh: string, en: string) => string;

function boolText(value: boolean | null | undefined, t: Translate): string {
  if (value === true) return t('是', 'Yes');
  if (value === false) return t('否', 'No');
  return t('未知', 'Unknown');
}

export function HostServiceSection({ onDeviceId }: { onDeviceId?: (deviceId: string) => void }) {
  const t = useText();
  const [host, setHost] = useState<HostStatus | null>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<HostControlAction | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inFlight = useRef(false);
  const statusRead = useRef(0);
  const actionInFlight = useRef(false);
  const live = useRef(true);

  const load = useCallback(async (afterAction = false) => {
    if (!live.current || actionInFlight.current || (inFlight.current && !afterAction)) return;
    const read = ++statusRead.current;
    inFlight.current = true;
    const isCurrent = () => live.current && statusRead.current === read && !actionInFlight.current;
    try {
      const next = await hostStatus();
      if (!isCurrent()) return;
      setHost(next);
      setLoadError('');
      onDeviceId?.(next.configured ? next.deviceId ?? '' : '');
    } catch (error) {
      if (!isCurrent()) return;
      setHost(null);
      setLoadError(hostErrorText(error, t));
      onDeviceId?.('');
    } finally {
      if (statusRead.current === read) inFlight.current = false;
    }
  }, [onDeviceId, t]);

  useEffect(() => {
    live.current = true;
    void load();
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(onVisible, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const run = async (action: HostControlAction) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(action);
    setActionError('');
    try {
      await hostControl(action);
      if (live.current && action === 'remove') setConfirmRemove(false);
    } catch (error) {
      if (live.current) setActionError(hostErrorText(error, t));
    } finally {
      actionInFlight.current = false;
      if (live.current) {
        setBusy(null);
        void load(true);
      }
    }
  };

  const running = host?.running;
  const processLabel = running === true ? t('运行中', 'Running') : running === false ? t('已停止', 'Stopped') : t('状态未知', 'Unknown');
  const taskLabel = host?.hostPhase === 'closing' ? t('正在停止', 'Stopping')
    : host?.ready === true ? t('本机已就绪', 'Ready on this device')
    : host?.ready === false ? t('尚未就绪', 'Not ready') : t('状态未知', 'Unknown');
  const autoLabel = host?.autostartScope === 'user-login' || host?.platform === 'windows'
    ? t('登录后自动运行', 'Run at login')
    : host?.autostartScope === 'system-boot' || host?.platform === 'linux'
      ? t('开机时自动运行', 'Run at startup')
      : t('自动运行', 'Start automatically');

  return (
    <details className="settings-section settings-disclosure settings-device-runtime">
      <summary>
        <strong>{t('本机运行服务', 'Local runtime')}</strong>
        <span className="status">{host === undefined ? t('正在读取', 'Reading') : host?.configured ? processLabel : t('未就绪', 'Not ready')}</span>
      </summary>
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy !== null}>
          <RefreshCw size={13} aria-hidden /> {t('刷新状态', 'Refresh status')}
        </button>
      </div>
      {host === null && <p className="status">{t('暂时无法读取本机服务。', 'Could not read the local runtime.')}</p>}
      {host && !host.configured && (
        <p className="status">{host.centerUrl || host.deviceId || host.configError
          ? t('本机配置不完整，可在连接页重新配对。', 'Local setup is incomplete. Re-pair on the connection page.')
          : t('本机尚未配对，可从连接页开始。', 'This device is unpaired. Start on the connection page.')}</p>
      )}
      {host?.configured && (
        <>
          <div className="card-row">
            <span className="metadata">{t('运行进程', 'Process')}</span><strong>{processLabel}</strong>
            {host.displayName && <span className="metadata">{host.displayName}</span>}
          </div>
          <div className="card-row">
            <span className="metadata">{t('任务就绪', 'Task readiness')}</span><strong>{taskLabel}</strong>
            {host.online != null && <span className="metadata">{host.online ? t('中心在线', 'Center online') : t('中心离线', 'Center offline')}</span>}
          </div>
          <div className="card-row">
            <span className="metadata">{autoLabel}</span>
            <button
              type="button"
              role="switch"
              aria-checked={host.autostart ?? false}
              aria-label={autoLabel}
              className={'grok-toggle-switch' + (host.autostart ? ' checked' : '')}
              disabled={busy !== null || host.autostart == null}
              onClick={() => void run(host.autostart ? 'disable' : 'enable')}
            >
              <span className="grok-toggle-knob" />
            </button>
            {host.autostart == null && <span className="metadata">{t('未知', 'Unknown')}</span>}
          </div>
          <div className="dialog-actions">
            {running === false && <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void run('start')}>{busy === 'start' ? t('正在启动…', 'Starting…') : t('启动', 'Start')}</button>}
            {running === true && (
              <>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('restart')}>{busy === 'restart' ? t('正在重启…', 'Restarting…') : t('重启', 'Restart')}</button>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('stop')}>{busy === 'stop' ? t('正在停止…', 'Stopping…') : t('停止', 'Stop')}</button>
              </>
            )}
          </div>
        </>
      )}
      {(host || loadError) && (
        <details className="settings-diagnostics">
          <summary>{t('服务诊断', 'Runtime diagnostics')}</summary>
          {loadError && <p className="metadata">{loadError}</p>}
          {host && (
            <>
              {host.centerUrl && <p className="metadata">{t('配对中心', 'Paired center')} {host.centerUrl}</p>}
              <p className="metadata">{t('已登记服务', 'Service registered')} {boolText(host.service?.registered, t)}</p>
              {host.service?.state && <p className="metadata">{t('服务状态', 'Service state')} {host.service.state}</p>}
              {host.service?.startType && <p className="metadata">{t('启动类型', 'Start type')} {host.service.startType}</p>}
              {host.hostPhase && <p className="metadata">{t('运行阶段', 'Runtime phase')} {host.hostPhase}</p>}
              {host.centerState && <p className="metadata">{t('中心状态', 'Center state')} {host.centerState}</p>}
              {host.linger != null && <p className="metadata">linger {boolText(host.linger, t)}</p>}
            </>
          )}
          {host?.configured && (
            <div className="dialog-actions">
              {host.platform === 'windows' && (
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('setup-shower')}>
                  {busy === 'setup-shower' ? t('等待授权…', 'Awaiting approval…') : t('配置虚拟屏凭据', 'Configure virtual display credentials')}
                </button>
              )}
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                <Trash2 size={13} aria-hidden /> {t('移除服务', 'Remove service')}
              </button>
            </div>
          )}
        </details>
      )}
      {confirmRemove && (
        <div className="card-row" role="alert">
          <span className="metadata">{t('移除登记会停止本机服务，配对与数据仍可用于恢复。', 'Removing the registration stops the local runtime. Pairing and data can be used to restore it.')}</span>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('remove')}>
            {busy === 'remove' ? t('正在移除…', 'Removing…') : t('确认移除', 'Confirm removal')}
          </button>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>{t('取消', 'Cancel')}</button>
        </div>
      )}
      {actionError && <p className="error-banner" role="alert">{actionError}</p>}
    </details>
  );
}
