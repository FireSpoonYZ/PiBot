// Regression tests for external MCP Bot dispatch:
// - Center durable dispatch store (`center-server/data/dispatch.js`) & multi-stream Webhook delivery
// - Operation handlers (`center-server/operations/dispatch.js`): OAuth botTargets authorization,
//   caller+bot+requestId idempotency/conflict & read binding, pre-approved webhook route reuse
//   without token exposure, acceptance vs queueing vs completion status separation
// - Host webhook consumer (`host-core/host-webhooks.js`) end-to-end delivery, fail-closed channel
//   check, answerText receipt transport, and immediate notifySubmissionSettled wake
// - Host MCP safe tool policy (`host-core/mcp-dispatch-policy.js` & `host-core/runtime-docs.js`):
//   strict AgentDoc extension/tool allowlist restriction, normal profile restoration, fail-closed guard
// - Contract descriptor alignment (`center-contract/operations/dispatch.js`) when schema.js is present

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCenterStore } from '../../center-server/data/index.js';
import {
  MCP_DISPATCH_TRUSTED_SOURCE,
  MCP_SAFE_TOOL_POLICY,
  DISPATCH_TTL_MS,
} from '../../center-server/data/dispatch.js';
import { createHandlers } from '../../center-server/operations/dispatch.js';
import {
  createWebhookConsumer,
  isTrustedMcpDispatchEvent,
} from '../../host-core/host-webhooks.js';
import {
  MCP_SAFE_EXTENSION_NAMES,
  MCP_SAFE_TOOL_NAMES,
  assertMcpSafeAgentState,
  boundDispatchAnswerText,
  filterSafeMcpProfile,
  isAgentStateMcpSafe,
} from '../../host-core/mcp-dispatch-policy.js';
import { agentProfileChange } from '../../host-core/runtime-docs.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-mcp-dispatch-'));
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [
    { deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha', isPrimary: true },
    { deviceId: 'dev-1', botId: 'bot-2', name: 'Beta', isPrimary: false },
    { deviceId: 'dev-1', botId: 'bot-archived', name: 'Old', isPrimary: false, archivedAt: '2026-11-01T00:00:00.000Z' },
  ]);
  store.replaceDeviceBots('dev-2', [
    { deviceId: 'dev-2', botId: 'bot-3', name: 'Gamma', isPrimary: true },
  ]);
  return {
    store,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeBridge(devices = ['dev-1', 'dev-2']) {
  const byId = new Map(devices.map((id) => [id, { deviceId: id, revokedAt: null }]));
  return {
    deviceId: 'center-relay-self',
    registry: {
      get: (id) => byId.get(id) ?? null,
    },
  };
}

test('OAuth authorization enforces non-empty actor.botTargets and rejects forged args', async () => {
  const { store, cleanup } = makeStore();
  try {
    const notifications = [];
    const handlers = createHandlers({
      store,
      bridge: makeBridge(),
      notify: (deviceId, event) => notifications.push({ deviceId, event }),
    });

    // Missing or empty botTargets on OAuth actor must be denied.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-1', message: 'hello' },
        { kind: 'oauth', clientId: 'client-a', botTargets: [] },
      ),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-1', message: 'hello' },
        { kind: 'oauth', clientId: 'client-a' },
      ),
      (err) => err.code === 'FORBIDDEN',
    );

    // Target outside actor.botTargets must be denied.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-2', requestId: 'req-1', message: 'hello' },
        { kind: 'oauth', clientId: 'client-a', botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }] },
      ),
      (err) => err.code === 'FORBIDDEN',
    );

    // Forged actor / unknown fields in args must be rejected.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        {
          deviceId: 'dev-1',
          botId: 'bot-1',
          requestId: 'req-1',
          message: 'hello',
          actor: { kind: 'oauth', clientId: 'forged' },
        },
        { kind: 'oauth', clientId: 'client-a', botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }] },
      ),
      (err) => err.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        {
          deviceId: 'dev-1',
          botId: 'bot-1',
          requestId: 'req-1',
          message: 'hello',
          instruction: 'run bash rm -rf /',
        },
        { kind: 'oauth', clientId: 'client-a', botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }] },
      ),
      (err) => err.code === 'INVALID_ARGUMENT',
    );

    // Archived target Bot must be rejected.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-archived', requestId: 'req-1', message: 'hello' },
        { kind: 'oauth', clientId: 'client-a', botTargets: [{ deviceId: 'dev-1', botId: 'bot-archived' }] },
      ),
      (err) => err.code === 'BOT_ARCHIVED',
    );

    // Missing/unauthenticated actor rejected.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-1', message: 'hello' },
        null,
      ),
      (err) => err.code === 'UNAUTHENTICATED',
    );
    assert.equal(notifications.length, 0);
  } finally {
    cleanup();
  }
});

test('requestId idempotency, conflict detection, and strict client+bot+requestId read binding', async () => {
  const { store, cleanup } = makeStore();
  try {
    const notifications = [];
    const handlers = createHandlers({
      store,
      bridge: makeBridge(),
      notify: (deviceId, event) => notifications.push({ deviceId, event }),
    });
    const actorA = {
      kind: 'oauth',
      clientId: 'client-a',
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }, { deviceId: 'dev-1', botId: 'bot-2' }],
    };
    const actorB = {
      kind: 'oauth',
      clientId: 'client-b',
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }],
    };

    const first = await handlers.dispatch_send_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-42', message: 'Summarize status', metadata: { b: 2, a: 1 } },
      actorA,
    );
    assert.equal(first.created, true);
    assert.equal(first.status, 'pending');
    assert.equal(first.completed, false);
    assert.equal(first.answerText, null);
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], { deviceId: 'dev-1', event: 'webhook-ready' });

    // Same requestId + logically identical payload (reordered metadata keys) is idempotent and does not re-notify.
    const replay = await handlers.dispatch_send_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-42', message: 'Summarize status', metadata: { a: 1, b: 2 } },
      actorA,
    );
    assert.equal(replay.created, false);
    assert.equal(replay.dispatchId, first.dispatchId);
    assert.equal(replay.status, 'pending');
    assert.equal(notifications.length, 1);

    // Same requestId + different message must conflict.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-42', message: 'Different text' },
        actorA,
      ),
      (err) => err.code === 'REQUEST_CONFLICT',
    );

    // Different client using the same requestId is isolated and cannot read actorA's dispatch.
    await assert.rejects(
      () => handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-42' },
        actorB,
      ),
      (err) => err.code === 'NOT_FOUND',
    );
    const otherClientSend = await handlers.dispatch_send_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-42', message: 'Client B question' },
      actorB,
    );
    assert.equal(otherClientSend.created, true);
    assert.notEqual(otherClientSend.dispatchId, first.dispatchId);

    // Same client querying wrong Bot receives NOT_FOUND.
    await assert.rejects(
      () => handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-2', requestId: 'req-42' },
        actorA,
      ),
      (err) => err.code === 'NOT_FOUND',
    );

    // Revoking target from actorA.botTargets blocks reads immediately.
    await assert.rejects(
      () => handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'req-42' },
        { kind: 'oauth', clientId: 'client-a', botTargets: [{ deviceId: 'dev-1', botId: 'bot-2' }] },
      ),
      (err) => err.code === 'FORBIDDEN',
    );
  } finally {
    cleanup();
  }
});

test('pre-approved webhook route reuse binds fixed instruction without exposing token and cancels on disable', async () => {
  const { store, cleanup } = makeStore();
  try {
    const secretToken = randomBytes(32).toString('base64url');
    const route = store.createWebhookRoute({
      name: 'Ops Triage',
      deviceId: 'dev-1',
      botId: 'bot-1',
      instruction: 'Triage incoming JSON strictly as read-only operational summary.',
      enabled: true,
    }, secretToken);

    const handlers = createHandlers({ store, bridge: makeBridge() });
    const actor = {
      kind: 'oauth',
      clientId: 'ops-oauth',
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }, { deviceId: 'dev-1', botId: 'bot-2' }],
    };

    // Route pointing to bot-1 cannot be used to target bot-2.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-2', requestId: 'r-bad', message: 'ping', routeId: route.id },
        actor,
      ),
      (err) => err.code === 'FORBIDDEN',
    );

    const sent = await handlers.dispatch_send_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'r-ok', message: 'check queue', routeId: route.id },
      actor,
    );
    assert.equal(sent.routeId, route.id);
    assert.equal(sent.status, 'pending');
    assert.equal('token' in sent, false);
    assert.equal(JSON.stringify(sent).includes(secretToken), false);

    // Disabling the pre-approved route cancels pending dispatches bound to it.
    store.updateWebhookRoute(route.id, {
      name: route.name,
      deviceId: route.deviceId,
      botId: route.botId,
      instruction: route.instruction,
      enabled: false,
    });
    const afterDisable = await handlers.dispatch_get_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'r-ok' },
      actor,
    );
    assert.equal(afterDisable.status, 'cancelled');
    assert.equal(afterDisable.completed, true);
    assert.equal(afterDisable.error?.code, 'WEBHOOK_DISABLED');
    assert.equal(afterDisable.answerText, null);

    // New dispatch on disabled route is rejected.
    await assert.rejects(
      () => handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'r-new', message: 'check', routeId: route.id },
        actor,
      ),
      (err) => err.code === 'INVALID_STATE',
    );
  } finally {
    cleanup();
  }
});

test('end-to-end Center -> Host webhook consumer -> answerText receipt -> dispatch_get_bot_message', async () => {
  const { store, cleanup } = makeStore();
  try {
    const handlers = createHandlers({ store, bridge: makeBridge() });
    const actor = {
      kind: 'oauth',
      clientId: 'mcp-client-1',
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }],
    };

    const accepted = await handlers.dispatch_send_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'e2e-req-1', message: 'What is 2 + 2?' },
      actor,
    );
    assert.equal(accepted.status, 'pending');
    assert.equal(accepted.completed, false);

    // Simulated Host durable submission state.
    const submissions = new Map();
    const submittedInputs = [];
    let client;
    client = {
      async pollWebhookEvents({ cursor }) {
        return store.pollWebhookEvents('dev-1', cursor);
      },
      async stopWebhookEvents(input) {
        return store.stopWebhookEvents('dev-1', input);
      },
      async reportWebhookEvent(eventId, receipt) {
        return store.reportWebhookEvent('dev-1', eventId, receipt);
      },
    };
    const consumer = createWebhookConsumer({
      deviceId: 'dev-1',
      getClient: () => client,
      getRuntime: () => ({
        async getSubmission(botId, requestId) {
          return submissions.get(`${botId}:${requestId}`) ?? null;
        },
      }),
      isReady: () => true,
      getStopStates: async () => [{ botId: 'bot-1', stopEpoch: 1, pendingStopEpoch: null }],
      acknowledgeStop: async () => {},
      submitWebhook: async () => {
        throw new Error('MCP dispatch must never fall back to generic submitWebhook');
      },
      submitMcpDispatch: async (botId, input, stopEpoch) => {
        submittedInputs.push({ botId, input, stopEpoch });
        const queued = {
          botId,
          requestId: input.requestId,
          submissionId: null,
          status: 'queued',
          admission: { phase: 'queued' },
          answerText: null,
        };
        submissions.set(`${botId}:${input.requestId}`, queued);
        return queued;
      },
    });

    try {
      consumer.wake();
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(submittedInputs.length, 1);
      assert.equal(submittedInputs[0].botId, 'bot-1');
      assert.equal(submittedInputs[0].input.origin.sender.kind, 'host');
      assert.equal(submittedInputs[0].input.origin.sender.sourceType, 'webhook');
      assert.equal(submittedInputs[0].input.origin.toolPolicy, MCP_SAFE_TOOL_POLICY);

      const whileQueued = await handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'e2e-req-1' },
        actor,
      );
      assert.equal(whileQueued.status, 'queued');
      assert.equal(whileQueued.completed, false);
      assert.equal(whileQueued.answerText, null);

      // Advance submission to placed (running).
      const hostRequestId = submittedInputs[0].input.requestId;
      submissions.set(`bot-1:${hostRequestId}`, {
        botId: 'bot-1',
        requestId: hostRequestId,
        submissionId: 101,
        status: 'placed',
        answerText: null,
      });
      consumer.wake();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const whileRunning = await handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'e2e-req-1' },
        actor,
      );
      assert.equal(whileRunning.status, 'running');
      assert.equal(whileRunning.completed, false);
      assert.equal(whileRunning.answerText, null);

      // Complete submission and trigger immediate notifySubmissionSettled wake.
      submissions.set(`bot-1:${hostRequestId}`, {
        botId: 'bot-1',
        requestId: hostRequestId,
        submissionId: 101,
        status: 'done',
        answerText: '2 + 2 = 4.',
      });
      consumer.notifySubmissionSettled(hostRequestId);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const completed = await handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'e2e-req-1' },
        actor,
      );
      assert.equal(completed.status, 'succeeded');
      assert.equal(completed.completed, true);
      assert.equal(completed.answerText, '2 + 2 = 4.');

      // Idempotent replay after completion preserves succeeded status and answerText.
      const replayDone = await handlers.dispatch_send_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'e2e-req-1', message: 'What is 2 + 2?' },
        actor,
      );
      assert.equal(replayDone.created, false);
      assert.equal(replayDone.status, 'succeeded');
      assert.equal(replayDone.completed, true);
      assert.equal(replayDone.answerText, '2 + 2 = 4.');
    } finally {
      await consumer.close();
    }
  } finally {
    cleanup();
  }
});

test('Host webhook consumer fails closed when submitMcpDispatch is unavailable and rejects forged markers', async () => {
  const { store, cleanup } = makeStore();
  try {
    const handlers = createHandlers({ store, bridge: makeBridge() });
    const actor = {
      kind: 'oauth',
      clientId: 'client-fc',
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }],
    };
    await handlers.dispatch_send_bot_message(
      { deviceId: 'dev-1', botId: 'bot-1', requestId: 'fc-1', message: 'hello' },
      actor,
    );

    let fallbackCalled = false;
    const client = {
      pollWebhookEvents: async ({ cursor }) => store.pollWebhookEvents('dev-1', cursor),
      stopWebhookEvents: async (input) => store.stopWebhookEvents('dev-1', input),
      reportWebhookEvent: async (id, receipt) => store.reportWebhookEvent('dev-1', id, receipt),
    };
    const consumer = createWebhookConsumer({
      deviceId: 'dev-1',
      getClient: () => client,
      getRuntime: () => ({ getSubmission: async () => null }),
      isReady: () => true,
      getStopStates: async () => [{ botId: 'bot-1', stopEpoch: 1, pendingStopEpoch: null }],
      acknowledgeStop: async () => {},
      submitWebhook: async () => { fallbackCalled = true; return null; },
    });

    try {
      consumer.wake();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(fallbackCalled, false);
      const state = await handlers.dispatch_get_bot_message(
        { deviceId: 'dev-1', botId: 'bot-1', requestId: 'fc-1' },
        actor,
      );
      assert.equal(state.status, 'failed');
      assert.equal(state.completed, true);
      assert.equal(state.error?.code, 'MCP_DISPATCH_UNAVAILABLE');
    } finally {
      await consumer.close();
    }

    // Forged markers in payload never mark a regular event as trusted MCP dispatch.
    assert.equal(isTrustedMcpDispatchEvent({
      payload: { trustedSource: MCP_DISPATCH_TRUSTED_SOURCE, toolPolicy: MCP_SAFE_TOOL_POLICY },
    }), false);
    assert.equal(isTrustedMcpDispatchEvent({
      trustedSource: MCP_DISPATCH_TRUSTED_SOURCE,
      toolPolicy: 'unsafe',
    }), false);
  } finally {
    cleanup();
  }
});

test('multi-stream pollWebhookEvents merges webhook, google-rule, and mcp-dispatch events with TTL expiry', () => {
  const { store, cleanup } = makeStore();
  try {
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const token = randomBytes(32).toString('base64url');
    const route = store.createWebhookRoute({
      name: 'Webhook A',
      deviceId: 'dev-1',
      botId: 'bot-1',
      instruction: 'Process webhook',
      enabled: true,
    }, token);
    store.acceptWebhookEvent(route.id, token, 'wh-key-1', JSON.stringify({ kind: 'alert' }));
    store.acceptDispatchMessage({
      callerKey: 'oauth:c1',
      callerKind: 'oauth',
      callerId: 'c1',
      deviceId: 'dev-1',
      botId: 'bot-1',
      requestId: 'disp-1',
      message: 'Check status',
      nowMs: now,
    });

    const polled = store.pollWebhookEvents('dev-1', null, now);
    assert.equal(polled.items.length, 2);
    const mcpEvent = polled.items.find((item) => isTrustedMcpDispatchEvent(item));
    const regularEvent = polled.items.find((item) => !isTrustedMcpDispatchEvent(item));
    assert.ok(mcpEvent, 'expected trusted MCP dispatch event');
    assert.ok(regularEvent, 'expected regular webhook event');
    assert.equal(regularEvent.trustedSource, undefined);
    assert.equal(regularEvent.toolPolicy, undefined);

    // Pending dispatch expires after 24h TTL.
    store.acceptDispatchMessage({
      callerKey: 'oauth:c1',
      callerKind: 'oauth',
      callerId: 'c1',
      deviceId: 'dev-1',
      botId: 'bot-1',
      requestId: 'disp-expired',
      message: 'Late check',
      nowMs: now,
    });
    const expired = store.getDispatchMessage({
      callerKey: 'oauth:c1',
      deviceId: 'dev-1',
      botId: 'bot-1',
      requestId: 'disp-expired',
      nowMs: now + DISPATCH_TTL_MS + 1000,
    });
    assert.equal(expired.status, 'expired');
    assert.equal(expired.completed, true);
    assert.equal(expired.error?.code, 'DISPATCH_EXPIRED');
  } finally {
    cleanup();
  }
});

test('Host MCP safe tool policy strips CLI/file/admin/plugin extensions and restores full profile cleanly', () => {
  const fullProfile = {
    cwd: '/workspace',
    instructions: 'Helpful bot',
    selectedExtensions: [
      { name: 'host.base-behavior', tools: [] },
      { name: 'coding-tools', tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'bash' }] },
      { name: 'host.bot-board', hooks: [] },
      { name: 'host.tools', tools: [{ name: 'grep' }, { name: 'find' }, { name: 'ls' }, { name: 'session_search' }] },
      { name: 'host.communication', tools: [{ name: 'send_to' }, { name: 'create_bot' }, { name: 'read_scope' }] },
      { name: 'host.schedule', tools: [{ name: 'schedule_task' }] },
      { name: 'host.request-context', hooks: [] },
      { name: 'codemode', tools: [{ name: 'codemode' }] },
      { name: 'cap-plugin-1', tools: [{ name: 'mcp_exec' }] },
      { name: 'cap-final-budget', hooks: [] },
    ],
    pluginTools: [{ name: 'mcp_exec' }],
    allowTools: null,
    thinkingLevel: 'medium',
    codemode: true,
    codemodeOnly: true,
  };

  const safeProfile = filterSafeMcpProfile(fullProfile);
  assert.deepEqual(
    safeProfile.selectedExtensions.map((ext) => ext.name),
    [...MCP_SAFE_EXTENSION_NAMES],
  );
  assert.deepEqual(safeProfile.allowTools, [...MCP_SAFE_TOOL_NAMES]);
  assert.deepEqual(safeProfile.pluginTools, []);
  assert.equal(safeProfile.codemode, false);
  assert.equal(safeProfile.codemodeOnly, false);
  assert.equal(safeProfile.instructions, 'Helpful bot');

  // Apply safe profile over normal AgentDoc state.
  const normalState = {
    cwd: '/workspace',
    instructions: 'Helpful bot',
    thinkingLevel: 'medium',
    extensions: fullProfile.selectedExtensions.map((e) => e.name),
    tools: null,
    modelTools: ['codemode'],
  };
  const toSafeChange = agentProfileChange(normalState, safeProfile);
  assert.ok(toSafeChange);
  assert.deepEqual(toSafeChange.extensions.map((e) => e.name), [...MCP_SAFE_EXTENSION_NAMES]);
  assert.deepEqual(toSafeChange.tools, []);
  assert.equal(toSafeChange.modelTools, null);

  // Verify safe AgentDoc passes fail-closed check.
  const safeState = {
    ...normalState,
    extensions: toSafeChange.extensions.map((e) => e.name),
    tools: [],
    modelTools: null,
  };
  assert.equal(isAgentStateMcpSafe(safeState), true);
  assert.doesNotThrow(() => assertMcpSafeAgentState(safeState));

  // Any unsafe extension or tool must fail closed with FORBIDDEN.
  assert.throws(
    () => assertMcpSafeAgentState({ ...safeState, extensions: [...safeState.extensions, 'coding-tools'] }),
    (err) => err.code === 'FORBIDDEN',
  );
  assert.throws(
    () => assertMcpSafeAgentState({ ...safeState, tools: ['bash'] }),
    (err) => err.code === 'FORBIDDEN',
  );
  assert.throws(
    () => assertMcpSafeAgentState({ ...safeState, tools: null }),
    (err) => err.code === 'FORBIDDEN',
  );

  // Restore full profile over safe AgentDoc state for the next normal turn.
  const toNormalChange = agentProfileChange(safeState, fullProfile);
  assert.ok(toNormalChange);
  assert.deepEqual(
    toNormalChange.extensions.map((e) => e.name),
    fullProfile.selectedExtensions.map((e) => e.name),
  );
  assert.equal(toNormalChange.tools, null);

  // Surrogate-safe answer truncation.
  const emoji = '😀'.repeat(10);
  const truncated = boundDispatchAnswerText(emoji, 18);
  assert.equal(truncated.isWellFormed(), true);
  assert.ok(truncated.endsWith('\n[truncated]'));
});

test('dispatch contract descriptors align 1-to-1 with dispatch handlers', async (t) => {
  const schemaPath = new URL('../../center-contract/operations/schema.js', import.meta.url);
  if (!existsSync(schemaPath)) {
    t.skip('center-contract/operations/schema.js is provided by parent integration');
    return;
  }
  const { operations } = await import('../../center-contract/operations/dispatch.js');
  const { store, cleanup } = makeStore();
  try {
    const handlers = createHandlers({ store, bridge: makeBridge() });
    const descriptorNames = operations.map((op) => op.name).sort();
    const handlerNames = Object.keys(handlers).sort();
    assert.deepEqual(descriptorNames, handlerNames);
    assert.deepEqual(descriptorNames, ['dispatch_get_bot_message', 'dispatch_send_bot_message']);
    const sendOp = operations.find((op) => op.name === 'dispatch_send_bot_message');
    const getOp = operations.find((op) => op.name === 'dispatch_get_bot_message');
    assert.equal(sendOp.readOnly, false);
    assert.equal(sendOp.destructive, false);
    assert.equal(getOp.readOnly, true);
    assert.equal(getOp.destructive, false);
  } finally {
    cleanup();
  }
});
