import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRelayRegistry } from '../../host-core/relay-registry.js';
import { openRelayServer } from '../../host-core/relay-server.js';
import { LIVE_EXTENSIONS_HEADER_WIRE } from '../../host-core/remote-live-protocol.js';
import {
  CLIPBOARD_CLOSE,
  CLIPBOARD_NONCE_BYTES,
  CLIPBOARD_NONCE_CHARS,
  CLIPBOARD_PROTOCOL_VERSION,
  CLIPBOARD_RATE_LIMIT_MAX,
  CLIPBOARD_ROLE,
  CLIPBOARD_SEALED_MAX_BYTES,
  CLIPBOARD_SEALED_MAX_CHARS,
  CLIPBOARD_SEALED_MIN_BYTES,
  CLIPBOARD_SEALED_MIN_CHARS,
  CLIPBOARD_UPGRADE_HEADER_WIRE,
  CLIPBOARD_UPGRADE_VALUE,
  MAX_CLIPBOARD_FRAME_BYTES,
  MAX_CLIPBOARD_GROUP_DEVICES,
  createClipboardRelay,
  readClipboardClientFrame,
  readClipboardServerFrame,
} from '../../host-core/clipboard-relay.js';

// ws is installed inside host-core; resolve from host-core/package.json.
const wsModule = createRequire(new URL('../../host-core/package.json', import.meta.url))('ws');
const WebSocket = wsModule.default ?? wsModule;

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function makeGroup() {
  return randomBytes(32).toString('hex');
}

function makeNonce() {
  return randomBytes(CLIPBOARD_NONCE_BYTES).toString('base64url');
}

function makeSealed(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function attachPeer(ws) {
  const messages = [];
  const waiters = [];
  let closedInfo = null;
  const closeWaiters = [];

  ws.on('message', (data, isBinary) => {
    const item = {
      data,
      isBinary,
      text: isBinary ? null : data.toString('utf8'),
    };
    if (waiters.length > 0) {
      waiters.shift().resolve(item);
    } else {
      messages.push(item);
    }
  });

  ws.on('close', (code, reason) => {
    closedInfo = { code, reason: reason ? reason.toString('utf8') : '' };
    while (waiters.length > 0) {
      waiters.shift().reject(new Error(`socket closed with ${code}`));
    }
    while (closeWaiters.length > 0) {
      closeWaiters.shift().resolve(closedInfo);
    }
  });

  ws.on('error', () => {
    // Errors on test sockets are observed via close or connect rejection.
  });

  return {
    ws,
    sendRaw(payload, options) {
      ws.send(payload, options);
    },
    sendJson(obj) {
      ws.send(JSON.stringify(obj));
    },
    nextMessage(timeoutMs = 3000) {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      if (closedInfo !== null) {
        return Promise.reject(new Error(`socket already closed with ${closedInfo.code}`));
      }
      return new Promise((resolve, reject) => {
        const entry = {
          resolve(val) {
            clearTimeout(timer);
            resolve(val);
          },
          reject(err) {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error('timed out waiting for WS message'));
        }, timeoutMs);
        waiters.push(entry);
      });
    },
    async nextJson(timeoutMs = 3000) {
      const msg = await this.nextMessage(timeoutMs);
      assert.equal(msg.isBinary, false);
      return JSON.parse(msg.text);
    },
    async expectNoMessage(waitMs = 150) {
      if (messages.length > 0) {
        assert.fail(`expected no message, but already received: ${messages[0].text}`);
      }
      if (closedInfo !== null) {
        assert.fail(`expected open socket with no message, but closed with ${closedInfo.code}`);
      }
      await new Promise((resolve, reject) => {
        const entry = {
          resolve(val) {
            clearTimeout(timer);
            reject(new Error(`expected no message, received: ${val.text}`));
          },
          reject(err) {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve();
        }, waitMs);
        waiters.push(entry);
      });
    },
    waitClose(timeoutMs = 3000) {
      if (closedInfo !== null) {
        return Promise.resolve(closedInfo);
      }
      return new Promise((resolve, reject) => {
        const entry = {
          resolve(val) {
            clearTimeout(timer);
            resolve(val);
          },
        };
        const timer = setTimeout(() => {
          const idx = closeWaiters.indexOf(entry);
          if (idx !== -1) closeWaiters.splice(idx, 1);
          reject(new Error('timed out waiting for WS close'));
        }, timeoutMs);
        closeWaiters.push(entry);
      });
    },
    close() {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    },
  };
}

function connectWs(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    let responseHeaders = null;
    const peer = attachPeer(ws);

    ws.once('upgrade', (res) => {
      responseHeaders = res.headers;
    });

    const cleanup = () => {
      ws.removeListener('open', onOpen);
      ws.removeListener('unexpected-response', onUnexpected);
      ws.removeListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve({ peer, responseHeaders });
    };
    const onUnexpected = (_req, res) => {
      cleanup();
      res.resume();
      const err = new Error(`Unexpected server response: ${res.statusCode}`);
      err.statusCode = res.statusCode;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    ws.once('open', onOpen);
    ws.once('unexpected-response', onUnexpected);
    ws.once('error', onError);
  });
}

async function expectUpgradeStatus(url, headers, expectedStatus) {
  await assert.rejects(
    connectWs(url, headers),
    (err) => Boolean(err && err.statusCode === expectedStatus),
  );
}

async function connectClipboard(url, { deviceId, token, clipboardGroup, extraHeaders = {} }) {
  const { peer, responseHeaders } = await connectWs(url, {
    [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
    ...extraHeaders,
  });
  peer.sendJson({
    type: 'hello',
    protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
    role: CLIPBOARD_ROLE,
    deviceId,
    token,
    clipboardGroup,
  });
  const ready = await peer.nextJson();
  assert.deepEqual(ready, {
    type: 'ready',
    protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
    role: CLIPBOARD_ROLE,
    deviceId,
  });
  return { peer, responseHeaders };
}

async function withRelay(fn, relayOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pibot-clipboard-relay-'));
  const registry = openRelayRegistry({ dataRoot: root });
  const relay = await openRelayServer({
    dataRoot: root,
    port: 0,
    listenHost: '127.0.0.1',
    ...relayOptions,
  });
  const tracked = [];
  const track = (peer) => {
    tracked.push(peer);
    return peer;
  };
  try {
    return await fn({ root, registry, relay, track });
  } finally {
    for (const peer of tracked) {
      peer.close();
    }
    await relay.close();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('upgrade gate enforces exact /v1/link path, no Origin, exact clipboard header, and isolates response headers', async () => {
  await withRelay(async ({ registry, relay, track }) => {
    const token = makeToken();
    const group = makeGroup();
    registry.register({ deviceId: 'dev-gate', token });

    // Origin / Sec-WebSocket-Origin rejected with 403 even with clipboard header.
    await expectUpgradeStatus(
      relay.url,
      {
        Origin: 'https://evil.example',
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      },
      403,
    );
    await expectUpgradeStatus(
      relay.url,
      {
        'Sec-WebSocket-Origin': 'https://evil.example',
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      },
      403,
    );

    // Non-exact path / query rejected with 404 even with clipboard header.
    await expectUpgradeStatus(
      `${relay.url}?v=1`,
      { [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE },
      404,
    );
    await expectUpgradeStatus(
      relay.url.replace('/v1/link', '/v1/clipboard'),
      { [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE },
      404,
    );

    // Invalid or duplicate X-PiBot-Clipboard-V1 fails closed with 400 (never falls through).
    await expectUpgradeStatus(relay.url, { [CLIPBOARD_UPGRADE_HEADER_WIRE]: '2' }, 400);
    await expectUpgradeStatus(relay.url, { [CLIPBOARD_UPGRADE_HEADER_WIRE]: '' }, 400);
    await expectUpgradeStatus(relay.url, { [CLIPBOARD_UPGRADE_HEADER_WIRE]: '1, 1' }, 400);
    await expectUpgradeStatus(relay.url, { [CLIPBOARD_UPGRADE_HEADER_WIRE]: ['1', '1'] }, 400);

    // Valid upgrade does not negotiate or echo legacy X-PiBot-Live-Extensions.
    const { peer, responseHeaders } = await connectClipboard(relay.url, {
      deviceId: 'dev-gate',
      token,
      clipboardGroup: group,
      extraHeaders: { [LIVE_EXTENSIONS_HEADER_WIRE]: 'durable-waits-v1,host-sources-v1' },
    });
    track(peer);
    assert.equal(responseHeaders['x-pibot-live-extensions'], undefined);
  });
});

test('exact hello authentication, strict field checks, and hello timeout', async () => {
  await withRelay(async ({ registry, relay, track }) => {
    const token = makeToken();
    const otherToken = makeToken();
    const revokedToken = makeToken();
    const group = makeGroup();
    registry.register({ deviceId: 'dev-auth', token });
    registry.register({ deviceId: 'dev-revoked', token: revokedToken });
    registry.revoke('dev-revoked');

    // Unknown deviceId -> 4401.
    {
      const { peer } = await connectWs(relay.url, {
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      });
      track(peer);
      peer.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'clipboard',
        deviceId: 'dev-missing',
        token,
        clipboardGroup: group,
      });
      assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.UNAUTHORIZED);
    }

    // Wrong token -> 4401.
    {
      const { peer } = await connectWs(relay.url, {
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      });
      track(peer);
      peer.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'clipboard',
        deviceId: 'dev-auth',
        token: otherToken,
        clipboardGroup: group,
      });
      assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.UNAUTHORIZED);
    }

    // Already-revoked device -> 4401.
    {
      const { peer } = await connectWs(relay.url, {
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      });
      track(peer);
      peer.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'clipboard',
        deviceId: 'dev-revoked',
        token: revokedToken,
        clipboardGroup: group,
      });
      assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.UNAUTHORIZED);
    }

    // Bad hello shapes -> 4400.
    const badHellos = [
      { type: 'hello', protocolVersion: 2, role: 'clipboard', deviceId: 'dev-auth', token, clipboardGroup: group },
      { type: 'hello', protocolVersion: 1, role: 'host', deviceId: 'dev-auth', token, clipboardGroup: group },
      { type: 'hello', protocolVersion: 1, role: 'client', deviceId: 'dev-auth', token, clipboardGroup: group },
      { type: 'hello', protocolVersion: 1, deviceId: 'dev-auth', token, clipboardGroup: group },
      { type: 'hello', protocolVersion: 1, role: 'clipboard', deviceId: 'dev-auth', token, clipboardGroup: group.toUpperCase() },
      { type: 'hello', protocolVersion: 1, role: 'clipboard', deviceId: 'dev-auth', token, clipboardGroup: group.slice(0, 63) },
      { type: 'hello', protocolVersion: 1, role: 'clipboard', deviceId: 'dev-auth', token, clipboardGroup: `${group}0` },
      { type: 'hello', protocolVersion: 1, role: 'clipboard', deviceId: 'dev-auth', token, clipboardGroup: group, displayName: 'ShouldNotCopy' },
      { type: 'hello', protocolVersion: 1, role: 'clipboard', deviceId: 'dev-auth', token, clipboardGroup: group, extra: true },
      { type: 'clipboard-put', nonce: makeNonce(), sealed: makeSealed(), sentAt: nowSec() },
    ];

    for (const payload of badHellos) {
      const { peer } = await connectWs(relay.url, {
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      });
      track(peer);
      peer.sendJson(payload);
      assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.BAD_FRAME);
    }

    // Metadata must not have been mutated by rejected hello.
    assert.equal(registry.get('dev-auth').displayName, null);

    // Binary frame before hello -> 4400.
    {
      const { peer } = await connectWs(relay.url, {
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      });
      track(peer);
      peer.sendRaw(Buffer.from('{"type":"hello"}'), { binary: true });
      assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.BAD_FRAME);
    }

    // Duplicate hello after auth -> 4400.
    {
      const { peer } = await connectClipboard(relay.url, {
        deviceId: 'dev-auth',
        token,
        clipboardGroup: group,
      });
      track(peer);
      peer.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'clipboard',
        deviceId: 'dev-auth',
        token,
        clipboardGroup: group,
      });
      assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.BAD_FRAME);
    }
  });

  // Hello deadline closes idle unauthenticated sockets with 4408.
  const root = mkdtempSync(join(tmpdir(), 'pibot-clipboard-hello-timeout-'));
  const registry = openRelayRegistry({ dataRoot: root });
  const clipboardRelay = createClipboardRelay({
    registry,
    helloTimeoutMs: 120,
    registryCheckMs: 500,
    heartbeatMs: 1000,
  });
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => clipboardRelay.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let peer = null;
  try {
    const { port } = server.address();
    ({ peer } = await connectWs(`ws://127.0.0.1:${port}/v1/link`, {
      [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
    }));
    const closed = await peer.waitClose(2000);
    assert.equal(closed.code, CLIPBOARD_CLOSE.HELLO_TIMEOUT);
  } finally {
    peer?.close();
    await clipboardRelay.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      server.closeAllConnections();
    });
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('group isolation, no sender echo, authenticated fromDeviceId, replacement (4409), and group capacity cap (16)', async () => {
  await withRelay(async ({ registry, relay, track }) => {
    const groupA = makeGroup();
    const groupB = makeGroup();

    const creds = new Map();
    for (const id of ['dev-a1', 'dev-a2', 'dev-a3', 'dev-b1']) {
      const token = makeToken();
      registry.register({ deviceId: id, token });
      creds.set(id, token);
    }

    const { peer: a1 } = await connectClipboard(relay.url, {
      deviceId: 'dev-a1',
      token: creds.get('dev-a1'),
      clipboardGroup: groupA,
    });
    const { peer: a2 } = await connectClipboard(relay.url, {
      deviceId: 'dev-a2',
      token: creds.get('dev-a2'),
      clipboardGroup: groupA,
    });
    const { peer: a3 } = await connectClipboard(relay.url, {
      deviceId: 'dev-a3',
      token: creds.get('dev-a3'),
      clipboardGroup: groupA,
    });
    const { peer: b1 } = await connectClipboard(relay.url, {
      deviceId: 'dev-b1',
      token: creds.get('dev-b1'),
      clipboardGroup: groupB,
    });
    track(a1);
    track(a2);
    track(a3);
    track(b1);

    const nonce = makeNonce();
    const sealed = makeSealed(64);
    const sentAt = nowSec();
    a1.sendJson({ type: 'clipboard-put', nonce, sealed, sentAt });

    const [evA2, evA3] = await Promise.all([a2.nextJson(), a3.nextJson()]);
    const expected = {
      type: 'clipboard-event',
      fromDeviceId: 'dev-a1',
      nonce,
      sealed,
      sentAt,
    };
    assert.deepEqual(evA2, expected);
    assert.deepEqual(evA3, expected);
    assert.deepEqual(readClipboardServerFrame(JSON.stringify(evA2)), expected);

    // No echo back to sender; no leak across group boundary.
    await Promise.all([a1.expectNoMessage(150), b1.expectNoMessage(150)]);

    // Replacing dev-a1 moves it cleanly to groupB and closes the old socket with 4409.
    const { peer: a1Replacement } = await connectClipboard(relay.url, {
      deviceId: 'dev-a1',
      token: creds.get('dev-a1'),
      clipboardGroup: groupB,
    });
    track(a1Replacement);
    assert.equal((await a1.waitClose()).code, CLIPBOARD_CLOSE.REPLACED);

    const nonce2 = makeNonce();
    const sealed2 = makeSealed(40);
    const sentAt2 = nowSec();
    a1Replacement.sendJson({ type: 'clipboard-put', nonce: nonce2, sealed: sealed2, sentAt: sentAt2 });

    const evB1 = await b1.nextJson();
    assert.deepEqual(evB1, {
      type: 'clipboard-event',
      fromDeviceId: 'dev-a1',
      nonce: nonce2,
      sealed: sealed2,
      sentAt: sentAt2,
    });
    await Promise.all([a2.expectNoMessage(150), a3.expectNoMessage(150), a1Replacement.expectNoMessage(150)]);

    // Group cap of MAX_CLIPBOARD_GROUP_DEVICES (16) blocks 17th distinct device,
    // while allowing same-device replacement inside the full group.
    const fullGroup = makeGroup();
    const fullPeers = [];
    const fullTokens = [];
    for (let i = 0; i < MAX_CLIPBOARD_GROUP_DEVICES; i += 1) {
      const id = `dev-cap-${i}`;
      const token = makeToken();
      registry.register({ deviceId: id, token });
      fullTokens.push({ id, token });
      const { peer } = await connectClipboard(relay.url, {
        deviceId: id,
        token,
        clipboardGroup: fullGroup,
      });
      track(peer);
      fullPeers.push(peer);
    }

    const extraToken = makeToken();
    registry.register({ deviceId: 'dev-cap-extra', token: extraToken });
    const { peer: extraPeer } = await connectWs(relay.url, {
      [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
    });
    track(extraPeer);
    extraPeer.sendJson({
      type: 'hello',
      protocolVersion: 1,
      role: 'clipboard',
      deviceId: 'dev-cap-extra',
      token: extraToken,
      clipboardGroup: fullGroup,
    });
    assert.equal((await extraPeer.waitClose()).code, CLIPBOARD_CLOSE.GROUP_FULL);

    // Same-device reconnect inside a full group replaces its own slot cleanly.
    const firstCred = fullTokens[0];
    const { peer: firstReplacement } = await connectClipboard(relay.url, {
      deviceId: firstCred.id,
      token: firstCred.token,
      clipboardGroup: fullGroup,
    });
    track(firstReplacement);
    assert.equal((await fullPeers[0].waitClose()).code, CLIPBOARD_CLOSE.REPLACED);
  });
});

test('old clients remain unaffected and clipboard sockets are strictly isolated from host, control, live, and scope routes', async () => {
  const disconnectedHosts = [];
  await withRelay(
    async ({ registry, relay, track }) => {
      const hostToken = makeToken();
      const clientToken = makeToken();
      const clipOnlyToken = makeToken();
      const group = makeGroup();
      registry.register({ deviceId: 'dev-host', token: hostToken });
      registry.register({ deviceId: 'dev-client', token: clientToken });
      registry.register({ deviceId: 'dev-clip-only', token: clipOnlyToken });

      // Legacy host connects on /v1/link without clipboard header.
      const { peer: legacyHost } = await connectWs(relay.url);
      track(legacyHost);
      legacyHost.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'host',
        controlProtocol: 2,
        scopeProtocol: 1,
        deviceId: 'dev-host',
        token: hostToken,
      });
      const hostReady = await legacyHost.nextJson();
      assert.deepEqual(hostReady, {
        type: 'ready',
        protocolVersion: 1,
        deviceId: 'dev-host',
        scopeProtocol: 1,
        controlProtocol: 2,
      });

      // Legacy client connects on /v1/link without clipboard header.
      const { peer: legacyClient } = await connectWs(relay.url);
      track(legacyClient);
      legacyClient.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'client',
        controlProtocol: 2,
        deviceId: 'dev-client',
        token: clientToken,
      });
      const clientReady = await legacyClient.nextJson();
      assert.deepEqual(clientReady, {
        type: 'ready',
        protocolVersion: 1,
        deviceId: 'dev-client',
        role: 'client',
        controlProtocol: 2,
      });

      // Same deviceId connects via clipboard header: must NOT replace legacy host.
      const { peer: hostClipboard } = await connectClipboard(relay.url, {
        deviceId: 'dev-host',
        token: hostToken,
        clipboardGroup: group,
      });
      track(hostClipboard);

      const { peer: clipOnly } = await connectClipboard(relay.url, {
        deviceId: 'dev-clip-only',
        token: clipOnlyToken,
        clipboardGroup: group,
      });
      track(clipOnly);

      assert.deepEqual(relay.getStatus().onlineDeviceIds, ['dev-host']);
      assert.deepEqual(disconnectedHosts, []);

      // Legacy client directory listing still sees dev-host online and dev-clip-only offline.
      legacyClient.sendJson({ type: 'devices-list', callId: 'list-1' });
      const listRes = await legacyClient.nextJson();
      assert.equal(listRes.type, 'devices-result');
      assert.equal(listRes.ok, true);
      const byId = new Map(listRes.items.map((item) => [item.deviceId, item]));
      assert.equal(byId.get('dev-host')?.online, true);
      assert.equal(byId.get('dev-clip-only')?.online, false);

      // Clipboard traffic flows without touching legacy host or legacy client.
      const nonce = makeNonce();
      const sealed = makeSealed(32);
      const sentAt = nowSec();
      hostClipboard.sendJson({ type: 'clipboard-put', nonce, sealed, sentAt });
      const clipEv = await clipOnly.nextJson();
      assert.equal(clipEv.fromDeviceId, 'dev-host');
      await Promise.all([legacyHost.expectNoMessage(150), legacyClient.expectNoMessage(150)]);

      // Closing clipboard connection for dev-host does not trigger onHostDisconnect or affect host.
      hostClipboard.close();
      await hostClipboard.waitClose();
      assert.deepEqual(relay.getStatus().onlineDeviceIds, ['dev-host']);
      assert.deepEqual(disconnectedHosts, []);

      // Clipboard socket cannot send legacy/RPC/live/directory/scope frames.
      const forbiddenFrames = [
        { type: 'devices-list', callId: 'c1' },
        { type: 'device-rename', callId: 'c2', deviceId: 'dev-host', displayName: 'pwn' },
        { type: 'control-call', callId: 'c3', targetDeviceId: 'dev-host', method: 'bots.list', input: {} },
        { type: 'live-open', watchId: 'w1', targetDeviceId: 'dev-host', target: { kind: 'primary', botId: 'b1' } },
        { type: 'deliver', targetDeviceId: 'dev-host', message: {} },
        { type: 'scope-offer', targetDeviceId: 'dev-host' },
      ];
      for (const frame of forbiddenFrames) {
        const { peer } = await connectClipboard(relay.url, {
          deviceId: 'dev-clip-only',
          token: clipOnlyToken,
          clipboardGroup: group,
        });
        track(peer);
        peer.sendJson(frame);
        assert.equal((await peer.waitClose()).code, CLIPBOARD_CLOSE.BAD_FRAME);
      }

      // Legacy socket without clipboard header cannot use role:"clipboard".
      const { peer: legacyWrongRole } = await connectWs(relay.url);
      track(legacyWrongRole);
      legacyWrongRole.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'clipboard',
        deviceId: 'dev-clip-only',
        token: clipOnlyToken,
        clipboardGroup: group,
      });
      assert.equal((await legacyWrongRole.waitClose()).code, CLIPBOARD_CLOSE.BAD_FRAME);

      // Legacy host and client are still alive and responsive.
      legacyClient.sendJson({ type: 'devices-list', callId: 'list-2' });
      const listRes2 = await legacyClient.nextJson();
      assert.equal(listRes2.type, 'devices-result');
      assert.equal(listRes2.callId, 'list-2');
      assert.equal(listRes2.ok, true);
    },
    { onHostDisconnect: (id) => disconnectedHosts.push(id) },
  );
});

test('revoke and rotate are enforced both ways immediately and via periodic cadence', async () => {
  await withRelay(async ({ registry, relay, track }) => {
    const group = makeGroup();
    const tSender = makeToken();
    const tSender2 = makeToken();
    const tRecvRevoked = makeToken();
    const tRecvRotated = makeToken();
    const tRecvRotatedNew = makeToken();
    const tRecvHealthy = makeToken();
    const tIdle = makeToken();

    registry.register({ deviceId: 'dev-sender', token: tSender });
    registry.register({ deviceId: 'dev-recv-revoked', token: tRecvRevoked });
    registry.register({ deviceId: 'dev-recv-rotated', token: tRecvRotated });
    registry.register({ deviceId: 'dev-recv-healthy', token: tRecvHealthy });
    registry.register({ deviceId: 'dev-idle', token: tIdle });

    const { peer: sender } = await connectClipboard(relay.url, {
      deviceId: 'dev-sender',
      token: tSender,
      clipboardGroup: group,
    });
    const { peer: recvRevoked } = await connectClipboard(relay.url, {
      deviceId: 'dev-recv-revoked',
      token: tRecvRevoked,
      clipboardGroup: group,
    });
    const { peer: recvRotated } = await connectClipboard(relay.url, {
      deviceId: 'dev-recv-rotated',
      token: tRecvRotated,
      clipboardGroup: group,
    });
    const { peer: recvHealthy } = await connectClipboard(relay.url, {
      deviceId: 'dev-recv-healthy',
      token: tRecvHealthy,
      clipboardGroup: group,
    });
    const { peer: idlePeer } = await connectClipboard(relay.url, {
      deviceId: 'dev-idle',
      token: tIdle,
      clipboardGroup: makeGroup(),
    });
    track(sender);
    track(recvRevoked);
    track(recvRotated);
    track(recvHealthy);
    track(idlePeer);

    // Revoke one receiver and rotate another BEFORE sending: neither receives the event,
    // both are kicked immediately with 4403, and the healthy receiver still receives it.
    registry.revoke('dev-recv-revoked');
    registry.rotate({ deviceId: 'dev-recv-rotated', token: tRecvRotatedNew });

    const nonce1 = makeNonce();
    const sealed1 = makeSealed(48);
    const sentAt1 = nowSec();
    sender.sendJson({ type: 'clipboard-put', nonce: nonce1, sealed: sealed1, sentAt: sentAt1 });

    const [healthyEv, revokedClose, rotatedClose] = await Promise.all([
      recvHealthy.nextJson(),
      recvRevoked.waitClose(),
      recvRotated.waitClose(),
    ]);
    assert.deepEqual(healthyEv, {
      type: 'clipboard-event',
      fromDeviceId: 'dev-sender',
      nonce: nonce1,
      sealed: sealed1,
      sentAt: sentAt1,
    });
    assert.equal(revokedClose.code, CLIPBOARD_CLOSE.REVOKED);
    assert.equal(rotatedClose.code, CLIPBOARD_CLOSE.REVOKED);

    // Rotated device cannot reconnect with old token (4401), succeeds with new token.
    {
      const { peer: oldTry } = await connectWs(relay.url, {
        [CLIPBOARD_UPGRADE_HEADER_WIRE]: CLIPBOARD_UPGRADE_VALUE,
      });
      track(oldTry);
      oldTry.sendJson({
        type: 'hello',
        protocolVersion: 1,
        role: 'clipboard',
        deviceId: 'dev-recv-rotated',
        token: tRecvRotated,
        clipboardGroup: group,
      });
      assert.equal((await oldTry.waitClose()).code, CLIPBOARD_CLOSE.UNAUTHORIZED);
    }
    const { peer: recvRotatedFresh } = await connectClipboard(relay.url, {
      deviceId: 'dev-recv-rotated',
      token: tRecvRotatedNew,
      clipboardGroup: group,
    });
    track(recvRotatedFresh);

    // Rotate sender: sender's next clipboard-put closes sender with 4403 and routes nothing.
    registry.rotate({ deviceId: 'dev-sender', token: tSender2 });
    sender.sendJson({
      type: 'clipboard-put',
      nonce: makeNonce(),
      sealed: makeSealed(32),
      sentAt: nowSec(),
    });
    assert.equal((await sender.waitClose()).code, CLIPBOARD_CLOSE.REVOKED);
    await Promise.all([
      recvHealthy.expectNoMessage(150),
      recvRotatedFresh.expectNoMessage(150),
    ]);

    // Idle revoked socket is kicked on the ~1s registry scan cadence without sending frames.
    registry.revoke('dev-idle');
    assert.equal((await idlePeer.waitClose(3000)).code, CLIPBOARD_CLOSE.REVOKED);
  });
});

test('no offline backlog or replay on new or reconnecting devices', async () => {
  await withRelay(async ({ registry, relay, track }) => {
    const group = makeGroup();
    const t1 = makeToken();
    const t2 = makeToken();
    registry.register({ deviceId: 'dev-1', token: t1 });
    registry.register({ deviceId: 'dev-2', token: t2 });

    const { peer: p1 } = await connectClipboard(relay.url, {
      deviceId: 'dev-1',
      token: t1,
      clipboardGroup: group,
    });
    track(p1);

    // Send while no other peer is online.
    p1.sendJson({
      type: 'clipboard-put',
      nonce: makeNonce(),
      sealed: makeSealed(40),
      sentAt: nowSec(),
    });

    // dev-2 joins after the put: must NOT receive any historical event.
    const { peer: p2First } = await connectClipboard(relay.url, {
      deviceId: 'dev-2',
      token: t2,
      clipboardGroup: group,
    });
    track(p2First);
    await p2First.expectNoMessage(150);

    // dev-2 disconnects; dev-1 sends another put; dev-2 reconnects: still no replay.
    p2First.close();
    await p2First.waitClose();

    p1.sendJson({
      type: 'clipboard-put',
      nonce: makeNonce(),
      sealed: makeSealed(40),
      sentAt: nowSec(),
    });

    const { peer: p2Second } = await connectClipboard(relay.url, {
      deviceId: 'dev-2',
      token: t2,
      clipboardGroup: group,
    });
    track(p2Second);
    await p2Second.expectNoMessage(150);

    // Fresh put while both are online delivers only the fresh event.
    const freshNonce = makeNonce();
    const freshSealed = makeSealed(44);
    const freshSentAt = nowSec();
    p1.sendJson({
      type: 'clipboard-put',
      nonce: freshNonce,
      sealed: freshSealed,
      sentAt: freshSentAt,
    });
    const received = await p2Second.nextJson();
    assert.deepEqual(received, {
      type: 'clipboard-event',
      fromDeviceId: 'dev-1',
      nonce: freshNonce,
      sealed: freshSealed,
      sentAt: freshSentAt,
    });
  });
});

test('strict frame and field boundaries, 96 KiB WS cap, and small rate limit', async () => {
  await withRelay(async ({ registry, relay, track }) => {
    const group = makeGroup();
    const tSend = makeToken();
    const tRecv = makeToken();
    registry.register({ deviceId: 'dev-bounds-send', token: tSend });
    registry.register({ deviceId: 'dev-bounds-recv', token: tRecv });

    const { peer: recv } = await connectClipboard(relay.url, {
      deviceId: 'dev-bounds-recv',
      token: tRecv,
      clipboardGroup: group,
    });
    track(recv);

    // Minimum valid sealed (17 bytes / 23 chars) and maximum valid sealed (65552 bytes / 87403 chars).
    const minSealed = makeSealed(CLIPBOARD_SEALED_MIN_BYTES);
    const maxSealed = makeSealed(CLIPBOARD_SEALED_MAX_BYTES);
    assert.equal(minSealed.length, CLIPBOARD_SEALED_MIN_CHARS);
    assert.equal(maxSealed.length, CLIPBOARD_SEALED_MAX_CHARS);

    const { peer: sender } = await connectClipboard(relay.url, {
      deviceId: 'dev-bounds-send',
      token: tSend,
      clipboardGroup: group,
    });
    track(sender);

    const minNonce = makeNonce();
    assert.equal(minNonce.length, CLIPBOARD_NONCE_CHARS);
    const tsMin = nowSec();
    sender.sendJson({ type: 'clipboard-put', nonce: minNonce, sealed: minSealed, sentAt: tsMin });
    const evMin = await recv.nextJson();
    assert.deepEqual(evMin, {
      type: 'clipboard-event',
      fromDeviceId: 'dev-bounds-send',
      nonce: minNonce,
      sealed: minSealed,
      sentAt: tsMin,
    });

    const maxNonce = makeNonce();
    const tsMax = nowSec();
    sender.sendJson({ type: 'clipboard-put', nonce: maxNonce, sealed: maxSealed, sentAt: tsMax });
    const evMax = await recv.nextJson();
    assert.deepEqual(evMax, {
      type: 'clipboard-event',
      fromDeviceId: 'dev-bounds-send',
      nonce: maxNonce,
      sealed: maxSealed,
      sentAt: tsMax,
    });

    // Exact 96 KiB (98304 bytes) valid JSON frame passes.
    const exactBase = JSON.stringify({
      type: 'clipboard-put',
      nonce: makeNonce(),
      sealed: minSealed,
      sentAt: nowSec(),
    });
    const exact96k = exactBase + ' '.repeat(MAX_CLIPBOARD_FRAME_BYTES - Buffer.byteLength(exactBase, 'utf8'));
    assert.equal(Buffer.byteLength(exact96k, 'utf8'), MAX_CLIPBOARD_FRAME_BYTES);
    sender.sendRaw(exact96k);
    const ev96k = await recv.nextJson();
    assert.equal(ev96k.sealed, minSealed);

    // 96 KiB + 1 byte (98305 bytes) exceeds maxPayload and closes with 1009 without delivery.
    const over96k = `${exact96k} `;
    assert.equal(Buffer.byteLength(over96k, 'utf8'), MAX_CLIPBOARD_FRAME_BYTES + 1);
    sender.sendRaw(over96k);
    assert.equal((await sender.waitClose()).code, CLIPBOARD_CLOSE.FRAME_TOO_LARGE);
    await recv.expectNoMessage(150);

    // Invalid clipboard-put frames close with 4400 and never deliver.
    const validNonce = makeNonce();
    const validSealed = makeSealed(24);
    const badPuts = [
      // nonce boundaries & encoding
      { type: 'clipboard-put', nonce: makeSealed(23), sealed: validSealed, sentAt: nowSec() },
      { type: 'clipboard-put', nonce: makeSealed(25), sealed: validSealed, sentAt: nowSec() },
      { type: 'clipboard-put', nonce: `${validNonce.slice(0, 31)}=`, sealed: validSealed, sentAt: nowSec() },
      { type: 'clipboard-put', nonce: `${validNonce.slice(0, 31)}+`, sealed: validSealed, sentAt: nowSec() },
      // sealed boundaries & encoding
      { type: 'clipboard-put', nonce: validNonce, sealed: makeSealed(CLIPBOARD_SEALED_MIN_BYTES - 1), sentAt: nowSec() },
      { type: 'clipboard-put', nonce: validNonce, sealed: makeSealed(CLIPBOARD_SEALED_MAX_BYTES + 1), sentAt: nowSec() },
      { type: 'clipboard-put', nonce: validNonce, sealed: `${validSealed.slice(0, 23)}=`, sentAt: nowSec() },
      { type: 'clipboard-put', nonce: validNonce, sealed: `${validSealed.slice(0, 23)}/`, sentAt: nowSec() },
      { type: 'clipboard-put', nonce: validNonce, sealed: 'A'.repeat(25), sentAt: nowSec() }, // len % 4 === 1
      { type: 'clipboard-put', nonce: validNonce, sealed: `${'A'.repeat(22)}B`, sentAt: nowSec() }, // non-canonical trailing bits (rem 3)
      { type: 'clipboard-put', nonce: validNonce, sealed: `${'A'.repeat(25)}B`, sentAt: nowSec() }, // non-canonical trailing bits (rem 2)
      // sentAt bounds & type
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: 0 },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: -10 },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: 1.5 },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: String(nowSec()) },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: Number.MAX_SAFE_INTEGER + 1 },
      // forbidden extra / targeting fields
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: nowSec(), targetDeviceId: 'dev-bounds-recv' },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: nowSec(), targets: ['dev-bounds-recv'] },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: nowSec(), fromDeviceId: 'spoofed' },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: nowSec(), clipboardGroup: group },
      { type: 'clipboard-put', nonce: validNonce, sealed: validSealed, sentAt: nowSec(), plaintext: 'never' },
    ];

    for (const bad of badPuts) {
      assert.throws(() => readClipboardClientFrame(JSON.stringify(bad)), { code: 'INVALID_ARGUMENT' });
      const { peer: badSender } = await connectClipboard(relay.url, {
        deviceId: 'dev-bounds-send',
        token: tSend,
        clipboardGroup: group,
      });
      track(badSender);
      badSender.sendJson(bad);
      assert.equal((await badSender.waitClose()).code, CLIPBOARD_CLOSE.BAD_FRAME);
    }
    await recv.expectNoMessage(150);

    // Rate limit drops excess updates without disconnecting the sender.
    const tFlood = makeToken();
    registry.register({ deviceId: 'dev-flood', token: tFlood });
    const { peer: flooder } = await connectClipboard(relay.url, {
      deviceId: 'dev-flood',
      token: tFlood,
      clipboardGroup: group,
    });
    track(flooder);

    for (let i = 0; i < CLIPBOARD_RATE_LIMIT_MAX; i += 1) {
      flooder.sendJson({
        type: 'clipboard-put',
        nonce: makeNonce(),
        sealed: validSealed,
        sentAt: nowSec(),
      });
      const ev = await recv.nextJson();
      assert.equal(ev.fromDeviceId, 'dev-flood');
    }

    flooder.sendJson({
      type: 'clipboard-put',
      nonce: makeNonce(),
      sealed: validSealed,
      sentAt: nowSec(),
    });
    await recv.expectNoMessage(150);
    recv.sendJson({ type: 'clipboard-put', nonce: makeNonce(), sealed: validSealed, sentAt: nowSec() });
    assert.equal((await flooder.nextJson()).fromDeviceId, 'dev-bounds-recv');
  });
});

test('shared httpServer mode (Center reverse-proxy topology) routes clipboard upgrades cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-clipboard-shared-http-'));
  const registry = openRelayRegistry({ dataRoot: root });
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('center-ok');
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const relay = await openRelayServer({ dataRoot: root, httpServer });
  const tracked = [];
  try {
    const { port } = httpServer.address();
    const url = `ws://127.0.0.1:${port}/v1/link`;
    const group = makeGroup();
    const t1 = makeToken();
    const t2 = makeToken();
    registry.register({ deviceId: 'center-dev-1', token: t1 });
    registry.register({ deviceId: 'center-dev-2', token: t2 });

    const { peer: p1 } = await connectClipboard(url, {
      deviceId: 'center-dev-1',
      token: t1,
      clipboardGroup: group,
    });
    const { peer: p2 } = await connectClipboard(url, {
      deviceId: 'center-dev-2',
      token: t2,
      clipboardGroup: group,
    });
    tracked.push(p1, p2);

    const nonce = makeNonce();
    const sealed = makeSealed(32);
    const sentAt = nowSec();
    p1.sendJson({ type: 'clipboard-put', nonce, sealed, sentAt });
    const ev = await p2.nextJson();
    assert.deepEqual(ev, {
      type: 'clipboard-event',
      fromDeviceId: 'center-dev-1',
      nonce,
      sealed,
      sentAt,
    });
    await p1.expectNoMessage(150);
  } finally {
    for (const p of tracked) p.close();
    await relay.close();
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
    });
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
