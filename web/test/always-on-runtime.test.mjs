import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createScheduleManager } from '../../host-core/host-schedules.js';
import {
  createExecutionEvent,
  createRunContext,
  normalizeTaskDispatchContext,
  projectExecutionState,
  projectRunMetadata,
} from '../../host-core/runtime-execution-context.js';

const OWNER = { deviceId: 'device-a', botId: 'bot-a', conversationId: 'primary-a' };
const BOT = { botId: OWNER.botId, primaryConversationId: OWNER.conversationId };
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = 'schedule-occurrence-1';
const FROZEN_TEXT = 'Scheduled task; not an authenticated human message original occurrence';

function occurrence(overrides = {}) {
  return {
    id: RUN_ID, taskId: TASK_ID, revision: 1, occurrence: Date.now() - 1000,
    requestId: REQUEST_ID, owner: { ...OWNER }, prompt: 'old occurrence', skills: [],
    status: 'dispatching', submitted: false, deleteAfterRun: false,
    handoff: {
      version: 1, state: 'pending', stopEpoch: 7,
      input: { requestId: REQUEST_ID, text: FROZEN_TEXT },
    },
    ...overrides,
  };
}

function receipt(status, extra = {}) {
  return { botId: OWNER.botId, conversationId: OWNER.conversationId,
    requestId: REQUEST_ID, submissionId: 91, status, ...extra };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, message) {
  // The driver is promise-based; yield the event loop without waiting for its
  // production retry timer. Tests explicitly call notifyOnline for retries.
  for (let attempts = 0; attempts < 40; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), message);
}

function fixture(t, runs = [occurrence()]) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'always-on-schedule-'));
  const dbPath = join(dataRoot, 'schedules.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE state(id INTEGER NOT NULL PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL)');
  database.prepare('INSERT INTO state(id, version, json) VALUES(1, 1, ?)').run(JSON.stringify({
    version: 1,
    tasks: [{ id: TASK_ID, revision: 2, owner: { ...OWNER }, title: 'edited definition',
      prompt: 'new definition must not replace the occurrence', skills: ['new-skill'],
      enabled: false, nextRunAt: 0, repeat: 'daily', time: '09:00' }],
    runs,
    schedulingError: '', timeZone: 'UTC',
  }));
  database.close();
  const managers = [];
  const host = { dataRoot, deviceId: OWNER.deviceId,
    getBot: (botId) => botId === BOT.botId ? BOT : null };
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.close()));
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    open(runtime) {
      const manager = createScheduleManager({ host, getRuntime: () => runtime, isOnline: () => true });
      managers.push(manager);
      manager.start();
      return manager;
    },
    readRun() {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return JSON.parse(db.prepare('SELECT json FROM state WHERE id = 1').get().json).runs[0]; }
      finally { db.close(); }
    },
  };
}

function fencedRuntime(overrides = {}) {
  return {
    getScheduleFence() { throw new Error('A recovered handoff must never recapture its fence'); },
    submit() { throw new Error('A recovered handoff must use the internal fenced admission'); },
    submitScheduled() { throw new Error('Unexpected resubmission'); },
    getSubmission() { return null; },
    ...overrides,
  };
}

for (const crashPoint of ['armed-before-send', 'claimed-before-send']) {
  test(`schedule recovery: ${crashPoint} first reconciles and preserves input and stop epoch`, async (t) => {
    const state = crashPoint === 'claimed-before-send'
      ? { status: 'unconfirmed', submitted: true } : {};
    const f = fixture(t, [occurrence(state)]);
    const calls = [];
    f.open(fencedRuntime({
      getSubmission(botId, requestId) { calls.push(['lookup', botId, requestId]); return null; },
      submitScheduled(botId, input) {
        calls.push(['submit', botId, structuredClone(input)]);
        return receipt('done');
      },
    }));
    await until(() => f.readRun().status === 'done', 'recovered occurrence did not settle');
    assert.deepEqual(calls, [
      ['lookup', BOT.botId, REQUEST_ID],
      ['submit', BOT.botId, { requestId: REQUEST_ID, text: FROZEN_TEXT, stopEpoch: 7 }],
    ]);
    assert.equal(f.readRun().handoff.state, 'accepted');
    assert.equal(f.readRun().handoff.stopEpoch, 7);
  });
}

test('schedule recovery: lost acceptance response reconciles the durable receipt without another submission', async (t) => {
  const f = fixture(t);
  let accepted = null;
  let submissions = 0;
  const runtime = fencedRuntime({
    getSubmission() { return accepted; },
    submitScheduled() {
      submissions += 1;
      accepted = receipt('done');
      throw Object.assign(new Error('response lost after durable acceptance'), { code: 'CONNECTION_LOST' });
    },
  });
  const first = f.open(runtime);
  await until(() => submissions === 1 && f.readRun().status === 'unconfirmed', 'first attempt did not reach the lost response');
  await first.close();
  assert.equal(f.readRun().handoff.state, 'pending');
  f.open(runtime);
  await until(() => f.readRun().status === 'done', 'reconciliation did not recover the accepted receipt');
  assert.equal(submissions, 1);
});

test('schedule recovery: a frozen old stop epoch reaches admission unchanged and closes as cancelled', async (t) => {
  const f = fixture(t);
  let receivedEpoch;
  f.open(fencedRuntime({
    submitScheduled(_botId, input) {
      receivedEpoch = input.stopEpoch;
      // Admission owns stop fencing; the scheduler must not acquire epoch 8
      // merely because a stopped occurrence is being reconciled after restart.
      assert.equal(input.stopEpoch, 7);
      return receipt('unanswered', { submissionId: null, reason: 'cancelled' });
    },
  }));
  await until(() => f.readRun().status === 'unanswered', 'stale occurrence did not settle');
  assert.equal(receivedEpoch, 7);
  assert.equal(f.readRun().submissionId, null);
  assert.equal(f.readRun().handoff.state, 'accepted');
});

test('schedule recovery: queued receipt with null native ID remains accepted even if a later lookup is missing', async (t) => {
  const f = fixture(t);
  let lookups = 0;
  let submissions = 0;
  const runtime = fencedRuntime({
    getSubmission() { lookups += 1; return null; },
    submitScheduled() { submissions += 1; return receipt('queued', { submissionId: null }); },
  });
  const first = f.open(runtime);
  await until(() => f.readRun().status === 'queued', 'Host-only queued receipt was not accepted');
  const acceptedAt = f.readRun().handoff.acceptedAt;
  await first.close();
  const second = f.open(runtime);
  await until(() => lookups === 2 && f.readRun().status === 'unconfirmed', 'restart did not query the accepted occurrence');
  second.notifyOnline();
  await until(() => lookups === 3, 'follow-up lookup did not occur');
  assert.equal(submissions, 1);
  assert.equal(f.readRun().handoff.state, 'accepted');
  assert.equal(f.readRun().handoff.acceptedAt, acceptedAt);
});

for (const evidence of [{ submissionId: 19 }, { submissionId: null, submissionStatus: 'queued' }]) {
  test(`schedule recovery: legacy acceptance evidence ${JSON.stringify(evidence)} prevents retry`, async (t) => {
    const f = fixture(t, [occurrence({ status: 'unconfirmed', submitted: true, ...evidence })]);
    let lookups = 0;
    let submissions = 0;
    const manager = f.open(fencedRuntime({
      getSubmission() { lookups += 1; return null; },
      submitScheduled() { submissions += 1; return receipt('done'); },
    }));
    await until(() => lookups === 1, 'legacy receipt was not reconciled');
    await new Promise((resolve) => setImmediate(resolve));
    manager.notifyOnline();
    await until(() => lookups === 2, 'legacy receipt was not queried again');
    assert.equal(submissions, 0);
  });
}

test('schedule recovery: unarmed offline occurrence is skipped, ambiguous legacy occurrence is query-only', async (t) => {
  const unarmed = fixture(t, [occurrence({ handoff: undefined })]);
  let unarmedCalls = 0;
  unarmed.open(fencedRuntime({
    getScheduleFence() { unarmedCalls += 1; return { ...OWNER, stopEpoch: 8 }; },
    getSubmission() { unarmedCalls += 1; return null; },
  }));
  assert.equal(unarmed.readRun().status, 'skipped_offline');
  assert.equal(unarmedCalls, 0);

  const legacy = fixture(t, [occurrence({ handoff: undefined, status: 'unconfirmed', submitted: true })]);
  let lookups = 0;
  let submissions = 0;
  const manager = legacy.open(fencedRuntime({
    getSubmission() { lookups += 1; return null; },
    submitScheduled() { submissions += 1; return receipt('done'); },
  }));
  await until(() => lookups === 1, 'legacy attempt was not reconciled');
  await new Promise((resolve) => setImmediate(resolve));
  manager.notifyOnline();
  await until(() => lookups === 2, 'legacy attempt did not stay query-only');
  assert.equal(legacy.readRun().status, 'unconfirmed');
  assert.equal(submissions, 0);
});

test('schedule recovery: malformed or unavailable receipts do not grant permission to resubmit', async (t) => {
  const f = fixture(t);
  const responses = [undefined, {}, receipt('queued', { submissionId: undefined }),
    receipt('done', { requestId: 'another-occurrence' }),
    Object.assign(new Error('query transport unavailable'), { code: 'NOT_CONNECTED' })];
  let lookups = 0;
  let submissions = 0;
  const manager = f.open(fencedRuntime({
    getSubmission() {
      const result = responses[lookups++];
      if (result instanceof Error) throw result;
      return result;
    },
    submitScheduled() { submissions += 1; return receipt('done'); },
  }));
  for (let index = 0; index < responses.length; index += 1) {
    if (index > 0) manager.notifyOnline();
    await until(() => lookups === index + 1, 'query attempt did not occur');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.readRun().status, 'unconfirmed');
    assert.equal(f.readRun().handoff.state, 'pending');
    assert.equal(submissions, 0);
  }
});

test('schedule recovery: a transport failure before acceptance retries only after a fresh missing lookup', async (t) => {
  const f = fixture(t);
  const calls = [];
  let attempts = 0;
  const manager = f.open(fencedRuntime({
    getSubmission() { calls.push('lookup'); return null; },
    submitScheduled() {
      calls.push('submit');
      if (++attempts === 1) throw Object.assign(new Error('socket unavailable'), { code: 'NOT_CONNECTED' });
      return receipt('done');
    },
  }));
  await until(() => attempts === 1 && f.readRun().status === 'unconfirmed', 'initial failure was not persisted');
  manager.notifyOnline();
  await until(() => f.readRun().status === 'done', 'retry failed to settle');
  assert.deepEqual(calls, ['lookup', 'submit', 'lookup', 'submit']);
});

test('schedule recovery: delete during an in-flight lookup prevents a late receipt from reviving the occurrence', async (t) => {
  const f = fixture(t);
  const query = deferred();
  const manager = f.open(fencedRuntime({ getSubmission() { return query.promise; } }));
  await manager.deleteBot(BOT);
  assert.equal(f.readRun().status, 'skipped_offline');
  query.resolve(receipt('done'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.readRun().status, 'skipped_offline');
  assert.equal(f.readRun().reason, 'task_deleted');
  assert.equal(f.readRun().handoff.state, 'pending');
});

function event(overrides = {}) {
  return createExecutionEvent({ turn: {
    requestId: 'request-a', kind: 'primary', sender: { kind: 'user', deviceId: OWNER.deviceId },
    replyTarget: { kind: 'primary' }, taskId: 1234, ...overrides,
  } });
}

test('execution identity: SDK task identity never becomes a business task or a fabricated stable run ID', () => {
  const input = event();
  assert.equal(input.dispatchContext, null);
  const identity = { ...OWNER, nativeConversationId: 22 };
  const first = createRunContext({ identity, nativeRun: { taskId: 31, inputs: [41] }, events: [input] });
  const handedOff = createRunContext({ identity, nativeRun: { taskId: 32, inputs: [41] }, events: [input] });
  assert.equal(first.runId, null);
  assert.equal(handedOff.runId, null);
  assert.notEqual(first.sdkExecutionId, handedOff.sdkExecutionId);
  assert.equal(first.events[0].dispatchContext, null);
  assert.deepEqual(normalizeTaskDispatchContext({ taskId: 'business-task', stepId: 'step-2', executionRevision: 3 }),
    { taskId: 'business-task', stepId: 'step-2', executionRevision: 3 });
  assert.throws(() => normalizeTaskDispatchContext({ taskId: 1234 }), { code: 'INVALID_ARGUMENT' });
});

test('execution identity: steering preserves all input identities, routes and explicit business context', () => {
  const peer = createExecutionEvent({
    turn: { requestId: 'peer-request', kind: 'room', scopeId: 'room-a',
      sender: { kind: 'bot', botId: 'bot-b', deviceId: 'device-b' },
      replyTarget: { kind: 'room', scopeId: 'room-a' },
      triggerMessageIds: ['message-a', 'message-b'], triggerMessageId: 'message-a' },
    submissionId: 42,
    dispatchContext: { taskId: 'business-task', stepId: 'step-2' },
  });
  const result = createRunContext({
    identity: { ...OWNER, nativeConversationId: 22 }, runId: 'persisted-run',
    nativeRun: { taskId: 31, inputs: [41, 42, 43] }, events: [event(), peer], status: 'running',
  });
  assert.deepEqual(result.requestIds, ['request-a', 'peer-request']);
  assert.deepEqual(result.sourceEventIds, ['request:request-a', 'request:peer-request']);
  assert.deepEqual(result.submissionIds, [41, 42, 43]);
  assert.deepEqual(result.events[1].replyTarget, { kind: 'room', scopeId: 'room-a' });
  assert.deepEqual(result.events[1].triggerMessageIds, ['message-a', 'message-b']);
  assert.equal(result.events[1].source, 'task_dispatch');
  assert.equal(result.events[1].dispatchContext.taskId, 'business-task');
});

test('execution metadata: payloads and credentials cannot leak through the allowlisted projection', () => {
  const result = createRunContext({ identity: { ...OWNER, nativeConversationId: 22 }, events: [event()] });
  result.token = 'secret-token';
  result.events[0].text = 'private-prompt';
  result.events[0].sender.credential = 'private-key';
  const projected = projectRunMetadata(result);
  assert.doesNotMatch(JSON.stringify(projected), /secret-token|private-prompt|private-key/);
  projected.events[0].replyTarget.kind = 'changed';
  assert.equal(result.events[0].replyTarget.kind, 'primary');
  assert.equal(event({ sender: { kind: 'untrusted-role' }, replyTarget: { kind: 'unknown' } }).sender.kind, 'bot');
  assert.equal(event({ replyTarget: { kind: 'room' } }).replyTarget, null);
});

test('execution states: transport acceptance, queueing, waiting and task completion remain distinct', () => {
  assert.equal(projectExecutionState({ delivery: { status: 'acked' } }), null);
  assert.equal(projectExecutionState({ accepted: true }), 'accepted');
  assert.equal(projectExecutionState({ submission: { status: 'queued' } }), 'queued');
  const running = { status: 'placed', requestId: 'request-a' };
  assert.equal(projectExecutionState({ submission: running, wait: { status: 'pending', requestId: 'request-a' } }), 'running');
  assert.equal(projectExecutionState({ submission: running, wait: { live: true, status: 'pending', requestId: 'another' } }), 'running');
  assert.equal(projectExecutionState({ submission: running, wait: { live: true, status: 'pending', requestId: 'request-a' } }), 'waiting');
  assert.equal(projectExecutionState({ submission: running, wait: { live: true, status: 'answered', requestId: 'request-a' } }), 'running');
  const staleWait = { live: true, status: 'pending', requestId: 'request-a' };
  assert.equal(projectExecutionState({ submission: { ...running, status: 'done' }, wait: staleWait }), 'completed');
  assert.equal(projectExecutionState({ submission: { ...running, status: 'unanswered', reason: 'cancelled' }, wait: staleWait }), 'cancelled');
  assert.equal(projectExecutionState({ admission: { phase: 'cancelled', requestId: 'request-a' }, wait: staleWait }), 'cancelled');
  assert.equal(projectExecutionState({ submission: { ...running, status: 'unanswered', reason: 'model_error' } }), 'failed');
});
