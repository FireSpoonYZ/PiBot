import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpConnection } from '../../center-server/antigravity/vendor/acp/connection.ts';
import { ensureIsolatedProfile, resolveProfile, BRIDGE_ALLOW_RULE } from '../../center-server/antigravity/profile.ts';
import { ACP_RECALL_HOOK_NAME } from '../../center-server/antigravity/vendor/acp/recall-hook.ts';
import {
  createControlledAcpDriverHarness, openIsolatedAntigravity, closeAndRemove,
  drainEventStream, BASE_SYSTEM, MODEL_ID,
} from './helpers/antigravity-sync-harness.mjs';

const SESSION = 'resource-test';
const HOOK = fileURLToPath(new URL('../../center-server/antigravity/vendor/acp/recall-hook-client.cjs', import.meta.url));

const fakeAcp = String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const [hook, session] = process.argv.slice(2);
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const reply = (id, result) => send({ id, result });
const update = (payload) => send({ method: 'session/update', params: { sessionId: session, update: payload } });
const finish = (id, status) => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status });
let parkedPrompt;

function start(name, id, mcp) {
  update({ sessionUpdate: 'tool_call', toolCallId: id, name, status: 'in_progress', ...(mcp && { _meta: { mcp } }) });
}

function deny(name, id) {
  const child = spawnSync(process.execPath, [hook, '--deny-native-tools'], {
    input: JSON.stringify({ hookEventName: 'PreToolUse', conversationId: session, toolCall: { id, name } }),
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PI_AGY_RECALL_PORT: '', PI_AGY_RECALL_KEY: '' },
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /codemode/);
  assert.match(result.reason, /model-only/);
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, {});
  if (method === 'session/new') reply(id, { sessionId: session });
  if (method === 'session/cancel') {
    finish('waiting-tool', 'failed');
    reply(parkedPrompt, { stopReason: 'end_turn' });
  }
  if (method !== 'session/prompt') continue;

  const scenario = params.prompt.at(-1).text;
  if (scenario === 'business-denials') {
    for (const [index, name] of ['run_command', 'view_file', 'write_to_file', 'browser_navigate'].entries()) {
      const callId = 'denied-' + index;
      start(name, callId);
      deny(name, callId);
      finish(callId, 'failed');
    }
  } else if (scenario === 'cancel') {
    start('future_internal_progress', 'waiting-tool');
    parkedPrompt = id;
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'waiting for cancellation' } });
    continue;
  } else {
    start('list_resources', 'resource-discovery');
    finish('resource-discovery', 'completed');
    start('read_resource', 'resource-read');
    finish('resource-read', 'failed');
    start('future_internal_progress', 'unknown');
    start('future_internal_progress', 'unknown');
    finish('unknown', 'failed');
    finish('unknown', 'completed');
    start('foreign_tool', 'foreign', { server: 'foreign-server', tool: 'foreign_tool' });
    finish('foreign', 'completed');
    start('read_file', 'host-read', { server: 'pibot-bridge', tool: 'read_file' });
    finish('host-read', 'completed');
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply continued' } });
  reply(id, { stopReason: 'end_turn' });
}
`;

async function openTestConnection(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-acp-resource-'));
  const server = path.join(cwd, 'fake-acp.mjs');
  fs.writeFileSync(server, fakeAcp);
  const updates = [];
  const conn = new AcpConnection({
    cwd, bin: process.execPath, binArgs: [server, HOOK, SESSION],
    enableTurnRecall: false, enableToolImages: true,
    log() {}, onExit() {},
    onUpdate(id, update) {
      updates.push(update);
      if (update.content?.text === 'waiting for cancellation') conn.cancel(id);
    },
  });
  t.after(async () => {
    conn.kill();
    await conn.waitForExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  await conn.start();
  await conn.newSession(cwd);
  return { conn, updates };
}

test('Dedicated agent hides business builtins and keeps host MCP permissions intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agent-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = resolveProfile({ dataRoot: root, geminiHome: path.join(root, 'gemini') });
  fs.mkdirSync(path.dirname(profile.settingsPath), { recursive: true });
  fs.writeFileSync(profile.settingsPath, JSON.stringify({
    permissions: { allow: ['mcp(existing/*)'], deny: ['run_command'] },
    existingSetting: true,
  }));
  ensureIsolatedProfile(profile);

  const agent = fs.readFileSync(profile.agentPath, 'utf8');
  assert.match(agent, /^tools: \[\]$/m);
  assert.match(agent, /^excludeDefaultComponents: true$/m);
  assert.match(agent, /^inheritCustomizations: false$/m);
  assert.match(agent, /^inheritMcp: true$/m);
  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(profile.agentPath), 'recall-hooks.json'), 'utf8'))[ACP_RECALL_HOOK_NAME];
  assert.equal(hooks.PreInvocation.length, 1, 'image hook remains installed with automatic recall off');
  assert.equal(hooks.PreToolUse.length, 1);
  assert.match(hooks.PreToolUse[0].hooks[0].command, /--deny-native-tools$/);
  const matcher = new RegExp(hooks.PreToolUse[0].matcher);
  for (const name of ['view_file', 'write_to_file', 'run_command', 'search_web', 'invoke_subagent', 'browser_navigate']) {
    assert.equal(matcher.test(name), true, name);
  }
  for (const name of ['list_resources', 'read_resource', 'future_internal_progress', 'codemode', 'mcp_pibot-bridge_read_file']) {
    assert.equal(matcher.test(name), false, name);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(profile.settingsPath, 'utf8')), {
    permissions: { allow: ['mcp(existing/*)', BRIDGE_ALLOW_RULE], deny: ['run_command'] },
    existingSetting: true,
  });
});

test('Business tool denial is local to each call and generation continues without a receipt counter', { timeout: 15_000 }, async t => {
  const { conn, updates } = await openTestConnection(t);
  assert.equal((await conn.prompt(SESSION, 'business-denials')).stopReason, 'end_turn');
  assert.equal(updates.filter(update => update.sessionUpdate === 'tool_call').length, 4);
  assert.equal(updates.filter(update => update.sessionUpdate === 'tool_call_update' && update.status === 'failed').length, 4);
  assert.equal(updates.at(-1).content.text, 'reply continued');
  assert.equal(conn.alive, true);
});

test('Unknown and internal ACP tool progress does not abort the prompt or hide bridge events', { timeout: 10_000 }, async t => {
  const { conn, updates } = await openTestConnection(t);
  assert.equal((await conn.prompt(SESSION, 'internal-progress')).stopReason, 'end_turn');
  assert.deepEqual(updates.filter(frame => frame.sessionUpdate === 'tool_call').map(frame =>
    [frame.name, frame._meta?.mcp?.server]), [
    ['list_resources', undefined], ['read_resource', undefined],
    ['future_internal_progress', undefined], ['future_internal_progress', undefined],
    ['foreign_tool', 'foreign-server'], ['read_file', 'pibot-bridge'],
  ]);
  assert.equal(updates.at(-1).content.text, 'reply continued');
  assert.equal(conn.alive, true);
});

test('Cancelling internal progress leaves the next prompt usable without a denial receipt', { timeout: 10_000 }, async t => {
  const { conn } = await openTestConnection(t);
  assert.equal((await conn.prompt(SESSION, 'cancel')).stopReason, 'cancelled');
  assert.equal((await conn.prompt(SESSION, 'internal-progress')).stopReason, 'end_turn');
});

test('Center treats native internal and denied business activity as progress, not Host tool requests', { timeout: 10_000 }, async t => {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-native-progress-'));
  const antigravity = openIsolatedAntigravity(rootDir);
  t.after(() => closeAndRemove({ antigravity, rootDir }));
  driver.setOnRun(ctx => {
    for (const name of ['list_resources', 'future_internal_progress', 'run_command']) {
      ctx.emit({ type: 'tool_start', toolCallId: name, name, args: {} });
      ctx.emit({ type: 'tool_error', toolCallId: name, name, message: 'denied or unavailable' });
    }
    ctx.emit({ type: 'text', delta: 'Continued after local tool progress.' });
    ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: 'Continued.', finished: true, aborted: false });
  });
  const messages = [BASE_SYSTEM, { role: 'user', content: 'Continue normally.', timestamp: 10 }];
  const result = await drainEventStream(antigravity.stream({
    deviceId: 'progress', sessionId: 'progress', modelId: MODEL_ID, messages,
    turnContext: { inputIndex: 1, auxiliaryIndices: [] },
  }));
  assert.equal(result.terminal.reason, 'stop');
  assert.equal(result.terminal.message.content.some(part => part.type === 'toolCall'), false);
  assert.equal(driver.runs.length, 1);
});
