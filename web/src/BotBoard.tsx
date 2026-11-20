import { useState } from 'react';
import { ArrowLeft, ChevronRight, PanelLeft, Search, X } from 'lucide-react';
import type { BotBoardItem } from '../../host-core/index.js';
import { formatWorkingElapsed, GrokBotAvatar } from './GrokBotAvatar';
import { botActivityText, isBotActivityBusy, parseBotActivityStartedAt } from './botActivity';
import { useText } from './ui';
import { botBoardBucket, isBotBoardInterrupted, type BoardBucket, type BotBoardState, type BotBoardTarget } from './useBotBoard';
import './BotBoard.css';

type TaskAwareBoardItem = BotBoardItem & {
  taskId?: string | null;
  taskTitle?: string | null;
  taskStatusLine?: string | null;
};

type BadgeTone = 'warning' | 'working' | 'review' | 'danger' | 'offline';
type SummaryTone = 'default' | 'muted' | 'danger';

function formatCompactTime(value: string, nowMs: number = Date.now()): string {
  const date = new Date(value);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) return '';
  const now = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay = sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return hhmm;
  const mmdd = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  if (sameYear) return `${mmdd} ${hhmm}`;
  return `${date.getFullYear()}/${mmdd}`;
}

function localizeBoardError(message: string | undefined, t: (zh: string, en: string) => string): string | undefined {
  if (!message) return message;
  if (message === 'Bot 已不存在，请刷新目录。' || message === 'Bot no longer exists. Please refresh the directory.') return t('Bot 已不存在，请刷新目录。', 'Bot no longer exists. Please refresh the directory.');
  if (message === '状态读取失败。' || message === 'Failed to read status.') return t('状态读取失败。', 'Failed to read status.');
  if (message === '看板不可用，请检查连接，或更新中心与 Host。' || message === 'Board unavailable. Check your connection or update Center and Host.') return t('看板不可用，请检查连接，或更新中心与 Host。', 'Board unavailable. Check your connection or update Center and Host.');
  if (message === '无法读取本机查看标记；待查看状态可能不完整。' || message === 'Unable to read local viewed markers; review status may be incomplete.') return t('无法读取本机查看标记；待查看状态可能不完整。', 'Unable to read local viewed markers; review status may be incomplete.');
  if (message === '查看标记未能保存；本次会话仍有效，重启后可能再次显示待查看。' || message === 'Failed to save viewed marker; valid for this session, may reappear after restart.') return t('查看标记未能保存；本次会话仍有效，重启后可能再次显示待查看。', 'Failed to save viewed marker; valid for this session, may reappear after restart.');
  return message;
}

export function BotBoard({ targets, board, onOpen, onOpenTask, onBack, onOpenMobileDrawer, loading, error, variant = 'mobile' }: {
  targets: BotBoardTarget[];
  board: BotBoardState;
  onOpen: (target: BotBoardTarget, questionnaire?: { conversationId: string; requestId: string }) => void;
  onOpenTask?: (taskId: string) => void;
  onBack?: () => void;
  onOpenMobileDrawer?: () => void;
  loading?: boolean;
  error?: string | null;
  variant?: 'desktop' | 'mobile';
}) {
  const t = useText();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BoardBucket | 'all'>('all');
  const desktop = variant === 'desktop';
  const nowMs = Date.now();

  const columns: { key: BoardBucket; label: string }[] = [
    { key: 'attention', label: t('需要你', 'Needs you') },
    { key: 'working', label: desktop ? t('进行中', 'In progress') : t('工作中', 'Working') },
    { key: 'review', label: t('待查看', 'Ready to review') },
    { key: 'idle', label: t('空闲', 'Idle') },
    { key: 'offline', label: t('离线', 'Offline') },
  ];

  const rows = targets.map(target => {
    const record = board.records.get(target.key);
    const item = record?.item;
    const bucket = !target.online ? 'offline' : item ? botBoardBucket(item, board.seen.get(target.key)) : null;
    const stale = !target.online || !!record?.error || record?.generation !== target.generation;
    return { target, record, item, bucket, stale };
  });

  const q = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(({ target, item, bucket }) => {
    if (!(filter === 'all' || bucket === filter || bucket === null)) return false;
    if (!q) return true;
    const taskItem = item as TaskAwareBoardItem | undefined;
    return [
      target.name,
      target.deviceName,
      item?.attention?.summary,
      item?.lastResult?.summary,
      item?.progress?.current,
      item?.activity.error?.message,
      taskItem?.taskTitle,
      taskItem?.taskStatusLine,
    ].join(' ').toLocaleLowerCase().includes(q);
  });

  const renderCard = ({ target, record, item, bucket, stale }: typeof rows[number]) => {
    const startedAt = item ? parseBotActivityStartedAt(item.activity) : null;
    // A disconnected clock freezes at the last successful snapshot.
    const parsedUpdatedAt = stale && record?.updatedAt ? Date.parse(record.updatedAt) : NaN;
    const clock = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : nowMs;
    const controlling = item?.activity.phase === 'stopping' || item?.activity.phase === 'interrupting';
    const questionnaire = desktop && !stale && !controlling && item?.attention &&
      (item.activity.source === 'primary' || item.activity.source === 'background')
      ? { conversationId: item.conversationId, requestId: item.attention.requestId }
      : undefined;
    const interrupted = isBotBoardInterrupted(item?.activity);
    const statusText = item ? (interrupted ? t('回复已中断', 'Reply interrupted') : botActivityText(item.activity, t)) : '';
    const failureMessage = interrupted ? t('Host 停止，回复已中断', 'Host stopped; reply interrupted') : item?.activity.error?.message;
    const recordError = localizeBoardError(record?.error, t);
    const review = desktop && !stale && bucket === 'review';
    const failed = desktop && !stale && item?.activity.phase === 'failed' && !interrupted;
    const action = questionnaire
      ? t('回答问题', 'Answer')
      : review
        ? t('查看结果', 'View result')
        : failed
          ? t('查看失败原因', 'View failure')
          : t('进入聊天', 'Open chat');
    const actionLabel = questionnaire
      ? t(`回答 ${target.name} 的问题`, `Answer ${target.name}'s question`)
      : review
        ? t(`查看 ${target.name} 的结果`, `View ${target.name}'s result`)
        : t(`打开 ${target.name} 的聊天`, `Open chat with ${target.name}`);
    const taskItem = item as TaskAwareBoardItem | undefined;
    const taskId = taskItem?.taskId ?? null;
    const taskTitle = taskItem?.taskTitle ?? null;
    const taskStatusLine = taskItem?.taskStatusLine ?? null;
    const hasTaskLink = Boolean(taskId && onOpenTask);
    const openChat = () => {
      if (variant === 'mobile' && item?.lastResult) board.markViewed(target.key, item.lastResult.id);
      onOpen(target, questionnaire);
    };
    const busy = Boolean(item && isBotActivityBusy(item.activity));
    const elapsedSeconds = startedAt !== null ? Math.max(0, Math.floor((clock - startedAt) / 1000)) : 0;

    // Compact semantic status badge ONLY for non-idle states.
    const badge: { label: string; tone: BadgeTone } | null = (() => {
      if (!target.online) return { label: t('离线', 'Offline'), tone: 'offline' };
      if (item?.activity.phase === 'failed' && !interrupted) return { label: t('失败', 'Failed'), tone: 'danger' };
      if (item?.attention && !controlling) return { label: t('需要你', 'Needs you'), tone: 'warning' };
      if (item && (item.activity.phase === 'queued' || (!busy && item.queuedCount > 0))) {
        const count = Math.max(1, item.queuedCount);
        return { label: t(`排队 ${count}`, `${count} queued`), tone: 'working' };
      }
      if (bucket === 'working' || busy) {
        if (item?.activity.phase === 'stopping') return { label: t('停止中', 'Stopping'), tone: 'working' };
        if (item?.activity.phase === 'interrupting') return { label: t('让位中', 'Yielding'), tone: 'working' };
        return {
          label: item && item.queuedCount > 0
            ? t(`工作中 · 排队 ${item.queuedCount}`, `Working · ${item.queuedCount} queued`)
            : t('工作中', 'Working'),
          tone: 'working',
        };
      }
      if (bucket === 'review') return { label: t('待查看', 'Review'), tone: 'review' };
      return null;
    })();

    const compactTime = busy && startedAt !== null
      ? formatWorkingElapsed(elapsedSeconds)
      : item?.lastResult?.completedAt
        ? formatCompactTime(item.lastResult.completedAt, nowMs)
        : '';

    const summary: { text: string; tone: SummaryTone } | null = (() => {
      if (!target.online) {
        return { text: recordError || t('设备离线', 'Device offline'), tone: recordError ? 'danger' : 'muted' };
      }
      if (recordError) {
        return { text: recordError, tone: 'danger' };
      }
      if (!item) {
        return { text: t('正在读取状态…', 'Loading status…'), tone: 'muted' };
      }
      if (item.attention && !controlling) {
        const prefix = t(`待回答 · ${item.attention.count} 题`, `Needs answer · ${item.attention.count}`);
        const detail = item.attention.summary?.trim();
        return {
          text: detail ? t(`${prefix}：${detail}`, `${prefix}: ${detail}`) : prefix,
          tone: 'default',
        };
      }
      if (item.activity.phase === 'failed') {
        return {
          text: failureMessage || t('执行失败，请进入聊天处理。', 'Run failed. Open chat to handle it.'),
          tone: interrupted ? 'muted' : 'danger',
        };
      }
      if (item.progress) {
        const progressHead = t(`已完成 ${item.progress.completed}/${item.progress.total}`, `${item.progress.completed}/${item.progress.total} done`);
        const current = item.progress.current?.trim();
        return {
          text: current ? `${progressHead} · ${current}` : progressHead,
          tone: 'default',
        };
      }
      if (item.lastResult) {
        return {
          text: item.lastResult.summary || t('已完成，进入聊天查看结果。', 'Completed. Open chat to view results.'),
          tone: 'default',
        };
      }
      if (taskTitle || taskStatusLine) {
        return { text: taskTitle || taskStatusLine || '', tone: 'default' };
      }
      if (bucket === 'idle' && item.activity.phase === 'idle' && !item.activity.webhookStopPending) {
        return null;
      }
      return statusText ? { text: statusText, tone: 'muted' } : null;
    })();

    const staleTime = stale && record?.updatedAt ? formatCompactTime(record.updatedAt, nowMs) : '';
    const staleNote = staleTime
      ? t(`上次同步 ${staleTime}`, `Last synced ${staleTime}`)
      : stale && target.online && !recordError && item
        ? t('正在同步…', 'Syncing…')
        : '';

    const cardContent = (
      <>
        <span className="bot-board-card-head">
          <span className="bot-board-card-identity">
            <GrokBotAvatar botKey={target.avatarKey} roleName={target.name} isPrimary={target.isPrimary} offline={!target.online} size={36} />
            <span className="bot-board-card-titles">
              <strong>{target.name}</strong>
              <small>{target.deviceName}</small>
            </span>
          </span>
          <span className="bot-board-card-meta">
            {badge && <span className={`bot-board-badge is-${badge.tone}`}>{badge.label}</span>}
            {compactTime && <span className="bot-board-time">{compactTime}</span>}
            {!hasTaskLink && <ChevronRight size={16} className="bot-board-chevron" aria-hidden="true" />}
          </span>
        </span>
        {summary && (
          <span className={`bot-board-summary${summary.tone !== 'default' ? ` is-${summary.tone}` : ''}`}>
            {summary.text}
          </span>
        )}
        {staleNote && <small className="bot-board-stale-note">{staleNote}</small>}
      </>
    );

    if (hasTaskLink) {
      return (
        <article
          className={`bot-board-card has-task-link${!target.online ? ' is-offline' : ''}`}
          key={target.key}
        >
          <button
            type="button"
            className="bot-board-card-main"
            onClick={openChat}
            aria-label={`${actionLabel} · ${target.deviceName}`}
          >
            {cardContent}
          </button>
          <div className="bot-board-links">
            <button
              type="button"
              className="bot-board-link-btn"
              aria-label={t(`查看 ${target.name} 的任务`, `View task for ${target.name}`)}
              onClick={() => onOpenTask!(taskId!)}
            >
              <span>{t('查看任务', 'View task')}</span>
              <span aria-hidden="true"> →</span>
            </button>
            <button
              type="button"
              className="bot-board-link-btn is-primary"
              aria-label={`${actionLabel} · ${target.deviceName}`}
              onClick={openChat}
            >
              <span>{action}</span>
              <span aria-hidden="true"> →</span>
            </button>
          </div>
        </article>
      );
    }

    return (
      <button
        type="button"
        className={`bot-board-card${!target.online ? ' is-offline' : ''}`}
        key={target.key}
        onClick={openChat}
        aria-label={`${actionLabel} · ${target.deviceName}`}
      >
        {cardContent}
      </button>
    );
  };

  const renderGroup = (column: typeof columns[number], cards: typeof rows) => (
    <section className={`bot-board-group is-${column.key}`} key={column.key}>
      <h2 className="bot-board-group-head">
        <span className={`bot-board-dot is-${column.key}`} aria-hidden="true" />
        <span>{column.label}</span>{' '}
        <small className="bot-board-group-count">{cards.length}</small>
      </h2>
      <div className="bot-board-grid">
        {cards.map(renderCard)}
      </div>
    </section>
  );

  const cardsByBucket = new Map<BoardBucket, typeof rows>();
  for (const column of columns) {
    cardsByBucket.set(column.key, filtered.filter(row => row.bucket === column.key));
  }

  const activeColumns = columns.filter(column =>
    (column.key === 'attention' || column.key === 'working' || column.key === 'review') &&
    (cardsByBucket.get(column.key)?.length ?? 0) > 0,
  );
  const otherColumns = columns.filter(column =>
    (column.key === 'idle' || column.key === 'offline') &&
    (cardsByBucket.get(column.key)?.length ?? 0) > 0,
  );
  const hasActiveCards = activeColumns.length > 0;
  const collapseOtherOnDesktop = desktop && filter === 'all' && hasActiveCards && otherColumns.length > 0;

  const visibleGroups = filter === 'all'
    ? (collapseOtherOnDesktop ? activeColumns : [...activeColumns, ...otherColumns])
    : columns.filter(column => column.key === filter && (cardsByBucket.get(column.key)?.length ?? 0) > 0);

  const unknown = filtered.filter(row => row.bucket === null);
  const unknownSection = unknown.length > 0 && (
    <section className="bot-board-group bot-board-unknown">
      <h2 className="bot-board-group-head">
        <span className="bot-board-dot is-offline" aria-hidden="true" />
        <span>{t('状态未确认', 'Status unconfirmed')}</span>{' '}
        <small className="bot-board-group-count">{unknown.length}</small>
      </h2>
      <div className="bot-board-grid">{unknown.map(renderCard)}</div>
    </section>
  );

  const storageErrorText = localizeBoardError(board.storageError || undefined, t);
  const offlineTotal = rows.filter(row => row.bucket === 'offline').length;
  const filterChips: { key: BoardBucket | 'all'; label: string; count: number }[] = [
    { key: 'all', label: t('全部', 'All'), count: rows.length },
    ...columns
      .filter(column => column.key !== 'offline' || offlineTotal > 0 || filter === 'offline')
      .map(column => ({
        key: column.key,
        label: column.label,
        count: rows.filter(row => row.bucket === column.key).length,
      })),
  ];

  const idleCount = cardsByBucket.get('idle')?.length ?? 0;
  const offlineCount = cardsByBucket.get('offline')?.length ?? 0;
  const otherSummary = [
    idleCount > 0 ? t(`空闲 ${idleCount}`, `Idle ${idleCount}`) : '',
    offlineCount > 0 ? t(`离线 ${offlineCount}`, `Offline ${offlineCount}`) : '',
  ].filter(Boolean).join(' · ');

  const filterEmptyText = (() => {
    if (q) return t('没有符合筛选条件的 Bot。', 'No Bots match the current filter.');
    switch (filter) {
      case 'attention':
        return t('当前没有需要你处理的 Bot。', 'No bots need your attention right now.');
      case 'working':
        return t('当前没有正在工作的 Bot。', 'No bots are working right now.');
      case 'review':
        return t('当前没有待查看的结果。', 'No results ready to review.');
      case 'idle':
        return t('当前没有空闲的 Bot。', 'No idle bots right now.');
      case 'offline':
        return t('当前没有离线的 Bot。', 'No offline bots right now.');
      default:
        return t('没有符合筛选条件的 Bot。', 'No Bots match the current filter.');
    }
  })();

  const showFilterEmpty = targets.length > 0 && visibleGroups.length === 0 && !collapseOtherOnDesktop && (filter !== 'all' || unknown.length === 0);

  return (
    <section className={`bot-board${desktop ? ' bot-board-desktop' : ''}`} aria-label={t('Bot 看板', 'Bot Board')}>
      <div className="bot-board-inner">
        <header className="bot-board-header">
          <div className="bot-board-header-left">
            {onOpenMobileDrawer ? (
              <button type="button" onClick={onOpenMobileDrawer} aria-label={t('打开侧边栏', 'Open sidebar')}>
                <PanelLeft size={20} aria-hidden="true" />
              </button>
            ) : onBack ? (
              <button type="button" onClick={onBack} aria-label={t('返回', 'Back')}>
                <ArrowLeft size={20} aria-hidden="true" />
              </button>
            ) : null}
            <h1>{t('Bot 看板', 'Bot Board')}</h1>
          </div>
          {targets.length > 0 && (
            <span className="bot-board-total" aria-label={t(`共 ${targets.length} 个 Bot`, `${targets.length} bots total`)}>
              {t(`共 ${targets.length} 个`, `${targets.length} total`)}
            </span>
          )}
        </header>

        <div className="bot-board-toolbar">
          <div className="bot-board-search">
            <Search size={16} className="bot-board-search-icon" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('搜索 Bot、设备或摘要', 'Search bots, devices, or summaries')}
              aria-label={t('搜索 Bot、设备或摘要', 'Search bots, devices, or summaries')}
            />
            {query && (
              <button
                type="button"
                className="bot-board-search-clear"
                onClick={() => setQuery('')}
                aria-label={t('清空搜索', 'Clear search')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <nav className="bot-board-filters" aria-label={t('状态筛选', 'Filter by status')}>
          {filterChips.map(c => (
            <button
              key={c.key}
              type="button"
              className={c.key !== 'all' && c.count === 0 ? 'is-zero' : undefined}
              aria-pressed={filter === c.key}
              onClick={() => setFilter(c.key)}
            >
              <span>{c.label}</span>{' '}
              <span className="bot-board-filter-count">{c.count}</span>
            </button>
          ))}
        </nav>

        {error && <p role="alert" className="bot-board-alert">{t(`目录读取失败：${error}`, `Failed to load directory: ${error}`)}</p>}
        {storageErrorText && <p role="alert" className="bot-board-alert">{storageErrorText}</p>}
        {filtered.some(r => r.stale && r.item) && (
          <p className="bot-board-snapshot-note">
            {t('以下保留最后一次读取的状态，请留意更新时间。', 'Showing the last fetched status; check the update timestamp.')}
          </p>
        )}

        {!targets.length && (
          <p className="bot-board-empty-state" role="status">
            {loading
              ? t('正在加载 Bot 目录…', 'Loading Bot directory…')
              : error
                ? t('目录暂不可用，请恢复连接后重试。', 'Directory unavailable. Restore connection and retry.')
                : t('还没有 Bot，请先在对话页创建。', 'No Bots yet. Create one in chat first.')}
          </p>
        )}

        {showFilterEmpty && (
          <p className="bot-board-empty-state" role="status">{filterEmptyText}</p>
        )}

        {!desktop && unknownSection}

        {visibleGroups.length > 0 && (
          <div className="bot-board-groups">
            {visibleGroups.map(column => renderGroup(column, cardsByBucket.get(column.key) ?? []))}
          </div>
        )}

        {desktop && unknownSection}

        {collapseOtherOnDesktop && (
          <details className="bot-board-other" open={q ? true : undefined}>
            <summary>
              <ChevronRight size={15} className="bot-board-other-chevron" aria-hidden="true" />
              <span>{otherSummary}</span>
            </summary>
            <div className="bot-board-groups">
              {otherColumns.map(column => renderGroup(column, cardsByBucket.get(column.key) ?? []))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
