import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { InlineBanner } from '../components/ui';
import { LabelStack, SmoothExpand } from '../layout';
import { useNotice } from '../notice';
import { useText } from '../ui';
import {
  isTaskRevisionConflictError,
  isTaskWaitingForBot,
  type GlobalTask,
  type TaskBotOption,
  type TaskStep,
} from './types';
import './TaskBoard.css';

export interface TaskChatPromptBannerProps {
  botDeviceId: string;
  botId: string;
  task: GlobalTask | null;
  focusedStep?: TaskStep | null;
  showQuoteStrip?: boolean;
  waitingTasksCount?: number;
  waitingTaskIndex?: number;
  bots: TaskBotOption[];
  busy?: boolean;
  variant?: 'desktop' | 'mobile';
  /** When embedded inside ConditionDock, default expanded and omit redundant outer collapse header. */
  embeddedInDock?: boolean;
  onConfirmPlan: (taskId: string, expectedRevision?: number) => Promise<boolean | void> | boolean | void;
  onOpenTaskDetail: (taskId: string, openEdit?: boolean) => void;
  onAnswerPrompt: (taskId: string, answer: string, expectedRevision?: number) => Promise<boolean | void> | boolean | void;
  onClearQuote?: () => void;
  onCycleWaitingTask?: () => void;
}

export function TaskChatPromptBanner({
  botDeviceId,
  botId,
  task,
  focusedStep = null,
  showQuoteStrip = false,
  waitingTasksCount = 0,
  waitingTaskIndex = 0,
  bots,
  busy = false,
  variant = 'desktop',
  embeddedInDock = false,
  onConfirmPlan,
  onOpenTaskDetail,
  onAnswerPrompt,
  onClearQuote,
  onCycleWaitingTask,
}: TaskChatPromptBannerProps) {
  const t = useText();
  const { notify, dismiss } = useNotice();
  const panelId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(embeddedInDock);
  const [inlineError, setInlineError] = useState('');
  const preserveExpandedOnCycleRef = useRef(false);

  const errorNoticeId = `task-prompt-error:${botDeviceId}:${botId}`;
  const hasPrompt = Boolean(
    task && isTaskWaitingForBot(task, botDeviceId, botId) && task.pendingPrompt,
  );
  const hasQuote = !hasPrompt && Boolean(showQuoteStrip && task);
  const isMobile = variant === 'mobile';
  const dockClass = `tb-scope chat-task-dock${isMobile ? ' is-mobile' : ''}${embeddedInDock ? ' is-embedded' : ''}`;

  useEffect(() => {
    setInlineError('');
    dismiss(errorNoticeId);
  }, [task?.id, task?.revision, hasPrompt, errorNoticeId, dismiss]);

  useEffect(() => {
    return () => {
      dismiss(errorNoticeId);
    };
  }, [errorNoticeId, dismiss]);

  useEffect(() => {
    if (!hasPrompt) {
      preserveExpandedOnCycleRef.current = false;
      setExpanded(embeddedInDock);
      return;
    }
    if (embeddedInDock) {
      setExpanded(true);
      return;
    }
    if (preserveExpandedOnCycleRef.current) {
      preserveExpandedOnCycleRef.current = false;
      return;
    }
    setExpanded(false);
  }, [hasPrompt, task?.id, botDeviceId, botId, embeddedInDock]);

  if (!hasPrompt) {
    if (!hasQuote || !task) {
      return null;
    }
    const quoteLabel = focusedStep ? `${task.title} · ${focusedStep.text}` : task.title;
    return (
      <div className={dockClass}>
        <div
          key={`quote:${task.id}:${focusedStep?.id ?? ''}`}
          className="chat-quote-strip chat-task-bar-fade"
          role="region"
          aria-live="polite"
          aria-label={t('当前消息关联任务', 'Task linked to this message')}
        >
          <span className="chat-quote-arrow" aria-hidden="true">
            ↳
          </span>
          <button
            type="button"
            className="chat-quote-main"
            aria-label={t(`打开关联任务：${quoteLabel}`, `Open linked task: ${quoteLabel}`)}
            title={isMobile ? undefined : quoteLabel}
            onClick={() => onOpenTaskDetail(task.id, false)}
          >
            <span className="chat-quote-text">{quoteLabel}</span>
          </button>
          {waitingTasksCount > 0 && onClearQuote ? (
            <button
              type="button"
              className="chat-prompt-cycle-btn tabular-nums"
              aria-label={t(`取消当前任务引用并查看 ${waitingTasksCount} 个待回应任务`, `Clear quote and view ${waitingTasksCount} pending task(s)`)}
              onClick={onClearQuote}
            >
              {t(`查看待回应 (${waitingTasksCount})`, `View pending (${waitingTasksCount})`)}
            </button>
          ) : null}
          {onClearQuote ? (
            <button
              type="button"
              className="chat-quote-close"
              aria-label={t('取消关联任务', 'Unlink task')}
              title={isMobile ? undefined : t('取消关联任务', 'Unlink task')}
              onClick={onClearQuote}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const activeTask = task!;
  const prompt = activeTask.pendingPrompt!;
  const renderedRevision = activeTask.revision;
  const disabled = busy || submitting;
  const isExpanded = embeddedInDock || expanded;

  const handleConfirm = async () => {
    if (disabled) return;
    setSubmitting(true);
    setInlineError('');
    dismiss(errorNoticeId);
    try {
      const outcome = await onConfirmPlan(activeTask.id, renderedRevision);
      if (outcome === false) return;
      if (!embeddedInDock) setExpanded(false);
      onClearQuote?.();
    } catch (err) {
      const message = isTaskRevisionConflictError(err)
        ? t('待确认安排刚刚已更新，请核对最新内容或打开任务详情后再确认。', 'The plan awaiting confirmation was just updated. Please review the latest version or open task details before confirming.')
        : err instanceof Error && err.message
          ? err.message
          : String(err || t('确认执行安排失败', 'Failed to confirm plan'));
      setInlineError(message);
      notify({
        id: errorNoticeId,
        tone: 'error',
        title: message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAnswer = async (answer: string) => {
    if (disabled) return;
    setSubmitting(true);
    setInlineError('');
    dismiss(errorNoticeId);
    try {
      const outcome = await onAnswerPrompt(activeTask.id, answer, renderedRevision);
      if (outcome === false) return;
      if (!embeddedInDock) setExpanded(false);
      onClearQuote?.();
    } catch (err) {
      const message = isTaskRevisionConflictError(err)
        ? t('当前任务问题刚刚已更新，请核对最新内容后再回应。', 'This task question was just updated. Please review the latest version before replying.')
        : err instanceof Error && err.message
          ? err.message
          : String(err || t('提交回应失败', 'Failed to submit reply'));
      setInlineError(message);
      notify({
        id: errorNoticeId,
        tone: 'error',
        title: message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const visibleSteps = activeTask.steps.filter(s => s.status !== 'cancelled');
  const barSummary = activeTask.title || prompt.text;
  const confirmIdleLabel = t('确认安排并开始', 'Confirm and start');
  const confirmBusyLabel = t('启动中…', 'Starting…');

  const promptBody = (
    <div
      id={panelId}
      className="chat-prompt-body"
      aria-hidden={!isExpanded || undefined}
      inert={!isExpanded}
    >
      <div className="chat-prompt-head">
        <button
          type="button"
          className="chat-prompt-task-link"
          tabIndex={isExpanded ? undefined : -1}
          aria-label={t(`查看任务详情：${activeTask.title}`, `View task details: ${activeTask.title}`)}
          title={isMobile ? undefined : activeTask.title}
          onClick={() => onOpenTaskDetail(activeTask.id, false)}
        >
          <span className="chat-prompt-task-title">{activeTask.title}</span>
          <span aria-hidden="true">↗</span>
        </button>
        {embeddedInDock && waitingTasksCount > 1 && onCycleWaitingTask ? (
          <button
            type="button"
            className="chat-prompt-cycle-btn tabular-nums"
            onClick={() => {
              preserveExpandedOnCycleRef.current = true;
              onCycleWaitingTask();
            }}
          >
            {t(`切换 (${waitingTaskIndex + 1}/${waitingTasksCount})`, `Switch (${waitingTaskIndex + 1}/${waitingTasksCount})`)}
          </button>
        ) : null}
      </div>

      <p className="chat-prompt-text">{prompt.text}</p>

      {inlineError ? (
        <InlineBanner
          tone="danger"
          role="alert"
          compact
          title={inlineError}
          onDismiss={() => setInlineError('')}
        />
      ) : null}

      {prompt.kind === 'plan' && visibleSteps.length > 0 ? (
        <ol className="chat-plan-steps">
          {visibleSteps.map(step => {
            const matched = step.botId
              ? bots.find(
                  b =>
                    (step.deviceId ? b.deviceId === step.deviceId : true) &&
                    b.botId === step.botId,
                )
              : undefined;
            const ownerName =
              matched?.name ||
              step.botName ||
              (step.botId ? t('未知 Bot', 'Unknown Bot') : t('待接手', 'Unassigned'));
            return (
              <li key={step.id}>
                {step.text}{' '}
                <span className="chat-plan-step-bot">{t(`（${ownerName}）`, `(${ownerName})`)}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {prompt.kind === 'plan' ? (
        <div className="chat-prompt-actions">
          <button
            type="button"
            className="tb-primary-btn"
            tabIndex={isExpanded ? undefined : -1}
            disabled={disabled}
            onClick={() => void handleConfirm()}
          >
            <LabelStack
              active={submitting ? confirmBusyLabel : confirmIdleLabel}
              labels={[confirmIdleLabel, confirmBusyLabel]}
            />
          </button>
          <button
            type="button"
            className="tb-secondary-btn"
            tabIndex={isExpanded ? undefined : -1}
            disabled={disabled}
            onClick={() => onOpenTaskDetail(activeTask.id, true)}
          >
            {t('编辑步骤', 'Edit steps')}
          </button>
        </div>
      ) : prompt.options && prompt.options.length > 0 ? (
        <div className="chat-prompt-actions">
          {prompt.options.map(option => (
            <button
              key={option}
              type="button"
              className="option-pill"
              tabIndex={isExpanded ? undefined : -1}
              disabled={disabled}
              onClick={() => void handleAnswer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={dockClass}>
      <div
        className={`chat-prompt-card${isExpanded ? ' is-expanded' : ''}${embeddedInDock ? ' is-embedded' : ''}`}
        role="region"
        aria-label={prompt.kind === 'plan' ? t('待确认计划', 'Plan awaiting confirmation') : t('待回应问题', 'Question awaiting reply')}
      >
        {!embeddedInDock ? (
          <div
            key={`prompt:${activeTask.id}:${prompt.kind}`}
            className="chat-prompt-bar chat-task-bar-fade"
            aria-live="polite"
          >
            <button
              type="button"
              className="chat-prompt-bar-toggle"
              aria-expanded={isExpanded}
              aria-controls={panelId}
              aria-label={
                isExpanded
                  ? t(`收起任务提示：${barSummary}`, `Collapse task prompt: ${barSummary}`)
                  : t(`展开任务提示：${barSummary}`, `Expand task prompt: ${barSummary}`)
              }
              title={isMobile ? undefined : barSummary}
              onClick={() => setExpanded(prev => !prev)}
            >
              <span className="chat-prompt-dot" aria-hidden="true" />
              <span className="chat-prompt-kicker">
                {prompt.kind === 'plan' ? t('待确认安排', 'Confirm plan') : t('待你回应', 'Awaiting reply')}
              </span>
              <span className="chat-prompt-bar-sep" aria-hidden="true">
                ·
              </span>
              <span className="chat-prompt-bar-summary">{barSummary}</span>
              <span className={`chat-prompt-chevron${isExpanded ? ' is-open' : ''}`} aria-hidden="true">
                <ChevronDown size={15} />
              </span>
            </button>
            {waitingTasksCount > 1 && onCycleWaitingTask ? (
              <button
                type="button"
                className="chat-prompt-cycle-btn tabular-nums"
                onClick={() => {
                  if (isExpanded) preserveExpandedOnCycleRef.current = true;
                  onCycleWaitingTask();
                }}
              >
                {t(`切换 (${waitingTaskIndex + 1}/${waitingTasksCount})`, `Switch (${waitingTaskIndex + 1}/${waitingTasksCount})`)}
              </button>
            ) : null}
          </div>
        ) : null}

        {embeddedInDock ? (
          promptBody
        ) : (
          <SmoothExpand open={isExpanded} className="chat-prompt-expand">
            {promptBody}
          </SmoothExpand>
        )}
      </div>
    </div>
  );
}
