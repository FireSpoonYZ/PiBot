import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { openAntigravity } from '../../center-server/antigravity/index.js';
import { openProviderAuth } from '../../center-server/provider-auth.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerRoutes } from '../../center-server/routes.js';
import { PAIRING_CODE_PREFIX } from '../../center-server/pairing.js';
import { errorStatus } from '../../center-server/server.js';
import { connectCenter } from '../../host-core/center-client.js';
import { readScannedCode } from '../src/pairingCode.ts';
import { formatBotModelSummary } from '../src/bot-settings/modelDisplay.ts';
import { openExternalUrl } from '../src/center-admin/openExternalUrl.ts';

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

test('Android and Desktop client bridge allowlists expose center_admin_request, center_qr_login_approve, and OAUTH_ACCESS_REVOKED', async () => {
  const { BRIDGE_CLIENT_OPERATIONS, BRIDGE_ERROR_CODES } = await import('../../host-core/android-bridge-protocol.js');
  assert.equal(BRIDGE_CLIENT_OPERATIONS.has('center_admin_request'), true);
  assert.equal(BRIDGE_CLIENT_OPERATIONS.has('center_qr_login_approve'), true);
  assert.equal(BRIDGE_ERROR_CODES.has('OAUTH_ACCESS_REVOKED'), true);

  const bridgeRs = fs.readFileSync(new URL('../../desktop/src-tauri/src/bridge.rs', import.meta.url), 'utf8');
  assert.match(bridgeRs, /"center_admin_request"/);
  assert.match(bridgeRs, /"center_qr_login_approve"/);
});

test('batch provider-auth-status, antigravity OAuth logout file cleanup, and batch installation bot-bindings', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-agy-batch-test-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(9) });
  const bridge = openHostBridge({ dataRoot, store, linkUrl: 'wss://127.0.0.1:1', relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const antigravity = openAntigravity({ dataRoot });
  const fakeCatalog = {
    apply: async () => {},
    sync: async () => {},
    syncAntigravity: async () => {},
    status: () => ({ syncedAt: null, error: null }),
    bundledResetSpec: () => null,
    runtime: async () => ({
      getProvider: (id) => (id === 'openai-codex'
        ? { auth: { oauth: { loginLabel: '登录 ChatGPT', isSubscription: true }, apiKey: true } }
        : { auth: { apiKey: true } }),
      logout: async () => {},
    }),
  };
  const providerAuth = openProviderAuth({ store, catalog: fakeCatalog, antigravity, onChange: () => {} });
  const app = Fastify({ logger: false });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  const routes = registerRoutes(app, {
    store,
    packages: {},
    bridge,
    execution: {},
    oauth: {},
    linkUrl: 'wss://127.0.0.1:1',
    turns: {},
    catalog: fakeCatalog,
    providerAuth,
    antigravity,
    publicUrl: PUBLIC_URL,
  });
  await app.ready();

  try {
    let res = await app.inject({ method: 'GET', url: '/api/session' });
    let cookie = cookieOf(res);
    res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie, 'x-csrf-token': res.json().csrfToken },
      payload: { password: PASSWORD },
    });
    cookie = cookieOf(res, cookie);
    res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const csrf = res.json().csrfToken;
    cookie = cookieOf(res, cookie);

    store.putProvider({
      id: 'antigravity-acp',
      name: 'Antigravity (Center agy)',
      api: 'antigravity-acp',
      baseUrl: '',
      credentialRef: null,
      native: true,
      enabled: true,
      configured: true,
    }, null);
    store.putProvider({
      id: 'openai-codex',
      name: 'OpenAI Codex',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: null,
      native: true,
      enabled: true,
      configured: false,
    }, null);

    // 1. 无 token 文件时 /api/provider-auth-status 零子进程快速返回 method: 'none'
    const batchRes = await app.inject({
      method: 'GET',
      url: '/api/provider-auth-status',
      headers: { cookie },
    });
    assert.equal(batchRes.statusCode, 200);
    const batchMap = batchRes.json();
    assert.equal(batchMap['antigravity-acp'].method, 'none');
    assert.equal(batchMap['antigravity-acp'].oauth, true);
    assert.equal(batchMap['openai-codex'].oauth, true);
    assert.equal(batchMap['openai-codex'].label, '登录 ChatGPT');

    // 2. 写入模拟的隔离 OAuth 凭据文件，调用 POST /api/providers/antigravity-acp/logout 后必须彻底清理文件并返回 method: 'none'
    const agyCliDir = path.join(dataRoot, 'antigravity', 'gemini', 'antigravity-cli');
    const cacheDir = path.join(agyCliDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const tokenFile = path.join(agyCliDir, 'antigravity-oauth-token');
    const authCacheFile = path.join(cacheDir, 'acp-auth-state.json');
    const jetskiFile = path.join(agyCliDir, 'jetski_state.pbtxt');
    fs.writeFileSync(tokenFile, 'mock-oauth-token-payload');
    fs.writeFileSync(authCacheFile, '{"authenticated":true}');
    fs.writeFileSync(jetskiFile, 'state: 1');

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/providers/antigravity-acp/logout',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {},
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(logoutRes.json().method, 'none');
    assert.equal(fs.existsSync(tokenFile), false);
    assert.equal(fs.existsSync(authCacheFile), false);
    assert.equal(fs.existsSync(jetskiFile), false);
  } finally {
    routes.close();
    providerAuth.close();
    await antigravity.close();
    await app.close();
    bridge.close();
    store.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('connectCenter executes OAuth Bearer adminRequest calls in parallel over Keep-Alive without head-of-line serialization', async () => {
  let concurrent = 0;
  let peakConcurrent = 0;
  let releaseBarrier;
  const allThreeArrived = new Promise(resolve => {
    releaseBarrier = resolve;
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/api/host/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      return;
    }
    if (req.url === '/api/oauth/token' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accessToken: 'parallel-oauth-token' }));
      return;
    }
    if (req.url?.startsWith('/api/parallel-')) {
      assert.equal(req.headers.authorization, 'Bearer parallel-oauth-token');
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      if (concurrent >= 3) releaseBarrier();
      allThreeArrived.then(() => {
        concurrent -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: req.url, ok: true }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = await connectCenter({
    centerUrl: `http://127.0.0.1:${port}`,
    deviceId: 'dev-parallel-1',
    deviceToken: 'a'.repeat(48),
  });

  try {
    const results = await Promise.all([
      client.adminRequest('/api/parallel-1'),
      client.adminRequest('/api/parallel-2'),
      client.adminRequest('/api/parallel-3'),
    ]);
    assert.equal(peakConcurrent, 3);
    assert.deepEqual(results.map(r => r.url), ['/api/parallel-1', '/api/parallel-2', '/api/parallel-3']);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(() => resolve()));
  }
});

test('openExternalUrl dispatches across handler, AndroidBridge, Tauri fallback chain, and Web fallback', async () => {
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  const setGlobal = (key, value) => {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  };

  try {
    // 1. Empty / whitespace URLs are ignored without touching any opener
    let handlerCalls = [];
    let webOpenCalls = [];
    let bridgeCalls = [];
    setGlobal('document', undefined);
    setGlobal('window', {
      AndroidBridge: {
        openExternalUrl: u => bridgeCalls.push(u),
      },
      open: (...args) => {
        webOpenCalls.push(args);
        return {};
      },
    });
    await openExternalUrl('');
    await openExternalUrl('   \t\n  ', u => {
      handlerCalls.push(u);
    });
    assert.deepEqual(handlerCalls, []);
    assert.deepEqual(bridgeCalls, []);
    assert.deepEqual(webOpenCalls, []);

    // 2. Explicit handler takes precedence over AndroidBridge / window.open
    await openExternalUrl('  https://example.com/oauth?step=1  ', u => {
      handlerCalls.push(u);
    });
    assert.deepEqual(handlerCalls, ['https://example.com/oauth?step=1']);
    assert.deepEqual(bridgeCalls, []);
    assert.deepEqual(webOpenCalls, []);

    // 3. AndroidBridge.openExternalUrl takes precedence over Tauri and Web
    const tauriInvokes = [];
    setGlobal('window', {
      AndroidBridge: {
        openExternalUrl: u => bridgeCalls.push(u),
      },
      __TAURI_INTERNALS__: {
        invoke: async (cmd, args) => {
          tauriInvokes.push([cmd, args]);
        },
      },
      open: (...args) => {
        webOpenCalls.push(args);
        return {};
      },
    });
    await openExternalUrl('  https://example.com/android  ');
    assert.deepEqual(bridgeCalls, ['https://example.com/android']);
    assert.deepEqual(tauriInvokes, []);
    assert.deepEqual(webOpenCalls, []);

    // 4a. Tauri __TAURI_INTERNALS__.invoke falls back from opener/shell errors to desktop_open_center
    tauriInvokes.length = 0;
    setGlobal('window', {
      __TAURI_INTERNALS__: {
        invoke: async (cmd, args) => {
          tauriInvokes.push([cmd, args]);
          if (cmd === 'plugin:opener|open_url' || cmd === 'plugin:shell|open') {
            throw new Error(`command ${cmd} unavailable`);
          }
        },
      },
      open: (...args) => {
        webOpenCalls.push(args);
        return {};
      },
    });
    await openExternalUrl('https://example.com/desktop');
    assert.deepEqual(tauriInvokes, [
      ['plugin:opener|open_url', { url: 'https://example.com/desktop' }],
      ['plugin:shell|open', { path: 'https://example.com/desktop' }],
      ['desktop_open_center', { url: 'https://example.com/desktop' }],
    ]);
    assert.deepEqual(webOpenCalls, []);

    // 4b. Tauri __TAURI_INTERNALS__.invoke falls back further to mobile_host_request openCenter
    tauriInvokes.length = 0;
    setGlobal('window', {
      __TAURI_INTERNALS__: {
        invoke: async (cmd, args) => {
          tauriInvokes.push([cmd, args]);
          if (cmd !== 'mobile_host_request') {
            throw new Error(`command ${cmd} unavailable`);
          }
        },
      },
      open: (...args) => {
        webOpenCalls.push(args);
        return {};
      },
    });
    await openExternalUrl('https://example.com/mobile');
    assert.deepEqual(tauriInvokes, [
      ['plugin:opener|open_url', { url: 'https://example.com/mobile' }],
      ['plugin:shell|open', { path: 'https://example.com/mobile' }],
      ['desktop_open_center', { url: 'https://example.com/mobile' }],
      ['mobile_host_request', { method: 'openCenter', params: { url: 'https://example.com/mobile' } }],
    ]);
    assert.deepEqual(webOpenCalls, []);

    // 5. Standard Web environment falls back to window.open(url, '_blank', 'noopener,noreferrer')
    const anchorClicks = [];
    setGlobal('document', {
      createElement: tag => {
        const el = { tag, href: '', target: '', rel: '', clicked: false };
        el.click = () => {
          el.clicked = true;
          anchorClicks.push(el);
        };
        return el;
      },
    });
    setGlobal('window', {
      open: (...args) => {
        webOpenCalls.push(args);
        return {};
      },
    });
    await openExternalUrl('https://example.com/web');
    assert.deepEqual(webOpenCalls, [['https://example.com/web', '_blank', 'noopener,noreferrer']]);
    assert.deepEqual(anchorClicks, []);

    // 5b. Blocked popup (window.open returns null) triggers synthetic <a target="_blank"> click
    webOpenCalls.length = 0;
    setGlobal('window', {
      open: (...args) => {
        webOpenCalls.push(args);
        return null;
      },
    });
    await openExternalUrl('https://example.com/web-popup-blocked');
    assert.deepEqual(webOpenCalls, [
      ['https://example.com/web-popup-blocked', '_blank', 'noopener,noreferrer'],
    ]);
    assert.equal(anchorClicks.length, 1);
    assert.equal(anchorClicks[0].tag, 'a');
    assert.equal(anchorClicks[0].href, 'https://example.com/web-popup-blocked');
    assert.equal(anchorClicks[0].target, '_blank');
    assert.equal(anchorClicks[0].rel, 'noopener noreferrer');
    assert.equal(anchorClicks[0].clicked, true);
  } finally {
    if (prevWindowDesc) {
      Object.defineProperty(globalThis, 'window', prevWindowDesc);
    } else {
      delete globalThis.window;
    }
    if (prevDocumentDesc) {
      Object.defineProperty(globalThis, 'document', prevDocumentDesc);
    } else {
      delete globalThis.document;
    }
  }
});
