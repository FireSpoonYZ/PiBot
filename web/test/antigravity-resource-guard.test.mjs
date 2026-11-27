import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AGENT_SYSTEM_FILE,
  AGENT_TOOL_IMAGE_HOOKS_FILE,
  BRIDGE_ALLOW_RULE,
  ensureIsolatedProfile,
  ensureSessionAgent,
  resolveProfile,
  sessionAgentName,
} from '../../center-server/antigravity/profile.ts';
import { AcpConnection, buildAcpChildEnv } from '../../center-server/antigravity/vendor/acp/connection.ts';
import { AcpDriver } from '../../center-server/antigravity/vendor/acp/driver.ts';
import { ACP_TOOL_IMAGE_HOOK_NAME } from '../../center-server/antigravity/vendor/acp/tool-image-hook.ts';
import {
  collectRunEvents,
  createControlledAcpDriverHarness,
  openAntigravity,
} from './helpers/antigravity-sync-harness.mjs';

const MODEL_ID = 'gemini-4-neon';

test('profile writes PreInvocation tool-image hook, preserves settings + BRIDGE_ALLOW_RULE, and keeps initial SOUL on cold recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-profile-'));
  try {
    const profile = resolveProfile({ dataRoot: root, geminiHome: path.join(root, 'gemini') });
    fs.mkdirSync(path.dirname(profile.settingsPath), { recursive: true });
    fs.writeFileSync(profile.settingsPath, JSON.stringify({
      permissions: { allow: ['mcp(existing/*)'], deny: ['run_command'] },
      existingSetting: true,
    }));

    ensureIsolatedProfile(profile);

    const defaultAgent = fs.readFileSync(profile.agentPath, 'utf8');
    assert.match(defaultAgent, /^excludeDefaultComponents: true$/m);
    assert.match(defaultAgent, /^inheritCustomizations: false$/m);
    assert.match(defaultAgent, /^inheritMcp: true$/m);
    assert.match(defaultAgent, /^tools: \[\]$/m);
    assert.match(defaultAgent, /^hooks:\n  - "\.\/tool-image-hooks\.json"$/m);
    assert.equal(fs.existsSync(path.join(path.dirname(profile.agentPath), 'recall-hooks.json')), false);

    const defaultHooks = JSON.parse(
      fs.readFileSync(path.join(path.dirname(profile.agentPath), AGENT_TOOL_IMAGE_HOOKS_FILE), 'utf8'),
    );
    assert.deepEqual(Object.keys(defaultHooks), [ACP_TOOL_IMAGE_HOOK_NAME]);
    assert.deepEqual(Object.keys(defaultHooks[ACP_TOOL_IMAGE_HOOK_NAME]), ['PreInvocation']);
    assert.equal(defaultHooks[ACP_TOOL_IMAGE_HOOK_NAME].PreInvocation.length, 1);
    assert.match(defaultHooks[ACP_TOOL_IMAGE_HOOK_NAME].PreInvocation[0].command, /tool-image-hook-client\.cjs/);

    assert.deepEqual(JSON.parse(fs.readFileSync(profile.settingsPath, 'utf8')), {
      permissions: { allow: ['mcp(existing/*)', BRIDGE_ALLOW_RULE], deny: ['run_command'] },
      existingSetting: true,
    });

    const agentName = sessionAgentName('["dev-1","sess-1"]');
    assert.match(agentName, /^pibot-s-[0-9a-f]{24}$/);
    const writtenName = ensureSessionAgent(profile, {
      agentName,
      initialSystemPrompt: 'INITIAL_SESSION_SOUL_DO_NOT_OVERWRITE',
    });
    assert.equal(writtenName, agentName);

    const sessionAgentDir = path.join(profile.geminiHome, 'config', 'agents', agentName);
    const sessionAgentPath = path.join(sessionAgentDir, AGENT_SYSTEM_FILE);
    const sessionHooksPath = path.join(sessionAgentDir, AGENT_TOOL_IMAGE_HOOKS_FILE);
    const initialContent = fs.readFileSync(sessionAgentPath, 'utf8');
    assert.match(initialContent, new RegExp(`^name: ${agentName}$`, 'm'));
    assert.match(initialContent, /^excludeDefaultComponents: true$/m);
    assert.match(initialContent, /^tools: \[\]$/m);
    assert.match(initialContent, /^hooks:\n  - "\.\/tool-image-hooks\.json"$/m);
    assert.equal(fs.existsSync(path.join(sessionAgentDir, 'recall-hooks.json')), false);
    assert.equal(fs.existsSync(sessionHooksPath), true);
    assert.ok(initialContent.includes('INITIAL_SESSION_SOUL_DO_NOT_OVERWRITE'));

    // Cold recovery calls ensureSessionAgent without initialSystemPrompt: existing agent.md must be preserved
    // and existing tool-image-hooks.json is refreshed if stale.
    fs.writeFileSync(sessionHooksPath, '{"stale":true}\n', 'utf8');
    ensureSessionAgent(profile, { agentName });
    assert.equal(fs.readFileSync(sessionAgentPath, 'utf8'), initialContent);
    const refreshedHooks = JSON.parse(fs.readFileSync(sessionHooksPath, 'utf8'));
    assert.deepEqual(Object.keys(refreshedHooks), [ACP_TOOL_IMAGE_HOOK_NAME]);

    // Pre-fix legacy agent dir without tool-image-hooks.json keeps its existing agent.md untouched.
    const legacyName = sessionAgentName('["dev-1","sess-legacy"]');
    const legacyDir = path.join(profile.geminiHome, 'config', 'agents', legacyName);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, AGENT_SYSTEM_FILE);
    fs.writeFileSync(legacyPath, '---\nname: legacy\ntools: []\n---\nLEGACY\n', 'utf8');
    ensureSessionAgent(profile, { agentName: legacyName });
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), '---\nname: legacy\ntools: []\n---\nLEGACY\n');
    assert.equal(fs.existsSync(path.join(legacyDir, AGENT_TOOL_IMAGE_HOOKS_FILE)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AcpConnection auto-approves all session/request_permission requests and strips ANTIGRAVITY_* and hook child env', { timeout: 15_000 }, async (t) => {
  const prevUpper = process.env.ANTIGRAVITY_TEST_SECRET;
  const prevLower = process.env.antigravity_nested_flag;
  const prevRecall = process.env.PI_AGY_RECALL_PORT;
  const prevImgHookPort = process.env.PI_AGY_IMAGE_HOOK_PORT;
  const prevImgHookKey = process.env.PI_AGY_IMAGE_HOOK_KEY;
  const prevKeep = process.env.PIBOT_ENV_KEEP_CHECK;
  process.env.ANTIGRAVITY_TEST_SECRET = 'must-not-leak';
  process.env.antigravity_nested_flag = '1';
  process.env.PI_AGY_RECALL_PORT = '9999';
  process.env.PI_AGY_IMAGE_HOOK_PORT = '9998';
  process.env.PI_AGY_IMAGE_HOOK_KEY = 'stale-key';
  process.env.PIBOT_ENV_KEEP_CHECK = 'visible';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-acp-perm-env-'));
  const script = path.join(root, 'fake-acp-perm.mjs');
  const reportFile = path.join(root, 'report.json');

  fs.writeFileSync(script, String.raw`
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const reportFile = process.argv[2];
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const pendingReplies = new Map();
let nextReqId = 1000;

function askClient(method, params) {
  const id = nextReqId++;
  return new Promise((resolve) => {
    pendingReplies.set(id, resolve);
    send({ id, method, params });
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id !== undefined) {
    const resolver = pendingReplies.get(msg.id);
    if (resolver) {
      pendingReplies.delete(msg.id);
      resolver(msg);
    }
    continue;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ id, result: { agentInfo: { name: 'fake-agy', version: '1.5.12' } } });
    continue;
  }
  if (method === 'session/new') {
    send({ id, result: { sessionId: 'perm-session', configOptions: [] } });
    continue;
  }
  if (method === 'session/prompt') {
    void (async () => {
      const nonBridge = await askClient('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'nat-1', name: 'manage_task', kind: 'execute' },
        options: [
          { optionId: 'reject-once', kind: 'reject_once' },
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'allow-always', kind: 'allow_always' },
        ],
      });
      const bridge = await askClient('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'mcp-1',
          name: 'mcp_pibot-bridge_codemode',
          _meta: { mcp: { server: 'pibot-bridge', tool: 'codemode' } },
        },
        options: [{ optionId: 'allow-always', kind: 'allow_always' }],
      });
      const fallbackFirst = await askClient('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'nat-2', name: 'read_resource' },
        options: [{ optionId: 'custom-first', kind: 'other' }],
      });
      const emptyOpts = await askClient('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'nat-3', name: 'empty_opts' },
        options: [],
      });
      const unsupportedFs = await askClient('fs/read_text_file', { path: '/etc/passwd' });

      const leakedAgyKeys = Object.keys(process.env).filter((k) => /^(?:ANTIGRAVITY_|PI_AGY_RECALL_|PI_AGY_IMAGE_HOOK_)/i.test(k));
      fs.writeFileSync(reportFile, JSON.stringify({
        nonBridge,
        bridge,
        fallbackFirst,
        emptyOpts,
        unsupportedFs,
        leakedAgyKeys,
        keepCheck: process.env.PIBOT_ENV_KEEP_CHECK ?? null,
        extraCheck: process.env.EXTRA_TEST_FLAG ?? null,
      }));
      send({
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'approved' } } },
      });
      send({ id, result: { stopReason: 'end_turn' } });
    })();
    continue;
  }
  if (id !== undefined) send({ id, result: {} });
}
`, 'utf8');

  let conn;
  try {
    const built = buildAcpChildEnv({ EXTRA_TEST_FLAG: 'yes' });
    assert.equal(Object.keys(built).some((k) => /^(?:ANTIGRAVITY_|PI_AGY_RECALL_|PI_AGY_IMAGE_HOOK_)/i.test(k)), false);
    assert.equal(built.PIBOT_ENV_KEEP_CHECK, 'visible');
    assert.equal(built.EXTRA_TEST_FLAG, 'yes');

    conn = new AcpConnection({
      cwd: root,
      bin: process.execPath,
      binArgs: [script, reportFile],
      extraEnv: { EXTRA_TEST_FLAG: 'yes' },
      log() {},
      onUpdate() {},
      onExit() {},
    });
    await conn.start();
    const { sessionId } = await conn.newSession(root);
    const promptRes = await conn.prompt(sessionId, 'check permissions');
    assert.equal(promptRes.stopReason, 'end_turn');

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.deepEqual(report.nonBridge.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    assert.deepEqual(report.bridge.result, { outcome: { outcome: 'selected', optionId: 'allow-always' } });
    assert.deepEqual(report.fallbackFirst.result, { outcome: { outcome: 'selected', optionId: 'custom-first' } });
    assert.deepEqual(report.emptyOpts.result, { outcome: { outcome: 'cancelled' } });
    assert.ok(report.unsupportedFs.error, 'unsupported fs/* server requests must still be rejected');
    assert.deepEqual(report.leakedAgyKeys, []);
    assert.equal(report.keepCheck, 'visible');
    assert.equal(report.extraCheck, 'yes');
  } finally {
    if (prevUpper === undefined) delete process.env.ANTIGRAVITY_TEST_SECRET;
    else process.env.ANTIGRAVITY_TEST_SECRET = prevUpper;
    if (prevLower === undefined) delete process.env.antigravity_nested_flag;
    else process.env.antigravity_nested_flag = prevLower;
    if (prevRecall === undefined) delete process.env.PI_AGY_RECALL_PORT;
    else process.env.PI_AGY_RECALL_PORT = prevRecall;
    if (prevImgHookPort === undefined) delete process.env.PI_AGY_IMAGE_HOOK_PORT;
    else process.env.PI_AGY_IMAGE_HOOK_PORT = prevImgHookPort;
    if (prevImgHookKey === undefined) delete process.env.PI_AGY_IMAGE_HOOK_KEY;
    else process.env.PI_AGY_IMAGE_HOOK_KEY = prevImgHookKey;
    if (prevKeep === undefined) delete process.env.PIBOT_ENV_KEEP_CHECK;
    else process.env.PIBOT_ENV_KEEP_CHECK = prevKeep;
    conn?.kill();
    await conn?.waitForExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cold start uses session/resume (not session/load) with zero history replay and re-applies model + thought_level', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-acp-resume-'));
  const script = path.join(root, 'fake-acp-resume.mjs');
  const logFile = path.join(root, 'rpc.jsonl');

  fs.writeFileSync(script, String.raw`
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const logFile = process.argv[2];
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const configOptions = [
  { id: 'model', currentValue: 'default-model', options: [{ value: 'default-model' }, { value: 'gemini-4-neon' }] },
  { id: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
];

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(logFile, JSON.stringify({ method, params }) + '\n');
  if (method === 'initialize') {
    send({ id, result: { agentInfo: { name: 'fake-agy', version: '1.5.12' } } });
  } else if (method === 'session/resume') {
    send({ id, result: { configOptions } });
  } else if (method === 'session/set_config_option') {
    send({ id, result: { configOptions } });
  } else if (method === 'session/prompt') {
    send({
      method: 'session/update',
      params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed-reply' } } },
    });
    send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } } });
  } else if (id !== undefined) {
    send({ id, result: {} });
  }
}
`, 'utf8');

  const driver = new AcpDriver({ bin: process.execPath, binArgs: [script, logFile] });
  try {
    const handle = await driver.run({
      cwd: root,
      model: MODEL_ID,
      effort: 'high',
      mode: 'default',
      conversationId: 'existing-native-conv',
      prompt: 'fresh message after cold restart',
    });
    const textDeltas = [];
    for (;;) {
      const activity = await handle.next();
      if (!activity) break;
      if (activity.type === 'text') textDeltas.push(activity.delta);
    }
    const outcome = await handle.outcome;
    assert.equal(outcome.status, 'OK');
    assert.equal(outcome.conversationId, 'existing-native-conv');
    assert.equal(textDeltas.join(''), 'resumed-reply');

    const frames = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(frames.some((f) => f.method === 'session/load'), false, 'cold start must not call session/load');
    assert.equal(frames.some((f) => f.method === 'session/new'), false, 'cold start must not call session/new');
    const resumeIdx = frames.findIndex((f) => f.method === 'session/resume');
    const modelIdx = frames.findIndex((f) => f.method === 'session/set_config_option' && f.params.configId === 'model');
    const thoughtIdx = frames.findIndex((f) => f.method === 'session/set_config_option' && f.params.configId === 'thought_level');
    const promptIdx = frames.findIndex((f) => f.method === 'session/prompt');

    assert.ok(resumeIdx >= 0, 'session/resume must be invoked');
    assert.equal(frames[resumeIdx].params.sessionId, 'existing-native-conv');
    assert.ok(modelIdx > resumeIdx && modelIdx < promptIdx);
    assert.equal(frames[modelIdx].params.value, MODEL_ID);
    assert.ok(thoughtIdx > modelIdx && thoughtIdx < promptIdx);
    assert.equal(frames[thoughtIdx].params.value, 'high');
    assert.deepEqual(frames[promptIdx].params.prompt, [{ type: 'text', text: 'fresh message after cold restart' }]);
  } finally {
    await driver.close('shutdown');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openAntigravity emits native_tool_start/end for non-bridge native tools and suppresses duplicate pibot-bridge notifications', { timeout: 10_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-native-tools-'));
  const harness = createControlledAcpDriverHarness((ctx) => {
    ctx.emit({ type: 'tool_start', toolCallId: 'nat-1', name: 'manage_task', args: { action: 'list' } });
    ctx.emit({ type: 'tool_done', toolCallId: 'nat-1', name: 'manage_task', args: { action: 'list' }, output: 'tasks ok' });
    ctx.emit({ type: 'tool_start', toolCallId: 'nat-2', name: 'read_resource', args: { uri: 'res://doc' } });
    ctx.emit({ type: 'tool_error', toolCallId: 'nat-2', name: 'read_resource', message: 'not found' });
    ctx.emit({ type: 'tool_start', toolCallId: 'mcp-1', name: 'codemode', args: { code: '1+1' }, mcpServer: 'pibot-bridge' });
    ctx.emit({ type: 'tool_done', toolCallId: 'mcp-1', name: 'codemode', args: { code: '1+1' }, output: '2', mcpServer: 'pibot-bridge' });
    ctx.emit({ type: 'tool_start', toolCallId: 'mcp-2', name: 'read', args: { path: 'a.txt' }, mcpServer: 'pi-bridge-1' });
    ctx.emit({ type: 'tool_error', toolCallId: 'mcp-2', name: 'read', message: 'enoent', mcpServer: 'pi-bridge-1' });
    ctx.emit({ type: 'text', delta: 'Completed.' });
    ctx.finish();
  });
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    const events = await collectRunEvents(service.run({
      deviceId: 'dev-nat',
      sessionId: 'sess-nat',
      runId: 'run-nat-1',
      modelId: MODEL_ID,
      tools: [{ name: 'codemode', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'run native tools' }],
    }));

    assert.equal(events.some((ev) => ev.type === 'tool_request'), false, 'ACP native tool notifications must not trigger tool_request');
    const nativeEvents = events.filter((ev) => ev.type === 'native_tool_start' || ev.type === 'native_tool_end');
    assert.deepEqual(nativeEvents, [
      { type: 'native_tool_start', toolCallId: 'nat-1', name: 'manage_task', args: { action: 'list' } },
      { type: 'native_tool_end', toolCallId: 'nat-1', name: 'manage_task', output: 'tasks ok', isError: false },
      { type: 'native_tool_start', toolCallId: 'nat-2', name: 'read_resource', args: { uri: 'res://doc' } },
      { type: 'native_tool_end', toolCallId: 'nat-2', name: 'read_resource', output: 'not found', isError: true },
    ]);
    assert.equal(events.at(-1)?.type, 'turn_done');
  } finally {
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
