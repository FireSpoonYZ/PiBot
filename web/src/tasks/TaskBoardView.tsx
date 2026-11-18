import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, PanelLeft, Plus } from 'lucide-react';
import { GrokBotAvatar, type GrokAvatarPreset } from '../GrokBotAvatar';
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

function ListStatusBadge({ task }: { task: GlobalTask }) {
  const info = getTaskStatusInfo(task);
  return (
    <span className={`bs-badge ${info.cls}`}>
      {info.spinning ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
      {info.label}
    </span>
  );
}

function AvatarStack({ botRefs, bots }: { botRefs: TaskBotRef[]; bots: TaskBotOption[] }) {
  if (!botRefs.length) return null;
  const visible = botRefs.slice(0, 4);
  return (
    <span className="avatar-stack">
      {visible.map(ref => {
        const bot = resolveBot(bots, ref);
        const name = bot?.name || ref.botName || ref.botId;
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
  const [filter, setFilter] = useState<TaskFilter>('active');
  const [completedFoldOpen, setCompletedFoldOpen] = useState(false);

  const scopeClass = `tb-scope tasks-root${variant === 'mobile' ? ' is-mobile' : ''}`;

  const activeList = useMemo(
    () => controller.tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled'),
    [controller.tasks],
  );
  const waitingList = useMemo(
    () => controller.tasks.filter(isTaskWaitingForUser),
    [controller.tasks],
  );
  const doneList = useMemo(
    () => controller.tasks.filter(t => t.status === 'done' || t.status === 'cancelled'),
    [controller.tasks],
  );

  const visibleList = filter === 'active' ? activeList : filter === 'waiting' ? waitingList : doneList;
  const activeTask = activeTaskId ? controller.tasks.find(t => t.id === activeTaskId) ?? null : null;
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
            err instanceof Error && err.message ? err.message : String(err || '加载任务详情失败'),
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
                <span>任务</span>
              </button>
            </header>
            {matchedFetch?.status === 'not_found' ? (
              <div className="tasks-empty">该任务不存在或已删除。</div>
            ) : matchedFetch?.status === 'error' ? (
              <div className="tasks-error-strip" role="alert">
                <span>{matchedFetch.errorMessage || '加载任务详情失败'}</span>
                <button
                  type="button"
                  className="mini-pill"
                  onClick={() => setDetailRetryTick(n => n + 1)}
                >
                  重试
                </button>
              </div>
            ) : (
              <div className="tasks-empty">正在加载任务详情…</div>
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
      <div className="task-row-head">
        <span className="task-row-title">{task.title}</span>
        <ListStatusBadge task={task} />
      </div>
      <div className="task-row-foot">
        <span className="task-row-summary">{formatTaskSummary(task)}</span>
        <AvatarStack botRefs={task.botRefs} bots={bots} />
      </div>
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
                  aria-label="打开导航菜单"
                >
                  <PanelLeft size={20} aria-hidden="true" />
                </button>
              ) : null}
              <h1>任务</h1>
            </div>
            <div className="view-topbar-right">
              <button
                type="button"
                className="new-task-btn"
                onClick={onOpenCreate}
                aria-label={hasDraft ? '新建任务（有未发布草稿）' : '新建任务'}
                title={hasDraft ? '继续编辑未发布草稿' : '新建任务'}
              >
                <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
                <span className="new-task-btn-text">新建任务</span>
                {hasDraft ? <span className="draft-dot" aria-hidden="true" /> : null}
              </button>
            </div>
          </header>

          <nav className="filter-pills tabular" aria-label="事项筛选">
            <button
              type="button"
              aria-pressed={filter === 'active'}
              onClick={() => setFilter('active')}
            >
              未完成 {activeList.length}
            </button>
            <button
              type="button"
              aria-pressed={filter === 'waiting'}
              onClick={() => setFilter('waiting')}
            >
              待你回应 {waitingList.length}
            </button>
            <button
              type="button"
              aria-pressed={filter === 'done'}
              onClick={() => setFilter('done')}
            >
              已完成 {doneList.length}
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
                重试
              </button>
            </div>
          ) : null}

          {!controller.loaded && controller.loading && controller.tasks.length === 0 ? (
            <p className="tasks-empty">正在加载任务…</p>
          ) : visibleList.length > 0 ? (
            <>
              <div className="task-list">{visibleList.map(renderCard)}</div>
              {controller.activeTruncated && filter !== 'done' ? (
                <p className="tasks-limit-note">
                  当前进行中任务数量已达分页上限，部分较早事项未全部显示。
                </p>
              ) : null}
              {controller.historyTruncated && filter === 'done' ? (
                <p className="tasks-limit-note">
                  仅显示最近 200 条已完成记录，更早任务可通过历史对话中的任务卡片打开。
                </p>
              ) : null}
            </>
          ) : controller.tasks.length === 0 ? (
            <p className="tasks-empty">
              还没有跟进中的任务，点右上角新建任务，或在和 Bot 聊天时随时交代。
            </p>
          ) : (
            <p className="tasks-empty">当前筛选下没有事项。</p>
          )}

          {filter === 'active' && doneList.length > 0 ? (
            <div className="completed-fold">
              <button
                type="button"
                className={`disclosure-btn${completedFoldOpen ? ' is-open' : ''}`}
                aria-expanded={completedFoldOpen}
                onClick={() => setCompletedFoldOpen(v => !v)}
              >
                <ChevronRight size={15} aria-hidden="true" />
                <span className="tabular">已完成 · {doneList.length}</span>
              </button>
              {completedFoldOpen ? (
                <>
                  <div className="task-list" style={{ marginTop: 8 }}>
                    {doneList.map(renderCard)}
                  </div>
                  {controller.historyTruncated ? (
                    <p className="tasks-limit-note">
                      仅显示最近 200 条已完成记录，更早任务可通过历史对话中的任务卡片打开。
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
