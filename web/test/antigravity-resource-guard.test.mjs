import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpConnection } from '../../center-server/antigravity/vendor/acp/connection.ts';

const SESSION = 'resource-test';
const NATIVE_TOOL = 'list_resources';
const HOOK = fileURLToPath(new URL('../../center-server/antigravity/vendor/acp/recall-hook-client.cjs', import.meta.url));
const rejected = /did not confirm that native list_resources was blocked/;

const fakeAcp = String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const [hook, session, nativeTool] = process.argv.slice(2);
const callId = 'resource-call';
const encode = (frame) => JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n';
const send = (frame) => process.stdout.write(encode(frame));
const reply = (id, result) => send({ id, result });
const update = (payload) => send({ method: 'session/update', params: { sessionId: session, update: payload } });
const finish = (status, id = callId) => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status });
let parkedPrompt;

function start(name = nativeTool, id = callId, mcp) {
  update({ sessionUpdate: 'tool_call', toolCallId: id, name, status: 'in_progress', ...(mcp && { _meta: { mcp } }) });
}

function invokeHook(event, mode, env = process.env) {
  const child = spawnSync(process.execPath, [hook, ...mode], { input: JSON.stringify(event), encoding: 'utf8', env, timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function deny(id = callId, sessionId = session, env) {
  const event = { hookEventName: 'PreToolUse', conversationId: sessionId, toolCall: { id, name: nativeTool } };
  assert.equal(invokeHook(event, ['--deny-list-resources'], env).decision, 'deny');
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, {});
  if (method === 'session/new') reply(id, { sessionId: session });
  if (method === 'session/cancel') {
    finish('failed');
    reply(parkedPrompt, { stopReason: 'end_turn' });
  }
  if (method !== 'session/prompt') continue;

  const scenario = params.prompt.at(-1).text;
  if (scenario === 'foreign') {
    start(nativeTool, callId, { server: 'foreign-server', tool: nativeTool });
    start('read_resource', 'native-read');
    start('read_file', 'host-read', { server: 'pibot-bridge', tool: 'read_file' });
  } else {
    start();
    if (scenario === 'confirmed') {
      const recall = invokeHook({ conversationId: session }, []);
      assert.match(recall.injectSteps[0].ephemeralMessage, /round-only memory/);
      start(); // An in-progress duplicate with the same ID is idempotent.
      start(nativeTool, 'parallel');
      deny('parallel');
      deny();
      finish('failed', 'parallel');
      finish('failed');
      finish('failed');
    } else if (scenario === 'cancel') {
      deny();
      parkedPrompt = id;
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'waiting for cancellation' } });
      continue;
    } else if (scenario === 'completed') {
      deny();
      finish('completed');
    } else if (scenario === 'contradictory update with reply') {
      deny();
      finish('failed');
      process.stdout.write(encode({ id, result: { stopReason: 'end_turn' } }) + encode({
        method: 'session/update', params: { sessionId: session, update: {
          sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed',
        } },
      }));
      continue;
    } else if (scenario === 'missing completion') {
      deny();
    } else {
      if (scenario === 'wrong ID') deny('different-call');
      if (scenario === 'wrong session') deny(callId, 'different-session');
      if (scenario === 'bad signature') deny(callId, session, { ...process.env, PI_AGY_RECALL_KEY: '0'.repeat(64) });
      finish('failed');
    }
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
    cwd, bin: process.execPath, binArgs: [server, HOOK, SESSION, NATIVE_TOOL], enableTurnRecall: true,
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

test('Only authenticated, matched native discovery denials allow ACP generation to continue', { timeout: 20_000 }, async (t) => {
  await t.test('confirmed parallel denials and ordinary recall', async (subtest) => {
    const { conn, updates } = await openTestConnection(subtest);
    assert.equal((await conn.prompt(SESSION, 'confirmed', [], undefined, 'round-only memory')).stopReason, 'end_turn');
    assert.deepEqual(updates.map((update) => update.content?.text), ['reply continued']);
  });

  for (const scenario of ['completed', 'contradictory update with reply', 'missing completion', 'no receipt', 'wrong ID', 'wrong session', 'bad signature']) {
    await t.test(scenario, async (subtest) => {
      const { conn } = await openTestConnection(subtest);
      await assert.rejects(conn.prompt(SESSION, scenario), rejected);
      assert.equal(conn.alive, false);
    });
  }

  await t.test('cancel clears the receipt before the next prompt', async (subtest) => {
    const { conn } = await openTestConnection(subtest);
    assert.equal((await conn.prompt(SESSION, 'cancel')).stopReason, 'cancelled');
    await assert.rejects(conn.prompt(SESSION, 'no receipt'), rejected);
  });

  await t.test('other tools still reach the Center tool policy', async (subtest) => {
    const { conn, updates } = await openTestConnection(subtest);
    assert.equal((await conn.prompt(SESSION, 'foreign')).stopReason, 'end_turn');
    assert.deepEqual(updates.filter((frame) => frame.sessionUpdate === 'tool_call').map((frame) =>
      [frame.name, frame._meta?.mcp?.server]), [
      [NATIVE_TOOL, 'foreign-server'], ['read_resource', undefined], ['read_file', 'pibot-bridge'],
    ]);
  });
});
