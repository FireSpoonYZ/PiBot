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
    assert.deepEqual(retried.terminal.message, first.terminal.message);
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
