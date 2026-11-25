import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptHistoryDelta, hashValue, historyPrefixes, messageHash,
} from '../../center-contract/antigravity-delta.js';
import { createAntigravityHistoryTransport } from '../../host-core/antigravity-delta.js';

const system = {
  role: 'system', content: 'Stable Soul.',
  toolsAdded: [{ name: 'codemode', description: 'Execute code.', parameters: { type: 'object' } }],
};
const user = (text) => ({ role: 'user', content: text, timestamp: 1 });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
const payload = (messages, overrides = {}) => ({
  sessionId: 'session-a', modelId: 'gemini-test', messages: [system, ...messages], ...overrides,
});
const isClear = (error) => error.code === 'AGY_HISTORY_CHANGED' && error.message.includes('/clear');

test('Host uploads only the acknowledged suffix; Center overlap is idempotent', () => {
  const host = createAntigravityHistoryTransport();
  const first = host.prepare(payload([user('one')]));
  const received = acceptHistoryDelta(null, first.payload.delta);
  assert.equal(received.history.messages.length, 1);
  assert.equal(received.history.attemptedThrough, undefined, 'receipt is not native consumption');
  first.acknowledge(received.ack);
  const second = host.prepare(payload([user('one'), assistant('answer'), user('two')]));
  assert.equal(second.payload.delta.offset, 1);
  assert.equal(second.payload.delta.config, undefined);
  assert.deepEqual(second.payload.delta.messages, [assistant('answer'), user('two')]);
  const next = acceptHistoryDelta(received.history, second.payload.delta);
  const repeated = acceptHistoryDelta(next.history, second.payload.delta);
  assert.deepEqual(repeated.history, next.history);
  assert.equal(repeated.history.messages.length, 3);
  assert.equal(second.payload.turnContext.inputIndex, 2);
});

test('Lost receipt and a Host restart can resend without duplicating accepted entries', () => {
  const original = createAntigravityHistoryTransport();
  const messages = [user('one'), assistant('answer'), user('two')];
  const send = original.prepare(payload(messages));
  const accepted = acceptHistoryDelta(null, send.payload.delta);
  const restarted = createAntigravityHistoryTransport();
  const retry = restarted.prepare(payload(messages));
  assert.equal(retry.payload.delta.offset, 0);
  const persisted = JSON.parse(JSON.stringify(accepted.history));
  const result = acceptHistoryDelta(persisted, retry.payload.delta);
  assert.deepEqual(result.history, persisted);
  retry.acknowledge(result.ack);
  const follow = restarted.prepare(payload([...messages, assistant('ok'), user('three')]));
  assert.equal(follow.payload.delta.offset, 3);
  assert.equal(follow.payload.delta.messages.length, 2);
});

test('A delayed earlier receipt cannot move the Host cursor backwards', () => {
  const host = createAntigravityHistoryTransport();
  const a = host.prepare(payload([user('one')]));
  const first = acceptHistoryDelta(null, a.payload.delta);
  a.acknowledge(first.ack);
  const messages = [user('one'), assistant('answer'), user('two')];
  const b = host.prepare(payload(messages));
  const second = acceptHistoryDelta(first.history, b.payload.delta);
  b.acknowledge(second.ack);
  a.acknowledge(first.ack);
  const c = host.prepare(payload([...messages, assistant('second answer'), user('three')]));
  assert.equal(c.payload.delta.offset, 3);
});

test('Equal user text at different history positions remains two separate inputs', () => {
  const host = createAntigravityHistoryTransport();
  const wire = host.prepare(payload([user('continue'), assistant('ok'), user('continue')]));
  const result = acceptHistoryDelta(null, wire.payload.delta);
  assert.equal(result.history.messages.filter((entry) => entry.role === 'user').length, 2);
  assert.notEqual(result.history.prefixes[1], result.history.prefixes[3]);
});

test('Historical edits, shortening, Soul and tool declaration changes require clear', () => {
  const edits = [
    payload([user('edited'), assistant('ok'), user('next')]),
    payload([user('one')]),
    payload([user('one'), assistant('ok'), user('next')], {
      messages: [{ ...system, content: 'New Soul.' }, user('one'), assistant('ok'), user('next')],
    }),
    payload([user('one'), assistant('ok'), user('next')], {
      messages: [{ ...system, toolsAdded: [{ ...system.toolsAdded[0], description: 'Changed tool.' }] },
        user('one'), assistant('ok'), user('next')],
    }),
  ];
  for (const changed of edits) {
    const host = createAntigravityHistoryTransport();
    const first = host.prepare(payload([user('one'), assistant('ok')]));
    first.acknowledge(acceptHistoryDelta(null, first.payload.delta).ack);
    assert.throws(() => host.prepare(changed), isClear);
  }
});

test('Per-turn routing varies independently; fixed routing rules require clear', () => {
  const host = createAntigravityHistoryTransport();
  const route = (text) => ({ role: 'system', content: '', sections: { 'host-turn-routing': text } });
  const first = host.prepare(payload([], {
    messages: [route('Source: human'), system, user('one')],
    turnContext: { inputIndex: 2, auxiliaryIndices: [], routingPolicy: 'rules-v1' },
  }));
  first.acknowledge(acceptHistoryDelta(null, first.payload.delta).ack);
  const second = host.prepare(payload([], {
    messages: [route('Source: scheduled task'), system, user('one'), assistant('ok'), user('two')],
    turnContext: { inputIndex: 4, auxiliaryIndices: [], routingPolicy: 'rules-v1' },
  }));
  assert.equal(second.payload.delta.offset, 1);
  assert.match(second.payload.turnContext.routeNote, /scheduled/);
  assert.throws(() => host.prepare(payload([], {
    messages: [system, user('one'), assistant('ok'), user('two')],
    turnContext: { inputIndex: 3, auxiliaryIndices: [], routingPolicy: 'rules-v2' },
  })), isClear);
});

test('Center rejects changed overlap or configuration without mutating its receipt', () => {
  const host = createAntigravityHistoryTransport();
  const first = host.prepare(payload([user('one')]));
  const { history } = acceptHistoryDelta(null, first.payload.delta);
  const before = JSON.stringify(history);
  assert.throws(() => acceptHistoryDelta(history, {
    ...first.payload.delta, messages: [user('edited')],
  }), isClear);
  const config = { ...first.payload.delta.config, systemPrompt: 'Other Soul' };
  assert.throws(() => acceptHistoryDelta(history, {
    ...first.payload.delta, config, configHash: hashValue(config),
  }), isClear);
  assert.equal(JSON.stringify(history), before);
});

test('Delivery metadata may settle while actual text, image and tool arguments stay immutable', () => {
  const before = { ...assistant('ok'), timestamp: 1, usage: { input: 1 }, durationMs: 1 };
  const after = { ...before, timestamp: 2, usage: { input: 2 }, durationMs: 9 };
  assert.equal(messageHash(before), messageHash(after));
  assert.notEqual(messageHash(before), messageHash(assistant('changed')));
  const result = { role: 'toolResult', toolCallId: 'call-a', toolName: 'read',
    content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
  assert.notEqual(messageHash(result), messageHash({ ...result,
    content: [{ type: 'image', data: 'AAAB', mimeType: 'image/png' }] }));
});

test('Receipt accepts more than 4096 messages without a synthetic conversation limit', () => {
  const host = createAntigravityHistoryTransport();
  const messages = Array.from({ length: 4100 }, (_, i) => user('queued-' + i));
  const sent = host.prepare(payload(messages));
  const { history, ack } = acceptHistoryDelta(null, sent.payload.delta);
  assert.equal(ack.offset, 4100);
  assert.equal(history.messages.length, 4100);
  assert.deepEqual(history.prefixes, historyPrefixes(messages));
});
