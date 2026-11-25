import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore, makeSessionKey } from '../../center-server/antigravity/sessions.ts';
import {
  BASE_SYSTEM, MODEL_ID, createControlledAcpDriverHarness, openIsolatedAntigravity,
  drainEventStream, messageText, toolResult,
} from './helpers/antigravity-sync-harness.mjs';

const DEVICE_ID = 'delta-recovery-device';
const SESSION_ID = 'delta-recovery-session';
const source = { role: 'user', content: 'U1: execute the requested operation once.', timestamp: 10 };

function send(service, messages, requestId) {
  return drainEventStream(service.stream({
    deviceId: DEVICE_ID, sessionId: SESSION_ID, modelId: MODEL_ID, requestId, messages,
    turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] },
  }));
}

function complete(ctx, text) {
  ctx.emit({ type: 'text', delta: text });
  ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: text, finished: true, aborted: false });
}

function readBinding(rootDir) {
  const filename = path.join(rootDir, 'center', 'antigravity', 'sessions.json');
  return JSON.parse(fs.readFileSync(filename, 'utf8'))[makeSessionKey(DEVICE_ID, SESSION_ID)];
}

for (const lostWaiter of ['cancel', 'restart']) {
  test(`cached toolUse cannot be replayed after native waiter loss by ${lostWaiter}`, { timeout: 15_000 }, async t => {
    const driver = createControlledAcpDriverHarness(t);
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-cached-tool-'));
    let service = openIsolatedAntigravity(rootDir);
    let native;
    driver.setOnRun(async ctx => {
      native = ctx;
      await ctx.mcp.handler.onToolCall('once-only-call', 'read_file', { path: 'fixture.txt' }, ctx.signal);
      complete(ctx, 'original tool result consumed');
    });
    try {
      const first = await send(service, [BASE_SYSTEM, source], 'first');
      assert.equal(first.terminal.reason, 'toolUse');
      assert.equal(first.terminal.message.content.find(part => part.type === 'toolCall')?.id, 'once-only-call');
      if (lostWaiter === 'cancel') {
        await service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID, requestId: 'first' });
      } else {
        await service.close();
        service = openIsolatedAntigravity(rootDir);
      }
      assert.equal(native.signal.aborted, true);
      const retried = await send(service, [BASE_SYSTEM, source], 'retry');
      assert.equal(retried.terminal.type, 'error');
      assert.match(retried.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
      assert.equal(retried.events.some(event => event.type === 'done' && event.reason === 'toolUse'), false);
      assert.equal(driver.runs.length, 1, 'lost callbacks cannot be reconstructed by another model run');
    } finally {
      try { await service.close(); }
      finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
    }
  });
}

test('cached toolUse remains replayable while its exact native waiter is alive', { timeout: 15_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-live-tool-receipt-'));
  const service = openIsolatedAntigravity(rootDir);
  let deliveries = 0;
  driver.setOnRun(async ctx => {
    const result = await ctx.mcp.handler.onToolCall('live-call', 'read_file', { path: 'fixture.txt' }, ctx.signal);
    deliveries += 1;
    complete(ctx, result.content[0].text);
  });
  try {
    const first = await send(service, [BASE_SYSTEM, source], 'first');
    assert.equal(first.terminal.reason, 'toolUse');
    const retried = await send(service, [BASE_SYSTEM, source], 'retry');
    assert.equal(retried.terminal.reason, 'toolUse');
    const { durationMs: _elapsed, ...firstMessage } = first.terminal.message;
    assert.deepEqual(retried.terminal.message, firstMessage);
    assert.equal(driver.runs.length, 1);
    const completed = await send(service, [
      BASE_SYSTEM, source, first.terminal.message, toolResult('live-call', 'read_file', 'DELIVER_ONCE', 12),
    ], 'result');
    assert.equal(completed.terminal.reason, 'stop');
    assert.equal(messageText(completed.terminal.message), 'DELIVER_ONCE');
    assert.equal(deliveries, 1);
    assert.equal(driver.runs.length, 1);
  } finally {
    try { await service.close(); }
    finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
  }
});

for (const failRollback of [false, true]) {
  test(`pre-dispatch intent flush failure preserves U1${failRollback ? ' even when its first rollback flush fails' : ''}`, { timeout: 15_000 }, async t => {
    const driver = createControlledAcpDriverHarness(t);
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-intent-write-failure-'));
    const service = openIsolatedAntigravity(rootDir);
    const originalFlush = SessionStore.prototype.flush;
    let failureStage = 'intent';
    let dispatched = 0;
    t.mock.method(SessionStore.prototype, 'flush', async function () {
      const binding = this.get(makeSessionKey(DEVICE_ID, SESSION_ID));
      if (failureStage === 'intent' && binding?.consumedUserIndices?.includes(0)) {
        failureStage = failRollback ? 'rollback' : 'done';
        throw new Error('FIXTURE_INTENT_FLUSH_FAILED');
      }
      if (failureStage === 'rollback' && binding?.consumedUserIndices?.length === 0) {
        failureStage = 'done';
        throw new Error('FIXTURE_ROLLBACK_FLUSH_FAILED');
      }
      return originalFlush.call(this);
    });
    driver.setOnRun(ctx => {
      dispatched += 1;
      assert.match(ctx.request.prompt, /U1: execute the requested operation once/);
      assert.equal(ctx.request.contextBlock, undefined);
      complete(ctx, 'U1 completed exactly once');
    });
    try {
      const failed = await send(service, [BASE_SYSTEM, source], 'first');
      assert.equal(failed.terminal.type, 'error');
      assert.match(failed.terminal.error.errorMessage, /FIXTURE_(?:INTENT|ROLLBACK)_FLUSH_FAILED/);
      if (failRollback) assert.match(failed.terminal.error.errorMessage, /ROLLBACK/);
      assert.equal(dispatched, 0, 'a failed beforePrompt durability barrier must not call the model');
      const afterFailure = readBinding(rootDir);
      assert.equal(afterFailure.history.messages[0].content, source.content);
      assert.deepEqual(afterFailure.consumedUserIndices, []);
      assert.equal(afterFailure.attemptedThrough, 0);

      const retried = await send(service, [BASE_SYSTEM, source], 'retry');
      assert.equal(retried.terminal.reason, 'stop');
      assert.equal(messageText(retried.terminal.message), 'U1 completed exactly once');
      assert.equal(dispatched, 1);
      assert.deepEqual(readBinding(rootDir).consumedUserIndices, [0]);
      const again = await send(service, [BASE_SYSTEM, source], 'duplicate-after-result');
      assert.equal(again.terminal.reason, 'stop');
      assert.equal(messageText(again.terminal.message), 'U1 completed exactly once');
      assert.equal(dispatched, 1, 'a completed result retry must reuse its receipt');
    } finally {
      try { await service.close(); }
      finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
    }
  });
}


test('a failed ready checkpoint cannot cache an error for an unsent queued user', { timeout: 15_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-ready-write-failure-'));
  const service = openIsolatedAntigravity(rootDir);
  const originalFlush = SessionStore.prototype.flush;
  const queued = { role: 'user', content: 'U2: select Copper after the tool finishes.', timestamp: 13 };
  let readyFailed = false;
  let delivered = 0;
  let queuedDispatches = 0;
  t.mock.method(SessionStore.prototype, 'flush', async function () {
    const binding = this.get(makeSessionKey(DEVICE_ID, SESSION_ID));
    if (!readyFailed && delivered === 1 && binding?.phase === 'ready' &&
        binding.consumedUserIndices?.length === 1 && binding.history.messages.length === 4) {
      readyFailed = true;
      throw new Error('FIXTURE_READY_FLUSH_FAILED');
    }
    return originalFlush.call(this);
  });
  driver.setOnRun(async ctx => {
    if (driver.runs.length === 1) {
      const result = await ctx.mcp.handler.onToolCall('ready-call', 'read_file', { path: 'fixture.txt' }, ctx.signal);
      assert.equal(result.content[0].text, 'READY_TOOL_RESULT');
      delivered += 1;
      ctx.emit({ type: 'thought', delta: 'OLD_WAITING_THOUGHT' });
      complete(ctx, 'Waiting for your selection.');
      return;
    }
    queuedDispatches += 1;
    assert.match(ctx.request.prompt, /U2: select Copper/);
    assert.doesNotMatch(ctx.request.prompt, /U1:|READY_TOOL_RESULT/);
    assert.equal(ctx.request.contextBlock, undefined);
    complete(ctx, 'QUEUED_ANSWER_DONE');
  });
  try {
    const first = await send(service, [BASE_SYSTEM, source], 'first');
    assert.equal(first.terminal.reason, 'toolUse');
    const messages = [BASE_SYSTEM, source, first.terminal.message,
      toolResult('ready-call', 'read_file', 'READY_TOOL_RESULT', 12), queued];
    const failed = await send(service, messages, 'ready-write-fails');
    assert.equal(failed.terminal.type, 'error');
    assert.match(failed.terminal.error.errorMessage, /FIXTURE_READY_FLUSH_FAILED/);
    assert.doesNotMatch(JSON.stringify(failed.events), /Waiting for your selection|OLD_WAITING_THOUGHT/);
    assert.equal(readyFailed, true);
    assert.equal(delivered, 1);
    assert.equal(queuedDispatches, 0);
    assert.equal(driver.runs.length, 1);
    const checkpoint = readBinding(rootDir);
    assert.equal(checkpoint.phase, 'ready');
    assert.deepEqual(checkpoint.pendingToolCallIds, []);
    assert.deepEqual(checkpoint.consumedUserIndices, [0]);
    assert.equal(checkpoint.reply, undefined, 'the unsent user has no result receipt');

    const retried = await send(service, messages, 'retry-same-delta');
    assert.equal(retried.terminal.reason, 'stop');
    assert.equal(messageText(retried.terminal.message), 'QUEUED_ANSWER_DONE');
    assert.equal(delivered, 1, 'the completed old tool is never delivered twice');
    assert.equal(queuedDispatches, 1);
    assert.equal(driver.runs.length, 2);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.deepEqual(readBinding(rootDir).consumedUserIndices, [0, 3]);
    const duplicate = await send(service, messages, 'duplicate-finished-delta');
    assert.equal(duplicate.terminal.reason, 'stop');
    assert.equal(queuedDispatches, 1);
  } finally {
    try { await service.close(); }
    finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
  }
});

test('a tool-result-tail retry preserves queued user input after the next prompt never dispatched', { timeout: 15_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-queued-user-retry-'));
  const service = openIsolatedAntigravity(rootDir);
  const originalFlush = SessionStore.prototype.flush;
  const queued = { role: 'user', content: 'U2: choose Copper after the native tools finish.', timestamp: 13 };
  const deliveries = [0, 0];
  let intentFailed = false;
  let queuedDispatches = 0;
  t.mock.method(SessionStore.prototype, 'flush', async function () {
    const binding = this.get(makeSessionKey(DEVICE_ID, SESSION_ID));
    if (!intentFailed && binding?.consumedUserIndices?.includes(3)) {
      intentFailed = true;
      throw new Error('FIXTURE_QUEUED_INTENT_FLUSH_FAILED');
    }
    return originalFlush.call(this);
  });
  driver.setOnRun(async ctx => {
    if (driver.runs.length === 1) {
      const first = await ctx.mcp.handler.onToolCall('queued-first', 'read_file', { path: 'first.txt' }, ctx.signal);
      assert.equal(first.content[0].text, 'FIRST_REAL_RESULT');
      deliveries[0] += 1;
      ctx.emit({ type: 'text', delta: 'OLD_WAITING_TEXT' });
      ctx.emit({ type: 'thought', delta: 'OLD_WAITING_THOUGHT' });
      const second = await ctx.mcp.handler.onToolCall('queued-followup', 'read_file', { path: 'second.txt' }, ctx.signal);
      assert.equal(second.content[0].text, 'SECOND_REAL_RESULT');
      deliveries[1] += 1;
      complete(ctx, 'old native turn finished after its follow-up tool');
      return;
    }
    queuedDispatches += 1;
    assert.match(ctx.request.prompt, /U2: choose Copper/);
    assert.doesNotMatch(ctx.request.prompt, /U1:|FIRST_REAL_RESULT|SECOND_REAL_RESULT/);
    assert.equal(ctx.request.contextBlock, undefined);
    complete(ctx, 'QUEUED_USER_COMPLETED_ONCE');
  });
  try {
    const first = await send(service, [BASE_SYSTEM, source], 'first');
    assert.equal(first.terminal.reason, 'toolUse');
    const withQueuedUser = [BASE_SYSTEM, source, first.terminal.message,
      toolResult('queued-first', 'read_file', 'FIRST_REAL_RESULT', 12), queued];
    const parked = await send(service, withQueuedUser, 'deliver-first-and-queue-user');
    assert.equal(parked.terminal.reason, 'toolUse');
    assert.equal(parked.terminal.message.content.find(part => part.type === 'toolCall')?.id, 'queued-followup');
    assert.equal(messageText(parked.terminal.message), '', 'old waiting text is not part of the queued user response');
    assert.doesNotMatch(JSON.stringify(parked.events), /OLD_WAITING_TEXT|OLD_WAITING_THOUGHT/);
    assert.equal(driver.runs.length, 1);
    assert.equal(queuedDispatches, 0);
    assert.deepEqual(readBinding(rootDir).consumedUserIndices, [0]);

    const messages = [...withQueuedUser, parked.terminal.message,
      toolResult('queued-followup', 'read_file', 'SECOND_REAL_RESULT', 14)];
    const failed = await send(service, messages, 'deliver-followup-before-unsent-prompt');
    assert.equal(failed.terminal.type, 'error');
    assert.match(failed.terminal.error.errorMessage, /FIXTURE_QUEUED_INTENT_FLUSH_FAILED/);
    assert.doesNotMatch(JSON.stringify(failed.events), /old native turn finished|OLD_WAITING/);
    assert.equal(intentFailed, true);
    assert.deepEqual(deliveries, [1, 1]);
    assert.equal(queuedDispatches, 0);
    assert.equal(driver.runs.length, 2, 'the second handle failed before calling the model');
    const checkpoint = readBinding(rootDir);
    assert.equal(checkpoint.phase, 'ready');
    assert.deepEqual(checkpoint.pendingToolCallIds, []);
    assert.deepEqual(checkpoint.consumedUserIndices, [0]);
    assert.equal(checkpoint.reply, undefined);

    const retried = await send(service, messages, 'retry-tool-result-tail');
    assert.equal(retried.terminal.reason, 'stop');
    assert.equal(messageText(retried.terminal.message), 'QUEUED_USER_COMPLETED_ONCE');
    assert.deepEqual(deliveries, [1, 1]);
    assert.equal(queuedDispatches, 1);
    assert.equal(driver.runs.length, 3);
    assert.equal(driver.runs[2].request.conversationId, driver.runs[0].assignedConversationId);
    assert.deepEqual(readBinding(rootDir).consumedUserIndices, [0, 3]);
    const duplicate = await send(service, messages, 'duplicate-completed-tool-result-tail');
    assert.equal(duplicate.terminal.reason, 'stop');
    assert.equal(queuedDispatches, 1);
    assert.deepEqual(deliveries, [1, 1]);
  } finally {
    try { await service.close(); }
    finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
  }
});
