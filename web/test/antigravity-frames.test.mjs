import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonRpcSession, JsonRpcFrameSizeError } from '../../center-server/antigravity/vendor/acp/jsonrpc.ts';
import { MAX_FRAME_BYTES } from '../../center-server/antigravity/vendor/frame-guard.ts';

test('ACP outgoing frame limits use encoded UTF-8 bytes, include the newline, and leave no pending requests', async () => {
  const sent = [];
  const rpc = new JsonRpcSession({ send: frame => sent.push(frame), defaultTimeoutMs: 10000 });
  const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boundary', params: { text: '' } })) + 1;
  const exact = 'x'.repeat(MAX_FRAME_BYTES - overhead);
  const accepted = rpc.request('boundary', { text: exact });
  assert.equal(Buffer.byteLength(sent[0]) + 1, MAX_FRAME_BYTES);
  assert.equal(rpc.pendingCount, 1);
  rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n');
  assert.equal(await accepted, 'ok');
  sent.length = 0;
  await assert.rejects(rpc.request('boundary', { text: exact + 'x' }), error => error instanceof JsonRpcFrameSizeError && error.code === 'ACP_FRAME_TOO_LARGE');
  assert.equal(rpc.pendingCount, 0);
  assert.equal(sent.length, 0);
  const multibyte = '汉'.repeat(Math.ceil(MAX_FRAME_BYTES / 3));
  await assert.rejects(rpc.request('utf8', { text: multibyte }), JsonRpcFrameSizeError);
  assert.throws(() => rpc.notify('utf8', { text: multibyte }), JsonRpcFrameSizeError);
  assert.equal(rpc.pendingCount, 0);
  assert.equal(sent.length, 0);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(rpc.request('cyclic', cyclic), /circular/i);
  assert.equal(rpc.pendingCount, 0);
  const normal = rpc.request('normal', { text: 'small' });
  const frame = JSON.parse(sent.at(-1));
  rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: 42 }) + '\n');
  assert.equal(await normal, 42);
  const broken = new JsonRpcSession({ send() { throw new Error('pipe closed'); }, defaultTimeoutMs: 10000 });
  await assert.rejects(broken.request('request'), /pipe closed/);
  assert.equal(broken.pendingCount, 0);
});

test('ACP oversized server-request results return a complete bounded error frame', async () => {
  const sent = [];
  const rpc = new JsonRpcSession({
    send: frame => sent.push(frame),
    onRequest: async () => ({ text: 'x'.repeat(MAX_FRAME_BYTES) }),
  });
  rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: 'server-request', method: 'read-large-file', params: {} }) + '\n');
  await new Promise(setImmediate);
  assert.equal(sent.length, 1);
  assert.ok(Buffer.byteLength(sent[0]) + 1 <= MAX_FRAME_BYTES);
  const response = JSON.parse(sent[0]);
  assert.equal(response.id, 'server-request');
  assert.ok(response.error && typeof response.error.code === 'number');
  assert.equal(response.result, undefined);
});
