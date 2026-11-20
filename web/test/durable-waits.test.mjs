import assert from 'node:assert/strict';
import test from 'node:test';
import { canDetachPrimaryWait, createRuntimeWaits } from '../../host-core/runtime-waits.js';
import { createPlugin } from '../../plugins/ask-user-question/entry.js';

// A transactional store shared by successive factory instances. These tests
// exercise the Host handoff state machine. Actual run release also requires
// integration verification with the pinned Durable runtime.
function memoryHarness() {
  let documents = new Map();
  let line = Promise.resolve();
  const address = (token, key) => `${token.definition.kind}:${key}`;
  const harness = {
    commit(change) {
      const next = line.then(async () => {
        const draft = structuredClone(documents);
        const result = await change({
          async doc(token, key) {
            const id = address(token, key);
            if (!draft.has(id)) draft.set(id, token.definition.initial());
            return draft.get(id);
          },
        });
        documents = draft;
        return result;
      });
      line = next.catch(() => {});
      return next;
    },
    async snapshot(token, key) {
      await line;
      return structuredClone(documents.get(address(token, key)) ?? null);
    },
  };
  return harness;
}

const questions = [{
  question: 'Which result should be published?', header: 'Result',
  options: [{ label: 'A', description: 'First result' }, { label: 'B', description: 'Second result' }],
}];

function fixture(t, overrides = {}) {
  const harness = memoryHarness();
  const bots = [
    { botId: 'alpha', deviceId: 'device', primaryConversationId: 'primary-alpha' },
    { botId: 'beta', deviceId: 'device', primaryConversationId: 'primary-beta' },
  ];
  const host = { deviceId: 'device', getBot: id => bots.find(bot => bot.botId === id), listBots: () => bots };
  const identity = { installationId: 'question-plugin', conversationId: 12, requestId: '42' };
  const details = { presentation: { kind: 'questionnaire', version: 1, ...identity, status: 'pending', questions }, questions };
  const state = { epoch: 4, ready: false, submissions: new Map(), sent: [], cancelledRequests: [] };
  const source = { turn: {
    requestId: 'peer-request', kind: 'dm', scopeId: 'scope-a',
    replyTarget: { kind: 'dm', scopeId: 'scope-a', botId: 'peer' },
    sender: { kind: 'bot', botId: 'peer', deviceId: 'other-device' },
  }, dispatchContext: { taskId: 'global-task', stepId: 'step-a', executionRevision: 2 } };
  const dependencies = {
    host, getHarness: () => harness, context: {}, getStopEpoch: () => state.epoch,
    captureContext: async () => ({ ...source, stopEpoch: state.epoch }),
    getSubmission: async (_botId, requestId) => state.submissions.get(requestId) ?? null,
    submitContinuation: async (botId, input) => {
      state.sent.push(structuredClone(input));
      const receipt = { botId, conversationId: host.getBot(botId).primaryConversationId,
        requestId: input.requestId, submissionId: null,
        status: input.stopEpoch === state.epoch ? 'queued' : 'unanswered',
        reason: input.stopEpoch === state.epoch ? null : 'cancelled' };
      state.submissions.set(input.requestId, receipt);
      return receipt;
    },
    cancelContinuation: async (_botId, requestId) => {
      state.cancelledRequests.push(requestId);
      const receipt = state.submissions.get(requestId);
      if (receipt) state.submissions.set(requestId, { ...receipt, status: 'unanswered', reason: 'cancelled' });
    },
    canResume: () => state.ready,
    ...overrides,
  };
  let waits = createRuntimeWaits(dependencies);
  t.after(() => waits.close());
  const api = { taskId: 42, conversationId: 12, commit: (change) => harness.commit(change) };
  return {
    state, source, identity, details, dependencies, harness,
    get waits() { return waits; },
    open(requestId = identity.requestId, scopeId = source.turn.scopeId, conversationId = identity.conversationId) {
      source.turn.scopeId = scopeId;
      source.turn.replyTarget.scopeId = scopeId;
      const currentDetails = { ...details, presentation: { ...details.presentation, requestId, conversationId } };
      return waits.open('alpha', { ...identity, requestId, conversationId, params: { questions }, details: currentDetails },
        { ...api, taskId: Number(requestId), conversationId });
    },
    answer: (text = 'Approved result A') => waits.answer('alpha', identity, () => ({
      result: { answers: [{ questionIndex: 0, answer: 'A' }], cancelled: false },
      details: { ...details, presentation: { ...details.presentation, status: 'answered' } }, text,
    })),
    async reopen() { await waits.close(); waits = createRuntimeWaits(dependencies); },
  };
}

test('durable wait survives tool completion and restart, then resumes its frozen task and route', async t => {
  const f = fixture(t);
  const opened = await f.open();
  f.source.turn.replyTarget.scopeId = 'changed-later';
  f.source.dispatchContext.taskId = 'another-task';
  await f.reopen();
  assert.equal((await f.waits.getPresentation('alpha', f.details)).live, true);
  assert.deepEqual(await f.answer(), { status: 'answered' });
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 1);
  const resumed = f.state.sent[0];
  assert.equal(resumed.stopEpoch, 4);
  assert.equal(resumed.turn.replyTarget.scopeId, 'scope-a');
  assert.equal(resumed.dispatchContext.taskId, 'global-task');
  assert.equal(resumed.requestId, opened.resumeRequestId);
  assert.equal((await f.waits.list('alpha')).length, 1, 'accepted work stays reachable for scope Stop');
  f.state.submissions.set(resumed.requestId, { ...f.state.submissions.get(resumed.requestId),
    status: 'done', submissionId: 91 });
  await f.waits.reconcile('alpha');
  assert.equal((await f.waits.list('alpha')).length, 0, 'a terminal receipt retires only the activity index');
  const presentation = await f.waits.getPresentation('alpha', f.details);
  assert.equal(presentation.live, false);
  assert.equal(presentation.status, 'answered');
});

test('answer is durable before admission and the first answer wins across retries', async t => {
  const f = fixture(t);
  await f.open();
  const answers = await Promise.all([f.answer('first'), f.answer('second')]);
  assert.deepEqual(answers, [{ status: 'answered' }, { status: 'settled' }]);
  await f.reopen();
  const record = await f.waits.get('alpha', f.identity);
  assert.equal(record.resume.input.text, 'first');
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0].text, 'first');
});

test('lost acceptance response reconciles the same request after restart without repeating the effect', async t => {
  const f = fixture(t);
  const original = f.dependencies.submitContinuation;
  f.dependencies.submitContinuation = async (...args) => {
    await original(...args);
    throw Object.assign(new Error('response lost'), { code: 'NOT_CONNECTED' });
  };
  // The factory captures injected functions, so install this failing transport
  // by reopening before the first submission.
  await f.reopen();
  await f.open();
  await f.answer();
  f.state.ready = true;
  await assert.rejects(f.waits.reconcile('alpha'), /response lost/);
  assert.equal(f.state.sent.length, 1);
  await f.reopen();
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 1);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'accepted');
  assert.equal((await f.waits.list('alpha')).length, 1);
});

test('accepted queued receipt with no native id never becomes permission to submit again', async t => {
  const f = fixture(t);
  await f.open();
  await f.answer();
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  f.state.submissions.clear();
  await f.reopen();
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 1);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'accepted');
  assert.equal((await f.waits.list('alpha')).length, 1, 'missing lookup must retain accepted work for cancellation');
});

test('Stop invalidates an unanswered question and late answers cannot revive it', async t => {
  const f = fixture(t);
  await f.open();
  f.state.epoch = 5;
  assert.deepEqual(await f.answer(), { status: 'settled' });
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 0);
  const projected = await f.waits.getPresentation('alpha', f.details);
  assert.equal(projected.status, 'cancelled');
  assert.equal(projected.live, false);
});

test('Stop between durable answer and continuation admission cancels the handoff', async t => {
  const f = fixture(t);
  await f.open();
  await f.answer();
  f.state.epoch = 5;
  await f.waits.cancelBot('alpha', 4);
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 0);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelled');
});

test('a malformed lookup is not proof of absence and cannot authorize continuation submission', async t => {
  const f = fixture(t, { getSubmission: async () => ({}) });
  await f.open();
  await f.answer();
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, 0);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'pending');
});

test('wait identities are Bot-scoped and a forged cross-Bot answer is inert', async t => {
  const f = fixture(t);
  await f.open();
  assert.equal(await f.waits.get('beta', f.identity), null);
  assert.equal(await f.waits.getPresentation('beta', f.details), null);
  const result = await f.waits.answer('beta', f.identity, () => { throw new Error('must not resolve'); });
  assert.deepEqual(result, { status: 'settled' });
  assert.equal((await f.waits.get('alpha', f.identity)).status, 'pending');
});

test('Stop racing capture prevents a newly published wait', async t => {
  const f = fixture(t);
  f.dependencies.captureContext = async () => {
    f.state.epoch += 1;
    return { ...f.source, stopEpoch: f.state.epoch };
  };
  await f.reopen();
  await assert.rejects(f.open(), error => error.code === 'WAIT_CANCELLED');
  assert.deepEqual(await f.waits.list('alpha'), []);
});

test('archived Bot waits remain readable and cancellable, but cannot accept answers', async t => {
  const f = fixture(t);
  await f.open();
  f.dependencies.host.getBot('alpha').archivedAt = '2026-11-15T00:00:00.000Z';
  assert.equal((await f.waits.getPresentation('alpha', f.details)).status, 'pending');
  await assert.rejects(f.answer(), error => error.code === 'BOT_CONTEXT_REQUIRED');
  await f.waits.cancelBot('alpha', 4);
  assert.equal((await f.waits.getPresentation('alpha', f.details)).status, 'cancelled');
});

test('scope Stop cancels only its frozen scope and leaves other waits answerable', async t => {
  const f = fixture(t);
  await f.open('42', 'scope-a');
  await f.open('43', 'scope-b');
  await f.waits.cancelScope('alpha', 'scope-a');
  assert.equal((await f.waits.get('alpha', f.identity)).status, 'cancelled');
  const other = { ...f.identity, requestId: '43' };
  assert.equal((await f.waits.get('alpha', other)).status, 'pending');
  assert.deepEqual((await f.waits.list('alpha')).map(record => record.requestId), ['43']);
  assert.deepEqual(f.state.cancelledRequests, [], 'pure unanswered waits have no continuation to cancel');
  assert.deepEqual(await f.answer(), { status: 'settled' });
});

test('scope Stop precisely cancels an accepted continuation before retiring its wait index', async t => {
  const f = fixture(t);
  const opened = await f.open();
  await f.answer();
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'accepted');
  await f.waits.cancelScope('alpha', 'scope-a');
  assert.deepEqual(f.state.cancelledRequests, [opened.resumeRequestId]);
  assert.equal(f.state.submissions.get(opened.resumeRequestId).reason, 'cancelled');
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelled');
  assert.equal((await f.waits.list('alpha')).length, 0);
  assert.equal(f.state.epoch, 4, 'scope Stop does not advance the Bot-wide stop epoch');
});

test('scope Stop during receipt lookup cannot resurrect the answered wait', async t => {
  let releaseLookup;
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const lookup = new Promise(resolve => { releaseLookup = resolve; });
  const f = fixture(t, { getSubmission: async () => { lookupStarted(); return lookup; } });
  await f.open();
  await f.answer();
  await f.waits.reconcile('alpha');
  f.state.ready = true;
  const pumping = f.waits.reconcile('alpha');
  await started;
  try { await f.waits.cancelScope('alpha', 'scope-a'); }
  finally { releaseLookup(null); }
  await pumping;
  assert.equal(f.state.sent.length, 0);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelled');
  assert.equal((await f.waits.list('alpha')).length, 0);
});

test('a lost cancellation response stays durable and retries after restart while offline', async t => {
  const f = fixture(t);
  const original = f.dependencies.cancelContinuation;
  f.dependencies.cancelContinuation = async (...args) => {
    await original(...args);
    throw Object.assign(new Error('cancel response lost'), { code: 'NOT_CONNECTED' });
  };
  await f.reopen();
  const opened = await f.open();
  await f.answer();
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  await assert.rejects(f.waits.cancelScope('alpha', 'scope-a'), /cancel response lost/);
  const cancelled = await f.waits.get('alpha', f.identity);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.resume.state, 'cancelling');
  assert.equal((await f.waits.list('alpha')).length, 1, 'failed cancellation remains discoverable');
  f.dependencies.cancelContinuation = original;
  f.state.ready = false;
  await f.reopen();
  await f.waits.reconcile('alpha');
  assert.deepEqual(f.state.cancelledRequests, [opened.resumeRequestId, opened.resumeRequestId]);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelled');
  assert.equal((await f.waits.list('alpha')).length, 0);
  assert.equal(f.state.sent.length, 1);
});

test('scope publication gate survives restart, and explicit resume permits only new waits', async t => {
  const f = fixture(t);
  await f.open();
  await f.waits.cancelScope('alpha', 'scope-a');
  await f.reopen();
  await assert.rejects(f.open('43', 'scope-a'), error => error.code === 'WAIT_CANCELLED');
  assert.deepEqual(await f.answer(), { status: 'settled' });
  await f.waits.resumeScope('alpha', 'scope-a');
  const newWait = await f.open('43', 'scope-a');
  assert.equal(newWait.status, 'pending');
  assert.equal((await f.waits.get('alpha', f.identity)).status, 'cancelled');
  assert.deepEqual(await f.answer(), { status: 'settled' }, 'resume never reopens a cancelled question');
});

test('history fork and native-conversation wait cancellation commit or roll back together', async t => {
  let changes = 0;
  const f = fixture(t, { onChange() { changes += 1; } });
  await f.open('42', 'scope-a', 12);
  await f.open('43', 'scope-a', 34);
  const primary = { definition: { kind: 'test.primary-index', initial: () => ({ nativeId: 12 }) } };
  await f.harness.commit(async tx => { await tx.doc(primary, 'primary-alpha'); });
  const baseline = changes;
  await assert.rejects(f.harness.commit(async tx => {
    await f.waits.cancelConversationInTransaction('alpha', 12, tx);
    const index = await tx.doc(primary, 'primary-alpha');
    index.nativeId = 34;
    throw new Error('fork commit failed');
  }), /fork commit failed/);
  assert.equal((await f.harness.snapshot(primary, 'primary-alpha')).nativeId, 12);
  assert.equal((await f.waits.get('alpha', f.identity)).status, 'pending');
  assert.equal((await f.waits.list('alpha')).length, 2);
  assert.equal(changes, baseline, 'transaction-only helper cannot notify observers before commit');
  assert.deepEqual(f.state.cancelledRequests, []);

  await f.harness.commit(async tx => {
    await f.waits.cancelConversationInTransaction('alpha', 12, tx);
    const index = await tx.doc(primary, 'primary-alpha');
    index.nativeId = 34;
  });
  assert.equal((await f.harness.snapshot(primary, 'primary-alpha')).nativeId, 34);
  assert.equal((await f.waits.get('alpha', f.identity)).status, 'cancelled');
  assert.equal((await f.waits.get('alpha', { ...f.identity, requestId: '43', conversationId: 34 })).status, 'pending');
  assert.deepEqual((await f.waits.list('alpha')).map(record => record.requestId), ['43']);
  assert.equal(changes, baseline);
  assert.deepEqual(f.state.cancelledRequests, []);
});

test('cancellation recovery drains fork cancellation without looking up or admitting another resume', async t => {
  let lookups = 0;
  let changes = 0;
  const f = fixture(t, {
    getSubmission: async () => { lookups += 1; return null; },
    onChange() { changes += 1; },
  });
  const old = await f.open('42', 'scope-a', 12);
  await f.answer();
  await f.open('43', 'scope-b', 34);
  const other = { ...f.identity, requestId: '43', conversationId: 34 };
  await f.waits.answer('alpha', other, record => ({
    result: { answers: [], cancelled: true },
    details: { ...record.details, presentation: { ...record.details.presentation, status: 'cancelled' } },
    text: 'Declined the other questionnaire',
  }));
  await f.waits.reconcile('alpha');
  const baseline = changes;
  await f.harness.commit(tx => f.waits.cancelConversationInTransaction('alpha', 12, tx));
  assert.equal(changes, baseline);
  assert.deepEqual(f.state.cancelledRequests, [], 'marking inside the fork transaction cannot perform cancellation');
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelling');
  assert.equal((await f.waits.get('alpha', other)).resume.state, 'pending');
  f.state.ready = true;
  await f.reopen();
  await f.waits.recoverCancellations();
  assert.deepEqual(f.state.cancelledRequests, [old.resumeRequestId]);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelled');
  assert.equal((await f.waits.get('alpha', other)).resume.state, 'pending');
  assert.equal(f.state.sent.length, 0);
  assert.equal(lookups, 0, 'startup cancellation barrier must not run ordinary reconciliation');
});

test('cancellation recovery reports incomplete cancellation and can retry an archived Bot while offline', async t => {
  const f = fixture(t);
  const confirmedCancel = f.dependencies.cancelContinuation;
  f.dependencies.cancelContinuation = async () => {
    throw Object.assign(new Error('exact request cancellation incomplete'), { code: 'CANCEL_INCOMPLETE' });
  };
  await f.reopen();
  const opened = await f.open();
  await f.answer();
  await f.waits.reconcile('alpha');
  await f.harness.commit(tx => f.waits.cancelConversationInTransaction('alpha', 12, tx));
  await assert.rejects(f.waits.recoverCancellations('alpha'), error => error.code === 'CANCEL_INCOMPLETE');
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelling');
  assert.equal((await f.waits.list('alpha')).length, 1);
  f.dependencies.cancelContinuation = confirmedCancel;
  f.dependencies.host.getBot('alpha').archivedAt = '2026-11-15T00:00:00.000Z';
  await f.reopen();
  await f.waits.recoverCancellations();
  assert.equal(f.state.ready, false);
  assert.deepEqual(f.state.cancelledRequests, [opened.resumeRequestId]);
  assert.equal((await f.waits.list('alpha')).length, 0);
  assert.equal(f.state.sent.length, 0);
});

async function questionTool(t, {
  inputKind = 'model',
  toolCount = 1,
  openResult = undefined,
  existingWait = null,
  existingRequest = null,
  initialPhase = undefined,
  watchAnswer = null,
  withWaits = true,
} = {}) {
  const LiveDoc = { definition: { kind: 'pi.live' } };
  const calls = [];
  const memos = new Map();
  if (initialPhase !== undefined) memos.set('ask-user-question.phase', initialPhase);
  let requestDoc = existingRequest ? structuredClone(existingRequest) : null;
  let commitCount = 0;
  const publishedDetails = [];
  const host = {
    context: {},
    sdk: { defineDoc: definition => ({ definition }), defineTool: definition => definition, LiveDoc },
    getHarness: () => ({ inspect: async () => ({ tasks: [] }) }),
    assertCapabilityAllowed() {},
    ...(withWaits ? {
      waits: {
        get: async () => existingWait ? structuredClone(existingWait) : null,
        open: async (_botId, input) => {
          calls.push(input);
          if (openResult !== undefined) return openResult;
          return { status: 'pending', params: input.params, details: input.details };
        },
      },
    } : {}),
  };
  const instance = createPlugin({ installationId: 'question-plugin', host });
  const bot = await instance.forBot({ botId: 'alpha' });
  t.after(() => instance.close());
  const api = {
    taskId: 42, conversationId: 12,
    async memo(key, value) {
      if (arguments.length >= 3 || (arguments.length === 2 && typeof value === 'string')) {
        memos.set(key, value);
        return value;
      }
      return memos.get(key);
    },
    getTask: async () => ({ kind: 'pi.tool', input: { kind: inputKind } }),
    snapshot: async token => {
      if (token === LiveDoc) {
        return {
          tools: Array.from({ length: toolCount }, (_, i) => ({
            taskId: i === 0 ? 42 : 43, name: i === 0 ? 'ask_user_question' : 'another_tool',
          })),
        };
      }
      return requestDoc ? structuredClone(requestDoc) : null;
    },
    commit: async (fn) => {
      commitCount += 1;
      const draft = requestDoc ? structuredClone(requestDoc) : {
        version: 1,
        status: 'settled',
        params: { questions: [] },
        details: { presentation: { kind: 'questionnaire', version: 1 }, questions: [] },
      };
      await fn({
        task: async () => ({
          id: 42, kind: 'pi.tool', conversationId: 12,
          abortRequested: false, state: { status: 'running' },
        }),
        doc: async () => draft,
      });
      requestDoc = draft;
    },
    watchDoc: async () => {
      const value = watchAnswer
        ? {
            ...(requestDoc ?? { params: { questions } }),
            status: watchAnswer.cancelled ? 'cancelled' : 'answered',
            result: {
              ...watchAnswer,
              answers: watchAnswer.answers.map(answer => ({
                question: questions[answer.questionIndex].question,
                kind: 'option',
                ...answer,
              })),
            },
          }
        : structuredClone(requestDoc);
      return {
        value,
        closed: new Promise(() => {}),
        start() {},
        stop: async () => {},
      };
    },
    details: async (d) => { publishedDetails.push(structuredClone(d)); },
  };
  return {
    tool: bot.durableContributions.tools[0],
    api, calls, memos, publishedDetails,
    get requestDoc() { return requestDoc; },
    get commitCount() { return commitCount; },
  };
}

test('canDetachPrimaryWait strictly admits only unscoped non-task-dispatch primary turns without workNativeId', () => {
  const basePrimary = {
    requestId: 'req-1', kind: 'primary', scopeId: null,
    replyTarget: { kind: 'primary' },
    sender: { kind: 'user', deviceId: 'device' },
  };
  assert.equal(canDetachPrimaryWait(basePrimary, null), true);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, sender: { kind: 'host', sourceType: 'schedule' } }, null), true);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, sender: { kind: 'host', sourceType: 'webhook' } }, null), true);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, originRequestId: 'req-0', sender: { kind: 'host' } }, undefined), true);

  assert.equal(canDetachPrimaryWait(null, null), false);
  assert.equal(canDetachPrimaryWait(undefined, null), false);
  assert.equal(canDetachPrimaryWait(basePrimary, { taskId: 'global-task', stepId: 's1', executionRevision: 1 }), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, sender: { kind: 'host', sourceType: 'task_dispatch' } }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, workNativeId: 7 }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, scopeId: 'room-1' }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, kind: 'dm', scopeId: 'dm-1', replyTarget: { kind: 'dm', scopeId: 'dm-1', botId: 'peer' } }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, kind: 'room', scopeId: 'room-1', replyTarget: { kind: 'room', scopeId: 'room-1' } }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, replyTarget: { kind: 'room', scopeId: 'room-1' } }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, replyTarget: { kind: 'primary', scopeId: 'room-1' } }, null), false);
  assert.equal(canDetachPrimaryWait({ ...basePrimary, replyTarget: null }, null), false);
});

test('open with canDetach returns null and writes no wait for out-of-scope turns while keeping Stop fencing', async t => {
  let changes = 0;
  const f = fixture(t, { canDetach: canDetachPrimaryWait, onChange() { changes += 1; } });

  // Fixture defaults to a DM + task dispatch source -> out of scope.
  assert.equal(await f.open('42', 'scope-a', 12), null);
  assert.deepEqual(await f.waits.list('alpha'), []);
  assert.equal(await f.waits.get('alpha', f.identity), null);
  assert.equal(changes, 0);

  // Scoped room without dispatchContext -> still out of scope.
  f.source.dispatchContext = null;
  f.source.turn = {
    requestId: 'room-req', kind: 'room', scopeId: 'room-1',
    replyTarget: { kind: 'room', scopeId: 'room-1' },
    sender: { kind: 'user', deviceId: 'device' },
  };
  assert.equal(await f.open('43', 'room-1', 12), null);

  // Primary with task dispatchContext -> out of scope.
  f.source.turn = {
    requestId: 'task-req', kind: 'primary', scopeId: null,
    replyTarget: { kind: 'primary' },
    sender: { kind: 'host', sourceType: 'webhook', deviceId: 'device' },
  };
  f.source.dispatchContext = { taskId: 'global-task', stepId: 'step-1', executionRevision: 1 };
  assert.equal(await f.open('44', null, 12), null);

  // Primary late work-reply carrying workNativeId -> out of scope.
  f.source.dispatchContext = null;
  f.source.turn = {
    requestId: 'late-work-reply', kind: 'primary', scopeId: null, workNativeId: 9,
    replyTarget: { kind: 'primary' },
    sender: { kind: 'host', deviceId: 'device' },
  };
  assert.equal(await f.open('45', null, 12), null);

  // Non-primary conversation returning { turn: null } without Stop -> out of scope (returns null).
  f.dependencies.captureContext = async () => ({ turn: null, dispatchContext: null, stopEpoch: f.state.epoch });
  await f.reopen();
  assert.equal(await f.open('46', null, 12), null);
  assert.deepEqual(await f.waits.list('alpha'), []);
  assert.equal(changes, 0);

  // Actual Stop race must still throw WAIT_CANCELLED rather than silently falling back.
  f.dependencies.captureContext = async () => {
    f.state.epoch += 1;
    return { turn: null, dispatchContext: null, stopEpoch: f.state.epoch };
  };
  await f.reopen();
  await assert.rejects(f.open('47', null, 12), error => error.code === 'WAIT_CANCELLED');
  assert.deepEqual(await f.waits.list('alpha'), []);

  // Eligible unscoped primary without dispatchContext or workNativeId -> persists detached wait.
  f.dependencies.captureContext = async () => ({
    turn: {
      requestId: 'primary-req', kind: 'primary', scopeId: null,
      replyTarget: { kind: 'primary' },
      sender: { kind: 'user', deviceId: 'device' },
    },
    dispatchContext: null,
    stopEpoch: f.state.epoch,
  });
  await f.reopen();
  const opened = await f.open('48', null, 12);
  assert.equal(opened?.status, 'pending');
  assert.equal((await f.waits.list('alpha')).length, 1);
  assert.equal(changes, 1);
});

test('existing experimental unsupported waits are safely retired offline and never submitted or re-admitted', async t => {
  // Seed experimental waits using an unrestricted instance (pre-compatibility state).
  const f = fixture(t);
  // 1) Pending DM wait
  const dmId = { ...f.identity, requestId: '42' };
  await f.open('42', 'scope-dm', 12);

  // 2) Answered room wait already accepted into TurnQueue (resume.state = 'accepted')
  const roomAcceptedId = { ...f.identity, requestId: '43' };
  f.source.dispatchContext = null;
  f.source.turn = {
    requestId: 'room-req-1', kind: 'room', scopeId: 'room-1',
    replyTarget: { kind: 'room', scopeId: 'room-1' },
    sender: { kind: 'user', deviceId: 'device' },
  };
  const roomAccepted = await f.open('43', 'room-1', 12);
  await f.waits.answer('alpha', roomAcceptedId, record => ({
    result: { answers: [{ questionIndex: 0, answer: 'B' }], cancelled: false },
    details: { ...record.details, presentation: { ...record.details.presentation, status: 'answered' } },
    text: 'Room answer already accepted',
  }));
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal((await f.waits.get('alpha', roomAcceptedId)).resume.state, 'accepted');
  const sentBeforeUpgrade = f.state.sent.length;
  assert.equal(sentBeforeUpgrade, 1);

  // 3) Answered task-dispatch wait still waiting for admission (resume.state = 'pending')
  f.state.ready = false;
  const taskPendingId = { ...f.identity, requestId: '44' };
  f.source.turn = {
    requestId: 'task-req-1', kind: 'primary', scopeId: null,
    replyTarget: { kind: 'primary' },
    sender: { kind: 'host', sourceType: 'webhook', deviceId: 'device' },
  };
  f.source.dispatchContext = { taskId: 'global-task', stepId: 'step-1', executionRevision: 1 };
  const taskPending = await f.open('44', null, 12);
  await f.waits.answer('alpha', taskPendingId, record => ({
    result: { answers: [{ questionIndex: 0, answer: 'A' }], cancelled: false },
    details: { ...record.details, presentation: { ...record.details.presentation, status: 'answered' } },
    text: 'Task answer before restart',
  }));
  assert.equal((await f.waits.get('alpha', taskPendingId)).resume.state, 'pending');

  // Reopen offline with strict deployed eligibility (canDetachPrimaryWait).
  let lookups = 0;
  const origGetSubmission = f.dependencies.getSubmission;
  f.dependencies.canDetach = canDetachPrimaryWait;
  f.dependencies.getSubmission = async (...args) => { lookups += 1; return origGetSubmission(...args); };
  f.state.ready = false;
  await f.reopen();

  // Projection never marks unsupported records as live; late answer cancels & stays inert.
  const dmDetails = { ...f.details, presentation: { ...f.details.presentation, requestId: '42' } };
  const projected = await f.waits.getPresentation('alpha', dmDetails);
  assert.equal(projected.live, false);
  assert.equal(projected.status, 'cancelled');

  let resolveCalled = false;
  assert.deepEqual(await f.waits.answer('alpha', dmId, () => {
    resolveCalled = true;
    throw new Error('unsupported wait must not resolve');
  }), { status: 'settled' });
  assert.equal(resolveCalled, false);
  assert.equal((await f.waits.get('alpha', dmId)).status, 'cancelled');

  // Offline cancellation recovery cancels accepted/pending unsupported continuations
  // without looking up or submitting anything.
  await f.waits.recoverCancellations();
  assert.equal(lookups, 0, 'offline recovery must not look up submissions');
  assert.equal(f.state.sent.length, sentBeforeUpgrade, 'unsupported waits must never submit');
  assert.ok(f.state.cancelledRequests.includes(taskPending.resumeRequestId));
  assert.ok(f.state.cancelledRequests.includes(roomAccepted.resumeRequestId));
  assert.equal((await f.waits.get('alpha', taskPendingId)).resume.state, 'cancelled');
  assert.equal((await f.waits.get('alpha', roomAcceptedId)).resume.state, 'cancelled');
  assert.deepEqual(await f.waits.list('alpha'), []);

  // Even if reconcile runs online afterwards, nothing re-admits.
  f.state.ready = true;
  await f.waits.reconcile('alpha');
  assert.equal(f.state.sent.length, sentBeforeUpgrade);
});

test('unsupported experimental wait retries offline cancellation after error and rechecks canDetach before submission', async t => {
  const f = fixture(t);
  let allowDetach = true;
  f.dependencies.canDetach = () => allowDetach;
  await f.reopen();

  const opened = await f.open('42', 'scope-a', 12);
  await f.answer('Answer while temporarily allowed');

  // Flip eligibility while getSubmission is in flight: reconcile must recheck
  // canDetach right before submitContinuation and cancel instead of submitting.
  let releaseLookup;
  const origCancel = f.dependencies.cancelContinuation;
  let failCancelOnce = true;
  f.dependencies.getSubmission = async () => new Promise(resolve => {
    allowDetach = false;
    releaseLookup = resolve;
    queueMicrotask(() => releaseLookup(null));
  });
  f.dependencies.cancelContinuation = async (...args) => {
    if (failCancelOnce) {
      failCancelOnce = false;
      throw Object.assign(new Error('offline cancel error'), { code: 'CANCEL_INCOMPLETE' });
    }
    return origCancel(...args);
  };
  await f.reopen();
  allowDetach = true;
  f.state.ready = true;
  await assert.rejects(f.waits.reconcile('alpha'), error => error.code === 'CANCEL_INCOMPLETE');
  assert.equal(f.state.sent.length, 0, 'pre-submit canDetach recheck must prevent submission');
  const cancelling = await f.waits.get('alpha', f.identity);
  assert.equal(cancelling.status, 'cancelled');
  assert.equal(cancelling.resume.state, 'cancelling');
  assert.equal((await f.waits.list('alpha')).length, 1);

  // Subsequent offline recovery finishes cancelling and retires the record.
  f.state.ready = false;
  await f.waits.recoverCancellations('alpha');
  assert.deepEqual(f.state.cancelledRequests, [opened.resumeRequestId]);
  assert.equal((await f.waits.get('alpha', f.identity)).resume.state, 'cancelled');
  assert.deepEqual(await f.waits.list('alpha'), []);
});

test('a sole model-issued questionnaire publishes a durable wait and returns terminate immediately', async t => {
  const { tool, api, calls, memos } = await questionTool(t);
  assert.equal(tool.callers, undefined, 'SDK default [model, tools] callers must remain preserved');
  const result = await tool.execute({ questions }, api, {});
  assert.equal(calls.length, 1);
  assert.equal(memos.get('ask-user-question.phase'), 'deferred');
  assert.equal(result.details.presentation.status, 'pending');
  assert.deepEqual(result.control, { terminate: true });
});

test('out-of-scope standalone questionnaire falls back to live-task protocol when waits.open returns null', async t => {
  const q = await questionTool(t, {
    openResult: null,
    watchAnswer: { answers: [{ questionIndex: 0, answer: 'A' }], cancelled: false },
  });
  const result = await q.tool.execute({ questions }, q.api, {});
  assert.equal(q.calls.length, 1);
  assert.equal(q.memos.get('ask-user-question.phase'), 'open');
  assert.equal(result.isError, undefined);
  assert.equal(result.control, undefined);
  assert.match(result.output[0].text, /A/);
  assert.doesNotMatch(result.output[0].text, /execution is paused|Bot is free/i);
  assert.equal(q.requestDoc?.status, 'pending');
});

test('a multi-tool round preserves live-task fallback without creating a durable wait', async t => {
  const { tool, api, calls, memos } = await questionTool(t, {
    toolCount: 2,
    watchAnswer: { answers: [{ questionIndex: 0, answer: 'B' }], cancelled: false },
  });
  const result = await tool.execute({ questions }, api, {});
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 0);
  assert.equal(memos.get('ask-user-question.phase'), 'open');
  assert.equal(result.control, undefined);
  assert.match(result.output[0].text, /B/);
  assert.doesNotMatch(result.output[0].text, /execution is paused|Bot is free/i);
});

test('a nested or codemode-only tool invocation preserves live-task fallback without creating a durable wait', async t => {
  const { tool, api, calls, memos } = await questionTool(t, {
    inputKind: 'nested',
    watchAnswer: { answers: [{ questionIndex: 0, answer: 'A' }], cancelled: false },
  });
  assert.equal(tool.callers, undefined, 'nested/codemode callers must remain enabled');
  const result = await tool.execute({ questions }, api, {});
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 0);
  assert.equal(memos.get('ask-user-question.phase'), 'open');
  assert.equal(result.control, undefined);
  assert.match(result.output[0].text, /A/);
  assert.doesNotMatch(result.output[0].text, /execution is paused|Bot is free/i);
});

test('existing in-flight open and deferred replays remain coherent and idempotent across memo boundaries', async t => {
  const oldDetails = { presentation: {
    kind: 'questionnaire', version: 1, installationId: 'question-plugin',
    conversationId: 12, requestId: '42', status: 'pending', questions,
  }, questions };
  const oldRecord = { status: 'pending', params: { questions }, details: oldDetails };

  // 1) Pre-upgrade/in-flight 'open' memo stays on live-task path without calling waits.open.
  const openReplay = await questionTool(t, {
    inputKind: 'nested',
    initialPhase: 'open',
    existingRequest: oldRecord,
    watchAnswer: { answers: [], cancelled: true },
  });
  const openResult = await openReplay.tool.execute({ questions }, openReplay.api, {});
  assert.equal(openReplay.calls.length, 0);
  assert.equal(openResult.control, undefined);
  assert.match(openResult.output[0].text, /declined/);

  // 2) Pre-memo committed Request doc (crash before memo('open')) stays on live-task path.
  const preMemoOpen = await questionTool(t, {
    inputKind: 'model',
    toolCount: 1,
    existingRequest: oldRecord,
    watchAnswer: { answers: [{ questionIndex: 0, answer: 'A' }], cancelled: false },
  });
  const preMemoOpenResult = await preMemoOpen.tool.execute({ questions }, preMemoOpen.api, {});
  assert.equal(preMemoOpen.calls.length, 0);
  assert.equal(preMemoOpen.memos.get('ask-user-question.phase'), 'open');
  assert.equal(preMemoOpenResult.control, undefined);
  assert.match(preMemoOpenResult.output[0].text, /A/);

  // 3) Replayed 'deferred' memo reads existing DurableWait idempotently without writing Request.
  const deferredReplay = await questionTool(t, {
    initialPhase: 'deferred',
    existingWait: { status: 'cancelled', reason: 'stopped', params: { questions }, details: {
      ...oldDetails, presentation: { ...oldDetails.presentation, status: 'cancelled' },
    } },
  });
  const deferredResult = await deferredReplay.tool.execute({ questions }, deferredReplay.api, {});
  assert.equal(deferredReplay.calls.length, 0);
  assert.equal(deferredReplay.commitCount, 0);
  assert.deepEqual(deferredResult.control, { terminate: true });
  assert.equal(deferredResult.details.presentation.status, 'cancelled');
  assert.match(deferredResult.output[0].text, /cancelled/i);

  // 4) Pre-memo committed DurableWait (crash between waits.open and memo('deferred')) stays deferred.
  const preMemoDeferred = await questionTool(t, {
    existingWait: { status: 'pending', params: { questions }, details: oldDetails },
  });
  const preMemoDeferredResult = await preMemoDeferred.tool.execute({ questions }, preMemoDeferred.api, {});
  assert.equal(preMemoDeferred.calls.length, 0);
  assert.equal(preMemoDeferred.commitCount, 0);
  assert.equal(preMemoDeferred.memos.get('ask-user-question.phase'), 'deferred');
  assert.deepEqual(preMemoDeferredResult.control, { terminate: true });
});
