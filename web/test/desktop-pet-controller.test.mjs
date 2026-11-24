import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDesktopPetController,
  projectPetCards,
  projectPetMessages,
} from '../../desktop/web/src/pet/controller.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
const history = (id, role, text, kind = 'pi.message') => ({ id, kind, messages: [{ role, text }] });
const idle = () => ({
  busy: false, queuedCount: 0, tools: [], history: [history(1, 'assistant', 'Earlier reply')],
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
      queueMicrotask(() => callback({ frame: { type: 'snapshot', botId: target.botId, state: idle() } }));
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

test('pet projects active running and durable questionnaires, settled receipt, handoff, and todo', () => {
  const readyActivity = { phase: 'running', source: 'primary', scopeId: null, requestId: 't1', startedAt: null };
  const runningCards = projectPetCards({
    busy: true,
    queuedCount: 0,
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
    ],
  }, readyActivity, true);

  assert.equal(runningCards.questionnaire?.presentation.requestId, 'req-qa-1');
  assert.equal(runningCards.questionnaire?.interactive, true);
  assert.equal(runningCards.handoff?.kind, 'vault-unlock');
  assert.equal(runningCards.todo?.tasks.length, 2);

  // Durable wait in history stays active only when listed in durableWaits
  const idleActivity = { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null };
  const durableCards = projectPetCards({
    busy: false,
    queuedCount: 0,
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
