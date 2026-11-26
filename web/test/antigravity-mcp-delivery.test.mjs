import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import { POLL_TOOL_NAME, RunToolWaiters } from '../../center-server/antigravity/tool-waiters.ts';
import {
  collectRunEvents,
  createControlledAcpDriverHarness,
  openAntigravity,
  waitUntil,
} from './helpers/antigravity-sync-harness.mjs';

const requireCenter = createRequire(new URL('../../center-server/package.json', import.meta.url));
const transportEntry = requireCenter.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js');
const transportEsmEntry = path.resolve(path.dirname(transportEntry), '../../esm/server/streamableHttp.js');
const { StreamableHTTPServerTransport } = await import(pathToFileURL(transportEsmEntry).href);

const MODEL_ID = 'gemini-4-hydrogen';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=';

const mcpHeaders = (token, extra = {}) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-bridge-token': token,
  ...extra,
});

function readRpcResponse(body, id = 1) {
  if (body.trimStart().startsWith('{')) return JSON.parse(body);
  const frames = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()));
  return frames.find((frame) => frame.id === id) ?? frames.at(-1);
}

test('SharedMcpBridge handles split UTF-8, /.well-known/ 404, non-POST 405, protocol downgrade 2026-07-28, and token isolation', { timeout: 15_000 }, async (t) => {
  const bridge = new SharedMcpBridge();
  const observedCalls = [];
  const regA = bridge.registerSession({
    listTools: () => [{ name: 'write_file', description: 'Write', inputSchema: { type: 'object', properties: {} } }],
    async onToolCall(_callId, name, args) {
      observedCalls.push({ owner: 'A', name, args });
      return { content: [{ type: 'text', text: `A:${args.content ?? 'ok'}` }] };
    },
  });
  const regB = bridge.registerSession({
    listTools: () => [],
    async onToolCall(_callId, name, args) {
      observedCalls.push({ owner: 'B', name, args });
      return { content: [{ type: 'text', text: 'B:ok' }] };
    },
  });

  try {
    await bridge.ensureStarted();
    const mcpUrl = bridge.serverConfig(regA.token).url;
    const baseUrl = new URL(mcpUrl).origin;

    // 1. /.well-known/ returns 404 for GET and POST
    assert.equal((await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, { signal: t.signal })).status, 404);
    assert.equal((await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { method: 'POST', signal: t.signal })).status, 404);

    // 2. Non-POST methods return 405
    assert.equal((await fetch(mcpUrl, { method: 'GET', headers: { 'x-bridge-token': regA.token }, signal: t.signal })).status, 405);
    assert.equal((await fetch(mcpUrl, { method: 'DELETE', headers: { 'x-bridge-token': regA.token }, signal: t.signal })).status, 405);

    // 3. Cross-chunk UTF-8 tool arguments decode without corruption
    const utf8Text = '中文😀END';
    const bytes = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { content: utf8Text } },
    }));
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    const chunked = Promise.withResolvers();
    const req = http.request(mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(regA.token),
      signal: t.signal,
    }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.once('error', chunked.reject);
      res.once('end', () => chunked.resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.once('error', chunked.reject);
    req.setNoDelay?.(true);
    req.write(bytes.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 15));
    req.end(bytes.subarray(split));
    const chunkedRes = await chunked.promise;
    assert.equal(chunkedRes.status, 200);
    assert.equal(readRpcResponse(chunkedRes.body).result.content[0].text, `A:${utf8Text}`);

    // 4. mcp-protocol-version: 2026-07-28 downgrade works for both tools/list and tools/call
    const listRes = await fetch(mcpUrl, {
      method: 'POST',
      signal: t.signal,
      headers: mcpHeaders(regA.token, { 'mcp-protocol-version': '2026-07-28' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(listRes.status, 200);
    assert.equal(readRpcResponse(await listRes.text(), 2).result.tools[0].name, 'write_file');

    const callRes = await fetch(mcpUrl, {
      method: 'POST',
      signal: t.signal,
      headers: mcpHeaders(regA.token, { 'mcp-protocol-version': '2026-07-28' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_file', arguments: { content: 'v2026' } } }),
    });
    assert.equal(callRes.status, 200);
    assert.equal(readRpcResponse(await callRes.text(), 3).result.content[0].text, 'A:v2026');

    // 5. Token isolation and 403 after unregister
    const badRes = await fetch(mcpUrl, {
      method: 'POST',
      signal: t.signal,
      headers: mcpHeaders('wrong-token'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.equal(badRes.status, 403);

    regA.unregister();
    const retiredRes = await fetch(mcpUrl, {
      method: 'POST',
      signal: t.signal,
      headers: mcpHeaders(regA.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_file', arguments: {} } }),
    });
    assert.equal(retiredRes.status, 403);

    const bRes = await fetch(mcpUrl, {
      method: 'POST',
      signal: t.signal,
      headers: mcpHeaders(regB.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'write_file', arguments: {} } }),
    });
    assert.equal(bRes.status, 200);
    assert.equal(readRpcResponse(await bRes.text(), 6).result.content[0].text, 'B:ok');
  } finally {
    regA.unregister();
    regB.unregister();
    await bridge.close();
  }
});

test('Connection-level MCP token is reused across hot runs, captureContext rejects stale run without poisoning token', { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-token-reuse-'));
  const contexts = [];
  const harness = createControlledAcpDriverHarness((ctx) => {
    contexts.push(ctx);
  });
  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    // Run 1 starts on hot session
    const run1EventsPromise = collectRunEvents(service.run({
      deviceId: 'dev-reuse',
      sessionId: 'sess-reuse',
      runId: 'run-reuse-1',
      modelId: MODEL_ID,
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'First turn' }],
    }));
    const ctx1 = await waitUntil(() => contexts[0], { label: 'run 1 context' });
    const token1 = ctx1.mcp.token;
    const mcpUrl = ctx1.mcp.bridge.serverConfig(token1).url;

    // Spy on captureContext so we deterministically know the HTTP request entered during Run 1
    // and captured Run 1's reference BEFORE its body finishes arriving.
    const capturedInRun1 = Promise.withResolvers();
    const origCapture = ctx1.mcp.handler.captureContext;
    ctx1.mcp.handler.captureContext = () => {
      const value = origCapture();
      capturedInRun1.resolve(value);
      return value;
    };

    const staleBody = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'from-run-1.txt' } },
    }));
    const staleResponse = Promise.withResolvers();
    const staleReq = http.request(mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(token1),
      signal: t.signal,
    }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.once('error', staleResponse.reject);
      res.once('end', () => staleResponse.resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    staleReq.once('error', staleResponse.reject);
    staleReq.setNoDelay?.(true);
    staleReq.flushHeaders();
    staleReq.write(staleBody.subarray(0, 10));
    await capturedInRun1.promise;
    ctx1.mcp.handler.captureContext = origCapture;

    // Finish Run 1 while keeping driver alive (hot connection!)
    ctx1.emit({ type: 'text', delta: 'run-1-done' });
    ctx1.finish();
    const run1Events = await run1EventsPromise;
    assert.equal(run1Events.at(-1)?.type, 'turn_done');

    // Start Run 2 on the exact same session -> MUST reuse connection-level MCP token (no rotation!).
    const stream2 = service.run({
      deviceId: 'dev-reuse',
      sessionId: 'sess-reuse',
      runId: 'run-reuse-2',
      modelId: MODEL_ID,
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'Second turn' }],
    });
    const iter2 = stream2[Symbol.asyncIterator]();
    const ctx2 = await waitUntil(() => contexts[1], { label: 'run 2 context' });
    assert.equal(ctx2.mcp.token, token1, 'hot connection must reuse the same connection-level MCP token');
    assert.equal(harness.mcpRegistrations.length, 1);

    // Now finish sending the delayed Run 1 request body during Run 2.
    staleReq.end(staleBody.subarray(10));
    const staleRes = await staleResponse.promise;
    assert.equal(staleRes.status, 200);
    const staleRpc = readRpcResponse(staleRes.body, 10);
    assert.equal(staleRpc.result.isError, true, 'delayed call captured during Run 1 must be rejected as isError');
    assert.match(staleRpc.result.content[0].text, /inactive run/);

    // Verify the connection-level token was NOT poisoned: Run 2 can still execute a real tool call over the SAME token!
    const freshCallPromise = fetch(mcpUrl, {
      method: 'POST',
      signal: t.signal,
      headers: mcpHeaders(token1),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'from-run-2.txt' } },
      }),
    }).then(async (res) => ({ status: res.status, frame: readRpcResponse(await res.text(), 11) }));

    const toolReqStep = await iter2.next();
    assert.equal(toolReqStep.done, false);
    assert.equal(toolReqStep.value.type, 'tool_request');
    assert.equal(toolReqStep.value.name, 'read_file');
    assert.deepEqual(toolReqStep.value.args, { path: 'from-run-2.txt' });

    await service.submitToolResult({
      deviceId: 'dev-reuse',
      sessionId: 'sess-reuse',
      runId: 'run-reuse-2',
      callId: toolReqStep.value.callId,
      content: [{ type: 'text', text: 'run-2-tool-ok' }],
      isError: false,
    });

    const freshRes = await freshCallPromise;
    assert.equal(freshRes.status, 200);
    assert.equal(freshRes.frame.result.isError, false);
    assert.deepEqual(freshRes.frame.result.content, [{ type: 'text', text: 'run-2-tool-ok' }]);

    ctx2.emit({ type: 'text', delta: 'run-2-done' });
    ctx2.finish();
    const run2Rest = [];
    for (;;) {
      const next = await iter2.next();
      if (next.done) break;
      run2Rest.push(next.value);
    }
    assert.equal(run2Rest.at(-1)?.type, 'turn_done');
  } finally {
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP transport write failure triggers onDeliveryError, aborts active run, and recycles connection', { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-delivery-err-'));
  const marker = 'DELIVERY_WRITE_FAILURE_MARKER';
  const requestAbort = new AbortController();
  let injectedFailure = false;

  const origSend = StreamableHTTPServerTransport.prototype.send;
  t.mock.method(StreamableHTTPServerTransport.prototype, 'send', async function (message, ...rest) {
    if (JSON.stringify(message).includes(marker)) {
      injectedFailure = true;
      throw new Error('injected MCP transport write failure');
    }
    return origSend.call(this, message, ...rest);
  });

  const httpDone = Promise.withResolvers();
  const harness = createControlledAcpDriverHarness(async (ctx) => {
    if (harness.runs.length === 1) {
      const url = ctx.mcp.bridge.serverConfig(ctx.mcp.token).url;
      try {
        await fetch(url, {
          method: 'POST',
          headers: mcpHeaders(ctx.mcp.token),
          signal: AbortSignal.any([requestAbort.signal, t.signal]),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'read_file', arguments: { path: 'x.txt' } },
          }),
        });
      } catch {
        // Expected when server transport fails mid-write.
      } finally {
        httpDone.resolve();
      }
      // Even if native ACP still attempts to finish OK, Center must fail closed due to onDeliveryError.
      ctx.emit({ type: 'text', delta: 'must-not-succeed' });
      ctx.finish();
      return;
    }
    ctx.emit({ type: 'text', delta: 'recovered-after-recycle' });
    ctx.finish();
  });

  const service = openAntigravity({
    dataRoot: root,
    bin: 'mocked-agy',
    geminiHome: path.join(root, 'antigravity', 'gemini'),
  });

  try {
    const stream1 = service.run({
      deviceId: 'dev-deliv',
      sessionId: 'sess-deliv',
      runId: 'run-deliv-1',
      modelId: MODEL_ID,
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'Call tool with delivery failure' }],
    });
    const iter1 = stream1[Symbol.asyncIterator]();
    const reqStep = await iter1.next();
    assert.equal(reqStep.value?.type, 'tool_request');

    await service.submitToolResult({
      deviceId: 'dev-deliv',
      sessionId: 'sess-deliv',
      runId: 'run-deliv-1',
      callId: reqStep.value.callId,
      content: [{ type: 'text', text: marker }],
      isError: false,
    });
    await httpDone.promise;

    const rest1 = [];
    for (;;) {
      const step = await iter1.next();
      if (step.done) break;
      rest1.push(step.value);
    }
    assert.equal(injectedFailure, true, 'failure injection must hit the ESM StreamableHTTPServerTransport');
    assert.equal(rest1.at(-1)?.type, 'error', 'delivery failure must fail the run rather than emitting turn_done');
    assert.match(rest1.at(-1)?.message ?? '', /injected MCP transport write failure/);
    assert.ok(harness.closes.some((c) => c.reason === 'recycle' && c.cause === 'mcp delivery error'));
    assert.equal(harness.mcpRegistrations[0]?.unregistered, true);

    // Subsequent run on the same session obtains a fresh MCP token after connection recycle.
    const events2 = await collectRunEvents(service.run({
      deviceId: 'dev-deliv',
      sessionId: 'sess-deliv',
      runId: 'run-deliv-2',
      modelId: MODEL_ID,
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
      inputs: [{ text: 'Fresh run after recycle' }],
    }));
    assert.equal(events2.at(-1)?.type, 'turn_done');
    assert.equal(harness.mcpRegistrations.length, 2);
    assert.notEqual(harness.mcpRegistrations[1].token, harness.mcpRegistrations[0].token);
  } finally {
    requestAbort.abort();
    await service.close();
    harness.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RunToolWaiters returns standard MCP text + image blocks directly on normal resolution', async () => {
  const requests = [];
  const inFlightHistory = [];
  const waiters = new RunToolWaiters({
    escalateAfterMs: 5_000,
    onToolRequest: (ev) => requests.push(ev),
    onInFlightChange: (count) => inFlightHistory.push(count),
  });

  const ac = new AbortController();
  const pending = waiters.handleToolCall('call-img-1', 'codemode', { code: 'read("pic.png")' }, ac.signal);
  assert.deepEqual(requests, [{ callId: 'call-img-1', name: 'codemode', args: { code: 'read("pic.png")' } }]);
  assert.deepEqual(inFlightHistory, [1]);

  assert.equal(
    waiters.resolve('call-img-1', [
      { type: 'text', text: 'image loaded' },
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
    ], false),
    true,
  );
  assert.equal(waiters.resolve('call-img-1', 'duplicate', false), false);

  const result = await pending;
  assert.deepEqual(result, {
    content: [
      { type: 'text', text: 'image loaded' },
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
    ],
    isError: false,
  });
  assert.deepEqual(inFlightHistory, [1, 0]);
  assert.equal(waiters.inFlightCount, 0);
});

test('RunToolWaiters escalates slow tools to STILL RUNNING + callId and bridge_poll_result retrieves full text + image without re-running', { timeout: 10_000 }, async () => {
  const requests = [];
  const inFlightHistory = [];
  const waiters = new RunToolWaiters({
    escalateAfterMs: 40,
    onToolRequest: (ev) => requests.push(ev),
    onInFlightChange: (count) => inFlightHistory.push(count),
  });
  const ac = new AbortController();

  // 1. Direct call escalates after 40ms
  const ack = await waiters.handleToolCall('slow-call-1', 'codemode', { code: 'slow()' }, ac.signal);
  assert.equal(requests.length, 1);
  assert.equal(ack.isError, false);
  assert.match(ack.content[0].text, /STILL RUNNING/);
  assert.ok(ack.content[0].text.includes('slow-call-1'));
  assert.ok(ack.content[0].text.includes(POLL_TOOL_NAME));
  assert.equal(waiters.inFlightCount, 1);

  // 2. First poll while still executing also returns STILL RUNNING without re-running tool
  const stillRunning = await waiters.handleToolCall('poll-1', POLL_TOOL_NAME, { callId: 'slow-call-1' }, ac.signal);
  assert.equal(stillRunning.isError, false);
  assert.match(stillRunning.content[0].text, /STILL RUNNING/);
  assert.equal(requests.length, 1);

  // 3. Second poll awaits completion and receives complete text + image block
  const pollPromise = waiters.handleToolCall('poll-2', POLL_TOOL_NAME, { callId: 'slow-call-1' }, ac.signal);
  assert.equal(requests.length, 1);
  assert.equal(
    waiters.resolve('slow-call-1', [
      { type: 'text', text: 'slow result ready' },
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
    ], false),
    true,
  );
  const completed = await pollPromise;
  assert.deepEqual(completed, {
    content: [
      { type: 'text', text: 'slow result ready' },
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
    ],
    isError: false,
  });

  // 4. Subsequent poll returns the cached result cleanly; onToolRequest stayed strictly 1!
  const repeated = await waiters.handleToolCall('poll-3', POLL_TOOL_NAME, { callId: 'slow-call-1' }, ac.signal);
  assert.deepEqual(repeated, completed);
  assert.equal(requests.length, 1, 'onToolRequest must fire strictly once for an escalated tool');
  assert.deepEqual(inFlightHistory, [1, 0]);
});

test('bridge_poll_result rejects unknown, non-escalated, and cross-run callIds with isError: true', { timeout: 10_000 }, async () => {
  const requests1 = [];
  const run1Waiters = new RunToolWaiters({
    escalateAfterMs: 40,
    onToolRequest: (ev) => requests1.push(ev),
  });
  const ac = new AbortController();

  // Unknown, empty, and non-escalated in-flight callId
  const unknown = await run1Waiters.handleToolCall('p-unk', POLL_TOOL_NAME, { callId: 'does-not-exist' }, ac.signal);
  assert.equal(unknown.isError, true);
  const empty = await run1Waiters.handleToolCall('p-empty', POLL_TOOL_NAME, {}, ac.signal);
  assert.equal(empty.isError, true);

  const nonEscalatedWaiters = new RunToolWaiters({
    escalateAfterMs: 5_000,
    onToolRequest: () => {},
  });
  const pendingDirect = nonEscalatedWaiters.handleToolCall('not-escalated', 'codemode', {}, ac.signal);
  const pollEarly = await nonEscalatedWaiters.handleToolCall('p-early', POLL_TOOL_NAME, { callId: 'not-escalated' }, ac.signal);
  assert.equal(pollEarly.isError, true);
  nonEscalatedWaiters.failAll('cleanup');
  await pendingDirect;

  // Escalate a call in Run 1
  await run1Waiters.handleToolCall('run1-slow', 'codemode', { code: 'work()' }, ac.signal);
  run1Waiters.resolve('run1-slow', 'run1 done', false);
  assert.equal(requests1.length, 1);

  // Cross-run poll in Run 2 must fail closed with isError: true and never dispatch a tool
  const requests2 = [];
  const run2Waiters = new RunToolWaiters({
    escalateAfterMs: 40,
    onToolRequest: (ev) => requests2.push(ev),
  });
  const crossRun = await run2Waiters.handleToolCall('p-cross', POLL_TOOL_NAME, { callId: 'run1-slow' }, ac.signal);
  assert.equal(crossRun.isError, true);
  assert.match(crossRun.content[0].text, /Unknown or non-escalated callId/);
  assert.equal(requests2.length, 0);
});
