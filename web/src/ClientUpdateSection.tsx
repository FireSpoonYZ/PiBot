// 设置页“客户端更新”分区：桌面 SettingsPanel 与 Android HubSettingsView 共用。
// 只渲染原生状态与用户明确操作；不自动下载、不后台静默安装。
// 固定结构（状态行、进度条、状态槽、操作区、更新说明开关常驻）保证阶段切换零跳动。
import { CheckCircle2, ChevronDown, Download, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useText } from './ui';
import { Section } from './bot-settings/primitives';
import { CLIENT_UPDATE_OPEN_EVENT, formatUpdateBytes, updateProgress, type ClientUpdatePhase } from './ClientUpdate';
import { Dialog } from './components/ui/dialog';
import { useClientUpdate, type ClientUpdateContextValue } from './ClientUpdateProvider';
import { LabelStack, ReservedSlot, SmoothExpand } from './layout';
import { useNotice } from './notice';
import './ClientUpdate.css';

const CLIENT_UPDATE_ERROR_NOTICE_ID = 'client-update-error';

type TranslateFn = (zh: string, en: string) => string;

function phaseLabel(phase: ClientUpdatePhase, t: TranslateFn): string {
  switch (phase) {
    case 'checking': return t('正在检查更新…', 'Checking for updates…');
    case 'available': return t('发现新版本', 'Update available');
    case 'up-to-date': return t('已是最新版本', 'Up to date');
    case 'downloading': return t('正在下载更新…', 'Downloading update…');
    case 'downloaded': return t('更新已下载', 'Update downloaded');
    case 'waiting-permission': return t('等待系统安装权限', 'Waiting for install permission');
    case 'waiting-install': return t('等待系统确认安装', 'Waiting for system confirmation');
    case 'installing': return t('正在安装更新…', 'Installing update…');
    case 'complete': return t('更新完成', 'Update complete');
    case 'cancelled': return t('已取消', 'Cancelled');
    case 'error': return t('更新出错', 'Update error');
    case 'waiting-tasks': return t('有任务正在运行', 'Tasks are running');
    default: return t('尚未检查', 'Not checked yet');
  }
}

export function useClientUpdateSummary(): string | undefined {
  const t = useText();
  const update = useClientUpdate();
  if (!update?.ready) return undefined;
  const { status, pending, actionError } = update;
  if (pending === 'install') return phaseLabel('installing', t);
  if (pending === 'download' || status?.phase === 'downloading') {
    const progress = updateProgress(status);
    return t('下载中', 'Downloading') + (progress === null ? '' : ' · ' + progress + '%');
  }
  if (pending === 'check') return phaseLabel('checking', t);
  if (actionError) return phaseLabel('error', t);
  if (!status || status.phase === 'idle' || status.phase === 'up-to-date') return status?.currentVersion;
  return phaseLabel(status.phase, t);
}

export function MobileClientUpdatePrompt({ active, onOpenUpdates }: { active: boolean; onOpenUpdates(): void }) {
  const t = useText();
  const update = useClientUpdate();
  const [visible, setVisible] = useState(() => !document.hidden);
  const [dismissedRelease, setDismissedRelease] = useState('');
  const release = update?.ready && !update.pending && update.status?.phase === 'available' ? update.status.release : undefined;
  const releaseKey = release ? `${release.id}:${release.versionCode ?? release.version}` : '';
  const open = active && visible && Boolean(releaseKey) && releaseKey !== dismissedRelease;
  const dismiss = () => setDismissedRelease(releaseKey);

  useEffect(() => {
    const syncVisibility = () => setVisible(!document.hidden);
    const reopen = () => setDismissedRelease('');
    document.addEventListener('visibilitychange', syncVisibility);
    window.addEventListener(CLIENT_UPDATE_OPEN_EVENT, reopen);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener(CLIENT_UPDATE_OPEN_EVENT, reopen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleBack = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setDismissedRelease(releaseKey);
    };
    window.addEventListener('app-back', handleBack, true);
    return () => window.removeEventListener('app-back', handleBack, true);
  }, [open, releaseKey]);

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) dismiss(); }} title={t('发现新版本', 'Update available')}>
      <p className="secondary">
        {t(`PiBot ${release?.version ?? ''} 已发布。现在下载更新吗？`, `PiBot ${release?.version ?? ''} is available. Download the update now?`)}
      </p>
      <div className="dialog-actions">
        <button type="button" className="quiet-button" onClick={dismiss}>{t('稍后', 'Later')}</button>
        <button type="button" className="button" onClick={() => {
          dismiss();
          update?.download();
          onOpenUpdates();
        }}>{t('下载更新', 'Download update')}</button>
      </div>
    </Dialog>
  );
}

function parseActiveTaskCount(waiting: boolean, message?: string): number | null {
  const taskMatch = waiting && /^(\d+) host task\(s\) still active$/.exec(message ?? '');
  const count = taskMatch ? Number(taskMatch[1]) : NaN;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function useClientUpdateErrorNotice(params: {
  actionError: string;
  phase: ClientUpdatePhase;
  statusMessage?: string;
  ready: boolean;
  check: () => void;
  dismissError: () => void;
  t: TranslateFn;
}) {
  const { actionError, phase, statusMessage, ready, check, dismissError, t } = params;
  const { notify, dismiss } = useNotice();
  const prevSigRef = useRef('');
  const callbacksRef = useRef({ check, dismissError });
  callbacksRef.current = { check, dismissError };

  const activeError = actionError || (phase === 'error' ? (statusMessage ?? '') : '');
  const hasError = Boolean(actionError) || phase === 'error';
  const errorSig = actionError
    ? `action:${actionError}`
    : phase === 'error'
      ? `phase:${statusMessage ?? ''}`
      : '';

  useEffect(() => {
    if (!hasError) {
      if (prevSigRef.current) {
        prevSigRef.current = '';
        dismiss(CLIENT_UPDATE_ERROR_NOTICE_ID);
      }
      return;
    }
    if (errorSig === prevSigRef.current) return;
    prevSigRef.current = errorSig;
    const detail = activeError || t('更新过程中发生错误，请稍后重试。', 'An error occurred during update. Please try again.');
    notify({
      id: CLIENT_UPDATE_ERROR_NOTICE_ID,
      tone: 'error',
      title: t('客户端更新失败', 'Client update failed'),
      detail,
      action: ready
        ? {
            label: t('重试', 'Retry'),
            onClick: () => {
              dismiss(CLIENT_UPDATE_ERROR_NOTICE_ID);
              callbacksRef.current.dismissError();
              callbacksRef.current.check();
            },
          }
        : undefined,
    });
  }, [hasError, errorSig, activeError, ready, notify, dismiss, t]);
}

function UpdateSectionBody({
  update,
  variant,
}: {
  update: ClientUpdateContextValue;
  variant: 'desktop' | 'mobile';
}) {
  const t = useText();
  const notesPanelId = useId();
  const { status, pending, ready, actionError, dismissError, check, download, install, cancel } = update;
  const [confirmStop, setConfirmStop] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const isDesktop = variant === 'desktop';
  const primaryBtn = isDesktop ? 'primary-button cu-action-btn' : 'hst-btn is-primary cu-action-btn';
  const secondaryBtn = isDesktop ? 'secondary-button cu-action-btn' : 'hst-btn cu-action-btn';
  const dangerBtn = isDesktop ? 'primary-button danger-button cu-action-btn' : 'hst-btn is-danger cu-action-btn';

  const rawPhase: ClientUpdatePhase = status?.phase ?? (pending === 'check' ? 'checking' : 'idle');
  const checking = pending === 'check' || rawPhase === 'checking';
  const downloading = pending === 'download' || rawPhase === 'downloading';
  const installing = pending === 'install' || rawPhase === 'installing';
  const cancelling = pending === 'cancel';
  const effectivePhase: ClientUpdatePhase = installing
    ? 'installing'
    : downloading
      ? 'downloading'
      : checking
        ? 'checking'
        : rawPhase;

  const waiting = effectivePhase === 'waiting-tasks';
  const busy = pending !== null || !ready;
  const canCancelAction = ready && (pending === null || pending === 'check' || pending === 'download');
  const progress = updateProgress(status);
  const release = status?.release;
  const sizeText = formatUpdateBytes(status?.totalBytes ?? release?.size);
  const taskCount = parseActiveTaskCount(waiting, status?.message);

  const showRelease = Boolean(
    release &&
      (isDesktop
        ? true
        : effectivePhase === 'available' ||
          effectivePhase === 'downloading' ||
          effectivePhase === 'downloaded' ||
          effectivePhase === 'waiting-tasks' ||
          effectivePhase === 'waiting-permission' ||
          effectivePhase === 'waiting-install' ||
          effectivePhase === 'installing'),
  );
  const hasNotes = Boolean(
    release?.notes &&
      (isDesktop
        ? true
        : effectivePhase !== 'up-to-date' && effectivePhase !== 'idle' && effectivePhase !== 'checking'),
  );

  useEffect(() => {
    setConfirmStop(false);
  }, [ready, effectivePhase, release?.id, status?.message]);

  useEffect(() => {
    if (!hasNotes) setNotesOpen(false);
  }, [hasNotes, release?.id]);

  useClientUpdateErrorNotice({
    actionError,
    phase: effectivePhase,
    statusMessage: status?.message,
    ready,
    check,
    dismissError,
    t,
  });

  // 稳定按钮标签候选（LabelStack 锁定最大宽度，阶段切换不跳动）
  const labelCheck = t('检查更新', 'Check for updates');
  const labelChecking = t('检查中…', 'Checking…');
  const labelDownload = t('下载更新', 'Download update');
  const labelDownloading = t('下载中…', 'Downloading…');
  const labelInstall = t('安装更新', 'Install update');
  const labelInstalling = t('安装中…', 'Installing…');
  const labelRetry = t('重试', 'Retry');
  const labelContinueInstall = t('继续安装', 'Continue installation');
  const labelReopenInstaller = t('重新打开安装器', 'Reopen installer');
  const labelRecheck = t('重新检查', 'Re-check');
  const labelCancel = t('取消', 'Cancel');
  const labelCancelCheck = t('取消检查', 'Cancel check');
  const labelCancelDownload = t('取消下载', 'Cancel download');
  const labelCancelInstall = t('取消安装', 'Cancel installation');
  const labelCancelWaiting = t('取消等待', 'Cancel waiting');
  const labelCancelling = t('取消中…', 'Cancelling…');
  const labelShowNotes = t('查看更新说明', 'Show release notes');
  const labelHideNotes = t('收起更新说明', 'Hide release notes');

  const statusSummary = installing
    ? t('正在安装', 'Installing')
    : downloading
      ? t('正在下载', 'Downloading') + (progress === null ? '' : ' · ' + progress + '%')
      : phaseLabel(effectivePhase, t);

  const releaseSummary = showRelease && release
    ? release.version + (sizeText ? ' · ' + sizeText : '')
    : '—';

  const progressActive = downloading || installing;
  const progressIndeterminate = installing || (downloading && progress === null);
  const fillPercent = progressActive
    ? (progress ?? 0)
    : effectivePhase === 'downloaded' ||
        effectivePhase === 'complete' ||
        effectivePhase === 'waiting-tasks' ||
        effectivePhase === 'waiting-permission' ||
        effectivePhase === 'waiting-install'
      ? 100
      : 0;

  // 固定高度状态槽文案：覆盖未就绪、错误、进度、安装引导与完成提示
  let statusMessageText = '';
  let statusMessageKey = 'empty';
  let statusMessageTone: 'muted' | 'meta' | 'error' = 'muted';

  if (!ready) {
    statusMessageText = t('连接中心后可检查更新。', 'Connect to the center to check for updates.');
    statusMessageKey = 'not-ready';
  } else if (actionError) {
    statusMessageText = actionError;
    statusMessageKey = `action-error:${actionError}`;
    statusMessageTone = 'error';
  } else if (effectivePhase === 'error') {
    statusMessageText = status?.message || t('更新出错，请重试。', 'Update failed. Please try again.');
    statusMessageKey = `phase-error:${status?.message ?? ''}`;
    statusMessageTone = 'error';
  } else if (installing) {
    statusMessageText = isDesktop
      ? t('系统正在处理安装。', 'The system is processing the installation.')
      : t('安装已开始，此阶段无法在应用内取消。', 'Installation has started and cannot be cancelled here.');
    statusMessageKey = 'installing';
  } else if (downloading) {
    const downloadedText = formatUpdateBytes(status?.downloadedBytes);
    const totalText = formatUpdateBytes(status?.totalBytes ?? (isDesktop ? release?.size : undefined));
    if (downloadedText || progress !== null) {
      const prefix = isDesktop ? t('下载', 'Download') + ' ' : '';
      const bytesPart = downloadedText + (totalText ? ' / ' + totalText : '');
      const pctPart = progress !== null ? (bytesPart ? ' · ' : '') + progress + '%' : '';
      statusMessageText = `${prefix}${bytesPart}${pctPart}`.trim();
    } else {
      statusMessageText = t('正在下载更新…', 'Downloading update…');
    }
    statusMessageKey = 'downloading';
    statusMessageTone = 'meta';
  } else if (waiting) {
    const runningText = taskCount === null
      ? t('还有本机任务在运行。', 'Local tasks are still running.')
      : t(`最近一次检查还有 ${taskCount} 个本机任务在运行。`, `${taskCount} local tasks were running at the last check.`);
    statusMessageText = `${runningText} ${t('任务结束后可继续安装。', 'You can continue installation after the tasks finish.')}`;
    statusMessageKey = `waiting-tasks:${taskCount ?? 'unknown'}`;
  } else if (effectivePhase === 'waiting-permission') {
    const hint = t('请在系统设置中授予安装权限，返回后点击“继续安装”。', 'Grant install permission in system settings, then return and select “Continue installation”.');
    statusMessageText = status?.message ? `${hint} ${status.message}` : hint;
    statusMessageKey = 'waiting-permission';
  } else if (effectivePhase === 'waiting-install') {
    const hint = t('请在系统安装器中确认；取消等待不能撤销已打开的系统安装器。', 'Confirm in the system installer; cancelling the wait cannot dismiss an installer already opened.');
    statusMessageText = status?.message ? `${hint} ${status.message}` : hint;
    statusMessageKey = 'waiting-install';
  } else if (checking) {
    statusMessageText = status?.message || t('正在查询中心…', 'Querying the center…');
    statusMessageKey = 'checking';
  } else if (effectivePhase === 'complete') {
    statusMessageText = status?.message || t('重启应用后生效', 'Takes effect after restart');
    statusMessageKey = 'complete';
  } else if (status?.message) {
    statusMessageText = status.message;
    statusMessageKey = `message:${effectivePhase}:${status.message}`;
  }

  // 主操作按钮状态（所有常规阶段共用同一按钮与 LabelStack，宽度与高度零变化）
  const isWaitingSystemInstall = !isDesktop && !installing && (effectivePhase === 'waiting-permission' || effectivePhase === 'waiting-install');
  const primaryLabels = isWaitingSystemInstall
    ? [labelContinueInstall, labelReopenInstaller, labelInstalling]
    : [labelCheck, labelChecking, labelDownload, labelDownloading, labelInstall, labelInstalling, labelRetry];

  let primaryActive = labelCheck;
  let primaryClass = secondaryBtn;
  let primaryDisabled = busy;
  let primaryAction: (() => void) | undefined = check;
  let primaryIcon: ReactNode = <RefreshCw size={13} aria-hidden="true" />;

  if (isWaitingSystemInstall) {
    primaryActive = effectivePhase === 'waiting-permission' ? labelContinueInstall : labelReopenInstaller;
    primaryClass = primaryBtn;
    primaryDisabled = busy;
    primaryAction = () => install(false);
    primaryIcon = <CheckCircle2 size={13} aria-hidden="true" />;
  } else if (installing) {
    primaryActive = labelInstalling;
    primaryClass = primaryBtn;
    primaryDisabled = true;
    primaryAction = undefined;
    primaryIcon = <Loader2 size={13} className="cu-spin" aria-hidden="true" />;
  } else if (downloading) {
    primaryActive = labelDownloading;
    primaryClass = primaryBtn;
    primaryDisabled = true;
    primaryAction = undefined;
    primaryIcon = <Loader2 size={13} className="cu-spin" aria-hidden="true" />;
  } else if (checking) {
    primaryActive = labelChecking;
    primaryClass = secondaryBtn;
    primaryDisabled = true;
    primaryAction = undefined;
    primaryIcon = <RefreshCw size={13} className="cu-spin" aria-hidden="true" />;
  } else if (effectivePhase === 'available') {
    primaryActive = labelDownload;
    primaryClass = primaryBtn;
    primaryDisabled = busy;
    primaryAction = download;
    primaryIcon = <Download size={13} aria-hidden="true" />;
  } else if (effectivePhase === 'downloaded') {
    primaryActive = labelInstall;
    primaryClass = primaryBtn;
    primaryDisabled = busy;
    primaryAction = () => install(false);
    primaryIcon = <CheckCircle2 size={13} aria-hidden="true" />;
  } else if (effectivePhase === 'error') {
    primaryActive = labelRetry;
    primaryClass = secondaryBtn;
    primaryDisabled = busy;
    primaryAction = check;
    primaryIcon = <RefreshCw size={13} aria-hidden="true" />;
  }

  // 次操作按钮（可用时重新检查；检查/下载/等待系统确认时取消）
  const canRecheck = effectivePhase === 'available' && !downloading && !installing;
  const canShowCancel = !installing && (
    checking ||
    downloading ||
    (!isDesktop && (effectivePhase === 'waiting-permission' || effectivePhase === 'waiting-install'))
  );
  const secondaryLabels = isDesktop
    ? [labelCheck, labelCancelCheck, labelCancelDownload, labelCancelling]
    : [labelRecheck, labelCancel, labelCancelWaiting, labelCancelling];
  const secondaryActive = canRecheck
    ? (isDesktop ? labelCheck : labelRecheck)
    : cancelling
      ? labelCancelling
      : isDesktop
        ? (downloading ? labelCancelDownload : labelCancelCheck)
        : (effectivePhase === 'waiting-install' ? labelCancelWaiting : labelCancel);
  const secondaryDisabled = canRecheck ? busy : !canCancelAction;
  const secondaryAction = canRecheck ? check : cancel;
  const secondaryIcon = canRecheck
    ? <RefreshCw size={13} aria-hidden="true" />
    : cancelling
      ? <Loader2 size={13} className="cu-spin" aria-hidden="true" />
      : <XCircle size={13} aria-hidden="true" />;

  const confirmStopOpen = waiting && confirmStop && !installing;

  return (
    <div className="cu-panel">
      <div className="cu-row">
        <div className="cu-line">
          <span className="cu-label">{t('当前版本', 'Current version')}</span>
          <span className="cu-value">{status?.currentVersion || '—'}</span>
        </div>

        <div className="cu-line">
          <span className="cu-label">{t('状态', 'Status')}</span>
          <ReservedSlot inline minHeight={22} align="center" className="cu-value-slot" contentKey={effectivePhase}>
            <span className={'cu-value' + (effectivePhase === 'error' ? ' is-error' : '')} title={statusSummary}>
              {statusSummary}
            </span>
          </ReservedSlot>
        </div>

        <div className="cu-line">
          <span className="cu-label">{t('新版本', 'New version')}</span>
          <ReservedSlot
            inline
            minHeight={22}
            align="center"
            className="cu-value-slot"
            contentKey={showRelease && release ? release.id : 'none'}
          >
            <span
              className={'cu-value' + (showRelease && release ? '' : ' is-muted')}
              title={showRelease && release ? releaseSummary : undefined}
            >
              {releaseSummary}
            </span>
          </ReservedSlot>
        </div>

        <div
          className={
            'cu-progress' +
            (progressActive ? ' is-active' : ' is-idle') +
            (progressIndeterminate ? ' is-indeterminate' : '')
          }
          role={progressActive ? 'progressbar' : undefined}
          aria-hidden={!progressActive || undefined}
          aria-label={progressActive ? (installing ? t('安装进度', 'Installation progress') : t('下载进度', 'Download progress')) : undefined}
          aria-valuemin={progressActive ? 0 : undefined}
          aria-valuemax={progressActive ? 100 : undefined}
          aria-valuenow={progressActive && !progressIndeterminate ? (progress ?? 0) : undefined}
        >
          <span
            className="cu-progress-fill"
            style={progressIndeterminate ? undefined : { width: fillPercent + '%' }}
          />
        </div>

        <ReservedSlot
          minHeight={58}
          align="start"
          className="cu-status-slot"
          contentKey={statusMessageKey}
          role={statusMessageTone === 'error' ? 'alert' : 'status'}
          aria-live={statusMessageTone === 'error' ? 'assertive' : 'polite'}
        >
          {statusMessageText ? (
            <p
              className={
                'cu-status-text' +
                (statusMessageTone === 'error' ? ' is-error' : '') +
                (statusMessageTone === 'meta' ? ' is-meta' : '')
              }
              title={statusMessageText}
            >
              {statusMessageText}
            </p>
          ) : null}
        </ReservedSlot>

        <div className="cu-actions">
          {waiting && !installing ? (
            isDesktop ? (
              <>
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => { setConfirmStop(false); install(false); }}>
                  {t('检查任务并继续安装', 'Check tasks and continue installation')}
                </button>
                <button type="button" className={secondaryBtn} disabled={busy} onClick={() => { setConfirmStop(false); cancel(); }}>
                  <span className="cu-btn-icon" aria-hidden="true">
                    {cancelling ? <Loader2 size={13} className="cu-spin" aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
                  </span>
                  <LabelStack active={cancelling ? labelCancelling : labelCancelInstall} labels={[labelCancelInstall, labelCancelling]} />
                </button>
                <button type="button" className={secondaryBtn} disabled={busy} aria-expanded={confirmStop} onClick={() => setConfirmStop(prev => !prev)}>
                  {t('立即安装…', 'Install now…')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className={secondaryBtn} disabled={busy} onClick={() => { setConfirmStop(false); install(false); }}>
                  {t('等待任务结束后重试', 'Retry after tasks finish')}
                </button>
                <button type="button" className={primaryBtn} disabled={busy} aria-expanded={confirmStop} onClick={() => setConfirmStop(prev => !prev)}>
                  {t('停止活动任务并继续…', 'Stop running tasks and continue…')}
                </button>
                <button type="button" className={secondaryBtn} disabled={busy} onClick={() => { setConfirmStop(false); cancel(); }}>
                  <span className="cu-btn-icon" aria-hidden="true">
                    {cancelling ? <Loader2 size={13} className="cu-spin" aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
                  </span>
                  <LabelStack active={cancelling ? labelCancelling : labelCancel} labels={[labelCancel, labelCancelling]} />
                </button>
              </>
            )
          ) : (
            <>
              <button type="button" className={primaryClass} disabled={primaryDisabled} onClick={primaryAction}>
                <span className="cu-btn-icon" aria-hidden="true">{primaryIcon}</span>
                <LabelStack active={primaryActive} labels={primaryLabels} />
              </button>
              {(canRecheck || canShowCancel) && (
                <button
                  type="button"
                  className={`${secondaryBtn} cu-secondary-action`}
                  disabled={secondaryDisabled}
                  onClick={secondaryAction}
                >
                  <span className="cu-btn-icon" aria-hidden="true">{secondaryIcon}</span>
                  <LabelStack active={secondaryActive} labels={secondaryLabels} />
                </button>
              )}
            </>
          )}
        </div>

        <ReservedSlot
          minHeight={32}
          align="center"
          className="cu-notes-slot"
          contentKey={hasNotes ? 'notes-available' : 'notes-empty'}
        >
          {hasNotes ? (
            <button
              type="button"
              className={`cu-notes-toggle${notesOpen ? ' is-open' : ''}`}
              aria-expanded={notesOpen}
              aria-controls={notesPanelId}
              onClick={() => setNotesOpen(prev => !prev)}
            >
              <ChevronDown size={14} className="cu-notes-chevron" aria-hidden="true" />
              <LabelStack
                align="start"
                active={notesOpen ? labelHideNotes : labelShowNotes}
                labels={[labelShowNotes, labelHideNotes]}
              />
            </button>
          ) : null}
        </ReservedSlot>
      </div>

      <SmoothExpand open={hasNotes && notesOpen} className="cu-expand-region">
        <div id={notesPanelId} className="cu-notes-panel">
          <pre className="cu-notes">{release?.notes ?? ''}</pre>
        </div>
      </SmoothExpand>

      <SmoothExpand open={confirmStopOpen} className="cu-expand-region">
        <div className="cu-stop-confirm-wrap">
          <div className="cu-stop-confirm" role="group" aria-label={t('确认停止活动任务', 'Confirm stopping running tasks')}>
            <p className="cu-message">
              {taskCount === null
                ? t('继续会停止当前活动任务。任务数量暂未上报。', 'Continuing stops active tasks. The task count is unavailable.')
                : t(`继续会停止本机活动任务（上次检查为 ${taskCount} 个）并开始安装。`, `Continuing stops local tasks (${taskCount} at the last check) and starts installation.`)}
            </p>
            <div className="cu-actions">
              <button
                type="button"
                className={secondaryBtn}
                tabIndex={confirmStopOpen ? undefined : -1}
                onClick={() => setConfirmStop(false)}
              >
                {t('返回', 'Back')}
              </button>
              <button
                type="button"
                className={dangerBtn}
                disabled={busy || !confirmStopOpen}
                tabIndex={confirmStopOpen ? undefined : -1}
                onClick={() => { setConfirmStop(false); install(true); }}
              >
                {t('停止任务并安装', 'Stop tasks and install')}
              </button>
            </div>
          </div>
        </div>
      </SmoothExpand>
    </div>
  );
}

export function ClientUpdateSection(props: { variant: 'desktop' | 'mobile' }) {
  const update = useClientUpdate();
  if (!update) return null;
  if (props.variant === 'desktop') {
    return (
      <section className="settings-section cu-desktop">
        <UpdateSectionBody update={update} variant="desktop" />
      </section>
    );
  }
  return (
    <Section>
      <div className="cu-mobile">
        <UpdateSectionBody update={update} variant="mobile" />
      </div>
    </Section>
  );
}
