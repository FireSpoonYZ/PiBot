import { useState } from 'react';
import { ArrowLeft, LayoutDashboard, Search } from 'lucide-react';
import { GrokBotAvatar } from './GrokBotAvatar';
import { botActivityText, isBotActivityBusy, parseBotActivityStartedAt } from './botActivity';
import { botBoardBucket, type BoardBucket, type BotBoardState, type BotBoardTarget } from './useBotBoard';
import './BotBoard.css';

const columns: { key: BoardBucket; label: string }[] = [
  { key: 'attention', label: '需要你' },
  { key: 'working', label: '工作中' },
  { key: 'review', label: '待查看' },
  { key: 'idle', label: '空闲' },
];
const timeText = (value: string) => new Date(value).toLocaleString();

export function BotBoard({ targets, board, onOpen, onBack, loading, error }: {
  targets: BotBoardTarget[];
  board: BotBoardState;
  onOpen: (target: BotBoardTarget) => void;
  onBack?: () => void;
  loading?: boolean;
  error?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [showIdle, setShowIdle] = useState(true);
  const [filter, setFilter] = useState<BoardBucket | 'all'>('all');
  const rows = targets.map(target => {
    const record = board.records.get(target.key);
    const item = record?.item;
    const bucket = item ? botBoardBucket(item, board.seen.get(target.key)) : null;
    const stale = !target.online || !!record?.error || record?.generation !== target.generation;
    return { target, record, item, bucket, stale };
  });
  const q = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(({ target, item, bucket }) =>
    (showIdle || bucket !== 'idle') &&
    (filter === 'all' || bucket === filter || bucket === null) &&
    [target.name, target.deviceName, item?.attention?.summary, item?.lastResult?.summary, item?.progress?.current, item?.activity.error?.message]
      .join(' ').toLocaleLowerCase().includes(q));
  const renderCard = ({ target, record, item, stale }: typeof rows[number]) => {
    const startedAt = item ? parseBotActivityStartedAt(item.activity) : null;
    // A disconnected clock freezes at the last successful snapshot.
    const clock = stale && record?.updatedAt ? Date.parse(record.updatedAt) : Date.now();
    const controlling = item?.activity.phase === 'stopping' || item?.activity.phase === 'interrupting';
    return <button type="button" className="bot-board-card" key={target.key} onClick={() => {
      if (item?.lastResult) board.markViewed(target.key, item.lastResult.id);
      onOpen(target);
    }} aria-label={`打开 ${target.name} 的聊天 · ${target.deviceName}`}>
      <span className="bot-board-card-head">
        <GrokBotAvatar botKey={target.avatarKey} roleName={target.name} size={40} />
        <span><strong>{target.name}</strong><small>{target.deviceName}</small></span>
      </span>
      {stale && <span className="bot-board-warning">{!target.online ? '设备离线' : record?.error || '正在刷新'}</span>}
      <span className="bot-board-status">{item ? botActivityText(item.activity, zh => zh) : target.online ? '等待状态读取…' : '尚无状态快照'}</span>
      {!!item?.queuedCount && <small>排队 {item.queuedCount} 项</small>}
      {item?.attention && !controlling && <p>待回答 · {item.attention.count} 题<br />{item.attention.summary}</p>}
      {item?.activity.phase === 'failed' && <p>{item.activity.error?.message || '执行失败，请进入聊天处理。'}</p>}
      {item?.progress && <span><small>已完成 {item.progress.completed} / {item.progress.total} 项</small>{item.progress.current && <p>{item.progress.current}</p>}</span>}
      {item?.lastResult && <p>{item.lastResult.summary || '已完成，打开聊天查看结果。'}</p>}
      {item && isBotActivityBusy(item.activity) && startedAt !== null && <small>已用时 {Math.max(0, Math.floor((clock - startedAt) / 1000))} 秒{stale ? '（截至快照）' : ''}</small>}
      {item?.lastResult && <small>完成于 {timeText(item.lastResult.completedAt)}</small>}
      {record?.updatedAt && <small>更新于 {timeText(record.updatedAt)}</small>}
      <span className="bot-board-open">进入聊天 →</span>
    </button>;
  };
  return <section className="bot-board" aria-label="Bot 看板">
    <header className="bot-board-header">
      {onBack && <button type="button" onClick={onBack} aria-label="返回"><ArrowLeft size={20} /></button>}
      <LayoutDashboard size={22} aria-hidden /><h1>Bot 看板</h1>
      <span>可见时约 2 秒刷新 · 只读摘要</span>
    </header>
    <div className="bot-board-toolbar">
      <label className="bot-board-search"><Search size={16} aria-hidden /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 Bot、设备或摘要" aria-label="搜索 Bot、设备或摘要" /></label>
      <label><input type="checkbox" checked={showIdle} onChange={e => { setShowIdle(e.target.checked); if (!e.target.checked && filter === 'idle') setFilter('all'); }} /> 显示空闲</label>
    </div>
    <nav className="bot-board-filters" aria-label="状态筛选">
      {[{ key: 'all' as const, label: '全部' }, ...columns.filter(c => showIdle || c.key !== 'idle')].map(c =>
        <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>{c.label} {c.key === 'all' ? rows.length : rows.filter(r => r.bucket === c.key).length}</button>)}
    </nav>
    {error && <p role="alert" className="bot-board-warning">目录读取失败：{error}</p>}
    {board.storageError && <p role="alert" className="bot-board-warning">{board.storageError}</p>}
    {filtered.some(r => r.stale && r.item) && <p className="bot-board-warning">以下保留最后一次读取的状态，请留意更新时间。</p>}
    {!targets.length && <p role="status">{loading ? '正在加载 Bot 目录…' : error ? '目录暂不可用，请恢复连接后重试。' : '还没有 Bot，请先在对话页创建。'}</p>}
    {!!targets.length && !filtered.length && <p role="status">没有符合筛选条件的 Bot。</p>}
    {filtered.some(r => r.bucket === null) && <section className="bot-board-unknown"><h2>状态未确认</h2><div>{filtered.filter(r => r.bucket === null).map(renderCard)}</div></section>}
    <div className="bot-board-columns">
      {columns.filter(c => (showIdle || c.key !== 'idle') && (filter === 'all' || filter === c.key)).map(column =>
        <section className={`bot-board-column is-${column.key}`} key={column.key}>
          <h2>{column.label} <small>{filtered.filter(r => r.bucket === column.key).length}</small></h2>
          {filtered.filter(r => r.bucket === column.key).map(renderCard)}
          {!filtered.some(r => r.bucket === column.key) && <p className="bot-board-empty">暂无</p>}
        </section>)}
    </div>
  </section>;
}
