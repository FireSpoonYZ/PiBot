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

export function projectBotBoardItem(botId, conversationId, state, view, details) {
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
  return {
    botId,
    conversationId,
    activity: state.activity,
    queuedCount: state.queuedCount,
    attention,
    progress: details?.progress ?? null,
    // A committed answer in afterRun is not yet idle; queues/control/failure win.
    lastResult: state.activity.phase === 'idle' && live?.runFailure == null
      ? details?.lastResult ?? null : null,
  };
}
