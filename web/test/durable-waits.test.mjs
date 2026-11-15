import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeWaits } from '../../host-core/runtime-waits.js';
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

async function questionTool(t, { inputKind = 'model', toolCount = 1 } = {}) {
  const LiveDoc = { definition: { kind: 'pi.live' } };
  const calls = [];
  const host = {
    context: {},
    sdk: { defineDoc: definition => ({ definition }), defineTool: definition => definition, LiveDoc },
    getHarness: () => ({ inspect: async () => ({ tasks: [] }) }),
    assertCapabilityAllowed() {},
    waits: { open: async (_botId, input) => {
      calls.push(input);
      return { status: 'pending', details: input.details };
    } },
  };
  const instance = createPlugin({ installationId: 'question-plugin', host });
  const bot = await instance.forBot({ botId: 'alpha' });
  t.after(() => instance.close());
  const api = {
    taskId: 42, conversationId: 12,
    memo: async () => undefined,
    getTask: async () => ({ kind: 'pi.tool', input: { kind: inputKind } }),
    snapshot: async token => token === LiveDoc ? {
      tools: Array.from({ length: toolCount }, (_, i) => ({
        taskId: i === 0 ? 42 : 43, name: i === 0 ? 'ask_user_question' : 'another_tool',
      })),
    } : null,
    details: async () => {},
  };
  return { tool: bot.durableContributions.tools[0], api, calls };
}

test('a sole model-issued questionnaire publishes a durable wait and returns terminate immediately', async t => {
  const { tool, api, calls } = await questionTool(t);
  assert.deepEqual(tool.callers, ['model']);
  const result = await tool.execute({ questions }, api, {});
  assert.equal(calls.length, 1);
  assert.equal(result.details.presentation.status, 'pending');
  assert.deepEqual(result.control, { terminate: true });
});

test('a multi-tool round cannot create a wait that would fail to release the run', async t => {
  const { tool, api, calls } = await questionTool(t, { toolCount: 2 });
  const result = await tool.execute({ questions }, api, {});
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.equal(result.control, undefined);
});

test('a new nested tool invocation cannot create a wait whose control is ignored', async t => {
  const { tool, api, calls } = await questionTool(t, { inputKind: 'nested' });
  const result = await tool.execute({ questions }, api, {});
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('an existing nested questionnaire retains its old live-task protocol during upgrade', async t => {
  const oldDetails = { presentation: {
    kind: 'questionnaire', version: 1, installationId: 'question-plugin',
    conversationId: 12, requestId: '42', status: 'pending', questions,
  }, questions };
  const oldRecord = { status: 'pending', params: { questions }, details: oldDetails };
  const nestedTask = { id: 42, kind: 'pi.tool', conversationId: 12,
    input: { kind: 'nested', call: { name: 'ask_user_question' } } };
  let newWaitCalls = 0;
  const host = {
    context: {},
    sdk: { defineDoc: definition => ({ definition }), defineTool: definition => definition },
    getHarness: () => ({
      inspect: async () => ({ tasks: [{ record: nestedTask }] }),
      snapshot: async () => oldRecord,
    }),
    resolveConversationBot: async () => 'alpha', assertCapabilityAllowed() {},
    waits: { open() { newWaitCalls += 1; throw new Error('legacy request must not be republished'); } },
  };
  const instance = createPlugin({ installationId: 'question-plugin', host });
  const bot = await instance.forBot({ botId: 'alpha' });
  t.after(() => instance.close());
  const tool = bot.durableContributions.tools[0];
  assert.deepEqual(tool.callers, ['model', 'tools']);
  const result = await tool.execute({ questions }, {
    taskId: 42, conversationId: 12, memo: async () => 'open',
    watchDoc: async () => ({ value: { ...oldRecord, status: 'answered',
      result: { answers: [], cancelled: true } }, stop: async () => {} }),
  }, {});
  assert.equal(newWaitCalls, 0);
  assert.equal(result.control, undefined);
  assert.match(result.output[0].text, /declined/);
});
