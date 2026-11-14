import { assertId } from './message-protocol.js';

const POLL_INTERVAL_MS = 15000;
const ACTIVE_TASKS_PAGE_LIMIT = 200;
const MAX_ACTIVE_TASK_PAGES = 25;
const DELIVERY_STATUSES = new Set(['dispatching', 'queued', 'running']);
const TASK_DISPATCH_KINDS = new Set([
  'triage',
  'execute',
  'confirm_plan',
  'answer_prompt',
  'adopt_change',
  'subtask',
  'subtask_completed',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameCursor(left, right) {
  if (!left || !right) return false;
  return left.createdAt === right.createdAt && left.rowid === right.rowid;
}

function isValidCursor(nextCursor, prevCursor, itemCount) {
  if (nextCursor === null) return true;
  if (!isPlainObject(nextCursor)) return false;
  if (!Number.isSafeInteger(nextCursor.createdAt) || !Number.isSafeInteger(nextCursor.rowid)) {
    return false;
  }
  if (itemCount === 0 || sameCursor(nextCursor, prevCursor)) return false;
  return true;
}

function isValidListCursor(nextCursor) {
  if (typeof nextCursor === 'string') return nextCursor.length > 0;
  if (!isPlainObject(nextCursor)) return false;
  return Number.isSafeInteger(nextCursor.updatedAt) && typeof nextCursor.id === 'string' && nextCursor.id.length > 0;
}

export async function fetchAllActiveGlobalTasks(
  fetchList,
  { signal, limit = ACTIVE_TASKS_PAGE_LIMIT, maxPages = MAX_ACTIVE_TASK_PAGES } = {},
) {
  const byId = new Map();
  const seenCursors = new Set();
  let cursor = null;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const result = await fetchList(
      {
        action: 'list',
        status: 'active',
        limit,
        ...(cursor !== null ? { cursor } : {}),
      },
      signal,
    );
    const items = Array.isArray(result?.tasks)
      ? result.tasks
      : Array.isArray(result?.items)
        ? result.items
        : null;
    if (!items) break;
    for (const task of items) {
      if (isPlainObject(task) && typeof task.id === 'string' && task.id) {
        byId.set(task.id, task);
      }
    }
    const nextCursor = result?.nextCursor ?? null;
    if (!nextCursor || items.length === 0 || !isValidListCursor(nextCursor)) break;
    const cursorKey = typeof nextCursor === 'string'
      ? nextCursor
      : `${nextCursor.updatedAt}:${nextCursor.id}`;
    if (seenCursors.has(cursorKey)) break;
    seenCursors.add(cursorKey);
    cursor = nextCursor;
  }
  return [...byId.values()];
}

function readOptionalExecRevision(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function validateEvent(event, deviceId) {
  if (!isPlainObject(event)) throw new Error('invalid task dispatch event');
  for (const key of ['id', 'taskId', 'botId', 'requestId']) assertId(event[key], key);
  if (event.stepId !== null && event.stepId !== undefined) assertId(event.stepId, 'stepId');
  if (
    !TASK_DISPATCH_KINDS.has(event.kind) ||
    event.deviceId !== deviceId ||
    !DELIVERY_STATUSES.has(event.status) ||
    (event.cancelRequested !== undefined && typeof event.cancelRequested !== 'boolean') ||
    typeof event.taskTitle !== 'string' ||
    !event.taskTitle.trim() ||
    event.taskTitle.length > 300 ||
    typeof event.instruction !== 'string' ||
    !event.instruction.trim() ||
    event.instruction.length > 8000 ||
    !isPlainObject(event.payload)
  ) {
    throw new Error('invalid task dispatch event');
  }
  if (
    event.payload.taskId !== event.taskId ||
    (event.payload.stepId ?? null) !== (event.stepId ?? null) ||
    (event.payload.kind !== undefined && event.payload.kind !== event.kind)
  ) {
    throw new Error('task dispatch payload mismatches event identity');
  }
  const topExecRevision = readOptionalExecRevision(event.executionRevision, 'executionRevision');
  const payloadExecRevision = readOptionalExecRevision(event.payload.executionRevision, 'payload.executionRevision');
  if (topExecRevision !== null && payloadExecRevision !== null && topExecRevision !== payloadExecRevision) {
    throw new Error('task dispatch executionRevision mismatches payload');
  }
}

function isDispatchStillExecutable(latestTask, event, deviceId) {
  if (!isPlainObject(latestTask) || latestTask.id !== event.taskId) return false;
  if (latestTask.status === 'done' || latestTask.status === 'cancelled') return false;
  const expectedExecRev = event.executionRevision ?? event.payload.executionRevision ?? null;
  if (event.kind === 'triage') {
    if (latestTask.status !== 'triaging') return false;
    if (latestTask.pendingPrompt?.kind === 'plan') return false;
    if (latestTask.coordinatorBotId != null && latestTask.coordinatorBotId !== event.botId) return false;
    if (latestTask.coordinatorDeviceId && latestTask.coordinatorDeviceId !== deviceId) return false;
    return true;
  }
  if (event.stepId != null) {
    if (latestTask.pendingPrompt?.kind === 'plan') return false;
    const step = Array.isArray(latestTask.steps)
      ? latestTask.steps.find((item) => isPlainObject(item) && item.id === event.stepId)
      : null;
    if (!step || step.status === 'cancelled') return false;
    if (step.botId !== event.botId) return false;
    if (step.deviceId && step.deviceId !== deviceId) return false;
    if ((event.kind === 'execute' || event.kind === 'subtask') && step.status === 'done') return false;
    if (
      expectedExecRev !== null &&
      Number.isSafeInteger(step.executionRevision) &&
      step.executionRevision !== expectedExecRev
    ) {
      return false;
    }
    return true;
  }
  if (latestTask.coordinatorBotId && latestTask.coordinatorBotId !== event.botId) return false;
  if (latestTask.coordinatorDeviceId && latestTask.coordinatorDeviceId !== deviceId) return false;
  if (event.kind === 'confirm_plan' && latestTask.pendingPrompt?.kind === 'plan') return false;
  return true;
}

function submissionReceipt(submission) {
  switch (submission.status) {
    case 'queued':
      return { status: 'queued' };
    case 'placed':
      return { status: 'running' };
    case 'done':
      return { status: 'succeeded' };
    case 'unanswered':
      return submission.reason === 'aborted' || submission.reason === 'cancelled'
        ? { status: 'cancelled' }
        : { status: 'failed', error: 'Task dispatch submission ended without an answer' };
    default:
      throw new Error('unknown submission status');
  }
}

function readEventError(event) {
  if (typeof event?.error === 'string') return event.error;
  if (typeof event?.error?.message === 'string') return event.error.message;
  return undefined;
}

export function createTaskDispatchConsumer({
  runtime,
  getClient,
  getDeviceId,
  onTasksSynced,
  isReady,
  getStopStates,
}) {
  let closed = false;
  let paused = false;
  let timer = null;
  let inflight = null;
  let controller = null;
  let pending = false;
  let cursor = null;

  const ready = () => (typeof isReady === 'function' ? Boolean(isReady()) : Boolean(getClient?.()));

  async function consume(event, stopState, hasStopSnapshot, client, signal) {
    const active = () => !signal.aborted && !closed && !paused && ready() && getClient() === client;
    let receipt;
    try {
      if (event.cancelRequested) {
        try {
          await runtime.cancelTaskDispatch(event.botId, event.requestId);
        } catch (cancelErr) {
          if (cancelErr?.code !== 'BOT_NOT_FOUND' && cancelErr?.code !== 'BOT_ARCHIVED') {
            return;
          }
        }
        receipt = { status: 'cancelled', error: 'Task dispatch cancelled' };
      } else {
        let submission = await runtime.getSubmission(event.botId, event.requestId);
        if (!active()) return;
        if (!submission) {
          if (stopState?.pendingStopEpoch != null) {
            return;
          } else if (event.status !== 'dispatching') {
            receipt = {
              status: 'failed',
              error: 'Previously accepted task dispatch submission is unavailable',
            };
          } else {
            if (hasStopSnapshot && !stopState) return;
            let latestResult;
            try {
              latestResult = await client.globalTasks({ action: 'get', taskId: event.taskId }, signal);
            } catch (lookupErr) {
              if (lookupErr?.code === 'TASK_NOT_FOUND' || lookupErr?.code === 'NOT_FOUND') {
                receipt = { status: 'cancelled', error: 'Task no longer exists' };
                latestResult = null;
              } else {
                return;
              }
            }
            if (!active()) return;
            if (!receipt) {
              if (!isDispatchStillExecutable(latestResult?.task, event, getDeviceId?.())) {
                receipt = { status: 'cancelled', error: 'Task dispatch superseded or no longer executable' };
              } else {
                submission = await runtime.submitTaskDispatch(
                  event.botId,
                  {
                    requestId: event.requestId,
                    text: event.instruction,
                    dispatchContext: {
                      taskId: event.taskId,
                      stepId: event.stepId ?? null,
                      executionRevision: event.executionRevision ?? event.payload.executionRevision ?? 1,
                    },
                    origin: {
                      sender: {
                        kind: 'host',
                        name: '任务 · ' + (event.taskTitle || '全局任务'),
                        sourceType: 'webhook',
                      },
                      replyTo: null,
                    },
                  },
                  stopState?.stopEpoch,
                );
              }
            }
          }
        }
        if (submission) receipt = submissionReceipt(submission);
      }
    } catch (error) {
      if (error?.code === 'BOT_NOT_FOUND' || error?.code === 'BOT_ARCHIVED') {
        receipt = { status: 'cancelled', error: 'Task dispatch target Bot is unavailable' };
      } else if (error?.code === 'REQUEST_CONFLICT') {
        receipt = { status: 'failed', error: 'Task dispatch request ID conflicts with an existing submission' };
      } else {
        return;
      }
    }
    if (!active() || !receipt) return;
    if (event.status === 'running' && receipt.status === 'queued') return;
    const isTerminalReceipt = receipt.status !== 'queued' && receipt.status !== 'running';
    if (
      isTerminalReceipt &&
      receipt.status === event.status &&
      (receipt.error ?? undefined) === readEventError(event)
    ) {
      return;
    }
    await client.reportTaskDispatch(event.id, receipt, signal);
  }

  async function syncCaches(client, signal) {
    const active = () => !signal.aborted && !closed && !paused && ready() && getClient() === client;
    if (!active() || typeof onTasksSynced !== 'function') return;
    const [tasksResult, directoryResult] = await Promise.allSettled([
      typeof client.globalTasks === 'function'
        ? fetchAllActiveGlobalTasks((body, sig) => client.globalTasks(body, sig), { signal })
        : Promise.resolve(null),
      typeof client.getBotSync === 'function'
        ? client.getBotSync({}, signal)
        : Promise.resolve(null),
    ]);
    if (!active()) return;
    const tasks = tasksResult.status === 'fulfilled' && Array.isArray(tasksResult.value)
      ? tasksResult.value
      : undefined;
    const directoryValue = directoryResult.status === 'fulfilled' ? directoryResult.value : null;
    const bots = Array.isArray(directoryValue?.bots)
      ? directoryValue.bots
      : Array.isArray(directoryValue?.items)
        ? directoryValue.items
        : undefined;
    if (tasks !== undefined || bots !== undefined) {
      onTasksSynced({
        ...(tasks !== undefined ? { tasks } : {}),
        ...(bots !== undefined ? { bots } : {}),
      });
    }
  }

  async function drain(signal) {
    pending = false;
    const client = getClient?.();
    const active = () => !signal.aborted && !closed && !paused && ready() && getClient() === client;
    if (!client || !active()) return false;
    const deviceId = getDeviceId?.();
    let stopStates = null;
    if (typeof getStopStates === 'function') {
      const snapshot = await getStopStates();
      if (!active()) return false;
      stopStates = new Map(snapshot.map(({ botId, stopEpoch, pendingStopEpoch }) => [
        botId,
        { stopEpoch, pendingStopEpoch },
      ]));
    }
    const result = await client.pollTaskDispatches({ cursor }, signal);
    if (!active()) return false;
    if (!Array.isArray(result?.items) || result.items.length > 50 ||
        !isValidCursor(result.nextCursor, cursor, result.items.length)) {
      throw new Error('invalid task dispatch poll response');
    }
    for (const event of result.items) {
      if (!active()) return false;
      try {
        validateEvent(event, deviceId);
        await consume(event, stopStates?.get(event.botId), stopStates !== null, client, signal);
      } catch {
        // Isolate malformed events or single receipt failures to retry on the next cycle.
      }
    }
    if (!active()) return false;
    cursor = result.nextCursor;
    if (cursor === null) {
      try {
        await syncCaches(client, signal);
      } catch {
        // Cache sync failures retry on the next wake/poll cycle.
      }
    }
    return cursor !== null;
  }

  function wake() {
    if (closed || paused || !ready()) return;
    pending = true;
    if (inflight) return;
    clearTimeout(timer);
    timer = null;
    controller = new AbortController();
    const { signal } = controller;
    let more = false;
    inflight = drain(signal).then((nextPage) => {
      more = nextPage;
    }).catch(() => {
      // Fallback polling retries when SSE events or HTTP requests drop.
    }).finally(() => {
      inflight = null;
      controller = null;
      if (closed || paused || !ready() || (signal.aborted && !pending)) return;
      timer = setTimeout(wake, pending || more ? 0 : POLL_INTERVAL_MS);
      timer.unref?.();
    });
  }

  function pause() {
    paused = true;
    pending = false;
    clearTimeout(timer);
    timer = null;
    controller?.abort();
  }

  function resume() {
    if (closed) return;
    paused = false;
    wake();
  }

  return {
    wake,
    pause,
    resume,
    async close() {
      closed = true;
      pause();
      await inflight;
    },
  };
}
