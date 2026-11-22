import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ChatToolCallItem } from './chatTurnModel';
import { formatTurnDuration, pendingToolPrompts, resolveToolPresentationActive } from './chatTurnModel';
import {
  readToolPresentation,
  ToolPresentationCard,
  type GoogleChatCardContext,
  type QuestionnaireSubmitPayload,
  type VaultUnlockSubmitPayload,
} from './ToolPresentation';
import { useText } from './ui';
import './tool-call-card.css';

const COMPACT_ARG_VALUE_LIMIT = 80;

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

function formatCompactArgValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isLongCompactArgValue(formatted: string): boolean {
  return formatted.length > COMPACT_ARG_VALUE_LIMIT || formatted.includes('\n');
}

function previewCompactArgValue(formatted: string): string {
  const firstLine = formatted.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.length > COMPACT_ARG_VALUE_LIMIT) {
    return `${firstLine.slice(0, COMPACT_ARG_VALUE_LIMIT - 1)}…`;
  }
  return formatted.includes('\n') ? `${firstLine}…` : firstLine;
}

export interface ToolCallCardProps {
  tool: ChatToolCallItem;
  scopeKey: string;
  active: boolean;
  disabled?: boolean;
  variant?: 'mobile' | 'desktop';
  requesterName?: string;
  collapseOutput: boolean;
  /** 仅作初始展开态（省略时回退 !collapseOutput）；用户手动切换后不再被自动覆写。 */
  defaultOpen?: boolean;
  presentationOnly?: boolean;
  /** 内部嵌套层级计数（默认 0），用于限制最大缩进 2 层。 */
  depth?: number;
  googleContext?: GoogleChatCardContext;
  onSubmitQuestionnaire?: (installationId: string, input: QuestionnaireSubmitPayload) => Promise<unknown>;
  onSubmitVaultUnlock?: (input: VaultUnlockSubmitPayload) => Promise<unknown>;
  onOpenTask?: (taskId: string, openEdit?: boolean) => void;
  onConfirmTaskPlan?: (taskId: string) => Promise<void> | void;
  onAnswerTaskPrompt?: (taskId: string, answer: string) => Promise<void> | void;
}

/** One model call, its script-owned children, and its own result stay in one flat trace block. */
export function ToolCallCard({
  tool,
  scopeKey,
  active,
  disabled = false,
  variant,
  requesterName,
  collapseOutput,
  defaultOpen,
  presentationOnly = false,
  depth = 0,
  googleContext,
  onSubmitQuestionnaire,
  onSubmitVaultUnlock,
  onOpenTask,
  onConfirmTaskPlan,
  onAnswerTaskPrompt,
}: ToolCallCardProps) {
  const t = useText();
  const panelId = useId();
  const isCoarse = useIsCoarsePointer();
  const mobileCompact = isCoarse && variant !== 'desktop';
  const [expandedArgKeys, setExpandedArgKeys] = useState<Record<string, boolean>>({});
  const [showRawArgs, setShowRawArgs] = useState(false);

  const presentation = readToolPresentation(tool.presentation);
  const codemode = tool.name === 'codemode';
  const script = codemode && typeof tool.args?.code === 'string' ? tool.args.code : undefined;
  const argsEntries = tool.args ? Object.entries(tool.args) : [];
  const args = argsEntries.length > 0 ? JSON.stringify(tool.args, null, 2) : undefined;
  const incomplete = tool.status === 'done' && tool.outcome !== 'ok';

  const statusLabel = tool.status === 'running' ? t('调用中', 'Calling')
    : tool.status === 'error' ? t('失败', 'Failed')
      : tool.status === 'cancelled' ? t('已取消', 'Cancelled')
        : tool.status === 'interrupted' ? t('已中断', 'Interrupted')
          : incomplete ? t('结果不完整', 'Outcome unavailable') : t('已完成', 'Done');

  const icon = tool.status === 'running' ? '…'
    : tool.status === 'error' ? '✕'
      : tool.status === 'cancelled' ? '⊘'
        : tool.status === 'interrupted' || incomplete ? '—' : '✓';

  const duration = tool.durationMs === undefined ? undefined
    : tool.durationMs < 1000 ? `${Math.round(tool.durationMs)}ms`
      : formatTurnDuration(tool.durationMs, (_zh, en) => en);

  const presentationKey = presentation
    ? presentation.kind === 'todo'
      ? tool.id
      : presentation.kind === 'task'
        ? presentation.taskId
        : presentation.kind === 'google-setup'
          ? (presentation.runId ?? tool.id)
          : presentation.kind === 'google-account-select'
            ? (presentation.requestId ?? tool.id)
            : presentation.kind === 'google-browser-takeover'
              ? (presentation.pageId ?? tool.id)
              : presentation.kind === 'google-readiness'
                ? `${presentation.account ?? ''}:${presentation.service ?? ''}:${tool.id}`
                : presentation.kind === 'questionnaire'
                  ? `${presentation.installationId}:${presentation.conversationId}:${presentation.requestId}`
                  : presentation.requestId
    : tool.id;

  const sendTo = !tool.parentCallId && tool.name === 'send_to' ? tool.sendTo : undefined;
  const sendToTarget = sendTo
    ? (sendTo.targetName ||
       (sendTo.scopeKind === 'room' ? t('群聊', 'Group chat') : t('对端 Bot', 'Peer Bot')))
    : undefined;
  const sendToAction = sendTo
    ? (sendTo.silentPass
        ? t('静默跳过', 'Silent pass')
        : sendTo.category === 'reply'
          ? t('回传结果', 'Reply')
          : sendTo.category === 'request'
            ? t('派发任务', 'Dispatch')
            : sendTo.category === 'public'
              ? t('群聊发言', 'Room message')
              : sendTo.category === 'notice'
                ? t('通知', 'Notice')
                : t('发送消息', 'Message'))
    : undefined;

  const hasDetails = codemode || args !== undefined || tool.output !== undefined || tool.outputTruncated ||
    (tool.parentCallId !== undefined && tool.argSummary !== undefined);
  const hasVisibleChildPresentation = Boolean(
    tool.children && (
      (tool.status === 'running' && tool.children.some(child => {
        const childPres = readToolPresentation(child.presentation);
        return child.presentationLive === true && childPres !== null && childPres.kind !== 'google-setup';
      })) ||
      pendingToolPrompts(tool.children, tool.status === 'running').length > 0
    ),
  );

  // 严格把 defaultOpen / !collapseOutput 作为初始态，在渲染期同步推导自动展开；
  // 一旦用户手动切换展开/收起，永不再由 props 或异步子调用变化自动覆盖。
  const [initialOpen] = useState<boolean>(() => defaultOpen ?? !collapseOutput);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [autoExpandedForChild, setAutoExpandedForChild] = useState<boolean>(
    () => hasVisibleChildPresentation,
  );
  if (hasVisibleChildPresentation && !autoExpandedForChild && userOpen === null) {
    setAutoExpandedForChild(true);
  }

  const expanded = userOpen ?? (initialOpen || autoExpandedForChild);
  const hasPanelContent = hasDetails || Boolean(
    tool.error ||
    tool.children?.length ||
    tool.nestedCallsTruncated ||
    (!sendTo && tool.argSummary) ||
    (codemode && tool.status !== 'running' && tool.children === undefined),
  );

  const isGoogleSetupHistory = presentation?.kind === 'google-setup';
  const presentationActive = isGoogleSetupHistory
    ? false
    : resolveToolPresentationActive(tool, presentation, active, disabled);
  const questionnaireInterrupted = presentation?.kind === 'questionnaire' && presentation.status === 'pending' &&
    (tool.status === 'error' || tool.status === 'interrupted' || tool.status === 'cancelled');

  const presentationCard = presentation ? (
    <ToolPresentationCard
      key={`${scopeKey}:${tool.id}:${presentation.kind}:${presentationKey}`}
      presentation={presentation}
      active={presentationActive}
      disabled={disabled}
      questionnaireInterrupted={questionnaireInterrupted}
      variant={variant === 'desktop' ? 'desktop' : undefined}
      requesterName={requesterName}
      googleContext={isGoogleSetupHistory ? undefined : googleContext}
      onSubmit={presentation.kind === 'questionnaire' && onSubmitQuestionnaire
        ? input => onSubmitQuestionnaire(presentation.installationId, input)
        : undefined}
      onSubmitVaultUnlock={onSubmitVaultUnlock}
      onOpenTask={onOpenTask}
      onConfirmTaskPlan={onConfirmTaskPlan}
      onAnswerTaskPrompt={onAnswerTaskPrompt}
    />
  ) : null;

  if (presentationOnly) return presentationCard;
  if (isGoogleSetupHistory) {
    return (
      <div key={`${scopeKey}:${tool.id}`} role="listitem" className="gws-history-listitem">
        {presentationCard}
      </div>
    );
  }

  const renderChildren = () =>
    tool.children && tool.children.length > 0 ? (
      <div
        className={`tool-call-children${depth >= 2 ? ' is-depth-capped' : ''}`}
        role="list"
        aria-label={t('脚本子调用', 'Nested tool calls')}
      >
        {tool.children.map(child => (
          <ToolCallCard
            key={child.id}
            tool={child}
            scopeKey={scopeKey}
            active={active && tool.status === 'running'}
            disabled={disabled}
            variant={variant}
            requesterName={requesterName}
            collapseOutput={collapseOutput}
            defaultOpen={defaultOpen}
            depth={depth + 1}
            googleContext={googleContext}
            onSubmitQuestionnaire={onSubmitQuestionnaire}
            onSubmitVaultUnlock={onSubmitVaultUnlock}
            onOpenTask={onOpenTask}
            onConfirmTaskPlan={onConfirmTaskPlan}
            onAnswerTaskPrompt={onAnswerTaskPrompt}
          />
        ))}
      </div>
    ) : null;

  const sendToSummary = sendTo
    ? [sendToTarget, sendToAction].filter(Boolean).join(' · ')
    : undefined;

  const rowContent = (
    <>
      <span className="tool-call-icon" aria-hidden="true">{icon}</span>
      {sendTo ? (
        <span className="tool-call-name is-prose">{sendToSummary || tool.name}</span>
      ) : (
        <span className="tool-call-name">{tool.name}</span>
      )}
      {!sendTo && tool.argSummary ? (
        <span className="tool-call-summary" title={isCoarse ? undefined : tool.argSummary}>
          {tool.argSummary}
        </span>
      ) : null}
      <span className="tool-call-state">{statusLabel}</span>
      {duration ? <span className="tool-call-duration tabular-nums">{duration}</span> : null}
      {hasPanelContent ? (
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={`tool-call-chevron${expanded ? ' is-open' : ''}`}
        />
      ) : null}
    </>
  );

  return (
    <div
      key={`${scopeKey}:${tool.id}`}
      role="listitem"
      className={`tool-call-card is-${tool.status}${incomplete ? ' is-incomplete' : ''}${tool.parentCallId ? ' is-nested' : ''}${sendTo ? ' is-send-to' : ''}${mobileCompact ? ' is-mobile-compact' : ''}`}
    >
      {hasPanelContent ? (
        <button
          type="button"
          className={`tool-call-header tool-call-toggle${expanded ? ' is-expanded' : ''}`}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setUserOpen(!expanded)}
        >
          {rowContent}
        </button>
      ) : (
        <div className="tool-call-header">
          {rowContent}
        </div>
      )}

      {sendTo && (sendTo.text || sendTo.silentPass) ? (
        <div className={`tool-send-to-preview${sendTo.silentPass ? ' is-silent' : ''}`}>
          <div className="tool-send-to-meta">
            <span className="tool-send-to-target">{sendToTarget}</span>
            {sendToAction ? (
              <>
                <span className="tool-send-to-sep" aria-hidden="true">·</span>
                <span className="tool-send-to-action">{sendToAction}</span>
              </>
            ) : null}
            {sendTo.fileCount && sendTo.fileCount > 0 ? (
              <>
                <span className="tool-send-to-sep" aria-hidden="true">·</span>
                <span className="tool-send-to-files tabular-nums">
                  {t(`${sendTo.fileCount} 个附件`, `${sendTo.fileCount} file(s)`)}
                </span>
              </>
            ) : null}
          </div>
          {sendTo.silentPass ? (
            <p className="tool-send-to-silent">{t('本次无需回复（pass）', 'No reply needed (pass)')}</p>
          ) : sendTo.text ? (
            <div className="tool-send-to-body">{sendTo.text}</div>
          ) : null}
        </div>
      ) : null}

      {expanded && hasPanelContent ? (
        <div id={panelId} className="tool-call-panel">
          {tool.error ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('错误', 'Error')}</span>
              <pre className="tool-call-error">{tool.error}</pre>
            </div>
          ) : null}

          {script !== undefined ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('脚本', 'Script')}</span>
              <pre className="tool-call-code">{script}</pre>
            </div>
          ) : mobileCompact && argsEntries.length > 0 ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('参数', 'Arguments')}</span>
              <dl className="tool-call-kv-list">
                {argsEntries.map(([key, rawValue]) => {
                  const formatted = formatCompactArgValue(rawValue);
                  const isLong = isLongCompactArgValue(formatted);
                  const isValExpanded = Boolean(expandedArgKeys[key]);
                  return (
                    <div key={key} className="tool-call-kv-row">
                      <dt className="tool-call-kv-key">{key}</dt>
                      <dd className="tool-call-kv-val-cell">
                        {isLong ? (
                          <button
                            type="button"
                            className={`tool-call-kv-val-toggle${isValExpanded ? ' is-expanded' : ''}`}
                            aria-expanded={isValExpanded}
                            onClick={() => setExpandedArgKeys(prev => ({ ...prev, [key]: !prev[key] }))}
                          >
                            <span className="tool-call-kv-val-text">
                              {isValExpanded ? formatted : previewCompactArgValue(formatted)}
                            </span>
                            <span className="tool-call-kv-val-action">
                              {isValExpanded ? t('收起', 'Collapse') : t('展开', 'Expand')}
                            </span>
                          </button>
                        ) : (
                          <span className="tool-call-kv-val">{formatted}</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {args !== undefined ? (
                <div className="tool-call-raw-wrap">
                  <button
                    type="button"
                    className="tool-call-raw-toggle"
                    aria-expanded={showRawArgs}
                    onClick={() => setShowRawArgs(v => !v)}
                  >
                    {showRawArgs ? t('收起原文', 'Hide raw') : t('查看原文', 'View raw')}
                  </button>
                  {showRawArgs ? <pre className="tool-call-code">{args}</pre> : null}
                </div>
              ) : null}
            </div>
          ) : args !== undefined ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('参数', 'Arguments')}</span>
              <pre className="tool-call-code">{args}</pre>
            </div>
          ) : codemode ? (
            <p className="tool-call-notice">{t('此记录未保留脚本。', 'The script is not available in this record.')}</p>
          ) : tool.argSummary ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('参数摘要', 'Argument preview')}</span>
              <pre className="tool-call-code">{tool.argSummary}</pre>
            </div>
          ) : null}

          {tool.children && tool.children.length > 0 ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('子调用', 'Nested calls')}</span>
              {renderChildren()}
            </div>
          ) : null}
          {tool.nestedCallsTruncated ? (
            <p className="tool-call-notice">{t('子调用摘要已截断，部分信息未显示。', 'Nested call summaries are truncated; some information is not shown.')}</p>
          ) : null}
          {codemode && tool.status !== 'running' && tool.children === undefined ? (
            <p className="tool-call-notice">{t('此记录未保留子调用摘要。', 'No nested call summaries were recorded.')}</p>
          ) : null}

          {tool.output !== undefined ? (
            <div className="tool-call-section">
              <span className="tool-call-label">
                {tool.status === 'running' ? t('实时输出', 'Live output') : t('输出', 'Output')}
              </span>
              <pre className="tool-call-code">{tool.output}</pre>
            </div>
          ) : codemode ? (
            <p className="tool-call-notice">{t('暂无记录的文本输出。', 'No recorded text output is available.')}</p>
          ) : null}
          {tool.outputTruncated ? (
            <p className="tool-call-notice">{t('输出已截断。', 'Output is truncated.')}</p>
          ) : null}
        </div>
      ) : null}

      {presentationCard}
    </div>
  );
}
