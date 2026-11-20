import { useId, useState } from 'react';
import { ArrowLeft, LayoutDashboard, PanelLeft, Search } from 'lucide-react';
import type { BotBoardItem } from '../../host-core/index.js';
import { Switch } from './components/ui';
import { GrokBotAvatar } from './GrokBotAvatar';
import { botActivityText, isBotActivityBusy, parseBotActivityStartedAt } from './botActivity';
import { useText } from './ui';
import { botBoardBucket, isBotBoardInterrupted, type BoardBucket, type BotBoardState, type BotBoardTarget } from './useBotBoard';
import './BotBoard.css';

type TaskAwareBoardItem = BotBoardItem & {
  taskId?: string | null;
  taskTitle?: string | null;
  taskStatusLine?: string | null;
};

const timeText = (value: string) => new Date(value).toLocaleString();

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
  const showIdleId = useId();
  const [query, setQuery] = useState('');
  const [showIdle, setShowIdle] = useState(true);
  const [filter, setFilter] = useState<BoardBucket | 'all'>('all');
  const desktop = variant === 'desktop';
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
  const filtered = rows.filter(({ target, item, bucket }) =>
    (showIdle || bucket !== 'idle') &&
    (filter === 'all' || bucket === filter || bucket === null) &&
    [target.name, target.deviceName, item?.attention?.summary, item?.lastResult?.summary, item?.progress?.current, item?.activity.error?.message]
      .join(' ').toLocaleLowerCase().includes(q));
  const renderCard = ({ target, record, item, bucket, stale }: typeof rows[number]) => {
    const startedAt = item ? parseBotActivityStartedAt(item.activity) : null;
    // A disconnected clock freezes at the last successful snapshot.
    const clock = stale && record?.updatedAt ? Date.parse(record.updatedAt) : Date.now();
    const controlling = item?.activity.phase === 'stopping' || item?.activity.phase === 'interrupting';
    const questionnaire = desktop && !stale && !controlling && item?.attention &&
      (item.activity.source === 'primary' || item.activity.source === 'background')
      ? { conversationId: item.conversationId, requestId: item.attention.requestId }
      : undefined;
    const interrupted = isBotBoardInterrupted(item?.activity);
    const statusText = item && (interrupted ? t('回复已中断', 'Reply interrupted') : botActivityText(item.activity, t));
    const failureMessage = interrupted ? t('Host 停止，回复已中断', 'Host stopped; reply interrupted') : item?.activity.error?.message;
    const recordError = localizeBoardError(record?.error, t);
    const review = desktop && !stale && bucket === 'review';
    const failed = desktop && !stale && item?.activity.phase === 'failed' && !interrupted;
    const action = questionnaire ? t('回答问题', 'Answer') : review ? t('查看结果', 'View result') : failed ? t('查看失败原因', 'View failure') : t('进入聊天', 'Open chat');
    const actionLabel = questionnaire ? t(`回答 ${target.name} 的问题`, `Answer ${target.name}'s question`) : review ? t(`查看 ${target.name} 的结果`, `View ${target.name}'s result`) : t(`打开 ${target.name} 的聊天`, `Open chat with ${target.name}`);
    const taskItem = item as TaskAwareBoardItem | undefined;
    const taskId = taskItem?.taskId ?? null;
    const taskTitle = taskItem?.taskTitle ?? null;
    const taskStatusLine = taskItem?.taskStatusLine ?? null;
    const hasTaskLink = Boolean(taskId && onOpenTask);
    const openChat = () => {
      if (variant === 'mobile' && item?.lastResult) board.markViewed(target.key, item.lastResult.id);
      onOpen(target, questionnaire);
    };
    const elapsedSeconds = startedAt !== null ? Math.max(0, Math.floor((clock - startedAt) / 1000)) : 0;
    const cardContent = (
      <>
        <span className="bot-board-card-head">
          <GrokBotAvatar botKey={target.avatarKey} roleName={target.name} isPrimary={target.isPrimary} offline={!target.online} size={40} />
          <span>
            <strong>{target.name}</strong>
            <small>{target.deviceName}{taskStatusLine ? ` · ${taskStatusLine}` : ''}</small>
          </span>
        </span>
        {desktop ? (
          <>
            <span className="bot-board-text bot-board-progress">{
              !target.online ? t('设备离线', 'Device offline') : recordError ?? (
                !item ? t('正在读取状态…', 'Loading status…') :
                item.attention && !controlling ? t(`等待你确认 · ${item.attention.count} 题`, `Awaiting confirmation · ${item.attention.count}`) :
                item.activity.phase === 'failed' ? failureMessage || t('执行失败', 'Failed') :
                item.lastResult ? item.lastResult.summary || t('已完成', 'Completed') :
                item.progress ? item.progress.current || t(`已完成 ${item.progress.completed} / ${item.progress.total} 项`, `Completed ${item.progress.completed} / ${item.progress.total}`) :
                taskTitle ? taskTitle :
                item.queuedCount ? t(`排队 ${item.queuedCount} 项`, `${item.queuedCount} queued`) : statusText
              )
            }</span>
            {stale && record?.updatedAt && <small>{t(`上次更新 ${timeText(record.updatedAt)}`, `Last updated ${timeText(record.updatedAt)}`)}</small>}
          </>
        ) : (
          <>
            {stale && <span className={target.online ? 'bot-board-warning' : 'bot-board-offline-label'}>{!target.online ? t('设备离线', 'Device offline') : recordError || t('正在刷新', 'Refreshing')}</span>}
            <span className="bot-board-status">{taskStatusLine || statusText || (target.online ? t('等待状态读取…', 'Waiting for status…') : t('尚无状态快照', 'No status snapshot yet'))}</span>
            {!!item?.queuedCount && <small>{t(`排队 ${item.queuedCount} 项`, `${item.queuedCount} queued`)}</small>}
            {item?.attention && !controlling && <span className="bot-board-text">{t(`待回答 · ${item.attention.count} 题`, `Needs answer · ${item.attention.count}`)}<br />{item.attention.summary}</span>}
            {item?.activity.phase === 'failed' && <span className="bot-board-text">{failureMessage || t('执行失败，请进入聊天处理。', 'Run failed. Open chat to handle it.')}</span>}
            {item?.progress && <span className="bot-board-progress-block"><small>{t(`已完成 ${item.progress.completed} / ${item.progress.total} 项`, `Completed ${item.progress.completed} / ${item.progress.total}`)}</small>{item.progress.current && <span className="bot-board-text">{item.progress.current}</span>}</span>}
            {item?.lastResult && <span className="bot-board-text">{item.lastResult.summary || t('已完成，打开聊天查看结果。', 'Completed. Open chat to view results.')}</span>}
            {!item?.progress && !item?.lastResult && taskTitle && <span className="bot-board-text">{taskTitle}</span>}
            {item && isBotActivityBusy(item.activity) && startedAt !== null && <small>{stale ? t(`已用时 ${elapsedSeconds} 秒（截至快照）`, `Elapsed ${elapsedSeconds}s (as of snapshot)`) : t(`已用时 ${elapsedSeconds} 秒`, `Elapsed ${elapsedSeconds}s`)}</small>}
            {item?.lastResult && <small>{t(`完成于 ${timeText(item.lastResult.completedAt)}`, `Finished ${timeText(item.lastResult.completedAt)}`)}</small>}
            {record?.updatedAt && <small>{t(`更新于 ${timeText(record.updatedAt)}`, `Updated ${timeText(record.updatedAt)}`)}</small>}
          </>
        )}
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
              className="bot-board-link-btn"
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
        <span className="bot-board-open">
          {action}
          <span aria-hidden="true"> →</span>
        </span>
      </button>
    );
  };
  const otherColumns = columns.filter(column => column.key === 'idle' || column.key === 'offline');
  const primaryColumns = columns.filter(column =>
    (showIdle || column.key !== 'idle') && (filter === 'all' || filter === column.key) &&
    (!desktop || filter !== 'all' || !otherColumns.includes(column)));
  const renderColumn = (column: typeof columns[number]) => {
    const cards = filtered.filter(row => row.bucket === column.key);
    return <section className={`bot-board-column is-${column.key}`} key={column.key}>
      <h2>{column.label} <small>{cards.length}</small></h2>
      {cards.map(renderCard)}
      {!cards.length && <p className="bot-board-empty">{t('暂无', 'None')}</p>}
    </section>;
  };
  const unknown = filtered.filter(row => row.bucket === null);
  const unknownSection = unknown.length > 0 && <section className="bot-board-unknown"><h2>{t('状态未确认', 'Status unconfirmed')}</h2><div>{unknown.map(renderCard)}</div></section>;
  const storageErrorText = localizeBoardError(board.storageError || undefined, t);
  const idleCount = filtered.filter(row => row.bucket === 'idle').length;
  const offlineCount = filtered.filter(row => row.bucket === 'offline').length;
  return <section className={`bot-board${desktop ? ' bot-board-desktop' : ''}`} aria-label={t('Bot 看板', 'Bot Board')}>
    <header className="bot-board-header">
      {onOpenMobileDrawer ? (
        <button type="button" onClick={onOpenMobileDrawer} aria-label={t('打开侧边栏', 'Open sidebar')}>
          <PanelLeft size={20} aria-hidden="true" />
        </button>
      ) : onBack ? (
        <button type="button" onClick={onBack} aria-label={t('返回', 'Back')}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
      ) : null}
      <LayoutDashboard size={22} aria-hidden="true" /><h1>{t('Bot 看板', 'Bot Board')}</h1>
      {!desktop && <span>{t('可见时约 2 秒刷新 · 只读摘要', 'Refreshes ~2s when visible · Read-only summary')}</span>}
    </header>
    <div className="bot-board-toolbar">
      <label className="bot-board-search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('搜索 Bot、设备或摘要', 'Search bots, devices, or summaries')} aria-label={t('搜索 Bot、设备或摘要', 'Search bots, devices, or summaries')} /></label>
      {!desktop && (
        <div className="bot-board-toggle">
          <Switch
            id={showIdleId}
            checked={showIdle}
            onCheckedChange={checked => {
              setShowIdle(checked);
              if (!checked && filter === 'idle') setFilter('all');
            }}
            label={t('显示空闲', 'Show idle')}
          />
          <label htmlFor={showIdleId}>{t('显示空闲', 'Show idle')}</label>
        </div>
      )}
    </div>
    <nav className="bot-board-filters" aria-label={t('状态筛选', 'Filter by status')}>
      {[{ key: 'all' as const, label: t('全部', 'All') }, ...columns.filter(c => showIdle || c.key !== 'idle')].map(c =>
        <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>{c.label} {c.key === 'all' ? rows.length : rows.filter(r => r.bucket === c.key).length}</button>)}
    </nav>
    {error && <p role="alert" className="bot-board-warning">{t(`目录读取失败：${error}`, `Failed to load directory: ${error}`)}</p>}
    {storageErrorText && <p role="alert" className="bot-board-warning">{storageErrorText}</p>}
    {filtered.some(r => r.stale && r.item) && <p className="bot-board-snapshot-note">{t('以下保留最后一次读取的状态，请留意更新时间。', 'Showing the last fetched status; check the update timestamp.')}</p>}
    {!targets.length && <p role="status">{loading ? t('正在加载 Bot 目录…', 'Loading Bot directory…') : error ? t('目录暂不可用，请恢复连接后重试。', 'Directory unavailable. Restore connection and retry.') : t('还没有 Bot，请先在对话页创建。', 'No Bots yet. Create one in chat first.')}</p>}
    {!!targets.length && !filtered.length && <p role="status">{t('没有符合筛选条件的 Bot。', 'No Bots match the current filter.')}</p>}
    {!desktop && unknownSection}
    <div className="bot-board-columns">
      {primaryColumns.map(renderColumn)}
    </div>
    {desktop && unknownSection}
    {desktop && filter === 'all' && filtered.some(row => row.bucket === 'idle' || row.bucket === 'offline') && (
      <details className="bot-board-other" open={q ? true : undefined}>
        <summary>{t(`空闲 ${idleCount} · 离线 ${offlineCount}`, `Idle ${idleCount} · Offline ${offlineCount}`)}</summary>
        <div className="bot-board-columns">{otherColumns.map(renderColumn)}</div>
      </details>
    )}
  </section>;
}
