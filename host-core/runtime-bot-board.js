import { defineDoc, LiveDoc, ResetEntry } from '@earendil-works/pi-durable';
import { BotSessionState, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } from './bot-session-context.js';
import { projectToolPresentation } from './tool-presentation.js';

export { GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE };
export const GOOGLE_ASSISTANT_BOARD_RESULT_KIND = 'proactive-google';
export const GOOGLE_ASSISTANT_DESENSITIZED_BOARD_SUMMARY = '有新的邮件或日程待查看';
export const GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW = '邮件与日程更新';

export function isSilentAssistantReply(text) {
  return typeof text !== 'string' || text.trim() === '' || /^\(?\s*pass\s*\)?\.?$/i.test(text.trim());
}

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

function isGoogleAssistantEntryData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.turn?.sender?.kind === 'host' && data.turn?.sender?.sourceType === GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE) {
    return true;
  }
  if (data.attribution?.kind === 'host' && data.attribution?.sourceType === GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE) {
    return true;
  }
  return false;
}

async function detectProactiveTurnFromHarness(harness, conversationId, taskId, context) {
  if (!harness || conversationId === undefined || conversationId === null) return false;
  const taskKey = taskId !== undefined && taskId !== null ? String(taskId) : null;
  if (typeof harness.snapshot === 'function' && taskKey !== null) {
    try {
      const sessionState = await harness.snapshot(BotSessionState, conversationId, context);
      const reqId = sessionState?.turnByTask?.[taskKey];
      const turn = typeof reqId === 'string' && reqId !== ''
        ? (sessionState?.completedTurns?.[reqId] ??
           (sessionState?.activeTurn?.requestId === reqId ? sessionState.activeTurn : null))
        : (sessionState?.activeTurn?.taskId !== undefined && String(sessionState.activeTurn.taskId) === taskKey
          ? sessionState.activeTurn
          : null);
      if (turn) {
        return turn.sender?.kind === 'host' && turn.sender?.sourceType === GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE;
      }
    } catch {
      // Fall through to LiveDoc inspection.
    }
    // Note: host.bot-board beforeRequest runs before host.request-context populates BotSessionState.turnByTask.
    // Inspect LiveDoc.run.inputs -> submission.entry to identify the incoming turn reliably before beforeRequest clears.
    try {
      const live = await harness.snapshot(LiveDoc, conversationId, context);
      const run = live?.run;
      if (run && String(run.taskId) === taskKey && Array.isArray(run.inputs) && run.inputs.length > 0 && typeof harness.commit === 'function') {
        for (const subId of run.inputs) {
          const entry = await harness.commit(async (tx) => {
            if (typeof tx.submission !== 'function' || typeof tx.entry !== 'function') return null;
            const rec = await tx.submission(subId);
            if (!rec || rec.type !== 'input' || rec.entry === undefined) return null;
            return await tx.entry(rec.entry);
          }, context);
          if (entry && isGoogleAssistantEntryData(entry.data)) {
            return true;
          }
        }
      }
    } catch {
      // Ignore if mock harness lacks LiveDoc/submission lookup.
    }
  }
  return false;
}

export function botBoardResultHooks(getHarness, options = {}) {
  async function resolveIsProactiveTurn(conversationId, taskId, context) {
    if (typeof options?.isProactiveAssistantTurn === 'function') {
      try {
        return Boolean(await options.isProactiveAssistantTurn(conversationId, taskId, context));
      } catch {
        return false;
      }
    }
    if (typeof options?.getTurnSourceType === 'function') {
      try {
        return (await options.getTurnSourceType(conversationId, taskId, context)) === GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE;
      } catch {
        return false;
      }
    }
    return detectProactiveTurnFromHarness(getHarness?.(), conversationId, taskId, context);
  }

  async function resolveIsDedicatedBot(conversationId, context) {
    if (typeof options?.isDedicatedAssistantBot !== 'function') return false;
    try {
      return Boolean(await options.isDedicatedAssistantBot(conversationId, context));
    } catch {
      return false;
    }
  }

  return {
    async beforeRequest(request, api, context) {
      const isProactive = await resolveIsProactiveTurn(api.conversationId, api.taskId, context);
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(BotBoardResult, api.conversationId);
        if (doc.taskId !== String(api.taskId)) {
          doc.taskId = String(api.taskId);
          // Background proactive assistant checks must NOT wipe an unread positive alert on start.
          if (!isProactive) {
            doc.lastResult = null;
          }
        }
      }, context);
    },
    async afterRun(run, api, context) {
      // afterRun is called only after a committed answer, never on failure/abort.
      const entry = await api.entry(run.answer, context);
      const message = entry?.model?.find((item) => item.role === 'assistant');
      if (!message) return;
      const rawText = Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text).join('\n').trim()
        : (typeof message.content === 'string' ? message.content.trim() : '');
      const isProactive = await resolveIsProactiveTurn(api.conversationId, api.taskId, context);
      if (isProactive && isSilentAssistantReply(rawText)) {
        // Silent "(pass)" or empty proactive sweep: preserve any existing unread positive alert.
        return;
      }
      let nextResult;
      if (isProactive) {
        nextResult = {
          id: String(run.answer),
          completedAt: new Date().toISOString(),
          summary: GOOGLE_ASSISTANT_DESENSITIZED_BOARD_SUMMARY,
          kind: GOOGLE_ASSISTANT_BOARD_RESULT_KIND,
        };
      } else {
        const isDedicated = await resolveIsDedicatedBot(api.conversationId, context);
        nextResult = {
          id: String(run.answer),
          completedAt: new Date().toISOString(),
          summary: isDedicated ? GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW : bounded(rawText, 500),
        };
      }
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(BotBoardResult, api.conversationId);
        // Stop/reset invalidates taskId too: a late hook cannot resurrect a result.
        if (doc.taskId !== String(api.taskId) || doc.lastResult?.id === String(run.answer)) return;
        doc.lastResult = nextResult;
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
  // These records have already passed the wait store's ownership/fence check.
  // Attention is independent of SDK execution: another run may be active.
  for (const waitDetails of details?.waits ?? []) {
    const presentation = projectToolPresentation(waitDetails);
    if (presentation?.kind !== 'questionnaire' || presentation.status !== 'pending') continue;
    attention = {
      kind: 'questionnaire', requestId: presentation.requestId,
      summary: bounded(presentation.questions.map((question) => question.question).join('\n'), 200),
      count: presentation.questions.length,
    };
    break;
  }
  // Historical tool results can retain a stale pending presentation after cancellation.
  for (const slot of [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]) {
    if (attention !== null) break;
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
