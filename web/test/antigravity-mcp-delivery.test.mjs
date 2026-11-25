import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { SharedMcpBridge } from '../../center-server/antigravity/mcp-bridge.ts';
import { ToolRoundTrips } from '../../center-server/antigravity/round-trips.ts';
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

async function httpToolRoundTrip(t, { failResponse = false, nativeToolError = false, hostToolError = false } = {}) {
  const driver = createControlledAcpDriverHarness(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-http-delivery-'));
  const service = openIsolatedAntigravity(rootDir);
  const requestAbort = new AbortController();
  const requestSignal = AbortSignal.any([requestAbort.signal, t.signal]);
  const marker = 'ACTUAL_HOST_TOOL_RESULT_DELIVERY_MARKER';
  let failed = false;
  let received;
  let transportError;
  const nativeRequestDone = Promise.withResolvers();

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
      } finally {
        nativeRequestDone.resolve();
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
  const send = (messages, sessionId = 'http-delivery') => drainEventStream(service.stream({
    deviceId: 'http-delivery', sessionId, modelId: MODEL_ID, messages,
    turnContext: { inputIndex: messages.length - 1, auxiliaryIndices: [] },
  }));
  try {
    const first = await send([BASE_SYSTEM, user]);
    assert.equal(first.terminal.reason, 'toolUse');
    const call = first.terminal.message.content.find(block => block.type === 'toolCall');
    assert.ok(call, 'real MCP HTTP tools/call must park a Host tool call');
    const history = [BASE_SYSTEM, user, first.terminal.message, toolResult(call.id, call.name, marker, 12, hostToolError)];
    const result = await send(history);
    await nativeRequestDone.promise;
    if (failResponse) {
      assert.equal(failed, true, 'failure injection must target the production ESM transport');
      assert.ok(transportError, 'the native HTTP client must observe the failed response');
    } else {
      assert.equal(received?.status, 200);
      assert.equal(received.frame.result.isError, hostToolError);
      assert.deepEqual(received.frame.result.content, [{ type: 'text', text: marker }]);
      assert.equal(transportError, undefined);
    }

    if (failResponse || (nativeToolError && !hostToolError)) {
      assert.equal(result.terminal.type, 'error', 'uncertain delivery must not become a ready native turn');
      const repeated = await send(history);
      assert.equal(repeated.terminal.type, 'error');
      assert.equal(driver.runs.length, 1, 'retry must not repeat a tool or native prompt');
      const next = await send([...history, { role: 'user', content: 'Continue using the file result.', timestamp: 20 }]);
      assert.equal(next.terminal.type, 'error', 'a lost live tool continuation cannot be rebuilt');
      assert.match(next.terminal.error.errorMessage, /AGY_TURN_PENDING|AGY_HISTORY_CHANGED/);
      assert.equal(driver.runs.length, 1, 'new input must not silently replay the old tool transcript');
      const cleared = await send([BASE_SYSTEM, { role: 'user', content: 'Start a clean conversation.', timestamp: 30 }], 'after-clear');
      assert.equal(cleared.terminal.reason, 'stop');
      assert.equal(driver.runs[1].request.conversationId, null);
      assert.equal(driver.runs[1].request.contextBlock, undefined);
      assert.equal(driver.runs[1].request.prompt.includes(marker), false);
    } else {
      assert.equal(result.terminal.type, 'done');
      assert.equal(result.terminal.reason, 'stop');
      history.push(result.terminal.message);
      const next = await send([...history, { role: 'user', content: 'Continue using the file result.', timestamp: 20 }]);
      assert.equal(next.terminal.reason, 'stop');
      assert.equal(driver.runs.length, 2, 'tool continuation must reenter the original native turn');
      const followUp = driver.runs[1].request;
      assert.equal(followUp.conversationId, driver.runs[0].assignedConversationId);
      assert.equal(followUp.contextBlock, undefined, 'native history is retained without transcript replay');
      assert.equal(followUp.prompt.includes(marker), false, 'completed tool output is not resubmitted as user input');
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

test('An ordinary Host tool error remains model input when native reports the matching tool_error', { timeout: 15_000 }, async t => {
  await httpToolRoundTrip(t, { nativeToolError: true, hostToolError: true });
});

test('MCP tokens isolate registrations and retired tokens cannot execute a tool', { timeout: 10_000 }, async t => {
  const bridge = new SharedMcpBridge();
  const calls = [];
  const register = owner => bridge.registerSession({
    listTools: () => [],
    async onToolCall(_id, name) {
      calls.push({ owner, name });
      return { content: [{ type: 'text', text: owner }] };
    },
  });
  const first = register('first');
  const second = register('second');
  try {
    await bridge.ensureStarted();
    const call = async token => {
      const response = await fetch(bridge.serverConfig(token).url, {
        method: 'POST', headers: headers(token), signal: t.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'read_file', arguments: {} } }),
      });
      return { status: response.status, body: await response.text() };
    };
    assert.equal((await call('invalid-token')).status, 403);
    assert.deepEqual(calls, []);
    assert.equal(readRpcResponse((await call(first.token)).body).result.content[0].text, 'first');
    first.unregister();
    assert.equal((await call(first.token)).status, 403);
    assert.equal(readRpcResponse((await call(second.token)).body).result.content[0].text, 'second');
    assert.deepEqual(calls, [{ owner: 'first', name: 'read_file' }, { owner: 'second', name: 'read_file' }]);
  } finally {
    first.unregister();
    second.unregister();
    await bridge.close();
  }
});

const png = { mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=' };

function imageRoundTrips(t, { escalateAfterMs = 0 } = {}) {
  const queuedImages = [];
  const activities = [];
  const driver = {
    activeHandle: { id: 'original-native-turn', pushExternal: activity => activities.push(activity) },
    kickIdle() {},
    queueToolResultImages(callId, images) { queuedImages.push({ callId, images: structuredClone(images) }); },
  };
  const trips = new ToolRoundTrips(driver, undefined, { escalateAfterMs });
  t.after(() => trips.failAll('fixture cleanup', { includeEscalated: true }));
  return { trips, driver, queuedImages, activities, signal: t.signal };
}

function assertImageNotice(result, callId) {
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.map(block => block.type), ['text'], 'MCP must not duplicate hook image blocks');
  assert.match(result.content[0].text, /Visual attachments/);
  assert.ok(result.content[0].text.includes(callId));
  assert.equal(JSON.stringify(result).includes(png.data), false, 'base64 is only handed to the native image hook');
}

for (const name of ['codemode', 'read_image']) {
  test(name + ' normal toolResult sends images to the hook once and keeps MCP textual', async t => {
    const { trips, queuedImages, activities, signal } = imageRoundTrips(t);
    const waiting = trips.onToolCall('normal-image-call', name, {}, signal);
    assert.equal(activities[0].type, 'bridge_call');
    assert.equal(trips.resolve('normal-image-call', 'tool output', false, [png]), true);
    const result = await waiting;
    assertImageNotice(result, 'normal-image-call');
    assert.deepEqual(queuedImages, [{ callId: 'normal-image-call', images: [png] }]);
    assert.equal(trips.resolve('normal-image-call', 'duplicate result', false, [png]), false);
    assert.equal(queuedImages.length, 1);
  });
}

test('A completed poll queues its original call images once; running and repeated polls do not', { timeout: 10_000 }, async t => {
  const { trips, queuedImages, signal } = imageRoundTrips(t, { escalateAfterMs: 1 });
  const waiting = await trips.onToolCall('slow-image-call', 'codemode', {}, signal);
  assert.match(waiting.content[0].text, /STILL RUNNING/);
  const running = await trips.onToolCall('poll-running', 'bridge_poll_result', { callId: 'slow-image-call' }, signal);
  assert.match(running.content[0].text, /STILL RUNNING/);
  assert.deepEqual(queuedImages, []);
  assert.equal(trips.resolve('slow-image-call', 'screenshot ready', false, [png]), true);
  assert.deepEqual(queuedImages, [], 'an escalated result waits for its live native poll');
  const completed = await trips.onToolCall('poll-done', 'bridge_poll_result', { callId: 'slow-image-call' }, signal);
  assertImageNotice(completed, 'slow-image-call');
  assert.deepEqual(queuedImages, [{ callId: 'slow-image-call', images: [png] }]);
  const repeated = await trips.onToolCall('poll-again', 'bridge_poll_result', { callId: 'slow-image-call' }, signal);
  assert.deepEqual(repeated, completed);
  assert.equal(queuedImages.length, 1, 'poll transport identity does not create another image source');
});

test('A polled image cannot move into a different native turn or rerun its original tool', { timeout: 10_000 }, async t => {
  const { trips, driver, queuedImages, activities, signal } = imageRoundTrips(t, { escalateAfterMs: 1 });
  await trips.onToolCall('old-image-call', 'read_image', {}, signal);
  trips.resolve('old-image-call', 'tool already completed', false, [png]);
  driver.activeHandle = { id: 'replacement-native-turn', pushExternal: activity => activities.push(activity) };
  const result = await trips.onToolCall('late-poll', 'bridge_poll_result', { callId: 'old-image-call' }, signal);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /original native prompt is no longer available/);
  assert.match(result.content[0].text, /do not repeat side effects/);
  assert.deepEqual(queuedImages, []);
  assert.equal(activities.filter(activity => activity.type === 'bridge_call').length, 1);
  assert.equal(result.content.some(block => block.type === 'image'), false);
});
