import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerRoutes } from '../../center-server/routes.js';
import { PAIRING_CODE_PREFIX } from '../../center-server/pairing.js';
import { errorStatus } from '../../center-server/server.js';

// Fastify 只安装在 center-server 包内，按该包解析。
const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const PASSWORD = 'owner-password-for-tests';
const PUBLIC_URL = 'https://center.test';
const KEY = new Uint8Array(32).fill(7);
const ENCRYPTION_KEY = KEY;

const CA_PEM = `-----BEGIN CERTIFICATE-----
MIICZDCCAgqgAwIBAgIJAIlTHzaomwuWMAoGCCqGSM49BAMCMDIxGzAZBgNVBAMM
ElBpQm90IFRlc3QgUm9vdCBDQTETMBEGA1UECgwKUGlCb3QgVGVzdDAgFw0yNjEx
MTExMjMxMTJaGA8yMTI2MTAxODEyMzExMlowMjEbMBkGA1UEAwwSUGlCb3QgVGVz
dCBSb290IENBMRMwEQYDVQQKDApQaUJvdCBUZXN0MIIBSzCCAQMGByqGSM49AgEw
gfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA////////////
////MFsEIP////8AAAABAAAAAAAAAAAAAAAA///////////////8BCBaxjXYqjqT
57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36Q
BEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8
D54WK84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA//////////+85vqtpxeehPO5
ysL8YyVRAgEBA0IABJEOHPH32lp97x5e+7WKdTveByx6uftlSS2kQ6hVkv80H2FD
/HtfrWBN6HGLxBrOYEUYMBeRNCRGwtSXHemBsBOjEzARMA8GA1UdEwEB/wQFMAMB
Af8wCgYIKoZIzj0EAwIDSAAwRQIgByHmlR4FZ6GNLhnwCfQu28guTFLpzVPkMQQO
CZDegVcCIQCAH65vrwLOS3d7Fua69qTNAh+pdz5FWvezQAZhIA4d/g==
-----END CERTIFICATE-----
`;

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(value => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

/** The real error-code to HTTP-status map, so a code missing from it fails here instead of passing against a copy. */
const STATUS = errorStatus;

async function openCenter() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-pairing-test-'));
  const store = openCenterStore({ dataRoot, encryptionKey: ENCRYPTION_KEY });
  const bridge = openHostBridge({ dataRoot, store, linkUrl: 'wss://127.0.0.1:1', relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 400 && !STATUS[code]) code = 'INVALID_ARGUMENT';
    if (!STATUS[code]) code = 'INTERNAL_ERROR';
    reply.code(STATUS[code] || 500).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  const routes = registerRoutes(app, { store, packages: {}, bridge, execution: {}, oauth: {}, linkUrl: 'wss://127.0.0.1:1', turns: {}, publicUrl: PUBLIC_URL });
  await app.ready();

  const center = {
    app, bridge, dataRoot,
    async login() {
      let res = await app.inject({ method: 'GET', url: '/api/session' });
      let cookie = cookieOf(res);
      res = await app.inject({ method: 'POST', url: '/api/session', headers: { cookie, 'x-csrf-token': res.json().csrfToken }, payload: { password: PASSWORD } });
      assert.equal(res.statusCode, 200);
      cookie = cookieOf(res, cookie);
      res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      assert.equal(res.json().authenticated, true);
      return { cookie: cookieOf(res, cookie), csrf: res.json().csrfToken };
    },
    /** 以所有者身份调用；write 时带 CSRF。 */
    owner(session) {
      const headers = (write) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
      return {
        get: url => app.inject({ method: 'GET', url, headers: headers(false) }),
        post: (url, payload = {}) => app.inject({ method: 'POST', url, headers: headers(true), payload }),
        put: (url, payload) => app.inject({ method: 'PUT', url, headers: headers(true), payload }),
        del: url => app.inject({ method: 'DELETE', url, headers: headers(true) }),
      };
    },
    /** 设备侧：无会话、无 CSRF。 */
    redeem: payload => app.inject({ method: 'POST', url: '/api/pairing/redeem', payload }),
    sql(fn) {
      const db = new DatabaseSync(path.join(dataRoot, 'center.sqlite'));
      try { return fn(db); } finally { db.close(); }
    },
    async close() {
      routes.close();
      await app.close();
      bridge.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
  return center;
}

async function withCenter(fn) {
  const center = await openCenter();
  try { await fn(center, center.owner(await center.login())); } finally { await center.close(); }
}

const decodeCode = code => {
  assert.ok(code.startsWith(PAIRING_CODE_PREFIX));
  return JSON.parse(Buffer.from(code.slice(PAIRING_CODE_PREFIX.length), 'base64url').toString('utf8'));
};
const secretOf = code => decodeCode(code).c;
const newToken = () => randomBytes(32).toString('base64url');
const deviceBody = (code, overrides = {}) => ({
  code: secretOf(code), deviceId: 'mac-host-1', deviceToken: newToken(), displayName: 'My Mac', platform: 'macos', ...overrides,
});

test('owner mints a code that carries the center origin and a one-time secret', async () => {
  await withCenter(async (center, owner) => {
    const res = await owner.post('/api/pairing-codes');
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.ttlSeconds, 600);
    assert.equal(body.includesCa, false);
    assert.ok(Date.parse(body.expiresAt) > Date.now() + 9 * 60 * 1000);
    const payload = decodeCode(body.code);
    assert.equal(payload.u, PUBLIC_URL);
    assert.match(payload.c, /^[A-Za-z0-9_-]{32}$/);
    assert.equal('a' in payload, false);

    // 明文只在签发响应里出现：库中只有其 SHA-256。
    const rows = center.sql(db => db.prepare('SELECT id, code_hash FROM pairing_codes').all());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, body.id);
    assert.match(rows[0].code_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(rows[0].code_hash, payload.c);
    assert.equal(JSON.stringify(center.sql(db => db.prepare('SELECT * FROM pairing_codes').all())).includes(payload.c), false);

    const second = (await owner.post('/api/pairing-codes')).json();
    assert.notEqual(secretOf(second.code), payload.c);
    assert.equal((await owner.get(`/api/pairing-codes/${body.id}`)).json().status, 'pending');
  });
});

test('owner endpoints require a session and CSRF; redeem needs neither', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    assert.equal((await center.app.inject({ method: 'POST', url: '/api/pairing-codes', payload: {} })).statusCode, 401);
    assert.equal((await center.app.inject({ method: 'GET', url: `/api/pairing-codes/${minted.id}` })).statusCode, 401);
    assert.equal((await center.app.inject({ method: 'DELETE', url: `/api/pairing-codes/${minted.id}` })).statusCode, 401);
    assert.equal((await center.app.inject({ method: 'GET', url: '/api/pairing/ca' })).statusCode, 401);
    assert.equal((await center.app.inject({ method: 'PUT', url: '/api/pairing/ca', payload: { ca: null } })).statusCode, 401);

    const session = await center.login();
    const noCsrf = await center.app.inject({ method: 'POST', url: '/api/pairing-codes', headers: { cookie: session.cookie }, payload: {} });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((await center.app.inject({ method: 'PUT', url: '/api/pairing/ca', headers: { cookie: session.cookie }, payload: { ca: null } })).statusCode, 403);

    assert.equal((await owner.post('/api/pairing-codes', { extra: 1 })).statusCode, 400);

    const res = await center.redeem(deviceBody(minted.code));
    assert.equal(res.statusCode, 201);
  });
});

test('redeeming registers the device with the token it brought', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(minted.code);
    const res = await center.redeem(body);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { deviceId: 'mac-host-1', deviceToken: body.deviceToken, displayName: 'My Mac', platform: 'macos' });
    assert.ok(center.bridge.registry.authenticate('mac-host-1', body.deviceToken));
    assert.equal(center.bridge.registry.get('mac-host-1').platform, 'macos');
    assert.ok((await owner.get('/api/devices')).json().some(device => device.deviceId === 'mac-host-1' && device.name === 'My Mac'));

    const state = (await owner.get(`/api/pairing-codes/${minted.id}`)).json();
    assert.equal(state.status, 'redeemed');
    assert.deepEqual(state.device, { deviceId: 'mac-host-1', name: 'My Mac' });
  });
});

test('a code works once; the same device may replay it, anyone else is refused', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(minted.code);
    assert.equal((await center.redeem(body)).statusCode, 201);

    // 响应丢失后的重试：同设备、同令牌，幂等成功。
    const replay = await center.redeem(body);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().deviceToken, body.deviceToken);
    assert.ok(center.bridge.registry.authenticate('mac-host-1', body.deviceToken));

    const otherDevice = await center.redeem(deviceBody(minted.code, { deviceId: 'mac-host-2' }));
    assert.equal(otherDevice.statusCode, 409);
    assert.equal(otherDevice.json().error.code, 'PAIRING_CODE_USED');
    const otherToken = await center.redeem({ ...body, deviceToken: newToken() });
    assert.equal(otherToken.json().error.code, 'PAIRING_CODE_USED');
    assert.equal(center.bridge.registry.get('mac-host-2'), null);
    assert.ok(center.bridge.registry.authenticate('mac-host-1', body.deviceToken));
  });
});

test('replay stops working once the replay window has passed', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(minted.code);
    assert.equal((await center.redeem(body)).statusCode, 201);
    center.sql(db => db.prepare('UPDATE pairing_codes SET redeemed_at = ?').run(new Date(Date.now() - 11 * 60 * 1000).toISOString()));
    assert.equal((await center.redeem(body)).json().error.code, 'PAIRING_CODE_USED');
  });
});

test('expired and revoked codes are refused and register nothing', async () => {
  await withCenter(async (center, owner) => {
    const expired = (await owner.post('/api/pairing-codes')).json();
    center.sql(db => db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.id));
    const res = await center.redeem(deviceBody(expired.code));
    assert.equal(res.statusCode, 410);
    assert.equal(res.json().error.code, 'PAIRING_CODE_EXPIRED');
    assert.equal((await owner.get(`/api/pairing-codes/${expired.id}`)).json().status, 'expired');

    const revoked = (await owner.post('/api/pairing-codes')).json();
    assert.equal((await owner.del(`/api/pairing-codes/${revoked.id}`)).statusCode, 204);
    assert.equal((await owner.del(`/api/pairing-codes/${revoked.id}`)).statusCode, 204);
    assert.equal((await owner.get(`/api/pairing-codes/${revoked.id}`)).json().status, 'revoked');
    // Voided by closing the add-device window is told apart from running out of time.
    const voided = await center.redeem(deviceBody(revoked.code));
    assert.equal(voided.statusCode, 410);
    assert.equal(voided.json().error.code, 'PAIRING_CODE_REVOKED');

    assert.equal(center.bridge.registry.get('mac-host-1'), null);
    assert.equal((await owner.get('/api/pairing-codes/missing')).statusCode, 404);
  });
});

test('revoking a redeemed code does not undo the registration', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(minted.code);
    assert.equal((await center.redeem(body)).statusCode, 201);
    assert.equal((await owner.del(`/api/pairing-codes/${minted.id}`)).statusCode, 204);
    assert.equal((await owner.get(`/api/pairing-codes/${minted.id}`)).json().status, 'redeemed');
    assert.ok(center.bridge.registry.authenticate('mac-host-1', body.deviceToken));
  });
});

test('a generic code cannot take over a device that already exists', async () => {
  await withCenter(async (center, owner) => {
    const oldToken = newToken();
    center.bridge.registry.register({ deviceId: 'mac-host-1', token: oldToken, displayName: 'Living-room Mac' });
    const minted = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(minted.code);

    const res = await center.redeem(body);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'DEVICE_ALREADY_REGISTERED');
    // Nothing moved: the real device keeps its credential, and the code is still good for a new device.
    assert.ok(center.bridge.registry.authenticate('mac-host-1', oldToken));
    assert.equal(center.bridge.registry.authenticate('mac-host-1', body.deviceToken), null);
    assert.equal((await owner.get(`/api/pairing-codes/${minted.id}`)).json().status, 'pending');
    assert.equal((await center.redeem({ ...body, deviceId: 'brand-new-host', deviceToken: newToken() })).statusCode, 201);

  });
});

test('a generic code adds back a device the owner deleted, as a fresh registration', async () => {
  await withCenter(async (center, owner) => {
    const first = (await owner.post('/api/pairing-codes')).json();
    const firstBody = deviceBody(first.code, { displayName: 'My Mac' });
    assert.equal((await center.redeem(firstBody)).statusCode, 201);
    assert.equal(center.bridge.registry.get('mac-host-1').displayName, 'My Mac');
    assert.equal((await owner.del('/api/devices/mac-host-1')).statusCode, 204);

    // Deleting is a soft revoke, so the same machine still reports the same ID. A new code adds it back.
    const second = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(second.code, { displayName: 'MacBook Pro' });
    const res = await center.redeem(body);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().deviceId, 'mac-host-1');
    // The name the machine reports now wins over the one it had before the deletion, in the answer and
    // in what the owner sees afterwards.
    assert.equal(res.json().displayName, 'MacBook Pro');
    assert.equal(center.bridge.registry.get('mac-host-1').displayName, 'MacBook Pro');
    assert.equal(center.bridge.registry.get('mac-host-1').revokedAt, null);
    assert.ok(center.bridge.registry.authenticate('mac-host-1', body.deviceToken));
    // The credential from before the deletion stays dead.
    assert.equal(center.bridge.registry.authenticate('mac-host-1', firstBody.deviceToken), null);
    assert.ok((await owner.get('/api/devices')).json().some(device => device.deviceId === 'mac-host-1' && device.name === 'MacBook Pro'));
    const state = (await owner.get(`/api/pairing-codes/${second.id}`)).json();
    assert.equal(state.status, 'redeemed');
    assert.equal(state.device.deviceId, 'mac-host-1');
  });
});

test('a code issued for the device keeps the name the owner gave it', async () => {
  await withCenter(async (center, owner) => {
    const first = (await owner.post('/api/pairing-codes')).json();
    assert.equal((await center.redeem(deviceBody(first.code, { displayName: 'raw-hostname' }))).statusCode, 201);
    center.bridge.registry.rename('mac-host-1', 'Living-room Mac');

    const again = (await owner.post('/api/pairing-codes', { deviceId: 'mac-host-1' })).json();
    const res = await center.redeem(deviceBody(again.code, { displayName: 'raw-hostname' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().displayName, 'Living-room Mac');
    assert.equal(center.bridge.registry.get('mac-host-1').displayName, 'Living-room Mac');
  });
});

test('a code issued for one device re-binds exactly that device', async () => {
  await withCenter(async (center, owner) => {
    const oldToken = newToken();
    center.bridge.registry.register({ deviceId: 'mac-host-1', token: oldToken, displayName: 'Living-room Mac' });
    center.bridge.registry.updateMetadata('mac-host-1', { platform: 'macos' });

    const minted = (await owner.post('/api/pairing-codes', { deviceId: 'mac-host-1' })).json();
    assert.deepEqual(minted.target, { deviceId: 'mac-host-1', name: 'Living-room Mac' });
    assert.deepEqual((await owner.get(`/api/pairing-codes/${minted.id}`)).json().target, { deviceId: 'mac-host-1', name: 'Living-room Mac' });

    // The wrong machine is refused, and the attempt does not burn the owner's code.
    const wrong = await center.redeem(deviceBody(minted.code, { deviceId: 'other-host' }));
    assert.equal(wrong.statusCode, 409);
    assert.equal(wrong.json().error.code, 'PAIRING_CODE_DEVICE_MISMATCH');
    assert.equal(center.bridge.registry.get('other-host'), null);
    assert.equal((await owner.get(`/api/pairing-codes/${minted.id}`)).json().status, 'pending');

    const body = deviceBody(minted.code, { displayName: 'raw-hostname' });
    const res = await center.redeem(body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().displayName, 'Living-room Mac');
    assert.equal(center.bridge.registry.authenticate('mac-host-1', oldToken), null);
    assert.ok(center.bridge.registry.authenticate('mac-host-1', body.deviceToken));
    assert.equal(center.bridge.registry.get('mac-host-1').displayName, 'Living-room Mac');
  });
});

test('only an active device can be the target of a code', async () => {
  await withCenter(async (center, owner) => {
    center.bridge.registry.register({ deviceId: 'mac-host-1', token: newToken(), displayName: 'Mac' });
    assert.equal((await owner.post('/api/pairing-codes', { deviceId: 'nobody' })).statusCode, 404);
    assert.equal((await owner.post('/api/pairing-codes', { deviceId: center.bridge.deviceId })).statusCode, 404);
    assert.equal((await owner.post('/api/pairing-codes', { deviceId: 'bad id' })).statusCode, 400);
    assert.equal((await owner.post('/api/pairing-codes', { deviceId: 7 })).statusCode, 400);
    assert.equal((await owner.post('/api/pairing-codes', { deviceId: 'mac-host-1', extra: 1 })).statusCode, 400);

    // Deleted between issuing and redeeming: the owner's intent no longer holds.
    const minted = (await owner.post('/api/pairing-codes', { deviceId: 'mac-host-1' })).json();
    assert.equal((await owner.del('/api/devices/mac-host-1')).statusCode, 204);
    const res = await center.redeem(deviceBody(minted.code));
    assert.equal(res.statusCode, 410);
    assert.equal(res.json().error.code, 'PAIRING_CODE_EXPIRED');
    assert.equal((await owner.post('/api/pairing-codes', { deviceId: 'mac-host-1' })).statusCode, 404);
  });
});

test('redeem validates the code and the device before touching anything', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    const good = deviceBody(minted.code);

    for (const code of [undefined, 42, '', 'short', 'x'.repeat(31), '!'.repeat(32), 'A'.repeat(32)]) {
      const res = await center.redeem({ ...good, code });
      assert.equal(res.statusCode, 401, `code ${String(code)}`);
      assert.equal(res.json().error.code, 'PAIRING_CODE_INVALID');
    }
    assert.equal((await center.redeem({ ...good, deviceId: 'center-abc' })).statusCode, 403);
    assert.equal((await center.redeem({ ...good, deviceId: center.bridge.deviceId })).statusCode, 403);
    for (const bad of [{ deviceToken: undefined }, { deviceId: undefined }, { deviceToken: 'short' }, { displayName: '' }, { platform: 'plan9' }, { extra: true }]) {
      assert.equal((await center.redeem({ ...good, ...bad })).statusCode, 400, JSON.stringify(bad));
    }
    assert.equal((await center.app.inject({ method: 'POST', url: '/api/pairing/redeem', payload: [] })).statusCode, 400);

    // 以上全部失败，真实的码仍可使用。
    assert.equal((await owner.get(`/api/pairing-codes/${minted.id}`)).json().status, 'pending');
    assert.equal((await center.redeem(good)).statusCode, 201);
  });
});

test('redeem is rate limited per client address, not globally', async () => {
  await withCenter(async (center) => {
    const post = remoteAddress => center.app.inject({
      method: 'POST', url: '/api/pairing/redeem', remoteAddress,
      payload: { code: 'A'.repeat(32), deviceId: 'd', deviceToken: newToken(), displayName: 'n', platform: 'linux' },
    });
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await post('10.0.0.1')).statusCode);
    assert.equal(statuses.slice(0, 30).every(code => code === 401), true);
    assert.equal(statuses[30], 429);
    // Another client is not locked out by the first one's attempts.
    assert.equal((await post('10.0.0.2')).statusCode, 401);
  });
});

test('a replay cannot bring back a credential the owner has since replaced or revoked', async () => {
  await withCenter(async (center, owner) => {
    const first = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(first.code);
    assert.equal((await center.redeem(body)).statusCode, 201);

    // Replaced: the owner re-pairs the device inside the first code's replay window.
    const replacement = newToken();
    center.bridge.registry.rotate({ deviceId: 'mac-host-1', token: replacement });
    const replay = await center.redeem(body);
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'PAIRING_CODE_USED');
    assert.ok(center.bridge.registry.authenticate('mac-host-1', replacement));
    assert.equal(center.bridge.registry.authenticate('mac-host-1', body.deviceToken), null);

    // Revoked: the stolen-but-used code must not resurrect the device.
    const second = (await owner.post('/api/pairing-codes')).json();
    const secondBody = deviceBody(second.code, { deviceId: 'mac-host-2' });
    assert.equal((await center.redeem(secondBody)).statusCode, 201);
    assert.equal((await owner.del('/api/devices/mac-host-2')).statusCode, 204);
    assert.equal((await center.redeem(secondBody)).json().error.code, 'PAIRING_CODE_USED');
    assert.notEqual(center.bridge.registry.get('mac-host-2').revokedAt, null);
    assert.equal(center.bridge.registry.authenticate('mac-host-2', secondBody.deviceToken), null);
  });
});

test('a registry failure after the claim gives the code back instead of burning it', async () => {
  await withCenter(async (center, owner) => {
    const minted = (await owner.post('/api/pairing-codes')).json();
    const body = deviceBody(minted.code);
    const original = center.bridge.registry.register;
    center.bridge.registry.register = () => { throw Object.assign(new Error('disk full'), { code: 'IO_ERROR' }); };
    assert.equal((await center.redeem(body)).statusCode, 500);
    center.bridge.registry.register = original;

    assert.equal((await owner.get(`/api/pairing-codes/${minted.id}`)).json().status, 'pending');
    assert.equal(center.bridge.registry.get('mac-host-1'), null);
    assert.equal((await center.redeem(body)).statusCode, 201);
  });
});

test('the private CA is validated, stored once and embedded into new codes', async () => {
  await withCenter(async (center, owner) => {
    assert.deepEqual((await owner.get('/api/pairing/ca')).json(), { ca: null, certificates: [] });

    for (const ca of ['', 'hello', 42, undefined, `${CA_PEM}\ntrailing text`, CA_PEM.replace('MIIC', 'AAAA'),
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n', 'x'.repeat(70 * 1024)]) {
      assert.equal((await owner.put('/api/pairing/ca', { ca })).statusCode, 400, String(ca).slice(0, 30));
    }
    assert.equal((await owner.put('/api/pairing/ca', { ca: CA_PEM, extra: 1 })).statusCode, 400);
    assert.equal((await owner.get('/api/pairing/ca')).json().ca, null);

    // 带缩进/CRLF 的粘贴也能规整为标准 PEM。
    const messy = `  \r\n${CA_PEM.replaceAll('\n', '\r\n')}\r\n  `;
    const saved = (await owner.put('/api/pairing/ca', { ca: messy })).json();
    assert.equal(saved.ca, CA_PEM);
    assert.equal(saved.certificates.length, 1);
    assert.match(saved.certificates[0].subject, /PiBot Test Root CA/);
    assert.match(saved.certificates[0].fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(saved.certificates[0].validTo.startsWith('2126-'), true);

    const minted = (await owner.post('/api/pairing-codes')).json();
    assert.equal(minted.includesCa, true);
    assert.equal(decodeCode(minted.code).a, CA_PEM);

    assert.deepEqual((await owner.put('/api/pairing/ca', { ca: null })).json(), { ca: null, certificates: [] });
    const without = (await owner.post('/api/pairing-codes')).json();
    assert.equal(without.includesCa, false);
    assert.equal('a' in decodeCode(without.code), false);
  });
});

test('a bundle of several certificates is accepted', async () => {
  await withCenter(async (center, owner) => {
    const res = await owner.put('/api/pairing/ca', { ca: `${CA_PEM}\n${CA_PEM}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().certificates.length, 2);
  });
});

test('upgrading a schema 8 database adds the pairing tables and keeps the existing data', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-pairing-migrate-'));
  const sql = fn => { const db = new DatabaseSync(path.join(dataRoot, 'center.sqlite')); try { return fn(db); } finally { db.close(); } };
  try {
    // A center as the previous release left it: real rows in tables that predate pairing, user_version 8.
    let store = openCenterStore({ dataRoot, encryptionKey: ENCRYPTION_KEY });
    store.close();
    sql(db => db.exec(`
      INSERT INTO model_stars (model_ref) VALUES ('provider-a/model-1'), ('provider-b/model-2');
      DROP TABLE pairing_codes; DROP TABLE pairing_settings; PRAGMA user_version = 8;
    `));
    const before = sql(db => db.prepare('SELECT model_ref FROM model_stars ORDER BY model_ref').all().map(row => row.model_ref));
    assert.deepEqual(before, ['provider-a/model-1', 'provider-b/model-2']);

    store = openCenterStore({ dataRoot, encryptionKey: ENCRYPTION_KEY });
    assert.equal(store.getPairingCa(), null);
    store.setPairingCa(CA_PEM);
    assert.equal(store.getPairingCa(), CA_PEM);
    // The new column is there: a targeted code can be stored and read back.
    assert.equal(store.createPairingCode('a'.repeat(64), 60_000, 'mac-host-1').targetDeviceId, 'mac-host-1');
    store.close();

    assert.equal(sql(db => db.prepare('PRAGMA user_version').get().user_version), 9);
    assert.deepEqual(sql(db => db.prepare('SELECT model_ref FROM model_stars ORDER BY model_ref').all().map(row => row.model_ref)), before);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
