import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerRoutes } from '../../center-server/routes.js';

// Fastify 只安装在 center-server 包内，按该包解析。
const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const PASSWORD = 'owner-password-for-tests';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(value => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

async function openCenter() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-devices-test-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(7) });
  const bridge = openHostBridge({ dataRoot, store, linkUrl: 'wss://127.0.0.1:1', relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify({ logger: false });
  // 与 server.js 相同的错误码到状态映射（测试所需子集）。
  const status = { INVALID_ARGUMENT: 400, VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, CSRF_INVALID: 403 };
  app.setErrorHandler((error, req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 400 && !status[code]) code = 'INVALID_ARGUMENT';
    if (!status[code]) code = 'INTERNAL_ERROR';
    reply.code(status[code] || 500).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  const routes = registerRoutes(app, { store, packages: {}, bridge, execution: {}, oauth: {}, linkUrl: 'wss://127.0.0.1:1', turns: {} });
  await app.ready();
  return {
    app, bridge,
    async login() {
      let res = await app.inject({ method: 'GET', url: '/api/session' });
      let cookie = cookieOf(res);
      res = await app.inject({ method: 'POST', url: '/api/session', headers: { cookie, 'x-csrf-token': res.json().csrfToken }, payload: { password: PASSWORD } });
      assert.equal(res.statusCode, 200);
      cookie = cookieOf(res, cookie);
      res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      assert.equal(res.json().authenticated, true);
      return { cookie: cookieOf(res, cookie), csrfToken: res.json().csrfToken };
    },
    async close() {
      routes.close();
      await app.close();
      bridge.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('owner POST /api/devices registers a device that can authenticate with the returned token', async () => {
  const center = await openCenter();
  try {
    const { cookie, csrfToken } = await center.login();
    const res = await center.app.inject({
      method: 'POST', url: '/api/devices',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { displayName: '  my-pc  ', platform: 'windows' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'deviceToken', 'displayName', 'platform']);
    assert.match(body.deviceId, UUID_RE);
    assert.match(body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.displayName, 'my-pc');
    assert.equal(body.platform, 'windows');

    const identity = center.bridge.registry.authenticate(body.deviceId, body.deviceToken);
    assert.ok(identity);
    assert.equal(identity.displayName, 'my-pc');
    assert.equal(identity.platform, 'windows');
    assert.equal(center.bridge.registry.authenticate(body.deviceId, randomBytes(32).toString('base64url')), null);

    const list = await center.app.inject({ method: 'GET', url: '/api/devices', headers: { cookie } });
    assert.deepEqual(list.json().find(device => device.deviceId === body.deviceId), { deviceId: body.deviceId, name: 'my-pc', online: false });

    const second = await center.app.inject({
      method: 'POST', url: '/api/devices',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { displayName: 'my-pc', platform: 'linux' },
    });
    assert.equal(second.statusCode, 201);
    assert.notEqual(second.json().deviceId, body.deviceId);
    assert.notEqual(second.json().deviceToken, body.deviceToken);
  } finally {
    await center.close();
  }
});

test('POST /api/devices rejects requests without an owner session or CSRF token', async () => {
  const center = await openCenter();
  try {
    const before = center.bridge.registry.list().length;
    const anonymous = await center.app.inject({ method: 'POST', url: '/api/devices', payload: { displayName: 'pc', platform: 'linux' } });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, 'UNAUTHENTICATED');

    const { cookie } = await center.login();
    const noCsrf = await center.app.inject({ method: 'POST', url: '/api/devices', headers: { cookie }, payload: { displayName: 'pc', platform: 'linux' } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(center.bridge.registry.list().length, before);
  } finally {
    await center.close();
  }
});

test('POST /api/devices rejects invalid bodies without registering anything', async () => {
  const center = await openCenter();
  try {
    const { cookie, csrfToken } = await center.login();
    const before = center.bridge.registry.list().length;
    for (const payload of [
      {},
      { displayName: 'pc' },
      { platform: 'linux' },
      { displayName: '   ', platform: 'linux' },
      { displayName: 'x'.repeat(65), platform: 'linux' },
      { displayName: 42, platform: 'linux' },
      { displayName: 'pc', platform: 'ios' },
      { displayName: 'pc', platform: 'Windows' },
      { displayName: 'pc', platform: 'linux', deviceId: 'invalid device id' },
      [],
    ]) {
      const res = await center.app.inject({ method: 'POST', url: '/api/devices', headers: { cookie, 'x-csrf-token': csrfToken }, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.code, 'INVALID_ARGUMENT');
    }
    assert.equal(center.bridge.registry.list().length, before);
    const deviceId = 'chosen-by-client';
    const ok = await center.app.inject({
      method: 'POST', url: '/api/devices',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { displayName: 'x'.repeat(64), platform: 'macos', deviceId },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().deviceId, deviceId);
    assert.match(ok.json().deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(center.bridge.registry.list().length, before + 1);
  } finally {
    await center.close();
  }
});
