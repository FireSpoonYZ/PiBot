import { Clock } from 'lucide-react';
import { formatTurnDuration } from './chatTurnModel';
import { useText } from './ui';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function ChatTurnMeta({ timestamp, durationMs }: { timestamp?: number; durationMs?: number }) {
  const t = useText();
  const date = new Date(timestamp ?? NaN);
  const hasDate = Number.isFinite(date.getTime());
  if (!hasDate && durationMs === undefined) return null;
  return (
    <div className="bot-chat-turn-meta">
      {hasDate && <time dateTime={date.toISOString()}>{dateTimeFormat.format(date)}</time>}
      {durationMs !== undefined && (
        <span className="bot-chat-turn-duration">
          <Clock className="bot-chat-turn-clock" aria-hidden />
          {formatTurnDuration(durationMs, t)}
        </span>
      )}
    </div>
  );
}
