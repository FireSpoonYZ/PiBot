// 本机后台服务状态与控制：按 active 门控 10s 轮询，主行保持单一 Live Readiness Row，底层诊断、日志与虚拟屏收纳进折叠区。
import { Check, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Switch } from '../../../web/src/bot-settings/primitives';
import { ActionBar, Button, Dialog } from '../../../web/src/components/ui';
import { ErrorNotice, useText } from '../../../web/src/ui';
import { hostControl, hostErrorText, hostStatus, type HostControlAction, type HostStatus } from './hostService';

const POLL_MS = 10_000;
type Translate = (zh: string, en: string) => string;

function boolText(value: boolean | null | undefined, t: Translate): string {
  if (value === true) return t('是', 'Yes');
  if (value === false) return t('否', 'No');
  return t('未知', 'Unknown');
}

export function useHostService(active = true) {
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
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(onVisible, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, load]);

  const run = useCallback(async (action: HostControlAction) => {
    if (!live.current || actionInFlight.current) return false;
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
  }, [load, t]);

  const clearActionError = useCallback(() => {
    if (live.current) setActionError('');
  }, []);

  const running = host?.running;
  const processLabel = running === true ? t('运行中', 'Running') : running === false ? t('已停止', 'Stopped') : t('状态未知', 'Unknown');
  const summary = host === undefined ? t('正在读取', 'Reading')
    : host === null ? t('无法读取', 'Unavailable')
    : !host.configured ? t('未就绪', 'Not ready')
    : processLabel;
  return { host, loadError, actionError, clearActionError, busy, load, run, summary, processLabel };
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
      reason: loadError || t('本机后台服务未响应，请点击「重启服务」尝试恢复。', 'Local background service did not respond. Restart the service to recover.'),
      repairAction: 'restart',
    };
  }
  if (!host.configured) {
    return {
      label: t('尚未配对本机服务', 'Local service not paired'),
      tone: 'muted',
      reason: host.centerUrl || host.deviceId || host.configError
        ? t('本机配置不完整，请先切换或重新连接中心以完成配对。', 'Local configuration is incomplete. Switch or reconnect the center to complete pairing.')
        : t('本机尚未绑定到中心，请先完成中心配对。', 'This computer is not bound to a center yet. Pair it with a center first.'),
      repairAction: null,
    };
  }
  if (host.running === false) {
    return {
      label: t('服务已停止', 'Service stopped'),
      tone: 'warn',
      reason: host.startupError
        ? `${t('自动启动失败。', 'Automatic startup failed.')} ${hostErrorText(host.startupError, t)} ${t('可点击「启动服务」重试。', 'Select Start service to retry.')}`
        : t('后台服务未在运行，本机智能体与远程任务暂时不可用，请点击「启动服务」。', 'Background service is stopped; local agents and remote tasks are unavailable. Start the service to resume.'),
      repairAction: 'start',
    };
  }
  if (host.running === true && host.hostPhase === 'closing') {
    return {
      label: t('正在停止中', 'Stopping'),
      tone: 'warn',
      reason: t('后台服务正在退出，稍后可点击「重启服务」。', 'Background service is shutting down. Restart it shortly.'),
      repairAction: 'restart',
    };
  }
  if (host.running === true && host.ready === false) {
    return {
      label: t('未就绪', 'Not ready'),
      tone: 'warn',
      reason: t('后台进程已启动，但尚未进入可接收任务状态，可点击「重启服务」恢复。', 'Background process started but is not yet ready for tasks. Restart the service to recover.'),
      repairAction: 'restart',
    };
  }
  if (host.running === true && host.online === false) {
    return {
      label: t('与中心连接中断', 'Disconnected from center'),
      tone: 'warn',
      reason: t('本机服务正在运行，但暂未连接上中心服务器，请检查网络或点击「重启服务」。', 'Service is running but offline from center. Check your network or restart the service.'),
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
    reason: t('未能确认本机服务运行状态，可点击「重启服务」恢复。', 'Could not confirm service state. Restart the service to recover.'),
    repairAction: 'restart',
  };
}

export interface HostServiceSectionProps {
  service?: ReturnType<typeof useHostService>;
  active?: boolean;
  advancedNetwork?: ReactNode;
  diagnosticExtra?: Record<string, unknown>;
}

export function HostServiceSection({
  service,
  active = true,
  advancedNetwork,
  diagnosticExtra,
}: HostServiceSectionProps) {
  const t = useText();
  const internalService = useHostService(!service && active);
  const resolvedService = service ?? internalService;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);
  const mountedRef = useRef(true);
  const copyDiagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { host, loadError, actionError, clearActionError, busy, load, run } = resolvedService;
  const state = describeHostService(host, loadError, t);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyDiagTimerRef.current !== null) {
        clearTimeout(copyDiagTimerRef.current);
        copyDiagTimerRef.current = null;
      }
    };
  }, []);

  const autoLabel = host?.autostartScope === 'user-login' || host?.platform === 'windows' || host?.platform === 'macos'
    ? t('开机自动启动（登录后运行）', 'Start automatically at login')
    : t('开机自动启动', 'Start automatically at boot');

  const primaryAction: {
    action: 'start' | 'restart';
    label: string;
    busyLabel: string;
    emphasize: boolean;
  } | null = host?.configured && host.running === false
    ? {
        action: 'start',
        label: t('启动服务', 'Start service'),
        busyLabel: t('正在启动…', 'Starting…'),
        emphasize: true,
      }
    : (host?.configured || host === null)
      ? {
          action: 'restart',
          label: t('重启服务', 'Restart service'),
          busyLabel: t('正在重启…', 'Restarting…'),
          emphasize: state.repairAction !== null,
        }
      : null;

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
      if (!mountedRef.current) return;
      setCopiedDiag(true);
      if (copyDiagTimerRef.current !== null) clearTimeout(copyDiagTimerRef.current);
      copyDiagTimerRef.current = setTimeout(() => {
        copyDiagTimerRef.current = null;
        if (mountedRef.current) setCopiedDiag(false);
      }, 1800);
    }).catch(() => {});
  };

  return (
    <section className="settings-section host-service-section">
      <div className="settings-row-group">
        <div className="settings-row">
          <span className="settings-row-label">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className={`host-status-pill ${state.tone}`} aria-hidden>
                <span className="host-status-dot" />
              </span>
              <span>{t('本机后台服务', 'Local background service')}</span>
            </span>
            <span className="metadata" style={{ display: 'block', paddingLeft: '16px' }}>
              {state.label}
              {host?.displayName ? ` · ${host.displayName}` : ''}
            </span>
          </span>
          {primaryAction && (
            <button
              type="button"
              className={primaryAction.emphasize ? 'primary-button' : 'secondary-button'}
              disabled={busy !== null}
              onClick={() => void run(primaryAction.action)}
            >
              {busy === primaryAction.action ? primaryAction.busyLabel : primaryAction.label}
            </button>
          )}
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
        </div>
      )}

      {host?.configured && host.autostartError?.code === 'AUTOSTART_STALE' && (
        <div className="host-repair-banner" role="alert">
          <span className="metadata">
            {t('PiBot 的位置或版本已变化，需要重新启用开机自动启动。', 'PiBot moved or updated; re-enable startup to repair it.')}
          </span>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('enable')}>
            {busy === 'enable' ? t('正在重新启用…', 'Re-enabling…') : t('重新启用自启动', 'Re-enable startup')}
          </button>
        </div>
      )}

      {!confirmRemove && (
        <ErrorNotice compact error={actionError} onDismiss={clearActionError} />
      )}

      <details className="settings-diagnostics">
        <summary>{t('服务诊断、日志与高级控制', 'Diagnostics, logs & advanced controls')}</summary>
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
                  <span className="metadata">{t('服务登记', 'Service registration')}: {boolText(host.service?.registered, t)}</span>
                  {host.service?.state && <span className="metadata">{t('服务状态', 'Service state')}: {host.service.state}</span>}
                  {host.service?.startType && <span className="metadata">{t('启动类型', 'Start type')}: {host.service.startType}</span>}
                  {host.linger != null && <span className="metadata">linger: {boolText(host.linger, t)}</span>}
                  {host.pid != null && <span className="metadata">PID: {host.pid}</span>}
                  {host.hostPid != null && <span className="metadata">Host PID: {host.hostPid}</span>}
                  {host.logFile && <span className="metadata">{t('日志文件', 'Log file')}: <code>{host.logFile}</code></span>}
                </div>
              )}
              <div className="dialog-actions" style={{ marginTop: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== null}
                  onClick={() => void load()}
                >
                  <RefreshCw size={13} aria-hidden />
                  {t('刷新状态', 'Refresh status')}
                </button>
                {host?.configured && host.running === true && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy !== null}
                    onClick={() => void run('stop')}
                  >
                    {busy === 'stop' ? t('正在停止…', 'Stopping…') : t('停止服务', 'Stop service')}
                  </button>
                )}
                {host?.configured && (
                  <button
                    type="button"
                    className="secondary-button danger-outline"
                    disabled={busy !== null}
                    onClick={() => {
                      clearActionError();
                      setConfirmRemove(true);
                    }}
                  >
                    <Trash2 size={13} aria-hidden />
                    {t('移除服务登记', 'Remove service')}
                  </button>
                )}
              </div>
            </div>
          )}

          {host?.configured && host.platform === 'windows' && (
            <div className="diagnostics-block">
              <h5>{t('Windows 原生虚拟屏', 'Windows native virtual display')}</h5>
              <p className="metadata">
                {t('供桌面智能体在独立虚拟屏中运行；需要管理员授权与本机凭据。', 'Allows desktop agents to run in an isolated virtual display; requires admin approval.')}
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => void run('setup-shower')}
              >
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

      <Dialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!open && busy !== 'remove') {
            setConfirmRemove(false);
            clearActionError();
          }
        }}
        title={t('移除本机服务登记', 'Remove local service registration')}
        overlayClassName="bs-confirm-overlay"
        className="bs-confirm-dialog"
        closeDisabled={busy === 'remove'}
      >
        <p className="secondary">
          {t('移除登记会立即停止本机后台服务；您的配对凭据与对话数据会保留，后续仍可重新启用。', 'Removing registration immediately stops the local background service. Your pairing credentials and chat data are preserved for recovery.')}
        </p>
        <ErrorNotice compact error={actionError} onDismiss={clearActionError} />
        <ActionBar align="end" className="ui-confirm-actions">
          <Button
            variant="secondary"
            disabled={busy === 'remove'}
            onClick={() => {
              setConfirmRemove(false);
              clearActionError();
            }}
          >
            {t('取消', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy === 'remove'}
            disabled={busy !== null}
            onClick={() => {
              void run('remove').then((removed) => {
                if (!mountedRef.current) return;
                if (removed) setConfirmRemove(false);
              });
            }}
          >
            {t('确认移除服务', 'Remove service')}
          </Button>
        </ActionBar>
      </Dialog>
    </section>
  );
}
