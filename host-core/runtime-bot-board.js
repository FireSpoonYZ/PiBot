import { defineDoc, ResetEntry } from '@earendil-works/pi-durable';
import { projectToolPresentation } from './tool-presentation.js';

export const BotBoardResult = defineDoc({
  kind: 'host.bot-board-result',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ taskId: null, lastResult: null }),
  checkpointWhen: () => false,
});

// Fixed todo plugin v1 contract (plugins/todo/todo-state.js); read only.
// This SDK's ConversationView mounts only pi.* documents, not plugin docs.
const Todos = defineDoc({
  kind: 'e-launcher.todos',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ nextId: 1, tasks: [] }),
  checkpointWhen: () => false,
});

function bounded(text, max) {
  return text.slice(0, max).toWellFormed();
}

export function botBoardResultHooks(getHarness) {
  return {
    async beforeRequest(request, api, context) {
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(BotBoardResult, api.conversationId);
        if (doc.taskId !== String(api.taskId)) {
          doc.taskId = String(api.taskId);
          doc.lastResult = null;
        }
      }, context);
    },
    async afterRun(run, api, context) {
      // afterRun is called only after a committed answer, never on failure/abort.
      const entry = await api.entry(run.answer, context);
      const message = entry?.model?.find((item) => item.role === 'assistant');
      if (!message) return;
      const summary = bounded(message.content.filter((block) => block.type === 'text')
        .map((block) => block.text).join('\n').trim(), 500);
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(BotBoardResult, api.conversationId);
        // Stop/reset invalidates taskId too: a late hook cannot resurrect a result.
        if (doc.taskId !== String(api.taskId) || doc.lastResult?.id === String(run.answer)) return;
        doc.lastResult = {
          id: String(run.answer),
          completedAt: new Date().toISOString(),
          summary,
        };
      }, context);
    },
  };
}

export async function clearBotBoardResult(tx, nativeId) {
  const doc = await tx.doc(BotBoardResult, nativeId);
  doc.taskId = null;
  doc.lastResult = null;
}

/** Passive reads only; a crash between reset and index cleanup must not revive a result. */
export async function readBotBoardDetails(harness, nativeId, context) {
  const todos = await harness.snapshot(Todos, nativeId, context);
  const result = await harness.snapshot(BotBoardResult, nativeId, context);
  const tasks = todos?.tasks ?? [];
  const progress = tasks.length === 0 ? null : {
    completed: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    current: tasks.find((task) => task.status === 'in_progress')?.subject ?? null,
  };
  if (progress?.current !== null && progress?.current !== undefined) {
    progress.current = bounded(progress.current, 200);
  }
  let lastResult = result?.lastResult ?? null;
  if (lastResult) {
    const conversation = await harness.conversation(nativeId, context);
    let cursor;
    do {
      const page = await conversation.entries({ minEntryId: Number(lastResult.id) + 1 }, 100, cursor, context);
      if (page.items.some((entry) => entry.kind === ResetEntry.kind)) {
        lastResult = null;
        break;
      }
      cursor = page.next;
    } while (cursor);
  }
  return { progress, lastResult };
}

function matchesDevice(targetDeviceId, deviceId) {
  return !deviceId || !targetDeviceId || targetDeviceId === deviceId;
}

function taskStepInvolvesBot(step, botId, deviceId) {
  return Boolean(step && step.status !== 'cancelled' && step.botId === botId && matchesDevice(step.deviceId, deviceId));
}

function taskPromptTargetsBot(task, botId, deviceId) {
  return Boolean(task?.pendingPrompt && task.pendingPrompt.botId === botId && matchesDevice(task.pendingPrompt.deviceId, deviceId));
}

function taskInvolvesBot(task, botId, deviceId) {
  if (!task || task.status === 'done' || task.status === 'cancelled') return false;
  if (taskPromptTargetsBot(task, botId, deviceId)) return true;
  if (task.coordinatorBotId === botId && matchesDevice(task.coordinatorDeviceId, deviceId)) return true;
  return Array.isArray(task.steps) && task.steps.some((step) => taskStepInvolvesBot(step, botId, deviceId));
}

function deriveTaskStatusLine(task, botId, deviceId, botStep) {
  if (taskPromptTargetsBot(task, botId, deviceId)) {
    return task.pendingPrompt.kind === 'plan' ? '待确认' : '待你回应';
  }
  if (botStep?.status === 'working') return '进行中';
  if (botStep?.status === 'todo') return '等待开始';
  if (botStep?.status === 'blocked') return '受阻 · 等待前置结果';
  if (botStep?.status === 'waiting') return '等待确认';
  if (task.status === 'triaging') return '拆解中';
  if (task.status === 'waiting') return '等待前置结果';
  if (task.status === 'working') return '进行中';
  return '等待开始';
}

export function deriveGlobalTaskBoardFields(botId, tasks, deviceId, existingAttention, existingProgress) {
  const activeTasks = Array.isArray(tasks)
    ? tasks.filter((task) => taskInvolvesBot(task, botId, deviceId))
    : [];
  if (activeTasks.length === 0) {
    return {
      attention: existingAttention ?? null,
      progress: existingProgress ?? null,
      taskId: null,
      taskTitle: null,
      taskStatusLine: null,
    };
  }
  const attentionTasks = activeTasks.filter((task) => taskPromptTargetsBot(task, botId, deviceId));
  let attention = existingAttention ?? null;
  if (attention === null && attentionTasks.length > 0) {
    const promptTask = attentionTasks[0];
    const title = typeof promptTask.title === 'string' ? promptTask.title : '';
    const promptText = typeof promptTask.pendingPrompt?.text === 'string'
      ? promptTask.pendingPrompt.text.slice(0, 160)
      : '';
    attention = {
      kind: 'questionnaire',
      requestId: 'task:' + promptTask.id,
      summary: bounded('「' + title + '」：' + promptText, 200),
      count: attentionTasks.length,
    };
  }
  // Plan-confirmation isolation: tasks awaiting plan confirmation must not expose unconfirmed steps in progress.
  const confirmedTasks = activeTasks.filter((task) => task.pendingPrompt?.kind !== 'plan');
  const primaryTask = attentionTasks.find((task) => task.pendingPrompt?.kind !== 'plan')
    ?? confirmedTasks[0]
    ?? null;
  if (!primaryTask) {
    const planTask = attentionTasks[0] ?? activeTasks[0];
    if (attentionTasks.length === 0 && existingProgress != null) {
      return {
        attention,
        progress: existingProgress,
        taskId: null,
        taskTitle: null,
        taskStatusLine: null,
      };
    }
    return {
      attention,
      progress: existingProgress ?? null,
      taskId: planTask.id,
      taskTitle: planTask.title ?? null,
      taskStatusLine: '待确认',
    };
  }
  const steps = Array.isArray(primaryTask.steps) ? primaryTask.steps : [];
  const nonCancelled = steps.filter((step) => step && step.status !== 'cancelled');
  const completed = nonCancelled.filter((step) => step.status === 'done').length;
  const total = nonCancelled.length;
  const mySteps = nonCancelled.filter((step) => taskStepInvolvesBot(step, botId, deviceId));
  const botStep =
    mySteps.find((step) => step.status === 'working') ??
    mySteps.find((step) => step.status === 'todo') ??
    mySteps.find((step) => step.status === 'blocked') ??
    mySteps.find((step) => step.status === 'waiting') ??
    null;
  const current = botStep
    ? bounded('「' + (primaryTask.title ?? '') + '」 · ' + (botStep.text ?? ''), 200)
    : null;
  const progress = total === 0
    ? null
    : { completed, total, current };
  return {
    attention,
    progress,
    taskId: primaryTask.id,
    taskTitle: primaryTask.title ?? null,
    taskStatusLine: deriveTaskStatusLine(primaryTask, botId, deviceId, botStep),
  };
}

export function applyGlobalTasksToBotBoardItem(item, globalTasks, deviceId) {
  if (!item) return item;
  const merged = deriveGlobalTaskBoardFields(
    item.botId,
    globalTasks,
    deviceId,
    item.attention ?? null,
    item.progress ?? null,
  );
  return {
    ...item,
    ...merged,
  };
}

export function projectBotBoardItem(botId, conversationId, state, view, details, options = {}) {
  let attention = null;
  const live = view?.docs?.['pi.live'];
  // Historical tool results can retain a stale pending presentation after cancellation.
  for (const slot of [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]) {
    if (slot.status !== 'running') continue;
    const presentation = projectToolPresentation(slot.details);
    if (presentation?.kind !== 'questionnaire' || presentation.status !== 'pending') continue;
    attention = {
      kind: 'questionnaire',
      requestId: presentation.requestId,
      summary: bounded(presentation.questions.map((question) => question.question).join('\n'), 200),
      count: presentation.questions.length,
    };
    break;
  }
  const globalTasks = typeof options?.getBotGlobalTasks === 'function'
    ? options.getBotGlobalTasks(botId)
    : [];
  const merged = deriveGlobalTaskBoardFields(
    botId,
    globalTasks,
    options?.deviceId,
    attention,
    details?.progress ?? null,
  );
  return {
    botId,
    conversationId,
    activity: state.activity,
    queuedCount: state.queuedCount,
    attention: merged.attention,
    progress: merged.progress,
    taskId: merged.taskId,
    taskTitle: merged.taskTitle,
    taskStatusLine: merged.taskStatusLine,
    // A committed answer in afterRun is not yet idle; queues/control/failure win.
    lastResult: state.activity.phase === 'idle' && live?.runFailure == null
      ? details?.lastResult ?? null : null,
  };
}
