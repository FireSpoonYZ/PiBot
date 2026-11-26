import { Markdown } from './Markdown';
import { TurnToolCallsSection } from './hub/shared';
import { GrokBotFailureRow, type GrokAvatarPreset } from './GrokBotAvatar';
import { formatTurnDuration, resolveAssistantFailureDetail } from './chatTurnModel';
import type { DmExecutionTimelineItem } from './dmScopeTimeline';
import { useText } from './ui';
import './dm-scope-execution.css';

export interface DmScopeExecutionRowProps {
  item: DmExecutionTimelineItem;
  scopeId: string;
  authorName: string;
  avatarPreset: GrokAvatarPreset;
  botKey: string;
  variant: 'desktop' | 'mobile';
  hideToolOutput: boolean;
  collapseToolOutput: boolean;
  onOpenLink?: (href: string) => void | Promise<unknown>;
}

function formatExecutionTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function resolveExecutionTimestampMs(item: DmExecutionTimelineItem): number | null {
  const { turn } = item;
  if (typeof turn.timestamp === 'number' && Number.isFinite(turn.timestamp) && turn.timestamp > 0) {
    return turn.timestamp;
  }
  if (typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt) && turn.startedAt > 0) {
    return turn.startedAt;
  }
  const iso = turn.createdAt ?? turn.attribution?.createdAt;
  if (typeof iso === 'string' && iso.trim() !== '') {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function DmScopeExecutionRow({
  item,
  scopeId,
  authorName,
  avatarPreset,
  botKey,
  variant,
  hideToolOutput,
  collapseToolOutput,
  onOpenLink,
}: DmScopeExecutionRowProps) {
  const t = useText();
  const { turn } = item;
  const toolScopeKey = `dm:${scopeId}:${item.member.deviceId}:${item.member.botId}`;
  const toolVariant = variant === 'desktop' ? 'desktop' : undefined;

  const hasBlocks = Boolean(turn.blocks && turn.blocks.length > 0);
  const visibleBlocks = hasBlocks
    ? turn.blocks!.filter((block) => {
        if (block.kind === 'thinking') return !hideToolOutput && block.text.trim().length > 0;
        if (block.kind === 'tools') return !hideToolOutput && block.tools.length > 0;
        return block.text.trim().length > 0;
      })
    : [];

  const showFallbackThinking = !hasBlocks && !hideToolOutput && Boolean(turn.thinking && turn.thinking.trim());
  const showFallbackTools = !hasBlocks && !hideToolOutput && Boolean(turn.tools && turn.tools.length > 0);
  const showFallbackText = !hasBlocks && turn.text.trim().length > 0;
  const showSilentPass = item.silentPass && !hideToolOutput;
  const hasError = Boolean(turn.error && turn.error.trim());

  const hasVisibleContent =
    visibleBlocks.length > 0 ||
    showFallbackThinking ||
    showFallbackTools ||
    showFallbackText ||
    showSilentPass ||
    hasError;

  if (!hasVisibleContent) return null;

  const timeLabel = formatExecutionTime(resolveExecutionTimestampMs(item));
  const durationLabel =
    !item.isLive && typeof turn.durationMs === 'number' && turn.durationMs > 0
      ? formatTurnDuration(turn.durationMs, t)
      : '';
  const failureDetail = hasError ? resolveAssistantFailureDetail(turn.error, t) : '';
  const tagLabel = item.isLive
    ? t('执行中', 'Working')
    : showSilentPass
      ? t('跳过回复', 'Pass')
      : t('执行过程', 'Execution');

  return (
    <div
      className={`dm-exec-row${item.isLive ? ' is-live' : ''}${showSilentPass ? ' is-silent-pass' : ''}`}
      data-role="dm-execution"
    >
      <div className="dm-exec-header">
        <span className="dm-exec-author">{authorName}</span>
        <span className={`dm-exec-tag${item.isLive ? ' is-live' : ''}`}>{tagLabel}</span>
        {timeLabel || durationLabel ? (
          <span className="dm-exec-meta tabular-nums">
            {[timeLabel, durationLabel].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </div>

      <div className="dm-exec-body">
        {hasBlocks
          ? visibleBlocks.map((block) =>
              block.kind === 'thinking' ? (
                <details key={block.id} className="bot-chat-thinking">
                  <summary>{t('思考过程', 'Thinking')}</summary>
                  <pre>{block.text}</pre>
                </details>
              ) : block.kind === 'tools' ? (
                <TurnToolCallsSection
                  key={block.id}
                  tools={block.tools}
                  collapseOutput={collapseToolOutput}
                  collapseBotDm={collapseToolOutput}
                  autoExpandSendTo={false}
                  insideBotDmTurn={true}
                  presentationOnly={false}
                  active={false}
                  disabled={true}
                  scopeKey={toolScopeKey}
                  variant={toolVariant}
                  requesterName={authorName}
                  t={t}
                />
              ) : (
                <div key={block.id} className="dm-exec-text">
                  <Markdown text={block.text} onOpenLink={onOpenLink} />
                </div>
              ),
            )
          : null}

        {showFallbackThinking ? (
          <details className="bot-chat-thinking">
            <summary>{t('思考过程', 'Thinking')}</summary>
            <pre>{turn.thinking}</pre>
          </details>
        ) : null}

        {showFallbackTools && turn.tools ? (
          <TurnToolCallsSection
            tools={turn.tools}
            collapseOutput={collapseToolOutput}
            collapseBotDm={collapseToolOutput}
            autoExpandSendTo={false}
            insideBotDmTurn={true}
            presentationOnly={false}
            active={false}
            disabled={true}
            scopeKey={toolScopeKey}
            variant={toolVariant}
            requesterName={authorName}
            t={t}
          />
        ) : null}

        {showFallbackText ? (
          <div className="dm-exec-text">
            <Markdown text={turn.text} onOpenLink={onOpenLink} />
          </div>
        ) : null}

        {showSilentPass ? (
          <p className="dm-exec-silent-pass">{t('本次无需回复（pass）', 'No reply needed (pass)')}</p>
        ) : null}

        {hasError ? (
          <GrokBotFailureRow
            botKey={botKey}
            preset={avatarPreset}
            detail={failureDetail || undefined}
            inline
            t={t}
          />
        ) : null}
      </div>
    </div>
  );
}
