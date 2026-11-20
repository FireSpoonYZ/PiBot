import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, PanelLeft, Plus } from 'lucide-react';
import { GrokBotAvatar, type GrokAvatarPreset } from '../GrokBotAvatar';
import { useText } from '../ui';
import { TaskCreateView } from './TaskCreateView';
import { TaskDetailView } from './TaskDetailView';
import { formatTaskSummary, getTaskStatusInfo, isTaskWaitingForUser, type GlobalTask, type TaskBotOption, type TaskBotRef } from './types';
import type { GlobalTasksController } from './useGlobalTasks';
import './TaskBoard.css';

export interface TaskBoardViewProps {
  controller: GlobalTasksController;
  bots: TaskBotOption[];
  variant: 'desktop' | 'mobile';
  activeTaskId: string | null;
  creatingTask: boolean;
  initialEditMode?: boolean;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  onSelectTask: (taskId: string | null, openInEditMode?: boolean) => void;
  onJumpToChat: (target: { deviceId: string; botId: string; taskId: string; stepId?: string | null }) => void;
  onOpenMobileDrawer?: () => void;
}

type TaskFilter = 'active' | 'waiting' | 'done';

function asGrokAvatar(avatar: unknown): GrokAvatarPreset | undefined {
  if (avatar && typeof avatar === 'object' && 'shape' in avatar && 'color' in avatar) {
    return avatar as GrokAvatarPreset;
  }
  return undefined;
}

function resolveBot(bots: TaskBotOption[], ref: TaskBotRef): TaskBotOption | undefined {
  return (
    bots.find(b => b.deviceId === ref.deviceId && b.botId === ref.botId) ??
    bots.find(b => b.botId === ref.botId)
  );
}

function ListStatusBadge({ task, t }: { task: GlobalTask; t: (zh: string, en: string) => string }) {
  const info = getTaskStatusInfo(task, t);
  return (
    <span className={`bs-badge ${info.cls}`}>
      {info.spinning ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
      {info.label}
    </span>
  );
}

function AvatarStack({
  botRefs,
  bots,
  t,
}: {
  botRefs: TaskBotRef[];
  bots: TaskBotOption[];
  t: (zh: string, en: string) => string;
}) {
  if (!botRefs.length) return null;
  const visible = botRefs.slice(0, 4);
  const allNames = botRefs.map(ref => {
    const bot = resolveBot(bots, ref);
    return bot?.name || ref.botName || t('未知 Bot', 'Unknown Bot');
  });
  return (
    <span className="avatar-stack">
      <span className="sr-only">{t(`参与 Bot：${allNames.join('、')}`, `Participating bots: ${allNames.join(', ')}`)}</span>
      {visible.map(ref => {
        const bot = resolveBot(bots, ref);
        const name = bot?.name || ref.botName || t('未知 Bot', 'Unknown Bot');
        return (
          <GrokBotAvatar
            key={`${ref.deviceId}:${ref.botId}`}
            preset={asGrokAvatar(bot?.avatar)}
            botKey={`${ref.deviceId}:${ref.botId}`}
            roleName={name}
            isPrimary={bot?.isPrimary}
            offline={bot ? bot.online === false : false}
            size={22}
          />
        );
      })}
    </span>
  );
}

export function TaskBoardView({
  controller,
  bots,
  variant,
  activeTaskId,
  creatingTask,
  initialEditMode,
  onOpenCreate,
  onCloseCreate,
  onSelectTask,
  onJumpToChat,
  onOpenMobileDrawer,
}: TaskBoardViewProps) {
  const t = useText();
  const [filter, setFilter] = useState<TaskFilter>('active');

  const scopeClass = `tb-scope tasks-root${variant === 'mobile' ? ' is-mobile' : ''}`;

  const activeList = useMemo(
    () => controller.tasks.filter(item => item.status !== 'done' && item.status !== 'cancelled'),
    [controller.tasks],
  );
  const waitingList = useMemo(
    () => controller.tasks.filter(isTaskWaitingForUser),
    [controller.tasks],
  );
  const doneList = useMemo(
    () => controller.tasks.filter(item => item.status === 'done' || item.status === 'cancelled'),
    [controller.tasks],
  );

  const visibleList = filter === 'active' ? activeList : filter === 'waiting' ? waitingList : doneList;
  const activeTask = activeTaskId ? controller.tasks.find(item => item.id === activeTaskId) ?? null : null;
  const hasActiveTask = Boolean(activeTask);
  const { getTask } = controller;

  const [detailFetch, setDetailFetch] = useState<{
    taskId: string;
    getTaskRef: GlobalTasksController['getTask'];
    status: 'loading' | 'not_found' | 'error';
    errorMessage: string | null;
  } | null>(null);
  const [detailRetryTick, setDetailRetryTick] = useState(0);

  useEffect(() => {
    if (creatingTask || !activeTaskId || hasActiveTask) return;
    let cancelled = false;
    setDetailFetch({
      taskId: activeTaskId,
      getTaskRef: getTask,
      status: 'loading',
      errorMessage: null,
    });
    void getTask(activeTaskId)
      .then(found => {
        if (cancelled) return;
        if (!found) {
          setDetailFetch({
            taskId: activeTaskId,
            getTaskRef: getTask,
            status: 'not_found',
            errorMessage: null,
          });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setDetailFetch({
          taskId: activeTaskId,
          getTaskRef: getTask,
          status: 'error',
          errorMessage:
            err instanceof Error && err.message ? err.message : String(err || ''),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [creatingTask, activeTaskId, hasActiveTask, getTask, detailRetryTick]);

  if (creatingTask) {
    return (
      <div className={scopeClass}>
        <TaskCreateView controller={controller} onClose={onCloseCreate} />
      </div>
    );
  }

  if (activeTaskId) {
    if (activeTask) {
      return (
        <div className={scopeClass}>
          <TaskDetailView
            task={activeTask}
            controller={controller}
            bots={bots}
            initialEditMode={initialEditMode}
            onBack={() => onSelectTask(null)}
            onJumpToChat={onJumpToChat}
          />
        </div>
      );
    }
    const matchedFetch =
      detailFetch && detailFetch.taskId === activeTaskId && detailFetch.getTaskRef === getTask
        ? detailFetch
        : null;
    return (
      <div className={scopeClass}>
        <div className="tasks-scroll">
          <div className="tasks-container page-enter">
            <header className="detail-topbar">
              <button type="button" className="back-btn" onClick={() => onSelectTask(null)}>
                <ArrowLeft size={19} aria-hidden="true" />
                <span>{t('任务', 'Tasks')}</span>
              </button>
            </header>
            {matchedFetch?.status === 'not_found' ? (
              <div className="tasks-empty" role="status">{t('该任务不存在或已删除。', 'This task does not exist or has been deleted.')}</div>
            ) : matchedFetch?.status === 'error' ? (
              <div className="tasks-error-strip" role="alert">
                <span>{matchedFetch.errorMessage || t('加载任务详情失败', 'Failed to load task details')}</span>
                <button
                  type="button"
                  className="mini-pill"
                  onClick={() => setDetailRetryTick(n => n + 1)}
                >
                  {t('重试', 'Retry')}
                </button>
              </div>
            ) : (
              <div className="tasks-empty" role="status">{t('正在加载任务详情…', 'Loading task details…')}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const hasDraft = controller.createDraft.trim().length > 0;

  const renderCard = (task: GlobalTask) => (
    <button
      key={task.id}
      type="button"
      className={`task-row-card${task.status === 'done' || task.status === 'cancelled' ? ' is-done' : ''}`}
      onClick={() => onSelectTask(task.id)}
    >
      <span className="task-row-head">
        <span className="task-row-title">{task.title}</span>
        <ListStatusBadge task={task} t={t} />
      </span>
      <span className="task-row-foot">
        <span className="task-row-summary">{formatTaskSummary(task, t)}</span>
        <AvatarStack botRefs={task.botRefs} bots={bots} t={t} />
      </span>
    </button>
  );

  return (
    <div className={scopeClass}>
      <div className="tasks-scroll">
        <div className="tasks-container page-enter">
          <header className="view-topbar">
            <div className="view-topbar-left">
              {variant === 'mobile' && onOpenMobileDrawer ? (
                <button
                  type="button"
                  className="tb-circle-btn"
                  onClick={onOpenMobileDrawer}
                  aria-label={t('打开导航菜单', 'Open navigation menu')}
                >
                  <PanelLeft size={20} aria-hidden="true" />
                </button>
              ) : null}
              <h1>{t('任务', 'Tasks')}</h1>
            </div>
            <div className="view-topbar-right">
              <button
                type="button"
                className="new-task-btn"
                onClick={onOpenCreate}
                aria-label={hasDraft ? t('新建任务（有未发布草稿）', 'New task (unpublished draft)') : t('新建任务', 'New task')}
                title={variant === 'mobile' ? undefined : (hasDraft ? t('继续编辑未发布草稿', 'Continue editing unpublished draft') : t('新建任务', 'New task'))}
              >
                <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
                <span className="new-task-btn-text">{t('新建任务', 'New task')}</span>
                {hasDraft ? <span className="draft-dot" aria-hidden="true" /> : null}
              </button>
            </div>
          </header>

          <nav className="filter-pills tabular" aria-label={t('事项筛选', 'Filter tasks')}>
            <button
              type="button"
              aria-pressed={filter === 'active'}
              onClick={() => setFilter('active')}
            >
              {t('未完成', 'Active')} {activeList.length}
            </button>
            <button
              type="button"
              aria-pressed={filter === 'waiting'}
              onClick={() => setFilter('waiting')}
            >
              {t('待你回应', 'Awaiting reply')} {waitingList.length}
            </button>
            <button
              type="button"
              aria-pressed={filter === 'done'}
              onClick={() => setFilter('done')}
            >
              {t('已完成', 'Completed')} {doneList.length}
            </button>
          </nav>

          {controller.error ? (
            <div className="tasks-error-strip" role="alert">
              <span>{controller.error}</span>
              <button
                type="button"
                className="mini-pill"
                onClick={() => void controller.refresh()}
              >
                {t('重试', 'Retry')}
              </button>
            </div>
          ) : null}

          {!controller.loaded && controller.loading && controller.tasks.length === 0 ? (
            <p className="tasks-empty" role="status">{t('正在加载任务…', 'Loading tasks…')}</p>
          ) : visibleList.length > 0 ? (
            <>
              <div className="task-list">{visibleList.map(renderCard)}</div>
              {controller.activeTruncated && filter !== 'done' ? (
                <p className="tasks-limit-note">
                  {t('当前进行中任务数量已达分页上限，部分较早事项未全部显示。', 'Active task list reached the pagination limit; some older tasks are not shown.')}
                </p>
              ) : null}
              {controller.historyTruncated && filter === 'done' ? (
                <p className="tasks-limit-note">
                  {t('仅显示最近 200 条已完成记录，更早任务可通过历史对话中的任务卡片打开。', 'Showing the most recent 200 completed tasks. Older tasks can be opened from task cards in chat history.')}
                </p>
              ) : null}
            </>
          ) : controller.tasks.length === 0 ? (
            <p className="tasks-empty">
              {t('还没有跟进中的任务，点右上角新建任务，或在和 Bot 聊天时随时交代。', 'No tasks yet. Tap New task above, or ask a Bot in chat anytime.')}
            </p>
          ) : (
            <p className="tasks-empty">{t('当前筛选下没有事项。', 'No tasks match this filter.')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
