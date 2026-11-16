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
import { PAIRING_CODE_PREFIX } from '../../center-server/pairing.js';
import { errorStatus } from '../../center-server/server.js';
import { readScannedCode } from '../src/pairingCode.ts';
import { formatBotModelSummary } from '../src/bot-settings/modelDisplay.ts';

// Fastify 只安装在 center-server 包内，按该包解析。
const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const PASSWORD = 'owner-password-for-tests';
const PUBLIC_URL = 'https://center.example.com';

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(value => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function decodePairingCode(code) {
  assert.ok(code.startsWith(PAIRING_CODE_PREFIX));
  return JSON.parse(Buffer.from(code.slice(PAIRING_CODE_PREFIX.length), 'base64url').toString('utf8'));
}

async function openCenter({ publicUrl = PUBLIC_URL } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-oauth-ux-test-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(7) });
  const bridge = openHostBridge({ dataRoot, store, linkUrl: 'wss://127.0.0.1:1', relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 400 && !errorStatus[code]) code = 'INVALID_ARGUMENT';
    if (!errorStatus[code]) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  const routes = registerRoutes(app, { store, packages: {}, bridge, execution: {}, oauth: {}, linkUrl: 'wss://127.0.0.1:1', turns: {}, publicUrl });
  await app.ready();
  const center = {
    app,
    bridge,
    store,
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
    owner(session) {
      const headers = (write) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
      return {
        get: url => app.inject({ method: 'GET', url, headers: headers(false) }),
        post: (url, payload = {}) => app.inject({ method: 'POST', url, headers: headers(true), payload }),
        put: (url, payload) => app.inject({ method: 'PUT', url, headers: headers(true), payload }),
        patch: (url, payload) => app.inject({ method: 'PATCH', url, headers: headers(true), payload }),
        del: url => app.inject({ method: 'DELETE', url, headers: headers(true) }),
      };
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

test('pairing grants long-lived OAuth admin token that bypasses Cookie CSRF and can be revoked independently', async () => {
  const center = await openCenter();
  try {
    const session = await center.login();
    const owner = center.owner(session);

    const mintedRes = await owner.post('/api/pairing-codes');
    assert.equal(mintedRes.statusCode, 201);
    const minted = mintedRes.json();
    const secret = decodePairingCode(minted.code).c;

    const deviceId = 'device-oauth-1';
    const deviceToken = randomBytes(32).toString('base64url');
    const redeemRes = await center.app.inject({
      method: 'POST',
      url: '/api/pairing/redeem',
      payload: {
        code: secret,
        deviceId,
        deviceToken,
        displayName: 'Phone One',
        platform: 'android',
      },
    });
    assert.equal(redeemRes.statusCode, 201);

    const tokenRes = await center.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'x-device-id': deviceId,
      },
    });
    assert.equal(tokenRes.statusCode, 200);
    const tokenBody = tokenRes.json();
    assert.equal(typeof tokenBody.accessToken, 'string');
    assert.ok(tokenBody.accessToken.startsWith('pboauth_'));
    assert.equal(tokenBody.tokenType, 'Bearer');
    assert.deepEqual(tokenBody.scopes, ['center:admin']);

    const bearerHeaders = { authorization: `Bearer ${tokenBody.accessToken}` };
    const sessionRes = await center.app.inject({ method: 'GET', url: '/api/session', headers: bearerHeaders });
    assert.equal(sessionRes.statusCode, 200);
    assert.deepEqual(sessionRes.json(), { authenticated: true, csrfToken: 'oauth-bearer' });

    const devicesRes = await center.app.inject({ method: 'GET', url: '/api/devices', headers: bearerHeaders });
    assert.equal(devicesRes.statusCode, 200);
    assert.deepEqual(devicesRes.json().find(d => d.deviceId === deviceId), {
      deviceId,
      name: 'Phone One',
      online: false,
      platform: 'android',
      oauthAdminEnabled: true,
    });

    // OAuth Bearer 写操作免除 Cookie CSRF；无认证请求仍被拒绝。
    const renameRes = await center.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      headers: bearerHeaders,
      payload: { name: 'Phone Renamed' },
    });
    assert.equal(renameRes.statusCode, 200);
    assert.equal(renameRes.json().name, 'Phone Renamed');

    const unauthRename = await center.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      payload: { name: 'Should Fail' },
    });
    assert.equal(unauthRename.statusCode, 401);
    assert.equal(unauthRename.json().error.code, 'UNAUTHENTICATED');

    const noCsrfCookieRename = await center.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      headers: { cookie: session.cookie },
      payload: { name: 'No Csrf' },
    });
    assert.equal(noCsrfCookieRename.statusCode, 403);

    // 独立吊销设备 OAuth 管理权限后，旧 pboauth_ 立即失效，且不可重新兑换。
    const disableRes = await owner.put(`/api/devices/${deviceId}/oauth-grant`, { enabled: false });
    assert.equal(disableRes.statusCode, 200);
    assert.equal(disableRes.json().oauthAdminEnabled, false);

    const revokedListRes = await center.app.inject({ method: 'GET', url: '/api/devices', headers: bearerHeaders });
    assert.equal(revokedListRes.statusCode, 401);
    assert.equal(revokedListRes.json().error.code, 'UNAUTHENTICATED');

    const reExchangeRes = await center.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'x-device-id': deviceId,
      },
    });
    assert.equal(reExchangeRes.statusCode, 403);
    assert.equal(reExchangeRes.json().error.code, 'OAUTH_ACCESS_REVOKED');
  } finally {
    await center.close();
  }
});

test('web QR login flow issues pibotlogin1 challenge, verifies browserSecret, approves via device, and logs in once', async () => {
  const center = await openCenter({ publicUrl: PUBLIC_URL });
  try {
    const session = await center.login();
    const owner = center.owner(session);

    const regRes = await owner.post('/api/devices', { displayName: 'Approver Phone', platform: 'android' });
    assert.equal(regRes.statusCode, 201);
    const { deviceId, deviceToken } = regRes.json();

    const qrRes = await center.app.inject({
      method: 'POST',
      url: '/api/session/qr',
      headers: { origin: PUBLIC_URL },
    });
    assert.equal(qrRes.statusCode, 200);
    const qrBody = qrRes.json();
    assert.equal(typeof qrBody.challengeId, 'string');
    assert.equal(typeof qrBody.browserSecret, 'string');
    assert.ok(qrBody.qrCode.startsWith('pibotlogin1.'));
    assert.equal(typeof qrBody.expiresAt, 'string');
    assert.equal(qrBody.ttlSeconds, 180);

    const scanned = readScannedCode(qrBody.qrCode);
    assert.equal(scanned.kind, 'web-login');
    assert.equal(scanned.centerUrl, PUBLIC_URL);
    assert.equal(scanned.centerHost, 'center.example.com');
    assert.equal(scanned.challengeId, qrBody.challengeId);
    assert.equal(typeof scanned.qrNonce, 'string');

    const pendingRes = await center.app.inject({
      method: 'POST',
      url: `/api/session/qr/${qrBody.challengeId}/claim`,
      payload: { browserSecret: qrBody.browserSecret },
    });
    assert.equal(pendingRes.statusCode, 200);
    assert.deepEqual(pendingRes.json(), { status: 'pending' });

    const badSecretRes = await center.app.inject({
      method: 'POST',
      url: `/api/session/qr/${qrBody.challengeId}/claim`,
      payload: { browserSecret: 'wrong-browser-secret' },
    });
    assert.equal(badSecretRes.statusCode, 401);
    assert.equal(badSecretRes.json().error.code, 'UNAUTHENTICATED');

    const approveRes = await center.app.inject({
      method: 'POST',
      url: '/api/oauth/qr-approve',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'x-device-id': deviceId,
      },
      payload: {
        challengeId: scanned.challengeId,
        qrNonce: scanned.qrNonce,
      },
    });
    assert.equal(approveRes.statusCode, 200);
    assert.deepEqual(approveRes.json(), { approved: true });

    const claimRes = await center.app.inject({
      method: 'POST',
      url: `/api/session/qr/${qrBody.challengeId}/claim`,
      payload: { browserSecret: qrBody.browserSecret },
    });
    assert.equal(claimRes.statusCode, 200);
    const claimBody = claimRes.json();
    assert.equal(claimBody.status, 'approved');
    assert.equal(claimBody.authenticated, true);
    assert.equal(typeof claimBody.csrfToken, 'string');
    assert.ok(claimBody.csrfToken.length > 0);

    const browserCookie = cookieOf(claimRes);
    assert.ok(browserCookie.length > 0);
    const devicesRes = await center.app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: browserCookie },
    });
    assert.equal(devicesRes.statusCode, 200);
    assert.ok(Array.isArray(devicesRes.json()));

    // 挑战一次性消费，二次 claim 返回 expired。
    const secondClaimRes = await center.app.inject({
      method: 'POST',
      url: `/api/session/qr/${qrBody.challengeId}/claim`,
      payload: { browserSecret: qrBody.browserSecret },
    });
    assert.equal(secondClaimRes.statusCode, 200);
    assert.deepEqual(secondClaimRes.json(), { status: 'expired' });
  } finally {
    await center.close();
  }
});

test('active pairing codes remain queryable until explicitly revoked', async () => {
  const center = await openCenter();
  try {
    const owner = center.owner(await center.login());

    const mintedRes = await owner.post('/api/pairing-codes');
    assert.equal(mintedRes.statusCode, 201);
    const minted = mintedRes.json();

    const activeRes = await owner.get('/api/pairing-codes/active');
    assert.equal(activeRes.statusCode, 200);
    const activeList = activeRes.json();
    assert.ok(Array.isArray(activeList));
    const entry = activeList.find(item => item.id === minted.id);
    assert.ok(entry);
    assert.deepEqual(entry, {
      id: minted.id,
      status: 'pending',
      createdAt: entry.createdAt,
      expiresAt: minted.expiresAt,
      includesCa: false,
      target: null,
    });
    assert.equal(typeof entry.createdAt, 'string');

    const statusRes = await owner.get(`/api/pairing-codes/${minted.id}`);
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json().status, 'pending');

    const stillActiveRes = await owner.get('/api/pairing-codes/active');
    assert.equal(stillActiveRes.statusCode, 200);
    assert.equal(stillActiveRes.json().some(item => item.id === minted.id && item.status === 'pending'), true);

    const revokeRes = await owner.del(`/api/pairing-codes/${minted.id}`);
    assert.equal(revokeRes.statusCode, 204);

    const afterRevokeRes = await owner.get('/api/pairing-codes/active');
    assert.equal(afterRevokeRes.statusCode, 200);
    assert.equal(afterRevokeRes.json().some(item => item.id === minted.id), false);
  } finally {
    await center.close();
  }
});

test('bot resolvedModel and formatBotModelSummary honestly reflect unset, center_default, and bot overrides', async () => {
  const center = await openCenter();
  try {
    const owner = center.owner(await center.login());
    const regRes = await owner.post('/api/devices', { displayName: 'Model Host', platform: 'macos' });
    assert.equal(regRes.statusCode, 201);
    const { deviceId } = regRes.json();

    center.store.putCredential('anthropic-api-key', { expectedRevision: null, value: 'sk-ant-test' });
    center.store.putProvider({
      id: 'anthropic',
      name: 'Anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      credentialRef: 'anthropic-api-key',
      enabled: true,
      configured: true,
    }, null);
    center.store.putModel('anthropic', {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      contextWindow: 200000,
      maxTokens: 8192,
      input: ['text'],
      reasoning: true,
      enabled: true,
      source: 'manual',
    }, null);
    center.store.putModel('anthropic', {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      contextWindow: 200000,
      maxTokens: 8192,
      input: ['text'],
      reasoning: true,
      enabled: true,
      source: 'manual',
    }, null);
    center.store.replaceDeviceBots(deviceId, [{
      deviceId,
      botId: 'bot-1',
      name: 'Assistant',
      isPrimary: true,
    }]);

    // 1. 中心默认与单 Bot 均未设置：诚实返回 unset，不谎报继承自中心。
    let botsRes = await owner.get(`/api/devices/${deviceId}/bots`);
    assert.equal(botsRes.statusCode, 200);
    let bot = botsRes.json().find(item => item.botId === 'bot-1');
    assert.equal(bot.resolvedModel.source, 'unset');
    assert.equal(bot.resolvedModel.effectiveModelRef, null);
    assert.equal(bot.resolvedModel.available, false);

    const unsetSummary = formatBotModelSummary(bot, { connectedToCenter: true });
    assert.equal(unsetSummary.primaryText, '未配置 · 去选择');
    assert.equal(unsetSummary.badgeText, undefined);
    const disconnectedSummary = formatBotModelSummary(bot, { connectedToCenter: false });
    assert.equal(disconnectedSummary.primaryText, '未配置 · 扫码绑定中心后可用');
    assert.equal(disconnectedSummary.needsCenterBind, true);

    // 2. 设置中心全局默认模型后：source === 'center_default'，展示模型名 + '默认' 徽标。
    const globalCfg = center.store.getModelConfig();
    center.store.putModelConfig(globalCfg.revision, { modelRef: 'anthropic/claude-sonnet-4-6' });

    botsRes = await owner.get(`/api/devices/${deviceId}/bots`);
    assert.equal(botsRes.statusCode, 200);
    bot = botsRes.json().find(item => item.botId === 'bot-1');
    assert.deepEqual(bot.resolvedModel, {
      effectiveModelRef: 'anthropic/claude-sonnet-4-6',
      effectiveModelName: 'Claude Sonnet 4.6',
      effectiveProviderName: 'Anthropic',
      source: 'center_default',
      available: true,
    });
    const defaultSummary = formatBotModelSummary(bot, { connectedToCenter: true });
    assert.equal(defaultSummary.primaryText, 'Claude Sonnet 4.6');
    assert.equal(defaultSummary.badgeText, '默认');
    assert.equal(defaultSummary.tone, 'normal');

    // 3. 为该 Bot 单独指定模型后：source === 'bot'，展示具体模型名且无 '默认' 徽标。
    const botCfg = center.store.getBotModelConfig(deviceId, 'bot-1');
    center.store.putBotModelConfig(deviceId, 'bot-1', botCfg.revision, { modelRef: 'anthropic/claude-opus-4-6' });

    botsRes = await owner.get(`/api/devices/${deviceId}/bots`);
    assert.equal(botsRes.statusCode, 200);
    bot = botsRes.json().find(item => item.botId === 'bot-1');
    assert.equal(bot.resolvedModel.source, 'bot');
    assert.equal(bot.resolvedModel.effectiveModelRef, 'anthropic/claude-opus-4-6');
    assert.equal(bot.resolvedModel.effectiveModelName, 'Claude Opus 4.6');
    assert.equal(bot.resolvedModel.available, true);

    const botSummary = formatBotModelSummary(bot, { connectedToCenter: true });
    assert.equal(botSummary.primaryText, 'Claude Opus 4.6');
    assert.equal(botSummary.badgeText, undefined);
    assert.equal(botSummary.tone, 'normal');
  } finally {
    await center.close();
  }
});
