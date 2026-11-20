import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerAuth } from '../../center-server/auth.js';
import { hashOwnerPassword } from '../../center-server/config.js';
import { registerClientReleaseRoutes } from '../../center-server/client-releases.js';
import { registerRoutes } from '../../center-server/routes.js';
import { openOperations } from '../../center-server/operations/index.js';
import { operationScopes } from '../../center-contract/operations/index.js';
import { createOperationTools } from '../../host-core/operation-tools.js';
import { registerMcpOAuth, MCP_OAUTH_PATHS } from '../../center-server/mcp/oauth.js';
import { registerMcp } from '../../center-server/mcp/server.js';

const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');
const publicUrl = 'https://center.example.test';
const form = fields => new URLSearchParams(fields).toString();
const cookie = response => String(response.headers['set-cookie']).split(';')[0];

test('owner UI, deferred Bot tool and OAuth MCP share actual Center operations without sharing credentials', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pibot-shared-operations-'));
  const store = openCenterStore({ dataRoot, encryptionKey: randomBytes(32) });
  const bridge = openHostBridge({ dataRoot, store, relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify();
  let routes;
  try {
    app.setErrorHandler((err, _req, reply) => reply.code(
      ({ FORBIDDEN: 403, INVALID_ARGUMENT: 400, REVISION_CONFLICT: 409 })[err.code] ?? 500,
    ).send({ error: err.code ?? 'INTERNAL_ERROR' }));
    const password = 'owner-password-for-test';
    await registerAuth(app, { ownerPasswordHash: hashOwnerPassword(password), sessionKey: randomBytes(32) });
    const { listReleases } = registerClientReleaseRoutes(app, { store, dataRoot, registry: bridge.registry, internalDeviceId: bridge.deviceId, publicUrl });
    routes = registerRoutes(app, {
      store, bridge, packages: {}, execution: {}, oauth: {}, linkUrl: 'wss://center.example.test/v1/link',
      turns: {}, catalog: { status: () => ({ source: 'test' }) }, publicUrl, listReleases, createOperations: openOperations,
    });
    const client = {
      clientId: 'test-client', clientSecret: randomBytes(32).toString('base64url'),
      redirectUris: ['https://mcp-client.example.test/callback'], scopes: ['pibot:center:read'],
    };
    const { authenticate } = registerMcpOAuth(app, { publicUrl, clients: [client], supportedScopes: operationScopes });
    registerMcp(app, { publicUrl, authenticate, operations: routes.operations });
    await app.ready();

    const deviceId = 'test-host';
    const botId = 'working-bot';
    const deviceToken = randomBytes(32).toString('base64url');
    bridge.registry.register({ deviceId, token: deviceToken, displayName: 'Test Host' });
    store.replaceDeviceBots(deviceId, [{ deviceId, botId, name: 'Working Bot' }]);
    const hostHeaders = { authorization: `Bearer ${deviceToken}`, 'x-device-id': deviceId };
    const hostCall = (name, args = {}, fields = {}, headers = hostHeaders) => app.inject({
      method: 'POST', url: '/api/host/operations/call', headers, payload: { botId, name, args, ...fields },
    });
    const tool = createOperationTools({}).find(item => item.name === 'center_set_model_config');
    assert.equal(tool.deferred, true);
    assert.equal(tool.replay, 'unsafe');

    const result = await hostCall(tool.name, { expectedRevision: 0, value: { thinkingLevel: 'high' } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().global.thinkingLevel, 'high');
    assert.equal((await hostCall(tool.name, { expectedRevision: 0, value: { thinkingLevel: 'low' } })).statusCode, 409);
    assert.equal((await hostCall('center_get_model_config', { path: '/api/oauth/token' })).statusCode, 400);
    assert.equal((await hostCall('center_get_model_config', {}, { botId: 'absent' })).statusCode, 403);
    assert.equal((await hostCall('center_get_model_config', {}, { actor: { kind: 'owner' } })).statusCode, 400);
    const oldAdminToken = (await app.inject({ method: 'POST', url: '/api/oauth/token', headers: hostHeaders, payload: {} })).json().accessToken;
    store.setDeviceOAuthGrantEnabled(deviceId, false);
    assert.equal((await hostCall(tool.name, { expectedRevision: 1, value: { thinkingLevel: 'low' } })).statusCode, 403);

    const beforeLogin = await app.inject({ method: 'GET', url: '/api/session' });
    const login = await app.inject({
      method: 'POST', url: '/api/session',
      headers: { cookie: cookie(beforeLogin), 'x-csrf-token': beforeLogin.json().csrfToken },
      payload: { password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const owner = { cookie: cookie(login) };
    const observed = await app.inject({ method: 'GET', url: '/api/model-config', headers: owner });
    assert.equal(observed.json().global.thinkingLevel, 'high');

    const verifier = randomBytes(32).toString('base64url');
    const resource = publicUrl + '/mcp';
    const consent = await app.inject({
      method: 'GET', url: MCP_OAUTH_PATHS.authorize + '?' + form({
        response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUris[0],
        scope: client.scopes.join(' '), state: 'client-test-state', resource,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }), headers: owner,
    });
    assert.equal(consent.statusCode, 200, consent.body);
    const approved = await app.inject({
      method: 'POST', url: MCP_OAUTH_PATHS.authorize, headers: { ...owner, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ consent_id: /name="consent_id" value="([^"]+)"/.exec(consent.body)[1],
        csrf_token: /name="csrf_token" value="([^"]+)"/.exec(consent.body)[1], decision: 'approve' }),
    });
    assert.equal(approved.statusCode, 302, approved.body);
    const grant = await app.inject({
      method: 'POST', url: MCP_OAUTH_PATHS.token, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ grant_type: 'authorization_code', code: new URL(approved.headers.location).searchParams.get('code'),
        code_verifier: verifier, redirect_uri: client.redirectUris[0], client_id: client.clientId,
        client_secret: client.clientSecret, resource }),
    });
    assert.equal(grant.statusCode, 200, grant.body);
    const token = grant.json().access_token;
    const rpc = (method, params = {}, bearer = token) => app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });

    const list = await rpc('tools/list');
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(list.json().result.tools.some(tool => tool.name === 'center_get_model_config'));
    assert.ok(list.json().result.tools.every(tool => tool.annotations.readOnlyHint));
    for (const [name, check] of [
      ['center_get_model_config', value => assert.equal(value.global.thinkingLevel, 'high')],
      ['center_list_client_releases', value => assert.deepEqual(value.releases, [])],
    ]) {
      const response = await rpc('tools/call', { name, arguments: {} });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().result;
      assert.ok(result && !result.isError, response.body);
      check(result.structuredContent ?? JSON.parse(result.content[0].text));
    }
    const denied = await rpc('tools/call', { name: tool.name, arguments: { expectedRevision: 1, value: { thinkingLevel: 'low' } } });
    assert.ok(denied.json().result?.isError || denied.json().error, denied.body);
    assert.equal(store.getModelConfig().global.thinkingLevel, 'high');
    for (const incompatible of [oldAdminToken, deviceToken]) {
      const response = await rpc('tools/list', {}, incompatible);
      assert.equal(response.statusCode, 401);
      assert.match(response.headers['www-authenticate'], /resource_metadata=/);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/model-config', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal((await hostCall('center_get_model_config', {}, {}, { ...hostHeaders, authorization: `Bearer ${token}` })).statusCode, 401);
  } finally {
    routes?.close();
    await app.close();
    bridge.close();
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
