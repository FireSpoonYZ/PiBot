import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDesktopPetController,
  projectPetCards,
  projectPetMessages,
  projectPetTranscript,
  resolvePetMascotState,
} from '../../desktop/web/src/pet/controller.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
const history = (id, role, text, kind = 'pi.message', extra = {}) => ({
  id,
  kind,
  messages: [{ role, text }],
  ...extra,
});
const idle = () => ({
  busy: false, queuedCount: 0, tools: [], history: [history(1, 'assistant', 'Earlier reply')],
  lastEntryId: 1,
  generation: null,
  activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
});

function harness(options = {}) {
  const calls = [];
  const watches = [];
  let listener = () => {};
  const bots = [
    { deviceId: 'remote-device', botId: 'remote-main', role: 'Remote', isPrimary: true, online: true },
    { deviceId: 'local-device', botId: 'local-main', role: 'Local', isPrimary: true, online: true },
  ];
  const api = {
    identity: { profileId: 'center', kind: 'relay', targetDeviceId: 'remote-device', generation: 1 },
    transportConnected: true,
    subscribe(fn) { listener = fn; return () => { listener = () => {}; }; },
    identityForTarget(targetDeviceId) { return { ...this.identity, targetDeviceId }; },
    async broker(identity, op) {
      calls.push({ identity, op });
      assert.equal(op, 'bot_directory');
      return { bots, devices: [], errors: [] };
    },
    observe(identity, target, callback) {
      const watch = { identity, target, callback, closed: 0 };
      watches.push(watch);
      if (options.onObserve) {
        options.onObserve(watch);
      } else {
        const state = options.initialState?.() ?? idle();
        queueMicrotask(() => callback({ frame: { type: 'snapshot', botId: target.botId, state } }));
      }
      return { ready: Promise.resolve(), async close() { watch.closed++; } };
    },
    async pending(identity, op, params) {
      calls.push({ identity, op, params });
      if (options.pending) return options.pending(identity, op, params);
      return { id: 'pending-one', state: op === 'pending_enqueue' ? 'queued' : 'accepted' };
    },
    async call(identity, op, params) {
      calls.push({ identity, op, params });
      if (options.call) return options.call(identity, op, params);
      return {};
    },
  };
  const snapshots = [];
  const controller = createDesktopPetController(api, snapshot => snapshots.push(snapshot), {
    hostStatus: async () => ({ configured: true, deviceId: 'local-device' }),
  });
  const action = (kind, extra = {}) => ({
    id: crypto.randomUUID(), kind, deviceId: 'local-device', botId: 'local-main', ...extra,
  });
  return { api, bots, calls, watches, snapshots, controller, action, emit: () => listener() };
}

test('pet binds local primary while the main UI browses a remote device', async () => {
  const h = harness();
  h.controller.start();
  await settle();
  assert.equal(h.controller.snapshot().botId, 'local-main');
  assert.equal(h.controller.snapshot().deviceId, 'local-device');
  assert.equal(h.watches[0].identity.targetDeviceId, 'local-device');
  h.api.identity = { ...h.api.identity, targetDeviceId: 'another-remote' };
  h.emit();
  await settle();
  assert.equal(h.watches.length, 1);
  const result = await h.controller.handleAction(h.action('send', { text: 'Hello main' }));
  assert.equal(result.ok, true);
  assert.equal(result.pendingId, 'pending-one');
  const sends = h.calls.filter(call => call.op.startsWith('pending_'));
  assert.deepEqual(sends.map(call => call.op), ['pending_enqueue', 'pending_send']);
  assert.equal(sends[0].params.input.botId, 'local-main');
  assert.equal(sends[0].params.input.targetDeviceId, 'local-device');
  assert.equal(sends[0].params.input.text, 'Hello main');
  assert.equal(sends[1].identity.targetDeviceId, 'local-device');
  h.controller.stop();
});

test('disconnect and pet close discard old live frames without disconnecting the shared client', async () => {
  const h = harness();
  h.controller.start();
  await settle();
  const old = h.watches[0];
  h.api.transportConnected = false;
  h.emit();
  await settle();
  old.callback({ frame: { type: 'update', botId: 'local-main', changes: { generation: { text: 'Stale text' } } } });
  assert.equal(h.controller.snapshot().connection, 'offline');
  assert.equal(h.controller.snapshot().streamingText, '');
  h.api.identity = { ...h.api.identity, generation: 2 };
  h.api.transportConnected = true;
  h.emit();
  await settle();
  assert.equal(h.watches.length, 2);
  assert.equal(old.closed, 1);
  h.controller.stop();
  assert.equal(h.watches[1].closed, 1);
  assert.equal(h.api.transportConnected, true);
  const revisions = h.snapshots.length;
  h.watches[1].callback({ frame: { type: 'update', botId: 'local-main', changes: { generation: { text: 'After close' } } } });
  assert.equal(h.snapshots.length, revisions);
});

test('busy reflects bot activity including DM work; stop targets that bot', async () => {
  const h = harness();
  h.controller.start();
  await settle();
  h.watches[0].callback({ frame: { type: 'update', botId: 'local-main', changes: {
    activity: { phase: 'running', source: 'dm', scopeId: 'dm-one', requestId: 'turn-one', startedAt: null },
  } } });
  assert.equal(h.controller.snapshot().canStop, true);
  assert.notEqual(h.controller.snapshot().mascotState, 'idle');
  await h.controller.handleAction(h.action('stop'));
  assert.deepEqual(h.calls.at(-1).params, { botId: 'local-main' });
  assert.equal(h.calls.at(-1).op, 'abort');
  h.controller.stop();
});

test('accepted enqueue remains identifiable after an unknown send result and is never automatically retried', async () => {
  const h = harness({ pending: async (_identity, op) => {
    if (op === 'pending_enqueue') return { id: 'durable-record', state: 'queued' };
    throw { code: 'TIMEOUT', outcome: 'unconfirmed', message: 'lost response' };
  } });
  h.controller.start();
  await settle();
  const result = await h.controller.handleAction(h.action('send', { text: 'Only once' }));
  assert.equal(result.ok, false);
  assert.equal(result.pendingId, 'durable-record');
  assert.match(result.message, /发送记录/);
  h.emit();
  await settle();
  assert.equal(h.calls.filter(call => call.op === 'pending_send').length, 1);
  h.controller.stop();
});

test('an unconfirmed enqueue never triggers pending_send or retry', async () => {
  const h = harness({ pending: async () => { throw { code: 'TIMEOUT', outcome: 'unconfirmed', message: 'lost' }; } });
  h.controller.start();
  await settle();
  const result = await h.controller.handleAction(h.action('send', { text: 'Check ledger' }));
  assert.equal(result.ok, false);
  assert.match(result.message, /勿重复发送/);
  assert.equal(h.calls.filter(call => call.op === 'pending_send').length, 0);
  h.controller.stop();
});

test('overlapping send gestures enqueue only once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ pending: async (_identity, op) => {
    if (op === 'pending_enqueue') await gate;
    return { id: 'one', state: op === 'pending_enqueue' ? 'queued' : 'accepted' };
  } });
  h.controller.start();
  await settle();
  const first = h.controller.handleAction(h.action('send', { text: 'First' }));
  const second = await h.controller.handleAction(h.action('send', { text: 'Second' }));
  assert.equal(second.ok, false);
  assert.equal(h.calls.filter(call => call.op === 'pending_enqueue').length, 1);
  release();
  assert.equal((await first).ok, true);
  h.controller.stop();
});

test('old pet snapshot cannot send to or stop a newly selected main bot', async () => {
  const h = harness();
  h.controller.start();
  await settle();
  h.bots[1] = { ...h.bots[1], botId: 'replacement-main' };
  await h.controller.handleAction({ id: 'refresh', kind: 'refresh' });
  await settle();
  const before = h.calls.length;
  assert.equal((await h.controller.handleAction(h.action('send', { text: 'Old intent' }))).ok, false);
  assert.equal((await h.controller.handleAction(h.action('stop'))).ok, false);
  assert.equal(h.calls.length, before);
  h.controller.stop();
});

test('transcript respects reset boundary and excludes tool output', () => {
  assert.deepEqual(projectPetMessages([
    history(1, 'assistant', 'Before clear'),
    history(2, 'assistant', '', 'pi.reset'),
    history(3, 'user', 'New question'),
    history(4, 'toolResult', 'Private tool output'),
    history(5, 'assistant', 'New answer'),
  ]), [
    { id: '3:0', role: 'user', text: 'New question' },
    { id: '5:0', role: 'assistant', text: 'New answer' },
  ]);
});

const sampleQuestionnaire = (overrides = {}) => ({
  kind: 'questionnaire',
  version: 1,
  installationId: 'inst-qa',
  conversationId: 7,
  requestId: 'req-qa-1',
  status: 'pending',
  questions: [
    {
      header: '方式',
      question: '希望怎么展示桌宠？',
      options: [
        { label: '多态气泡', description: '按类型以气泡呈现' },
        { label: '传统弹窗', description: '固定小窗' },
      ],
    },
  ],
  ...overrides,
});

test('pet projects active running and durable questionnaires, settled receipt, and handoff without todo or task', () => {
  const readyActivity = { phase: 'running', source: 'primary', scopeId: null, requestId: 't1', startedAt: null };
  const runningCards = projectPetCards({
    busy: true,
    queuedCount: 0,
    lastEntryId: null,
    generation: null,
    history: [],
    tools: [
      {
        callId: 'call-qa',
        name: 'ask_user_question',
        status: 'running',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: sampleQuestionnaire(),
      },
      {
        callId: 'call-vault',
        name: 'vault_unlock',
        status: 'running',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: {
          kind: 'vault-unlock',
          version: 1,
          installationId: 'inst-v',
          conversationId: 7,
          requestId: 'vault-1',
          mode: 'unlock',
          status: 'pending',
        },
      },
      {
        callId: 'call-todo',
        name: 'todo_write',
        status: 'done',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: {
          kind: 'todo',
          version: 1,
          installationId: 'inst-t',
          tasks: [
            { id: 1, subject: 'Step one', status: 'completed' },
            { id: 2, subject: 'Step two', status: 'in_progress' },
          ],
        },
      },
      {
        callId: 'call-task',
        name: 'task_progress',
        status: 'running',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: {
          kind: 'task',
          version: 1,
          taskId: 'task-live',
          status: 'working',
          title: 'Update PiBot',
          cardLabel: 'Progress',
          stepCount: { done: 1, total: 3 },
        },
      },
    ],
  }, readyActivity, true);

  assert.equal(runningCards.questionnaire?.presentation.requestId, 'req-qa-1');
  assert.equal(runningCards.questionnaire?.interactive, true);
  assert.equal(runningCards.handoff?.kind, 'vault-unlock');
  assert.equal('activeToolName' in runningCards, false);
  assert.equal('todo' in runningCards, false);
  assert.equal('task' in runningCards, false);

  // Durable wait in history stays active only when listed in durableWaits
  const idleActivity = { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null };
  const durableCards = projectPetCards({
    busy: false,
    queuedCount: 0,
    lastEntryId: 10,
    generation: null,
    tools: [],
    durableWaits: [{ installationId: 'inst-qa', conversationId: 7, requestId: 'req-qa-1' }],
    history: [
      {
        id: 10,
        kind: 'pi.message',
        messages: [{ role: 'toolResult', text: '', toolCallId: 'hist-qa', presentation: sampleQuestionnaire(), durableWait: true }],
      },
    ],
  }, idleActivity, true);
  assert.equal(durableCards.questionnaire?.presentation.requestId, 'req-qa-1');
  assert.equal(durableCards.questionnaire?.interactive, true);

  // When durableWaits is empty, stale pending questionnaire in history is NOT resurrected
  const staleCards = projectPetCards({
    busy: false,
    queuedCount: 0,
    lastEntryId: 11,
    generation: null,
    tools: [],
    durableWaits: [],
    history: [
      {
        id: 10,
        kind: 'pi.message',
        messages: [{ role: 'toolResult', text: '', toolCallId: 'hist-qa', presentation: sampleQuestionnaire(), durableWait: true }],
      },
      {
        id: 11,
        kind: 'pi.message',
        messages: [{
          role: 'toolResult',
          text: '',
          toolCallId: 'hist-qa-done',
          presentation: sampleQuestionnaire({
            status: 'answered',
            result: {
              cancelled: false,
              answers: [{ questionIndex: 0, question: '希望怎么展示桌宠？', kind: 'option', answer: '多态气泡' }],
            },
          }),
        }],
      },
    ],
  }, idleActivity, true);
  assert.equal(staleCards.questionnaire, null);
  assert.equal(staleCards.settledQuestionnaire?.status, 'answered');
});

test('pet answer-questionnaire reuses callCapabilityAction answerQuestionnaire and returns settled data', async () => {
  const h = harness({
    call: async (_identity, op, params) => {
      assert.equal(op, 'callCapabilityAction');
      assert.equal(params.action, 'answerQuestionnaire');
      return { result: { status: 'settled' } };
    },
  });
  h.controller.start();
  await settle();
  const payload = {
    conversationId: 7,
    requestId: 'req-qa-1',
    cancelled: false,
    answers: [{ questionIndex: 0, selectedOptions: [0] }],
  };
  const result = await h.controller.handleAction(h.action('answer-questionnaire', {
    installationId: 'inst-qa',
    input: payload,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { status: 'settled' });
  const call = h.calls.find(c => c.op === 'callCapabilityAction');
  assert.equal(call.identity.targetDeviceId, 'local-device');
  assert.equal(call.params.installationId, 'inst-qa');
  assert.equal(call.params.request.botId, 'local-main');
  assert.deepEqual(call.params.request.input, payload);
  h.controller.stop();
});

test('switching primary bot during refresh never emits a fake ready with empty messages', async () => {
  let holdSnapshot = false;
  let deliverReplacement = null;
  const h = harness({
    onObserve(watch) {
      const deliver = (state = idle()) => {
        watch.callback({ frame: { type: 'snapshot', botId: watch.target.botId, state } });
      };
      if (holdSnapshot) {
        deliverReplacement = deliver;
      } else {
        queueMicrotask(() => deliver());
      }
    },
  });

  h.controller.start();
  await settle();
  assert.equal(h.controller.snapshot().connection, 'ready');
  assert.equal(h.controller.snapshot().botId, 'local-main');
  assert.deepEqual(h.controller.snapshot().messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
  ]);

  h.bots[1] = { ...h.bots[1], botId: 'replacement-main', role: 'Replacement' };
  holdSnapshot = true;
  const beforeSwitch = h.snapshots.length;
  await h.controller.handleAction({ id: 'refresh', kind: 'refresh' });
  await settle();

  assert.equal(h.watches.length, 2);
  assert.equal(h.watches[0].closed, 1);
  assert.equal(h.watches[1].target.botId, 'replacement-main');
  assert.equal(typeof deliverReplacement, 'function');

  const transitional = h.snapshots.slice(beforeSwitch);
  assert.ok(transitional.length >= 2);
  for (const snap of transitional) {
    assert.notEqual(snap.connection, 'ready');
    assert.equal(snap.connection, 'connecting');
    assert.deepEqual(snap.messages, []);
  }
  assert.equal(h.controller.snapshot().botId, 'replacement-main');
  assert.equal(h.controller.snapshot().connection, 'connecting');
  assert.deepEqual(h.controller.snapshot().messages, []);

  const beforeDeliver = h.snapshots.length;
  deliverReplacement({
    ...idle(),
    history: [history(1, 'assistant', 'Replacement reply')],
    lastEntryId: 1,
  });

  const afterDeliver = h.snapshots.slice(beforeDeliver);
  assert.equal(afterDeliver.length, 1);
  assert.equal(afterDeliver[0].connection, 'ready');
  assert.equal(afterDeliver[0].botId, 'replacement-main');
  assert.deepEqual(afterDeliver[0].messages, [
    { id: '1:0', role: 'assistant', text: 'Replacement reply' },
  ]);
  h.controller.stop();
});

test('stop clears stale streamingText, messages, and cards before reopen', async () => {
  const streamingState = () => ({
    busy: true,
    queuedCount: 0,
    lastEntryId: 2,
    generation: { text: 'Streaming...' },
    activity: { phase: 'running', source: 'primary', scopeId: null, requestId: 'turn-1', startedAt: null },
    history: [
      history(1, 'user', 'Check status'),
      history(2, 'assistant', 'Working on it'),
    ],
    tools: [
      {
        callId: 'call-qa',
        name: 'ask_user_question',
        status: 'running',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: sampleQuestionnaire(),
      },
      {
        callId: 'call-vault',
        name: 'vault_unlock',
        status: 'running',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: {
          kind: 'vault-unlock',
          version: 1,
          installationId: 'inst-v',
          conversationId: 7,
          requestId: 'vault-1',
          mode: 'unlock',
          status: 'pending',
        },
      },
      {
        callId: 'call-todo',
        name: 'todo_write',
        status: 'done',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: {
          kind: 'todo',
          version: 1,
          installationId: 'inst-t',
          tasks: [{ id: 1, subject: 'Step one', status: 'in_progress' }],
        },
      },
      {
        callId: 'call-task',
        name: 'task_progress',
        status: 'running',
        output: '',
        truncated: false,
        droppedBytes: 0,
        droppedLines: 0,
        presentation: {
          kind: 'task',
          version: 1,
          taskId: 'task-live',
          status: 'working',
          title: 'Update PiBot',
          cardLabel: 'Progress',
          stepCount: { done: 1, total: 3 },
        },
      },
    ],
  });

  let holdSnapshot = false;
  let deliverReopen = null;
  const h = harness({
    onObserve(watch) {
      const deliver = (state = streamingState()) => {
        watch.callback({ frame: { type: 'snapshot', botId: watch.target.botId, state } });
      };
      if (holdSnapshot) {
        deliverReopen = deliver;
      } else {
        queueMicrotask(() => deliver());
      }
    },
  });

  h.controller.start();
  await settle();
  const activeSnap = h.controller.snapshot();
  assert.equal(activeSnap.connection, 'ready');
  assert.equal(activeSnap.streamingText, 'Streaming...');
  assert.equal(typeof activeSnap.generationId, 'string');
  assert.equal(activeSnap.messages.length, 2);
  assert.equal(activeSnap.hasPendingUserTurn, false);
  assert.equal(activeSnap.questionnaire?.presentation.requestId, 'req-qa-1');
  assert.equal(activeSnap.handoff?.kind, 'vault-unlock');
  assert.equal(activeSnap.canStop, true);
  assert.equal(activeSnap.mascotState, 'blocked');
  assert.equal('activeToolName' in activeSnap, false);
  assert.equal('todo' in activeSnap, false);
  assert.equal('task' in activeSnap, false);

  h.controller.stop();
  holdSnapshot = true;
  const beforeReopen = h.snapshots.length;
  h.controller.start();
  await h.controller.handleAction({ id: 'reopen', kind: 'ready' });
  await settle();

  assert.equal(h.watches.length, 2);
  assert.equal(typeof deliverReopen, 'function');
  const transitional = h.snapshots.slice(beforeReopen);
  assert.ok(transitional.length >= 2);
  for (const snap of transitional) {
    assert.equal(snap.connection, 'connecting');
    assert.equal(snap.streamingText, '');
    assert.deepEqual(snap.messages, []);
    assert.equal(snap.hasPendingUserTurn, false);
    assert.equal(snap.questionnaire, null);
    assert.equal(snap.settledQuestionnaire, null);
    assert.equal(snap.handoff, null);
    assert.equal('activeToolName' in snap, false);
    assert.equal('todo' in snap, false);
    assert.equal('task' in snap, false);
    assert.equal(snap.canStop, false);
    assert.equal(snap.mascotState, 'idle');
    assert.equal(snap.generationId, null);
    assert.equal(snap.activity.phase, 'idle');
    assert.equal(snap.error, null);
    assert.equal(snap.hostSessionId, activeSnap.hostSessionId);
  }

  const beforeDeliver = h.snapshots.length;
  deliverReopen({
    ...idle(),
    history: [
      history(1, 'user', 'Check status'),
      history(2, 'assistant', 'Working on it'),
      history(3, 'assistant', 'Fresh reply after reopen'),
    ],
    lastEntryId: 3,
  });

  const afterDeliver = h.snapshots.slice(beforeDeliver);
  assert.equal(afterDeliver.length, 1);
  assert.equal(afterDeliver[0].connection, 'ready');
  assert.equal(afterDeliver[0].streamingText, '');
  assert.equal(afterDeliver[0].generationId, null);
  assert.equal(afterDeliver[0].hasPendingUserTurn, false);
  assert.equal(afterDeliver[0].mascotState, 'idle');
  assert.equal(afterDeliver[0].canStop, false);
  assert.equal(afterDeliver[0].questionnaire, null);
  assert.equal(afterDeliver[0].handoff, null);
  assert.equal('activeToolName' in afterDeliver[0], false);
  assert.equal('todo' in afterDeliver[0], false);
  assert.equal('task' in afterDeliver[0], false);
  assert.deepEqual(afterDeliver[0].messages, [
    { id: '1:0', role: 'user', text: 'Check status' },
    { id: '2:0', role: 'assistant', text: 'Working on it' },
    { id: '3:0', role: 'assistant', text: 'Fresh reply after reopen' },
  ]);
  h.controller.stop();
});

test('live stream end marks controller offline while keeping questionnaire read-only', async () => {
  const h = harness({
    initialState: () => ({
      ...idle(),
      busy: true,
      activity: { phase: 'running', source: 'primary', scopeId: null, requestId: 'turn-1', startedAt: null },
      generation: { text: 'Streaming...' },
      history: [
        history(1, 'assistant', 'Earlier reply'),
        history(2, 'user', 'Unlock and continue'),
      ],
      lastEntryId: 2,
      tools: [
        {
          callId: 'call-qa',
          name: 'ask_user_question',
          status: 'running',
          output: '',
          truncated: false,
          droppedBytes: 0,
          droppedLines: 0,
          presentation: sampleQuestionnaire(),
        },
        {
          callId: 'call-vault',
          name: 'vault_unlock',
          status: 'running',
          output: '',
          truncated: false,
          droppedBytes: 0,
          droppedLines: 0,
          presentation: {
            kind: 'vault-unlock',
            version: 1,
            installationId: 'inst-v',
            conversationId: 7,
            requestId: 'vault-1',
            mode: 'unlock',
            status: 'pending',
          },
        },
        {
          callId: 'call-todo',
          name: 'todo_write',
          status: 'done',
          output: '',
          truncated: false,
          droppedBytes: 0,
          droppedLines: 0,
          presentation: {
            kind: 'todo',
            version: 1,
            installationId: 'inst-t',
            tasks: [{ id: 1, subject: 'Step one', status: 'in_progress' }],
          },
        },
      ],
    }),
  });

  h.controller.start();
  await settle();
  const beforeEnd = h.controller.snapshot();
  assert.equal(beforeEnd.questionnaire?.interactive, true);
  assert.equal(beforeEnd.handoff?.kind, 'vault-unlock');
  assert.equal(beforeEnd.mascotState, 'blocked');
  assert.equal(beforeEnd.hasPendingUserTurn, true);
  assert.equal(typeof beforeEnd.generationId, 'string');
  assert.equal('activeToolName' in beforeEnd, false);
  assert.equal('todo' in beforeEnd, false);
  assert.equal('task' in beforeEnd, false);

  h.watches[0].callback({ frame: { type: 'end' } });
  const offline = h.controller.snapshot();
  assert.equal(offline.connection, 'offline');
  assert.equal(offline.streamingText, '');
  assert.equal(offline.generationId, null);
  assert.equal(offline.hasPendingUserTurn, false);
  assert.equal(offline.mascotState, 'idle');
  assert.equal(offline.handoff, null);
  assert.equal(offline.questionnaire?.presentation.requestId, 'req-qa-1');
  assert.equal(offline.questionnaire?.interactive, false);
  assert.equal('activeToolName' in offline, false);
  assert.equal('todo' in offline, false);
  assert.equal('task' in offline, false);
  h.controller.stop();
});

test('startup keeps avatarReady false while disconnected/connecting until primary avatar loads, and resets on stop', async () => {
  const customAvatar = {
    id: 'pink-pebble',
    shape: 'pebble',
    color: '#DF4191',
    rotation: -14,
    expressionIndex: 1,
    labelZh: '粉红胶囊',
    labelEn: 'Pink Pebble',
  };
  let releaseDirectory = null;
  let holdDirectory = false;
  let listener = () => {};
  const bots = [
    {
      deviceId: 'local-device',
      botId: 'local-main',
      role: 'Luna',
      isPrimary: true,
      online: true,
      avatar: customAvatar,
      avatarRevision: 3,
    },
  ];
  const api = {
    identity: null,
    transportConnected: false,
    subscribe(fn) { listener = fn; return () => { listener = () => {}; }; },
    identityForTarget(targetDeviceId) { return { ...this.identity, targetDeviceId }; },
    async broker(_identity, op) {
      assert.equal(op, 'bot_directory');
      if (holdDirectory) {
        await new Promise((resolve) => { releaseDirectory = resolve; });
      }
      return { bots, devices: [{ deviceId: 'local-device', online: true }], errors: [] };
    },
    observe(_identity, target, callback) {
      queueMicrotask(() => callback({ frame: { type: 'snapshot', botId: target.botId, state: idle() } }));
      return { ready: Promise.resolve(), async close() {} };
    },
    async pending() { return { id: 'p-1', state: 'accepted' }; },
    async call() { return {}; },
  };
  const snapshots = [];
  const controller = createDesktopPetController(api, (s) => snapshots.push(s), {
    hostStatus: async () => ({ configured: true, deviceId: 'local-device' }),
  });

  // 1. Cold start before CenterGate connects -> offline transitional snapshot must NOT mark avatarReady
  controller.start();
  await settle();
  assert.equal(controller.snapshot().connection, 'offline');
  assert.equal(controller.snapshot().avatarReady, false);
  assert.ok(snapshots.every((snap) => snap.avatarReady === false));

  // 2. Client connects -> bot_directory still in flight -> avatarReady stays false
  holdDirectory = true;
  api.identity = { profileId: 'center', kind: 'relay', targetDeviceId: '', generation: 1 };
  api.transportConnected = true;
  listener();
  await settle();
  assert.equal(typeof releaseDirectory, 'function');
  assert.equal(controller.snapshot().avatarReady, false);
  assert.ok(snapshots.every((snap) => snap.avatarReady === false));

  // 3. bot_directory resolves -> avatarReady flips true with authoritative avatar & revision
  const beforeResolve = snapshots.length;
  releaseDirectory();
  await settle();
  assert.equal(controller.snapshot().avatarReady, true);
  assert.deepEqual(controller.snapshot().avatar, customAvatar);
  assert.equal(controller.snapshot().avatarRevision, 3);
  const readyAfterResolve = snapshots.slice(beforeResolve).filter((snap) => snap.avatarReady);
  assert.ok(readyAfterResolve.length >= 1);
  assert.ok(readyAfterResolve.every((snap) => snap.botId === 'local-main' && snap.avatar?.id === customAvatar.id));

  // 4. stop() resets avatarReady so reopen waits for fresh directory load instead of stale cache
  controller.stop();
  assert.equal(controller.snapshot().avatarReady, false);
  holdDirectory = true;
  releaseDirectory = null;
  const updatedAvatar = { ...customAvatar, id: 'emerald-leaf', shape: 'leaf', color: '#4EBD64' };
  bots[0] = { ...bots[0], avatar: updatedAvatar, avatarRevision: 4 };
  const beforeReopen = snapshots.length;
  controller.start();
  await controller.handleAction({ id: 'reopen-ready', kind: 'ready' });
  await settle();
  assert.ok(snapshots.slice(beforeReopen).every((snap) => snap.avatarReady === false));

  releaseDirectory();
  await settle();
  assert.equal(controller.snapshot().avatarReady, true);
  assert.deepEqual(controller.snapshot().avatar, updatedAvatar);
  assert.equal(controller.snapshot().avatarRevision, 4);
  controller.stop();
});

test('offline primary from Center keeps real avatar ready, unconfigured marks ready, missing offline host waits', async () => {
  const customAvatar = {
    id: 'coral-wedge',
    shape: 'wedge',
    color: '#EA403C',
    rotation: 32,
    expressionIndex: 0,
    labelZh: '珊瑚三角',
    labelEn: 'Coral Wedge',
  };
  let hostState = { configured: true, deviceId: 'local-device' };
  let dirResponse = {
    bots: [
      {
        deviceId: 'local-device',
        botId: 'local-main',
        role: 'Offline Main',
        isPrimary: true,
        online: false,
        avatar: customAvatar,
        avatarRevision: 2,
      },
    ],
    devices: [{ deviceId: 'local-device', online: false }],
    errors: [],
  };
  const api = {
    identity: { profileId: 'center', kind: 'relay', targetDeviceId: 'local-device', generation: 1 },
    transportConnected: true,
    subscribe() { return () => {}; },
    identityForTarget(targetDeviceId) { return { ...this.identity, targetDeviceId }; },
    async broker(_identity, op) {
      assert.equal(op, 'bot_directory');
      return dirResponse;
    },
    observe() { return { ready: Promise.resolve(), async close() {} }; },
    async pending() { return { id: 'p-1', state: 'accepted' }; },
    async call() { return {}; },
  };
  const controller = createDesktopPetController(api, () => {}, {
    hostStatus: async () => hostState,
  });

  // Offline local host whose primary bot metadata came from Center -> real avatar IS ready
  controller.start();
  await settle();
  assert.equal(controller.snapshot().connection, 'offline');
  assert.equal(controller.snapshot().avatarReady, true);
  assert.deepEqual(controller.snapshot().avatar, customAvatar);

  // Missing primary while local device reports offline/error -> do not fall back to default circle
  dirResponse = {
    bots: [],
    devices: [{ deviceId: 'local-device', online: false }],
    errors: [],
  };
  await controller.handleAction({ id: 'r-offline-missing', kind: 'refresh' });
  assert.equal(controller.snapshot().connection, 'offline');
  assert.equal(controller.snapshot().avatarReady, false);

  // Online local device with confirmed no primary bot -> unconfigured is terminal & ready
  dirResponse = {
    bots: [],
    devices: [{ deviceId: 'local-device', online: true }],
    errors: [],
  };
  await controller.handleAction({ id: 'r-no-primary', kind: 'refresh' });
  assert.equal(controller.snapshot().connection, 'unconfigured');
  assert.equal(controller.snapshot().avatarReady, true);

  // Unconfigured local host -> terminal & ready
  hostState = { configured: false, deviceId: '' };
  await controller.handleAction({ id: 'r-unconfigured', kind: 'refresh' });
  assert.equal(controller.snapshot().connection, 'unconfigured');
  assert.equal(controller.snapshot().avatarReady, true);
  controller.stop();
});

test('multi-step tool turn tracks pending user turn, stable working mascot, and fresh generationId per segment', async () => {
  const runningActivity = {
    phase: 'running',
    source: 'primary',
    scopeId: null,
    requestId: 'turn-multi',
    startedAt: null,
  };
  const idleActivity = {
    phase: 'idle',
    source: null,
    scopeId: null,
    requestId: null,
    startedAt: null,
  };
  const toolSlot = (callId, name, status) => ({
    callId,
    name,
    status,
    output: '',
    truncated: false,
    droppedBytes: 0,
    droppedLines: 0,
  });

  const h = harness();
  h.controller.start();
  await settle();
  const watch = h.watches[0];
  const baseHistory = [history(1, 'assistant', 'Earlier reply')];
  const emit = (changes) => watch.callback({ frame: { type: 'update', botId: 'local-main', changes } });

  assert.equal(h.controller.snapshot().hasPendingUserTurn, false);
  assert.equal(h.controller.snapshot().mascotState, 'idle');
  assert.equal(h.controller.snapshot().generationId, null);

  // 1. User turn starts: pending user turn + working mascot
  const withUser = [...baseHistory, history(2, 'user', 'Fix the build and verify')];
  emit({
    busy: true,
    activity: runningActivity,
    history: withUser,
    lastEntryId: 2,
    generation: null,
    tools: [],
  });
  let snap = h.controller.snapshot();
  assert.equal(snap.hasPendingUserTurn, true);
  assert.equal(snap.mascotState, 'working');
  assert.equal(snap.streamingText, '');
  assert.equal(snap.generationId, null);
  assert.equal(snap.canStop, true);

  // 2. Intermediate streaming segment gets a non-null generationId and keeps it as text grows
  emit({ generation: { text: 'Checking', truncated: false } });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'streaming');
  assert.equal(snap.streamingText, 'Checking');
  const firstGenId = snap.generationId;
  assert.equal(typeof firstGenId, 'string');
  assert.ok(firstGenId.length > 0);

  emit({ generation: { text: 'Checking files first.', truncated: false } });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'streaming');
  assert.equal(snap.streamingText, 'Checking files first.');
  assert.equal(snap.generationId, firstGenId);

  // 3. Intermediate text commits, generation clears, and multiple tools run without per-tool mascot morphs
  const withIntermediate = [...withUser, history(3, 'assistant', 'Checking files first.')];
  emit({
    history: withIntermediate,
    lastEntryId: 3,
    generation: null,
    tools: [toolSlot('call-1', 'grep', 'running')],
  });
  snap = h.controller.snapshot();
  assert.equal(snap.hasPendingUserTurn, false);
  assert.deepEqual(snap.messages.map((m) => m.text), [
    'Earlier reply',
    'Fix the build and verify',
    'Checking files first.',
  ]);
  assert.equal(snap.streamingText, '');
  assert.equal(snap.generationId, null);
  assert.equal(snap.mascotState, 'working');
  assert.equal('activeToolName' in snap, false);
  assert.equal('todo' in snap, false);
  assert.equal('task' in snap, false);

  emit({ tools: [toolSlot('call-1', 'grep', 'done'), toolSlot('call-2', 'write_file', 'running')] });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'working');
  assert.equal(snap.generationId, null);

  emit({
    tools: [
      toolSlot('call-1', 'grep', 'done'),
      toolSlot('call-2', 'write_file', 'done'),
      toolSlot('call-3', 'bash', 'running'),
    ],
  });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'working');
  assert.equal(snap.generationId, null);

  // 4. Next streaming segment gets a fresh generationId
  emit({
    tools: [
      toolSlot('call-1', 'grep', 'done'),
      toolSlot('call-2', 'write_file', 'done'),
      toolSlot('call-3', 'bash', 'done'),
    ],
    generation: { text: 'Build fixed and verified.', truncated: false },
  });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'streaming');
  assert.equal(snap.streamingText, 'Build fixed and verified.');
  assert.equal(typeof snap.generationId, 'string');
  assert.notEqual(snap.generationId, firstGenId);

  // 5. afterRun keeps final text in messages while still busy with generation cleared
  const withFinal = [...withIntermediate, history(4, 'assistant', 'Build fixed and verified.')];
  emit({
    busy: true,
    activity: runningActivity,
    history: withFinal,
    lastEntryId: 4,
    generation: null,
    tools: [],
  });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'working');
  assert.equal(snap.streamingText, '');
  assert.equal(snap.generationId, null);
  assert.equal(snap.hasPendingUserTurn, false);
  assert.deepEqual(snap.messages.map((m) => m.text), [
    'Earlier reply',
    'Fix the build and verify',
    'Checking files first.',
    'Build fixed and verified.',
  ]);

  // 6. Idle after turn finishes
  emit({
    busy: false,
    activity: idleActivity,
    generation: null,
  });
  snap = h.controller.snapshot();
  assert.equal(snap.mascotState, 'idle');
  assert.equal(snap.canStop, false);
  assert.equal(snap.hasPendingUserTurn, false);
  assert.equal(snap.messages.at(-1)?.text, 'Build fixed and verified.');
  h.controller.stop();
});

test('image-only user turn sets hasPendingUserTurn without adding empty message and clears on assistant reply', async () => {
  const imageOnlyUser = {
    id: 2,
    kind: 'pi.message',
    messages: [{
      role: 'user',
      text: '',
      attachments: [{
        id: 'a'.repeat(64),
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: 2048,
        width: 800,
        height: 600,
      }],
    }],
  };
  const emptyToolCallAssistant = {
    id: 3,
    kind: 'pi.message',
    messages: [{ role: 'assistant', text: '', toolCalls: [{ callId: 'c1', name: 'read' }] }],
  };

  const pendingTranscript = projectPetTranscript([
    history(1, 'assistant', 'Earlier reply'),
    imageOnlyUser,
  ]);
  assert.deepEqual(pendingTranscript.messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
  ]);
  assert.equal(pendingTranscript.hasPendingUserTurn, true);

  const afterEmptyAssistant = projectPetTranscript([
    history(1, 'assistant', 'Earlier reply'),
    imageOnlyUser,
    emptyToolCallAssistant,
  ]);
  assert.deepEqual(afterEmptyAssistant.messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
  ]);
  assert.equal(afterEmptyAssistant.hasPendingUserTurn, true);

  const answeredTranscript = projectPetTranscript([
    history(1, 'assistant', 'Earlier reply'),
    imageOnlyUser,
    emptyToolCallAssistant,
    history(4, 'assistant', 'I see the screenshot.'),
  ]);
  assert.deepEqual(answeredTranscript.messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
    { id: '4:0', role: 'assistant', text: 'I see the screenshot.' },
  ]);
  assert.equal(answeredTranscript.hasPendingUserTurn, false);

  const h = harness();
  h.controller.start();
  await settle();
  const watch = h.watches[0];
  assert.equal(h.controller.snapshot().hasPendingUserTurn, false);

  watch.callback({
    frame: {
      type: 'update',
      botId: 'local-main',
      changes: {
        busy: true,
        activity: { phase: 'running', source: 'primary', scopeId: null, requestId: 'img-1', startedAt: null },
        history: [history(1, 'assistant', 'Earlier reply'), imageOnlyUser],
        lastEntryId: 2,
      },
    },
  });
  assert.equal(h.controller.snapshot().hasPendingUserTurn, true);
  assert.deepEqual(h.controller.snapshot().messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
  ]);

  watch.callback({
    frame: {
      type: 'update',
      botId: 'local-main',
      changes: {
        busy: false,
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        history: [
          history(1, 'assistant', 'Earlier reply'),
          imageOnlyUser,
          history(3, 'assistant', 'I see the screenshot.'),
        ],
        lastEntryId: 3,
      },
    },
  });
  assert.equal(h.controller.snapshot().hasPendingUserTurn, false);
  assert.deepEqual(h.controller.snapshot().messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
    { id: '3:0', role: 'assistant', text: 'I see the screenshot.' },
  ]);
  h.controller.stop();
  assert.equal(h.controller.snapshot().hasPendingUserTurn, false);
});

test('macro mascot state enforces connection, stopping, awaitingUser, busy, and failed priorities', async () => {
  const idleActivity = { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null };
  const runningActivity = { phase: 'running', source: 'primary', scopeId: null, requestId: 't-1', startedAt: null };
  const stoppingActivity = { phase: 'stopping', source: 'primary', scopeId: null, requestId: 't-1', startedAt: null };
  const failedActivity = {
    phase: 'failed',
    source: 'primary',
    scopeId: null,
    requestId: 't-1',
    startedAt: null,
    error: { code: 'PROVIDER_ERROR', message: 'Upstream failed' },
  };

  assert.equal(
    resolvePetMascotState({ connection: 'offline', activity: stoppingActivity, isStreaming: true, awaitingUser: true }),
    'idle',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'connecting', activity: runningActivity, isStreaming: true, awaitingUser: false }),
    'idle',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: stoppingActivity, isStreaming: true, awaitingUser: true }),
    'powering-down',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: idleActivity, isStreaming: false, awaitingUser: true }),
    'blocked',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: runningActivity, isStreaming: true, awaitingUser: true }),
    'blocked',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: runningActivity, isStreaming: true, awaitingUser: false }),
    'streaming',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: runningActivity, isStreaming: false, awaitingUser: false }),
    'working',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: failedActivity, isStreaming: false, awaitingUser: false }),
    'failed',
  );
  assert.equal(
    resolvePetMascotState({ connection: 'ready', activity: idleActivity, isStreaming: false, awaitingUser: false }),
    'idle',
  );

  const runningVaultTool = {
    callId: 'call-vault',
    name: 'vault_unlock',
    status: 'running',
    output: '',
    truncated: false,
    droppedBytes: 0,
    droppedLines: 0,
    presentation: {
      kind: 'vault-unlock',
      version: 1,
      installationId: 'inst-v',
      conversationId: 7,
      requestId: 'vault-1',
      mode: 'unlock',
      status: 'pending',
    },
  };

  const h = harness({
    initialState: () => ({
      ...idle(),
      busy: false,
      activity: idleActivity,
      durableWaits: [{ installationId: 'inst-qa', conversationId: 7, requestId: 'req-qa-1' }],
      history: [
        history(1, 'assistant', 'Earlier reply'),
        {
          id: 2,
          kind: 'pi.message',
          messages: [{
            role: 'toolResult',
            text: '',
            toolCallId: 'hist-qa',
            presentation: sampleQuestionnaire(),
            durableWait: true,
          }],
        },
      ],
      lastEntryId: 2,
    }),
  });

  h.controller.start();
  await settle();
  const watch = h.watches[0];
  const emit = (changes) => watch.callback({ frame: { type: 'update', botId: 'local-main', changes } });

  // 1. Durable wait questionnaire while idle (busy: false) -> blocked
  assert.equal(h.controller.snapshot().questionnaire?.interactive, true);
  assert.equal(h.controller.snapshot().mascotState, 'blocked');

  // 2. Running handoff -> blocked
  emit({
    busy: true,
    activity: runningActivity,
    durableWaits: [],
    tools: [runningVaultTool],
  });
  assert.equal(h.controller.snapshot().questionnaire, null);
  assert.equal(h.controller.snapshot().handoff?.kind, 'vault-unlock');
  assert.equal(h.controller.snapshot().mascotState, 'blocked');

  // 3. Stopping overrides running handoff -> powering-down
  emit({ activity: stoppingActivity });
  assert.equal(h.controller.snapshot().handoff?.kind, 'vault-unlock');
  assert.equal(h.controller.snapshot().mascotState, 'powering-down');

  // 4. Failed activity -> failed
  emit({
    busy: false,
    tools: [],
    activity: failedActivity,
  });
  assert.equal(h.controller.snapshot().handoff, null);
  assert.equal(h.controller.snapshot().mascotState, 'failed');
  assert.equal(h.controller.snapshot().error, 'Upstream failed');

  // 5. markOffline clears active handoff and resets mascotState to idle
  emit({
    busy: true,
    activity: runningActivity,
    tools: [runningVaultTool],
  });
  assert.equal(h.controller.snapshot().handoff?.kind, 'vault-unlock');
  assert.equal(h.controller.snapshot().mascotState, 'blocked');

  watch.callback({ frame: { type: 'end' } });
  const offline = h.controller.snapshot();
  assert.equal(offline.connection, 'offline');
  assert.equal(offline.handoff, null);
  assert.equal(offline.mascotState, 'idle');
  assert.equal(offline.generationId, null);
  assert.equal(offline.hasPendingUserTurn, false);
  h.controller.stop();
});

test('collaborative channel history and streaming stay isolated while activity drives canStop and mascotState', async () => {
  const mixedHistory = [
    history(1, 'user', 'Primary question', 'pi.message', { attribution: { kind: 'user', channel: 'primary' } }),
    history(2, 'assistant', 'Primary answer', 'pi.message', { attribution: { kind: 'bot', channel: 'primary' } }),
    history(3, 'user', 'Scope notice', 'host.scope-message'),
    history(4, 'user', 'Room prompt', 'pi.message', { attribution: { kind: 'user', channel: 'room', scopeId: 'room-1' } }),
    history(5, 'assistant', 'Room reply', 'pi.message', { attribution: { kind: 'bot', channel: 'room', scopeId: 'room-1' } }),
    history(6, 'user', 'DM prompt', 'pi.message', { attribution: { kind: 'bot', channel: 'dm', scopeId: 'dm-1' } }),
  ];

  const transcript = projectPetTranscript(mixedHistory);
  assert.deepEqual(transcript.messages, [
    { id: '1:0', role: 'user', text: 'Primary question' },
    { id: '2:0', role: 'assistant', text: 'Primary answer' },
  ]);
  assert.equal(transcript.hasPendingUserTurn, false);
  assert.deepEqual(projectPetMessages(mixedHistory), transcript.messages);

  const h = harness();
  h.controller.start();
  await settle();
  const watch = h.watches[0];
  const emit = (changes) => watch.callback({ frame: { type: 'update', botId: 'local-main', changes } });

  // 1. Room history & streaming do not leak, while canStop and mascotState reflect running work
  const withCollabHistory = [
    history(1, 'assistant', 'Earlier reply'),
    history(2, 'user', 'Scope broadcast', 'host.scope-message'),
    history(3, 'user', 'Room user turn', 'pi.message', { attribution: { kind: 'user', channel: 'room', scopeId: 'room-1' } }),
  ];
  emit({
    busy: true,
    activity: { phase: 'running', source: 'room', scopeId: 'room-1', requestId: 'room-turn-1', startedAt: null },
    history: withCollabHistory,
    lastEntryId: 3,
    generation: {
      text: 'Secret room stream',
      truncated: false,
      attribution: { kind: 'bot', channel: 'room', scopeId: 'room-1' },
    },
  });
  let snap = h.controller.snapshot();
  assert.deepEqual(snap.messages, [{ id: '1:0', role: 'assistant', text: 'Earlier reply' }]);
  assert.equal(snap.streamingText, '');
  assert.equal(snap.generationId, null);
  assert.equal(snap.hasPendingUserTurn, false);
  assert.equal(snap.canStop, true);
  assert.equal(snap.mascotState, 'working');

  // 2. DM activity & streaming (even without generation.attribution) stay suppressed
  const withDmHistory = [
    ...withCollabHistory,
    history(4, 'user', 'DM turn', 'pi.message', { attribution: { kind: 'bot', channel: 'dm', scopeId: 'dm-1' } }),
  ];
  emit({
    busy: true,
    activity: { phase: 'running', source: 'dm', scopeId: 'dm-1', requestId: 'dm-turn-1', startedAt: null },
    history: withDmHistory,
    lastEntryId: 4,
    generation: { text: 'Secret DM stream', truncated: false },
  });
  snap = h.controller.snapshot();
  assert.deepEqual(snap.messages, [{ id: '1:0', role: 'assistant', text: 'Earlier reply' }]);
  assert.equal(snap.streamingText, '');
  assert.equal(snap.generationId, null);
  assert.equal(snap.hasPendingUserTurn, false);
  assert.equal(snap.canStop, true);
  assert.equal(snap.mascotState, 'working');

  // 3. Collaborative generation attribution suppresses streaming even if activity.source is primary
  emit({
    busy: true,
    activity: { phase: 'running', source: 'primary', scopeId: null, requestId: 'dm-turn-2', startedAt: null },
    generation: {
      text: 'Attributed DM stream',
      truncated: false,
      attribution: { kind: 'bot', channel: 'dm', scopeId: 'dm-1' },
    },
  });
  snap = h.controller.snapshot();
  assert.equal(snap.streamingText, '');
  assert.equal(snap.generationId, null);
  assert.equal(snap.mascotState, 'working');

  // 4. Primary turn after collaborative turns still surfaces normally
  emit({
    busy: true,
    activity: { phase: 'running', source: 'primary', scopeId: null, requestId: 'primary-1', startedAt: null },
    history: [
      ...withDmHistory,
      history(5, 'user', 'Back to primary', 'pi.message', { attribution: { kind: 'user', channel: 'primary' } }),
    ],
    lastEntryId: 5,
    generation: {
      text: 'Primary stream',
      truncated: false,
      attribution: { kind: 'bot', channel: 'primary' },
    },
  });
  snap = h.controller.snapshot();
  assert.deepEqual(snap.messages, [
    { id: '1:0', role: 'assistant', text: 'Earlier reply' },
    { id: '5:0', role: 'user', text: 'Back to primary' },
  ]);
  assert.equal(snap.hasPendingUserTurn, true);
  assert.equal(snap.streamingText, 'Primary stream');
  assert.equal(typeof snap.generationId, 'string');
  assert.equal(snap.mascotState, 'streaming');
  h.controller.stop();
});
