import { useEffect, useRef, useState } from 'react';
import { Check, Clock, Copy, Pencil, X } from 'lucide-react';
import { formatTurnDuration } from './chatTurnModel';
import './components/ui/components.css';
import { useText } from './ui';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

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

export interface ChatTurnMetaProps {
  timestamp?: number;
  durationMs?: number;
  copyText?: string;
  onEdit?: () => void;
  /** 轮次角色；assistant 始终预留固定最小高度，避免首个 token 到达时行高从 0 跳变。 */
  role?: 'user' | 'assistant';
  /** 显式控制是否预留最小高度；默认在 role === 'assistant' 时为 true。 */
  reserveHeight?: boolean;
  /** 是否在非粗指针端展示「复制 / 已复制」固定宽度文案栈（默认沿用纯图标按钮）。 */
  showCopyLabel?: boolean;
}

export function ChatTurnMeta({
  timestamp,
  durationMs,
  copyText,
  onEdit,
  role,
  reserveHeight,
  showCopyLabel = false,
}: ChatTurnMetaProps) {
  const t = useText();
  const isCoarse = useIsCoarsePointer();
  const mountedRef = useRef(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timeout = window.setTimeout(() => setCopyState('idle'), 1_400);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const date = new Date(timestamp ?? NaN);
  const hasDate = Number.isFinite(date.getTime());
  const textToCopy = copyText && copyText.trim().length > 0 ? copyText : '';
  const shouldReserve = reserveHeight ?? (role === 'assistant');
  const reservedMinHeight = isCoarse ? 32 : 24;

  if (!hasDate && durationMs === undefined && !textToCopy && !onEdit) {
    if (!shouldReserve) return null;
    return (
      <div
        className="bot-chat-turn-meta is-empty"
        style={{ minHeight: reservedMinHeight }}
        aria-hidden="true"
      />
    );
  }

  const idleCopyText = t('复制', 'Copy');
  const editLabel = t('编辑消息', 'Edit message');
  const copiedText = t('已复制', 'Copied');
  const errorShortText = t('失败', 'Failed');
  const copyLabel =
    copyState === 'copied'
      ? copiedText
      : copyState === 'error'
        ? t('复制失败', 'Copy failed')
        : idleCopyText;

  const handleCopy = () => {
    if (!textToCopy || !navigator.clipboard?.writeText) {
      setCopyState('error');
      return;
    }
    try {
      void navigator.clipboard
        .writeText(textToCopy)
        .then(() => { if (mountedRef.current) setCopyState('copied'); })
        .catch(() => { if (mountedRef.current) setCopyState('error'); });
    } catch {
      setCopyState('error');
    }
  };

  const copyIcon = copyState === 'copied' ? (
    <Check className="bot-chat-turn-action-icon" aria-hidden />
  ) : copyState === 'error' ? (
    <X className="bot-chat-turn-action-icon" aria-hidden />
  ) : (
    <Copy className="bot-chat-turn-action-icon" aria-hidden />
  );

  return (
    <div
      className="bot-chat-turn-meta"
      style={shouldReserve ? { minHeight: reservedMinHeight } : undefined}
    >
      {hasDate && <time dateTime={date.toISOString()}>{dateTimeFormat.format(date)}</time>}
      {durationMs !== undefined && (
        <span className="bot-chat-turn-duration">
          <Clock className="bot-chat-turn-clock" aria-hidden />
          {formatTurnDuration(durationMs, t)}
        </span>
      )}
      {onEdit ? (
        <button
          type="button"
          className={isCoarse ? 'ui-icon-btn is-ghost is-sm bot-chat-turn-action' : 'bot-chat-turn-action'}
          aria-label={editLabel}
          title={isCoarse ? undefined : editLabel}
          onClick={onEdit}
        >
          <Pencil className="bot-chat-turn-action-icon" aria-hidden />
        </button>
      ) : null}
      {textToCopy ? (
        <button
          type="button"
          className={isCoarse ? 'ui-icon-btn is-ghost is-sm bot-chat-turn-action bot-chat-turn-copy' : 'bot-chat-turn-action bot-chat-turn-copy'}
          aria-label={copyLabel}
          title={isCoarse ? undefined : copyLabel}
          data-copied={copyState === 'copied' || undefined}
          data-copy-error={copyState === 'error' || undefined}
          onClick={handleCopy}
        >
          {copyIcon}
          {showCopyLabel && !isCoarse ? (
            <span
              className="bot-chat-turn-copy-label"
              style={{ display: 'inline-grid', alignItems: 'center', marginLeft: 4 }}
            >
              <span
                style={{ gridArea: '1 / 1', visibility: copyState === 'idle' ? 'visible' : 'hidden' }}
                aria-hidden={copyState !== 'idle' || undefined}
              >
                {idleCopyText}
              </span>
              <span
                style={{ gridArea: '1 / 1', visibility: copyState === 'copied' ? 'visible' : 'hidden' }}
                aria-hidden={copyState !== 'copied' || undefined}
              >
                {copiedText}
              </span>
              <span
                style={{ gridArea: '1 / 1', visibility: copyState === 'error' ? 'visible' : 'hidden' }}
                aria-hidden={copyState !== 'error' || undefined}
              >
                {errorShortText}
              </span>
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
