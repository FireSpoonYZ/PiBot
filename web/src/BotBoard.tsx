import { useState } from 'react';
import { ArrowLeft, LayoutDashboard, Search } from 'lucide-react';
import type { BotBoardItem } from '../../host-core/index.js';
import { GrokBotAvatar } from './GrokBotAvatar';
import { botActivityText, isBotActivityBusy, parseBotActivityStartedAt } from './botActivity';
import { botBoardBucket, type BoardBucket, type BotBoardState, type BotBoardTarget } from './useBotBoard';
import './BotBoard.css';

type TaskAwareBoardItem = BotBoardItem & {
  taskId?: string | null;
  taskTitle?: string | null;
  taskStatusLine?: string | null;
};

const columns: { key: BoardBucket; label: string }[] = [
  { key: 'attention', label: '需要你' },
  { key: 'working', label: '工作中' },
  { key: 'review', label: '待查看' },
  { key: 'idle', label: '空闲' },
  { key: 'offline', label: '离线' },
];
const timeText = (value: string) => new Date(value).toLocaleString();

export function BotBoard({ targets, board, onOpen, onOpenTask, onBack, loading, error, variant = 'mobile' }: {
  targets: BotBoardTarget[];
  board: BotBoardState;
  onOpen: (target: BotBoardTarget, questionnaire?: { conversationId: string; requestId: string }) => void;
  onOpenTask?: (taskId: string) => void;
  onBack?: () => void;
  loading?: boolean;
  error?: string | null;
  variant?: 'desktop' | 'mobile';
}) {
  const [query, setQuery] = useState('');
  const [showIdle, setShowIdle] = useState(true);
  const [filter, setFilter] = useState<BoardBucket | 'all'>('all');
  const desktop = variant === 'desktop';
  const columnLabel = ({ key, label }: typeof columns[number]) => desktop && key === 'working' ? '进行中' : label;
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
    const review = desktop && !stale && bucket === 'review';
    const failed = desktop && !stale && item?.activity.phase === 'failed';
    const action = questionnaire ? '回答问题' : review ? '查看结果' : failed ? '查看失败原因' : '进入聊天';
    const actionLabel = questionnaire ? `回答 ${target.name} 的问题` : review ? `查看 ${target.name} 的结果` : `打开 ${target.name} 的聊天`;
    const taskItem = item as TaskAwareBoardItem | undefined;
    const taskId = taskItem?.taskId ?? null;
    const taskTitle = taskItem?.taskTitle ?? null;
    const taskStatusLine = taskItem?.taskStatusLine ?? null;
    const hasTaskLink = Boolean(taskId && onOpenTask);
    const openChat = () => {
      if (variant === 'mobile' && item?.lastResult) board.markViewed(target.key, item.lastResult.id);
      onOpen(target, questionnaire);
    };
    const cardBody = (
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
            <p className="bot-board-progress">{
              !target.online ? '设备离线' : record?.error ?? (
                !item ? '正在读取状态…' :
                item.attention && !controlling ? `等待你确认 · ${item.attention.count} 题` :
                item.activity.phase === 'failed' ? item.activity.error?.message || '执行失败' :
                item.lastResult ? item.lastResult.summary || '已完成' :
                item.progress ? item.progress.current || `已完成 ${item.progress.completed} / ${item.progress.total} 项` :
                taskTitle ? taskTitle :
                item.queuedCount ? `排队 ${item.queuedCount} 项` : botActivityText(item.activity, zh => zh)
              )
            }</p>
            {stale && record?.updatedAt && <small>上次更新 {timeText(record.updatedAt)}</small>}
          </>
        ) : (
          <>
            {stale && <span className={target.online ? 'bot-board-warning' : 'bot-board-offline-label'}>{!target.online ? '设备离线' : record?.error || '正在刷新'}</span>}
            <span className="bot-board-status">{taskStatusLine || (item ? botActivityText(item.activity, zh => zh) : target.online ? '等待状态读取…' : '尚无状态快照')}</span>
            {!!item?.queuedCount && <small>排队 {item.queuedCount} 项</small>}
            {item?.attention && !controlling && <p>待回答 · {item.attention.count} 题<br />{item.attention.summary}</p>}
            {item?.activity.phase === 'failed' && <p>{item.activity.error?.message || '执行失败，请进入聊天处理。'}</p>}
            {item?.progress && <span><small>已完成 {item.progress.completed} / {item.progress.total} 项</small>{item.progress.current && <p>{item.progress.current}</p>}</span>}
            {item?.lastResult && <p>{item.lastResult.summary || '已完成，打开聊天查看结果。'}</p>}
            {!item?.progress && !item?.lastResult && taskTitle && <p>{taskTitle}</p>}
            {item && isBotActivityBusy(item.activity) && startedAt !== null && <small>已用时 {Math.max(0, Math.floor((clock - startedAt) / 1000))} 秒{stale ? '（截至快照）' : ''}</small>}
            {item?.lastResult && <small>完成于 {timeText(item.lastResult.completedAt)}</small>}
            {record?.updatedAt && <small>更新于 {timeText(record.updatedAt)}</small>}
          </>
        )}
        {hasTaskLink ? (
          <div className="bot-board-links" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%' }}>
            <button
              type="button"
              className="bot-board-open"
              style={{ border: 0, background: 'transparent', padding: 0 }}
              onClick={e => {
                e.stopPropagation();
                onOpenTask!(taskId!);
              }}
            >
              查看任务 →
            </button>
            <span className="bot-board-open">{action} →</span>
          </div>
        ) : (
          <span className="bot-board-open">{action} →</span>
        )}
      </>
    );
    if (hasTaskLink) {
      return (
        <div
          role="button"
          tabIndex={0}
          className={`bot-board-card${!target.online ? ' is-offline' : ''}`}
          style={{ cursor: 'pointer' }}
          key={target.key}
          onClick={openChat}
          onKeyDown={e => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              openChat();
            }
          }}
          aria-label={`${actionLabel} · ${target.deviceName}`}
        >
          {cardBody}
        </div>
      );
    }
    return <button type="button" className={`bot-board-card${!target.online ? ' is-offline' : ''}`} key={target.key} onClick={openChat} aria-label={`${actionLabel} · ${target.deviceName}`}>
      {cardBody}
    </button>;
  };
  const otherColumns = columns.filter(column => column.key === 'idle' || column.key === 'offline');
  const primaryColumns = columns.filter(column =>
    (showIdle || column.key !== 'idle') && (filter === 'all' || filter === column.key) &&
    (!desktop || filter !== 'all' || !otherColumns.includes(column)));
  const renderColumn = (column: typeof columns[number]) => {
    const cards = filtered.filter(row => row.bucket === column.key);
    return <section className={`bot-board-column is-${column.key}`} key={column.key}>
      <h2>{columnLabel(column)} <small>{cards.length}</small></h2>
      {cards.map(renderCard)}
      {!cards.length && <p className="bot-board-empty">暂无</p>}
    </section>;
  };
  const unknown = filtered.filter(row => row.bucket === null);
  const unknownSection = unknown.length > 0 && <section className="bot-board-unknown"><h2>状态未确认</h2><div>{unknown.map(renderCard)}</div></section>;
  return <section className={`bot-board${desktop ? ' bot-board-desktop' : ''}`} aria-label="Bot 看板">
    <header className="bot-board-header">
      {onBack && <button type="button" onClick={onBack} aria-label="返回"><ArrowLeft size={20} /></button>}
      <LayoutDashboard size={22} aria-hidden /><h1>Bot 看板</h1>
      {!desktop && <span>可见时约 2 秒刷新 · 只读摘要</span>}
    </header>
    <div className="bot-board-toolbar">
      <label className="bot-board-search"><Search size={16} aria-hidden /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 Bot、设备或摘要" aria-label="搜索 Bot、设备或摘要" /></label>
      {!desktop && <label><input type="checkbox" checked={showIdle} onChange={e => { setShowIdle(e.target.checked); if (!e.target.checked && filter === 'idle') setFilter('all'); }} /> 显示空闲</label>}
    </div>
    <nav className="bot-board-filters" aria-label="状态筛选">
      {[{ key: 'all' as const, label: '全部' }, ...columns.filter(c => showIdle || c.key !== 'idle')].map(c =>
        <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>{c.key === 'all' ? c.label : columnLabel(c)} {c.key === 'all' ? rows.length : rows.filter(r => r.bucket === c.key).length}</button>)}
    </nav>
    {error && <p role="alert" className="bot-board-warning">目录读取失败：{error}</p>}
    {board.storageError && <p role="alert" className="bot-board-warning">{board.storageError}</p>}
    {filtered.some(r => r.stale && r.item) && <p className="bot-board-snapshot-note">以下保留最后一次读取的状态，请留意更新时间。</p>}
    {!targets.length && <p role="status">{loading ? '正在加载 Bot 目录…' : error ? '目录暂不可用，请恢复连接后重试。' : '还没有 Bot，请先在对话页创建。'}</p>}
    {!!targets.length && !filtered.length && <p role="status">没有符合筛选条件的 Bot。</p>}
    {!desktop && unknownSection}
    <div className="bot-board-columns">
      {primaryColumns.map(renderColumn)}
    </div>
    {desktop && unknownSection}
    {desktop && filter === 'all' && filtered.some(row => row.bucket === 'idle' || row.bucket === 'offline') && (
      <details className="bot-board-other" open={q ? true : undefined}>
        <summary>空闲 {filtered.filter(row => row.bucket === 'idle').length} · 离线 {filtered.filter(row => row.bucket === 'offline').length}</summary>
        <div className="bot-board-columns">{otherColumns.map(renderColumn)}</div>
      </details>
    )}
  </section>;
}
