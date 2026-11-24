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
import { AcpConnection } from '../../center-server/antigravity/vendor/acp/connection.ts';
import { AcpDriver } from '../../center-server/antigravity/vendor/acp/driver.ts';
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

test('ACP rejects a tool result whose MCP waiter disappears during persistence and rebuilds on retry', { timeout: 15_000 }, async t => {
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
      assert.equal(retried.terminal.reason, 'stop');
      assert.equal(driver.runs.length, 2);
      assert.equal(driver.runs[1].request.conversationId, null);
      assert.ok(driver.runs[1].request.contextBlock.text.includes('Read the file before answering.'));
      assert.ok(driver.runs[1].request.contextBlock.text.includes('race-call'));
      assert.ok(driver.runs[1].request.contextBlock.text.includes(resultText));
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

test('ACP rebuilds a parked continuation when its trailing auxiliary context changes', { timeout: 15_000 }, async t => {
  await centerCase(t, 'aux-change', async ({ driver, service }) => {
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        await ctx.mcp.handler.onToolCall('aux-call', 'read_file', { path: 'x' }, ctx.signal);
      }
      finishTurn(ctx);
    });
    const initial = [BASE_SYSTEM, user('Read this file.'), user('OLD_AUX_MUST_BE_REPLACED', 11)];
    const first = await send(service, initial, { inputIndex: 1, auxiliaryIndices: [2] });
    assert.equal(first.terminal.reason, 'toolUse');
    const result = await send(service, [
      BASE_SYSTEM, initial[1], first.terminal.message,
      toolResult('aux-call', 'read_file', 'REAL_AUX_TOOL_RESULT', 12),
      user('NEW_AUX_MUST_REACH_NATIVE', 13),
    ], { inputIndex: 3, auxiliaryIndices: [4] });

    assert.equal(result.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2, 'changed auxiliary context cannot use the parked native prompt');
    assert.equal(driver.runs[1].request.conversationId, null);
    const rebuilt = JSON.stringify(driver.runs[1].request);
    assert.ok(rebuilt.includes('NEW_AUX_MUST_REACH_NATIVE'));
    assert.ok(rebuilt.includes('REAL_AUX_TOOL_RESULT'));
    assert.ok(!rebuilt.includes('OLD_AUX_MUST_BE_REPLACED'));
  });
});

test('ACP removes expired auxiliary context by rebuilding the next ordinary user turn', { timeout: 15_000 }, async t => {
  await centerCase(t, 'aux-delete', async ({ driver, service }) => {
    const initial = [BASE_SYSTEM, user('Keep this real question.'), user('AUX_REMOVED_BEFORE_NEXT_TURN', 11)];
    const first = await send(service, initial, { inputIndex: 1, auxiliaryIndices: [2] });
    assert.equal(first.terminal.reason, 'stop');
    assert.ok(JSON.stringify(driver.runs[0].request).includes('AUX_REMOVED_BEFORE_NEXT_TURN'));
    const next = await send(service, [BASE_SYSTEM, initial[1], first.terminal.message, user('Continue without the old auxiliary note.', 12)]);
    assert.equal(next.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes('Keep this real question.'));
    assert.ok(!JSON.stringify(driver.runs[1].request).includes('AUX_REMOVED_BEFORE_NEXT_TURN'));
  });
});

test('ACP preserves a ready binding when a replacement replay exceeds the frame budget', { timeout: 15_000 }, async t => {
  await centerCase(t, 'oversized-replay', async ({ driver, service }) => {
    // Quotation marks are escaped once in the replay record and again in the frame.
    const initial = [BASE_SYSTEM, user('"'.repeat(ANTIGRAVITY_MAX_FRAME_BYTES / 4))];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'stop');
    const history = [...initial, first.terminal.message, user('Continue.')];
    const changed = [{ ...BASE_SYSTEM, content: 'Changed SOUL.' }, ...history.slice(1)];
    assert.ok(Buffer.byteLength(JSON.stringify(changed)) < ANTIGRAVITY_MAX_FRAME_BYTES);
    const rejected = await send(service, changed);
    assert.match(rejected.terminal.error?.errorMessage, /ACP frame budget/);
    assert.equal(driver.runs.length, 1, 'oversized replay was never dispatched');

    const restored = await send(service, history);
    assert.equal(restored.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
  });
});

test('ACP sends images from first-turn auxiliary context with an explicit attachment number', { timeout: 15_000 }, async t => {
  await centerCase(t, 'aux-image', async ({ driver, service }) => {
    const auxiliary = {
      role: 'user', timestamp: 11,
      content: [
        { type: 'text', text: 'AUX_IMAGE_CONTEXT' },
        { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
      ],
    };
    const result = await send(service, [BASE_SYSTEM, user('Use the auxiliary image.'), auxiliary], {
      inputIndex: 1, auxiliaryIndices: [2],
    });
    assert.equal(result.terminal.reason, 'stop');
    const request = driver.runs[0].request;
    assert.deepEqual(request.images, [{ data: PNG_1X1, mimeType: 'image/png' }]);
    const attachedContext = `${request.contextBlock?.text ?? ''}\n${request.prompt}`;
    assert.ok(attachedContext.includes('AUX_IMAGE_CONTEXT'));
    assert.match(attachedContext, /\bimage(?:\s+attachments?)?[\s#:_-]*1\b/i, 'the auxiliary text must identify its attached image');
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

test('ACP real Host compaction rejects a partial max_tokens summary and preserves the original history', { timeout: 30_000 }, async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-adversarial-summary-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  let runtime, antigravity;
  let compacting = false;
  let nativeSequence = 0;
  const promptResults = [];
  const injectedText = [];

  t.mock.getter(AcpConnection.prototype, 'alive', () => true);
  t.mock.method(AcpConnection.prototype, 'start', async () => {});
  t.mock.method(AcpConnection.prototype, 'newSession', async () => ({ sessionId: `summary-native-${++nativeSequence}` }));
  t.mock.method(AcpConnection.prototype, 'loadSession', async () => ({}));
  t.mock.method(AcpConnection.prototype, 'setConfigOption', async () => ({}));
  t.mock.method(AcpConnection.prototype, 'prompt', async () => {
    const stopReason = compacting ? 'max_tokens' : 'end_turn';
    promptResults.push(stopReason);
    return { stopReason };
  });
  // Preserve the real driver's outcome mapping. Only supply the text activity
  // that a native server would stream before returning its stop reason.
  const run = AcpDriver.prototype.run;
  t.mock.method(AcpDriver.prototype, 'run', async function (request) {
    const text = compacting ? 'PARTIAL_SUMMARY' : 'reply';
    const handle = await run.call(this, request);
    let injected = false;
    return {
      ...handle,
      next() {
        if (!injected) {
          injected = true;
          injectedText.push(text);
          return Promise.resolve({ type: 'text', delta: text });
        }
        return handle.next();
      },
    };
  });

  try {
    antigravity = openIsolatedAntigravity(rootDir);
    const captured = [];
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'create-partial-summary', role: 'Audit', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));
    const submit = async (requestId, text) => {
      await runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      assert.equal((await env.waitForSubmission(bot.botId, requestId)).status, 'done');
    };
    await submit('summary-older-history', `OLDER_HISTORY_MUST_REMAIN\n${'older conversation material '.repeat(3500)}`);
    await submit('summary-recent-history', `RECENT_HISTORY_MUST_REMAIN\n${'keep this recent material '.repeat(3500)}`);
    const before = await runtime.history(bot.botId, { limit: 30 });
    assert.ok(JSON.stringify(before.items).includes('OLDER_HISTORY_MUST_REMAIN'));
    assert.ok(JSON.stringify(before.items).includes('RECENT_HISTORY_MUST_REMAIN'));

    const promptCount = promptResults.length;
    let compactResult, compactError;
    compacting = true;
    try {
      compactResult = await runtime.compact(bot.botId);
    } catch (error) {
      compactError = error;
    } finally {
      compacting = false;
    }
    assert.ok(promptResults.length > promptCount, 'the fixture must reach the real compaction provider call');
    assert.ok(promptResults.slice(promptCount).every(reason => reason === 'max_tokens'));
    assert.ok(injectedText.includes('PARTIAL_SUMMARY'), 'text must have been streamed before the incomplete outcome');
    assert.ok(compactError || compactResult?.compacted === false, 'partial text must not make compaction succeed');
    if (compactError) assert.equal(compactError.code, 'COMPACTION_FAILED');

    const after = await runtime.history(bot.botId, { limit: 30 });
    const afterText = JSON.stringify(after.items);
    assert.ok(afterText.includes('OLDER_HISTORY_MUST_REMAIN'));
    assert.ok(afterText.includes('RECENT_HISTORY_MUST_REMAIN'));
    assert.ok(!afterText.includes('PARTIAL_SUMMARY'));

    await submit('after-rejected-summary', 'Continue with the unchanged conversation.');
    const nextProjection = JSON.stringify(captured.at(-1).messages);
    assert.ok(nextProjection.includes('OLDER_HISTORY_MUST_REMAIN'));
    assert.ok(nextProjection.includes('RECENT_HISTORY_MUST_REMAIN'));
    assert.ok(!nextProjection.includes('PARTIAL_SUMMARY'), 'the partial summary cannot become the next model context head');
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir });
  }
});

for (const previousTurn of ['completed', 'cancelled']) {
  test(`ACP rejects a delayed MCP callback from a ${previousTurn} turn during the next run`, { timeout: 15_000 }, async t => {
    await centerCase(t, `stale-mcp-${previousTurn}`, async ({ driver, service }) => {
      const firstStarted = Promise.withResolvers();
      const secondStarted = Promise.withResolvers();
      const lateAbort = new AbortController();
      let oldMcp;
      let secondCtx;
      let lateSettlement;
      let lateCall;
      driver.setOnRun(async ctx => {
        if (driver.runs.length === 1) {
          oldMcp = ctx.mcp;
          firstStarted.resolve();
          if (previousTurn === 'completed') finishTurn(ctx, 'first reply');
        } else {
          secondCtx = ctx;
          secondStarted.resolve();
        }
      });
      try {
        const firstInput = user('First turn.');
        const firstRequest = send(service, [BASE_SYSTEM, firstInput]);
        await firstStarted.promise;
        if (previousTurn === 'cancelled') await service.cancel({ deviceId: DEVICE_ID, sessionId: SESSION_ID });
        const first = await firstRequest;
        assert.equal(first.terminal.reason, previousTurn === 'completed' ? 'stop' : 'aborted');

        const nextMessages = previousTurn === 'completed'
          ? [BASE_SYSTEM, firstInput, first.terminal.message, user('Second turn.', 20)]
          : [BASE_SYSTEM, user('Second turn after cancellation.', 20)];
        const nextRequest = send(service, nextMessages);
        await secondStarted.promise;
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

test('ACP rebuilds a ready conversation when explicit reasoning is removed from the next request', { timeout: 15_000 }, async t => {
  await centerCase(t, 'ready-reasoning', async ({ driver, service }) => {
    const initial = [BASE_SYSTEM, user('READY_HIGH_REASONING_HISTORY')];
    const first = await send(service, initial, { reasoning: 'high' });
    assert.equal(first.terminal.reason, 'stop');
    const next = await send(service, [...initial, first.terminal.message, user('Continue using the default reasoning setting.', 12)]);
    assert.equal(next.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2);
    assert.equal(driver.runs[1].request.conversationId, null, 'native thought settings must not leak from the previous ready turn');
    assert.ok(driver.runs[1].request.contextBlock.text.includes('READY_HIGH_REASONING_HISTORY'));
    const previousReply = first.terminal.message.content.find(block => block.type === 'text').text;
    assert.ok(driver.runs[1].request.contextBlock.text.includes(previousReply));
  });
});

test('ACP reloads persisted model and reasoning before reusing a ready conversation after restart', { timeout: 15_000 }, async t => {
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

    const afterRestart = [...initial, first.terminal.message, user('SAME_CONFIG_AFTER_RESTART', 12)];
    const second = await send(service, afterRestart, { reasoning: 'high' });
    assert.equal(second.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, nativeId, 'persisted matching model and reasoning must permit normal reuse');

    const nextModel = 'gemini-3-flash';
    const afterModelChange = [...afterRestart, second.terminal.message, user('Continue on the new model.', 14)];
    const third = await send(service, afterModelChange, { modelId: nextModel, reasoning: 'high' });
    assert.equal(third.terminal.reason, 'stop');
    assert.equal(driver.runs[2].request.model, nextModel);
    assert.equal(driver.runs[2].request.conversationId, null);
    assert.ok(driver.runs[2].request.contextBlock.text.includes('PERSISTED_CONFIG_HISTORY'));
    assert.ok(driver.runs[2].request.contextBlock.text.includes('SAME_CONFIG_AFTER_RESTART'));

    const afterReasoningChange = [...afterModelChange, third.terminal.message, user('Restore the default reasoning setting.', 16)];
    const fourth = await send(service, afterReasoningChange, { modelId: nextModel });
    assert.equal(fourth.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 4);
    assert.equal(driver.runs[3].request.conversationId, null);
    assert.ok(driver.runs[3].request.contextBlock.text.includes('PERSISTED_CONFIG_HISTORY'));
    assert.ok(driver.runs[3].request.contextBlock.text.includes('Continue on the new model.'));
  } finally {
    await closeAndRemove({ antigravity: service, rootDir });
  }
});

test('ACP starts a new native run when the model changes during a parked tool continuation', { timeout: 15_000 }, async t => {
  await centerCase(t, 'parked-model', async ({ driver, service }) => {
    const nextModel = 'gemini-3-flash';
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        await ctx.mcp.handler.onToolCall('model-call', 'read_file', { path: 'x' }, ctx.signal);
      }
      finishTurn(ctx, 'continued using the selected model');
    });
    const initial = [BASE_SYSTEM, user('Read the file and continue.')];
    const first = await send(service, initial);
    assert.equal(first.terminal.reason, 'toolUse');
    const result = await send(service, [
      ...initial, first.terminal.message, toolResult('model-call', 'read_file', 'MODEL_SWITCH_REAL_RESULT', 12),
    ], { modelId: nextModel });
    assert.equal(result.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2, 'the previous model must not finish through parked reentry');
    assert.equal(driver.runs[1].request.model, nextModel);
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes('MODEL_SWITCH_REAL_RESULT'));
    assert.equal(result.terminal.message.model, nextModel);
  });
});

test('ACP starts a new native run when reasoning changes during a parked continuation on the same model', { timeout: 15_000 }, async t => {
  await centerCase(t, 'parked-reasoning', async ({ driver, service }) => {
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        await ctx.mcp.handler.onToolCall('reasoning-call', 'read_file', { path: 'x' }, ctx.signal);
      }
      finishTurn(ctx, 'continued with the selected reasoning level');
    });
    const initial = [BASE_SYSTEM, user('Read the file before choosing the next step.')];
    const first = await send(service, initial, { reasoning: 'off' });
    assert.equal(first.terminal.reason, 'toolUse');
    const result = await send(service, [
      ...initial, first.terminal.message,
      toolResult('reasoning-call', 'read_file', 'REASONING_SWITCH_REAL_RESULT', 12),
    ], { reasoning: 'high' });
    assert.equal(result.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2, 'changed reasoning cannot continue the previous native prompt');
    assert.equal(driver.runs[0].request.model, MODEL_ID);
    assert.equal(driver.runs[1].request.model, MODEL_ID);
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes('Read the file before choosing the next step.'));
    assert.ok(driver.runs[1].request.contextBlock.text.includes('reasoning-call'));
    assert.ok(driver.runs[1].request.contextBlock.text.includes('REASONING_SWITCH_REAL_RESULT'));
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

test('ACP retires dedicated compaction drivers and persisted bindings after their tasks complete', { timeout: 15_000 }, async t => {
  await centerCase(t, 'summary-cleanup', async ({ driver, rootDir, service }) => {
    const conversationUuid = randomUUID();
    const sessionIds = [1, 2].map(taskId => JSON.stringify(['antigravity-compaction', conversationUuid, taskId]));
    for (const sessionId of sessionIds) {
      const result = await send(service, [BASE_SYSTEM, user('Summarize this isolated task.')], { sessionId });
      assert.equal(result.terminal.reason, 'stop');
    }
    assert.equal(driver.runs.length, 2);
    assert.notEqual(driver.runs[0].driver, driver.runs[1].driver);
    const sessionsPath = path.join(rootDir, 'center', 'antigravity', 'sessions.json');
    const bindings = () => fs.existsSync(sessionsPath) ? JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) : {};
    await waitUntil(() => driver.runs.every(record => record.driverState.state === 'dead') && Object.keys(bindings()).length === 0, {
      timeoutMs: 5_000, label: 'completed compaction drivers and bindings to be retired',
    });
    for (const record of driver.runs) assert.equal(record.driverState.state, 'dead');
    assert.deepEqual(bindings(), {}, 'one-shot summarization tasks must not accumulate in sessions.json');
  });
});
