import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  groupProcessTimelineSteps,
  partitionAssistantTurnBlocks,
  pendingToolPrompts,
  type ChatToolCallItem,
  type ChatTurn,
  type ChatTurnBlock,
} from './chatTurnModel';
import {
  readToolPresentation,
  type GoogleChatCardContext,
  type QuestionnaireSubmitPayload,
  type VaultUnlockSubmitPayload,
} from './ToolPresentation';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { TurnToolCallsSection } from './hub/shared';
import './turn-process-rail.css';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface TurnProcessRailProps {
  blocks: readonly ChatTurnBlock[];
  isLive: boolean;
  forceExpand?: boolean;
  renderToolBlock: (block: Extract<ChatTurnBlock, { kind: 'tools' }>) => ReactNode;
  onOpenLink?: (href: string) => void | Promise<unknown>;
  trackEntryIds?: boolean;
  t: (zh: string, en: string) => string;
}

export function TurnProcessRail({
  blocks,
  isLive,
  forceExpand,
  renderToolBlock,
  onOpenLink,
  trackEntryIds,
  t,
}: TurnProcessRailProps) {
  const bodyId = useId();
  const collapseRef = useRef<HTMLDivElement | null>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const expanded = userOpen ?? (isLive || Boolean(forceExpand));

  useIsomorphicLayoutEffect(() => {
    const el = collapseRef.current;
    if (!el) return;
    (el as HTMLDivElement & { inert?: boolean }).inert = !expanded;
    if (!expanded) {
      el.setAttribute('inert', '');
    } else {
      el.removeAttribute('inert');
    }
  }, [expanded]);

  const steps = groupProcessTimelineSteps(blocks);
  if (steps.length === 0) return null;

  let narrationCount = 0;
  let toolCount = 0;
  for (const block of blocks) {
    if (block.kind === 'text') narrationCount += 1;
    else if (block.kind === 'tools') toolCount += block.tools.length;
  }

  const titleLabel = isLive ? t('推进中', 'Working') : t('过程记录', 'Process');
  const stepEn = narrationCount === 1 ? '1 step' : `${narrationCount} steps`;
  const toolEn = toolCount === 1 ? '1 tool' : `${toolCount} tools`;
  const metaLabel =
    narrationCount > 0 && toolCount > 0
      ? t(`${narrationCount} 步 · ${toolCount} 次工具`, `${stepEn} · ${toolEn}`)
      : narrationCount > 0
        ? t(`${narrationCount} 步`, stepEn)
        : toolCount > 0
          ? t(`${toolCount} 次工具`, toolEn)
          : t('思考过程', 'Thinking');

  return (
    <div className={`turn-process-rail${isLive ? ' is-live' : ''}`}>
      <button
        type="button"
        className="turn-process-trigger"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setUserOpen(!expanded)}
      >
        <span className="turn-process-icon" aria-hidden="true">
          {isLive ? (
            <span className="turn-process-live-dot" />
          ) : (
            <svg viewBox="0 0 14 14" width="14" height="14" fill="none" aria-hidden="true">
              <circle cx="3.25" cy="3.75" r="1.35" fill="currentColor" />
              <circle cx="3.25" cy="10.25" r="1.35" fill="currentColor" />
              <path d="M3.25 5.1v3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <path d="M6.25 3.75h5.25M6.25 10.25h3.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="turn-process-title">{titleLabel}</span>
        <span className="turn-process-sep" aria-hidden="true">·</span>
        <span className="turn-process-meta tabular-nums">{metaLabel}</span>
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={`turn-process-chevron${expanded ? ' is-open' : ''}`}
        />
      </button>

      <div
        ref={collapseRef}
        id={bodyId}
        className={`turn-process-collapse${expanded ? ' is-open' : ''}`}
        aria-hidden={!expanded || undefined}
      >
        <div className="turn-process-collapse-inner">
          <div className="turn-process-timeline">
            {steps.map((step, idx) => (
              <div
                key={step.id}
                className={`turn-process-step${isLive && idx === steps.length - 1 ? ' is-active' : ''}`}
              >
                <span className="turn-process-step-dot" aria-hidden="true" />
                {step.text ? (
                  <div
                    className="turn-process-step-text"
                    data-assistant-entry-id={trackEntryIds ? step.entryId : undefined}
                  >
                    <Markdown text={step.text} onOpenLink={onOpenLink} />
                  </div>
                ) : null}
                {step.blocks.length > 0 ? (
                  <div className="turn-process-step-extras">
                    {step.blocks.map((block) =>
                      block.kind === 'thinking' ? (
                        <details key={block.id} className="bot-chat-thinking">
                          <summary>{t('思考过程', 'Thinking')}</summary>
                          <pre>{block.text}</pre>
                        </details>
                      ) : block.kind === 'tools' ? (
                        <Fragment key={block.id}>{renderToolBlock(block)}</Fragment>
                      ) : null,
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {steps.length >= 5 ? (
            <div className="turn-process-footer">
              <button
                type="button"
                className="turn-process-footer-btn"
                onClick={() => setUserOpen(false)}
              >
                <span>{t('收起过程', 'Collapse')}</span>
                <ChevronUp size={12} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface AssistantTurnBodyProps {
  turn: ChatTurn;
  isLive: boolean;
  insideDm: boolean;
  collapseToolOutput: boolean;
  hideToolOutput: boolean;
  collapseBotDm: boolean;
  forceExpand?: boolean;
  scopeKey: string;
  active: boolean;
  disabled?: boolean;
  variant?: 'mobile' | 'desktop';
  requesterName?: string;
  trackEntryIds?: boolean;
  googleContext?: GoogleChatCardContext;
  onOpenLink?: (href: string) => void | Promise<unknown>;
  onSubmitQuestionnaire?: (installationId: string, input: QuestionnaireSubmitPayload) => Promise<unknown>;
  onSubmitVaultUnlock?: (input: VaultUnlockSubmitPayload) => Promise<unknown>;
  onOpenTask?: (taskId: string, openEdit?: boolean) => void;
  onConfirmTaskPlan?: (taskId: string) => Promise<void> | void;
  onAnswerTaskPrompt?: (taskId: string, answer: string) => Promise<void> | void;
  t: (zh: string, en: string) => string;
}

function hasPromotedTool(item: ChatToolCallItem, insideDm: boolean): boolean {
  if (readToolPresentation(item.presentation) !== null) {
    return true;
  }
  if (
    item.name === 'send_to' &&
    (item.sendTo?.scopeKind === 'dm' ||
      insideDm ||
      Boolean(
        item.sendTo &&
          (item.sendTo.text ||
            item.sendTo.silentPass ||
            (item.sendTo.fileCount && item.sendTo.fileCount > 0)),
      ))
  ) {
    return true;
  }
  return Boolean(item.children?.some((child) => hasPromotedTool(child, insideDm)));
}

export function AssistantTurnBody({
  turn,
  isLive,
  insideDm,
  collapseToolOutput,
  hideToolOutput,
  collapseBotDm,
  forceExpand,
  scopeKey,
  active,
  disabled,
  variant,
  requesterName,
  trackEntryIds,
  googleContext,
  onOpenLink,
  onSubmitQuestionnaire,
  onSubmitVaultUnlock,
  onOpenTask,
  onConfirmTaskPlan,
  onAnswerTaskPrompt,
  t,
}: AssistantTurnBodyProps) {
  const toolCardProps = {
    collapseOutput: collapseToolOutput,
    collapseBotDm: insideDm ? false : collapseBotDm,
    insideBotDmTurn: insideDm,
    forceExpandBotDm: Boolean(forceExpand),
    presentationOnly: hideToolOutput,
    scopeKey,
    active,
    disabled,
    variant,
    requesterName,
    googleContext,
    onSubmitQuestionnaire,
    onSubmitVaultUnlock,
    onOpenTask,
    onConfirmTaskPlan,
    onAnswerTaskPrompt,
  };

  const renderTools = (tools: ChatToolCallItem[], key?: string) => (
    <TurnToolCallsSection key={key} tools={tools} {...toolCardProps} t={t} />
  );

  const renderProcessToolBlock = (block: Extract<ChatTurnBlock, { kind: 'tools' }>) => {
    if (block.tools.length < 3 && !hideToolOutput) {
      return (
        <div
          key={block.id}
          className="bot-chat-tools"
          role="list"
          aria-label={t('工具调用', 'Tool calls')}
        >
          {block.tools.map((tool) => (
            <ToolCallCard key={tool.id} tool={tool} {...toolCardProps} />
          ))}
        </div>
      );
    }
    return renderTools(block.tools, block.id);
  };

  if (turn.blocks) {
    const isPromotedToolBlock = (tools: readonly ChatToolCallItem[]): boolean =>
      pendingToolPrompts(tools).length > 0 || tools.some((tool) => hasPromotedTool(tool, insideDm));

    const segments = partitionAssistantTurnBlocks(turn.blocks, {
      isLive,
      isPromotedToolBlock,
    });

    return (
      <>
        {segments.map((segment) => {
          if (segment.kind === 'process') {
            return (
              <TurnProcessRail
                key={segment.id}
                blocks={segment.blocks}
                isLive={isLive}
                forceExpand={forceExpand}
                renderToolBlock={renderProcessToolBlock}
                onOpenLink={onOpenLink}
                trackEntryIds={trackEntryIds}
                t={t}
              />
            );
          }
          const { block } = segment;
          if (block.kind === 'tools') {
            return renderTools(block.tools, block.id);
          }
          if (block.kind === 'thinking') {
            return (
              <details key={block.id} className="bot-chat-thinking">
                <summary>{t('思考过程', 'Thinking')}</summary>
                <pre>{block.text}</pre>
              </details>
            );
          }
          return (
            <div
              key={block.id}
              className="turn-final-answer"
              data-assistant-entry-id={trackEntryIds ? block.entryId : undefined}
            >
              <Markdown text={block.text} onOpenLink={onOpenLink} />
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {turn.thinking ? (
        <details className="bot-chat-thinking">
          <summary>{t('思考过程', 'Thinking')}</summary>
          <pre>{turn.thinking}</pre>
        </details>
      ) : null}
      {turn.tools && turn.tools.length > 0 ? renderTools(turn.tools) : null}
      {turn.text ? <Markdown text={turn.text} onOpenLink={onOpenLink} /> : null}
    </>
  );
}
