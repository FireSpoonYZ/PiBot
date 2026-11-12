import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, CornerUpLeft, Pencil, X, Zap } from 'lucide-react';
import type { UnifiedQueuedStripItem } from './composerFlowControl';

type TranslateFn = (zh: string, en: string) => string;

const defaultTr: TranslateFn = zh => zh;

export interface PendingQueueStripProps {
  items: readonly UnifiedQueuedStripItem[];
  disabled?: boolean;
  onRecall: (item: UnifiedQueuedStripItem) => void;
  onRecallAll: () => void;
  onDiscard: (item: UnifiedQueuedStripItem) => void;
  onSteer?: (item: UnifiedQueuedStripItem) => void;
  tr?: TranslateFn;
}

export function PendingQueueStrip({
  items,
  disabled = false,
  onRecall,
  onRecallAll,
  onDiscard,
  onSteer,
  tr = defaultTr,
}: PendingQueueStripProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (items.length < 2 && expanded) {
      setExpanded(false);
    }
  }, [items.length, expanded]);

  if (items.length === 0) return null;

  if (items.length === 1) {
    const item = items[0];
    const isSteer = item.delivery === 'steer';
    return (
      <div className="cf-queue-strip" role="region" aria-label={tr('排队消息', 'Queued messages')}>
        <div className="cf-queue-row">
          <button
            type="button"
            className={`cf-queue-main ${isSteer ? 'is-steer' : ''}`}
            disabled={disabled}
            onClick={() => onRecall(item)}
            title={tr('撤回到输入框继续编辑 (Alt+↑)', 'Recall into composer to edit (Alt+Up)')}
          >
            <span className="cf-queue-lead-icon" aria-hidden="true">
              {isSteer ? <Zap size={12} /> : <CornerUpLeft size={12} />}
            </span>
            <span className="cf-queue-tag">
              {isSteer ? tr('待插入', 'Steer') : tr('排队中', 'Queued')}
            </span>
            <span className="cf-queue-dot" aria-hidden="true">·</span>
            <span className="cf-queue-preview">
              {item.preview || tr('空消息', 'Message')}
            </span>
          </button>
          <div className="cf-queue-actions">
            {item.source === 'host' && !isSteer && onSteer ? (
              <button
                type="button"
                className="cf-queue-icon-btn is-steer-btn"
                disabled={disabled}
                onClick={() => onSteer(item)}
                title={tr('打断并立即插入', 'Interrupt & send immediately')}
                aria-label={tr('打断并立即插入', 'Interrupt & send immediately')}
              >
                <Zap size={13} />
              </button>
            ) : null}
            <button
              type="button"
              className="cf-queue-icon-btn"
              disabled={disabled}
              onClick={() => onDiscard(item)}
              title={tr('移除此排队消息', 'Discard queued message')}
              aria-label={tr('移除此排队消息', 'Discard queued message')}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const first = items[0];
  return (
    <div
      className={`cf-queue-strip is-multi ${expanded ? 'is-expanded' : ''}`}
      role="region"
      aria-label={tr('排队消息', 'Queued messages')}
    >
      {expanded ? (
        <div className="cf-queue-expanded-list">
          {items.map(item => {
            const isSteer = item.delivery === 'steer';
            return (
              <div key={item.requestId} className="cf-queue-row is-subrow">
                <button
                  type="button"
                  className={`cf-queue-main ${isSteer ? 'is-steer' : ''}`}
                  disabled={disabled}
                  onClick={() => onRecall(item)}
                  title={tr('撤回到输入框继续编辑', 'Recall into composer to edit')}
                >
                  <span className="cf-queue-lead-icon" aria-hidden="true">
                    {isSteer ? <Zap size={12} /> : <CornerUpLeft size={12} />}
                  </span>
                  {isSteer ? (
                    <>
                      <span className="cf-queue-tag">{tr('待插入', 'Steer')}</span>
                      <span className="cf-queue-dot" aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <span className="cf-queue-preview">
                    {item.preview || tr('空消息', 'Message')}
                  </span>
                </button>
                <div className="cf-queue-actions">
                  {item.source === 'host' && !isSteer && onSteer ? (
                    <button
                      type="button"
                      className="cf-queue-icon-btn is-steer-btn"
                      disabled={disabled}
                      onClick={() => onSteer(item)}
                      title={tr('打断并立即插入', 'Interrupt & send immediately')}
                      aria-label={tr('打断并立即插入', 'Interrupt & send immediately')}
                    >
                      <Zap size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="cf-queue-icon-btn"
                    disabled={disabled}
                    onClick={() => onDiscard(item)}
                    title={tr('移除此排队消息', 'Discard queued message')}
                    aria-label={tr('移除此排队消息', 'Discard queued message')}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="cf-queue-row cf-queue-summary-row">
        <button
          type="button"
          className="cf-queue-main"
          onClick={() => setExpanded(prev => !prev)}
          aria-expanded={expanded}
          title={expanded ? tr('收起排队列表', 'Collapse queue') : tr('展开排队列表', 'Expand queue')}
        >
          <span className="cf-queue-lead-icon" aria-hidden="true">
            <CornerUpLeft size={12} />
          </span>
          <span className="cf-queue-tag">
            {tr(`${items.length} 条排队`, `${items.length} queued`)}
          </span>
          <span className="cf-queue-dot" aria-hidden="true">·</span>
          <span className="cf-queue-preview">
            {first.preview || tr('空消息', 'Message')}
          </span>
          <span className="cf-queue-chevron" aria-hidden="true">
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>
        <div className="cf-queue-actions">
          <button
            type="button"
            className="cf-queue-text-btn"
            disabled={disabled}
            onClick={onRecallAll}
            title={tr('将全部排队消息撤回到输入框', 'Recall all queued messages into composer')}
          >
            {tr('全部撤回', 'Recall all')}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ComposerEditBannerProps {
  disabled?: boolean;
  onCancel: () => void;
  tr?: TranslateFn;
}

export function ComposerEditBanner({
  disabled = false,
  onCancel,
  tr = defaultTr,
}: ComposerEditBannerProps) {
  return (
    <div className="cf-edit-banner" role="status">
      <div className="cf-edit-banner-main">
        <span className="cf-edit-banner-icon" aria-hidden="true">
          <Pencil size={12} />
        </span>
        <span className="cf-edit-banner-text">
          {tr('正在编辑消息 · 发送后将从此条重新回复', 'Editing message · Sending will reply again from here')}
        </span>
      </div>
      <button
        type="button"
        className="cf-queue-icon-btn"
        disabled={disabled}
        onClick={onCancel}
        title={tr('取消编辑 (Esc)', 'Cancel edit (Esc)')}
        aria-label={tr('取消编辑', 'Cancel edit')}
      >
        <X size={13} />
      </button>
    </div>
  );
}
