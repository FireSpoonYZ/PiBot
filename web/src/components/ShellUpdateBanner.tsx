import { ArrowUpCircle, CheckCircle2, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { updateProgress, type ClientUpdatePhase } from '../ClientUpdate';
import { useClientUpdate, type ClientUpdateContextValue } from '../ClientUpdateProvider';
import { useText } from '../ui';

const ACTIONABLE_UPDATE_PHASES: ReadonlySet<ClientUpdatePhase> = new Set([
  'available',
  'downloading',
  'downloaded',
  'waiting-permission',
  'waiting-install',
  'waiting-tasks',
  'installing',
]);

export function hasShellClientUpdate(update: ClientUpdateContextValue | null): boolean {
  if (!update?.ready) return false;
  if (update.pending === 'download' || update.pending === 'install') return true;
  const status = update.status;
  if (!status || !ACTIONABLE_UPDATE_PHASES.has(status.phase)) return false;
  if (status.phase === 'available') return Boolean(status.release);
  return true;
}

export function useHasShellUpdate(): boolean {
  return hasShellClientUpdate(useClientUpdate());
}

export interface ShellUpdateBannerProps {
  onOpenUpdates(): void;
  className?: string;
}

export function ShellUpdateBanner({ onOpenUpdates, className = '' }: ShellUpdateBannerProps) {
  const t = useText();
  const update = useClientUpdate();

  if (!hasShellClientUpdate(update) || !update) {
    return null;
  }

  const { status, pending } = update;
  const phase: ClientUpdatePhase =
    pending === 'install'
      ? 'installing'
      : pending === 'download'
        ? 'downloading'
        : (status?.phase ?? 'idle');
  const version = status?.release?.version ? `v${status.release.version}` : '';
  const progress = updateProgress(status);

  let title: string;
  let detail: string;
  let icon = <ArrowUpCircle size={18} aria-hidden="true" />;
  let toneClass = 'is-available';

  if (phase === 'downloading') {
    title = t('正在下载更新', 'Downloading update');
    detail =
      progress !== null
        ? [version, `${progress}%`].filter(Boolean).join(' · ')
        : version || t('查看下载进度', 'View progress');
    icon = <Download size={18} aria-hidden="true" />;
    toneClass = 'is-downloading';
  } else if (phase === 'installing') {
    title = t('正在安装更新', 'Installing update');
    detail = version || t('查看安装状态', 'View install status');
    icon = <RefreshCw size={18} className="shell-update-spin" aria-hidden="true" />;
    toneClass = 'is-downloading';
  } else if (
    phase === 'downloaded' ||
    phase === 'waiting-permission' ||
    phase === 'waiting-install' ||
    phase === 'waiting-tasks'
  ) {
    title = t('更新已就绪', 'Update ready');
    detail = version
      ? t(`${version} · 点击安装`, `${version} · Tap to install`)
      : t('点击前往安装', 'Tap to install');
    icon = <CheckCircle2 size={18} aria-hidden="true" />;
    toneClass = 'is-ready';
  } else {
    title = t('发现新版本', 'Update available');
    detail = version
      ? t(`${version} · 查看详情`, `${version} · View details`)
      : t('查看更新详情', 'View update details');
  }

  const cls = ['shell-update-banner', toneClass, className].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={cls}
      onClick={onOpenUpdates}
      aria-label={`${title}${detail ? ` (${detail})` : ''}`}
    >
      <span className="shell-update-banner-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="shell-update-banner-body">
        <span className="shell-update-banner-title">{title}</span>
        <span className="shell-update-banner-detail tabular-nums">{detail}</span>
      </span>
      <ChevronRight size={16} className="shell-update-banner-chevron" aria-hidden="true" />
    </button>
  );
}
