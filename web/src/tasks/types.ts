export type TaskStatus = 'triaging' | 'working' | 'waiting' | 'done' | 'cancelled';

export type TaskStepStatus =
  | 'unassigned'
  | 'todo'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface TaskOrigin {
  kind: 'ui' | 'chat' | 'voice';
  deviceId?: string | null;
  botId?: string | null;
  botName?: string | null;
  conversationId?: string | null;
  label: string;
}

export interface TaskBotRef {
  deviceId: string;
  botId: string;
  botName?: string;
}

export interface TaskPendingPrompt {
  kind: 'plan' | 'question';
  deviceId: string;
  botId: string;
  botName?: string;
  text: string;
  options?: string[];
  createdAt: number;
}

export interface TaskAdoption {
  phase: 'recorded' | 'adjusting' | 'needs_scope' | 'adopted';
  shortReceipt: string;
  changeText: string;
  scopeDesc?: string;
  updatedAt: number;
}

export interface TaskStep {
  id: string;
  parentStepId: string | null;
  text: string;
  status: TaskStepStatus;
  deviceId: string | null;
  botId: string | null;
  botName?: string | null;
  dependsOnStepIds?: string[];
  preserved?: boolean;
  relationNote?: string;
  resultSummary?: string;
  updatedAt: number;
}

export interface TaskLogEntry {
  id: string;
  time: number;
  text: string;
}

export interface GlobalTask {
  id: string;
  title: string;
  requirement: string;
  status: TaskStatus;
  summary: string;
  origin: TaskOrigin;
  coordinatorDeviceId: string | null;
  coordinatorBotId: string | null;
  botRefs: TaskBotRef[];
  pendingPrompt: TaskPendingPrompt | null;
  adoption: TaskAdoption | null;
  steps: TaskStep[];
  logs: TaskLogEntry[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskListCursor {
  updatedAt: number;
  id: string;
}

export type TaskActionInput =
  | {
      action: 'list';
      status?: 'all' | 'active' | 'waiting' | 'done';
      botDeviceId?: string;
      botId?: string;
      limit?: number;
      /** Keyset pagination cursor matching Center ordering (updatedAt DESC, id DESC). */
      cursor?: TaskListCursor | null;
    }
  | {
      action: 'get';
      taskId: string;
    }
  | {
      action: 'create';
      text?: string;
      title?: string;
      requirement?: string;
      origin?: Partial<TaskOrigin>;
      coordinatorDeviceId?: string | null;
      coordinatorBotId?: string | null;
      actorBotId?: string;
      directStart?: boolean;
      pendingPrompt?: { kind: 'plan' | 'question'; text: string; options?: string[] } | null;
      steps?: Array<{
        id?: string;
        parentStepId?: string | null;
        text: string;
        status?: TaskStepStatus;
        deviceId?: string | null;
        botId?: string | null;
        dependsOnStepIds?: string[];
        relationNote?: string;
        resultSummary?: string;
      }>;
    }
  | {
      action: 'update';
      taskId: string;
      expectedRevision?: number;
      actorBotId?: string;
      fromChatBotId?: string;
      fromChatDeviceId?: string;
      title?: string;
      requirement?: string;
      status?: TaskStatus;
      summary?: string;
      coordinatorDeviceId?: string | null;
      coordinatorBotId?: string | null;
      steps?: Array<{
        id?: string;
        parentStepId?: string | null;
        text: string;
        status?: TaskStepStatus;
        deviceId?: string | null;
        botId?: string | null;
        dependsOnStepIds?: string[];
        preserved?: boolean;
        relationNote?: string;
        resultSummary?: string;
      }>;
      stepPatches?: Array<{
        stepId: string;
        parentStepId?: string | null;
        text?: string;
        status?: TaskStepStatus;
        deviceId?: string | null;
        botId?: string | null;
        dependsOnStepIds?: string[];
        preserved?: boolean;
        relationNote?: string;
        resultSummary?: string;
      }>;
      addSteps?: Array<{
        id?: string;
        parentStepId?: string | null;
        afterStepId?: string | null;
        text: string;
        status?: TaskStepStatus;
        deviceId?: string | null;
        botId?: string | null;
        dependsOnStepIds?: string[];
        relationNote?: string;
      }>;
      pendingPrompt?: {
        kind: 'plan' | 'question';
        deviceId?: string;
        botId?: string;
        text: string;
        options?: string[];
      } | null;
      adoption?: Partial<TaskAdoption> | null;
      logText?: string;
    }
  | {
      action: 'confirm_plan';
      taskId: string;
      expectedRevision?: number;
    }
  | {
      action: 'answer_prompt';
      taskId: string;
      answer: string;
      expectedRevision?: number;
    }
  | {
      action: 'resolve_adoption_scope';
      taskId: string;
      scope: 'keep' | 'redo';
      expectedRevision?: number;
    }
  | {
      action: 'dismiss_adoption';
      taskId: string;
    }
  | {
      action: 'delete';
      taskId: string;
    };

export interface TaskBotOption {
  deviceId: string;
  botId: string;
  name: string;
  description?: string;
  online?: boolean;
  avatar?: unknown;
  isPrimary?: boolean;
}

export function getStepStatusInfo(task: GlobalTask, step: TaskStep): { label: string; cls: string } {
  if (step.status === 'done') return { label: '已完成', cls: 'is-done' };
  if (step.status === 'cancelled') return { label: '已取消', cls: 'is-cancelled' };
  if (!step.botId || step.status === 'unassigned') return { label: '待接手', cls: 'is-unassigned' };
  if (task.pendingPrompt?.kind === 'plan') return { label: '待确认', cls: 'is-waiting' };
  if (step.status === 'waiting') return { label: '待你回应', cls: 'is-waiting' };
  if (step.status === 'blocked') return { label: '受阻', cls: 'is-blocked' };
  if (step.status === 'working') return { label: '进行中', cls: 'is-working' };
  return { label: '待开始', cls: 'is-todo' };
}

export function stepCounts(task: GlobalTask): { done: number; total: number } {
  let total = 0;
  let done = 0;
  for (const step of task.steps) {
    if (step.status === 'cancelled') continue;
    total += 1;
    if (step.status === 'done') done += 1;
  }
  return { done, total };
}

export function formatTaskSummary(task: GlobalTask): string {
  const raw = String(task.summary || '').replace(/^已完成\s*\d+\s*\/\s*\d+\s*·\s*/, '');
  if (task.status === 'triaging') return raw;
  const counts = stepCounts(task);
  if (task.status === 'done') {
    const countPart = counts.total > 1 ? ` ${counts.done}/${counts.total}` : '';
    return `已完成${countPart}${raw ? ` · ${raw}` : ''}`;
  }
  if (task.pendingPrompt?.kind === 'plan' && counts.done === 0) {
    return raw;
  }
  if (counts.total > 1) {
    return `已完成 ${counts.done}/${counts.total}${raw ? ` · ${raw}` : ''}`;
  }
  return raw;
}

export interface TaskStatusInfo {
  label: string;
  cls: 'is-triaging' | 'is-waiting' | 'is-unassigned' | 'is-working' | 'is-done';
  spinning?: boolean;
}

export function isTaskWaitingForUser(task: GlobalTask): boolean {
  if (task.status === 'done' || task.status === 'cancelled') return false;
  return task.status === 'waiting' || task.pendingPrompt != null || task.adoption?.phase === 'needs_scope';
}

export function getTaskStatusInfo(task: GlobalTask): TaskStatusInfo {
  if (task.status === 'done') return { label: '已完成', cls: 'is-done' };
  if (task.status === 'cancelled') return { label: '已取消', cls: 'is-done' };
  if (task.status === 'triaging') return { label: '正在理清…', cls: 'is-triaging', spinning: true };
  if (task.adoption?.phase === 'needs_scope') return { label: '待你回应', cls: 'is-waiting' };
  if (task.status === 'waiting' || task.pendingPrompt != null) {
    return {
      label: task.pendingPrompt?.kind === 'plan' ? '待确认安排' : '待你回应',
      cls: 'is-waiting',
    };
  }
  const hasCoordinator = Boolean(task.coordinatorDeviceId && task.coordinatorBotId);
  const hasWorkingStep = task.steps.some(step => step.status === 'working');
  if (!hasCoordinator && !hasWorkingStep) {
    return { label: '待接手', cls: 'is-unassigned' };
  }
  return { label: '进行中', cls: 'is-working' };
}

export function countWaitingTasks(tasks: GlobalTask[]): number {
  let count = 0;
  for (const task of tasks) {
    if (isTaskWaitingForUser(task)) count += 1;
  }
  return count;
}

export function botTasksFor(tasks: GlobalTask[], botDeviceId: string, botId: string): GlobalTask[] {
  return tasks.filter(task => {
    if (task.status === 'cancelled') return false;
    if (task.botRefs.some(ref => ref.deviceId === botDeviceId && ref.botId === botId)) return true;
    if (task.coordinatorDeviceId === botDeviceId && task.coordinatorBotId === botId) return true;
    if (task.pendingPrompt && task.pendingPrompt.deviceId === botDeviceId && task.pendingPrompt.botId === botId) return true;
    return task.steps.some(step => step.status !== 'cancelled' && step.deviceId === botDeviceId && step.botId === botId);
  });
}

function readTaskErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const match = /^([A-Z][A-Z0-9_]{1,63})(?:\b|:)/.exec(msg.trim());
  return match ? match[1] : null;
}

export function isTaskNotFoundError(error: unknown): boolean {
  return readTaskErrorCode(error) === 'TASK_NOT_FOUND';
}

export function isTaskRevisionConflictError(error: unknown): boolean {
  const code = readTaskErrorCode(error);
  return code === 'REQUEST_CONFLICT' || code === 'REVISION_CONFLICT';
}
