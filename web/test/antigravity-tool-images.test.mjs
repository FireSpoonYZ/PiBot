import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAcpRecallHook } from '../../center-server/antigravity/vendor/acp/recall-hook.ts';

const HELPER = fileURLToPath(new URL('../../center-server/antigravity/vendor/acp/recall-hook-client.cjs', import.meta.url));
const png = { mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=' };

async function exchange(hook, request) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(hook.env.PI_AGY_RECALL_PORT) });
    const chunks = [];
    let ended = false;
    const timer = setTimeout(() => socket.destroy(new Error('hook fixture timed out')), 3000);
    socket.on('connect', () => socket.end(JSON.stringify(request)));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      if (!ended) reject(new Error('hook fixture socket closed before reply ended'));
    });
    socket.on('end', () => {
      ended = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

async function readHook(hook, conversationId) {
  const nonce = randomBytes(16).toString('hex');
  const key = Buffer.from(hook.env.PI_AGY_RECALL_KEY, 'hex');
  const proof = createHmac('sha256', key).update('read:').update(nonce).update(conversationId).digest('hex');
  const received = await exchange(hook, { conversationId, nonce, proof });
  if (!received.length) return null;
  assert.equal(received[64], 10);
  const signature = received.subarray(0, 64).toString();
  const body = received.subarray(65);
  assert.equal(signature, createHmac('sha256', key).update('reply:').update(nonce).update(body).digest('hex'));
  return {
    payload: JSON.parse(body.toString()),
    receipt: {
      conversationId, nonce, delivered: true,
      proof: createHmac('sha256', key).update('delivered:').update(nonce).update(conversationId).update(body).digest('hex'),
    },
  };
}

async function acknowledge(hook, reply) {
  await exchange(hook, reply.receipt);
}

async function runHelper(hook, conversationId, { breakStdout = false } = {}) {
  const child = spawn(process.execPath, [HELPER], {
    env: { ...process.env, ...hook.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  if (breakStdout) child.stdout.destroy();
  else child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    child.stdin.end(JSON.stringify({ hookEventName: 'PreInvocation', conversationId }));
    return await result;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('Tool image hook works with automatic recall disabled and delivers each call image once', async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const binding = hook.bind('native-a', undefined);
  binding.queueToolResultImages('call-a', [png]);
  binding.queueToolResultImages('call-a', [png]);
  const first = await readHook(hook, 'native-a');
  assert.equal(first.payload.injectSteps.length, 1);
  assert.deepEqual(first.payload.injectSteps[0].systemMessage.media, [
    { mimeType: png.mimeType, inlineData: png.data },
  ]);
  assert.equal(first.payload.injectSteps[0].ephemeralMessage, undefined);
  assert.equal(first.payload.injectSteps[0].systemMessage.metadata, undefined);
  assert.throws(() => binding.assertImagesDelivered(), /local helper delivery/);
  await acknowledge(hook, first);
  binding.assertImagesDelivered();
  assert.equal(await readHook(hook, 'native-a'), null);
  binding.queueToolResultImages('call-a', [png]);
  assert.equal(await readHook(hook, 'native-a'), null);
  await acknowledge(hook, first);
  binding.assertImagesDelivered();
});

test('Image order and source identities remain separate across calls and sessions', async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const binding = hook.bind('native-a', undefined);
  binding.queueToolResultImages('call-a', [png, png]);
  binding.queueToolResultImages('call-b', [png]);
  assert.equal(await readHook(hook, 'native-b'), null);
  const reply = await readHook(hook, 'native-a');
  assert.equal(reply.payload.injectSteps.length, 3);
  const texts = reply.payload.injectSteps.map(step => step.systemMessage.systemMessage);
  assert.match(texts[0], /call-a/);
  assert.match(texts[1], /"imageIndex":1/);
  assert.match(texts[2], /call-b/);
  await acknowledge(hook, reply);
  binding.assertImagesDelivered();
});

test('Cancelled pending images cannot cross into the next native prompt', async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const old = hook.bind('native-a', undefined);
  old.queueToolResultImages('cancelled-call', [png]);
  old.release();
  const next = hook.bind('native-b', undefined);
  assert.equal(await readHook(hook, 'native-a'), null);
  assert.equal(await readHook(hook, 'native-b'), null);
  assert.throws(() => old.queueToolResultImages('late-call', [png]), /active native prompt/);
  assert.throws(() => old.assertImagesDelivered(), /not delivered/);
  next.assertImagesDelivered();
});

test('Reading a hook reply without ACK never counts as image delivery', async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const binding = hook.bind('native-a', undefined);
  assert.throws(() => binding.queueToolResultImages('bad', [{ ...png, data: 'not-an-image' }]));
  binding.queueToolResultImages('pending', [png]);
  assert.throws(() => binding.assertImagesDelivered(), /before consuming/);
  await readHook(hook, 'native-a');
  assert.equal(await readHook(hook, 'native-a'), null, 'an unacknowledged read must not duplicate image output');
  assert.throws(() => binding.assertImagesDelivered(), /local helper delivery/);
});

test('Bad HMAC and wrong-session ACKs cannot confirm an image', async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const binding = hook.bind('native-a', undefined);
  binding.queueToolResultImages('call-a', [png]);
  const reply = await readHook(hook, 'native-a');
  await exchange(hook, { ...reply.receipt, proof: '0'.repeat(64) });
  assert.throws(() => binding.assertImagesDelivered(), /local helper delivery/);
  await exchange(hook, { ...reply.receipt, conversationId: 'native-b' });
  assert.throws(() => binding.assertImagesDelivered(), /local helper delivery/);
  await acknowledge(hook, reply);
  binding.assertImagesDelivered();
});

test('A cancelled prompt ACK cannot confirm a later image in the same native session', async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const old = hook.bind('native-a', undefined);
  old.queueToolResultImages('old-call', [png]);
  const oldReply = await readHook(hook, 'native-a');
  old.release();
  const next = hook.bind('native-a', undefined);
  next.queueToolResultImages('new-call', [png]);
  const nextReply = await readHook(hook, 'native-a');
  await acknowledge(hook, oldReply);
  assert.throws(() => next.assertImagesDelivered(), /local helper delivery/);
  assert.throws(() => old.assertImagesDelivered(), /not delivered/);
  await acknowledge(hook, nextReply);
  next.assertImagesDelivered();
});

test('The shipped helper confirms its successful stdout image output before exiting', { timeout: 10_000 }, async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const binding = hook.bind('native-helper', undefined);
  binding.queueToolResultImages('helper-image', [png]);
  const result = await runHelper(hook, 'native-helper');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.injectSteps[0].systemMessage.media, [{ mimeType: png.mimeType, inlineData: png.data }]);
  binding.assertImagesDelivered();
  assert.equal(await readHook(hook, 'native-helper'), null);
});

test('The shipped helper cannot ACK an image when its stdout pipe is broken', { timeout: 10_000 }, async t => {
  const hook = await createAcpRecallHook();
  t.after(() => hook.close());
  const binding = hook.bind('native-helper', undefined);
  binding.queueToolResultImages('helper-image', [png]);
  const result = await runHelper(hook, 'native-helper', { breakStdout: true });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null, 'failure must come from the write callback rather than the fixture timeout');
  assert.equal(await readHook(hook, 'native-helper'), null, 'the helper read the queue before stdout failed');
  assert.throws(() => binding.assertImagesDelivered(), /local helper delivery/);
});
