// 设置弹窗共用本机服务状态。进程存在、任务就绪与中心在线各自取自原生状态。
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

export function useHostService() {
  const t = useText();
  const [host, setHost] = useState<HostStatus | null>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<HostControlAction | null>(null);
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
    } catch (error) {
      if (!isCurrent()) return;
      setHost(null);
      setLoadError(hostErrorText(error, t));
    } finally {
      if (statusRead.current === read) inFlight.current = false;
    }
  }, [t]);

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
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setBusy(action);
    setActionError('');
    try {
      await hostControl(action);
      return true;
    } catch (error) {
      if (live.current) setActionError(hostErrorText(error, t));
      return false;
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
  const summary = host === undefined ? t('正在读取', 'Reading')
    : host === null ? t('无法读取', 'Unavailable')
    : !host.configured ? t('未就绪', 'Not ready')
    : processLabel;
  return { host, loadError, actionError, busy, load, run, summary, processLabel };
}

export function HostServiceSection({ service }: { service: ReturnType<typeof useHostService> }) {
  const t = useText();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { host, loadError, actionError, busy, load, run, summary, processLabel } = service;
  const running = host?.running;
  const taskLabel = host?.hostPhase === 'closing' ? t('正在停止', 'Stopping')
    : host?.ready === true ? t('本机已就绪', 'Ready on this device')
    : host?.ready === false ? t('尚未就绪', 'Not ready') : t('状态未知', 'Unknown');
  const autoLabel = host?.autostartScope === 'user-login' || host?.platform === 'windows' || host?.platform === 'macos'
    ? t('登录后自动运行', 'Run at login')
    : host?.autostartScope === 'system-boot' || host?.platform === 'linux'
      ? t('开机时自动运行', 'Run at startup')
      : t('自动运行', 'Start automatically');

  return (
    <section className="settings-section">
      {host === undefined && <p className="metadata" role="status">{summary}</p>}
      {host === null && <p className="status">{t('暂时无法读取本机服务。', 'Could not read the local runtime.')}</p>}
      {host && !host.configured && (
        <p className="status">{host.centerUrl || host.deviceId || host.configError
          ? t('本机配置不完整，可在连接页重新配对。', 'Local setup is incomplete. Re-pair on the connection page.')
          : t('本机尚未配对，可从连接页开始。', 'This device is unpaired. Start on the connection page.')}</p>
      )}
      {host?.configured && (
        <div className="settings-row-group">
          <div className="settings-row">
            <span className="settings-row-label">{host.displayName || t('运行进程', 'Process')}</span>
            <span className={running ? 'status online' : 'metadata'}>{processLabel}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t('任务就绪', 'Task readiness')}</span>
            <span className="metadata">{taskLabel}</span>
          </div>
          {host.online != null && (
            <div className="settings-row">
              <span className="settings-row-label">{t('中心连接', 'Center connection')}</span>
              <span className="metadata">{host.online ? t('在线', 'Online') : t('离线', 'Offline')}</span>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-row-label">{autoLabel}</span>
            {host.autostart == null ? <span className="metadata">{t('未知', 'Unknown')}</span> : (
              <button
                type="button"
                role="switch"
                aria-checked={host.autostart}
                aria-label={autoLabel}
                className={'grok-toggle-switch' + (host.autostart ? ' checked' : '')}
                disabled={busy !== null}
                onClick={() => void run(host.autostart ? 'disable' : 'enable')}
              >
                <span className="grok-toggle-knob" />
              </button>
            )}
          </div>
        </div>
      )}
      {host?.configured && host.autostartError?.code === 'AUTOSTART_STALE' && (
        <div className="card-row" role="alert">
          <span className="metadata">{t('PiBot 的位置或版本已变化，需要重新启用登录后自动运行。', 'PiBot was moved or changed; turn run at login on again to repair it.')}</span>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('enable')}>
            {busy === 'enable' ? t('正在重新启用…', 'Re-enabling…') : t('重新启用', 'Re-enable')}
          </button>
        </div>
      )}
      <div className="dialog-actions">
        {host?.configured && running === false && <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void run('start')}>{busy === 'start' ? t('正在启动…', 'Starting…') : t('启动服务', 'Start service')}</button>}
        {host?.configured && running === true && (
          <>
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('restart')}>{busy === 'restart' ? t('正在重启…', 'Restarting…') : t('重启服务', 'Restart service')}</button>
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('stop')}>{busy === 'stop' ? t('正在停止…', 'Stopping…') : t('停止服务', 'Stop service')}</button>
          </>
        )}
        <button type="button" className="icon-button" onClick={() => void load()} disabled={busy !== null} aria-label={t('刷新状态', 'Refresh status')}>
          <RefreshCw size={15} aria-hidden />
        </button>
      </div>
      {(host || loadError) && (
        <details className="settings-diagnostics">
          <summary>{t('服务诊断与维护', 'Runtime diagnostics and maintenance')}</summary>
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
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('remove').then(removed => { if (removed) setConfirmRemove(false); })}>
            {busy === 'remove' ? t('正在移除…', 'Removing…') : t('确认移除', 'Confirm removal')}
          </button>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>{t('取消', 'Cancel')}</button>
        </div>
      )}
      {actionError && <p className="error-banner" role="alert">{actionError}</p>}
    </section>
  );
}
