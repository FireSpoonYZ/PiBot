// 设置页“客户端更新”分区：桌面 SettingsPanel 与 Android HubSettingsView 共用。
// 只渲染原生状态与用户明确操作；不自动下载、不后台静默安装。
import { Download, RefreshCw, XCircle } from 'lucide-react';
import { useText } from './ui';
import { Section } from './bot-settings/primitives';
import { formatUpdateBytes, updateProgress, type ClientUpdatePhase } from './ClientUpdate';
import { useClientUpdate } from './ClientUpdateProvider';
import './ClientUpdate.css';

function phaseLabel(phase: ClientUpdatePhase, t: (zh: string, en: string) => string): string {
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

export function ClientUpdateSection(props: { variant: 'desktop' | 'mobile' }) {
  const t = useText();
  const update = useClientUpdate();
  if (!update) return null;
  const { status, pending, ready, actionError, check, download, install, cancel } = update;
  const variant = props.variant;
  const primary = variant === 'desktop' ? 'primary-button' : 'hst-btn is-primary';
  const secondary = variant === 'desktop' ? 'secondary-button' : 'hst-btn';
  const busy = pending !== null || !ready;
  const progress = updateProgress(status);
  const phase = status?.phase ?? (pending === 'check' ? 'checking' : 'idle');
  const canCancel = ready && (pending === null || pending === 'check' || pending === 'download');
  const release = status?.release;
  const sizeText = formatUpdateBytes(status?.totalBytes ?? release?.size);
  const showRelease = Boolean(
    release &&
    (phase === 'available' || phase === 'downloading' || phase === 'downloaded' ||
      phase === 'waiting-tasks' || phase === 'waiting-permission' ||
      phase === 'waiting-install' || phase === 'installing'),
  );

  const body = (
    <>
      <div className="cu-row">
        <div className="cu-line">
          <span className="cu-label">{t('当前版本', 'Current version')}</span>
          <span className="cu-value">{status?.currentVersion || '—'}</span>
        </div>
        <div className="cu-line">
          <span className="cu-label">{t('状态', 'Status')}</span>
          <span className="cu-value">{phaseLabel(phase, t)}</span>
        </div>
        {showRelease && release && (
          <div className="cu-line">
            <span className="cu-label">{t('新版本', 'New version')}</span>
            <span className="cu-value">
              {release.version}
              {sizeText ? ' · ' + sizeText : ''}
            </span>
          </div>
        )}
        {release?.notes && phase !== 'up-to-date' && phase !== 'idle' && phase !== 'checking' && (
          <pre className="cu-notes">{release.notes}</pre>
        )}
        {status?.message && (
          <div className={'cu-message' + (phase === 'error' ? ' is-error' : '')}>{status.message}</div>
        )}
        {phase === 'downloading' && (
          <div className="cu-progress" role="progressbar" aria-valuenow={progress ?? undefined}>
            <span style={{ width: (progress ?? 0) + '%' }} />
          </div>
        )}
        {phase === 'downloading' && (
          <div className="cu-meta">
            {formatUpdateBytes(status?.downloadedBytes)}
            {status?.totalBytes ? ' / ' + formatUpdateBytes(status.totalBytes) : ''}
            {progress !== null ? ' · ' + progress + '%' : ''}
          </div>
        )}
      </div>

      <div className="cu-actions">
        {(phase === 'idle' || phase === 'up-to-date' || phase === 'available' || phase === 'cancelled' || phase === 'error' || phase === 'complete') && (
          <button type="button" className={secondary} disabled={busy} onClick={check}>
            <RefreshCw size={13} aria-hidden /> {t('检查更新', 'Check for updates')}
          </button>
        )}
        {phase === 'available' && (
          <button type="button" className={primary} disabled={busy} onClick={download}>
            <Download size={13} aria-hidden /> {pending === 'download' ? t('正在准备…', 'Preparing…') : t('下载更新', 'Download update')}
          </button>
        )}
        {phase === 'downloaded' && (
          <button type="button" className={primary} disabled={busy} onClick={() => install(false)}>
            {pending === 'install' ? t('正在准备…', 'Preparing…') : t('安装更新', 'Install update')}
          </button>
        )}
        {phase === 'waiting-tasks' && (
          <>
            <button type="button" className={secondary} disabled={busy} onClick={() => install(false)}>
              {t('等待任务结束后重试', 'Retry after tasks finish')}
            </button>
            <button type="button" className={primary} disabled={busy} onClick={() => install(true)}>
              {t('停止活动任务并继续', 'Stop running tasks and continue')}
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={cancel}>
              <XCircle size={13} aria-hidden /> {t('取消', 'Cancel')}
            </button>
          </>
        )}
        {variant === 'mobile' && (phase === 'waiting-permission' || phase === 'waiting-install') && (
          <button type="button" className={primary} disabled={busy} onClick={() => install(false)}>
            {phase === 'waiting-permission' ? t('继续安装', 'Continue installation') : t('重新打开安装器', 'Reopen installer')}
          </button>
        )}
        {phase !== 'installing' && (pending === 'check' || pending === 'download' || phase === 'checking' || phase === 'downloading' || phase === 'waiting-permission' || phase === 'waiting-install') && (
          <button type="button" className={secondary} disabled={!canCancel} onClick={cancel}>
            <XCircle size={13} aria-hidden /> {phase === 'waiting-install' ? t('取消等待', 'Cancel waiting') : t('取消', 'Cancel')}
          </button>
        )}
        {phase === 'checking' && (
          <span className="cu-message">{t('正在查询中心…', 'Querying the center…')}</span>
        )}
        {phase === 'waiting-permission' && (
          <span className="cu-message">{t('请在系统设置中授予安装权限，返回后点击“继续安装”。', 'Grant install permission in system settings, then return and select “Continue installation”.')}</span>
        )}
        {phase === 'waiting-install' && (
          <span className="cu-message">{t('请在系统安装器中确认；取消等待不能撤销已打开的系统安装器。', 'Confirm in the system installer; cancelling the wait cannot dismiss an installer already opened.')}</span>
        )}
        {phase === 'installing' && (
          <span className="cu-message">{t('安装已开始，此阶段无法在应用内取消。', 'Installation has started and cannot be cancelled here.')}</span>
        )}
        {phase === 'complete' && (
          <span className="cu-message">{t('重启应用后生效', 'Takes effect after restart')}</span>
        )}
      </div>

      {!ready && <div className="cu-message">{t('连接中心后可检查更新。', 'Connect to the center to check for updates.')}</div>}

      {actionError && (
        <div className="cu-message is-error" role="alert">
          {actionError}
        </div>
      )}
    </>
  );

  if (variant === 'desktop') {
    return (
      <div className="settings-section">
        <div className="section-head"><h4>{t('客户端更新', 'Client Update')}</h4></div>
        {body}
      </div>
    );
  }
  return <Section title={t('客户端更新', 'Client Update')}>{body}</Section>;
}
