import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerClientReleaseRoutes } from '../../center-server/client-releases.js';
import { registerRoutes } from '../../center-server/routes.js';
import { openOperations } from '../../center-server/operations/index.js';
import { errorStatus } from '../../center-server/server.js';
import { connectCenter } from '../../host-core/center-client.js';
import { openDesktopClient } from '../../host-core/desktop-client.js';
import { createDesktopClientCli } from '../../host-core/desktop-client-cli.js';
import { createAndroidBridge } from '../../host-core/android-runtime.js';
import { openRelayRegistry } from '../../host-core/relay-registry.js';
import { openRelayServer } from '../../host-core/relay-server.js';

const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const PASSWORD = 'owner-password-for-release-push-tests';
const PUBLIC_URL = 'https://center.example.test';

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((value) => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function removeDirSafe(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  const finalValue = await predicate();
  if (finalValue) return finalValue;
  throw new Error(`Timed out waiting for ${label}`);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReleaseRecord(id, version = '1.2.3') {
  return {
    id,
    platform: 'linux',
    arch: 'x86_64',
    format: 'deb',
    version,
    size: 4096,
    sha256: 'a'.repeat(64),
    signature: Buffer.from('untrusted comment: sig\nAAAA==\n', 'utf8').toString('base64'),
    notes: `Release ${version}`,
    sourceCommit: 'b'.repeat(40),
    filename: `pibot-${version}-linux-x86_64.deb`,
    published: false,
    publishedAt: null,
    createdAt: '2026-11-26T00:00:00.000Z',
  };
}

async function openListeningCenter({ wireOnReleasePublished = true } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-release-push-center-'));
  const store = openCenterStore({ dataRoot, encryptionKey: randomBytes(32) });
  const bridge = openHostBridge({
    dataRoot,
    store,
    linkUrl: 'wss://center.example.test/v1/link',
    relay: { getStatus: () => ({ onlineDeviceIds: [] }) },
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 400 && !errorStatus[code]) code = 'INVALID_ARGUMENT';
    if (!errorStatus[code]) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  let routes;
  const releaseOptions = {
    store,
    dataRoot,
    registry: bridge.registry,
    internalDeviceId: bridge.deviceId,
    publicUrl: PUBLIC_URL,
    ...(wireOnReleasePublished ? { onReleasePublished: () => routes?.notifyAll('client-release-published') } : {}),
  };
  const { listReleases, setReleasePublished } = registerClientReleaseRoutes(app, releaseOptions);
  routes = registerRoutes(app, {
    store,
    packages: {},
    bridge,
    execution: {},
    oauth: {},
    linkUrl: 'wss://center.example.test/v1/link',
    turns: {},
    catalog: { status: () => ({ source: 'test' }) },
    publicUrl: PUBLIC_URL,
    listReleases,
    setReleasePublished,
    createOperations: openOperations,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    store,
    bridge,
    routes,
    baseUrl,
    async login() {
      let res = await app.inject({ method: 'GET', url: '/api/session' });
      let cookie = cookieOf(res);
      res = await app.inject({
        method: 'POST',
        url: '/api/session',
        headers: { cookie, 'x-csrf-token': res.json().csrfToken },
        payload: { password: PASSWORD },
      });
      assert.equal(res.statusCode, 200);
      cookie = cookieOf(res, cookie);
      res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      assert.equal(res.json().authenticated, true);
      return { cookie: cookieOf(res, cookie), csrfToken: res.json().csrfToken };
    },
    async close() {
      routes.close();
      app.server.closeAllConnections?.();
      await app.close();
      bridge.close();
      store.close();
      removeDirSafe(dataRoot);
    },
  };
}

function openRawSseStream(baseUrl, { deviceId, deviceToken }) {
  const frames = [];
  let buffer = '';
  let ended = false;
  let statusCode = 0;

  const req = http.request(new URL('/api/host/events', baseUrl), {
    method: 'GET',
    agent: false,
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      'X-Device-Id': deviceId,
    },
  });
  req.on('error', () => {
    ended = true;
  });

  const connected = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', (res) => {
      statusCode = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('error', () => {
        ended = true;
      });
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buffer.slice(0, end);
          const sep = /^\r?\n\r?\n/.exec(buffer.slice(end))[0];
          buffer = buffer.slice(end + sep.length);
          frames.push(raw + '\n\n');
        }
      });
      res.once('end', () => {
        ended = true;
      });
      res.once('close', () => {
        ended = true;
      });
      resolve(res);
    });
  });

  req.end();

  return {
    connected,
    frames,
    getStatusCode: () => statusCode,
    isEnded: () => ended,
    close() {
      req.destroy();
    },
  };
}

async function createMockCenterAndRelay(deviceId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-release-push-mock-'));
  const cred = { deviceId, token: randomBytes(32).toString('base64url') };
  const registry = openRelayRegistry({ dataRoot: root });
  try {
    registry.register(cred);
  } finally {
    registry.close();
  }
  const relay = await openRelayServer({ dataRoot: root, port: 0 });
  const sseStreams = [];
  let connectionRequests = 0;
  let connectionGate = null;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/host/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('event: heartbeat\ndata: {}\n\n');
      sseStreams.push(res);
      return;
    }
    if (req.url === '/api/host/connection') {
      connectionRequests += 1;
      const gate = connectionGate;
      if (gate) await gate.promise;
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ linkUrl: relay.url }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const centerUrl = `http://127.0.0.1:${port}`;

  return {
    root,
    relay,
    cred,
    centerUrl,
    sseStreams,
    getConnectionRequests: () => connectionRequests,
    setConnectionGate(gate) {
      connectionGate = gate;
    },
    async close() {
      for (const stream of sseStreams) {
        try { stream.destroy(); } catch { /* ignore */ }
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await relay.close();
      removeDirSafe(root);
    },
  };
}

function attachJsonlReader(stream) {
  const frames = [];
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.length > 0) {
        frames.push(JSON.parse(line));
      }
    }
  });
  return {
    frames,
    waitForFrame(predicate, label) {
      return waitFor(() => frames.find(predicate), { label });
    },
  };
}

test('routes.notifyAll broadcasts custom SSE event to authenticated streams and defaults to config-changed', { timeout: 10_000 }, async () => {
  const center = await openListeningCenter();
  const streams = [];
  try {
    const devices = ['dev-notify-1', 'dev-notify-2', 'dev-notify-revoked'].map((deviceId) => {
      const deviceToken = randomBytes(32).toString('base64url');
      center.bridge.registry.register({ deviceId, token: deviceToken, displayName: deviceId });
      return { deviceId, deviceToken };
    });

    for (const dev of devices) {
      const stream = openRawSseStream(center.baseUrl, dev);
      streams.push(stream);
      await stream.connected;
      assert.equal(stream.getStatusCode(), 200);
      await waitFor(() => stream.frames.includes('event: heartbeat\ndata: {}\n\n'), {
        label: `${dev.deviceId} initial heartbeat`,
      });
    }

    // Revoke the third device; subsequent broadcasts must close it instead of writing events.
    center.bridge.registry.revoke('dev-notify-revoked');

    center.routes.notifyAll();
    await waitFor(
      () => streams[0].frames.includes('event: config-changed\ndata: {}\n\n')
        && streams[1].frames.includes('event: config-changed\ndata: {}\n\n')
        && streams[2].isEnded(),
      { label: 'default config-changed broadcast' },
    );
    assert.equal(streams[2].frames.includes('event: config-changed\ndata: {}\n\n'), false);

    center.routes.notifyAll('client-release-published');
    await waitFor(
      () => streams[0].frames.includes('event: client-release-published\ndata: {}\n\n')
        && streams[1].frames.includes('event: client-release-published\ndata: {}\n\n'),
      { label: 'custom client-release-published broadcast' },
    );
    assert.equal(streams[2].frames.includes('event: client-release-published\ndata: {}\n\n'), false);
  } finally {
    for (const stream of streams) stream.close();
    await center.close();
  }
});

test('setReleasePublished triggers SSE broadcast only when published=true across Web route and operations/MCP paths', { timeout: 10_000 }, async () => {
  const center = await openListeningCenter({ wireOnReleasePublished: true });
  let sseClient = null;
  try {
    // Verify server.js wires registerClientReleaseRoutes with the lazy notifyAll delegate.
    const serverSource = fs.readFileSync(new URL('../../center-server/server.js', import.meta.url), 'utf8');
    assert.match(serverSource, /onReleasePublished:\s*\(\)\s*=>\s*routes\?\.notifyAll\('client-release-published'\)/);

    const deviceId = 'dev-release-sub';
    const botId = 'bot-release-1';
    const deviceToken = randomBytes(32).toString('base64url');
    center.bridge.registry.register({ deviceId, token: deviceToken, displayName: 'Release Subscriber' });
    center.store.ensureDeviceOAuthGrant(deviceId);
    center.store.replaceDeviceBots(deviceId, [{ deviceId, botId, name: 'Release Bot', isPrimary: true }]);

    let releaseEvents = 0;
    let changeEvents = 0;
    sseClient = await connectCenter({
      centerUrl: center.baseUrl,
      deviceId,
      deviceToken,
      onChange: () => { changeEvents += 1; },
      onClientReleasePublished: () => { releaseEvents += 1; },
    });

    const record = makeReleaseRecord('rel-push-1', '1.2.3');
    center.store.createClientRelease(record);

    const { cookie, csrfToken } = await center.login();

    // 1. Web route publish (published: true) -> broadcasts client-release-published.
    let res = await center.app.inject({
      method: 'POST',
      url: `/api/client-releases/${record.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { published: true },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().published, true);
    await waitFor(() => releaseEvents === 1, { label: 'web publish SSE event' });

    // 2. Web route unpublish (published: false) -> must NOT broadcast.
    res = await center.app.inject({
      method: 'POST',
      url: `/api/client-releases/${record.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { published: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().published, false);
    center.routes.notifyAll();
    await waitFor(() => changeEvents === 1, { label: 'sentinel after web unpublish' });
    assert.equal(releaseEvents, 1);

    // 3. Unknown release ID -> NOT_FOUND and must NOT broadcast.
    res = await center.app.inject({
      method: 'POST',
      url: '/api/client-releases/rel-missing/publish',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { published: true },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
    center.routes.notifyAll();
    await waitFor(() => changeEvents === 2, { label: 'sentinel after failed publish' });
    assert.equal(releaseEvents, 1);

    // 4. Operations / MCP OAuth write actor publish -> broadcasts client-release-published.
    const oauthWriteActor = {
      kind: 'oauth',
      clientId: 'mcp-release-writer',
      scopes: ['pibot:center:read', 'pibot:center:write'],
      botTargets: [],
    };
    const opPublished = await center.routes.operations.call(
      oauthWriteActor,
      'center_set_client_release_published',
      { releaseId: record.id, published: true },
    );
    assert.equal(opPublished.published, true);
    await waitFor(() => releaseEvents === 2, { label: 'MCP operations publish SSE event' });

    // 5. Operations / MCP unpublish -> must NOT broadcast.
    const opUnpublished = await center.routes.operations.call(
      oauthWriteActor,
      'center_set_client_release_published',
      { releaseId: record.id, published: false },
    );
    assert.equal(opUnpublished.published, false);
    center.routes.notifyAll();
    await waitFor(() => changeEvents === 3, { label: 'sentinel after MCP unpublish' });
    assert.equal(releaseEvents, 2);

    // 6. Bot operations HTTP path (/api/host/operations/call) publish -> broadcasts client-release-published.
    res = await center.app.inject({
      method: 'POST',
      url: '/api/host/operations/call',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'x-device-id': deviceId,
      },
      payload: {
        botId,
        name: 'center_set_client_release_published',
        args: { releaseId: record.id, published: true },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().published, true);
    await waitFor(() => releaseEvents === 3, { label: 'Bot operations publish SSE event' });
  } finally {
    await sseClient?.close();
    await center.close();
  }

  // Backward compatibility: omitting onReleasePublished still succeeds cleanly.
  const centerWithoutCallback = await openListeningCenter({ wireOnReleasePublished: false });
  try {
    const rec = makeReleaseRecord('rel-no-cb', '2.0.0');
    centerWithoutCallback.store.createClientRelease(rec);
    const { cookie, csrfToken } = await centerWithoutCallback.login();
    const res = await centerWithoutCallback.app.inject({
      method: 'POST',
      url: `/api/client-releases/${rec.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { published: true },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().published, true);
  } finally {
    await centerWithoutCallback.close();
  }
});

test('connectCenter parses event: client-release-published across split chunks and mixed SSE frames', { timeout: 10_000 }, async () => {
  let sseRes = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/host/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseRes = res;
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  let changes = 0;
  let webhooks = 0;
  let tasks = 0;
  let releases = 0;

  const client = await connectCenter({
    centerUrl: `http://127.0.0.1:${port}`,
    deviceId: 'dev-sse-parser',
    deviceToken: randomBytes(32).toString('base64url'),
    onChange: () => { changes += 1; },
    onWebhookReady: () => { webhooks += 1; },
    onTaskReady: () => { tasks += 1; },
    onClientReleasePublished: () => { releases += 1; },
  });

  try {
    assert.ok(sseRes, 'SSE response stream should be established');

    // 1. Standard frame.
    sseRes.write('event: client-release-published\ndata: {}\n\n');
    await waitFor(() => releases === 1, { label: 'single release frame' });
    assert.deepEqual([changes, webhooks, tasks, releases], [0, 0, 0, 1]);

    // 2. Chunk-split frame across event name and CRLF boundary.
    sseRes.write('event: client-rele');
    await delay(20);
    assert.equal(releases, 1);
    sseRes.write('ase-published\r\ndata: {}\r');
    await delay(20);
    assert.equal(releases, 1);
    sseRes.write('\n\r\n');
    await waitFor(() => releases === 2, { label: 'chunk-split release frame' });

    // 3. Multiple frames coalesced into a single chunk.
    sseRes.write(
      'event: config-changed\ndata: {}\n\n'
      + 'event: webhook-ready\ndata: {}\n\n'
      + 'event: task-ready\ndata: {}\n\n'
      + 'event: client-release-published\ndata: {}\n\n',
    );
    await waitFor(() => releases === 3, { label: 'coalesced multi-event chunk' });
    assert.deepEqual([changes, webhooks, tasks, releases], [1, 1, 1, 3]);

    // 4. Non-matching event prefixes and data lines must not trigger onClientReleasePublished.
    sseRes.write(
      'event: client-release-published-extra\ndata: {}\n\n'
      + 'data: event: client-release-published\n\n'
      + 'event: heartbeat\ndata: {}\n\n'
      + 'event: config-changed\ndata: {}\n\n',
    );
    await waitFor(() => changes === 2, { label: 'sentinel after non-matching frames' });
    assert.equal(releases, 3);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('openDesktopClient emits lightweight center_event only when session is ready and generation matches', { timeout: 15_000 }, async () => {
  const mockA = await createMockCenterAndRelay('desktop-fence-a');
  const mockB = await createMockCenterAndRelay('desktop-fence-b');
  const clientDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-desktop-fence-data-'));
  const events = [];
  const desktop = openDesktopClient({
    dataRoot: clientDataRoot,
    persistCenterCredentials: false,
    onEvent: (event) => {
      events.push(event);
    },
  });

  try {
    // 1. Hold /api/host/connection so centerClient is assigned but centerState is still 'connecting'.
    const gateA = createDeferred();
    mockA.setConnectionGate(gateA);
    const connectA = desktop.request('center_connect', {
      url: mockA.centerUrl,
      deviceId: mockA.cred.deviceId,
      deviceToken: mockA.cred.token,
    });
    await waitFor(() => mockA.sseStreams.length === 1 && mockA.getConnectionRequests() === 1, {
      label: 'mockA connecting phase',
    });
    assert.equal((await desktop.request('center_status')).state, 'connecting');

    // Event during non-ready phase MUST be ignored.
    mockA.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    await delay(50);
    assert.equal(events.length, 0);

    // 2. Release gate -> centerState transitions to 'ready' -> event MUST emit exact lightweight frame.
    gateA.resolve();
    const readyA = await connectA;
    assert.equal(readyA.state, 'ready');
    assert.equal(events.length, 0);

    mockA.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    await waitFor(() => events.length === 1, { label: 'ready center_event on mockA' });
    assert.deepEqual(events[0], { type: 'center_event', event: 'client-release-published' });
    assert.deepEqual(Object.keys(events[0]).sort(), ['event', 'type']);

    // 3. Stale generation / disconnect fence: write racing with center_disconnect must be ignored.
    mockA.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    const disconnected = await desktop.request('center_disconnect', {});
    assert.equal(disconnected.state, 'disconnected');
    await delay(50);
    assert.equal(events.length, 1);

    // 4. Switch to new center generation (mockB): ignore while connecting, emit once ready.
    const gateB = createDeferred();
    mockB.setConnectionGate(gateB);
    const connectB = desktop.request('center_connect', {
      url: mockB.centerUrl,
      deviceId: mockB.cred.deviceId,
      deviceToken: mockB.cred.token,
    });
    await waitFor(() => mockB.sseStreams.length === 1 && mockB.getConnectionRequests() === 1, {
      label: 'mockB connecting phase',
    });
    mockB.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    await delay(50);
    assert.equal(events.length, 1);

    gateB.resolve();
    const readyB = await connectB;
    assert.equal(readyB.state, 'ready');

    mockB.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    await waitFor(() => events.length === 2, { label: 'ready center_event on mockB' });
    assert.deepEqual(events[1], { type: 'center_event', event: 'client-release-published' });

    // 5. Transient SSE drop -> automatic reconnect -> new stream emits, old stream is gone.
    mockB.setConnectionGate(null);
    mockB.sseStreams[0].destroy();
    await waitFor(
      () => mockB.sseStreams.length >= 2,
      { timeoutMs: 8000, label: 'mockB reconnected SSE stream' },
    );
    await waitFor(
      async () => (await desktop.request('center_status')).state === 'ready',
      { timeoutMs: 8000, intervalMs: 25, label: 'mockB reconnected ready state' },
    );
    mockB.sseStreams[mockB.sseStreams.length - 1].write('event: client-release-published\ndata: {}\n\n');
    await waitFor(() => events.length === 3, { label: 'reconnected center_event on mockB' });
    assert.deepEqual(events[2], { type: 'center_event', event: 'client-release-published' });
  } finally {
    await desktop.close();
    await mockA.close();
    await mockB.close();
    removeDirSafe(clientDataRoot);
  }
});

test('desktop-client-cli forwards center_event verbatim to stdout JSONL', { timeout: 15_000 }, async () => {
  const mock = await createMockCenterAndRelay('desktop-cli-push');
  const clientDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-cli-push-data-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  input.on('error', () => {});
  output.on('error', () => {});
  diagnostics.on('error', () => {});
  diagnostics.resume();
  const reader = attachJsonlReader(output);

  const cli = createDesktopClientCli({ input, output, diagnostics, exitOnClose: false });
  const runPromise = cli.run();

  try {
    input.write(JSON.stringify({ type: 'request', id: 'req-init', op: 'init', params: { dataRoot: clientDataRoot } }) + '\n');
    const initResp = await reader.waitForFrame((f) => f.type === 'response' && f.id === 'req-init', 'cli init response');
    assert.equal(initResp.ok, true);

    input.write(JSON.stringify({
      type: 'request',
      id: 'req-connect',
      op: 'center_connect',
      params: { url: mock.centerUrl, deviceId: mock.cred.deviceId, deviceToken: mock.cred.token },
    }) + '\n');
    const connResp = await reader.waitForFrame((f) => f.type === 'response' && f.id === 'req-connect', 'cli center_connect response');
    assert.equal(connResp.ok, true);
    assert.equal(connResp.result.state, 'ready');

    mock.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    const centerEvent = await reader.waitForFrame((f) => f.type === 'center_event', 'cli center_event frame');
    assert.deepEqual(centerEvent, { type: 'center_event', event: 'client-release-published' });
    assert.deepEqual(Object.keys(centerEvent).sort(), ['event', 'type']);

    // Main loop remains responsive after forwarding center_event.
    input.write(JSON.stringify({ type: 'request', id: 'req-status', op: 'center_status', params: {} }) + '\n');
    const statusResp = await reader.waitForFrame((f) => f.type === 'response' && f.id === 'req-status', 'cli center_status response');
    assert.equal(statusResp.ok, true);
    assert.equal(statusResp.result.state, 'ready');

    input.write(JSON.stringify({ type: 'request', id: 'req-close', op: 'close', params: {} }) + '\n');
    const closeResp = await reader.waitForFrame((f) => f.type === 'response' && f.id === 'req-close', 'cli close response');
    assert.equal(closeResp.ok, true);
    assert.deepEqual(closeResp.result, { closed: true });
    await runPromise;
  } finally {
    if (!input.destroyed) input.destroy();
    await runPromise.catch(() => {});
    if (!output.destroyed) output.destroy();
    if (!diagnostics.destroyed) diagnostics.destroy();
    await mock.close();
    removeDirSafe(clientDataRoot);
  }
});

test('android-runtime client mode forwards center_event to bounded stdout queue without blocking main loop', { timeout: 15_000 }, async () => {
  const mock = await createMockCenterAndRelay('android-cli-push');
  const clientDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-android-push-data-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  input.on('error', () => {});
  output.on('error', () => {});
  diagnostics.on('error', () => {});
  diagnostics.resume();
  const reader = attachJsonlReader(output);

  const bridge = createAndroidBridge({ input, output, diagnostics, exitOnClose: false });
  const runPromise = bridge.run();

  try {
    input.write(JSON.stringify({ type: 'init', protocol: 1, mode: 'client', dataRoot: clientDataRoot }) + '\n');
    const readyFrame = await reader.waitForFrame((f) => f.type === 'ready', 'android bridge ready frame');
    assert.equal(readyFrame.protocol, 1);
    assert.equal(readyFrame.url, null);

    input.write(JSON.stringify({
      type: 'call',
      id: 'call-connect',
      method: 'center_connect',
      params: { url: mock.centerUrl, deviceId: mock.cred.deviceId, deviceToken: mock.cred.token },
    }) + '\n');
    const connFrame = await reader.waitForFrame((f) => f.type === 'result' && f.id === 'call-connect', 'android center_connect result');
    assert.equal(connFrame.result.value.state, 'ready');

    mock.sseStreams[0].write('event: client-release-published\ndata: {}\n\n');
    const centerEvent = await reader.waitForFrame((f) => f.type === 'center_event', 'android center_event frame');
    assert.deepEqual(centerEvent, { type: 'center_event', event: 'client-release-published' });
    assert.deepEqual(Object.keys(centerEvent).sort(), ['event', 'type']);

    // Main loop stays responsive after forwarding center_event.
    input.write(JSON.stringify({
      type: 'call',
      id: 'call-status',
      method: 'center_status',
      params: {},
    }) + '\n');
    const statusFrame = await reader.waitForFrame((f) => f.type === 'result' && f.id === 'call-status', 'android center_status result');
    assert.equal(statusFrame.result.value.state, 'ready');

    input.write(JSON.stringify({ type: 'shutdown', id: 'cmd-shutdown' }) + '\n');
    const closedFrame = await reader.waitForFrame((f) => f.type === 'closed' && f.id === 'cmd-shutdown', 'android closed frame');
    assert.equal(closedFrame.id, 'cmd-shutdown');
    await runPromise;
  } finally {
    if (!input.destroyed) input.destroy();
    await runPromise.catch(() => {});
    if (!output.destroyed) output.destroy();
    if (!diagnostics.destroyed) diagnostics.destroy();
    await mock.close();
    removeDirSafe(clientDataRoot);
  }
});
