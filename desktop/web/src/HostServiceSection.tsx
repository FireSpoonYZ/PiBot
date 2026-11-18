// 设置弹窗共用本机服务状态。向用户展示单一的定性人话状态，底层阶段与排障统一收入折叠区。
import { Check, Copy, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Switch } from '../../../web/src/bot-settings/primitives';
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

interface QualitativeHostState {
  label: string;
  tone: 'online' | 'warn' | 'muted';
  reason: string;
  repairAction: 'start' | 'restart' | null;
}

function describeHostService(
  host: HostStatus | null | undefined,
  loadError: string,
  t: Translate,
): QualitativeHostState {
  if (host === undefined) {
    return { label: t('正在检测服务状态…', 'Checking local service…'), tone: 'muted', reason: '', repairAction: null };
  }
  if (host === null) {
    return {
      label: t('暂时无法读取本机服务', 'Unable to read local service'),
      tone: 'warn',
      reason: loadError || t('本机后台服务未响应，请尝试重启修复。', 'Local background service did not respond. Try restarting to repair.'),
      repairAction: 'restart',
    };
  }
  if (!host.configured) {
    return {
      label: t('尚未配对本机服务', 'Local service not paired'),
      tone: 'muted',
      reason: host.centerUrl || host.deviceId || host.configError
        ? t('本机配置不完整，请前往「中心连接」重新绑定。', 'Local configuration is incomplete. Rebind in Center Connection.')
        : t('本机尚未绑定到中心，请前往「中心连接」完成配对。', 'This computer is not bound to a center yet. Pair in Center Connection.'),
      repairAction: null,
    };
  }
  if (host.running === false) {
    return {
      label: t('服务已停止', 'Service stopped'),
      tone: 'warn',
      reason: t('后台服务未在运行，本机智能体和远程任务暂时不可用。', 'Background service is stopped; local agents and remote tasks are unavailable.'),
      repairAction: 'start',
    };
  }
  if (host.running === true && host.hostPhase === 'closing') {
    return {
      label: t('正在停止中', 'Stopping'),
      tone: 'warn',
      reason: t('后台服务正在退出，稍后可重新启动。', 'Background service is shutting down.'),
      repairAction: 'restart',
    };
  }
  if (host.running === true && host.ready === false) {
    return {
      label: t('未就绪', 'Not ready'),
      tone: 'warn',
      reason: t('后台进程已启动，但尚未进入可接收任务状态。', 'Background process started but is not yet ready for tasks.'),
      repairAction: 'restart',
    };
  }
  if (host.running === true && host.online === false) {
    return {
      label: t('与中心连接中断', 'Disconnected from center'),
      tone: 'warn',
      reason: t('本机服务正在运行，但暂未连接上中心服务器，请检查网络或重启服务。', 'Service is running but offline from center. Check network or restart service.'),
      repairAction: 'restart',
    };
  }
  if (host.running === true) {
    return {
      label: t('正常运行中', 'Running normally'),
      tone: 'online',
      reason: '',
      repairAction: null,
    };
  }
  return {
    label: t('状态未知', 'Status unknown'),
    tone: 'muted',
    reason: t('未能确认本机服务运行状态，可尝试重启修复。', 'Could not confirm service state. Try restarting to repair.'),
    repairAction: 'restart',
  };
}

export interface HostServiceSectionProps {
  service: ReturnType<typeof useHostService>;
  advancedNetwork?: ReactNode;
  diagnosticExtra?: Record<string, unknown>;
}

export function HostServiceSection({ service, advancedNetwork, diagnosticExtra }: HostServiceSectionProps) {
  const t = useText();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);
  const { host, loadError, actionError, busy, load, run } = service;
  const state = describeHostService(host, loadError, t);

  const autoLabel = host?.autostartScope === 'user-login' || host?.platform === 'windows' || host?.platform === 'macos'
    ? t('开机自动启动（登录后运行）', 'Start automatically at login')
    : t('开机自动启动', 'Start automatically at boot');

  const copyDiagnostics = () => {
    const payload = {
      capturedAt: new Date().toISOString(),
      host: host
        ? {
            configured: host.configured,
            running: host.running ?? null,
            ready: host.ready ?? null,
            online: host.online ?? null,
            hostPhase: host.hostPhase ?? null,
            centerState: host.centerState ?? null,
            platform: host.platform ?? null,
            autostart: host.autostart ?? null,
            autostartScope: host.autostartScope ?? null,
            autostartError: host.autostartError ?? null,
            linger: host.linger ?? null,
            service: host.service ?? null,
            pid: host.pid,
            hostPid: host.hostPid,
            centerUrl: host.centerUrl,
            deviceId: host.deviceId,
            controlUrl: host.controlUrl,
            logFile: host.logFile,
          }
        : null,
      loadError: loadError || null,
      ...diagnosticExtra,
    };
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(() => {
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 1800);
    }).catch(() => {});
  };

  return (
    <section className="settings-section host-service-section">
      <div className="settings-row-group">
        <div className="settings-row">
          <span className="settings-row-label">
            <span>{t('本机后台服务', 'Local background service')}</span>
            {host?.displayName && (
              <span className="metadata" style={{ display: 'block', fontSize: 12 }}>{host.displayName}</span>
            )}
          </span>
          <span className={`host-status-pill ${state.tone}`}>
            <span className="host-status-dot" aria-hidden />
            {state.label}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => void load()}
            disabled={busy !== null}
            aria-label={t('刷新状态', 'Refresh status')}
          >
            <RefreshCw size={14} aria-hidden />
          </button>
        </div>

        {host?.configured && (
          <div className="settings-row">
            <span className="settings-row-label">{autoLabel}</span>
            {host.autostart == null ? (
              <span className="metadata">{t('未知', 'Unknown')}</span>
            ) : (
              <Switch
                checked={host.autostart}
                label={autoLabel}
                disabled={busy !== null}
                onChange={(enabled) => void run(enabled ? 'enable' : 'disable')}
              />
            )}
          </div>
        )}
      </div>

      {state.reason && (
        <div className="host-repair-banner" role="status">
          <span className="metadata">{state.reason}</span>
          {state.repairAction && (
            <button
              type="button"
              className="primary-button"
              disabled={busy !== null}
              onClick={() => void run(state.repairAction!)}
            >
              <RotateCcw size={13} aria-hidden />
              {busy === 'start' || busy === 'restart'
                ? t('正在重启修复…', 'Restarting…')
                : t('一键重启修复', 'Restart & repair')}
            </button>
          )}
        </div>
      )}

      {host?.configured && host.autostartError?.code === 'AUTOSTART_STALE' && (
        <div className="card-row" role="alert">
          <span className="metadata">{t('PiBot 的位置或版本已变化，需要重新启用开机自动启动。', 'PiBot moved or updated; re-enable startup to repair it.')}</span>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('enable')}>
            {busy === 'enable' ? t('正在重新启用…', 'Re-enabling…') : t('重新启用', 'Re-enable')}
          </button>
        </div>
      )}

      {actionError && <p className="error-banner" role="alert">{actionError}</p>}

      <details className="settings-diagnostics">
        <summary>{t('高级网络与排障', 'Advanced network & troubleshooting')}</summary>
        <div className="settings-diagnostics-body">
          {(host || loadError) && (
            <div className="diagnostics-block">
              <h5>{t('底层服务状态', 'Low-level service diagnostics')}</h5>
              {loadError && <p className="metadata">{loadError}</p>}
              {host && (
                <div className="diagnostics-grid">
                  {host.centerUrl && <span className="metadata">{t('配对中心', 'Paired center')}: {host.centerUrl}</span>}
                  <span className="metadata">{t('运行阶段 (hostPhase)', 'Runtime phase (hostPhase)')}: {host.hostPhase ?? t('未知', 'Unknown')}</span>
                  <span className="metadata">{t('中心状态 (centerState)', 'Center state')}: {host.centerState ?? t('未知', 'Unknown')}</span>
                  <span className="metadata">{t('systemd / 服务登记', 'Service registration')}: {boolText(host.service?.registered, t)}</span>
                  {host.service?.state && <span className="metadata">{t('服务状态', 'Service state')}: {host.service.state}</span>}
                  {host.service?.startType && <span className="metadata">{t('启动类型', 'Start type')}: {host.service.startType}</span>}
                  {host.linger != null && <span className="metadata">linger: {boolText(host.linger, t)}</span>}
                </div>
              )}
              {host?.configured && (
                <div className="dialog-actions" style={{ marginTop: 8 }}>
                  {host.running === false && (
                    <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('start')}>
                      {busy === 'start' ? t('正在启动…', 'Starting…') : t('启动服务', 'Start service')}
                    </button>
                  )}
                  {host.running === true && (
                    <>
                      <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('restart')}>
                        {busy === 'restart' ? t('正在重启…', 'Restarting…') : t('重启服务', 'Restart service')}
                      </button>
                      <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('stop')}>
                        {busy === 'stop' ? t('正在停止…', 'Stopping…') : t('停止服务', 'Stop service')}
                      </button>
                    </>
                  )}
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                    <Trash2 size={13} aria-hidden /> {t('移除服务', 'Remove service')}
                  </button>
                </div>
              )}
              {confirmRemove && (
                <div className="card-row" role="alert" style={{ marginTop: 8 }}>
                  <span className="metadata">{t('移除登记会停止本机服务，配对与数据仍可用于恢复。', 'Removing registration stops the local runtime; data remains preserved.')}</span>
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('remove').then((removed) => { if (removed) setConfirmRemove(false); })}>
                    {busy === 'remove' ? t('正在移除…', 'Removing…') : t('确认移除', 'Confirm removal')}
                  </button>
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>{t('取消', 'Cancel')}</button>
                </div>
              )}
            </div>
          )}

          {host?.configured && host.platform === 'windows' && (
            <div className="diagnostics-block">
              <h5>{t('Windows 原生虚拟屏', 'Windows native virtual display')}</h5>
              <p className="metadata">{t('供桌面智能体在独立虚拟屏中运行；需要管理员授权与本机凭据。', 'Allows desktop agents to run in an isolated virtual display; requires admin approval.')}</p>
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('setup-shower')}>
                {busy === 'setup-shower' ? t('等待授权…', 'Awaiting approval…') : t('配置虚拟屏凭据', 'Configure virtual display')}
              </button>
            </div>
          )}

          {advancedNetwork}

          <div className="diagnostics-block">
            <button type="button" className="secondary-button" onClick={copyDiagnostics}>
              {copiedDiag ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              {copiedDiag ? t('已复制诊断信息', 'Copied diagnostics') : t('复制排障诊断信息', 'Copy troubleshooting diagnostics')}
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}
