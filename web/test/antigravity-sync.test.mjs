import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createControlledAcpDriverHarness, openIsolatedAntigravity, openTestHostRuntime,
  closeAndRemove, drainEventStream, waitUntil, asstText, asstToolCall, toolResult,
  BASE_SYSTEM, BASE_MODEL_SEL, MODEL_ID, USER_ORIGIN,
} from './helpers/antigravity-sync-harness.mjs';
import { AcpConnection } from '../../center-server/antigravity/vendor/acp/connection.ts';
import { AcpDriver } from '../../center-server/antigravity/vendor/acp/driver.ts';
import { TextAccumulator } from '../../center-server/antigravity/vendor/acp/events.ts';
import { createContextSnapshot, contextPrefixMatches, buildContextReplay } from '../../center-server/antigravity/context-sync.ts';
import { collectToolResults } from '../../center-server/antigravity/round-trips.ts';

async function realHostCase(t, body) {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-audit-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd);
  let runtime, antigravity;
  try {
    antigravity = openIsolatedAntigravity(rootDir);
    const captured = [];
    const env = await openTestHostRuntime({ rootDir, antigravity, capturedPayloads: captured });
    runtime = env.runtime;
    const bot = await runtime.createBot({ requestId: 'create-audit', role: 'Audit', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));
    const send = async (requestId, text) => {
      await runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      assert.equal((await env.waitForSubmission(bot.botId, requestId)).status, 'done');
    };
    await body({ driver, env, runtime, captured, bot, send });
  } finally {
    await closeAndRemove({ runtime, antigravity, rootDir });
  }
}

test('ACP /clear rotates the persisted Host identity and creates a clean native conversation', async t => {
  await realHostCase(t, async ({ driver, runtime, captured, bot, send }) => {
    await send('before-clear', 'OLD_HISTORY_SECRET_7');
    const nativeId = driver.runs[0].assignedConversationId;
    await runtime.clearHistory(bot.botId);
    await send('after-clear', 'A new conversation starts here.');
    assert.notEqual(captured[0].sessionId, captured[1].sessionId);
    assert.ok(!JSON.stringify(captured[1].delta.messages).includes('OLD_HISTORY_SECRET_7'));
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.notEqual(driver.runs[1].assignedConversationId, nativeId);
    assert.ok(!JSON.stringify(driver.runs[1].request).includes('OLD_HISTORY_SECRET_7'));
  });
});

test('ACP SOUL changes require explicit clear before updated instructions reach native', async t => {
  await realHostCase(t, async ({ driver, env, runtime, captured, bot, send }) => {
    await send('before-soul', 'Hello.');
    const soul = await runtime.getBotSoul(bot.botId);
    const marker = 'NEW_SOUL_RULE_8_REQUIRED';
    await runtime.setBotSoul(bot.botId, { expectedRevision: soul.revision, text: soul.text + '\n' + marker });
    await runtime.submit(bot.botId, { requestId: 'after-soul', text: 'Please continue.', origin: USER_ORIGIN });
    const rejected = await env.waitForSubmission(bot.botId, 'after-soul');
    assert.notEqual(rejected.status, 'done');
    const history = await runtime.history(bot.botId, { limit: 30 });
    assert.match(JSON.stringify(history), /AGY_HISTORY_CHANGED|\/clear/);
    assert.equal(driver.runs.length, 1, 'changed Soul must not create or prompt another native session');
    assert.equal(captured.length, 1, 'Host should reject changed configuration before upload');
    await runtime.clearHistory(bot.botId);
    await send('after-soul-clear', 'Start with the new Soul.');
    assert.match(driver.runs[1].request.systemPrompt, new RegExp(marker));
    assert.equal(driver.runs[1].request.conversationId, null);
  });
});

function request(service, messages, sessionId = 'audit-session') {
  return drainEventStream(service.stream({
    deviceId: 'audit-device', sessionId, modelId: MODEL_ID, messages,
    turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] },
  }));
}
const user = (text, timestamp = 10) => ({ role: 'user', content: text, timestamp });

test('ACP sends all unsent user inputs once without replaying acknowledged history', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-batch-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const firstInput = [BASE_SYSTEM, user('initial')];
    const first = await request(service, firstInput);
    const longInput = 'UNSENT_SECRET_9 ' + 'X'.repeat(9000);
    const messages = [...firstInput, first.terminal.message, user(longInput, 12), user('latest input', 14)];
    const second = await request(service, messages);
    assert.equal(second.terminal.reason, 'stop');
    assert.ok(driver.runs[1].request.prompt.includes(longInput));
    assert.ok(driver.runs[1].request.prompt.includes('latest input'));
    assert.equal(driver.runs[1].request.contextBlock, undefined);
    assert.ok(!driver.runs[1].request.prompt.includes('ack:'));
    await request(service, [...messages, second.terminal.message, user('next', 16)]);
    assert.equal(driver.runs[2].request.conversationId, driver.runs[0].assignedConversationId);
    assert.ok(!driver.runs[2].request.prompt.includes(longInput));
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP new bindings reject retained assistant history instead of silently replaying it', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-new-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const result = await request(service, [BASE_SYSTEM, user('Earlier question'), asstText('ANSWER_ONLY_MARKER_10', 11), user('Use the earlier answer', 12)]);
    assert.equal(result.terminal.reason, 'error');
    assert.match(result.terminal.error.errorMessage, /AGY_HISTORY_CHANGED.*\/clear/);
    assert.equal(driver.runs.length, 0);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP Center restart requires clear for a lost parked native continuation', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-park-'));
  let service = openIsolatedAntigravity(rootDir);
  try {
    driver.setOnRun(async ctx => {
      await ctx.mcp.handler.onToolCall('parked-id', 'read_file', { path: 'README.md' }, ctx.signal);
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: '', finished: true, aborted: false });
    });
    const initial = [BASE_SYSTEM, user('Read file')];
    const first = await request(service, initial);
    assert.equal(first.terminal.reason, 'toolUse');
    await service.close();
    service = openIsolatedAntigravity(rootDir);
    const result = await request(service, [...initial, first.terminal.message, toolResult('parked-id', 'read_file', 'UNIQUE_TOOL_RESULT_11', 12)]);
    assert.equal(result.terminal.reason, 'error');
    assert.match(result.terminal.error.errorMessage, /\/clear/);
    assert.equal(driver.runs.length, 1, 'the real tool result cannot be replayed into a replacement native session');
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP session/load failure asks for clear without creating a replacement session', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-load-'));
  const captures = [];
  let newCount = 0;
  t.mock.getter(AcpConnection.prototype, 'alive', () => true);
  t.mock.method(AcpConnection.prototype, 'start', async () => {});
  t.mock.method(AcpConnection.prototype, 'newSession', async () => ({ sessionId: 'native-' + ++newCount }));
  t.mock.method(AcpConnection.prototype, 'loadSession', async () => { throw new Error('session file missing'); });
  t.mock.method(AcpConnection.prototype, 'setConfigOption', async () => ({}));
  t.mock.method(AcpConnection.prototype, 'prompt', async (sessionId, prompt, images, contextBlock, recall, lifecycle) => {
    captures.push({ sessionId, prompt });
    lifecycle?.onTerminal?.();
    return { stopReason: 'end_turn' };
  });
  const service = openIsolatedAntigravity(rootDir);
  try {
    const initial = [BASE_SYSTEM, user('OLD_CONTEXT_MARKER_12')];
    const first = await request(service, initial);
    assert.equal(first.terminal.reason, 'stop');
    const result = await request(service, [...initial, first.terminal.message, user('Next question', 12)]);
    assert.equal(result.terminal.reason, 'error');
    assert.match(result.terminal.error.errorMessage, /\/clear/);
    assert.equal(captures.length, 1);
    assert.equal(newCount, 1);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP repeated text deltas preserve all received characters', () => {
  const acc = new TextAccumulator();
  acc.append('x'.repeat(32));
  acc.append('x'.repeat(33));
  acc.flush();
  assert.equal(acc.text, 'x'.repeat(65));
});

test('ACP preserves current user and live tool-result whitespace without replay', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-whitespace-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const userText = '  KEEP_USER_WHITESPACE\n  ';
    const initial = [BASE_SYSTEM, { role: 'user', content: [{ type: 'text', text: userText }], timestamp: 10 }];
    const first = await request(service, initial);
    assert.ok(driver.runs[0].request.prompt.endsWith(userText));
    const resultText = '  KEEP_RESULT_WHITESPACE\n  ';
    let delivered;
    driver.setOnRun(async ctx => {
      delivered = await ctx.mcp.handler.onToolCall('whitespace-call', 'read_file', { path: 'README.md' }, ctx.signal);
      ctx.emit({ type: 'text', delta: 'read complete' });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'read complete', finished: true, aborted: false });
    });
    const messages = [...initial, first.terminal.message, user('Read the file.', 11)];
    const parked = await request(service, messages);
    assert.equal(parked.terminal.reason, 'toolUse');
    const continuation = [...messages, parked.terminal.message, toolResult('whitespace-call', 'read_file', resultText, 12)];
    assert.equal(collectToolResults(continuation, ['whitespace-call'])[0].text, resultText);
    assert.equal((await request(service, continuation)).terminal.reason, 'stop');
    assert.equal(delivered.content[0].text, resultText);
    assert.equal(driver.runs.length, 2, 'tool continuation stays in the same native turn');
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP checkpoints compare semantic content, not counts or incidental transport metadata', () => {
  const original = [BASE_SYSTEM, user('same text')];
  const snapshot = createContextSnapshot(original);
  const normalized = [BASE_SYSTEM, { role: 'user', content: [{ type: 'text', text: 'same text' }], timestamp: 100, usage: {} }];
  assert.deepEqual(createContextSnapshot(normalized), snapshot);
  const assistant = asstText('answer', 12);
  assert.deepEqual(
    createContextSnapshot([...original, { ...assistant, thinkingLevel: 'off' }]),
    createContextSnapshot([...original, assistant]),
    'the SDK thinkingLevel decoration on an assistant message must not change its content checkpoint',
  );
  const toolCall = asstToolCall('thinking-argument', 'read_file', { path: 'a', thinkingLevel: 'off' }, 13);
  const changedToolCall = asstToolCall('thinking-argument', 'read_file', { path: 'a', thinkingLevel: 'high' }, 13);
  assert.ok(!contextPrefixMatches(
    createContextSnapshot([...original, toolCall]),
    createContextSnapshot([...original, changedToolCall]),
  ), 'a tool argument named thinkingLevel remains meaningful conversation content');
  assert.ok(contextPrefixMatches(snapshot, createContextSnapshot([...original, asstText('answer', 12)])));
  assert.ok(!contextPrefixMatches(snapshot, createContextSnapshot([BASE_SYSTEM, user('changed text')])));
  assert.ok(!contextPrefixMatches(snapshot, createContextSnapshot([BASE_SYSTEM])));
  assert.ok(!contextPrefixMatches(snapshot, createContextSnapshot([{ ...BASE_SYSTEM, content: 'New system policy' }, user('same text')])));
  assert.ok(!contextPrefixMatches(snapshot, createContextSnapshot([...original, { role: 'system', content: '', toolsRemoved: [{ name: 'read_file' }], timestamp: 0 }])));
  assert.ok(!contextPrefixMatches({ version: 0, ...snapshot, messageHashes: ['not-a-hash'] }, snapshot));
  assert.ok(!contextPrefixMatches({ lastMessageCount: 2 }, snapshot));
});

test('ACP replay retains own replies, tool arguments, images and literal compaction text without truncation', () => {
  const image = { type: 'image', data: 'aGlzdG9yeQ==', mimeType: 'image/png' };
  const messages = [BASE_SYSTEM, user('literal compacted into the following summary phrase'),
    asstText('A'.repeat(10000), 11), asstToolCall('old-call', 'read_file', { path: '/important', timestamp: 7, usage: 'argument' }, 12),
    toolResult('old-call', 'read_file', [{ type: 'text', text: 'actual-result' }, image], 13),
    user('current input', 14)];
  const replay = buildContextReplay(messages, { endIndex: 5 });
  assert.ok(replay.text.includes('literal compacted into the following summary phrase'));
  assert.ok(replay.text.includes('A'.repeat(10000)));
  assert.ok(replay.text.includes('"timestamp":7'));
  assert.ok(replay.text.includes('"usage":"argument"'));
  assert.ok(replay.text.includes('old-call') && replay.text.includes('/important') && replay.text.includes('actual-result'));
  assert.ok(replay.text.includes('[attached history image 1]'));
  assert.ok(!replay.text.includes('current input"'));
  assert.deepEqual(replay.images, [{ data: image.data, mimeType: image.mimeType }]);
  assert.throws(() => buildContextReplay(messages, { endIndex: 2, skipMessages: 2 }), /exceeds/);
  assert.throws(() => createContextSnapshot([user('bad'), { role: 'user', content: [1n] }]), /non-JSON/);
});

test('ACP append-only conversation reuses its binding without replaying acknowledged replies', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-append-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const firstMessages = [BASE_SYSTEM, user('first')];
    const first = await request(service, firstMessages);
    await request(service, [...firstMessages, first.terminal.message, user('second', 20)]);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
    assert.equal(driver.runs[1].request.contextBlock, undefined);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP same-length history edits require clear and leave the native session untouched', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-rewrite-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const first = await request(service, [BASE_SYSTEM, user('WRONG_OLD_FACT')]);
    const result = await request(service, [BASE_SYSTEM, user('CORRECTED_FACT'), first.terminal.message, user('continue', 20)]);
    assert.equal(result.terminal.reason, 'error');
    assert.match(result.terminal.error.errorMessage, /\/clear/);
    assert.equal(driver.runs.length, 1);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP refuses a BC projection instead of rewriting native history', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-compress-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    await request(service, [BASE_SYSTEM, user('before compression', 14)]);
    const messages = [BASE_SYSTEM, { ...user('BC_SUMMARY', 0), bcSummaryMaterial: true }, user('after compression', 20)];
    const result = await drainEventStream(service.stream({ deviceId: 'audit-device', sessionId: 'audit-session', modelId: MODEL_ID, messages,
      turnContext: { inputIndex: 2, auxiliaryIndices: [1] } }));
    assert.equal(result.terminal.reason, 'error');
    assert.match(result.terminal.error.errorMessage, /\/clear/);
    assert.equal(driver.runs.length, 1);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP retransmits a completed cached answer without prompting the native model twice', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-retry-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const messages = [BASE_SYSTEM, user('request whose response was lost')];
    const first = await request(service, messages);
    const retried = await request(service, messages);
    assert.deepEqual(retried.terminal.message.content, first.terminal.message.content);
    assert.equal(retried.terminal.message.timestamp, first.terminal.message.timestamp);
    assert.equal(driver.runs.length, 1);
    await request(service, [...messages, retried.terminal.message, user('A new turn', 20)]);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP cancellation preserves native identity and does not redispatch the interrupted input', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-cancel-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const initial = [BASE_SYSTEM, user('established history')];
    const first = await request(service, initial);
    const messages = [...initial, first.terminal.message, user('interrupted question', 20)];
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 2) { ctx.emit({ type: 'text', delta: 'partial output' }); return; }
      ctx.emit({ type: 'text', delta: 'continued' });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'continued', finished: true, aborted: false });
    });
    const pending = request(service, messages);
    await waitUntil(() => driver.runs.length === 2);
    await service.cancel({ deviceId: 'audit-device', sessionId: 'audit-session' });
    const cancelled = await pending;
    assert.equal(cancelled.terminal.reason, 'aborted');
    assert.equal((await request(service, messages)).terminal.reason, 'aborted');
    assert.equal(driver.runs.length, 2);
    const continued = await request(service, [...messages, cancelled.terminal.error, user('Continue from the interruption.', 21)]);
    assert.equal(continued.terminal.reason, 'stop');
    assert.equal(driver.runs[2].request.conversationId, driver.runs[0].assignedConversationId);
    assert.ok(!driver.runs[2].request.prompt.includes('interrupted question'));
    assert.equal(driver.runs[2].request.contextBlock, undefined);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP refuses to start another native turn when the recovery checkpoint cannot be persisted', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-storage-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const first = await request(service, [BASE_SYSTEM, user('first')]);
    const original = fs.promises.rename;
    let fail = true;
    t.mock.method(fs.promises, 'rename', async function (from, to) {
      if (fail && path.basename(String(to)) === 'sessions.json') throw new Error('ENOSPC checkpoint');
      return original.call(this, from, to);
    });
    const messages = [BASE_SYSTEM, user('first'), first.terminal.message, user('next', 20)];
    const result = await request(service, messages);
    fail = false;
    assert.equal(result.terminal.type, 'error');
    assert.equal(driver.runs.length, 1, 'a failed write-ahead checkpoint must prevent native dispatch');
    const recovered = await request(service, messages);
    assert.equal(recovered.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId, 'a failed receipt write must not rebuild the native session');
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP Host compaction requires clear without changing the persisted conversation', async t => {
  await realHostCase(t, async ({ driver, runtime, captured, bot, send }) => {
    await send('long-history', 'older conversation material '.repeat(3500));
    await send('recent-history', 'keep this recent material '.repeat(3500));
    const history = await runtime.history(bot.botId, { limit: 30 });
    const before = captured.length;
    await assert.rejects(runtime.compact(bot.botId), /\/clear/);
    assert.equal(captured.length, before);
    assert.deepEqual(await runtime.history(bot.botId, { limit: 30 }), history);
    await send('after-compaction', 'Continue without rewriting history.');
    assert.equal(driver.runs.at(-1).request.conversationId, driver.runs[0].assignedConversationId);
  });
});

test('ACP real Host rejects history editing without forking the native binding', async t => {
  await realHostCase(t, async ({ driver, runtime, captured, bot, send }) => {
    await send('edit-first', 'First retained question.');
    await send('edit-second', 'Second original question.');
    const history = await runtime.history(bot.botId, { limit: 30 });
    const target = history.items.find(entry => entry.model?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Second original question.')));
    assert.ok(target);
    await assert.rejects(runtime.editMessage(bot.botId, { entryId: target.id, requestId: 'edit-revised', text: 'Second revised question.' }), /\/clear/);
    assert.deepEqual(await runtime.history(bot.botId, { limit: 30 }), history);
    assert.equal(captured.length, 2);
    assert.equal(driver.runs.length, 2);
    assert.equal(driver.runs[1].request.conversationId, driver.runs[0].assignedConversationId);
  });
});

test('ACP real JSON-RPC driver stops before prompting a failed load and preserves repeated delta frames', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-rpc-'));
  const script = path.join(rootDir, 'fake-acp.mjs');
  const logFile = path.join(rootDir, 'requests.jsonl');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const logFile = process.argv[2];
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(logFile, JSON.stringify({ method, params }) + '\\n');
  if (method === 'session/load') { send({ id, error: { code: -32602, message: 'missing native session' } }); continue; }
  if (method === 'session/new') { send({ id, result: { sessionId: 'fresh-native', configOptions: [] } }); continue; }
  if (method === 'session/prompt') {
    for (const n of [32, 33]) send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(n) } } } });
    send({ id, result: { stopReason: 'end_turn' } }); continue;
  }
  if (id !== undefined) send({ id, result: {} });
}
`, 'utf8');
  const driver = new AcpDriver({ bin: process.execPath, binArgs: [script, logFile] });
  const base = { cwd: rootDir, model: MODEL_ID, mode: 'default', skipPermissions: false, prompt: 'current input' };
  try {
    const failed = await driver.run({ ...base, conversationId: 'missing-native' });
    while (await failed.next()) { /* drain */ }
    const failure = await failed.outcome;
    assert.equal(failure.status, 'ERROR');
    assert.equal(failure.sessionLoadFailed, true);
    assert.equal(failure.conversationId, 'missing-native');
    const initialRequests = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!initialRequests.some(frame => frame.method === 'session/new' || frame.method === 'session/prompt'));
    const rebuilt = await driver.run({ ...base, conversationId: null, contextBlock: { uri: 'urn:pibot:test-history', text: 'full recovered history' } });
    const deltas = [];
    for (;;) { const activity = await rebuilt.next(); if (!activity) break; if (activity.type === 'text') deltas.push(activity.delta); }
    const outcome = await rebuilt.outcome;
    assert.equal(outcome.status, 'OK');
    assert.equal(outcome.response, 'x'.repeat(65));
    assert.equal(deltas.join(''), 'x'.repeat(65));
    const requests = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    const prompts = requests.filter(frame => frame.method === 'session/prompt');
    assert.equal(prompts.length, 1);
    assert.ok(JSON.stringify(prompts[0]).includes('full recovered history'));
  } finally {
    await driver.close('shutdown');
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
