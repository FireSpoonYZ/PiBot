import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { operations } from '../../center-contract/operations/automation.js';
import { createHandlers } from '../../center-server/operations/automation.js';
import { openOperations } from '../../center-server/operations/index.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { registerTaskRoutes } from '../../center-server/tasks.js';
import { registerWebhookRoutes } from '../../center-server/webhooks.js';
import { openHost } from '../../host-core/host.js';
import { createScheduleManager } from '../../host-core/host-schedules.js';
import { zonedWallTimeToEpochMs } from '../../host-core/schedule-calendar.js';

const BOT_COORD = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-coord' };
const BOT_WORKER = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-worker' };
const OAUTH_CLIENT = { kind: 'oauth', clientId: 'oauth-client-1' };
const SAMPLE_UUID = '11111111-1111-4111-8111-111111111111';

function createAutomationHarness() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-ops-automation-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(9) });
  store.replaceDeviceBots('dev-1', [
    { deviceId: 'dev-1', botId: 'bot-coord', name: 'CoordBot', isPrimary: true },
    { deviceId: 'dev-1', botId: 'bot-worker', name: 'WorkerBot', isPrimary: false },
  ]);
  store.replaceDeviceBots('dev-2', [
    { deviceId: 'dev-2', botId: 'bot-remote', name: 'RemoteBot', isPrimary: true },
  ]);

  const registryEntries = new Map([
    ['dev-1', { deviceId: 'dev-1', displayName: 'Device One', platform: 'linux', revokedAt: null }],
    ['dev-2', { deviceId: 'dev-2', displayName: 'Device Two', platform: 'windows', revokedAt: null }],
    ['dev-revoked', { deviceId: 'dev-revoked', displayName: 'Revoked', platform: 'linux', revokedAt: '2026-01-01T00:00:00.000Z' }],
  ]);

  const bridgeCalls = [];
  const bridge = {
    deviceId: 'center-internal-relay',
    registry: {
      get: (id) => registryEntries.get(id) || null,
      list: () => [...registryEntries.values()],
    },
    listDevices: () => [
      { deviceId: 'dev-1', name: 'Device One', online: true },
      { deviceId: 'dev-2', name: 'Device Two', online: true },
    ],
    async call(targetDeviceId, method, params) {
      bridgeCalls.push({ targetDeviceId, method, params });
      if (method === 'scheduleTask') {
        return {
          ok: true,
          deviceId: targetDeviceId,
          botId: params.botId,
          action: params.input.action,
          input: params.input,
        };
      }
      throw Object.assign(new Error(`Unexpected RPC method: ${method}`), { code: 'FORBIDDEN' });
    },
  };

  const ownerRoutes = new Map();
  const ownerCalls = [];
  const notifications = [];
  const route = (method, pattern, handler) => {
    ownerRoutes.set(`${method} ${pattern}`, handler);
  };
  const host = () => {};
  const appStub = {
    post() {},
    rateLimit() {
      return () => {};
    },
  };

  registerWebhookRoutes(appStub, {
    store,
    bridge,
    route,
    host,
    publicUrl: 'https://center.example.com/',
    notify: (deviceId) => notifications.push({ deviceId, event: 'webhook-ready' }),
  });

  registerTaskRoutes({
    route,
    host,
    store,
    bridge,
    packages: {},
    notify: (deviceId, event) => notifications.push({ deviceId, event }),
    notifyConfig: (deviceId) => notifications.push({ deviceId, event: 'config-changed' }),
    notifyTaskReady: (deviceId) => notifications.push({ deviceId, event: 'task-ready' }),
    isAbsolutePath: () => true,
  });

  const owner = async (method, pattern, { params = {}, body, query = {} } = {}) => {
    ownerCalls.push({ method, pattern, params, body, query });
    const handler = ownerRoutes.get(`${method} ${pattern}`);
    if (!handler) {
      throw Object.assign(new Error(`Unknown owner route: ${method} ${pattern}`), { code: 'NOT_FOUND' });
    }
    let statusCode = 200;
    let sent = false;
    let sentValue;
    const reply = {
      code(code) {
        statusCode = code;
        return reply;
      },
      send(payload) {
        sent = true;
        sentValue = payload;
        return payload;
      },
    };
    const returned = await handler({ params, body, query }, reply);
    const value = sent ? sentValue : returned;
    if (statusCode >= 400) {
      const code = value?.error?.code || 'INTERNAL_ERROR';
      throw Object.assign(new Error(value?.error?.message || code), { code });
    }
    return value;
  };

  const handlers = createHandlers({
    owner,
    store,
    bridge,
    notifyTaskReady: (deviceId) => notifications.push({ deviceId, event: 'task-ready' }),
  });

  return {
    store,
    owner,
    bridge,
    bridgeCalls,
    ownerCalls,
    notifications,
    handlers,
    close() {
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('automation contract descriptors and handlers match 1-to-1 and exclude forbidden actions', () => {
  const names = operations.map((op) => op.name);
  assert.equal(new Set(names).size, names.length, 'operation names must be unique');
  assert.ok(names.length >= 15);
  for (const op of operations) {
    assert.match(op.name, /^automation_(schedule|task|webhook|google_rule|google_assistant)_/);
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 0);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    if (op.readOnly) {
      assert.equal(op.destructive, false, `${op.name} cannot be both readOnly and destructive`);
    }
    assert.equal(op.inputSchema?.type, 'object');
  }

  const handlers = createHandlers({});
  assert.deepEqual(Object.keys(handlers).sort(), [...names].sort());

  // Excluded unsafe / approval / secret-issuing operations must never appear.
  const forbiddenFragments = [
    'confirm_plan',
    'answer_prompt',
    'resolve_adoption_scope',
    'dismiss_adoption',
    'webhook_create',
    'rotate_token',
    'request_exact_alarm',
  ];
  for (const fragment of forbiddenFragments) {
    assert.equal(
      names.some((name) => name.includes(fragment)),
      false,
      `Forbidden operation fragment exposed: ${fragment}`,
    );
  }
});

test('all automation handlers reject missing, invalid, or spoofed actors', async () => {
  const env = createAutomationHarness();
  try {
    await assert.rejects(
      () => env.handlers.automation_task_list({}, null),
      (err) => err?.code === 'UNAUTHENTICATED',
    );
    await assert.rejects(
      () => env.handlers.automation_task_list({}, { kind: 'owner' }),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_task_create({ requirement: 'test', actor: { kind: 'owner' } }, BOT_COORD),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => env.handlers.automation_task_create({ requirement: 'test', actorBotId: 'bot-coord' }, BOT_WORKER),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
  } finally {
    env.close();
  }
});

test('automation_schedule_* calls fixed Host scheduleTask RPC with strict targeting and CAS validation', async () => {
  const env = createAutomationHarness();
  try {
    // Bot defaults to its own deviceId and botId.
    const listed = await env.handlers.automation_schedule_list({}, BOT_COORD);
    assert.equal(listed.deviceId, 'dev-1');
    assert.equal(listed.botId, 'bot-coord');
    assert.equal(listed.action, 'list');
    assert.equal(env.bridgeCalls.at(-1).method, 'scheduleTask');

    // Bot targeting another device must specify botId explicitly.
    await assert.rejects(
      () => env.handlers.automation_schedule_list({ deviceId: 'dev-2' }, BOT_COORD),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // OAuth must supply both deviceId and botId explicitly.
    await assert.rejects(
      () => env.handlers.automation_schedule_list({ deviceId: 'dev-1' }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Internal relay deviceId and revoked device are rejected.
    await assert.rejects(
      () => env.handlers.automation_schedule_list({ deviceId: 'center-internal-relay', botId: 'bot-coord' }, OAUTH_CLIENT),
      (err) => err?.code === 'NOT_FOUND',
    );
    await assert.rejects(
      () => env.handlers.automation_schedule_list({ deviceId: 'dev-revoked', botId: 'bot-coord' }, OAUTH_CLIENT),
      (err) => err?.code === 'NOT_FOUND',
    );

    // Create, update (CAS), setEnabled (CAS), delete (CAS)
    const created = await env.handlers.automation_schedule_create({
      deviceId: 'dev-2',
      botId: 'bot-remote',
      title: 'Daily Standup',
      prompt: 'Summarize open work',
      repeat: 'daily',
      time: '09:30',
      skills: ['daily-report'],
    }, OAUTH_CLIENT);
    assert.equal(created.deviceId, 'dev-2');
    assert.equal(created.botId, 'bot-remote');
    assert.equal(created.action, 'create');
    assert.deepEqual(created.input.skills, ['daily-report']);

    await assert.rejects(
      () => env.handlers.automation_schedule_update({ id: SAMPLE_UUID, revision: 1 }, BOT_COORD),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    const updated = await env.handlers.automation_schedule_update({
      id: SAMPLE_UUID,
      revision: 1,
      title: 'Daily Standup v2',
    }, BOT_COORD);
    assert.equal(updated.action, 'update');
    assert.equal(updated.input.revision, 1);

    const toggled = await env.handlers.automation_schedule_set_enabled({
      id: SAMPLE_UUID,
      revision: 2,
      enabled: false,
    }, BOT_COORD);
    assert.equal(toggled.action, 'setEnabled');
    assert.equal(toggled.input.enabled, false);

    const deleted = await env.handlers.automation_schedule_delete({
      id: SAMPLE_UUID,
      revision: 3,
    }, BOT_COORD);
    assert.equal(deleted.action, 'delete');
    assert.equal(deleted.input.revision, 3);

    // Invalid time rejected by schedule-protocol.
    await assert.rejects(
      () => env.handlers.automation_schedule_create({
        title: 'Bad',
        prompt: 'Bad time',
        repeat: 'daily',
        time: '25:00',
      }, BOT_COORD),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Direct handler call also rejects date:null on create, invalid calendar dates, and non-once dates.
    await assert.rejects(
      () => env.handlers.automation_schedule_create({
        title: 'Null Date',
        prompt: 'Should fail on create',
        repeat: 'once',
        time: '09:00',
        date: null,
      }, BOT_COORD),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
  } finally {
    env.close();
  }
});

test('openOperations exposes dated one-shot schedule create/update with schema, Host receipt, CAS, and auth enforcement', async (t) => {
  const fixedNow = Date.parse('2026-12-31T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: fixedNow });

  const env = createAutomationHarness();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-dated-'));
  const host = openHost({ dataRoot });
  const bot = host.createBot({ requestId: 'test-schedule', role: 'Test', cwd: dataRoot, makePrimary: true });
  const schedules = createScheduleManager({ host, getRuntime: () => null, isOnline: () => true });
  schedules.start();
  try {
    const target = { deviceId: host.deviceId, botId: bot.botId };
    let calls = 0;
    const ops = openOperations({ store: env.store, owner: env.owner, bridge: {
      async call(deviceId, method, params) {
        calls++;
        assert.equal(deviceId, host.deviceId);
        assert.equal(method, 'scheduleTask');
        assert.equal(params.botId, target.botId);
        return schedules.execute(bot, params.input);
      },
    } });
    const botActor = { kind: 'bot', ...target };
    const oauth = { kind: 'oauth', clientId: 'calendar' };
    const create = { title: 'Leap Day', prompt: 'Review', repeat: 'once', time: '20:00', date: '2028-02-29' };
    await assert.rejects(ops.call({ ...oauth, scopes: ['pibot:automation:read'] },
      'automation_schedule_create', { ...target, ...create }), { code: 'FORBIDDEN' });
    assert.equal(calls, 0);
    const created = await ops.call(botActor, 'automation_schedule_create', create);
    assert.equal(created.task.date, create.date);
    assert.equal(created.task.nextRunAt, zonedWallTimeToEpochMs(2028, 2, 29, 20, 0, created.timeZone));
    const update = (actor, patch) => ops.call(actor, 'automation_schedule_update', { ...target,
      id: created.task.id, revision: created.task.revision, ...patch });
    const changed = await update({ ...oauth, scopes: ['pibot:automation:write'] }, { date: '2028-03-01' });
    assert.equal(changed.task.date, '2028-03-01');
    await assert.rejects(update(botActor, { date: null }), { code: 'REQUEST_CONFLICT' });
    for (const patch of [{ date: '2027-02-29' }, { repeat: 'daily', date: create.date }]) {
      await assert.rejects(update(botActor, { revision: changed.task.revision, ...patch }), { code: 'INVALID_ARGUMENT' });
    }
    const cleared = await update(botActor, { revision: changed.task.revision, date: null });
    assert.equal(Object.hasOwn(cleared.task, 'date'), false);
    for (const date of [null, '2028/2/29', '2027-02-29', '2025-01-01']) {
      await assert.rejects(ops.call(botActor, 'automation_schedule_create', { ...create, date }), { code: 'INVALID_ARGUMENT' });
    }
  } finally {
    await schedules.close();
    host.close();
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    env.close();
  }
});

test('automation_task_* enforces real Bot actor permissions and strict CAS', async () => {
  const env = createAutomationHarness();
  try {
    // Bot creates task using its real Bot identity (origin=chat, coordinator=self).
    const created = await env.handlers.automation_task_create({
      title: 'Release Checklist',
      requirement: 'Verify build artifacts and release notes',
      directStart: true,
      steps: [
        { id: 'step-worker', text: 'Check artifacts', deviceId: 'dev-1', botId: 'bot-worker', status: 'todo' },
        { id: 'step-coord', text: 'Approve checklist', deviceId: 'dev-1', botId: 'bot-coord', status: 'todo' },
      ],
    }, BOT_COORD);
    const task = created.task;
    assert.equal(task.origin.kind, 'chat');
    assert.equal(task.origin.botId, 'bot-coord');
    assert.equal(task.coordinatorDeviceId, 'dev-1');
    assert.equal(task.coordinatorBotId, 'bot-coord');
    assert.equal(task.status, 'working');

    // List and get read paths work for both Bot and OAuth.
    const listed = await env.handlers.automation_task_list({ status: 'active', botId: 'bot-worker', limit: 10 }, BOT_WORKER);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, task.id);

    const fetched = await env.handlers.automation_task_get({ taskId: task.id }, OAUTH_CLIENT);
    assert.equal(fetched.task.id, task.id);

    // Worker Bot cannot modify task title, assign coordinator, delete task, or patch another Bot's step.
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: task.id,
        expectedRevision: task.revision,
        title: 'Hijacked',
      }, BOT_WORKER),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: task.id,
        expectedRevision: task.revision,
        stepPatches: [{ stepId: 'step-coord', status: 'done' }],
      }, BOT_WORKER),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_task_assign({
        taskId: task.id,
        expectedRevision: task.revision,
        coordinatorDeviceId: 'dev-1',
        coordinatorBotId: 'bot-worker',
      }, BOT_WORKER),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_task_delete({
        taskId: task.id,
        expectedRevision: task.revision,
      }, BOT_WORKER),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Worker Bot CAN patch its own step with strict CAS.
    const workerPatched = await env.handlers.automation_task_update({
      taskId: task.id,
      expectedRevision: task.revision,
      stepPatches: [{ stepId: 'step-worker', status: 'done', resultSummary: 'Artifacts verified' }],
    }, BOT_WORKER);
    assert.equal(workerPatched.task.revision, task.revision + 1);
    assert.equal(workerPatched.task.steps.find((s) => s.id === 'step-worker').status, 'done');

    // Stale expectedRevision fails with REQUEST_CONFLICT.
    await assert.rejects(
      () => env.handlers.automation_task_assign({
        taskId: task.id,
        expectedRevision: task.revision,
        coordinatorDeviceId: 'dev-2',
        coordinatorBotId: 'bot-remote',
      }, BOT_COORD),
      (err) => err?.code === 'REQUEST_CONFLICT',
    );

    // Coordinator can reassign and delete with latest revision.
    const reassigned = await env.handlers.automation_task_assign({
      taskId: task.id,
      expectedRevision: workerPatched.task.revision,
      coordinatorDeviceId: 'dev-2',
      coordinatorBotId: 'bot-remote',
    }, BOT_COORD);
    assert.equal(reassigned.task.coordinatorDeviceId, 'dev-2');
    assert.equal(reassigned.task.coordinatorBotId, 'bot-remote');

    const deleted = await env.handlers.automation_task_delete({
      taskId: task.id,
      expectedRevision: reassigned.task.revision,
    }, OAUTH_CLIENT);
    assert.equal(deleted.deleted, true);
  } finally {
    env.close();
  }
});

test('automation_task_update blocks OAuth and Bot from forging or bypassing user approvals', async () => {
  const env = createAutomationHarness();
  try {
    // 1. Task waiting on human plan confirmation.
    const planTaskRes = await env.handlers.automation_task_create({
      title: 'Deploy Plan',
      requirement: 'Deploy production release',
      coordinatorDeviceId: 'dev-1',
      coordinatorBotId: 'bot-coord',
      steps: [{ id: 'step-deploy', text: 'Deploy', deviceId: 'dev-1', botId: 'bot-coord', status: 'todo' }],
      pendingPrompt: { kind: 'plan', text: 'Approve production deployment plan?' },
    }, OAUTH_CLIENT);
    const planTask = planTaskRes.task;
    assert.equal(planTask.status, 'waiting');
    assert.equal(planTask.pendingPrompt.kind, 'plan');

    // Neither OAuth nor Bot can clear pendingPrompt.
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: planTask.id,
        expectedRevision: planTask.revision,
        pendingPrompt: null,
      }, OAUTH_CLIENT),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: planTask.id,
        expectedRevision: planTask.revision,
        pendingPrompt: null,
      }, BOT_COORD),
      (err) => err?.code === 'FORBIDDEN',
    );

    // OAuth cannot start/complete task or advance steps while plan is unconfirmed.
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: planTask.id,
        expectedRevision: planTask.revision,
        status: 'working',
      }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_STATE',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: planTask.id,
        expectedRevision: planTask.revision,
        stepPatches: [{ stepId: 'step-deploy', status: 'working' }],
      }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_STATE',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: planTask.id,
        expectedRevision: planTask.revision,
        pendingPrompt: { kind: 'question', text: 'Overwrite plan?' },
      }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_STATE',
    );

    // OAuth CAN still update non-bypassing metadata (e.g. title) with strict CAS.
    const renamed = await env.handlers.automation_task_update({
      taskId: planTask.id,
      expectedRevision: planTask.revision,
      title: 'Deploy Plan (Revised Title)',
    }, OAUTH_CLIENT);
    assert.equal(renamed.task.title, 'Deploy Plan (Revised Title)');
    assert.equal(renamed.task.pendingPrompt.kind, 'plan');
    assert.equal(renamed.task.status, 'waiting');

    // 2. Task waiting on human clarification question tied to a waiting step.
    const qTaskRes = await env.handlers.automation_task_create({
      title: 'Clarify Region',
      requirement: 'Provision cluster',
      coordinatorDeviceId: 'dev-1',
      coordinatorBotId: 'bot-coord',
      steps: [{ id: 'step-q', text: 'Pick region', deviceId: 'dev-1', botId: 'bot-coord', status: 'waiting' }],
      pendingPrompt: { kind: 'question', text: 'Which region?', stepId: 'step-q', deviceId: 'dev-1', botId: 'bot-coord' },
    }, OAUTH_CLIENT);
    const qTask = qTaskRes.task;

    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: qTask.id,
        expectedRevision: qTask.revision,
        status: 'working',
      }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_STATE',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: qTask.id,
        expectedRevision: qTask.revision,
        stepPatches: [{ stepId: 'step-q', status: 'working' }],
      }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_STATE',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: qTask.id,
        expectedRevision: qTask.revision,
        steps: [{ id: 'step-other', text: 'Replace waiting step', deviceId: 'dev-1', botId: 'bot-coord', status: 'todo' }],
      }, OAUTH_CLIENT),
      (err) => err?.code === 'INVALID_STATE',
    );

    // 3. Task waiting on human adoption needs_scope decision cannot be resolved via update.
    const scopeTaskRes = await env.handlers.automation_task_create({
      title: 'Scope Check',
      requirement: 'Initial requirement',
      directStart: true,
    }, BOT_COORD);
    const needsScopeRes = await env.handlers.automation_task_update({
      taskId: scopeTaskRes.task.id,
      expectedRevision: scopeTaskRes.task.revision,
      adoption: { phase: 'needs_scope', shortReceipt: 'Need scope', changeText: 'New req', scopeDesc: 'Keep or redo?' },
    }, BOT_COORD);
    assert.equal(needsScopeRes.task.adoption.phase, 'needs_scope');

    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: scopeTaskRes.task.id,
        expectedRevision: needsScopeRes.task.revision,
        adoption: { phase: 'adopted', shortReceipt: 'Forged' },
      }, OAUTH_CLIENT),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_task_update({
        taskId: scopeTaskRes.task.id,
        expectedRevision: needsScopeRes.task.revision,
        adoption: { phase: 'adopted', shortReceipt: 'Forged by bot' },
      }, BOT_COORD),
      (err) => err?.code === 'FORBIDDEN',
    );
  } finally {
    env.close();
  }
});

test('automation_webhook_* supports read/update/rebind/delete while never issuing or exposing tokens', async () => {
  const env = createAutomationHarness();
  try {
    const secretToken = randomBytes(32).toString('base64url');
    const seededRoute = env.store.createWebhookRoute({
      name: 'CI Hook',
      deviceId: 'dev-1',
      botId: 'bot-coord',
      instruction: 'Inspect CI failure',
      enabled: true,
    }, secretToken);
    env.store.acceptWebhookEvent(
      seededRoute.id,
      secretToken,
      'idem-001',
      JSON.stringify({ buildId: 42, secretLikePayload: 'do-not-leak' }),
    );

    // List webhooks: includes url and metadata, never exposes token/token_hash.
    const listed = await env.handlers.automation_webhook_list({}, OAUTH_CLIENT);
    assert.equal(listed.items.length, 1);
    const route = listed.items[0];
    assert.equal(route.id, seededRoute.id);
    assert.equal(route.url, `https://center.example.com/api/webhooks/${seededRoute.id}/events`);
    assert.equal('token' in route, false);
    assert.equal('token_hash' in route, false);
    assert.equal(JSON.stringify(listed).includes(secretToken), false);

    // List recent webhook events: excludes token and raw payload.
    const events = await env.handlers.automation_webhook_events_list({ id: seededRoute.id }, BOT_COORD);
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0].idempotencyKey, 'idem-001');
    assert.equal('payload' in events.items[0], false);
    assert.equal(JSON.stringify(events).includes('do-not-leak'), false);
    assert.equal(JSON.stringify(events).includes(secretToken), false);

    // Supplying token fields remains strictly forbidden.
    await assert.rejects(
      () => env.handlers.automation_webhook_update({
        id: seededRoute.id,
        token: 'attacker-token',
      }, OAUTH_CLIENT),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Scoped OAuth caller cannot rebind webhook to an unauthorized target Bot.
    const scopedOAuth = {
      kind: 'oauth',
      clientId: 'oauth-scoped',
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-coord' }],
    };
    await assert.rejects(
      () => env.handlers.automation_webhook_update({
        id: seededRoute.id,
        deviceId: 'dev-2',
        botId: 'bot-remote',
      }, scopedOAuth),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Rebinding target deviceId/botId succeeds for authorized callers and validates target existence.
    await assert.rejects(
      () => env.handlers.automation_webhook_update({
        id: seededRoute.id,
        deviceId: 'dev-2',
        botId: 'bot-missing',
      }, OAUTH_CLIENT),
      (err) => err?.code === 'BOT_NOT_FOUND',
    );
    const rebound = await env.handlers.automation_webhook_update({
      id: seededRoute.id,
      deviceId: 'dev-2',
      botId: 'bot-remote',
    }, BOT_COORD);
    assert.equal(rebound.deviceId, 'dev-2');
    assert.equal(rebound.botId, 'bot-remote');
    assert.equal(rebound.name, 'CI Hook');
    assert.equal('token' in rebound, false);

    // Safe partial update modifies instruction & enabled while preserving current target deviceId/botId.
    const updated = await env.handlers.automation_webhook_update({
      id: seededRoute.id,
      instruction: 'Inspect CI failure and summarize',
      enabled: false,
    }, OAUTH_CLIENT);
    assert.equal(updated.name, 'CI Hook');
    assert.equal(updated.instruction, 'Inspect CI failure and summarize');
    assert.equal(updated.enabled, false);
    assert.equal(updated.deviceId, 'dev-2');
    assert.equal(updated.botId, 'bot-remote');
    assert.equal('token' in updated, false);

    // Disabling cancels pending undelivered events.
    const afterDisableEvents = await env.handlers.automation_webhook_events_list({ id: seededRoute.id }, OAUTH_CLIENT);
    assert.equal(afterDisableEvents.items[0].status, 'cancelled');

    // Delete webhook route cleanly.
    const deleted = await env.handlers.automation_webhook_delete({ id: seededRoute.id }, OAUTH_CLIENT);
    assert.deepEqual(deleted, { deleted: true, id: seededRoute.id });

    const afterDelete = await env.handlers.automation_webhook_list({}, OAUTH_CLIENT);
    assert.equal(afterDelete.items.length, 0);

    // Verify only allowed hardcoded owner route patterns were ever invoked.
    const allowedPatterns = new Set([
      'GET /api/tasks',
      'POST /api/tasks/action',
      'GET /api/webhooks',
      'GET /api/webhooks/:id/events',
      'PUT /api/webhooks/:id',
      'DELETE /api/webhooks/:id',
    ]);
    for (const call of env.ownerCalls) {
      assert.ok(
        allowedPatterns.has(`${call.method} ${call.pattern}`),
        `Unexpected owner route invoked: ${call.method} ${call.pattern}`,
      );
    }
  } finally {
    env.close();
  }
});
