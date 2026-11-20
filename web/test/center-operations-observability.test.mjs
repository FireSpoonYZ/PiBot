import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { operations } from '../../center-contract/operations/observability.js';
import { createHandlers } from '../../center-server/operations/observability.js';
import { registerClientReleaseRoutes } from '../../center-server/client-releases.js';
import { openCenterStore } from '../../center-server/data/index.js';

const centerRequire = createRequire(new URL('../../center-server/package.json', import.meta.url));
const AjvMod = centerRequire('ajv');
const Ajv = AjvMod.default ?? AjvMod;

const PUBLIC_URL = 'https://center.example.test';
const BOT_ACTOR = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-1' };
const OAUTH_READ_ACTOR = {
  kind: 'oauth',
  clientId: 'mcp-reader',
  scopes: ['pibot:center:read'],
  botTargets: [],
};
const OAUTH_WRITE_ACTOR = {
  kind: 'oauth',
  clientId: 'mcp-writer',
  scopes: ['pibot:center:read', 'pibot:center:write'],
  botTargets: [],
};

function createObservabilityHarness() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-ops-observability-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(5) });

  const registryEntries = new Map([
    ['dev-1', { deviceId: 'dev-1', displayName: 'Workstation', platform: 'linux', revokedAt: null }],
    ['dev-offline', { deviceId: 'dev-offline', displayName: 'Laptop', platform: 'windows', revokedAt: null }],
    ['dev-revoked', { deviceId: 'dev-revoked', displayName: 'OldBox', platform: 'linux', revokedAt: '2026-01-01T00:00:00.000Z' }],
  ]);

  const bridgeCalls = [];
  const bridgeResponses = {
    getHostInfo: {
      protocolVersion: 1,
      deviceId: 'dev-1',
      defaultWorkspace: '/home/alice/pibot-workspace',
      displayName: 'Workstation',
      platform: 'linux',
      arch: 'x64',
      dataRoot: '/home/alice/.pibot',
      env: { SECRET_KEY: 'should-never-leak' },
      token: 'raw-host-token',
    },
    getServiceStatus: {
      deviceId: 'dev-1',
      phase: 'running',
      control: { url: 'http://127.0.0.1:43123', listening: true, token: 'control-secret' },
      relay: {
        deviceId: 'dev-1',
        phase: 'online',
        attempt: 1,
        lastError: 'retry failed against wss://internal.lan:8790/v1/link token=secret123',
        delivery: {
          inFlight: 2,
          lastProblem: {
            code: 'PEER_OFFLINE',
            targetDeviceId: 'dev-offline',
            messageId: 'msg-1',
            at: '2026-11-20T10:00:00.000Z',
          },
        },
        scopeDelivery: {
          online: true,
          inFlight: 0,
          lastProblem: null,
        },
        replicaSync: {
          online: true,
          inFlight: 1,
          activePairs: 3,
          lastProblem: {
            scopeId: 'room-1',
            peerDeviceId: 'dev-offline',
            code: 'SYNC_TIMEOUT',
          },
        },
      },
      activeSettingsRevision: 4,
      settingsRevision: 5,
      restartRequired: true,
      center: {
        state: 'ready',
        centerUrl: 'https://internal-center.local:8443',
        appliedRevision: 9,
        error: {
          code: 'CENTER_WARN',
          message: 'Bearer super-secret-jwt failed at https://internal-center.local:8443/api/host',
        },
      },
      env: { PRIVATE_VAR: 'nope' },
    },
    getBotBoard: {
      updatedAt: '2026-11-20T12:00:00.000Z',
      items: [
        {
          botId: 'bot-1',
          conversationId: 'conv-1',
          activity: {
            phase: 'running',
            source: 'primary',
            scopeId: null,
            requestId: 'req-1',
            startedAt: '2026-11-20T11:59:00.000Z',
          },
          queuedCount: 2,
          attention: {
            kind: 'questionnaire',
            requestId: 'q-1',
            summary: 'Confirm deploy with Bearer top-secret-token-xyz?',
            count: 1,
          },
          progress: {
            completed: 1,
            total: 3,
            current: 'Applying patch (api_key=sk-1234567890abcdef)',
          },
          lastResult: {
            id: '42',
            completedAt: '2026-11-20T11:50:00.000Z',
            summary: 'Finished previous check. ' + 'x'.repeat(600),
          },
          taskId: 'task-9',
          taskTitle: 'Release check',
          taskStatusLine: '进行中',
          history: [{ role: 'user', text: 'MUST NOT EXPORT PRIMARY HISTORY' }],
          messages: [{ text: 'secret transcript' }],
          tools: [{ name: 'bash', result: 'raw output' }],
          queuedItems: [{ text: 'queued user text' }],
          env: { API_KEY: 'nope' },
        },
        {
          botId: 'bot-unrequested',
          conversationId: 'conv-hidden',
          activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
          queuedCount: 0,
          attention: null,
          progress: null,
          lastResult: { id: '99', completedAt: '2026-11-20T11:00:00.000Z', summary: 'Should be filtered out' },
        },
      ],
      errors: [
        { botId: 'bot-missing', code: 'BOT_NOT_FOUND', message: 'bot not found: internal detail' },
        { botId: 'bot-unrequested', code: 'BOARD_UNAVAILABLE', message: 'should also be filtered' },
      ],
    },
  };

  const bridge = {
    deviceId: 'center-internal-relay',
    registry: {
      get: (id) => registryEntries.get(id) ?? null,
      list: () => [...registryEntries.values()],
      authenticate: () => false,
    },
    listDevices: () => [
      { deviceId: 'dev-1', name: 'Workstation', online: true },
      { deviceId: 'dev-offline', name: 'Laptop', online: false },
    ],
    async call(targetDeviceId, method, params) {
      bridgeCalls.push({ targetDeviceId, method, params });
      if (!Object.hasOwn(bridgeResponses, method)) {
        throw Object.assign(new Error(`Unexpected bridge method: ${method}`), { code: 'FORBIDDEN' });
      }
      return structuredClone(bridgeResponses[method]);
    },
  };

  const registeredRoutes = new Map();
  const appStub = {
    csrfProtection: () => {},
    get(pattern, optsOrHandler, maybeHandler) {
      const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
      registeredRoutes.set(`GET ${pattern}`, handler);
    },
    post(pattern, optsOrHandler, maybeHandler) {
      const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
      registeredRoutes.set(`POST ${pattern}`, handler);
    },
  };

  const { listReleases, setReleasePublished } = registerClientReleaseRoutes(appStub, {
    store,
    dataRoot,
    registry: bridge.registry,
    internalDeviceId: bridge.deviceId,
    publicUrl: PUBLIC_URL,
  });

  const ownerCalls = [];
  const owner = async (method, pattern, { params = {}, body, query = {} } = {}) => {
    ownerCalls.push({ method, pattern, params, body, query });
    if (method === 'POST' && pattern === '/api/client-releases/:id/publish') {
      return setReleasePublished({ params, body, query });
    }
    if (method === 'GET' && pattern === '/api/client-releases') {
      return listReleases({ params, body, query });
    }
    throw Object.assign(new Error(`Disallowed owner route: ${method} ${pattern}`), { code: 'FORBIDDEN' });
  };

  const handlers = createHandlers({ store, bridge, owner });

  return {
    dataRoot,
    store,
    bridge,
    bridgeCalls,
    ownerCalls,
    listReleases,
    setReleasePublished,
    registeredRoutes,
    handlers,
    cleanup() {
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('observability descriptors match handlers 1:1 with valid Ajv schemas and center domain conventions', () => {
  assert.ok(Array.isArray(operations) && operations.length === 4);
  const ajv = new Ajv({ strict: false, ownProperties: true });
  const handlers = createHandlers({});

  const descriptorNames = operations.map((op) => op.name);
  const handlerNames = Object.keys(handlers);
  assert.equal(new Set(descriptorNames).size, descriptorNames.length);
  assert.deepEqual([...handlerNames].sort(), [...descriptorNames].sort());

  for (const op of operations) {
    assert.match(op.name, /^center_[a-z0-9_]{1,56}$/);
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 20);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    assert.equal(op.destructive, false);
    assert.equal(op.inputSchema?.type, 'object');
    assert.equal(op.inputSchema?.additionalProperties, false);
    const validate = ajv.compile(op.inputSchema);
    assert.equal(typeof validate, 'function');
  }

  assert.equal(operations.find((op) => op.name === 'center_set_client_release_published')?.readOnly, false);
  assert.equal(operations.find((op) => op.name === 'center_get_host_info')?.readOnly, true);
  assert.equal(operations.find((op) => op.name === 'center_get_host_service_status')?.readOnly, true);
  assert.equal(operations.find((op) => op.name === 'center_get_bot_board')?.readOnly, true);
  assert.throws(() => createHandlers(null), TypeError);
});

test('center_set_client_release_published reuses client-releases handler to toggle only published boolean', async () => {
  const h = createObservabilityHarness();
  try {
    assert.equal(typeof h.setReleasePublished, 'function');
    assert.equal(
      h.registeredRoutes.get('POST /api/client-releases/:id/publish'),
      h.setReleasePublished,
    );

    const record = {
      id: 'rel-signed-1',
      platform: 'linux',
      arch: 'x86_64',
      format: 'deb',
      version: '1.2.3',
      size: 4096,
      sha256: 'a'.repeat(64),
      signature: Buffer.from('untrusted comment: sig\nAAAA==\n', 'utf8').toString('base64'),
      notes: 'Signed release',
      sourceCommit: 'b'.repeat(40),
      filename: 'pibot-1.2.3-linux-x86_64.deb',
      published: false,
      publishedAt: null,
      createdAt: '2026-11-20T09:00:00.000Z',
    };
    h.store.createClientRelease(record);

    const published = await h.handlers.center_set_client_release_published(
      { releaseId: 'rel-signed-1', published: true },
      OAUTH_WRITE_ACTOR,
    );
    assert.equal(published.id, 'rel-signed-1');
    assert.equal(published.published, true);
    assert.ok(typeof published.publishedAt === 'string' && published.publishedAt.length > 0);
    assert.equal(published.sha256, record.sha256);
    assert.equal(published.signature, record.signature);
    assert.equal(published.downloadUrl, `${PUBLIC_URL}/api/client-releases/rel-signed-1/download`);
    assert.deepEqual(h.ownerCalls, [
      {
        method: 'POST',
        pattern: '/api/client-releases/:id/publish',
        params: { id: 'rel-signed-1' },
        body: { published: true },
        query: {},
      },
    ]);

    const firstPublishedAt = published.publishedAt;
    const unpublished = await h.handlers.center_set_client_release_published(
      { releaseId: 'rel-signed-1', published: false },
      BOT_ACTOR,
    );
    assert.equal(unpublished.published, false);
    assert.equal(unpublished.publishedAt, firstPublishedAt);
    assert.equal(h.store.getClientRelease('rel-signed-1')?.published, false);

    // Direct callback fallback works identically when deps.owner is omitted.
    const directHandlers = createHandlers({ setReleasePublished: h.setReleasePublished });
    const republished = await directHandlers.center_set_client_release_published(
      { releaseId: 'rel-signed-1', published: true },
      OAUTH_WRITE_ACTOR,
    );
    assert.equal(republished.published, true);
    assert.equal(republished.publishedAt, firstPublishedAt);

    // Unknown release returns NOT_FOUND from store.setClientReleasePublished.
    await assert.rejects(
      () => h.handlers.center_set_client_release_published(
        { releaseId: 'rel-does-not-exist', published: true },
        OAUTH_WRITE_ACTOR,
      ),
      (err) => err?.code === 'NOT_FOUND',
    );

    // Rejects read-only OAuth scope, upload/secret fields, and non-boolean values.
    await assert.rejects(
      () => h.handlers.center_set_client_release_published(
        { releaseId: 'rel-signed-1', published: true },
        OAUTH_READ_ACTOR,
      ),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => h.handlers.center_set_client_release_published(
        { releaseId: 'rel-signed-1', published: true, signingKey: 'nope' },
        OAUTH_WRITE_ACTOR,
      ),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => h.handlers.center_set_client_release_published(
        { releaseId: 'rel-signed-1', published: true, artifact: 'bytes' },
        OAUTH_WRITE_ACTOR,
      ),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => h.handlers.center_set_client_release_published(
        { releaseId: 'rel-signed-1', published: 'yes' },
        OAUTH_WRITE_ACTOR,
      ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    assert.equal(h.bridgeCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('center_get_host_info and center_get_host_service_status sanitize internal environment and credentials', async () => {
  const h = createObservabilityHarness();
  try {
    const info = await h.handlers.center_get_host_info({ deviceId: 'dev-1' }, OAUTH_READ_ACTOR);
    assert.deepEqual(info, {
      deviceId: 'dev-1',
      displayName: 'Workstation',
      platform: 'linux',
      arch: 'x64',
      protocolVersion: 1,
    });
    assert.equal('defaultWorkspace' in info, false);
    assert.equal('dataRoot' in info, false);
    assert.equal('env' in info, false);
    assert.equal('token' in info, false);

    const status = await h.handlers.center_get_host_service_status({ deviceId: 'dev-1' }, BOT_ACTOR);
    assert.equal(status.deviceId, 'dev-1');
    assert.equal(status.phase, 'running');
    assert.deepEqual(status.control, { listening: true });
    assert.equal('url' in status.control, false);
    assert.equal('token' in status.control, false);
    assert.equal(status.activeSettingsRevision, 4);
    assert.equal(status.settingsRevision, 5);
    assert.equal(status.restartRequired, true);
    assert.equal(status.center.state, 'ready');
    assert.equal(status.center.appliedRevision, 9);
    assert.equal('centerUrl' in status.center, false);
    assert.equal(status.center.error.code, 'CENTER_WARN');
    assert.ok(!status.center.error.message.includes('super-secret-jwt'));
    assert.ok(!status.center.error.message.includes('internal-center.local'));
    assert.equal(status.relay.phase, 'online');
    assert.equal(status.relay.attempt, 1);
    assert.ok(!status.relay.lastError.includes('internal.lan'));
    assert.ok(!status.relay.lastError.includes('secret123'));
    assert.equal(status.relay.delivery.inFlight, 2);
    assert.equal(status.relay.replicaSync.activePairs, 3);
    assert.equal('env' in status, false);

    assert.deepEqual(h.bridgeCalls, [
      { targetDeviceId: 'dev-1', method: 'getHostInfo', params: {} },
      { targetDeviceId: 'dev-1', method: 'getServiceStatus', params: {} },
    ]);

    // Reserved, revoked, and offline targets are rejected before bridge.call.
    await assert.rejects(
      () => h.handlers.center_get_host_info({ deviceId: 'center-internal-relay' }, OAUTH_READ_ACTOR),
      (err) => err?.code === 'NOT_FOUND',
    );
    await assert.rejects(
      () => h.handlers.center_get_host_info({ deviceId: 'dev-revoked' }, OAUTH_READ_ACTOR),
      (err) => err?.code === 'NOT_FOUND',
    );
    await assert.rejects(
      () => h.handlers.center_get_host_service_status({ deviceId: 'dev-offline' }, OAUTH_READ_ACTOR),
      (err) => err?.code === 'DEVICE_OFFLINE',
    );
    assert.equal(h.bridgeCalls.length, 2);
  } finally {
    h.cleanup();
  }
});

test('center_get_bot_board enforces explicit management read auth, botTargets isolation, and never exports primary history', async () => {
  const h = createObservabilityHarness();
  try {
    // Rejects unauthenticated, missing-scope, and wrong-scope OAuth callers.
    await assert.rejects(
      () => h.handlers.center_get_bot_board({ deviceId: 'dev-1', botIds: ['bot-1'] }, null),
      (err) => err?.code === 'UNAUTHENTICATED',
    );
    await assert.rejects(
      () => h.handlers.center_get_bot_board(
        { deviceId: 'dev-1', botIds: ['bot-1'] },
        { kind: 'oauth', clientId: 'no-scope' },
      ),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => h.handlers.center_get_bot_board(
        { deviceId: 'dev-1', botIds: ['bot-1'] },
        { kind: 'oauth', clientId: 'messages-only', scopes: ['pibot:messages:read'] },
      ),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Scoped OAuth botTargets blocks unauthorized Bot reads before calling Host Bridge.
    const scopedOAuth = {
      kind: 'oauth',
      clientId: 'scoped-reader',
      scopes: ['pibot:center:read'],
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }],
    };
    await assert.rejects(
      () => h.handlers.center_get_bot_board(
        { deviceId: 'dev-1', botIds: ['bot-1', 'bot-other'] },
        scopedOAuth,
      ),
      (err) => err?.code === 'FORBIDDEN',
    );
    assert.equal(h.bridgeCalls.length, 0);

    // Disabled device management grant blocks bot actor.
    h.store.setDeviceOAuthGrantEnabled('dev-1', false);
    await assert.rejects(
      () => h.handlers.center_get_bot_board({ deviceId: 'dev-1', botIds: ['bot-1'] }, BOT_ACTOR),
      (err) => err?.code === 'FORBIDDEN',
    );
    h.store.setDeviceOAuthGrantEnabled('dev-1', true);

    // Rejects empty botIds and history-export fields.
    await assert.rejects(
      () => h.handlers.center_get_bot_board({ deviceId: 'dev-1', botIds: [] }, OAUTH_READ_ACTOR),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => h.handlers.center_get_bot_board(
        { deviceId: 'dev-1', botIds: ['bot-1'], includeHistory: true },
        OAUTH_READ_ACTOR,
      ),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Authorized read deduplicates botIds, filters out unrequested items/errors,
    // scrubs secrets in board summaries, caps summary lengths, and strips history/tools/env.
    const board = await h.handlers.center_get_bot_board(
      { deviceId: 'dev-1', botIds: ['bot-1', 'bot-1', 'bot-missing'] },
      OAUTH_READ_ACTOR,
    );
    assert.deepEqual(h.bridgeCalls, [
      { targetDeviceId: 'dev-1', method: 'getBotBoard', params: { botIds: ['bot-1', 'bot-missing'] } },
    ]);
    assert.equal(board.deviceId, 'dev-1');
    assert.equal(board.updatedAt, '2026-11-20T12:00:00.000Z');
    assert.equal(board.items.length, 1);
    const item = board.items[0];
    assert.equal(item.botId, 'bot-1');
    assert.equal(item.conversationId, 'conv-1');
    assert.equal(item.activity.phase, 'running');
    assert.equal(item.queuedCount, 2);
    assert.ok(!item.attention.summary.includes('top-secret-token-xyz'));
    assert.ok(!item.progress.current.includes('sk-1234567890abcdef'));
    assert.equal(item.lastResult.summary.length, 500);
    assert.equal(item.taskId, 'task-9');
    assert.equal(item.taskTitle, 'Release check');
    assert.equal(item.taskStatusLine, '进行中');
    assert.equal('history' in item, false);
    assert.equal('messages' in item, false);
    assert.equal('tools' in item, false);
    assert.equal('queuedItems' in item, false);
    assert.equal('env' in item, false);

    assert.deepEqual(board.errors, [
      { botId: 'bot-missing', code: 'BOT_NOT_FOUND', message: 'bot not found' },
    ]);

    // Scoped OAuth caller can read its explicitly authorized target Bot.
    const scopedBoard = await h.handlers.center_get_bot_board(
      { deviceId: 'dev-1', botIds: ['bot-1'] },
      scopedOAuth,
    );
    assert.equal(scopedBoard.items.length, 1);
    assert.equal(scopedBoard.items[0].botId, 'bot-1');
  } finally {
    h.cleanup();
  }
});
