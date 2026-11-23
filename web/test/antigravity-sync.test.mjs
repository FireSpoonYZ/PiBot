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
    assert.ok(!JSON.stringify(captured[1].messages).includes('OLD_HISTORY_SECRET_7'));
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.notEqual(driver.runs[1].assignedConversationId, nativeId);
    assert.ok(!JSON.stringify(driver.runs[1].request).includes('OLD_HISTORY_SECRET_7'));
  });
});

test('ACP SOUL changes rebuild native context with updated instructions and retained conversation', async t => {
  await realHostCase(t, async ({ driver, runtime, captured, bot, send }) => {
    await send('before-soul', 'Hello.');
    const soul = await runtime.getBotSoul(bot.botId);
    const marker = 'NEW_SOUL_RULE_8_REQUIRED';
    await runtime.setBotSoul(bot.botId, { expectedRevision: soul.revision, text: `${soul.text}\n${marker}` });
    await send('after-soul', 'Please continue.');
    assert.ok(JSON.stringify(captured[1].messages).includes(marker));
    assert.ok(JSON.stringify(driver.runs[1].request).includes(marker));
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes('Hello.'));
    assert.ok(driver.runs[1].request.contextBlock.text.includes('ack:'));
  });
});

function request(service, messages, sessionId = 'audit-session') {
  return drainEventStream(service.stream({
    deviceId: 'audit-device', sessionId, modelId: MODEL_ID, messages,
    turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] },
  }));
}
const user = (text, timestamp = 10) => ({ role: 'user', content: text, timestamp });

test('ACP catch-up preserves long history without acknowledging truncated content', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-digest-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const first = await request(service, [BASE_SYSTEM, user('initial')]);
    const messages = [BASE_SYSTEM, user('initial'), first.terminal.message,
      user('UNSENT_SECRET_9', 12), asstText('X'.repeat(9000), 13, 'other-provider'), user('back to agy', 14)];
    const second = await request(service, messages);
    assert.equal(second.terminal.reason, 'stop');
    assert.ok(driver.runs[1].request.contextBlock.text.includes('UNSENT_SECRET_9'));
    assert.ok(driver.runs[1].request.contextBlock.text.includes('X'.repeat(9000)));
    assert.ok(!driver.runs[1].request.contextBlock.text.includes('[truncated]'));
    await request(service, [...messages, second.terminal.message, user('next', 16)]);
    assert.equal(driver.runs[2].request.conversationId, driver.runs[1].assignedConversationId);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP new bindings replay retained own-provider assistant content', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-new-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    await request(service, [BASE_SYSTEM, user('Earlier question'), asstText('ANSWER_ONLY_MARKER_10', 11), user('Use the earlier answer', 12)]);
    assert.equal(driver.runs[0].request.conversationId, null);
    assert.ok(driver.runs[0].request.contextBlock.text.includes('Earlier question'));
    assert.ok(JSON.stringify(driver.runs[0].request).includes('ANSWER_ONLY_MARKER_10'));
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP Center restart restores the actual parked tool result in a rebuilt native context', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-park-'));
  let service = openIsolatedAntigravity(rootDir);
  try {
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 1) {
        await ctx.mcp.handler.onToolCall('parked-id', 'read_file', { path: 'README.md' }, ctx.signal);
        ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: '', finished: true, aborted: false });
      } else {
        ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'continued', finished: true, aborted: false });
      }
    });
    const initial = [BASE_SYSTEM, user('TRIGGER_PARK: read file')];
    assert.equal((await request(service, initial)).terminal.reason, 'toolUse');
    await service.close();
    service = openIsolatedAntigravity(rootDir);
    const result = await request(service, [...initial, asstToolCall('parked-id', 'read_file', { path: 'README.md' }, 11), toolResult('parked-id', 'read_file', 'UNIQUE_TOOL_RESULT_11', 12)]);
    assert.equal(result.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(JSON.stringify(driver.runs[1].request).includes('UNIQUE_TOOL_RESULT_11'));
    assert.ok(JSON.stringify(driver.runs[1].request).includes('parked-id'));
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP session/load failure rebuilds full context before a single safe retry', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-load-'));
  const captures = [];
  let newCount = 0;
  t.mock.getter(AcpConnection.prototype, 'alive', () => true);
  t.mock.method(AcpConnection.prototype, 'start', async () => {});
  t.mock.method(AcpConnection.prototype, 'newSession', async () => ({ sessionId: `native-${++newCount}` }));
  t.mock.method(AcpConnection.prototype, 'loadSession', async () => { throw new Error('session file missing'); });
  t.mock.method(AcpConnection.prototype, 'setConfigOption', async () => ({}));
  t.mock.method(AcpConnection.prototype, 'prompt', async (sessionId, prompt, images, contextBlock) => {
    captures.push({ sessionId, prompt, images, contextBlock });
    return { stopReason: 'end_turn' };
  });
  const service = openIsolatedAntigravity(rootDir);
  try {
    const first = await request(service, [BASE_SYSTEM, user('OLD_CONTEXT_MARKER_12')]);
    assert.equal(first.terminal.reason, 'stop');
    const result = await request(service, [BASE_SYSTEM, user('OLD_CONTEXT_MARKER_12'), first.terminal.message, user('Next question', 12)]);
    assert.equal(result.terminal.reason, 'stop');
    assert.notEqual(captures[0].sessionId, captures[1].sessionId);
    assert.equal(captures.length, 2);
    assert.equal(newCount, 2);
    assert.ok(JSON.stringify(captures[1]).includes('OLD_CONTEXT_MARKER_12'));
    assert.ok(JSON.stringify(captures[1]).includes(BASE_SYSTEM.content));
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP repeated text deltas preserve all received characters', () => {
  const acc = new TextAccumulator();
  acc.append('x'.repeat(32));
  acc.append('x'.repeat(33));
  acc.flush();
  assert.equal(acc.text, 'x'.repeat(65));
});

test('ACP preserves leading and trailing whitespace in current user and recovered tool result text', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-whitespace-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const userText = '  KEEP_USER_WHITESPACE\n  ';
    await request(service, [BASE_SYSTEM, { role: 'user', content: [{ type: 'text', text: userText }], timestamp: 10 }]);
    assert.ok(driver.runs[0].request.prompt.endsWith(userText));

    const resultText = '  KEEP_RESULT_WHITESPACE\n  ';
    const messages = [BASE_SYSTEM, user('Read the file.'),
      asstToolCall('whitespace-call', 'read_file', { path: 'README.md' }, 11),
      toolResult('whitespace-call', 'read_file', [{ type: 'text', text: resultText }], 12)];
    const [collected] = collectToolResults(messages, ['whitespace-call']);
    assert.equal(collected.text, resultText);
    const recovered = await request(service, messages);
    assert.equal(recovered.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes(JSON.stringify(resultText)));
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

test('ACP same-length history edits rebuild instead of trusting the old message count', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-rewrite-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const first = await request(service, [BASE_SYSTEM, user('WRONG_OLD_FACT')]);
    await request(service, [BASE_SYSTEM, user('CORRECTED_FACT'), first.terminal.message, user('continue', 20)]);
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes('CORRECTED_FACT'));
    assert.ok(!driver.runs[1].request.contextBlock.text.includes('WRONG_OLD_FACT'));
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP compressed BC projections rebuild with the new auxiliary summary', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-compress-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    await request(service, [BASE_SYSTEM, user('old-one'), asstText('old-answer', 11), user('old-two', 12), asstText('old-answer-two', 13), user('before compression', 14)]);
    const messages = [BASE_SYSTEM, { ...user('BC_SUMMARY_MUST_REACH_AGY', 0), bcSummaryMaterial: true }, user('after compression', 20)];
    const result = await drainEventStream(service.stream({ deviceId: 'audit-device', sessionId: 'audit-session', modelId: MODEL_ID, messages,
      turnContext: { inputIndex: 2, auxiliaryIndices: [1] } }));
    assert.equal(result.terminal.reason, 'stop');
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.ok(driver.runs[1].request.contextBlock.text.includes('BC_SUMMARY_MUST_REACH_AGY'));
    assert.ok(!driver.runs[1].request.contextBlock.text.includes('old-one'));
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP unacknowledged completed output cannot make a retried input reuse stale native history', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-retry-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const messages = [BASE_SYSTEM, user('request whose response was lost')];
    await request(service, messages);
    await request(service, messages);
    assert.equal(driver.runs[1].request.conversationId, null);
    assert.notEqual(driver.runs[1].assignedConversationId, driver.runs[0].assignedConversationId);
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP cancellation invalidates the old native binding before retry', async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sync-cancel-'));
  const service = openIsolatedAntigravity(rootDir);
  try {
    const initial = [BASE_SYSTEM, user('established history')];
    const first = await request(service, initial);
    const messages = [...initial, first.terminal.message, user('interrupted question', 20)];
    driver.setOnRun(async ctx => {
      if (driver.runs.length === 2) { ctx.emit({ type: 'text', delta: 'partial discarded output' }); return; }
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'recovered', finished: true, aborted: false });
    });
    const pending = request(service, messages);
    await waitUntil(() => driver.runs.length === 2);
    await service.cancel({ deviceId: 'audit-device', sessionId: 'audit-session' });
    assert.equal((await pending).terminal.reason, 'aborted');
    const retried = await request(service, messages);
    assert.equal(retried.terminal.reason, 'stop');
    assert.equal(driver.runs[2].request.conversationId, null);
    assert.ok(driver.runs[2].request.contextBlock.text.includes('established history'));
    assert.ok(!JSON.stringify(driver.runs[2].request).includes('partial discarded output'));
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
      if (fail && String(to).endsWith('/sessions.json')) throw new Error('ENOSPC checkpoint');
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
    assert.equal(driver.runs[1].request.conversationId, null, 'recovery must rebuild the uncertain native binding');
  } finally { await closeAndRemove({ antigravity: service, rootDir }); }
});

test('ACP native SDK compaction uses an isolated identity and its own summarization instructions', async t => {
  await realHostCase(t, async ({ driver, runtime, captured, bot, send }) => {
    await send('long-history', 'older conversation material '.repeat(3500));
    await send('recent-history', 'keep this recent material '.repeat(3500));
    const chatIdentity = captured[0].sessionId;
    const before = captured.length;
    const compacted = await runtime.compact(bot.botId);
    assert.equal(compacted.compacted, true);
    assert.ok(captured.length > before);
    const summaryRequest = captured[before];
    assert.notEqual(summaryRequest.sessionId, chatIdentity);
    const identity = JSON.parse(summaryRequest.sessionId);
    assert.equal(identity[0], 'antigravity-compaction');
    assert.equal(identity[1], chatIdentity);
    assert.ok(Number.isSafeInteger(identity[2]));
    assert.equal(driver.runs[before].request.conversationId, null);
    assert.ok(driver.runs[before].request.prompt.includes('context summarization assistant'));
    await send('after-compaction', 'Continue after compaction.');
    assert.equal(captured.at(-1).sessionId, chatIdentity);
  });
});

test('ACP real Host history editing forks the binding and retains the earlier native answer', async t => {
  await realHostCase(t, async ({ driver, env, runtime, captured, bot, send }) => {
    driver.setOnRun(async ctx => {
      const reply = driver.runs.length === 1 ? 'ANSWER_ONLY_KEEP_AFTER_FORK' : 'later answer';
      ctx.emit({ type: 'text', delta: reply });
      ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: reply, finished: true, aborted: false });
    });
    await send('edit-first', 'First retained question.');
    await send('edit-second', 'Second original question.');
    const history = await runtime.history(bot.botId, { limit: 30 });
    const target = history.items.find(entry => entry.model?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Second original question.')));
    assert.ok(target);
    await runtime.editMessage(bot.botId, { entryId: target.id, requestId: 'edit-revised', text: 'Second revised question.' });
    assert.equal((await env.waitForSubmission(bot.botId, 'edit-revised')).status, 'done');
    assert.notEqual(captured.at(-1).sessionId, captured[0].sessionId);
    const replay = driver.runs.at(-1).request;
    assert.equal(replay.conversationId, null);
    assert.ok(replay.contextBlock.text.includes('ANSWER_ONLY_KEEP_AFTER_FORK'));
    assert.ok(replay.contextBlock.text.includes('First retained question.'));
    assert.ok(!JSON.stringify(replay).includes('Second original question.'));
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
