import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCenterModels } from '../../host-core/runtime-models.js';
import { acceptHistoryDelta } from '../../center-contract/antigravity-delta.js';
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID } from '../../host-core/antigravity-provider.js';

const MODEL_ID = 'gemini-fixture';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=';
const system = { role: 'system', content: 'Stable fixture instructions.', timestamp: 0 };
const user = text => ({ role: 'user', content: text, timestamp: 1 });
const assistant = () => ({
  role: 'assistant', api: ANTIGRAVITY_API, provider: ANTIGRAVITY_PROVIDER_ID, model: MODEL_ID,
  content: [{ type: 'text', text: 'acknowledged' }], stopReason: 'stop', timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

function snapshot({ deviceId = 'host-a', linkUrl = 'wss://center-a.example/link', otherMaxTokens = 1024 } = {}) {
  return {
    protocol: 1, deviceId, linkUrl, revision: 1, bots: [], credentials: {},
    providers: [
      { id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', api: ANTIGRAVITY_API,
        baseUrl: '', native: true, enabled: true, credentialRef: null },
      { id: 'openai', name: 'Other provider', api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1', native: true, enabled: true, credentialRef: null },
    ],
    models: {
      [ANTIGRAVITY_PROVIDER_ID]: [{ id: MODEL_ID, name: MODEL_ID, api: ANTIGRAVITY_API,
        enabled: true, contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoning: false }],
      openai: [{ id: 'other-model', enabled: true, contextWindow: 128000, maxTokens: otherMaxTokens }],
    },
  };
}

function fakeCenter() {
  const histories = new Map();
  const sent = [];
  return {
    sent,
    stream(payload, options = {}) {
      sent.push(structuredClone(payload));
      return (async function* () {
        const accepted = acceptHistoryDelta(histories.get(payload.sessionId), payload.delta);
        histories.set(payload.sessionId, accepted.history);
        // Real center-client consumes this control frame before Pi sees it.
        await options.onHistoryAck?.(accepted.ack);
        yield { type: 'done', reason: 'stop', message: assistant() };
      })();
    },
  };
}

function apply(config, models, center) {
  // Runtime constructs a fresh callback on each registry rebuild.
  return applyCenterModels(config, models, undefined, (...args) => center.stream(...args)).models;
}

async function send(models, messages, sessionId = 'same-provider-session') {
  const provider = models.getProvider(ANTIGRAVITY_PROVIDER_ID);
  const events = [];
  for await (const event of provider.streamSimple(provider.getModels()[0], { messages }, { sessionId })) {
    events.push(event);
  }
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'done', terminal?.error?.errorMessage);
  return terminal.message;
}

test('Unrelated provider changes rebuild AGY without dropping its acknowledged history cursor', async () => {
  const center = fakeCenter();
  const models = apply(snapshot(), undefined, center);
  const firstProvider = models.getProvider(ANTIGRAVITY_PROVIDER_ID);
  const firstInput = { role: 'user', content: [{ type: 'text', text: 'first' },
    { type: 'image', data: png, mimeType: 'image/png' }], timestamp: 1 };
  const messages = [system, firstInput];
  messages.push(await send(models, messages));
  assert.equal(center.sent[0].delta.offset, 0);

  assert.equal(apply(snapshot({ otherMaxTokens: 2048 }), models, center), models);
  assert.notEqual(models.getProvider(ANTIGRAVITY_PROVIDER_ID), firstProvider, 'fixture must really replace the provider');
  messages.push(user('second'));
  messages.push(await send(models, messages));
  assert.equal(center.sent[1].delta.offset, 1);
  assert.equal(center.sent[1].delta.config, undefined);
  assert.equal(center.sent[1].delta.messages.length, 2);
  assert.equal(JSON.stringify(center.sent[1]).includes(png), false, 'old attachments must not be uploaded again');

  apply(snapshot({ otherMaxTokens: 4096 }), models, center);
  messages.push(user('third'));
  await send(models, messages);
  assert.equal(center.sent[2].delta.offset, 3);
  assert.equal(center.sent[2].delta.messages.length, 2);
});

test('Independent registries never inherit ACKs for equal provider session IDs', async () => {
  const firstCenter = fakeCenter();
  const secondCenter = fakeCenter();
  const firstModels = apply(snapshot(), undefined, firstCenter);
  const firstMessages = [system, user('first registry')];
  firstMessages.push(await send(firstModels, firstMessages));

  const secondModels = apply(snapshot(), undefined, secondCenter);
  await send(secondModels, [system, user('independent registry')]);
  assert.notEqual(firstModels, secondModels);
  assert.equal(secondCenter.sent[0].delta.offset, 0);
  assert.ok(secondCenter.sent[0].delta.config);
  assert.equal(secondCenter.sent[0].delta.messages.length, 1);

  firstMessages.push(user('first registry continues'));
  await send(firstModels, firstMessages);
  assert.equal(firstCenter.sent[1].delta.offset, 1, 'another registry must not reset the first owner');
});

for (const change of [{ deviceId: 'host-b' }, { linkUrl: 'wss://center-b.example/link' }]) {
  test('Changing ' + Object.keys(change)[0] + ' starts a fresh ACK scope even with a reused registry', async () => {
    const firstCenter = fakeCenter();
    const models = apply(snapshot(), undefined, firstCenter);
    await send(models, [system, user('prior identity')]);
    const nextCenter = fakeCenter();
    apply(snapshot(change), models, nextCenter);
    await send(models, [system, user('new identity')]);
    assert.equal(nextCenter.sent[0].delta.offset, 0);
    assert.ok(nextCenter.sent[0].delta.config);
    assert.equal(nextCenter.sent[0].delta.messages.length, 1);
  });
}
