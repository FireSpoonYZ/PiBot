import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopPetController } from '../../desktop/web/src/pet/controller.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const idleLive = () => ({
  busy: false,
  queuedCount: 0,
  tools: [],
  history: [{ id: 1, kind: 'pi.message', messages: [{ role: 'assistant', text: 'Local reply' }] }],
  generation: null,
  activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
});

function createHarness(options = {}) {
  const calls = [];
  const openedBots = [];
  let listener = () => {};
  const bots = options.bots ?? [
    { deviceId: 'local-device', botId: 'local-main', role: 'Local Main', isPrimary: true, online: true },
    { deviceId: 'remote-device', botId: 'mail-bot', role: '邮件助理', isPrimary: false, online: true },
  ];
  let assistantResponse = options.assistantResponse ?? (() => ({
    assistant: {
      enabled: true,
      deviceId: 'remote-device',
      botId: 'mail-bot',
      mode: 'dedicated',
      accounts: ['user@example.com'],
    },
  }));
  let boardResponse = options.boardResponse ?? (() => ({
    updatedAt: '2026-11-24T10:00:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: null,
      },
    ],
    errors: [],
  }));

  const api = {
    identity: options.identity ?? {
      profileId: 'center-1',
      kind: 'relay',
      targetDeviceId: 'local-device',
      generation: 1,
    },
    transportConnected: options.transportConnected ?? true,
    subscribe(fn) {
      listener = fn;
      return () => { listener = () => {}; };
    },
    identityForTarget(targetDeviceId) {
      return { ...this.identity, targetDeviceId };
    },
    async broker(identity, op, params) {
      calls.push({ kind: 'broker', identity, op, params });
      if (op === 'bot_directory') {
        return { bots, devices: [], errors: [] };
      }
      if (op === 'center_admin_request') {
        assert.equal(params.method, 'GET');
        assert.equal(params.path, '/api/google/assistant');
        return typeof assistantResponse === 'function' ? assistantResponse() : assistantResponse;
      }
      throw new Error(`Unexpected broker op: ${op}`);
    },
    observe(identity, target, callback) {
      queueMicrotask(() => callback({ frame: { type: 'snapshot', botId: target.botId, state: idleLive() } }));
      return { ready: Promise.resolve(), async close() {} };
    },
    async pending() {
      return { id: 'p-1', state: 'accepted' };
    },
    async call(identity, op, params) {
      calls.push({ kind: 'call', identity, op, params });
      if (op === 'getBotBoard') {
        return typeof boardResponse === 'function' ? boardResponse(identity, params) : boardResponse;
      }
      throw new Error(`Unexpected RPC call: ${op}`);
    },
  };

  const snapshots = [];
  const controller = createDesktopPetController(api, (snapshot) => snapshots.push(snapshot), {
    hostStatus: async () => ({ configured: true, deviceId: 'local-device' }),
    onOpenBot: (deviceId, botId) => openedBots.push({ deviceId, botId }),
    proactivePollIntervalMs: options.proactivePollIntervalMs ?? 60_000,
  });

  return {
    api,
    calls,
    openedBots,
    snapshots,
    controller,
    emit: () => listener(),
    setAssistantResponse: (next) => { assistantResponse = next; },
    setBoardResponse: (next) => { boardResponse = next; },
  };
}

test('cold-start baseline suppresses existing proactive result, then new proactive-google result surfaces', async () => {
  const h = createHarness({
    boardResponse: () => ({
      updatedAt: '2026-11-24T10:00:00.000Z',
      items: [
        {
          botId: 'mail-bot',
          conversationId: 'conv-mail',
          activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
          queuedCount: 0,
          attention: null,
          progress: null,
          lastResult: {
            id: '10',
            completedAt: '2026-11-24T09:50:00.000Z',
            summary: '有新的邮件或日程待查看',
            kind: 'proactive-google',
          },
        },
      ],
      errors: [],
    }),
  });

  h.controller.start();
  await settle();

  // Cold start records id='10' as baseline and stays calm.
  assert.equal(h.controller.snapshot().connection, 'ready');
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Refresh with the same baseline id='10' must still not pop.
  await h.controller.handleAction({ id: 'r1', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // A brand-new proactive-google result arrives with blank summary (uses desensitized fallback).
  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:05:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '11',
          completedAt: '2026-11-24T10:05:00.000Z',
          summary: '',
          kind: 'proactive-google',
        },
      },
    ],
    errors: [],
  }));

  await h.controller.handleAction({ id: 'r2', kind: 'refresh' });
  assert.deepEqual(h.controller.snapshot().proactiveAlert, {
    deviceId: 'remote-device',
    botId: 'mail-bot',
    botName: '邮件助理',
    resultId: '11',
    summary: '有新的邮件或日程待查看',
    completedAt: '2026-11-24T10:05:00.000Z',
  });

  // Never read raw history; only getBotBoard targeted at the bound remote device/bot.
  const boardCalls = h.calls.filter((c) => c.kind === 'call');
  assert.ok(boardCalls.length >= 2);
  assert.ok(boardCalls.every((c) => c.op === 'getBotBoard'));
  assert.equal(boardCalls.at(-1).identity.targetDeviceId, 'remote-device');
  assert.deepEqual(boardCalls.at(-1).params, { botIds: ['mail-bot'] });

  h.controller.stop();
});

test('non-proactive lastResult is ignored while proactive-google result after empty baseline surfaces', async () => {
  const h = createHarness();
  h.controller.start();
  await settle();
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Normal manual chat reply without kind='proactive-google' must be ignored.
  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:02:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '20',
          completedAt: '2026-11-24T10:02:00.000Z',
          summary: 'Manual reply summary',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r-manual', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Different kind must also be ignored.
  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:03:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '21',
          completedAt: '2026-11-24T10:03:00.000Z',
          summary: 'Webhook update',
          kind: 'webhook',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r-other-kind', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Real proactive-google result surfaces immediately.
  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:04:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '22',
          completedAt: '2026-11-24T10:04:00.000Z',
          summary: '有新的邮件或日程待查看',
          kind: 'proactive-google',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r-proactive', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert?.resultId, '22');

  h.controller.stop();
});

test('open-bot invokes onOpenBot callback, clears alert, and marks result dismissed', async () => {
  const h = createHarness();
  h.controller.start();
  await settle();

  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:10:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '30',
          completedAt: '2026-11-24T10:10:00.000Z',
          summary: '有新的邮件或日程待查看',
          kind: 'proactive-google',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r1', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert?.resultId, '30');

  const res = await h.controller.handleAction({
    id: 'open-1',
    kind: 'open-bot',
    deviceId: 'remote-device',
    botId: 'mail-bot',
  });
  assert.deepEqual(res, { id: 'open-1', ok: true });
  assert.deepEqual(h.openedBots, [{ deviceId: 'remote-device', botId: 'mail-bot' }]);
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Subsequent poll with the same resultId must not re-pop.
  await h.controller.handleAction({ id: 'r2', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  h.controller.stop();
});

test('dismiss-proactive-alert suppresses current resultId without blocking newer proactive results', async () => {
  const h = createHarness();
  h.controller.start();
  await settle();

  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:20:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '40',
          completedAt: '2026-11-24T10:20:00.000Z',
          summary: '有新的邮件或日程待查看',
          kind: 'proactive-google',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r1', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert?.resultId, '40');

  const dismissed = await h.controller.handleAction({
    id: 'dismiss-1',
    kind: 'dismiss-proactive-alert',
    resultId: '40',
  });
  assert.deepEqual(dismissed, { id: 'dismiss-1', ok: true });
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Polling same resultId stays dismissed.
  await h.controller.handleAction({ id: 'r2', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Newer resultId surfaces cleanly.
  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T10:30:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '41',
          completedAt: '2026-11-24T10:30:00.000Z',
          summary: '有新的邮件或日程待查看',
          kind: 'proactive-google',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r3', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert?.resultId, '41');

  h.controller.stop();
});

test('periodic polling surfaces new proactive alerts automatically', async () => {
  let step = 0;
  const h = createHarness({
    proactivePollIntervalMs: 50,
    boardResponse: () => {
      step += 1;
      return {
        updatedAt: '2026-11-24T11:00:00.000Z',
        items: [
          {
            botId: 'mail-bot',
            conversationId: 'conv-mail',
            activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
            queuedCount: 0,
            attention: null,
            progress: null,
            lastResult: step >= 2
              ? {
                  id: '50',
                  completedAt: '2026-11-24T11:00:00.000Z',
                  summary: '有新的邮件或日程待查看',
                  kind: 'proactive-google',
                }
              : null,
          },
        ],
        errors: [],
      };
    },
  });

  h.controller.start();
  await settle();
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  await sleep(120);
  assert.equal(h.controller.snapshot().proactiveAlert?.resultId, '50');

  h.controller.stop();
});

test('older Center 404, disabled assistant, or offline getBotBoard fails soft without disrupting pet state', async () => {
  const h = createHarness({
    assistantResponse: () => {
      const err = new Error('Not Found');
      err.code = 'NOT_FOUND';
      err.status = 404;
      throw err;
    },
  });

  h.controller.start();
  await settle();
  assert.equal(h.controller.snapshot().connection, 'ready');
  assert.equal(h.controller.snapshot().error, null);
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Board RPC failure also fails soft.
  h.setAssistantResponse(() => ({
    assistant: {
      enabled: true,
      deviceId: 'remote-device',
      botId: 'mail-bot',
      mode: 'dedicated',
      accounts: ['user@example.com'],
    },
  }));
  h.setBoardResponse(() => {
    throw { code: 'OFFLINE', outcome: 'not-sent', message: 'Target host offline' };
  });

  await h.controller.handleAction({ id: 'r-offline', kind: 'refresh' });
  assert.equal(h.controller.snapshot().connection, 'ready');
  assert.equal(h.controller.snapshot().error, null);
  assert.equal(h.controller.snapshot().proactiveAlert, null);

  // Disabling assistant clears any previously surfaced proactive alert.
  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T11:10:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: null,
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r-base', kind: 'refresh' });

  h.setBoardResponse(() => ({
    updatedAt: '2026-11-24T11:11:00.000Z',
    items: [
      {
        botId: 'mail-bot',
        conversationId: 'conv-mail',
        activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
        queuedCount: 0,
        attention: null,
        progress: null,
        lastResult: {
          id: '60',
          completedAt: '2026-11-24T11:11:00.000Z',
          summary: '有新的邮件或日程待查看',
          kind: 'proactive-google',
        },
      },
    ],
    errors: [],
  }));
  await h.controller.handleAction({ id: 'r-pop', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert?.resultId, '60');

  h.setAssistantResponse(() => ({
    assistant: {
      enabled: false,
      deviceId: 'remote-device',
      botId: 'mail-bot',
      mode: 'dedicated',
      accounts: [],
    },
  }));
  await h.controller.handleAction({ id: 'r-disabled', kind: 'refresh' });
  assert.equal(h.controller.snapshot().proactiveAlert, null);
  assert.equal(h.controller.snapshot().connection, 'ready');

  h.controller.stop();
});
