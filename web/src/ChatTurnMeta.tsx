import { useEffect, useRef, useState } from 'react';
import { Check, Clock, Copy, X } from 'lucide-react';
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

export function ChatTurnMeta({
  timestamp,
  durationMs,
  copyText,
}: {
  timestamp?: number;
  durationMs?: number;
  copyText?: string;
}) {
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
  if (!hasDate && durationMs === undefined && !textToCopy) return null;

  const copyLabel =
    copyState === 'copied'
      ? t('已复制', 'Copied')
      : copyState === 'error'
        ? t('复制失败', 'Copy failed')
        : t('复制', 'Copy');

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
    <Check className="bot-chat-turn-copy-icon" aria-hidden />
  ) : copyState === 'error' ? (
    <X className="bot-chat-turn-copy-icon" aria-hidden />
  ) : (
    <Copy className="bot-chat-turn-copy-icon" aria-hidden />
  );

  return (
    <div className="bot-chat-turn-meta">
      {hasDate && <time dateTime={date.toISOString()}>{dateTimeFormat.format(date)}</time>}
      {durationMs !== undefined && (
        <span className="bot-chat-turn-duration">
          <Clock className="bot-chat-turn-clock" aria-hidden />
          {formatTurnDuration(durationMs, t)}
        </span>
      )}
      {textToCopy ? (
        <button
          type="button"
          className={isCoarse ? 'ui-icon-btn is-ghost is-sm bot-chat-turn-copy' : 'bot-chat-turn-copy'}
          aria-label={copyLabel}
          title={isCoarse ? undefined : copyLabel}
          data-copied={copyState === 'copied' || undefined}
          data-copy-error={copyState === 'error' || undefined}
          onClick={handleCopy}
        >
          {copyIcon}
        </button>
      ) : null}
    </div>
  );
}
