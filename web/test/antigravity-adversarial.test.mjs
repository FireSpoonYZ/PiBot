import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createControlledAcpDriverHarness, openIsolatedAntigravity, openTestHostRuntime,
  closeAndRemove, drainEventStream, waitUntil, toolResult, messageText,
  BASE_SYSTEM, BASE_MODEL_SEL, MODEL_ID, USER_ORIGIN,
} from './helpers/antigravity-sync-harness.mjs';
import { ANTIGRAVITY_MAX_FRAME_BYTES } from '../../center-contract/antigravity.js';
import { mapStopReason } from '../../center-server/antigravity/vendor/acp/events.ts';

const DEVICE_ID = 'adversarial-device';
const SESSION_ID = 'adversarial-session';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2sAAAAASUVORK5CYII=';
const user = (text, timestamp = 10) => ({ role: 'user', content: text, timestamp });

function send(service, messages, {
  sessionId = SESSION_ID, modelId = MODEL_ID, reasoning,
  inputIndex = messages.length - 1, auxiliaryIndices = [],
} = {}) {
  return drainEventStream(service.stream({
    deviceId: DEVICE_ID, sessionId, modelId, messages,
    ...(reasoning === undefined ? {} : { reasoning }),
    turnContext: { inputIndex, auxiliaryIndices },
  }));
}

function finishTurn(ctx, response = 'native finished') {
  ctx.emit({ type: 'text', delta: response });
  ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response, finished: true, aborted: false });
}

async function centerCase(t, name, body) {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `pibot-agy-adversarial-${name}-`));
  const service = openIsolatedAntigravity(rootDir);
  try {
    await body({ driver, rootDir, service });
  } finally {
    await closeAndRemove({ antigravity: service, rootDir });
  }
}

test('ACP does not repeat pre-tool text when the continuation ends without new text', { timeout: 15_000 }, async t => {
  await centerCase(t, 'tool-only-end', async ({ driver, service }) => {
    const preToolText = 'I will check the file.';
    driver.setOnRun(async ctx => {
      ctx.emit({ type: 'text', delta: preToolText });
      await ctx.mcp.handler.onToolCall('read-call', 'read_file', { path: 'fixture.txt' }, ctx.signal);
      // The driver outcome contains the entire native turn, not just this HTTP stream.
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: preToolText, finished: true, aborted: false });
    });
    const initial = [BASE_SYSTEM, user('Read a file.')];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'toolUse');
    assert.equal(messageText(first.terminal.message), preToolText);

    const continued = await send(service, [
      ...initial, first.terminal.message, toolResult('read-call', 'read_file', 'actual result', 12),
    ]);
    assert.equal(continued.terminal.reason, 'stop');
    assert.equal(messageText(continued.terminal.message), '');
    assert.equal(driver.runs.length, 1, 'the tool result reenters the original native turn');
  });
});

test('ACP rejects a lost MCP waiter and requires clear instead of replaying its result', { timeout: 15_000 }, async t => {
  await centerCase(t, 'delivery-race', async ({ driver, rootDir, service }) => {
    const mcpAbort = new AbortController();
    let mcpSaw;
    let release;
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        try {
          mcpSaw = await ctx.mcp.handler.onToolCall('race-call', 'read_file', { path: 'x' }, mcpAbort.signal);
        } catch {
          mcpSaw = { error: 'MCP disconnected' };
        }
      }
      finishTurn(ctx);
    });
    try {
      const initial = [BASE_SYSTEM, user('Read the file before answering.')];
      const first = await send(service, initial);
      assert.equal(first.terminal.reason, 'toolUse');

      const unblock = Promise.withResolvers();
      release = unblock.resolve;
      const sessionsPath = path.join(rootDir, 'center', 'antigravity', 'sessions.json');
      const rename = fs.promises.rename;
      let hold = true;
      let renameBlocked = false;
      t.mock.method(fs.promises, 'rename', async function (from, to) {
        if (hold && String(to) === sessionsPath) {
          hold = false;
          renameBlocked = true;
          await unblock.promise;
        }
        return rename.call(this, from, to);
      });

      const resultText = 'ACTUAL_RESULT_MUST_REACH_NATIVE';
      const messages = [...initial, first.terminal.message, toolResult('race-call', 'read_file', resultText, 12)];
      const continuation = send(service, messages);
      await waitUntil(() => renameBlocked, { timeoutMs: 5_000, label: 'write-ahead rename barrier' });
      mcpAbort.abort();
      await new Promise(setImmediate);
      unblock.resolve();

      const failed = await continuation;
      assert.deepEqual(mcpSaw, { error: 'MCP disconnected' });
      assert.equal(failed.terminal.type, 'error', 'a native turn that never received the tool result cannot be acknowledged');
      assert.equal(driver.runs.length, 1, 'the failed continuation must not replay the prompt automatically');

      const retried = await send(service, messages);
      assert.equal(retried.terminal.type, 'error');
      assert.match(retried.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
      assert.equal(driver.runs.length, 1, 'retrying cannot reconstruct the lost MCP waiter');
      assert.equal(driver.runs[0].request.contextBlock, undefined);
    } finally {
      release?.();
      mcpAbort.abort();
    }
  });
});

test('ACP keeps the native turn open for a delivered Host tool error and lets the model retry', { timeout: 15_000 }, async t => {
  await centerCase(t, 'tool-error-retry', async ({ driver, service }) => {
    const errorText = 'HOST_READ_ERROR: the requested file does not exist';
    const args = { path: 'fixture.txt' };
    const server = 'pibot-bridge';
    driver.setOnRun(async ctx => {
      ctx.emit({
        type: 'tool_start', toolCallId: 'native-first', name: 'read_file',
        args: { ...args, toolSummary: 'Read fixture.txt' }, mcpServer: server,
      });
      const failed = await ctx.mcp.handler.onToolCall('host-first', 'read_file', args, ctx.signal);
      assert.equal(failed.isError, true);
      assert.deepEqual(failed.content, [{ type: 'text', text: errorText }]);
      ctx.emit({
        type: 'tool_error', toolCallId: 'native-first', name: 'read_file', mcpServer: server, message: 'tool failed',
      });
      ctx.emit({ type: 'tool_start', toolCallId: 'native-retry', name: 'read_file', args, mcpServer: server });
      const retried = await ctx.mcp.handler.onToolCall('host-retry', 'read_file', args, ctx.signal);
      assert.equal(retried.isError, false);
      ctx.emit({ type: 'tool_done', toolCallId: 'native-retry', name: 'read_file', args, mcpServer: server });
      finishTurn(ctx, retried.content[0].text);
    });

    const initial = [BASE_SYSTEM, user('Read the file.')];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'toolUse');
    const history = [...initial, first.terminal.message, toolResult('host-first', 'read_file', errorText, 12, true)];
    const second = await send(service, history);
    assert.equal(second.terminal.reason, 'toolUse');
    assert.equal(second.terminal.message.content.find(block => block.type === 'toolCall')?.id, 'host-retry');
    const result = await send(service, [
      ...history, second.terminal.message, toolResult('host-retry', 'read_file', 'retry succeeded', 13),
    ]);
    assert.equal(result.terminal.reason, 'stop');
    assert.equal(messageText(result.terminal.message), 'retry succeeded');
    assert.equal(driver.runs.length, 1, 'the model retries inside the original native turn without prompt replay');
  });
});

test('ACP does not use one Host error to excuse an ambiguous native failure', { timeout: 15_000 }, async t => {
  await centerCase(t, 'ambiguous-tool-error', async ({ driver, service }) => {
    const args = { path: 'fixture.txt' };
    const native = { name: 'read_file', mcpServer: 'pibot-bridge' };
    driver.setOnRun(async ctx => {
      ctx.emit({ type: 'tool_start', toolCallId: 'native-first', args, ...native });
      ctx.emit({ type: 'tool_start', toolCallId: 'native-other', args, ...native });
      const response = await ctx.mcp.handler.onToolCall('host-call', 'read_file', args, ctx.signal);
      assert.equal(response.isError, true);
      ctx.emit({ type: 'tool_error', toolCallId: 'native-other', message: 'tool failed', ...native });
      finishTurn(ctx);
    });
    const initial = [BASE_SYSTEM, user('Read the file.')];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'toolUse');
    const result = await send(service, [
      ...initial, first.terminal.message, toolResult('host-call', 'read_file', 'file missing', 12, true),
    ]);
    assert.equal(result.terminal.type, 'error');
    assert.match(result.terminal.error.errorMessage, /Antigravity bridge tool "read_file" failed/);
  });
});

test('ACP rejects changed auxiliary configuration without replacing a parked continuation', { timeout: 15_000 }, async t => {
  await centerCase(t, 'aux-change', async ({ driver, service }) => {
    driver.setOnRun(async ctx => {
      await ctx.mcp.handler.onToolCall('aux-call', 'read_file', { path: 'x' }, ctx.signal);
      finishTurn(ctx);
    });
    const originalAux = user('ORIGINAL_STABLE_AUX', 11);
    const initial = [BASE_SYSTEM, user('Read this file.'), originalAux];
    const first = await send(service, initial, { inputIndex: 1, auxiliaryIndices: [2] });
    assert.equal(first.terminal.reason, 'toolUse');
    const history = [BASE_SYSTEM, initial[1], first.terminal.message,
      toolResult('aux-call', 'read_file', 'REAL_AUX_TOOL_RESULT', 12)];
    const changed = await send(service, [...history, user('CHANGED_AUX', 13)], {
      inputIndex: 3, auxiliaryIndices: [4],
    });
    assert.equal(changed.terminal.type, 'error');
    assert.match(changed.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 1);
    assert.ok(driver.runs[0].driverState.active, 'rejection must leave the original waiter intact');

    const restored = await send(service, [...history, originalAux], { inputIndex: 3, auxiliaryIndices: [4] });
    assert.equal(restored.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 1);
    assert.match(driver.runs[0].request.systemPrompt, /ORIGINAL_STABLE_AUX/);
    assert.equal(driver.runs[0].request.contextBlock, undefined);
  });
});

test('ACP requires clear when previously bound auxiliary configuration is removed', { timeout: 15_000 }, async t => {
  await centerCase(t, 'aux-delete', async ({ driver, service }) => {
    const initial = [BASE_SYSTEM, user('Keep this real question.'), user('STABLE_AUX', 11)];
    const first = await send(service, initial, { inputIndex: 1, auxiliaryIndices: [2] });
    assert.equal(first.terminal.reason, 'stop');
    assert.match(driver.runs[0].request.systemPrompt, /STABLE_AUX/);
    const next = await send(service, [BASE_SYSTEM, initial[1], first.terminal.message, user('Continue.', 12)]);
    assert.equal(next.terminal.type, 'error');
    assert.match(next.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 1, 'configuration changes never launch an empty replacement session');
  });
});

test('ACP rejects changed Soul and can continue the unchanged large history without replay', { timeout: 15_000 }, async t => {
  await centerCase(t, 'soul-change', async ({ driver, service }) => {
    const initial = [BASE_SYSTEM, user('LARGE_HISTORY_' + 'x'.repeat(ANTIGRAVITY_MAX_FRAME_BYTES / 4))];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'stop');
    const history = [...initial, first.terminal.message, user('Continue.')];
    const changed = [{ ...BASE_SYSTEM, content: 'Changed SOUL.' }, ...history.slice(1)];
    const rejected = await send(service, changed);
    assert.match(rejected.terminal.error?.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 1);

    const restored = await send(service, history);
    assert.equal(restored.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal(driver.runs[1].request.contextBlock, undefined);
    assert.equal(driver.runs[1].request.prompt.includes('LARGE_HISTORY_'), false);
    assert.match(driver.runs[1].request.prompt, /Continue/);
  });
});

test('ACP rejects auxiliary image configuration but preserves actual user image input', { timeout: 15_000 }, async t => {
  await centerCase(t, 'source-image', async ({ driver, service }) => {
    const imageMessage = {
      role: 'user', timestamp: 11,
      content: [{ type: 'text', text: 'ACTUAL_IMAGE_INPUT' },
        { type: 'image', data: PNG_1X1, mimeType: 'image/png' }],
    };
    const invalid = await send(service, [BASE_SYSTEM, user('Read context.'), imageMessage], {
      inputIndex: 1, auxiliaryIndices: [2],
    });
    assert.equal(invalid.terminal.type, 'error');
    assert.match(invalid.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 0, 'a rejected projection must not create a native session');
    const result = await send(service, [BASE_SYSTEM, imageMessage]);
    assert.equal(result.terminal.reason, 'stop');
    assert.deepEqual(driver.runs[0].request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    assert.match(driver.runs[0].request.prompt, /ACTUAL_IMAGE_INPUT/);
    assert.equal(driver.runs[0].request.contextBlock, undefined);
  });
});

test('ACP maps token limits and unknown or missing stop reasons to errors', () => {
  for (const reason of ['max_tokens', 'unknown_stop_reason', undefined, null, '']) {
    const mapped = mapStopReason(reason);
    assert.equal(mapped.status, 'ERROR', `stop reason ${String(reason)} must fail closed`);
    assert.equal(mapped.aborted, false);
    assert.ok(typeof mapped.error === 'string' && mapped.error.length > 0);
  }
  assert.deepEqual(mapStopReason('end_turn'), { status: 'OK', aborted: false });
});

test('ACP real Host rejects manual compaction before native dispatch and preserves its ledger', { timeout: 30_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-adversarial-summary-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  let runtime, antigravity;
  try {
    antigravity = openIsolatedAntigravity(rootDir);
    const captured = [];
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'create-appendonly-summary', role: 'Audit', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));
    const submit = async (requestId, text) => {
      await runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      assert.equal((await env.waitForSubmission(bot.botId, requestId)).status, 'done');
    };
    await submit('summary-older-history', 'OLDER_HISTORY_MUST_REMAIN');
    await submit('summary-recent-history', 'RECENT_HISTORY_MUST_REMAIN');
    const before = await runtime.history(bot.botId, { limit: 30 });
    const runCount = driver.runs.length;
    await assert.rejects(runtime.compact(bot.botId),
      error => error?.code === 'AGY_HISTORY_CHANGED' && /\/clear/.test(error.message));
    assert.equal(driver.runs.length, runCount, 'manual Pi compaction must not dispatch a summary prompt');
    const after = await runtime.history(bot.botId, { limit: 30 });
    assert.deepEqual(after.items, before.items);
    await submit('after-rejected-summary', 'Continue with unchanged history.');
    assert.equal(driver.runs.at(-1).request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal(driver.runs.at(-1).request.contextBlock, undefined);
    assert.equal(driver.runs.at(-1).request.prompt.includes('OLDER_HISTORY_MUST_REMAIN'), false);
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir });
  }
});

for (const previousTurn of ['completed', 'cancelled']) {
  test(`ACP rejects a delayed MCP callback from a ${previousTurn} turn during the next run`, { timeout: 15_000 }, async t => {
    await centerCase(t, `stale-mcp-${previousTurn}`, async ({ driver, service }) => {
      const lateAbort = new AbortController();
      let oldMcp;
      let secondCtx;
      let lateSettlement;
      let lateCall;
      driver.setOnRun(async ctx => {
        if (driver.runs.length === 1) {
          oldMcp = ctx.mcp;
          if (previousTurn === 'completed') finishTurn(ctx, 'first reply');
        } else {
          secondCtx = ctx;
        }
      });
      try {
        const firstInput = user('First turn.');
        const firstRequest = send(service, [BASE_SYSTEM, firstInput]);
        await waitUntil(() => oldMcp, { timeoutMs: 3_000, label: 'first native MCP registration' });
        if (previousTurn === 'cancelled') await service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID });
        const first = await firstRequest;
        assert.equal(first.terminal.reason, previousTurn === 'completed' ? 'stop' : 'aborted');

        const nextMessages = previousTurn === 'completed'
          ? [BASE_SYSTEM, firstInput, first.terminal.message, user('Second turn.', 20)]
          : [BASE_SYSTEM, firstInput, user('Second turn after cancellation.', 20)];
        const nextRequest = send(service, nextMessages);
        await waitUntil(() => secondCtx, { timeoutMs: 3_000, label: 'second native turn' });
        // The delayed request retains the OLD handler and has its own live MCP
        // signal, so rejection must come from turn identity rather than abort.
        lateCall = Promise.resolve().then(() => oldMcp.handler.onToolCall(
          'STALE_OLD_CALL', 'read_file', { path: 'OLD_ARGUMENTS_MUST_NOT_EXECUTE' }, lateAbort.signal,
        )).then(
          value => { lateSettlement = { status: 'fulfilled', value }; },
          error => { lateSettlement = { status: 'rejected', error }; },
        );
        await new Promise(setImmediate);
        const rejectedBeforeCleanup = lateSettlement?.status === 'rejected' || lateSettlement?.value?.isError === true;
        finishTurn(secondCtx, 'second reply');
        const next = await nextRequest;
        lateAbort.abort();
        await lateCall;

        assert.ok(rejectedBeforeCleanup, 'the old handler must reject before cleanup aborts its independent MCP signal');
        assert.notEqual(secondCtx.mcp.token, oldMcp.token, 'each native run must receive a fresh MCP registration');
        assert.equal(next.terminal.reason, 'stop');
        assert.ok(!JSON.stringify(next.events).includes('STALE_OLD_CALL'));
        assert.ok(!JSON.stringify(next.terminal.message.content).includes('OLD_ARGUMENTS_MUST_NOT_EXECUTE'));
      } finally {
        lateAbort.abort();
        if (secondCtx) finishTurn(secondCtx);
      }
    });
  });
}

test('ACP applies reasoning changes on the same ready native conversation without replay', { timeout: 15_000 }, async t => {
  await centerCase(t, 'ready-reasoning', async ({ driver, service }) => {
    const initial = [BASE_SYSTEM, user('READY_HIGH_REASONING_HISTORY')];
    const first = await send(service, initial, { reasoning: 'high' });
    assert.equal(first.terminal.reason, 'stop');
    const next = await send(service, [...initial, first.terminal.message, user('Continue using the default reasoning setting.', 12)]);
    assert.equal(next.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal(driver.runs[1].request.contextBlock, undefined);
    assert.equal(driver.runs[1].request.prompt.includes('READY_HIGH_REASONING_HISTORY'), false);
  });
});

test('ACP reloads the persisted session, rejects model changes, and allows idle reasoning changes', { timeout: 15_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-adversarial-config-restart-'));
  let service = openIsolatedAntigravity(rootDir);
  try {
    const initial = [BASE_SYSTEM, user('PERSISTED_CONFIG_HISTORY')];
    const first = await send(service, initial, { reasoning: 'high' });
    assert.equal(first.terminal.reason, 'stop');
    const nativeId = driver.runs[0].assignedConversationId;
    await service.close();
    service = openIsolatedAntigravity(rootDir);
    const changedCachedModel = await send(service, initial, { modelId: 'gemini-3-flash', reasoning: 'high' });
    assert.equal(changedCachedModel.terminal.type, 'error');
    assert.match(changedCachedModel.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 1, 'a cached answer cannot bypass the persisted model binding');
    const afterRestart = [...initial, first.terminal.message, user('SAME_CONFIG_AFTER_RESTART', 12)];
    const second = await send(service, afterRestart, { reasoning: 'high' });
    assert.equal(second.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, nativeId);
    const pending = [...afterRestart, second.terminal.message, user('NEW_INPUT_AFTER_MODEL_SELECTION', 14)];
    const rejected = await send(service, pending, { modelId: 'gemini-3-flash', reasoning: 'high' });
    assert.equal(rejected.terminal.type, 'error');
    assert.match(rejected.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 2);
    const resumed = await send(service, pending);
    assert.equal(resumed.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 3);
    assert.equal(driver.runs[2].request.model, MODEL_ID);
    assert.equal(driver.runs[2].request.conversationId, nativeId);
    assert.equal(driver.runs[2].request.contextBlock, undefined);
    assert.equal(driver.runs[2].request.prompt.includes('PERSISTED_CONFIG_HISTORY'), false);
    assert.match(driver.runs[2].request.prompt, /NEW_INPUT_AFTER_MODEL_SELECTION/);
  } finally {
    await closeAndRemove({ antigravity: service, rootDir });
  }
});

test('ACP rejects a model change while a native tool continuation is parked', { timeout: 15_000 }, async t => {
  await centerCase(t, 'parked-model', async ({ driver, service }) => {
    driver.setOnRun(async ctx => {
      await ctx.mcp.handler.onToolCall('model-call', 'read_file', { path: 'x' }, ctx.signal);
      finishTurn(ctx, 'original model received the result');
    });
    const initial = [BASE_SYSTEM, user('Read the file and continue.')];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'toolUse');
    const continuation = [...initial, first.terminal.message,
      toolResult('model-call', 'read_file', 'MODEL_SWITCH_REAL_RESULT', 12)];
    const rejected = await send(service, continuation, { modelId: 'gemini-3-flash' });
    assert.equal(rejected.terminal.type, 'error');
    assert.match(rejected.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 1);
    assert.ok(driver.runs[0].driverState.active);
    const restored = await send(service, continuation);
    assert.equal(restored.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 1, 'the original model can still receive its original result');
  });
});

test('ACP rejects changed reasoning while a native tool continuation is parked', { timeout: 15_000 }, async t => {
  await centerCase(t, 'parked-reasoning', async ({ driver, service }) => {
    driver.setOnRun(async ctx => {
      await ctx.mcp.handler.onToolCall('reasoning-call', 'read_file', { path: 'x' }, ctx.signal);
      finishTurn(ctx, 'original reasoning received the result');
    });
    const initial = [BASE_SYSTEM, user('Read before choosing the next step.')];
    const first = await send(service, initial, { reasoning: 'off' });
    const continuation = [...initial, first.terminal.message,
      toolResult('reasoning-call', 'read_file', 'REASONING_SWITCH_REAL_RESULT', 12)];
    const rejected = await send(service, continuation, { reasoning: 'high' });
    assert.equal(rejected.terminal.type, 'error');
    assert.match(rejected.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/s);
    assert.equal(driver.runs.length, 1);
    const restored = await send(service, continuation, { reasoning: 'off' });
    assert.equal(restored.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 1);
  });
});

test('ACP caps ordinary idle drivers at 64 while preserving a parked tool continuation', { timeout: 30_000 }, async t => {
  await centerCase(t, 'idle-limit', async ({ driver, service }) => {
    const parkedSessionId = 'parked-during-idle-pressure';
    let receivedResult;
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        receivedResult = await ctx.mcp.handler.onToolCall('capacity-call', 'read_file', { path: 'x' }, ctx.signal);
        finishTurn(ctx, 'parked native received its real result');
      } else {
        finishTurn(ctx, 'ordinary idle session completed');
      }
    });
    const initial = [BASE_SYSTEM, user('Keep this tool call parked while other sessions finish.')];
    const first = await send(service, initial, { sessionId: parkedSessionId });
    assert.equal(first.terminal.reason, 'toolUse');
    const parked = driver.runs[0];
    const originalHandle = parked.driverState.active;
    assert.ok(originalHandle);

    for (let index = 0; index < 70; index += 1) {
      const result = await send(service, [BASE_SYSTEM, user(`Ordinary request ${index}.`)], {
        sessionId: `idle-capacity-${index}`,
      });
      assert.equal(result.terminal.reason, 'stop');
    }
    assert.equal(driver.runs.length, 71);
    const liveDrivers = () => driver.runs.filter(record => record.driverState.state !== 'dead');
    await waitUntil(() => liveDrivers().length <= 65, {
      timeoutMs: 5_000, label: 'idle drivers above the 64-slot limit to close',
    });
    assert.ok(liveDrivers().length <= 65, 'at most 64 idle drivers plus the one parked driver may remain live');
    assert.notEqual(parked.driverState.state, 'dead', 'idle eviction must not close the parked driver');
    assert.equal(parked.driverState.active, originalHandle, 'the parked native handle must survive idle eviction');

    const runCount = driver.runs.length;
    const reentries = parked.driverState.reentryCalls;
    const resultText = 'IDLE_PRESSURE_REAL_RESULT_MUST_REACH_NATIVE';
    const resumed = await send(service, [
      ...initial, first.terminal.message, toolResult('capacity-call', 'read_file', resultText, 12),
    ], { sessionId: parkedSessionId });
    assert.equal(resumed.terminal.reason, 'stop');
    assert.equal(driver.runs.length, runCount, 'resuming the preserved parked handle must not start another native run');
    assert.ok(parked.driverState.reentryCalls > reentries);
    assert.equal(receivedResult?.isError, false);
    assert.ok(receivedResult.content.some(block => block.type === 'text' && block.text === resultText));
  });
});

test('ACP reclaims an expired parked driver once its escalated tool call no longer has a live waiter', { timeout: 30_000 }, async t => {
  await centerCase(t, 'expired-parked', async ({ driver, service }) => {
    const expiredSessionId = 'expired-parked-under-idle-pressure';
    let escalationAck;
    let expired;
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        escalationAck = await ctx.mcp.handler.onToolCall('expired-call', 'read_file', { path: 'x' }, ctx.signal);
        finishTurn(ctx, 'native ended after the escalation acknowledgement');
      } else {
        finishTurn(ctx, 'ordinary request while the tool is parked');
      }
    });

    // Only advance the bridge timers. Date and setImmediate remain real, and
    // no waitUntil call runs until the timer mock has been reset.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const first = await send(service, [BASE_SYSTEM, user('Leave this tool unfinished until it expires.')], { sessionId: expiredSessionId });
      assert.equal(first.terminal.reason, 'toolUse');
      expired = driver.runs[0];
      assert.ok(expired.driverState.active);

      for (let index = 0; index < 64; index += 1) {
        const result = await send(service, [BASE_SYSTEM, user(`Ordinary request ${index} while parked.`)], {
          sessionId: `expired-parked-pressure-${index}`,
        });
        assert.equal(result.terminal.reason, 'stop');
      }
      assert.equal(driver.runs.length, 65);

      t.mock.timers.tick(20_001);
      await new Promise(setImmediate);
      assert.equal(escalationAck?.isError, false);
      assert.ok(escalationAck.content.some(block => block.type === 'text' && block.text.includes('STILL RUNNING')));
      assert.equal(expired.driverState.active, null, 'native end_turn must precede the escalated waiter timeout');
      assert.equal(expired.driverState.state, 'ready');

      t.mock.timers.tick(1_800_001);
      await new Promise(setImmediate);
    } finally {
      t.mock.timers.reset();
    }

    const liveDrivers = () => driver.runs.filter(record => record.driverState.state !== 'dead');
    await waitUntil(() => expired.driverState.state === 'dead' && liveDrivers().length <= 64, {
      timeoutMs: 5_000, label: 'expired parked driver to be evicted without follow-up traffic',
    });
    assert.equal(expired.driverState.state, 'dead');
    assert.ok(liveDrivers().length <= 64);
    // The persisted parked binding may remain as a recovery checkpoint; this
    // limit applies to live drivers, not to the durable conversation records.
  });
});

test('ACP keeps explicit new conversation IDs isolated and preserves both durable ledgers', { timeout: 15_000 }, async t => {
  await centerCase(t, 'clear-isolation', async ({ driver, rootDir, service }) => {
    const sessionIds = [randomUUID(), randomUUID()];
    for (let index = 0; index < sessionIds.length; index++) {
      const result = await send(service, [BASE_SYSTEM, user('Independent conversation ' + index)], { sessionId: sessionIds[index] });
      assert.equal(result.terminal.reason, 'stop');
    }
    assert.equal(driver.runs.length, 2);
    assert.notEqual(driver.runs[0].driver, driver.runs[1].driver);
    assert.notEqual(driver.runs[0].assignedConversationId, driver.runs[1].assignedConversationId);
    const bindings = JSON.parse(fs.readFileSync(path.join(rootDir, 'center', 'antigravity', 'sessions.json'), 'utf8'));
    for (let index = 0; index < sessionIds.length; index++) {
      const binding = bindings[JSON.stringify([DEVICE_ID, sessionIds[index]])];
      assert.equal(binding.phase, 'ready');
      assert.equal(binding.conversationId, driver.runs[index].assignedConversationId);
      assert.equal(binding.history.messages.length, 1);
      assert.deepEqual(binding.consumedUserIndices, [0]);
      assert.equal(driver.runs[index].request.contextBlock, undefined);
    }
  });
});
