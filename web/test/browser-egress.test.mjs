import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserEgressHost } from '../../host-core/bot-browser/egress-host.js';
import { openRelayRegistry } from '../../host-core/relay-registry.js';
import { openRelayServer } from '../../host-core/relay-server.js';
import { openRemoteControl } from '../../host-core/remote-control-client.js';
import { readServerFrame } from '../../host-core/relay-protocol.js';

const wsModule = createRequire(new URL('../../host-core/package.json', import.meta.url))('ws');
const WebSocket = wsModule.default ?? wsModule;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pibot-browser-egress-'));
  const credentials = ['egress-host', 'egress-viewer', 'egress-other-viewer'].map((deviceId) => ({
    deviceId, token: randomBytes(24).toString('base64url'),
  }));
  const calls = [];
  const siteRequests = [];
  const siteSockets = new Set();
  let privateRequests = 0;
  let allowed = true;
  let relay, hostSocket, receiver, remote, otherRemote;
  const site = createServer(async (req, res) => {
    if (req.url === '/hold') { res.writeHead(200); res.write('waiting'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    siteRequests.push({ path: req.url, body, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('response:');
    res.end(body || 'ok');
  });
  site.on('connection', (socket) => { siteSockets.add(socket); socket.on('close', () => siteSockets.delete(socket)); });
  const privateControl = createServer((_req, res) => { privateRequests += 1; res.end('must never be reached'); });
  t.after(async () => {
    remote?.close(); otherRemote?.close(); receiver?.reset(); hostSocket?.terminate();
    for (const socket of siteSockets) socket.destroy();
    site.closeAllConnections(); privateControl.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => site.close(resolve)),
      new Promise((resolve) => privateControl.close(resolve)),
      relay?.close(),
    ]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await Promise.all([
    new Promise((resolve) => site.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => privateControl.listen(0, '127.0.0.1', resolve)),
  ]);
  const sitePort = site.address().port;
  const privatePort = privateControl.address().port;
  const registry = openRelayRegistry({ dataRoot: root });
  try { for (const credential of credentials) registry.register(credential); } finally { registry.close(); }
  relay = await openRelayServer({ dataRoot: root, port: 0 });
  hostSocket = new WebSocket(relay.url, { headers: { 'X-PiBot-Browser-Egress': '1' } });
  receiver = createBrowserEgressHost({
    deviceId: credentials[0].deviceId,
    controlUrl: `http://127.0.0.1:${privatePort}`,
    execute: async (deviceId, method, params, options) => {
      calls.push({ deviceId, method, params, caller: options.caller });
      return {
        allowed: allowed && params.botId === 'bot-egress' && params.rendererId === 'renderer-egress' &&
          options.caller.fromDeviceId === credentials[1].deviceId,
        // Deliberately include the private port: the adapter's mandatory deny
        // must take precedence over even an overly permissive renderer grant.
        allowedPorts: [sitePort, privatePort],
      };
    },
    send: (frame) => {
      if (hostSocket.readyState !== WebSocket.OPEN) return false;
      hostSocket.send(JSON.stringify(frame)); return true;
    },
  });
  const ready = new Promise((resolve, reject) => {
    hostSocket.on('error', reject);
    hostSocket.on('message', (data, binary) => {
      try {
        const frame = readServerFrame(data, binary);
        if (frame.type === 'ready') resolve();
        else if (frame.type === 'browser-egress') receiver.handle(frame);
      } catch (error) { reject(error); }
    });
  });
  await once(hostSocket, 'open');
  hostSocket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, role: 'host', controlProtocol: 2, ...credentials[0] }));
  await ready;
  remote = await openRemoteControl({ url: relay.url, ...credentials[1] });
  otherRemote = await openRemoteControl({ url: relay.url, ...credentials[2] });
  const openProxy = (client = remote, rendererId = 'renderer-egress') => client.openBrowserEgress({
    targetDeviceId: credentials[0].deviceId, botId: 'bot-egress', rendererId,
  });
  const proxy = await openProxy();
  return {
    proxy, openProxy, remote, otherRemote, receiver, calls, siteRequests, siteSockets,
    sitePort, privatePort, privateRequests: () => privateRequests,
    deny: () => { allowed = false; },
  };
}

function throughProxy(proxy, url, chunks = []) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.proxyUrl);
    const req = request({
      host: proxyUrl.hostname, port: proxyUrl.port, path: url,
      method: chunks.length ? 'POST' : 'GET', agent: false,
      headers: { host: new URL(url).host, ...(chunks.length ? { 'transfer-encoding': 'chunked' } : {}) },
    }, (res) => {
      const received = [];
      res.on('data', (chunk) => received.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(received).toString() }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Proxy request deadline')));
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

function openConnect(proxy, port) {
  const proxyUrl = new URL(proxy.proxyUrl);
  const socket = connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  socket.setTimeout(5000, () => socket.destroy(new Error('CONNECT deadline')));
  return new Promise((resolve, reject) => {
    let response = '';
    socket.on('error', reject);
    const onData = (chunk) => {
      response += chunk.toString();
      if (!response.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      if (!response.startsWith('HTTP/1.1 200 ')) return reject(new Error('CONNECT denied'));
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('connect', () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
  });
}

test('browser egress: real Center carries chunked HTTP bodies with bounded multi-frame transfer', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const chunks = ['a'.repeat(70000), '中文'.repeat(20000), 'tail'];
  const reply = await throughProxy(f.proxy, `http://127.0.0.1:${f.sitePort}/echo`, chunks);
  assert.equal(reply.status, 200);
  assert.equal(reply.body, `response:${chunks.join('')}`);
  assert.equal(f.siteRequests[0].body, chunks.join(''));
  assert.equal(f.siteRequests[0].headers['transfer-encoding'], 'chunked');
  assert.deepEqual(f.calls[0].caller, { transport: 'relay', clientId: 'relay:egress-viewer', fromDeviceId: 'egress-viewer' });
  assert.equal(f.calls[0].method, 'browserControl');
  assert.equal(f.calls[0].params.action, 'rendererEgressAuthorize');
});

test('browser egress: CONNECT carries opaque request and response bytes through Center', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const socket = await openConnect(f.proxy, f.sitePort);
  t.after(() => socket.destroy());
  const response = [];
  socket.on('data', (chunk) => response.push(chunk));
  const ended = once(socket, 'end');
  socket.write(`GET /inside-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${f.sitePort}\r\nConnection: close\r\n\r\n`);
  await ended;
  assert.match(Buffer.concat(response).toString(), /^HTTP\/1\.1 200 /);
  assert.match(Buffer.concat(response).toString(), /response:/);
  assert.equal(f.siteRequests[0].path, '/inside-tunnel');
});

test('browser egress: private control port stays blocked even with a renderer port grant', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const reply = await throughProxy(f.proxy, `http://127.0.0.1:${f.privatePort}/`);
  assert.equal(reply.status, 502);
  assert.equal(f.privateRequests(), 0);
  assert.equal(f.calls.length, 1);
});

test('browser egress: missing or foreign renderer grant cannot reach the website', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const foreign = await f.openProxy(f.otherRemote);
  assert.equal((await throughProxy(foreign, `http://127.0.0.1:${f.sitePort}/`)).status, 502);
  const unregistered = await f.openProxy(f.remote, 'renderer-unregistered');
  assert.equal((await throughProxy(unregistered, `http://127.0.0.1:${f.sitePort}/`)).status, 502);
  f.deny();
  assert.equal((await throughProxy(f.proxy, `http://127.0.0.1:${f.sitePort}/`)).status, 502);
  assert.equal(f.siteRequests.length, 0);
  assert.equal(f.siteSockets.size, 0);
});

test('browser egress: Host reset closes live tunnels and client shutdown removes proxy listener', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const socket = await openConnect(f.proxy, f.sitePort);
  t.after(() => socket.destroy());
  const gotResponse = once(socket, 'data');
  socket.write(`GET /hold HTTP/1.1\r\nHost: 127.0.0.1:${f.sitePort}\r\n\r\n`);
  await gotResponse;
  const closed = once(socket, 'close');
  const hostSocketsClosed = [...f.siteSockets].map((peer) => once(peer, 'close'));
  f.receiver.reset();
  await closed;
  await Promise.all(hostSocketsClosed);
  assert.equal(f.siteSockets.size, 0);
  f.remote.close();
  await assert.rejects(throughProxy(f.proxy, `http://127.0.0.1:${f.sitePort}/`));
  await assert.rejects(f.openProxy(), /unavailable/);
});
