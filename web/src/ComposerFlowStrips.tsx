import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronUp, CornerUpLeft, Pencil, X, Zap } from 'lucide-react';
import type { UnifiedQueuedStripItem } from './composerFlowControl';
import { Button, IconButton } from './components/ui';
import { useText } from './ui';

type TranslateFn = (zh: string, en: string) => string;

const isCoarsePointer = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    setCoarse(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
  }, []);
  return coarse;
}

export interface PendingQueueStripProps {
  items: readonly UnifiedQueuedStripItem[];
  disabled?: boolean;
  canSteer?: boolean;
  onRecall: (item: UnifiedQueuedStripItem) => void;
  onRecallAll: () => void;
  onDiscard: (item: UnifiedQueuedStripItem) => void;
  onSteer?: (item: UnifiedQueuedStripItem) => void;
  tr?: TranslateFn;
}

export function PendingQueueStrip({
  items,
  disabled = false,
  canSteer = false,
  onRecall,
  onRecallAll,
  onDiscard,
  onSteer,
  tr,
}: PendingQueueStripProps) {
  const fallbackT = useText();
  const t = tr ?? fallbackT;
  const listId = useId();
  const isCoarse = useIsCoarsePointer();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (items.length < 2 && expanded) {
      setExpanded(false);
    }
  }, [items.length, expanded]);

  if (items.length === 0) return null;

  const renderSteerButton = (item: UnifiedQueuedStripItem) => {
    const label = t('打断并立即插入', 'Interrupt & send immediately');
    if (isCoarse) {
      return (
        <IconButton
          size="sm"
          variant="ghost"
          className="cf-queue-icon-btn is-steer-btn"
          disabled={disabled}
          onClick={() => onSteer?.(item)}
          label={label}
        >
          <Zap size={13} aria-hidden="true" />
        </IconButton>
      );
    }
    return (
      <button
        type="button"
        className="cf-queue-icon-btn is-steer-btn"
        disabled={disabled}
        onClick={() => onSteer?.(item)}
        title={label}
        aria-label={label}
      >
        <Zap size={13} aria-hidden="true" />
      </button>
    );
  };

  const renderDiscardButton = (item: UnifiedQueuedStripItem, isOutbox: boolean) => {
    const label = isOutbox ? t('移除此待发送消息', 'Discard pending message') : t('移除此排队消息', 'Discard queued message');
    if (isCoarse) {
      return (
        <IconButton
          size="sm"
          variant="ghost"
          className="cf-queue-icon-btn"
          disabled={disabled}
          onClick={() => onDiscard(item)}
          label={label}
        >
          <X size={13} aria-hidden="true" />
        </IconButton>
      );
    }
    return (
      <button
        type="button"
        className="cf-queue-icon-btn"
        disabled={disabled}
        onClick={() => onDiscard(item)}
        title={label}
        aria-label={label}
      >
        <X size={13} aria-hidden="true" />
      </button>
    );
  };

  if (items.length === 1) {
    const item = items[0];
    const isOutbox = item.source === 'outbox';
    const isSteer = !isOutbox && item.delivery === 'steer';
    return (
      <div
        className="cf-queue-strip"
        role="region"
        aria-label={isOutbox ? t('待发送消息', 'Pending messages') : t('排队消息', 'Queued messages')}
      >
        <div className="cf-queue-row">
          <button
            type="button"
            className={`cf-queue-main ${isSteer ? 'is-steer' : ''}`}
            disabled={disabled}
            onClick={() => onRecall(item)}
            title={isCoarse ? undefined : t('撤回到输入框继续编辑 (Alt+↑)', 'Recall into composer to edit (Alt+Up)')}
          >
            <span className="cf-queue-lead-icon" aria-hidden="true">
              {isSteer ? <Zap size={12} /> : <CornerUpLeft size={12} />}
            </span>
            <span className="cf-queue-tag tabular-nums">
              {isOutbox
                ? t('待发送', 'Pending')
                : isSteer
                  ? t('待插入', 'Steer')
                  : t('排队中', 'Queued')}
            </span>
            <span className="cf-queue-dot" aria-hidden="true">·</span>
            <span className="cf-queue-preview">
              {item.preview || t('空消息', 'Message')}
            </span>
          </button>
          <div className="cf-queue-actions">
            {canSteer && !isOutbox && !isSteer && onSteer ? renderSteerButton(item) : null}
            {renderDiscardButton(item, isOutbox)}
          </div>
        </div>
      </div>
    );
  }

  const first = items[0];
  const hostCount = items.filter(item => item.source === 'host').length;
  const outboxCount = items.length - hostCount;
  const onlyOutbox = outboxCount === items.length;
  const recallAllTitle = onlyOutbox
    ? t('将全部待发送消息撤回到输入框', 'Recall all pending messages into composer')
    : t('将全部排队消息撤回到输入框', 'Recall all queued messages into composer');
  return (
    <div
      className={`cf-queue-strip is-multi ${expanded ? 'is-expanded' : ''}`}
      role="region"
      aria-label={onlyOutbox ? t('待发送消息', 'Pending messages') : t('排队消息', 'Queued messages')}
    >
      {expanded ? (
        <div id={listId} className="cf-queue-expanded-list">
          {items.map(item => {
            const isOutbox = item.source === 'outbox';
            const isSteer = !isOutbox && item.delivery === 'steer';
            const showSubrowTag = isOutbox || isSteer || outboxCount > 0;
            return (
              <div key={item.requestId} className="cf-queue-row is-subrow">
                <button
                  type="button"
                  className={`cf-queue-main ${isSteer ? 'is-steer' : ''}`}
                  disabled={disabled}
                  onClick={() => onRecall(item)}
                  title={isCoarse ? undefined : t('撤回到输入框继续编辑', 'Recall into composer to edit')}
                >
                  <span className="cf-queue-lead-icon" aria-hidden="true">
                    {isSteer ? <Zap size={12} /> : <CornerUpLeft size={12} />}
                  </span>
                  {showSubrowTag ? (
                    <>
                      <span className="cf-queue-tag">
                        {isOutbox
                          ? t('待发送', 'Pending')
                          : isSteer
                            ? t('待插入', 'Steer')
                            : t('排队中', 'Queued')}
                      </span>
                      <span className="cf-queue-dot" aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <span className="cf-queue-preview">
                    {item.preview || t('空消息', 'Message')}
                  </span>
                </button>
                <div className="cf-queue-actions">
                  {canSteer && !isOutbox && !isSteer && onSteer ? renderSteerButton(item) : null}
                  {renderDiscardButton(item, isOutbox)}
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
          aria-controls={listId}
          title={
            isCoarse
              ? undefined
              : expanded
                ? (onlyOutbox ? t('收起待发送列表', 'Collapse pending list') : t('收起排队列表', 'Collapse queue'))
                : (onlyOutbox ? t('展开待发送列表', 'Expand pending list') : t('展开排队列表', 'Expand queue'))
          }
        >
          <span className="cf-queue-lead-icon" aria-hidden="true">
            <CornerUpLeft size={12} />
          </span>
          <span className="cf-queue-tag tabular-nums">
            {onlyOutbox
              ? t(`${items.length} 条待发送`, `${items.length} pending`)
              : outboxCount === 0
                ? t(`${items.length} 条排队`, `${items.length} queued`)
                : t(`${hostCount} 条排队 · ${outboxCount} 条待发送`, `${hostCount} queued · ${outboxCount} pending`)}
          </span>
          <span className="cf-queue-dot" aria-hidden="true">·</span>
          <span className="cf-queue-preview">
            {first.preview || t('空消息', 'Message')}
          </span>
          <span className="cf-queue-chevron" aria-hidden="true">
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>
        <div className="cf-queue-actions">
          {isCoarse ? (
            <Button
              size="sm"
              variant="ghost"
              className="cf-queue-text-btn"
              disabled={disabled}
              onClick={onRecallAll}
            >
              {t('全部撤回', 'Recall all')}
            </Button>
          ) : (
            <button
              type="button"
              className="cf-queue-text-btn"
              disabled={disabled}
              onClick={onRecallAll}
              title={recallAllTitle}
            >
              {t('全部撤回', 'Recall all')}
            </button>
          )}
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
  tr,
}: ComposerEditBannerProps) {
  const fallbackT = useText();
  const t = tr ?? fallbackT;
  const isCoarse = useIsCoarsePointer();
  return (
    <div className="cf-edit-banner" role="status">
      <div className="cf-edit-banner-main">
        <span className="cf-edit-banner-icon" aria-hidden="true">
          <Pencil size={12} />
        </span>
        <span className="cf-edit-banner-text">
          {t('正在编辑消息 · 发送后将从此条重新回复', 'Editing message · Sending will reply again from here')}
        </span>
      </div>
      {isCoarse ? (
        <IconButton
          size="sm"
          variant="ghost"
          className="cf-queue-icon-btn"
          disabled={disabled}
          onClick={onCancel}
          label={t('取消编辑', 'Cancel edit')}
        >
          <X size={13} aria-hidden="true" />
        </IconButton>
      ) : (
        <button
          type="button"
          className="cf-queue-icon-btn"
          disabled={disabled}
          onClick={onCancel}
          title={t('取消编辑 (Esc)', 'Cancel edit (Esc)')}
          aria-label={t('取消编辑', 'Cancel edit')}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
