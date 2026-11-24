import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopPetController, projectPetMessages } from '../../desktop/web/src/pet/controller.ts';

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
    async call(identity, op, params) { calls.push({ identity, op, params }); return {}; },
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
