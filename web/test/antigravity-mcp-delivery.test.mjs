import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import {
  createControlledAcpDriverHarness, openIsolatedAntigravity, closeAndRemove,
  drainEventStream, BASE_SYSTEM, MODEL_ID, toolResult,
} from './helpers/antigravity-sync-harness.mjs';

const requireCenter = createRequire(new URL('../../center-server/package.json', import.meta.url));
const transportEntry = requireCenter.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js');
// The locked SDK exposes separate CJS and ESM builds. Resolve from Center's
// dependencies, then load its ESM sibling so the mock targets the exact class
// used by mcp-bridge.ts rather than an independent CJS prototype.
const transportEsmEntry = path.resolve(path.dirname(transportEntry), '../../esm/server/streamableHttp.js');
const { StreamableHTTPServerTransport } = await import(pathToFileURL(transportEsmEntry).href);

const headers = token => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-bridge-token': token,
});

test('MCP preserves UTF-8 tool arguments when a character crosses HTTP chunks', { timeout: 15_000 }, async t => {
  const bridge = new SharedMcpBridge();
  let observed;
  const registration = bridge.registerSession({
    listTools: () => [],
    async onToolCall(_id, _name, args) {
      observed = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  try {
    await bridge.ensureStarted();
    const content = '中文😀END';
    const bytes = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'write_file', arguments: { content } },
    }));
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    const finished = Promise.withResolvers();
    const req = http.request(bridge.serverConfig(registration.token).url, {
      method: 'POST', headers: headers(registration.token), signal: t.signal,
    }, res => {
      res.once('error', finished.reject);
      res.once('end', () => finished.resolve(res.statusCode));
      res.resume();
    });
    req.once('error', finished.reject);
    req.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 15));
    req.end(bytes.subarray(split));
    assert.equal(await finished.promise, 200);
    assert.equal(observed.content, content);
  } finally {
    registration.unregister();
    await bridge.close();
  }
});

function readRpcResponse(body) {
  if (body.trimStart().startsWith('{')) return JSON.parse(body);
  const frames = body.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice('data:'.length).trim()));
  return frames.find(frame => frame.id === 1);
}

async function httpToolRoundTrip(t, { failResponse = false, nativeToolError = false } = {}) {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-http-delivery-'));
  const service = openIsolatedAntigravity(rootDir);
  const requestAbort = new AbortController();
  const requestSignal = AbortSignal.any([requestAbort.signal, t.signal]);
  const marker = 'ACTUAL_HOST_TOOL_RESULT_DELIVERY_MARKER';
  let failed = false;
  let received;
  let transportError;

  if (failResponse) {
    const original = StreamableHTTPServerTransport.prototype.send;
    t.mock.method(StreamableHTTPServerTransport.prototype, 'send', async function (message, ...rest) {
      if (JSON.stringify(message).includes(marker)) {
        failed = true;
        requestAbort.abort();
        throw new Error('injected MCP response send failure');
      }
      return original.call(this, message, ...rest);
    });
  }

  driver.setOnRun(async ctx => {
    if (driver.runs.length === 1) {
      const args = { path: 'fixture.txt' };
      ctx.emit({ type: 'tool_start', toolCallId: 'native-read', name: 'read_file', args, mcpServer: 'pibot-bridge' });
      try {
        const res = await fetch(ctx.mcp.bridge.serverConfig(ctx.mcp.token).url, {
          method: 'POST', headers: headers(ctx.mcp.token), signal: requestSignal,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'read_file', arguments: args },
          }),
        });
        received = { status: res.status, frame: readRpcResponse(await res.text()) };
      } catch (err) {
        // Native agy can still end normally after a tool transport failure.
        // The Center must independently prevent an uncertain ready checkpoint.
        transportError = err;
      }
      if (nativeToolError) {
        ctx.emit({
          type: 'tool_error', toolCallId: 'native-read', name: 'read_file',
          message: 'native failed to consume', mcpServer: 'pibot-bridge',
        });
      }
    }
    const reply = driver.runs.length === 1 ? 'native tool turn ended' : 'follow-up completed';
    ctx.emit({ type: 'text', delta: reply });
    ctx.finish({ conversationId: ctx.conversationId, status: 'OK', response: reply, finished: true, aborted: false });
  });

  const user = { role: 'user', content: 'Read fixture.txt and remember its result.', timestamp: 10 };
  const send = messages => drainEventStream(service.stream({
    deviceId: 'http-delivery', sessionId: 'http-delivery', modelId: MODEL_ID, messages,
    turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] },
  }));
  try {
    const first = await send([BASE_SYSTEM, user]);
    assert.equal(first.terminal.reason, 'toolUse');
    const call = first.terminal.message.content.find(block => block.type === 'toolCall');
    assert.ok(call, 'real MCP HTTP tools/call must park a Host tool call');
    const history = [BASE_SYSTEM, user, first.terminal.message, toolResult(call.id, call.name, marker, 12)];
    const result = await send(history);
    if (failResponse) {
      assert.equal(failed, true, 'failure injection must target the production ESM transport');
      assert.ok(transportError, 'the native HTTP client must observe the failed response');
    } else {
      assert.equal(received?.status, 200);
      assert.equal(received.frame.result.isError, false);
      assert.deepEqual(received.frame.result.content, [{ type: 'text', text: marker }]);
      assert.equal(transportError, undefined);
    }

    if (failResponse || nativeToolError) {
      assert.equal(result.terminal.type, 'error', 'uncertain tool delivery must not acknowledge a ready native history');
    } else {
      assert.equal(result.terminal.type, 'done');
      assert.equal(result.terminal.reason, 'stop');
      history.push(result.terminal.message);
    }
    const next = await send([...history, { role: 'user', content: 'Continue using the file result.', timestamp: 20 }]);
    assert.equal(next.terminal.reason, 'stop');
    assert.equal(driver.runs.length, 2, 'the first continuation must reenter its parked native turn');
    const followUp = driver.runs[1].request;
    if (failResponse || nativeToolError) {
      assert.equal(followUp.conversationId, null, 'uncertain native history must be rebuilt');
      assert.ok(followUp.contextBlock?.text.includes(marker), 'full replay must retain the actual Host tool result');
      assert.ok(followUp.contextBlock.text.includes(call.id), 'full replay must preserve the corresponding tool call');
      assert.ok(followUp.contextBlock.text.includes(user.content));
    } else {
      assert.equal(followUp.conversationId, driver.runs[0].assignedConversationId, 'successful HTTP delivery must retain the reusable binding');
    }
  } finally {
    requestAbort.abort();
    await closeAndRemove({ antigravity: service, rootDir });
  }
}

test('MCP HTTP send failure cannot acknowledge a successful Host tool result', { timeout: 15_000 }, async t => {
  await httpToolRoundTrip(t, { failResponse: true });
});

test('MCP HTTP successful result delivery retains the native binding', { timeout: 15_000 }, async t => {
  await httpToolRoundTrip(t);
});

test('MCP native bridge tool_error invalidates an otherwise successful turn', { timeout: 15_000 }, async t => {
  await httpToolRoundTrip(t, { nativeToolError: true });
});
