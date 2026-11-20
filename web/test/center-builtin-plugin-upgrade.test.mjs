import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerAuth } from '../../center-server/auth.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { openPackageManager } from '../../center-server/packages/index.js';
import { registerRoutes } from '../../center-server/routes.js';
import { errorStatus } from '../../center-server/server.js';

const centerRequire = createRequire(new URL('../../center-server/package.json', import.meta.url));
const hostRequire = createRequire(new URL('../../host-core/package.json', import.meta.url));
const Fastify = centerRequire('fastify');
const multipart = centerRequire('@fastify/multipart');
const NPM_CLI = path.join(path.dirname(centerRequire.resolve('npm/package.json')), 'bin', 'npm-cli.js');
const tar = hostRequire('tar');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'owner-password-for-builtin-upgrade-tests';

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(value => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function artifactMultipartBody(bytes, filename) {
  const boundary = '----pibot' + randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/gzip\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function makePluginArchive(workDir, { packageId, pkgName, displayName, version }) {
  const stage = path.join(workDir, `${pkgName}-${version}`);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: pkgName, version, type: 'module' }, null, 2),
  );
  fs.writeFileSync(
    path.join(stage, 'capability.json'),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: packageId,
        version,
        kind: 'plugin',
        displayName,
        hostApi: '^1.0.0',
        durableApi: '1.4.0',
        components: { host: { entry: 'entry.js' } },
        platforms: ['windows', 'linux', 'android'],
        configSchema: 'config.schema.json',
        stateVersion: 1,
        contributions: ['tools'],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(stage, 'config.schema.json'),
    JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }, null, 2),
  );
  fs.writeFileSync(path.join(stage, 'entry.js'), `export default function () { return { version: '${version}' }; }\n`);
  fs.writeFileSync(
    path.join(stage, 'package-lock.json'),
    JSON.stringify(
      {
        name: pkgName,
        version,
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: pkgName, version } },
      },
      null,
      2,
    ),
  );
  const archive = path.join(workDir, `${pkgName}-${version}.tgz`);
  await tar.create({ cwd: stage, file: archive, gzip: true, portable: true }, fs.readdirSync(stage));
  return fs.readFileSync(archive);
}

async function openCenter() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-builtin-upgrade-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(9) });
  const bridge = openHostBridge({
    dataRoot,
    store,
    linkUrl: 'wss://127.0.0.1:1',
    relay: { getStatus: () => ({ onlineDeviceIds: [] }) },
  });
  let routes;
  const packages = await openPackageManager({
    dataRoot,
    store,
    npmPath: NPM_CLI,
    onChange: id => routes?.notifyInstallation(id),
    withActivation: async (_id, publish) => {
      await publish();
      return true;
    },
    probeCenterMcp: async () => ({ tools: [] }),
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 413) code = 'PAYLOAD_TOO_LARGE';
    else if (error.statusCode === 400 && !errorStatus[code]) code = 'INVALID_ARGUMENT';
    if (!errorStatus[code]) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 0 } });
  routes = registerRoutes(app, {
    store,
    packages,
    bridge,
    execution: {},
    oauth: {},
    linkUrl: 'wss://127.0.0.1:1',
    turns: {},
  });
  await app.ready();

  return {
    app,
    store,
    packages,
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
      return { cookie: cookieOf(res, cookie), csrf: res.json().csrfToken };
    },
    async close() {
      routes.close();
      await app.close();
      await packages.close();
      bridge.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('owner upgrades existing ask-user-question@1.0.2 and tasks@1.0.0 in place to 1.1.0 via artifact APIs without losing bindings or re-enabling', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-builtin-upgrade-archives-'));
  const center = await openCenter();
  try {
    const { app, store, packages } = center;
    store.replaceDeviceBots('dev-1', [
      { deviceId: 'dev-1', botId: 'bot-a', name: 'Bot A', isPrimary: true },
      { deviceId: 'dev-1', botId: 'bot-b', name: 'Bot B', isPrimary: false },
    ]);

    const askOldArchive = await makePluginArchive(workDir, {
      packageId: 'e-launcher.ask-user-question',
      pkgName: 'e-launcher-ask-user-question',
      displayName: 'Ask User Question',
      version: '1.0.2',
    });
    const tasksOldArchive = await makePluginArchive(workDir, {
      packageId: 'e-launcher.tasks',
      pkgName: 'e-launcher-tasks',
      displayName: 'Tasks',
      version: '1.0.0',
    });

    // Seed existing artifact installations matching initializeBuiltinPlugins shape.
    const askSeedUpload = await packages.uploadArtifact([askOldArchive]);
    const askSeedInstall = await packages.install({
      requestId: randomUUID(),
      kind: 'plugin',
      target: 'host',
      displayName: '用户问卷',
      source: { type: 'artifact', artifactRef: askSeedUpload.artifactRef },
    });
    await packages.idle();
    const askInstId = store.getOperation(askSeedInstall.operationId).installationId;
    await packages.enable(askInstId, { requestId: randomUUID() });
    await packages.idle();

    const tasksSeedUpload = await packages.uploadArtifact([tasksOldArchive]);
    const tasksSeedInstall = await packages.install({
      requestId: randomUUID(),
      kind: 'plugin',
      target: 'host',
      displayName: '全局任务',
      source: { type: 'artifact', artifactRef: tasksSeedUpload.artifactRef },
    });
    await packages.idle();
    const tasksInstId = store.getOperation(tasksSeedInstall.operationId).installationId;
    // Keep tasks disabled to verify in-place upgrade never re-enables disabled plugins.

    const botABefore = store.getBotCapability('dev-1', 'bot-a', askInstId);
    const botAEnabled = botABefore.enabled
      ? botABefore
      : store.putBotCapability('dev-1', 'bot-a', askInstId, {
          expectedRevision: botABefore.revision,
          enabled: true,
          overrides: {},
        });
    const botBBefore = store.getBotCapability('dev-1', 'bot-b', askInstId);
    const botBDisabled = store.putBotCapability('dev-1', 'bot-b', askInstId, {
      expectedRevision: botBBefore.revision,
      enabled: false,
      overrides: {},
    });

    const askNewArchive = await makePluginArchive(workDir, {
      packageId: 'e-launcher.ask-user-question',
      pkgName: 'e-launcher-ask-user-question',
      displayName: 'Ask User Question',
      version: '1.1.0',
    });
    const tasksNewArchive = await makePluginArchive(workDir, {
      packageId: 'e-launcher.tasks',
      pkgName: 'e-launcher-tasks',
      displayName: 'Tasks',
      version: '1.1.0',
    });

    // Auth and CSRF gates remain enforced on both artifact upload and update APIs.
    const unauthUploadBody = artifactMultipartBody(askNewArchive, 'ask-user-question.tgz');
    const unauthUpload = await app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: { 'content-type': unauthUploadBody.contentType },
      payload: unauthUploadBody.body,
    });
    assert.equal(unauthUpload.statusCode, 401);

    const unauthUpdate = await app.inject({
      method: 'POST',
      url: `/api/installations/${askInstId}/update`,
      payload: { requestId: randomUUID(), source: { type: 'artifact', artifactRef: askSeedUpload.artifactRef } },
    });
    assert.equal(unauthUpdate.statusCode, 401);

    const session = await center.login();
    const noCsrfUpdate = await app.inject({
      method: 'POST',
      url: `/api/installations/${askInstId}/update`,
      headers: { cookie: session.cookie },
      payload: { requestId: randomUUID(), source: { type: 'artifact', artifactRef: askSeedUpload.artifactRef } },
    });
    assert.equal(noCsrfUpdate.statusCode, 403);
    assert.equal(noCsrfUpdate.json().error.code, 'CSRF_INVALID');

    // Explicit owner upgrade of enabled ask-user-question@1.0.2 -> 1.1.0.
    const askMp = artifactMultipartBody(askNewArchive, 'ask-user-question.tgz');
    const askUploadRes = await app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        'content-type': askMp.contentType,
      },
      payload: askMp.body,
    });
    assert.equal(askUploadRes.statusCode, 201);
    const askUpload = askUploadRes.json();

    const askUpdateRes = await app.inject({
      method: 'POST',
      url: `/api/installations/${askInstId}/update`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: {
        requestId: randomUUID(),
        source: { type: 'artifact', artifactRef: askUpload.artifactRef },
      },
    });
    assert.equal(askUpdateRes.statusCode, 202);
    await packages.idle();

    const askAfterRes = await app.inject({
      method: 'GET',
      url: `/api/installations/${askInstId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(askAfterRes.statusCode, 200);
    const askAfter = askAfterRes.json();
    assert.equal(askAfter.installationId, askInstId);
    assert.equal(askAfter.packageId, 'e-launcher.ask-user-question');
    assert.equal(askAfter.displayName, '用户问卷');
    assert.equal(askAfter.targetVersion, '1.1.0');
    assert.deepEqual(askAfter.source, { type: 'artifact', artifactRef: askUpload.artifactRef });
    assert.equal(askAfter.enabled, true);
    assert.equal(askAfter.activation.status, 'enabled');

    // Per-Bot bindings (enabled and explicit disable) survive in place without mutation.
    const botAAfter = store.getBotCapability('dev-1', 'bot-a', askInstId);
    const botBAfter = store.getBotCapability('dev-1', 'bot-b', askInstId);
    assert.equal(botAAfter.enabled, true);
    assert.equal(botAAfter.revision, botAEnabled.revision);
    assert.equal(botBAfter.enabled, false);
    assert.equal(botBAfter.revision, botBDisabled.revision);

    const devPlan = store.listDeploymentPlans('dev-1').find(plan => plan.installationId === askInstId);
    assert.ok(devPlan);
    assert.equal(devPlan.targetVersion, '1.1.0');
    assert.equal(devPlan.artifactRef, askUpload.artifactRef);
    assert.equal(devPlan.action, 'update');

    // Explicit owner upgrade of disabled tasks@1.0.0 -> 1.1.0 preserves disabled state.
    const tasksMp = artifactMultipartBody(tasksNewArchive, 'tasks.tgz');
    const tasksUploadRes = await app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        'content-type': tasksMp.contentType,
      },
      payload: tasksMp.body,
    });
    assert.equal(tasksUploadRes.statusCode, 201);
    const tasksUpload = tasksUploadRes.json();

    const tasksUpdateRes = await app.inject({
      method: 'POST',
      url: `/api/installations/${tasksInstId}/update`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: {
        requestId: randomUUID(),
        source: { type: 'artifact', artifactRef: tasksUpload.artifactRef },
      },
    });
    assert.equal(tasksUpdateRes.statusCode, 202);
    await packages.idle();

    const tasksAfterRes = await app.inject({
      method: 'GET',
      url: `/api/installations/${tasksInstId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(tasksAfterRes.statusCode, 200);
    const tasksAfter = tasksAfterRes.json();
    assert.equal(tasksAfter.installationId, tasksInstId);
    assert.equal(tasksAfter.packageId, 'e-launcher.tasks');
    assert.equal(tasksAfter.targetVersion, '1.1.0');
    assert.deepEqual(tasksAfter.source, { type: 'artifact', artifactRef: tasksUpload.artifactRef });
    assert.equal(tasksAfter.enabled, false);
    assert.equal(tasksAfter.activation.status, 'disabled');
    assert.equal(store.getBotCapability('dev-1', 'bot-a', tasksInstId).enabled, false);

    // Package ID mismatch is rejected without mutating the target installation.
    const mismatchRes = await app.inject({
      method: 'POST',
      url: `/api/installations/${askInstId}/update`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: {
        requestId: randomUUID(),
        source: { type: 'artifact', artifactRef: tasksUpload.artifactRef },
      },
    });
    assert.equal(mismatchRes.statusCode, 202);
    await packages.idle();

    const mismatchOpRes = await app.inject({
      method: 'GET',
      url: `/api/operations/${mismatchRes.json().operationId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(mismatchOpRes.statusCode, 200);
    assert.equal(mismatchOpRes.json().phase, 'failed');
    assert.deepEqual(mismatchOpRes.json().error, { code: 'INTERNAL_ERROR', message: 'Operation failed' });

    const askStillRes = await app.inject({
      method: 'GET',
      url: `/api/installations/${askInstId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(askStillRes.json().targetVersion, '1.1.0');
    assert.deepEqual(askStillRes.json().source, { type: 'artifact', artifactRef: askUpload.artifactRef });
  } finally {
    await center.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('admin UI capability detail drawer wires explicit artifact in-place upgrade and gates checkUpdates to npm', () => {
  const source = fs.readFileSync(path.join(ROOT, 'web', 'src', 'center-admin', 'CapabilitiesTab.tsx'), 'utf8');
  assert.match(source, /detailInst\.source\.type === 'npm'/);
  assert.match(source, /detailInst\.source\.type === 'artifact'/);
  assert.match(source, /handleApplyArtifactUpdate/);
  assert.match(source, /api\.uploadArtifact\(updateArtifactFile\)/);
  assert.match(source, /source:\s*\{\s*type:\s*'artifact',\s*artifactRef:\s*uploaded\.artifactRef\s*\}/);
  assert.match(source, /UNSUPPORTED_FORM_DATA/);
  assert.match(source, /operation\?\.phase === 'failed' && operation\.error\?\.message/);
});
