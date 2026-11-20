import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';

import { GOOGLE_WORKSPACE_INSTALLATION_ID } from '../../center-contract/google-workspace.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { openCenterExecution } from '../../center-server/execution.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerRoutes } from '../../center-server/routes.js';
import { errorStatus } from '../../center-server/server.js';
import {
  openGoogleAccounts,
  GOOGLE_ACCOUNTS_CREDENTIAL_ID,
} from '../../center-server/google-workspace/accounts.js';
import { openGoogleRules } from '../../center-server/google-workspace/rules.js';
import { createGoogleWorkspaceMcpAdapter } from '../../center-server/google-workspace/mcp-server.js';
import { createFileTools } from '../../center-server/google-workspace/file-tools.js';
import { createMailCalendarTools } from '../../center-server/google-workspace/mail-calendar-tools.js';
import { createMcpDriver } from '../../host-core/capabilities/mcp.js';
import {
  createGoogleWorkspacePrivacy,
  GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
} from '../../host-core/google-workspace-privacy.js';

// Fastify is installed under center-server/node_modules.
const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');

const OWNER_PASSWORD = 'owner-password-for-google-integration-tests';
const PUBLIC_URL = 'https://center.example.com';
const REDIRECT_URI = 'https://center.example.com/api/oauth/google/callback';

function makeOwnerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((value) => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function makeFakeIdToken({ sub, email, aud, nowMs = Date.now() }) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud,
    azp: aud,
    sub,
    email,
    email_verified: true,
    iat,
    exp: iat + 3600,
  })).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function makeJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function seedConnectedAccounts(store, records) {
  const accounts = {};
  const nowMs = Date.now();
  for (const item of records) {
    accounts[item.id] = {
      id: item.id,
      sub: item.id,
      email: item.email,
      client: {
        clientId: item.clientId ?? '123456-test.apps.googleusercontent.com',
        clientSecret: item.clientSecret ?? 'GOCSPX-testsecretvalue123456',
      },
      projectId: item.projectId ?? 'pibot-test-project',
      refreshToken: item.refreshToken ?? `1//refresh-${item.id}`,
      accessToken: item.accessToken ?? `ya29.access-${item.id}`,
      expiresAt: nowMs + 60 * 60 * 1000,
      grantedScopes: item.grantedScopes ?? [
        'openid',
        'email',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive',
      ],
      choices: item.choices ?? ['gmail', 'calendar', 'drive'],
      status: item.status ?? 'connected',
      services: item.services ?? [
        { service: 'gmail', state: 'ready' },
        { service: 'calendar', state: 'ready' },
        { service: 'drive', state: 'ready' },
      ],
      checkedAt: nowMs,
      connectedAt: nowMs,
      updatedAt: nowMs,
    };
  }
  const existing = store.getCredential(GOOGLE_ACCOUNTS_CREDENTIAL_ID);
  store.putCredential(GOOGLE_ACCOUNTS_CREDENTIAL_ID, {
    expectedRevision: existing?.revision ?? null,
    value: JSON.stringify({ version: 1, accounts }),
  });
}

/**
 * In-memory Durable harness implementing the exact doc snapshot/commit and
 * conversation entry APIs required by real `createGoogleWorkspacePrivacy`.
 */
function createMemoryDurableHarness() {
  const docs = new Map();
  const conversations = new Map();

  function docKey(def, conversationId) {
    const scope = def?.scope ?? def?.definition?.scope;
    const kind = def?.kind ?? def?.definition?.kind ?? String(def);
    const id = scope === 'session' || typeof conversationId !== 'number' ? 'session' : conversationId;
    return `${kind}:${id}`;
  }

  function initialOf(def) {
    const fn = def?.definition?.initial ?? def?.initial;
    return typeof fn === 'function' ? fn() : {};
  }

  function appendEntry(conversationId, entry) {
    const list = conversations.get(conversationId) ?? [];
    const id = entry.id ?? (list.length ? list[list.length - 1].id + 1 : 1);
    const stored = { conversationId, ...entry, id };
    list.push(stored);
    conversations.set(conversationId, list);
    return stored;
  }

  const harness = {
    appendEntry,
    async snapshot(def, conversationId) {
      const key = docKey(def, conversationId);
      return docs.has(key) ? structuredClone(docs.get(key)) : null;
    },
    async commit(fn) {
      const pending = new Map();
      const tx = {
        async doc(def, conversationId) {
          const key = docKey(def, conversationId);
          if (!pending.has(key)) {
            pending.set(key, docs.has(key) ? structuredClone(docs.get(key)) : initialOf(def));
          }
          return pending.get(key);
        },
        async latestEntryId(conversationId) {
          const list = conversations.get(conversationId) ?? [];
          return list.length ? list[list.length - 1].id : 0;
        },
      };
      const result = await fn(tx);
      for (const [key, value] of pending.entries()) {
        docs.set(key, structuredClone(value));
      }
      return result;
    },
    async conversation(conversationId) {
      return {
        async entries(_ctx, options = {}) {
          const list = [...(conversations.get(conversationId) ?? [])];
          const limit = options.limit ?? 100;
          if (options.order === 'desc') {
            list.reverse();
          }
          const page = list.slice(0, limit);
          return { items: page, nextCursor: null };
        },
      };
    },
  };

  return harness;
}

async function openIntegratedCenter({ fetchImpl, tools, now } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-center-google-int-'));
  const store = openCenterStore({ dataRoot, encryptionKey: randomBytes(32) });
  const relayOnline = new Set();
  const bridge = openHostBridge({
    dataRoot,
    store,
    linkUrl: 'wss://center.example.com/v1/link',
    relay: { getStatus: () => ({ onlineDeviceIds: [...relayOnline] }) },
  });
  const googleAccounts = await openGoogleAccounts({
    store,
    publicUrl: PUBLIC_URL,
    fetchImpl,
    ...(now ? { now } : {}),
  });
  const googleWorkspaceMcp = createGoogleWorkspaceMcpAdapter({
    accounts: googleAccounts,
    ...(tools ? { tools } : {}),
  });
  const execution = openCenterExecution({
    store,
    packages: { async getInstalled() { return null; } },
    oauth: {},
    builtinAdapters: new Map([[GOOGLE_WORKSPACE_INSTALLATION_ID, googleWorkspaceMcp]]),
  });

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    done();
  });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 413) code = 'PAYLOAD_TOO_LARGE';
    else if (error.statusCode === 400 && !errorStatus[code]) code = 'INVALID_ARGUMENT';
    if (!errorStatus[code]) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({
      error: {
        code,
        message: code === 'INTERNAL_ERROR' ? 'Internal error' : code.replaceAll('_', ' ').toLowerCase(),
      },
    });
  });

  await registerAuth(app, {
    sessionKey: randomBytes(32),
    ownerPasswordHash: makeOwnerPasswordHash(OWNER_PASSWORD),
  });

  const notifications = [];
  let routes;
  const googleRules = await openGoogleRules({
    store,
    google: googleAccounts,
    notify: (deviceId) => {
      notifications.push(deviceId);
      routes?.notifyDevice?.(deviceId, 'webhook-ready');
    },
    bridge,
    ...(now ? { now } : {}),
  });

  routes = registerRoutes(app, {
    store,
    packages: { async reconcileDevice() {} },
    bridge,
    execution,
    oauth: {},
    linkUrl: 'wss://center.example.com/v1/link',
    turns: {},
    publicUrl: PUBLIC_URL,
    google: { accounts: googleAccounts, rules: googleRules },
  });
  await app.ready();

  async function loginOwner() {
    let res = await app.inject({ method: 'GET', url: '/api/session' });
    let cookie = cookieOf(res);
    res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie, 'x-csrf-token': res.json().csrfToken },
      payload: { password: OWNER_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    cookie = cookieOf(res, cookie);
    const csrfToken = res.json().csrfToken;
    return { cookie, csrfToken };
  }

  return {
    app,
    store,
    bridge,
    execution,
    googleAccounts,
    googleRules,
    notifications,
    relayOnline,
    loginOwner,
    async close() {
      await googleRules.close();
      routes.close();
      await app.close();
      await execution.close();
      await googleWorkspaceMcp.close();
      googleAccounts.close();
      bridge.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('real Center server routes enforce auth/CSRF/no-store, public OAuth callback, canonical builtin.google-workspace ID, and new Bot auto-visibility', async () => {
  assert.equal(GOOGLE_WORKSPACE_INSTALLATION_ID, 'builtin.google-workspace');
  assert.equal(errorStatus.GOOGLE_ACCOUNT_NOT_CONNECTED, 409);
  assert.equal(errorStatus.GOOGLE_ACCOUNT_AMBIGUOUS, 409);

  const clientId = '123456789-realweb.apps.googleusercontent.com';
  const clientSecret = 'GOCSPX-real-center-secret-987654';
  const fakeFetch = async (urlString) => {
    const url = new URL(urlString);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      return makeJsonResponse({
        access_token: 'ya29.fresh-callback-access-token-xyz',
        refresh_token: '1//fresh-callback-refresh-token-xyz',
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        id_token: makeFakeIdToken({ sub: 'sub-alice', email: 'alice@example.com', aud: clientId }),
      });
    }
    if (url.hostname === 'gmail.googleapis.com') {
      return makeJsonResponse({ emailAddress: 'alice@example.com', messagesTotal: 1 });
    }
    if (url.hostname === 'people.googleapis.com') {
      return makeJsonResponse({ connections: [] });
    }
    return makeJsonResponse({});
  };

  const center = await openIntegratedCenter({ fetchImpl: fakeFetch });
  try {
    // 1. Unauthenticated access rejected; authenticated GET has no-store.
    const unauth = await center.app.inject({ method: 'GET', url: '/api/google/status' });
    assert.equal(unauth.statusCode, 401);

    const ownerA = await center.loginOwner();
    const ownerB = await center.loginOwner();

    const statusBefore = await center.app.inject({
      method: 'GET',
      url: '/api/google/status',
      headers: { cookie: ownerA.cookie },
    });
    assert.equal(statusBefore.statusCode, 200);
    assert.equal(statusBefore.headers['cache-control'], 'no-store');
    assert.equal(statusBefore.json().client.configured, false);
    assert.equal(statusBefore.json().client.redirectUri, REDIRECT_URI);

    // 2. Owner mutation without CSRF rejected.
    const noCsrf = await center.app.inject({
      method: 'POST',
      url: '/api/google/configure',
      headers: { cookie: ownerA.cookie },
      payload: { clientId, clientSecret },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error.code, 'CSRF_INVALID');

    // 3. Configure Web OAuth client via valid Web JSON; secret never echoed.
    const clientJson = JSON.stringify({
      web: {
        client_id: clientId,
        client_secret: clientSecret,
        project_id: 'acme-pibot',
        redirect_uris: [REDIRECT_URI],
      },
    });
    const configured = await center.app.inject({
      method: 'POST',
      url: '/api/google/configure',
      headers: { cookie: ownerA.cookie, 'x-csrf-token': ownerA.csrfToken },
      payload: { clientFile: clientJson },
    });
    assert.equal(configured.statusCode, 200);
    assert.doesNotMatch(configured.body, new RegExp(clientSecret));
    assert.equal(configured.json().client.configured, true);

    // 4. Start OAuth flow bound to ownerA; ownerB cannot inspect ownerA's flow.
    const authStart = await center.app.inject({
      method: 'POST',
      url: '/api/google/authorize',
      headers: { cookie: ownerA.cookie, 'x-csrf-token': ownerA.csrfToken },
      payload: { choices: ['gmail'] },
    });
    assert.equal(authStart.statusCode, 200);
    const { flowId, authorizationUrl } = authStart.json();
    const state = new URL(authorizationUrl).searchParams.get('state');
    assert.ok(flowId && state);

    const foreignInspect = await center.app.inject({
      method: 'POST',
      url: '/api/google/flow',
      headers: { cookie: ownerB.cookie, 'x-csrf-token': ownerB.csrfToken },
      payload: { flowId },
    });
    assert.equal(foreignInspect.statusCode, 404);

    // 5. Public HTTPS callback works without owner session/CSRF, sets strict headers, never echoes code/state/tokens.
    const cbRes = await center.app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?state=${encodeURIComponent(state)}&code=auth-code-secret-111`,
      headers: { accept: 'text/html' },
    });
    assert.equal(cbRes.statusCode, 200);
    assert.equal(cbRes.headers['cache-control'], 'no-store');
    assert.equal(cbRes.headers['referrer-policy'], 'no-referrer');
    assert.equal(cbRes.headers['x-frame-options'], 'DENY');
    assert.doesNotMatch(cbRes.body, /auth-code-secret-111/);
    assert.doesNotMatch(cbRes.body, new RegExp(state));
    assert.doesNotMatch(cbRes.body, /ya29\.fresh-callback/);
    assert.doesNotMatch(cbRes.body, /1\/\/fresh-callback/);
    assert.match(cbRes.body, /alice@example\.com/);

    const flowDone = await center.app.inject({
      method: 'POST',
      url: '/api/google/flow',
      headers: { cookie: ownerA.cookie, 'x-csrf-token': ownerA.csrfToken },
      payload: { flowId },
    });
    assert.equal(flowDone.statusCode, 200);
    assert.equal(flowDone.json().phase, 'connected');
    assert.equal(flowDone.json().account.email, 'alice@example.com');

    // 6. Register device, bootstrap existing Bot + sync brand-new Bot -> BOTH receive builtin.google-workspace with zero grants/toggles.
    const devRes = await center.app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: { cookie: ownerA.cookie, 'x-csrf-token': ownerA.csrfToken },
      payload: { displayName: 'Workstation', platform: 'windows' },
    });
    assert.equal(devRes.statusCode, 201);
    const { deviceId, deviceToken } = devRes.json();
    const hostHeaders = { authorization: `Bearer ${deviceToken}`, 'x-device-id': deviceId };

    const bootRes = await center.app.inject({
      method: 'POST',
      url: '/api/host/bootstrap',
      headers: hostHeaders,
      payload: {
        deviceId,
        capabilityProtocol: 1,
        bots: [{ deviceId, botId: 'bot-a', name: 'Alpha', isPrimary: true }],
      },
    });
    assert.equal(bootRes.statusCode, 200);
    const snapA = bootRes.json().snapshot;
    const capA = snapA.bots[0].capabilities.find((c) => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID);
    assert.ok(capA);
    assert.equal(capA.kind, 'mcp');
    assert.equal(capA.target, 'center');
    assert.equal(capA.enabled, true);
    assert.equal(capA.authorized, true);
    assert.deepEqual(capA.effectiveConfig, {});
    assert.deepEqual(capA.credentialRefs, []);
    assert.deepEqual(snapA.credentials, {});

    // New Bot created later receives builtin.google-workspace automatically without manual binding.
    const syncRes = await center.app.inject({
      method: 'POST',
      url: '/api/host/bots-sync',
      headers: hostHeaders,
      payload: {
        deviceId,
        bots: [
          { deviceId, botId: 'bot-a', name: 'Alpha', isPrimary: true },
          { deviceId, botId: 'bot-new', name: 'NewAssistant', isPrimary: false },
        ],
      },
    });
    assert.equal(syncRes.statusCode, 200);
    const snapAfter = (await center.app.inject({ method: 'GET', url: '/api/host/snapshot', headers: hostHeaders })).json();
    const newBot = snapAfter.bots.find((b) => b.botId === 'bot-new');
    assert.ok(newBot.capabilities.some((c) => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID && c.enabled && c.authorized));

    // Host tools/list works for new Bot and rejects unregistered Bot; per-Bot toggle is FORBIDDEN.
    const listNew = await center.app.inject({
      method: 'POST',
      url: `/api/host/capabilities/${encodeURIComponent(GOOGLE_WORKSPACE_INSTALLATION_ID)}/tools/list`,
      headers: hostHeaders,
      payload: { botId: 'bot-new' },
    });
    assert.equal(listNew.statusCode, 200);
    const toolNames = listNew.json().tools.map((t) => t.name);
    assert.ok(toolNames.includes('gmail_search'));
    assert.ok(toolNames.includes('drive_download'));

    const listGhost = await center.app.inject({
      method: 'POST',
      url: `/api/host/capabilities/${encodeURIComponent(GOOGLE_WORKSPACE_INSTALLATION_ID)}/tools/list`,
      headers: hostHeaders,
      payload: { botId: 'bot-unregistered' },
    });
    assert.equal(listGhost.statusCode, 403);

    const toggleRes = await center.app.inject({
      method: 'PUT',
      url: `/api/devices/${encodeURIComponent(deviceId)}/bots/bot-new/capabilities/${encodeURIComponent(GOOGLE_WORKSPACE_INSTALLATION_ID)}`,
      headers: { cookie: ownerA.cookie, 'x-csrf-token': ownerA.csrfToken },
      payload: { enabled: false, overrides: {}, expectedRevision: 0 },
    });
    assert.equal(toggleRes.statusCode, 403);
  } finally {
    await center.close();
  }
});

test('unified google_rule_events channel works with openGoogleRules default dispatcher and leaves normal webhooks unaffected', async () => {
  const center = await openIntegratedCenter();
  try {
    const owner = await center.loginOwner();
    seedConnectedAccounts(center.store, [{ id: 'sub-alice', email: 'alice@example.com' }]);

    const devRes = await center.app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: { displayName: 'Node-1', platform: 'linux' },
    });
    const { deviceId, deviceToken } = devRes.json();
    const hostHeaders = { authorization: `Bearer ${deviceToken}`, 'x-device-id': deviceId };
    center.store.replaceDeviceBots(deviceId, [{ deviceId, botId: 'bot-1', name: 'One', isPrimary: true }]);

    // 1. Create a real normal webhook route and accept an external webhook event.
    const whCreate = await center.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: { name: 'CI Alerts', deviceId, botId: 'bot-1', instruction: 'Inspect CI failure', enabled: true },
    });
    assert.equal(whCreate.statusCode, 201);
    const { route: webhookRoute, token: webhookToken } = whCreate.json();

    const whEventRes = await center.app.inject({
      method: 'POST',
      url: `/api/webhooks/${encodeURIComponent(webhookRoute.id)}/events`,
      headers: {
        authorization: `Bearer ${webhookToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'ci-build-42',
      },
      payload: { build: 42, status: 'failed' },
    });
    assert.equal(whEventRes.statusCode, 202);
    const normalEventId = whEventRes.json().eventId;

    // 2. Save a Google rule via real owner HTTP route -> stored in google_rules.
    const ruleSave = await center.app.inject({
      method: 'POST',
      url: '/api/google/rules/save',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: {
        deviceId,
        botId: 'bot-1',
        account: 'alice@example.com',
        source: 'gmail',
        enabled: true,
        subjectContains: 'Invoice',
        instruction: 'Summarize invoice email',
      },
    });
    assert.equal(ruleSave.statusCode, 200);
    const savedRule = ruleSave.json().rule;
    assert.ok(savedRule?.id);
    assert.equal(savedRule.account, 'alice@example.com');

    // Enqueue a rule event through the unified google_rule_events table (same table as rules-dispatch.js).
    const nowMs = Date.now();
    const enqueued1 = center.store.enqueueGoogleRuleEvent({
      ruleId: savedRule.id,
      ruleName: savedRule.name,
      deviceId,
      botId: 'bot-1',
      account: 'alice@example.com',
      source: 'gmail',
      eventKey: 'gmail:msg:inv-1',
      instruction: savedRule.instruction,
      payloadJson: JSON.stringify({ source: 'gmail', messageId: 'inv-1', subject: 'Invoice #1' }),
      occurredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
      nowMs,
    });
    assert.equal(enqueued1.created, true);

    // Normal /api/webhooks list contains ONLY the normal webhook route (zero hidden internal routes).
    const whList = await center.app.inject({
      method: 'GET',
      url: '/api/webhooks',
      headers: { cookie: owner.cookie },
    });
    assert.equal(whList.statusCode, 200);
    assert.deepEqual(whList.json().items.map((r) => r.id), [webhookRoute.id]);

    // GET /api/google/rules and GET /api/google/rules/:id/events reflect the real rule + event.
    const rulesList = await center.app.inject({
      method: 'GET',
      url: `/api/google/rules?deviceId=${encodeURIComponent(deviceId)}&botId=bot-1`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(rulesList.statusCode, 200);
    assert.equal(rulesList.json().items.length, 1);
    assert.equal(rulesList.json().items[0].id, savedRule.id);

    const ruleEvents = await center.app.inject({
      method: 'GET',
      url: `/api/google/rules/${encodeURIComponent(savedRule.id)}/events`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ruleEvents.statusCode, 200);
    assert.equal(ruleEvents.json().items.length, 1);
    assert.equal(ruleEvents.json().items[0].id, enqueued1.event.id);

    // 3. Host polls /api/host/webhook-events/poll -> receives BOTH normal webhook and google_rule_events via extraDelivery.
    const pollRes = await center.app.inject({
      method: 'POST',
      url: '/api/host/webhook-events/poll',
      headers: hostHeaders,
      payload: {},
    });
    assert.equal(pollRes.statusCode, 200);
    const polledIds = pollRes.json().items.map((item) => item.id);
    assert.ok(polledIds.includes(normalEventId));
    assert.ok(polledIds.includes(enqueued1.event.id));

    // Receipts update both streams cleanly.
    for (const eventId of [normalEventId, enqueued1.event.id]) {
      const receiptRes = await center.app.inject({
        method: 'POST',
        url: `/api/host/webhook-events/${encodeURIComponent(eventId)}/receipt`,
        headers: hostHeaders,
        payload: { status: 'succeeded', error: null },
      });
      assert.equal(receiptRes.statusCode, 200);
      assert.equal(receiptRes.json().status, 'succeeded');
    }

    // 4. Removing the Google rule cancels pending google_rule_events while keeping normal webhooks untouched.
    const enqueued2 = center.store.enqueueGoogleRuleEvent({
      ruleId: savedRule.id,
      ruleName: savedRule.name,
      deviceId,
      botId: 'bot-1',
      account: 'alice@example.com',
      source: 'gmail',
      eventKey: 'gmail:msg:inv-2',
      instruction: savedRule.instruction,
      payloadJson: JSON.stringify({ source: 'gmail', messageId: 'inv-2', subject: 'Invoice #2' }),
      occurredAt: new Date(nowMs + 1000).toISOString(),
      expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
      nowMs: nowMs + 1000,
    });
    assert.equal(enqueued2.created, true);

    const whEvent2 = await center.app.inject({
      method: 'POST',
      url: `/api/webhooks/${encodeURIComponent(webhookRoute.id)}/events`,
      headers: {
        authorization: `Bearer ${webhookToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'ci-build-43',
      },
      payload: { build: 43, status: 'failed' },
    });
    assert.equal(whEvent2.statusCode, 202);

    const ruleRemove = await center.app.inject({
      method: 'POST',
      url: '/api/google/rules/remove',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: { id: savedRule.id },
    });
    assert.equal(ruleRemove.statusCode, 200);
    assert.equal(ruleRemove.json().removed, true);

    const pollAfterRemove = await center.app.inject({
      method: 'POST',
      url: '/api/host/webhook-events/poll',
      headers: hostHeaders,
      payload: {},
    });
    assert.equal(pollAfterRemove.statusCode, 200);
    assert.deepEqual(pollAfterRemove.json().items.map((item) => item.id), [whEvent2.json().eventId]);
  } finally {
    await center.close();
  }
});

test('Host MCP driver fails closed without privacyGuard marker and executes real fileTools + google-file-transfer without leaking base64 to model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-google-file-int-'));
  const botCwd = path.join(dir, 'workspace');
  const hostDataRoot = path.join(dir, 'host-data');
  fs.mkdirSync(botCwd, { recursive: true });
  fs.mkdirSync(hostDataRoot, { recursive: true });
  fs.writeFileSync(path.join(botCwd, 'brief.txt'), 'Quarterly summary text', 'utf8');

  const store = openCenterStore({ dataRoot: path.join(dir, 'center-data'), encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [{ deviceId: 'dev-1', botId: 'bot-1', name: 'Worker', isPrimary: true }]);

  const uploadedToDrive = [];
  const downloadBytes = Buffer.from('%PDF-1.4\nCONFIDENTIAL_REPORT_BINARY_CONTENT', 'utf8');
  const downloadBase64 = downloadBytes.toString('base64');
  let downloadInvocations = 0;

  const realFileTools = createFileTools({
    loadOrca: async () => ({
      'google-drive': {
        async uploadDrive(_api, opts) {
          uploadedToDrive.push(opts);
          return { file: { id: 'drv-up-1', name: opts.name, mimeType: 'text/plain' } };
        },
      },
      'google-drive-read': {
        async downloadDrive(_api, ref) {
          downloadInvocations += 1;
          return {
            file: { id: ref, name: 'secret-report.pdf', mimeType: 'application/pdf' },
            name: 'secret-report.pdf',
            data: downloadBase64,
          };
        },
      },
    }),
  });

  const adapter = createGoogleWorkspaceMcpAdapter({
    accounts: {
      async api() {
        return {
          email: 'alice@example.com',
          get: async () => ({}),
          find: async () => null,
          send: async () => ({}),
          bytes: async () => new Uint8Array(),
        };
      },
    },
    tools: realFileTools,
  });
  const execution = openCenterExecution({
    store,
    packages: { async getInstalled() { return null; } },
    oauth: {},
    builtinAdapters: new Map([[GOOGLE_WORKSPACE_INSTALLATION_ID, adapter]]),
  });

  try {
    // 1. Fail-closed check: missing host.dataPrivacy MUST block before calling Center.
    let unguardedCenterCalls = 0;
    const unguardedDriver = await createMcpDriver({
      installationId: GOOGLE_WORKSPACE_INSTALLATION_ID,
      version: '1.0.0',
      target: 'center',
      packageRoot: null,
      host: {
        host: { dataRoot: hostDataRoot, getBot: () => ({ botId: 'bot-1', cwd: botCwd }) },
        assertCapabilityAllowed() {},
        async resolveConversationBot() { return 'bot-1'; },
        centerClient: {
          listCapabilityTools: (id, botId) => execution.listTools('dev-1', id, { botId }),
          async callCapabilityTool(id, botId, name, args, callId) {
            unguardedCenterCalls += 1;
            return execution.callTool('dev-1', id, { botId, name, args, callId });
          },
        },
      },
    });
    const unguardedBot = await unguardedDriver.forBot({ botId: 'bot-1', effectiveConfig: {}, credentials: {} });
    await unguardedBot.prepare();
    await unguardedBot.activate();
    const unguardedDownload = unguardedBot.durableContributions.tools.find((t) => t.description.startsWith('MCP tool drive_download:'));
    await assert.rejects(
      () => unguardedDownload.execute({ ref: 'file-1' }, { conversationId: 101, callId: 'call-fail-closed' }, {}),
      (err) => err?.code === GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
    );
    assert.equal(unguardedCenterCalls, 0);
    await unguardedBot.close();
    await unguardedDriver.close();

    // 2. Trusted privacy marker injected via real createGoogleWorkspacePrivacy -> real fileTools + real google-file-transfer.js.
    const harness = createMemoryDurableHarness();
    harness.appendEntry(202, { kind: 'host.user-message', data: { text: 'Download and upload files' } });
    const dataPrivacy = createGoogleWorkspacePrivacy({ getHarness: () => harness, context: {} });

    const observedCenterRawResults = [];
    const guardedDriver = await createMcpDriver({
      installationId: GOOGLE_WORKSPACE_INSTALLATION_ID,
      version: '1.0.0',
      target: 'center',
      packageRoot: null,
      host: {
        host: { dataRoot: hostDataRoot, getBot: () => ({ botId: 'bot-1', cwd: botCwd }) },
        dataPrivacy,
        assertCapabilityAllowed() {},
        async resolveConversationBot() { return 'bot-1'; },
        centerClient: {
          listCapabilityTools: (id, botId) => execution.listTools('dev-1', id, { botId }),
          async callCapabilityTool(id, botId, name, args, callId) {
            const res = await execution.callTool('dev-1', id, { botId, name, args, callId });
            observedCenterRawResults.push({ name, args, res });
            return res;
          },
        },
      },
    });
    const guardedBot = await guardedDriver.forBot({ botId: 'bot-1', effectiveConfig: {}, credentials: {} });
    await guardedBot.prepare();
    await guardedBot.activate();

    try {
      const uploadTool = guardedBot.durableContributions.tools.find((t) => t.description.startsWith('MCP tool drive_upload:'));
      const downloadTool = guardedBot.durableContributions.tools.find((t) => t.description.startsWith('MCP tool drive_download:'));
      assert.ok(uploadTool && downloadTool);

      // Upload stages local file from Bot cwd; Center never receives raw Host path.
      const upOut = await uploadTool.execute(
        { path: 'brief.txt', folder: 'root' },
        { conversationId: 202, callId: 'call-up-1' },
        {},
      );
      assert.equal(upOut.isError, false);
      assert.equal(await dataPrivacy.isConversationTainted(202), true);
      assert.equal(uploadedToDrive.length, 1);
      assert.equal(uploadedToDrive[0].name, 'brief.txt');
      assert.equal(observedCenterRawResults[0].args.path, undefined);

      // Model-supplied raw `data` on upload is rejected on Host before calling Center.
      const badUpload = await uploadTool.execute(
        { name: 'evil.txt', data: Buffer.from('forged').toString('base64') },
        { conversationId: 202, callId: 'call-up-forged' },
        {},
      );
      assert.equal(badUpload.isError, true);
      assert.equal(uploadedToDrive.length, 1);

      // Path traversal on download `out` is rejected on Host before calling Center.
      const escapeDownload = await downloadTool.execute(
        { ref: 'file-escape', out: '../escape.pdf' },
        { conversationId: 202, callId: 'call-dl-escape' },
        {},
      );
      assert.equal(escapeDownload.isError, true);
      assert.equal(downloadInvocations, 0);

      // Valid download writes binary bytes inside Bot cwd and strips base64 from BOTH Center text and final LLM output.
      const dlOut = await downloadTool.execute(
        { ref: 'file-pdf-1', out: 'reports/secret-report.pdf' },
        { conversationId: 202, callId: 'call-dl-1' },
        {},
      );
      assert.equal(dlOut.isError, false);
      assert.equal(downloadInvocations, 1);

      const centerDownloadRecord = observedCenterRawResults.find((item) => item.name === 'drive_download');
      assert.ok(centerDownloadRecord);
      assert.doesNotMatch(centerDownloadRecord.res.content[0].text, new RegExp(downloadBase64));

      const modelText = dlOut.output.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
      assert.doesNotMatch(modelText, new RegExp(downloadBase64));
      assert.doesNotMatch(modelText, /CONFIDENTIAL_REPORT_BINARY_CONTENT/);
      const parsedModelResult = JSON.parse(modelText);
      assert.equal(parsedModelResult.name, 'secret-report.pdf');
      assert.ok(parsedModelResult.savedTo);
      const writtenBytes = fs.readFileSync(parsedModelResult.savedTo);
      assert.deepEqual(writtenBytes, downloadBytes);
    } finally {
      await guardedBot.close();
      await guardedDriver.close();
    }
  } finally {
    await execution.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-account ambiguity and mismatched account never guess and never send outbound Google API requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-google-account-guard-'));
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  seedConnectedAccounts(store, [
    { id: 'sub-alice', email: 'alice@example.com' },
    { id: 'sub-bob', email: 'bob@example.com' },
  ]);

  let outboundFetchCalls = 0;
  const googleAccounts = await openGoogleAccounts({
    store,
    publicUrl: PUBLIC_URL,
    fetchImpl: async () => {
      outboundFetchCalls += 1;
      throw new Error('Unexpected outbound Google HTTP call');
    },
  });

  const orcaCalls = [];
  const realMailTools = createMailCalendarTools({
    loadOrca: async () => ({
      'google-gmail-write': {
        async sendGmailDraft(api, draftRef) {
          orcaCalls.push({ op: 'sendGmailDraft', email: api.email, draftRef });
          return { id: 'sent-1', account: api.email };
        },
      },
      'google-gmail-read': {
        async searchGmail(api, opts) {
          orcaCalls.push({ op: 'searchGmail', email: api.email, opts });
          return { threads: [], account: api.email };
        },
      },
    }),
  });

  const adapter = createGoogleWorkspaceMcpAdapter({
    accounts: googleAccounts,
    tools: realMailTools,
  });

  try {
    const client = await adapter.getClient();

    // 1. Omitting `account` when 2 accounts exist MUST return GOOGLE_ACCOUNT_AMBIGUOUS and perform zero outbound requests.
    const ambiguous = await adapter.runWithCaller(
      { deviceId: 'dev-1', botId: 'bot-1', callId: 'call-ambig' },
      () => client.callTool('gmail_send', { ref: 'gmail:draft:r-123' }),
    );
    assert.equal(ambiguous.isError, true);
    const ambiguousPayload = JSON.parse(ambiguous.content[0].text);
    assert.equal(ambiguousPayload.error.code, 'GOOGLE_ACCOUNT_AMBIGUOUS');
    assert.deepEqual(
      ambiguousPayload.error.accounts.map((a) => a.email).sort(),
      ['alice@example.com', 'bob@example.com'],
    );
    assert.equal(orcaCalls.length, 0);
    assert.equal(outboundFetchCalls, 0);

    // 2. Specifying an unknown account MUST return GOOGLE_ACCOUNT_NOT_FOUND, never fall back to Alice/Bob, and perform zero outbound requests.
    const wrongAccount = await adapter.runWithCaller(
      { deviceId: 'dev-1', botId: 'bot-1', callId: 'call-wrong' },
      () => client.callTool('gmail_send', { ref: 'gmail:draft:r-123', account: 'charlie@example.com' }),
    );
    assert.equal(wrongAccount.isError, true);
    assert.equal(JSON.parse(wrongAccount.content[0].text).error.code, 'GOOGLE_ACCOUNT_NOT_FOUND');
    assert.equal(orcaCalls.length, 0);
    assert.equal(outboundFetchCalls, 0);

    // 3. Explicit connected account executes ONLY on that account and strips spoofed caller/actor/token args.
    const okSearch = await adapter.runWithCaller(
      { deviceId: 'dev-1', botId: 'bot-1', callId: 'call-ok' },
      () => client.callTool('gmail_search', {
        query: 'is:unread',
        account: 'bob@example.com',
        askedBy: 'spoofed-person',
        botToken: 'spoofed-bot-token',
        callerSessionId: 'spoofed-session',
        accessToken: 'ya29.spoofed',
      }),
    );
    assert.notEqual(okSearch.isError, true);
    assert.equal(orcaCalls.length, 1);
    assert.equal(orcaCalls[0].op, 'searchGmail');
    assert.equal(orcaCalls[0].email, 'bob@example.com');
  } finally {
    await adapter.close();
    googleAccounts.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
