import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { GrokBotAvatar, type GrokAvatarPreset } from '../GrokBotAvatar';
import {
  botTasksFor,
  getStepStatusInfo,
  isTaskRevisionConflictError,
  type GlobalTask,
  type TaskBotOption,
} from './types';
import './TaskBoard.css';

export interface TaskChatContextBarProps {
  botDeviceId: string;
  botId: string;
  botName: string;
  tasks: GlobalTask[];
  activeTaskId: string | null;
  activeStepId: string | null;
  returnTaskId: string | null;
  onSelectTaskTopic: (taskId: string | null) => void;
  onSelectStepFocus: (stepId: string | null) => void;
  onOpenTaskDetail: (taskId: string, openEdit?: boolean) => void;
  onReturnToTask?: (taskId: string) => void;
  variant?: 'desktop' | 'mobile';
}

export interface TaskChatPromptBannerProps {
  botDeviceId: string;
  botId: string;
  botName: string;
  avatar?: unknown;
  task: GlobalTask | null;
  bots: TaskBotOption[];
  busy?: boolean;
  onConfirmPlan: (taskId: string, expectedRevision?: number) => Promise<void> | void;
  onOpenTaskEdit: (taskId: string) => void;
  onAnswerPrompt: (taskId: string, answer: string, expectedRevision?: number) => Promise<void> | void;
}

function asGrokAvatar(avatar: unknown): GrokAvatarPreset | undefined {
  if (avatar && typeof avatar === 'object' && 'shape' in avatar && 'color' in avatar) {
    return avatar as GrokAvatarPreset;
  }
  return undefined;
}

export function TaskChatContextBar({
  botDeviceId,
  botId,
  tasks,
  activeTaskId,
  activeStepId,
  returnTaskId,
  onSelectTaskTopic,
  onSelectStepFocus,
  onOpenTaskDetail,
  onReturnToTask,
  variant = 'desktop',
}: TaskChatContextBarProps) {
  const botTasks = useMemo(() => {
    const base = botTasksFor(tasks, botDeviceId, botId);
    if (activeTaskId && !base.some(t => t.id === activeTaskId)) {
      const explicit = tasks.find(t => t.id === activeTaskId);
      if (explicit) return [explicit, ...base];
    }
    return base;
  }, [tasks, botDeviceId, botId, activeTaskId]);

  if (!returnTaskId && botTasks.length === 0 && !activeTaskId) {
    return null;
  }

  const selectedTask = activeTaskId ? tasks.find(t => t.id === activeTaskId) ?? null : null;
  const botStepsInTask = selectedTask
    ? selectedTask.steps.filter(
        s => s.status !== 'cancelled' && s.deviceId === botDeviceId && s.botId === botId,
      )
    : [];

  return (
    <div className={`tb-scope${variant === 'mobile' ? ' is-mobile' : ''}`}>
      <div className="chat-topic-bar" aria-label="按事项隔离对话上下文">
        <div className="topic-pills">
          {returnTaskId && onReturnToTask ? (
            <button
              type="button"
              className="tb-return-task-btn"
              onClick={() => onReturnToTask(returnTaskId)}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>返回任务</span>
            </button>
          ) : null}

          <span className="topic-label">父任务：</span>
          {botTasks.map(task => {
            const isWaitingMe =
              task.status === 'waiting' &&
              task.pendingPrompt?.deviceId === botDeviceId &&
              task.pendingPrompt?.botId === botId;
            return (
              <button
                key={task.id}
                type="button"
                className={`topic-pill${activeTaskId === task.id ? ' active' : ''}`}
                title={task.title}
                onClick={() => onSelectTaskTopic(task.id)}
              >
                {isWaitingMe ? <span className="topic-dot" aria-hidden="true" /> : null}
                <span>{task.title}</span>
              </button>
            );
          })}

          <button
            type="button"
            className={`topic-pill${activeTaskId === null ? ' active' : ''}`}
            onClick={() => onSelectTaskTopic(null)}
          >
            <span>日常对话</span>
          </button>
        </div>

        {selectedTask ? (
          <button
            type="button"
            className="quiet-link"
            onClick={() => onOpenTaskDetail(selectedTask.id)}
          >
            查看任务详情 →
          </button>
        ) : null}
      </div>

      {selectedTask && botStepsInTask.length > 0 ? (
        <div className="chat-subtask-bar" aria-label="当前处理的子任务">
          <span className="topic-label">当前子项：</span>
          <button
            type="button"
            className={`subtask-pill${!activeStepId ? ' active' : ''}`}
            onClick={() => onSelectStepFocus(null)}
          >
            <span>整体任务</span>
          </button>
          {botStepsInTask.map(step => {
            const stInfo = getStepStatusInfo(selectedTask, step);
            return (
              <button
                key={step.id}
                type="button"
                className={`subtask-pill${activeStepId === step.id ? ' active' : ''}`}
                title={step.text}
                onClick={() => onSelectStepFocus(step.id)}
              >
                <span>
                  {step.text} · {stInfo.label}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TaskChatPromptBanner({
  botDeviceId,
  botId,
  botName,
  avatar,
  task,
  bots,
  busy = false,
  onConfirmPlan,
  onOpenTaskEdit,
  onAnswerPrompt,
}: TaskChatPromptBannerProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [task?.id, task?.revision]);

  if (
    !task ||
    !task.pendingPrompt ||
    task.pendingPrompt.deviceId !== botDeviceId ||
    task.pendingPrompt.botId !== botId
  ) {
    return null;
  }

  const prompt = task.pendingPrompt;
  const renderedRevision = task.revision;
  const disabled = busy || submitting;

  const handleConfirm = async () => {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirmPlan(task.id, renderedRevision);
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
      await onAnswerPrompt(task.id, answer, renderedRevision);
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

  const visibleSteps = task.steps.filter(s => s.status !== 'cancelled');

  return (
    <div className="tb-scope">
      <div
        className="chat-prompt-card"
        role="region"
        aria-label={prompt.kind === 'plan' ? '待确认计划' : '待回应问题'}
      >
        <div className="chat-prompt-head">
          <GrokBotAvatar
            preset={asGrokAvatar(avatar)}
            botKey={`${botDeviceId}:${botId}`}
            roleName={botName}
            size={24}
          />
          <span className="chat-prompt-kicker">
            {prompt.kind === 'plan'
              ? '待确认执行安排 · 需明确点击确认才会启动'
              : '待你回应'}
          </span>
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
              onClick={() => onOpenTaskEdit(task.id)}
            >
              回详情编辑步骤
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
