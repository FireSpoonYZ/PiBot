// Durable external waits belong to the Host, not to a live SDK tool invocation.
// A questionnaire may release its run and still be answered after a restart.
// The answer-to-continuation handoff uses the existing TurnQueue's idempotency
// and stop fence; this module does not own a second execution queue.
import { createHash } from 'node:crypto';
import { defineDocFamily } from '@earendil-works/pi-durable';

export const DurableWait = defineDocFamily({
  kind: 'host.durable-wait', version: 1, scope: 'session', family: true,
  initial: () => ({ version: 1, record: null }), checkpointWhen: () => false,
});
export const DurableWaitIndex = defineDocFamily({
  kind: 'host.durable-wait-index', version: 1, scope: 'session', family: true,
  initial: () => ({ version: 1, active: {}, stoppedScopes: {} }), checkpointWhen: () => false,
});

const MAX_ACTIVE_WAITS = 64;
const RETRY_MS = 5000;
const RECEIPT_STATES = new Set(['queued', 'placed', 'done', 'unanswered']);
const TERMINAL_RECEIPT_STATES = new Set(['done', 'unanswered']);
const ACTIVE_RESUME_STATES = new Set(['pending', 'accepted', 'cancelling']);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }

function identity(input) {
  if (!isObject(input) || typeof input.installationId !== 'string' || !input.installationId ||
      input.installationId.length > 200 || !Number.isSafeInteger(input.conversationId) || input.conversationId < 1 ||
      typeof input.requestId !== 'string' || !/^[1-9][0-9]*$/.test(input.requestId) || input.requestId.length > 64) {
    throw failure('INVALID_ARGUMENT', 'Invalid durable wait identity.');
  }
  return { installationId: input.installationId, conversationId: input.conversationId, requestId: input.requestId };
}

function receiptAccepted(value, botId, conversationId, requestId) {
  if (!isObject(value) || value.botId !== botId || value.conversationId !== conversationId ||
      value.requestId !== requestId || !RECEIPT_STATES.has(value.status)) return false;
  if (Number.isSafeInteger(value.submissionId) && value.submissionId > 0) return true;
  return value.submissionId === null && (value.status === 'queued' ||
    (value.status === 'unanswered' && value.reason === 'cancelled'));
}

/**
 * captureContext(botId, api, context) returns a trusted frozen
 * { turn, dispatchContext, stopEpoch }. No client-provided routing is accepted.
 * submitContinuation receives that unchanged context and the original fence.
 * Its admission transaction must reject a wait that is no longer user-answered
 * with resume.state=pending|accepted: scope cancellation has no global epoch.
 * cancelContinuation resolves only after that exact request is cancelled or
 * confirmed absent/terminal. It must be idempotent and work while offline.
 * getSubmission returns null only for a definitively absent request.
 * Call reconcile() after stop epochs have been restored and the Host is ready.
 */
export function createRuntimeWaits({
  host, getHarness, context, getStopEpoch, captureContext, getSubmission,
  submitContinuation,
  cancelContinuation = async () => { throw failure('INVALID_STATE', 'Continuation cancellation is unavailable.'); },
  onChange = () => {}, canResume = () => true,
}) {
  const pumping = new Map();
  const cancelling = new Map();
  const timers = new Map();
  let closed = false;

  function owner(botId, requireActive = false) {
    const bot = host.getBot(botId);
    if (!bot || (requireActive && bot.archivedAt) || bot.deviceId !== host.deviceId) {
      throw failure('BOT_CONTEXT_REQUIRED', 'Durable wait Bot is unavailable.');
    }
    return bot;
  }

  function keyFor(bot, input) {
    return createHash('sha256').update(JSON.stringify([
      bot.primaryConversationId, input.installationId, input.conversationId, input.requestId,
    ])).digest('hex');
  }

  function changed(botId) {
    // Projection refresh is advisory; a failed observer cannot undo a durable
    // answer or turn a successful first answer into a rejected action.
    try { Promise.resolve(onChange(botId)).catch(() => {}); } catch { /* observer only */ }
  }

  function assertActive() {
    if (closed) throw failure('RUNTIME_CLOSED', 'Durable waits are closed.');
  }

  async function get(botId, input, ctx = context) {
    const bot = owner(botId);
    const id = identity(input);
    const value = await getHarness().snapshot(DurableWait, keyFor(bot, id), ctx);
    const record = value?.record;
    if (!record || record.botId !== botId || record.installationId !== id.installationId ||
        record.conversationId !== id.conversationId || record.requestId !== id.requestId) return null;
    return copy(record);
  }

  async function open(botId, input, api, ctx = context) {
    assertActive();
    // Capture synchronously before resolving any task/conversation identity.
    const epoch = getStopEpoch(botId);
    if (!validEpoch(epoch)) throw failure('INVALID_STATE', 'Stop fence is unavailable.');
    const bot = owner(botId, true);
    const id = identity({ ...input, conversationId: api.conversationId });
    if (String(api.taskId) !== id.requestId) throw failure('BOT_CONTEXT_REQUIRED', 'Wait must belong to its tool task.');
    const captured = await captureContext(botId, api, ctx);
    if (!captured?.turn?.requestId || captured.stopEpoch !== epoch) {
      throw failure('WAIT_CANCELLED', 'The originating run was stopped or its context is unavailable.');
    }
    const frozen = copy({ turn: captured.turn, dispatchContext: captured.dispatchContext ?? null });
    const waitId = keyFor(bot, id);
    const params = copy(input.params);
    const details = copy(input.details);
    let result;
    await api.commit(async (tx) => {
      if (getStopEpoch(botId) !== epoch) throw failure('WAIT_CANCELLED', 'The originating run was stopped.');
      const doc = await tx.doc(DurableWait, waitId, {});
      if (doc.record) {
        if (doc.record.botId !== botId || JSON.stringify(doc.record.params) !== JSON.stringify(params)) {
          throw failure('INVALID_STATE', 'Durable wait identity already has different questions.');
        }
        result = copy(doc.record);
        return;
      }
      const index = await tx.doc(DurableWaitIndex, bot.primaryConversationId, {});
      if (frozen.turn.scopeId && index.stoppedScopes?.['s:' + frozen.turn.scopeId] === true) {
        throw failure('WAIT_CANCELLED', 'The originating scope was stopped.');
      }
      if (Object.keys(index.active).length >= MAX_ACTIVE_WAITS) {
        throw failure('WAIT_LIMIT', 'Resolve an existing questionnaire before opening another one.');
      }
      // Re-read the synchronous fence after document acquisition as well: Stop
      // can begin while tx.doc awaits without waiting for this transaction.
      if (getStopEpoch(botId) !== epoch) throw failure('WAIT_CANCELLED', 'The originating run was stopped.');
      const record = {
        version: 1, kind: 'questionnaire', waitId, botId, ...id,
        toolTaskId: api.taskId, sourceRequestId: frozen.turn.requestId,
        stopEpoch: epoch, ...frozen, status: 'pending', params, details,
        createdAt: Date.now(), resumeRequestId: `wait-${waitId.slice(0, 40)}`,
        resume: null,
      };
      doc.record = record;
      index.active[waitId] = id;
      result = copy(record);
    }, ctx);
    changed(botId);
    return result;
  }

  function stopped(record) {
    return record.stopEpoch !== getStopEpoch(record.botId);
  }

  function cancelRecord(record) {
    const hasContinuation = ACTIVE_RESUME_STATES.has(record.resume?.state);
    record.status = 'cancelled';
    record.reason = 'stopped';
    record.settledAt ??= Date.now();
    record.resume = { ...(record.resume ?? {}), state: hasContinuation ? 'cancelling' : 'cancelled' };
    const result = { answers: [], cancelled: true };
    record.result = result;
    record.details = {
      ...record.details,
      presentation: { ...record.details.presentation, status: 'cancelled', result },
    };
  }

  async function answer(botId, input, resolveAnswer, ctx = context) {
    assertActive();
    const bot = owner(botId, true);
    const id = identity(input);
    const waitId = keyFor(bot, id);
    const result = await getHarness().commit(async (tx) => {
      const doc = await tx.doc(DurableWait, waitId, {});
      const record = doc.record;
      if (!record || record.botId !== botId || record.status !== 'pending') return { status: 'settled' };
      const index = await tx.doc(DurableWaitIndex, bot.primaryConversationId, {});
      if (stopped(record)) {
        cancelRecord(record);
        delete index.active[waitId];
        return { status: 'settled' };
      }
      // resolveAnswer is a synchronous validator/formatter over stored questions.
      // The first valid answer wins in this same transaction.
      const answer = resolveAnswer(copy(record));
      if (!isObject(answer) || !isObject(answer.result) || !isObject(answer.details) ||
          typeof answer.text !== 'string' || !answer.text || typeof answer?.then === 'function') {
        throw failure('INVALID_ARGUMENT', 'Invalid durable wait answer.');
      }
      record.status = answer.result.cancelled === true ? 'cancelled' : 'answered';
      record.reason = 'user';
      record.result = copy(answer.result);
      record.details = copy(answer.details);
      record.settledAt = Date.now();
      record.resume = {
        state: 'pending',
        input: { requestId: record.resumeRequestId, text: answer.text },
      };
      return { status: record.status };
    }, ctx);
    changed(botId);
    nudge(botId);
    return result;
  }

  async function list(botId, ctx = context) {
    const bot = owner(botId);
    const index = await getHarness().snapshot(DurableWaitIndex, bot.primaryConversationId, ctx);
    const result = [];
    for (const waitId of Object.keys(index?.active ?? {})) {
      const record = (await getHarness().snapshot(DurableWait, waitId, ctx))?.record;
      if (record?.botId === botId) result.push(copy(record));
    }
    return result;
  }

  function finishCancellation(botId, waitId, ctx = context) {
    // Scope Stop, full Bot Stop and the recovery pump can all encounter the
    // same intent. Join locally; after restart the callback remains idempotent.
    if (cancelling.has(waitId)) return cancelling.get(waitId);
    const work = (async () => {
      const bot = owner(botId);
      const candidate = (await getHarness().snapshot(DurableWait, waitId, ctx))?.record;
      if (candidate?.botId !== botId || candidate.resume?.state !== 'cancelling') return;
      await cancelContinuation(botId, candidate.resumeRequestId, ctx);
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(DurableWait, waitId, {});
        if (doc.record?.botId !== botId || doc.record.resume?.state !== 'cancelling') return;
        const index = await tx.doc(DurableWaitIndex, bot.primaryConversationId, {});
        doc.record.resume = { ...doc.record.resume, state: 'cancelled', cancelledAt: Date.now() };
        delete index.active[waitId];
      }, ctx);
      changed(botId);
    })().finally(() => cancelling.delete(waitId));
    cancelling.set(waitId, work);
    return work;
  }

  // Transaction-only marking is shared with history fork/switch. Do not call
  // Harness, observers or cancellation callbacks while the caller owns its
  // transaction: a failed fork must roll back the waiting records with it.
  async function markMatchingInTransaction(botId, matches, tx, stopScopeId = null) {
    const bot = owner(botId);
    const pending = [];
    const index = await tx.doc(DurableWaitIndex, bot.primaryConversationId, {});
    // One transaction closes both sides of publish-vs-Stop: a question
    // already present is cancelled below, and a later publisher sees this
    // gate. Only explicit user resume removes it, including after restart.
    if (stopScopeId !== null) (index.stoppedScopes ??= {})['s:' + stopScopeId] = true;
    for (const waitId of Object.keys(index.active)) {
      const doc = await tx.doc(DurableWait, waitId, {});
      const record = doc.record;
      if (!record || record.botId !== botId) { delete index.active[waitId]; continue; }
      if (matches(record)) {
        cancelRecord(record);
        // Keep cancellation intent reachable until the precise Host request
        // has been cancelled. A lost callback response is retried on reopen.
        if (record.resume.state === 'cancelling') pending.push(waitId);
        else delete index.active[waitId];
      }
    }
    return pending;
  }

  async function cancelConversationInTransaction(botId, conversationId, tx) {
    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      throw failure('INVALID_ARGUMENT', 'Invalid native wait conversation.');
    }
    return markMatchingInTransaction(botId, record => record.conversationId === conversationId, tx);
  }

  async function cancelMatching(botId, matches, ctx, stopScopeId = null) {
    const pending = await getHarness().commit(
      tx => markMatchingInTransaction(botId, matches, tx, stopScopeId), ctx,
    );
    changed(botId);
    const errors = [];
    for (const waitId of pending) {
      try { await finishCancellation(botId, waitId, ctx); }
      catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      retry(botId);
      throw errors[0];
    }
  }

  async function cancelBot(botId, boundary, ctx = context) {
    if (!validEpoch(boundary)) throw failure('INVALID_ARGUMENT', 'Invalid stop boundary.');
    await cancelMatching(botId, record => record.stopEpoch <= boundary, ctx);
  }

  async function cancelScope(botId, scopeId, ctx = context) {
    if (typeof scopeId !== 'string' || !scopeId.trim()) throw failure('INVALID_ARGUMENT', 'Invalid wait scope.');
    await cancelMatching(botId, record => record.turn?.scopeId === scopeId, ctx, scopeId);
  }

  async function resumeScope(botId, scopeId, ctx = context) {
    assertActive();
    if (typeof scopeId !== 'string' || !scopeId.trim()) throw failure('INVALID_ARGUMENT', 'Invalid wait scope.');
    const bot = owner(botId, true);
    await getHarness().commit(async (tx) => {
      const index = await tx.doc(DurableWaitIndex, bot.primaryConversationId, {});
      if (index.stoppedScopes) delete index.stoppedScopes['s:' + scopeId];
    }, ctx);
    // Old records remain cancelled; clearing the gate permits only a new wait.
    changed(botId);
  }

  async function pump(botId) {
    if (closed) return;
    const bot = owner(botId);
    const candidates = await list(botId);
    const cancellationErrors = [];
    // Attempt every persisted cancellation before any new admission. One
    // failed request must not starve cancellation of unrelated scopes.
    for (const candidate of candidates) {
      if (closed) return;
      // A durable cancel is local cleanup, including on archived Bots; it must
      // not wait for the Center connection or ordinary execution readiness.
      if (candidate.resume?.state === 'cancelling') {
        try { await finishCancellation(botId, candidate.waitId); }
        catch (error) { cancellationErrors.push(error); }
      }
    }
    if (cancellationErrors.length > 0) throw cancellationErrors[0];
    for (const candidate of candidates) {
      if (closed) return;
      if (candidate.resume?.state === 'cancelling') continue;
      if (bot.archivedAt || !canResume()) continue;
      if (stopped(candidate)) {
        await cancelBot(botId, getStopEpoch(botId) - 1);
        continue;
      }
      if (!['pending', 'accepted'].includes(candidate.resume?.state) || candidate.status === 'pending') continue;
      // A restart always begins with reconciliation. Missing is a literal null;
      // malformed or failed lookups never authorize a speculative submission.
      let receipt = await getSubmission(botId, candidate.resumeRequestId, context);
      if (closed || !canResume()) return;
      if (receipt === null && candidate.resume.state === 'pending') {
        if (stopped(candidate)) { await cancelBot(botId, getStopEpoch(botId) - 1); continue; }
        // Avoid needless submissions after a cancellation that completed while
        // the lookup was in flight. The enqueue transaction must still enforce
        // the same guard to close the remaining read-to-admission race.
        const current = (await getHarness().snapshot(DurableWait, candidate.waitId, context))?.record;
        if (current?.botId !== botId || current.reason !== 'user' || current.resume?.state !== 'pending') continue;
        if (closed || !canResume()) return;
        receipt = await submitContinuation(botId, {
          ...candidate.resume.input,
          stopEpoch: candidate.stopEpoch,
          turn: copy(candidate.turn), dispatchContext: copy(candidate.dispatchContext),
          waitId: candidate.waitId,
        }, context);
      }
      if (!receiptAccepted(receipt, botId, bot.primaryConversationId, candidate.resumeRequestId)) continue;
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(DurableWait, candidate.waitId, {});
        const record = doc.record;
        if (!['pending', 'accepted'].includes(record?.resume?.state) || record.reason !== 'user') return;
        const index = await tx.doc(DurableWaitIndex, bot.primaryConversationId, {});
        if (stopped(record)) cancelRecord(record);
        else {
          record.resume = { ...record.resume, state: 'accepted',
            acceptedAt: record.resume.acceptedAt ?? Date.now(), receiptStatus: receipt.status };
          // Retain accepted work while queued/running so scope Stop can find
          // and cancel its continuation. Accepted lookup-missing is never a
          // license to submit again; only a terminal receipt retires the index.
          if (TERMINAL_RECEIPT_STATES.has(receipt.status)) {
            record.resume.finishedAt = Date.now();
            delete index.active[candidate.waitId];
          }
        }
      }, context);
      changed(botId);
    }
  }

  function retry(botId) {
    if (closed || timers.has(botId)) return;
    const timer = setTimeout(() => {
      timers.delete(botId);
      nudge(botId);
    }, RETRY_MS);
    timer.unref?.();
    timers.set(botId, timer);
  }

  function reconcileOne(botId) {
    if (pumping.has(botId)) return pumping.get(botId);
    const promise = pump(botId).finally(async () => {
      pumping.delete(botId);
      if (!closed) {
        try {
          if ((await list(botId)).some(record => ACTIVE_RESUME_STATES.has(record.resume?.state))) retry(botId);
        } catch { /* a later explicit reconcile can reopen unavailable storage */ }
      }
    });
    pumping.set(botId, promise);
    return promise;
  }

  function nudge(botId) {
    if (closed) return;
    reconcileOne(botId).catch(() => retry(botId));
  }

  async function reconcile(botId) {
    assertActive();
    if (botId !== undefined) return reconcileOne(botId);
    for (const bot of host.listBots()) {
      if (bot.deviceId === host.deviceId) await reconcileOne(bot.botId);
    }
  }

  /** Startup barrier: await persisted cancellations before resuming the SDK or
      nudging admission. This never looks up or submits a pending/accepted
      continuation, does not depend on Center connectivity, and reports errors
      to the caller instead of allowing startup to proceed past them. */
  async function recoverCancellations(botId) {
    assertActive();
    const bots = botId !== undefined ? [owner(botId)]
      : host.listBots().filter(bot => bot.deviceId === host.deviceId);
    const errors = [];
    for (const bot of bots) {
      assertActive();
      let records;
      try { records = await list(bot.botId); }
      catch (error) { errors.push(error); continue; }
      for (const record of records) {
        if (record.resume?.state !== 'cancelling') continue;
        assertActive();
        try { await finishCancellation(bot.botId, record.waitId); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length > 0) throw errors[0];
  }

  async function getPresentation(botId, details, ctx = context) {
    const p = details?.presentation;
    if (p?.kind !== 'questionnaire') return null;
    let record;
    try { record = await get(botId, p, ctx); }
    catch (error) { if (error?.code === 'INVALID_ARGUMENT') return null; throw error; }
    if (!record) return null;
    if (stopped(record) && record.status === 'pending') {
      const transient = copy(record);
      cancelRecord(transient);
      return { details: transient.details, live: false, status: 'cancelled', waitId: record.waitId };
    }
    return { details: record.details, live: record.status === 'pending' && !stopped(record),
      status: record.status, waitId: record.waitId };
  }

  async function overlayDetails(botId, details, ctx = context) {
    return (await getPresentation(botId, details, ctx))?.details ?? details;
  }

  async function close() {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    await Promise.allSettled([...pumping.values(), ...cancelling.values()]);
  }

  return { open, get, answer, list, cancelBot, cancelScope, resumeScope,
    cancelConversationInTransaction, recoverCancellations,
    reconcile, getPresentation, overlayDetails, close };
}
