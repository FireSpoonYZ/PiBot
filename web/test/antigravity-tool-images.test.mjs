import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGY_HISTORY_CHANGED } from '../../center-contract/antigravity.js';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import { POLL_TOOL_NAME, RunToolWaiters } from '../../center-server/antigravity/tool-waiters.ts';
import { AcpDriver } from '../../center-server/antigravity/vendor/acp/driver.ts';
import {
  acpToolImageHookCommand,
  createToolImageHook,
  TOOL_IMAGE_HOOK_KEY_ENV,
  TOOL_IMAGE_HOOK_PORT_ENV,
} from '../../center-server/antigravity/vendor/acp/tool-image-hook.ts';
import {
  collectRunEvents,
  createControlledAcpDriverHarness,
  openAntigravity,
  waitUntil,
} from './helpers/antigravity-sync-harness.mjs';

const MODEL_ID = 'gemini-4-hydrogen';
const HOOK_CLIENT_PATH = fileURLToPath(
  new URL('../../center-server/antigravity/vendor/acp/tool-image-hook-client.cjs', import.meta.url),
);

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=';
const JPEG_TINY = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');
const GIF_TINY = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary').toString('base64');
const WEBP_TINY = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x04, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]).toString('base64');

function runHookClient(stdinJson, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK_CLIENT_PATH], {
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr,
      });
    });
    child.on('error', reject);
    child.stdin.end(stdinJson);
  });
}

function sendRawHookRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('createToolImageHook + tool-image-hook-client validates formats, HMAC, dedup, ACK, broken stdout, and turn isolation', { timeout: 15_000 }, async () => {
  const hook = await createToolImageHook();
  try {
    assert.equal(hook.listening, true);
    const port = Number(hook.env[TOOL_IMAGE_HOOK_PORT_ENV]);
    const keyHex = hook.env[TOOL_IMAGE_HOOK_KEY_ENV];
    assert.ok(port > 0);
    assert.match(keyHex, /^[a-f0-9]{64}$/);
    assert.ok(acpToolImageHookCommand().includes('tool-image-hook-client.cjs'));

    const binding1 = hook.bind('conv-img-1');

    // Validation failures: malformed base64, MIME mismatch, invalid callId
    assert.throws(
      () => binding1.queueToolResultImages('', [{ data: PNG_1X1, mimeType: 'image/png' }]),
      /valid tool call ID/,
    );
    assert.throws(
      () => binding1.queueToolResultImages('c-bad-b64', [{ data: 'not-base64!!!', mimeType: 'image/png' }]),
      /complete base64/,
    );
    assert.throws(
      () => binding1.queueToolResultImages('c-bad-mime', [{ data: PNG_1X1, mimeType: 'image/jpeg' }]),
      /MIME type does not match/,
    );

    // Valid PNG, JPEG (via image/jpg alias), GIF, WebP
    binding1.queueToolResultImages('call-multi', [
      { data: PNG_1X1, mimeType: 'image/png' },
      { data: JPEG_TINY, mimeType: 'image/jpg; charset=binary' },
      { data: GIF_TINY, mimeType: 'image/gif' },
      { data: WEBP_TINY, mimeType: 'image/webp' },
    ]);
    // Identical re-queue is deduplicated; modified bytes for same (callId, index) fail
    binding1.queueToolResultImages('call-multi', [
      { data: PNG_1X1, mimeType: 'image/png' },
    ]);
    assert.throws(
      () => binding1.queueToolResultImages('call-multi', [{ data: GIF_TINY, mimeType: 'image/gif' }]),
      /content changed/,
    );

    // Unconsumed images fail assertImagesDelivered()
    assert.throws(() => binding1.assertImagesDelivered(), /before consuming the tool image hook/);

    // Non-PreInvocation event, wrong conversationId, or wrong HMAC proof receives {} without draining pending images
    const wrongEvent = await runHookClient(
      JSON.stringify({ hookEventName: 'PostInvocation', conversationId: 'conv-img-1' }),
      hook.env,
    );
    assert.equal(wrongEvent.code, 0);
    assert.deepEqual(JSON.parse(wrongEvent.stdout), {});

    const wrongConv = await runHookClient(
      JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'other-conv' }),
      hook.env,
    );
    assert.equal(wrongConv.code, 0);
    assert.deepEqual(JSON.parse(wrongConv.stdout), {});

    const badProof = await sendRawHookRequest(port, {
      conversationId: 'conv-img-1',
      nonce: randomBytes(16).toString('hex'),
      proof: '0'.repeat(64),
    });
    assert.equal(badProof, '');

    // Legitimate hook client reads, verifies reply HMAC, writes stdout, and ACKs delivery
    const good = await runHookClient(
      JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'conv-img-1' }),
      hook.env,
    );
    assert.equal(good.code, 0);
    const parsed = JSON.parse(good.stdout);
    assert.equal(parsed.injectSteps.length, 4);
    assert.deepEqual(
      parsed.injectSteps.map((s) => s.systemMessage.media[0].mimeType),
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    );
    assert.equal(parsed.injectSteps[0].systemMessage.media[0].inlineData, PNG_1X1);
    assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /"toolCallId":"call-multi"/);
    assert.doesNotThrow(() => binding1.assertImagesDelivered());

    // Subsequent hook read with no new images returns empty JSON object cleanly
    const emptyRead = await runHookClient(
      JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'conv-img-1' }),
      hook.env,
    );
    assert.equal(emptyRead.code, 0);
    assert.deepEqual(JSON.parse(emptyRead.stdout), {});

    // Read without ACK keeps entry inFlight and fails assertImagesDelivered()
    binding1.queueToolResultImages('call-unacked', [{ data: PNG_1X1, mimeType: 'image/png' }]);
    const nonce = randomBytes(16).toString('hex');
    const readProof = createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update('read:')
      .update(nonce)
      .update('conv-img-1')
      .digest('hex');
    const rawReply = await sendRawHookRequest(port, { conversationId: 'conv-img-1', nonce, proof: readProof });
    assert.ok(rawReply.includes('\n{"injectSteps":'));
    assert.throws(() => binding1.assertImagesDelivered(), /before consuming the tool image hook/);

    // Broken stdout: hook client exits non-zero and never sends delivered ACK
    const binding2 = hook.bind('conv-img-2');
    binding2.queueToolResultImages('call-broken-stdout', [{ data: PNG_1X1, mimeType: 'image/png' }]);
    const brokenExitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK_CLIENT_PATH], {
        env: { ...process.env, ...hook.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', reject);
      child.stdout.destroy();
      child.stdin.end(JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'conv-img-2' }));
      child.once('close', (code) => resolve(code));
    });
    assert.notEqual(brokenExitCode, 0, 'broken stdout must exit non-zero');
    assert.throws(() => binding2.assertImagesDelivered(), /before consuming the tool image hook/);

    // Releasing an aborted turn clears pending images so they never leak into the next turn
    const binding3 = hook.bind('conv-img-3');
    binding3.queueToolResultImages('call-aborted', [{ data: PNG_1X1, mimeType: 'image/png' }]);
    binding3.release();
    const binding4 = hook.bind('conv-img-3');
    const leaked = await runHookClient(
      JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'conv-img-3' }),
      hook.env,
    );
    assert.equal(leaked.code, 0);
    assert.deepEqual(JSON.parse(leaked.stdout), {}, 'aborted turn images must never leak into the next turn');
    assert.doesNotThrow(() => binding4.assertImagesDelivered());
    binding4.release();
  } finally {
    hook.close();
  }
});

test('Real AcpDriver + AcpConnection + tool-image-hook-client delivers normal, escalated, and steered tool images and fails closed if unconsumed', { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-e2e-img-'));
  const script = path.join(root, 'fake-acp-img.mjs');
  const reportFile = path.join(root, 'report.json');

  fs.writeFileSync(script, String.raw`
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const [reportFile, hookClientPath] = process.argv.slice(2);
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
let mcpServer = null;
let sessionSeq = 0;
const report = { turns: [] };

async function callMcp(name, args) {
  const res = await fetch(mcpServer.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...Object.fromEntries((mcpServer.headers ?? []).map((h) => [h.name, h.value])),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (text.trimStart().startsWith('{')) return JSON.parse(text).result;
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
  return frames.at(-1)?.result;
}

function invokeHook(sessionId) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hookClientPath], { env: process.env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout ? JSON.parse(stdout) : null);
    });
    child.stdin.end(JSON.stringify({ hookEventName: 'PreInvocation', conversationId: sessionId }));
  });
}

let activeSteerPromise = null;
let resolveSteerSeen = null;

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    send({ id, result: { agentInfo: { name: 'fake-agy', version: '1.5.18' } } });
    continue;
  }
  if (method === 'session/new') {
    mcpServer = (params.mcpServers ?? [])[0] ?? null;
    send({ id, result: { sessionId: 'fake-conv-' + (++sessionSeq), configOptions: [] } });
    continue;
  }
  if (method === 'session/prompt') {
    const promptText = (params.prompt ?? []).map((p) => p.text ?? '').join('\n');
    if (promptText.startsWith('STEER:')) {
      resolveSteerSeen?.(promptText);
      send({
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[steered]' } } },
      });
      send({ id, result: { stopReason: 'end_turn' } });
      continue;
    }

    void (async () => {
      const turnRecord = { promptText, mcpResults: [], hookPayloads: [] };
      if (promptText === 'TURN_NORMAL_AND_STEER') {
        activeSteerPromise = new Promise((resolve) => { resolveSteerSeen = resolve; });
        const mcpRes = await callMcp('codemode', { step: 'normal' });
        turnRecord.mcpResults.push(mcpRes);
        await activeSteerPromise;
        turnRecord.hookPayloads.push(await invokeHook(params.sessionId));
      } else if (promptText === 'TURN_ESCALATED') {
        const ack = await callMcp('codemode', { step: 'slow' });
        turnRecord.mcpResults.push(ack);
        const m = ack.content[0].text.match(/callId="([^"]+)"/);
        const poll1 = await callMcp('bridge_poll_result', { callId: m[1] });
        turnRecord.mcpResults.push(poll1);
        turnRecord.hookPayloads.push(await invokeHook(params.sessionId));
        const poll2 = await callMcp('bridge_poll_result', { callId: m[1] });
        turnRecord.mcpResults.push(poll2);
        turnRecord.hookPayloads.push(await invokeHook(params.sessionId));
      } else if (promptText === 'TURN_SKIP_HOOK') {
        const mcpRes = await callMcp('codemode', { step: 'skip-hook' });
        turnRecord.mcpResults.push(mcpRes);
        // Deliberately do NOT invoke PreInvocation hook before end_turn
      }
      report.turns.push(turnRecord);
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      send({
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done:' + promptText } } },
      });
      send({ id, result: { stopReason: 'end_turn' } });
    })();
    continue;
  }
  if (id !== undefined) send({ id, result: {} });
}
`, 'utf8');

  const mcpBridge = new SharedMcpBridge();
  let activeWaiters = null;
  const reg = mcpBridge.registerSession({
    listTools: () => [{ name: 'codemode', description: 'Run', inputSchema: { type: 'object', properties: {} } }],
    onToolCall: (callId, name, args, signal) => activeWaiters.handleToolCall(callId, name, args, signal),
  });
  await mcpBridge.ensureStarted();

  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [script, reportFile, HOOK_CLIENT_PATH],
    enableToolImages: true,
    mcpServers: () => [mcpBridge.serverConfig(reg.token)],
  });

  try {
    // 1. Normal tool image + concurrent steer in the same turn
    let conversationId;
    {
      const toolReqSeen = Promise.withResolvers();
      activeWaiters = new RunToolWaiters({
        escalateAfterMs: 5_000,
        onToolRequest: (ev) => toolReqSeen.resolve(ev),
        deliverToolImages: (callId, images) => driver.queueToolResultImages(callId, images),
      });
      const handle = await driver.run({
        cwd: root,
        model: MODEL_ID,
        mode: 'default',
        prompt: 'TURN_NORMAL_AND_STEER',
      });
      const reqEv = await toolReqSeen.promise;
      activeWaiters.resolve(reqEv.callId, [
        { type: 'text', text: 'normal-shot' },
        { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
      ], false);
      await driver.steer('STEER:also check corner');
      for (;;) {
        if (!(await handle.next())) break;
      }
      const outcome = await handle.outcome;
      assert.equal(outcome.status, 'OK', outcome.error ?? 'expected Turn 1 OK');
      conversationId = outcome.conversationId;
    }

    // 2. Escalated slow tool (`bridge_poll_result`) returning image on hot reused session
    {
      const toolReqSeen = Promise.withResolvers();
      activeWaiters = new RunToolWaiters({
        escalateAfterMs: 40,
        onToolRequest: (ev) => toolReqSeen.resolve(ev),
        deliverToolImages: (callId, images) => driver.queueToolResultImages(callId, images),
      });
      const handle = await driver.run({
        cwd: root,
        model: MODEL_ID,
        mode: 'default',
        conversationId,
        prompt: 'TURN_ESCALATED',
      });
      const reqEv = await toolReqSeen.promise;
      await new Promise((resolve) => setTimeout(resolve, 90));
      activeWaiters.resolve(reqEv.callId, [
        { type: 'text', text: 'slow-shot' },
        { type: 'image', data: JPEG_TINY, mimeType: 'image/jpeg' },
      ], false);
      for (;;) {
        if (!(await handle.next())) break;
      }
      const outcome = await handle.outcome;
      assert.equal(outcome.status, 'OK', outcome.error ?? 'expected Turn 2 OK');
    }

    // 3. Fail-closed when fake ACP returns end_turn without consuming queued hook images
    {
      const toolReqSeen = Promise.withResolvers();
      activeWaiters = new RunToolWaiters({
        escalateAfterMs: 5_000,
        onToolRequest: (ev) => toolReqSeen.resolve(ev),
        deliverToolImages: (callId, images) => driver.queueToolResultImages(callId, images),
      });
      const handle = await driver.run({
        cwd: root,
        model: MODEL_ID,
        mode: 'default',
        conversationId,
        prompt: 'TURN_SKIP_HOOK',
      });
      const reqEv = await toolReqSeen.promise;
      activeWaiters.resolve(reqEv.callId, [
        { type: 'text', text: 'unconsumed-shot' },
        { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
      ], false);
      for (;;) {
        if (!(await handle.next())) break;
      }
      const outcome = await handle.outcome;
      assert.equal(outcome.status, 'ERROR', 'unconsumed tool images must fail closed');
      assert.match(outcome.error ?? '', /before consuming the tool image hook/);
    }

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(report.turns.length, 3);

    // Turn 1: MCP got text-only block; PreInvocation hook delivered PNG media
    assert.equal(report.turns[0].mcpResults[0].content.every((b) => b.type === 'text'), true);
    assert.match(report.turns[0].mcpResults[0].content[0].text, /Visual attachments for Pi host tool result/);
    assert.equal(report.turns[0].hookPayloads[0].injectSteps[0].systemMessage.media[0].mimeType, 'image/png');
    assert.equal(report.turns[0].hookPayloads[0].injectSteps[0].systemMessage.media[0].inlineData, PNG_1X1);

    // Turn 2: escalated poll delivered JPEG once via hook; repeat poll returned cached text and null hook
    assert.match(report.turns[1].mcpResults[0].content[0].text, /STILL RUNNING/);
    assert.equal(report.turns[1].mcpResults[1].content.every((b) => b.type === 'text'), true);
    assert.equal(report.turns[1].hookPayloads[0].injectSteps[0].systemMessage.media[0].mimeType, 'image/jpeg');
    assert.equal(report.turns[1].hookPayloads[0].injectSteps[0].systemMessage.media[0].inlineData, JPEG_TINY);
    assert.deepEqual(report.turns[1].hookPayloads[1], {}, 'repeat bridge_poll_result must not re-queue image');
  } finally {
    reg.unregister();
    await driver.close('shutdown');
    await mcpBridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openAntigravity persists toolImageHook: true on new sessions and fails pre-fix sessions with AGY_HISTORY_CHANGED only when a tool returns an image', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-session-hook-'));
  const geminiHome = path.join(root, 'antigravity', 'gemini');
  const sessionsPath = path.join(root, 'antigravity', 'sessions.json');

  // Pre-seed a pre-fix session (created before toolImageHook existed) in sessions.json.
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  const legacyKey = JSON.stringify(['dev-img', 'sess-legacy']);
  fs.writeFileSync(sessionsPath, JSON.stringify({
    [legacyKey]: { conversationId: 'conv-legacy-1', agentName: 'pibot-s-legacy12345678901234' },
  }, null, 2));

  let mcpToolResult = null;
  const harness = createControlledAcpDriverHarness(async (ctx) => {
    const promptText = ctx.req.prompt ?? '';
    if (promptText.includes('CALL_TOOL')) {
      const mcpUrl = ctx.mcp.bridge.serverConfig(ctx.mcp.token).url;
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-bridge-token': ctx.mcp.token,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'codemode', arguments: { action: promptText } },
        }),
      });
      const body = await res.text();
      mcpToolResult = body.trimStart().startsWith('{')
        ? JSON.parse(body).result
        : body.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim())).at(-1)?.result;
    }
    ctx.emit({ type: 'text', delta: 'ok' });
    ctx.finish();
  });

  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome,
  });

  try {
    // 1. New session persists toolImageHook: true and delivers tool images via driver hook (text-only MCP).
    {
      const stream = service.run({
        deviceId: 'dev-img',
        sessionId: 'sess-new',
        runId: 'run-new-1',
        modelId: MODEL_ID,
        tools: [{ name: 'codemode', parameters: { type: 'object', properties: {} } }],
        inputs: [{ text: 'CALL_TOOL new-image' }],
      });
      const iter = stream[Symbol.asyncIterator]();
      const first = await iter.next();
      assert.equal(first.value?.type, 'tool_request');

      await service.submitToolResult({
        deviceId: 'dev-img',
        sessionId: 'sess-new',
        runId: 'run-new-1',
        callId: first.value.callId,
        content: [
          { type: 'text', text: 'captured screen' },
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
        ],
        isError: false,
      });

      const rest = [];
      for (;;) {
        const step = await iter.next();
        if (step.done) break;
        rest.push(step.value);
      }
      assert.equal(rest.at(-1)?.type, 'turn_done');
      assert.equal(mcpToolResult.isError, false);
      assert.equal(mcpToolResult.content.every((b) => b.type === 'text'), true);
      assert.equal(harness.toolImages.length, 1);
      assert.equal(harness.toolImages[0].images[0].data, PNG_1X1);

      const persisted = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.equal(persisted[JSON.stringify(['dev-img', 'sess-new'])].toolImageHook, true);
    }

    // 2. Pre-fix legacy session still succeeds for text-only tool calls.
    {
      const stream = service.run({
        deviceId: 'dev-img',
        sessionId: 'sess-legacy',
        runId: 'run-legacy-text',
        modelId: MODEL_ID,
        tools: [{ name: 'codemode', parameters: { type: 'object', properties: {} } }],
        inputs: [{ text: 'CALL_TOOL legacy-text' }],
      });
      const iter = stream[Symbol.asyncIterator]();
      const first = await iter.next();
      assert.equal(first.value?.type, 'tool_request');
      await service.submitToolResult({
        deviceId: 'dev-img',
        sessionId: 'sess-legacy',
        runId: 'run-legacy-text',
        callId: first.value.callId,
        content: [{ type: 'text', text: 'plain text ok' }],
        isError: false,
      });
      const rest = [];
      for (;;) {
        const step = await iter.next();
        if (step.done) break;
        rest.push(step.value);
      }
      assert.equal(rest.at(-1)?.type, 'turn_done');
    }

    // 3. Pre-fix legacy session fails cleanly with AGY_HISTORY_CHANGED when a tool returns an image.
    {
      const stream = service.run({
        deviceId: 'dev-img',
        sessionId: 'sess-legacy',
        runId: 'run-legacy-image',
        modelId: MODEL_ID,
        tools: [{ name: 'codemode', parameters: { type: 'object', properties: {} } }],
        inputs: [{ text: 'CALL_TOOL legacy-image' }],
      });
      const iter = stream[Symbol.asyncIterator]();
      const first = await iter.next();
      assert.equal(first.value?.type, 'tool_request');
      await service.submitToolResult({
        deviceId: 'dev-img',
        sessionId: 'sess-legacy',
        runId: 'run-legacy-image',
        callId: first.value.callId,
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
        ],
        isError: false,
      });
      const rest = [];
      for (;;) {
        const step = await iter.next();
        if (step.done) break;
        rest.push(step.value);
      }
      const terminal = rest.at(-1);
      assert.equal(terminal?.type, 'error');
      assert.equal(terminal?.code, AGY_HISTORY_CHANGED);
      assert.match(terminal?.message ?? '', /\/clear/);
    }
  } finally {
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
