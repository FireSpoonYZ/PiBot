// Read-only Host execution protocol. Existing queues, SDK submissions/tasks and
// GlobalTask records remain authoritative; this module never schedules or stores.
// Inputs must come from trusted Host records, never from model text or wire hints.
const HOST_SOURCES = ['schedule', 'webhook', 'task_dispatch', 'google-workspace-rule', 'google-workspace-assistant'];
const SOURCES = new Set(['user', 'peer', 'host', ...HOST_SOURCES]);
const CHANNELS = new Set(['primary', 'dm', 'room', 'host']);
const STATES = new Set(['accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function requiredText(value, name) {
  const result = text(value);
  if (result === null) throw invalid(`${name} must be a non-empty string`);
  return result;
}

function nativeId(value, name) {
  if (value === undefined || value === null) return null;
  const result = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 1) throw invalid(`${name} must be a positive safe integer`);
  return result;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function sender(value) {
  // Match existing attribution's conservative fallback: malformed authors never
  // gain the authority of the device user or Host.
  const kind = ['user', 'bot', 'host'].includes(value?.kind) ? value.kind : 'bot';
  return {
    kind,
    ...(text(value?.deviceId) ? { deviceId: value.deviceId } : {}),
    ...(kind === 'bot' && text(value?.botId) ? { botId: value.botId } : {}),
    ...(kind === 'host' && HOST_SOURCES.includes(value?.sourceType)
      ? { sourceType: value.sourceType } : {}),
  };
}

function replyTarget(value) {
  if (value?.kind === 'primary') return { kind: 'primary' };
  if ((value?.kind !== 'dm' && value?.kind !== 'room') || text(value.scopeId) === null) return null;
  return {
    kind: value.kind,
    scopeId: value.scopeId,
    ...(value.kind === 'dm' && text(value.botId) ? { botId: value.botId } : {}),
  };
}

/** Business task identity is explicit: a frozen turn.taskId is an SDK task. */
export function normalizeTaskDispatchContext(value) {
  if (value === undefined || value === null) return null;
  if (!record(value)) throw invalid('dispatchContext must be an object');
  const taskId = requiredText(value.taskId, 'dispatchContext.taskId');
  const stepId = value.stepId === undefined || value.stepId === null
    ? null : requiredText(value.stepId, 'dispatchContext.stepId');
  const executionRevision = value.executionRevision ?? 1;
  if (!Number.isSafeInteger(executionRevision) || executionRevision < 0) {
    throw invalid('dispatchContext.executionRevision must be a non-negative safe integer');
  }
  return { taskId, stepId, executionRevision };
}

/**
 * Project one trusted frozen turn. The default event ID is scoped to the Bot in
 * RunContext; a transport may supply its own durable event ID. It is not a run ID.
 * Legacy turns without finer Host source metadata remain source=host.
 */
export function createExecutionEvent({ turn, source, submissionId, dispatchContext, eventId } = {}) {
  if (!record(turn)) throw invalid('turn must be a trusted frozen turn');
  const requestId = requiredText(turn.requestId, 'turn.requestId');
  const author = sender(turn.sender);
  const dispatch = normalizeTaskDispatchContext(dispatchContext);
  const derivedSource = dispatch ? 'task_dispatch'
    : author.kind === 'user' ? 'user'
      : author.kind === 'bot' ? 'peer'
        : author.sourceType ?? 'host';
  if (source !== undefined && !SOURCES.has(source)) throw invalid('unknown execution event source');
  const triggerMessageIds = unique([
    ...(Array.isArray(turn.triggerMessageIds) ? turn.triggerMessageIds.map(text) : []),
    text(turn.triggerMessageId),
  ]);
  return {
    version: 1,
    eventId: eventId === undefined ? `request:${requestId}` : requiredText(eventId, 'eventId'),
    requestId,
    source: source ?? derivedSource,
    channel: CHANNELS.has(turn.kind) ? turn.kind : 'host',
    scopeId: text(turn.scopeId),
    sender: author,
    replyTarget: replyTarget(turn.replyTarget),
    submissionId: nativeId(submissionId, 'submissionId'),
    triggerMessageIds,
    originRequestId: text(turn.originRequestId),
    replyTo: text(turn.replyTo),
    rootId: text(turn.rootId),
    responseMessageId: text(turn.responseMessageId),
    dispatchContext: dispatch,
  };
}

function copyEvent(event) {
  if (!record(event) || event.version !== 1) throw invalid('unsupported execution event');
  return createExecutionEvent({
    turn: { ...event, kind: event.channel },
    source: event.source,
    submissionId: event.submissionId,
    dispatchContext: event.dispatchContext,
    eventId: event.eventId,
  });
}

/**
 * SDK task identity is deliberately named sdkExecutionId. A generation handoff
 * may change it; only a caller-provided persisted runId identifies a wider Run.
 * Steered inputs retain separate event/request IDs within the same SDK execution.
 */
export function createRunContext({ identity, nativeRun, events = [], activeTaskId, runId, status = null } = {}) {
  if (!record(identity)) throw invalid('identity must be a trusted Bot identity');
  if (!Array.isArray(events)) throw invalid('events must be an array');
  if (status !== null && !STATES.has(status)) throw invalid('unknown execution status');
  const deviceId = requiredText(identity.deviceId, 'identity.deviceId');
  const botId = requiredText(identity.botId, 'identity.botId');
  const conversationId = text(identity.conversationId);
  const nativeConversationId = nativeId(identity.nativeConversationId, 'identity.nativeConversationId');
  const nativeTaskId = nativeId(activeTaskId ?? nativeRun?.taskId, 'activeTaskId');
  const projectedEvents = events.map(copyEvent);
  const nativeInputs = Array.isArray(nativeRun?.inputs)
    ? nativeRun.inputs.map((id) => nativeId(id, 'nativeRun.inputs')) : [];
  return {
    version: 1,
    runId: runId === undefined || runId === null ? null : requiredText(runId, 'runId'),
    sdkExecutionId: nativeConversationId === null || nativeTaskId === null
      ? null : `sdk:${JSON.stringify([deviceId, nativeConversationId, nativeTaskId])}`,
    deviceId,
    botId,
    conversationId,
    nativeConversationId,
    nativeTaskId,
    status,
    sourceEventIds: unique(projectedEvents.map((event) => event.eventId)),
    requestIds: unique(projectedEvents.map((event) => event.requestId)),
    submissionIds: unique([...nativeInputs, ...projectedEvents.map((event) => event.submissionId)]),
    events: projectedEvents,
  };
}

/**
 * Execution state only. A stored/acked delivery cannot complete a Run or Task.
 * Terminal submission receipts win over stale waits. A wait is eligible only
 * when its owner has explicitly confirmed live=true and status=pending; a work
 * decision's ordinary pending record is not a suspended execution.
 */
export function projectExecutionState({ submission, admission, wait, failure, accepted = false } = {}) {
  if (submission?.status === 'done') return 'completed';
  if (submission?.status === 'unanswered') {
    return ['cancelled', 'user_stop', 'aborted'].includes(submission.reason) ? 'cancelled' : 'failed';
  }
  if (admission?.phase === 'cancelled') return 'cancelled';
  if (failure || admission?.phase === 'failed') return 'failed';
  const requestId = text(submission?.requestId) ?? text(admission?.requestId);
  if (wait?.live === true && wait.status === 'pending' &&
      (requestId === null || wait.requestId === requestId)) return 'waiting';
  if (submission?.status === 'placed' || submission?.status === 'running') return 'running';
  if (submission?.status === 'queued' || ['queued', 'checking', 'synchronizing'].includes(admission?.phase)) {
    return 'queued';
  }
  if (accepted === true || submission?.status === 'accepted') return 'accepted';
  return null;
}

/** Fresh allowlisted metadata; ignores arbitrary payloads, credentials and output. */
export function projectRunMetadata(context) {
  if (context === undefined || context === null) return null;
  if (!record(context) || context.version !== 1) throw invalid('unsupported run context');
  return createRunContext({
    identity: context,
    runId: context.runId,
    activeTaskId: context.nativeTaskId,
    nativeRun: { inputs: context.submissionIds },
    events: context.events,
    status: context.status,
  });
}
