import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ClipboardList, Filter, Loader2, PanelLeft, Plus } from 'lucide-react';
import { ActionBar, Button, EmptyState, ErrorState } from '../components/ui';
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
              <ActionBar align="start">
                <button type="button" className="back-btn" onClick={() => onSelectTask(null)}>
                  <ArrowLeft size={19} aria-hidden="true" />
                  <span>{t('任务列表', 'Tasks')}</span>
                </button>
              </ActionBar>
            </header>
            {matchedFetch?.status === 'not_found' ? (
              <EmptyState
                className="tasks-empty"
                icon={<ClipboardList aria-hidden="true" />}
                title={t('找不到该任务', 'Task not found')}
                description={t('该任务不存在或已被删除。', 'This task does not exist or has been deleted.')}
                actionLabel={t('返回任务列表', 'Back to tasks')}
                onAction={() => onSelectTask(null)}
              />
            ) : matchedFetch?.status === 'error' ? (
              <ErrorState
                title={t('加载任务详情失败', 'Failed to load task details')}
                description={matchedFetch.errorMessage || t('请检查网络连接后重试。', 'Check your connection and try again.')}
                retryLabel={t('重新加载', 'Reload task')}
                onRetry={() => setDetailRetryTick(n => n + 1)}
              />
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
            <ActionBar align="end" className="view-topbar-right">
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
            </ActionBar>
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

          {controller.error && controller.tasks.length > 0 ? (
            <div className="tasks-error-strip" role="alert">
              <span>{controller.error}</span>
              <ActionBar align="end">
                <button
                  type="button"
                  className="mini-pill"
                  disabled={controller.loading}
                  aria-busy={controller.loading || undefined}
                  onClick={() => void controller.refresh()}
                >
                  {controller.loading ? t('刷新中…', 'Refreshing…') : t('重新加载', 'Reload tasks')}
                </button>
              </ActionBar>
            </div>
          ) : null}

          {!controller.loaded && controller.loading && controller.tasks.length === 0 ? (
            <p className="tasks-empty" role="status">{t('正在加载任务…', 'Loading tasks…')}</p>
          ) : controller.error && controller.tasks.length === 0 ? (
            <ErrorState
              title={t('加载任务列表失败', 'Failed to load tasks')}
              description={controller.error}
              action={(
                <Button
                  variant="secondary"
                  size="sm"
                  loading={controller.loading}
                  onClick={() => void controller.refresh()}
                >
                  {controller.loading ? t('加载中…', 'Loading…') : t('重新加载', 'Reload tasks')}
                </Button>
              )}
            />
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
            <EmptyState
              className="tasks-empty"
              icon={<ClipboardList aria-hidden="true" />}
              title={t('还没有任务', 'No tasks yet')}
              description={t('写下想法或要求交给 Bot 协作推进，也可以在和 Bot 聊天时随时交代。', 'Write down an idea or request for Bots to coordinate, or ask a Bot anytime in chat.')}
              actionLabel={hasDraft ? t('继续编辑草稿', 'Resume draft') : t('新建任务', 'New task')}
              onAction={onOpenCreate}
            />
          ) : filter === 'active' ? (
            <EmptyState
              className="tasks-empty"
              icon={<Filter aria-hidden="true" />}
              title={t('没有未完成的任务', 'No active tasks')}
              description={t('现有任务都已完成，可切换到「已完成」查看记录，或新建任务。', 'All tasks are completed. Switch to Completed to review them, or create a new task.')}
              action={(
                <ActionBar align="start">
                  <Button variant="secondary" size="sm" onClick={() => setFilter('done')}>
                    {t('查看已完成', 'View completed')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={onOpenCreate}>
                    {hasDraft ? t('继续编辑草稿', 'Resume draft') : t('新建任务', 'New task')}
                  </Button>
                </ActionBar>
              )}
            />
          ) : filter === 'waiting' ? (
            <EmptyState
              className="tasks-empty"
              icon={<Filter aria-hidden="true" />}
              title={t('没有待你回应的任务', 'Nothing awaiting reply')}
              description={t('当前没有需要你确认安排或回答问题的事项。', 'No tasks currently need your confirmation or reply.')}
              action={(
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setFilter(activeList.length > 0 ? 'active' : 'done')}
                >
                  {activeList.length > 0 ? t('查看未完成', 'View active') : t('查看已完成', 'View completed')}
                </Button>
              )}
            />
          ) : (
            <EmptyState
              className="tasks-empty"
              icon={<Filter aria-hidden="true" />}
              title={t('还没有已完成任务', 'No completed tasks yet')}
              description={t('任务完成后会归档显示在这里。', 'Completed tasks will appear here once finished.')}
              action={(
                <Button variant="secondary" size="sm" onClick={() => setFilter('active')}>
                  {t('查看未完成', 'View active')}
                </Button>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}
