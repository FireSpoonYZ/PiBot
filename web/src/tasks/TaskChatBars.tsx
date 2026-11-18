import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
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
  onConfirmPlan: (taskId: string, expectedRevision?: number) => Promise<void> | void;
  onOpenTaskDetail: (taskId: string, openEdit?: boolean) => void;
  onAnswerPrompt: (taskId: string, answer: string, expectedRevision?: number) => Promise<void> | void;
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
  onConfirmPlan,
  onOpenTaskDetail,
  onAnswerPrompt,
  onClearQuote,
  onCycleWaitingTask,
}: TaskChatPromptBannerProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [task?.id, task?.revision]);

  const hasPrompt = Boolean(
    task && isTaskWaitingForBot(task, botDeviceId, botId) && task.pendingPrompt,
  );
  const dockClass = `tb-scope chat-task-dock${variant === 'mobile' ? ' is-mobile' : ''}`;

  if (!hasPrompt) {
    if (!showQuoteStrip || !task) {
      return null;
    }
    const quoteLabel = focusedStep ? `${task.title} · ${focusedStep.text}` : task.title;
    return (
      <div className={dockClass}>
        <div className="chat-quote-strip" role="region" aria-label="当前消息关联任务">
          <span className="chat-quote-arrow" aria-hidden="true">
            ↳
          </span>
          <button
            type="button"
            className="chat-quote-main"
            title={quoteLabel}
            onClick={() => onOpenTaskDetail(task.id, false)}
          >
            <span className="chat-quote-text">{quoteLabel}</span>
          </button>
          {waitingTasksCount > 0 && onClearQuote ? (
            <button
              type="button"
              className="chat-prompt-cycle-btn"
              onClick={onClearQuote}
            >
              待回应 ({waitingTasksCount})
            </button>
          ) : null}
          {onClearQuote ? (
            <button
              type="button"
              className="chat-quote-close"
              aria-label="取消关联任务"
              title="取消关联任务"
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

  const handleConfirm = async () => {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirmPlan(activeTask.id, renderedRevision);
      onClearQuote?.();
    } catch (err) {
      if (isTaskRevisionConflictError(err)) {
        setError('待确认安排刚刚已更新，请核对最新内容或打开任务详情后再确认。');
      } else {
        setError(err instanceof Error && err.message ? err.message : String(err || '确认执行安排失败'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleAnswer = async (answer: string) => {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAnswerPrompt(activeTask.id, answer, renderedRevision);
      onClearQuote?.();
    } catch (err) {
      if (isTaskRevisionConflictError(err)) {
        setError('当前任务问题刚刚已更新，请核对最新内容后再回应。');
      } else {
        setError(err instanceof Error && err.message ? err.message : String(err || '提交回应失败'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const visibleSteps = activeTask.steps.filter(s => s.status !== 'cancelled');

  return (
    <div className={dockClass}>
      <div
        className="chat-prompt-card"
        role="region"
        aria-label={prompt.kind === 'plan' ? '待确认计划' : '待回应问题'}
      >
        <div className="chat-prompt-head">
          <span className="chat-prompt-dot" aria-hidden="true" />
          <span className="chat-prompt-kicker">
            {prompt.kind === 'plan' ? '待确认安排' : '待你回应'}
          </span>
          <button
            type="button"
            className="chat-prompt-task-link"
            title={activeTask.title}
            onClick={() => onOpenTaskDetail(activeTask.id, false)}
          >
            <span className="chat-prompt-task-title">{activeTask.title}</span>
            <span aria-hidden="true">↗</span>
          </button>
          {waitingTasksCount > 1 && onCycleWaitingTask ? (
            <button
              type="button"
              className="chat-prompt-cycle-btn"
              onClick={onCycleWaitingTask}
            >
              切换 ({waitingTaskIndex + 1}/{waitingTasksCount})
            </button>
          ) : null}
        </div>

        <p className="chat-prompt-text">{prompt.text}</p>

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
              const ownerName = matched?.name || step.botName || step.botId || '待接手';
              return (
                <li key={step.id}>
                  {step.text}{' '}
                  <span className="chat-plan-step-bot">（{ownerName}）</span>
                </li>
              );
            })}
          </ol>
        ) : null}

        {error ? (
          <div className="tasks-error-strip" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        {prompt.kind === 'plan' ? (
          <div className="chat-prompt-actions">
            <button
              type="button"
              className="tb-primary-btn"
              disabled={disabled}
              onClick={() => void handleConfirm()}
            >
              {submitting ? '启动中…' : '确认安排并开始'}
            </button>
            <button
              type="button"
              className="tb-secondary-btn"
              disabled={disabled}
              onClick={() => onOpenTaskDetail(activeTask.id, true)}
            >
              编辑步骤
            </button>
          </div>
        ) : prompt.options && prompt.options.length > 0 ? (
          <div className="chat-prompt-actions">
            {prompt.options.map(option => (
              <button
                key={option}
                type="button"
                className="option-pill"
                disabled={disabled}
                onClick={() => void handleAnswer(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
