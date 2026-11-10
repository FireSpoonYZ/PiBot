import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerClientReleaseRoutes } from '../../center-server/client-releases.js';
import { readAppBundleInfo } from '../../center-server/app-bundle.js';
import { hostDevicePlatform } from '../../host-core/device-metadata.js';

// Fastify 与 multipart 只安装在 center-server 包内，按该包解析。
const centerRequire = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = centerRequire('fastify');
const multipart = centerRequire('@fastify/multipart');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'macos-release-test-password';
const COMMIT = 'a'.repeat(40);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function infoPlist({ identifier = 'io.github.firespoonyz.pibot', version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>pibot</string>
	<key>CFBundleIdentifier</key>
	<string>${identifier}</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
</dict>
</plist>
`;
}

/**
 * Builds <dir>/<name>.app.tar.gz with the system tar. A >100-byte path comes
 * first so the reader must follow GNU long-name (GNU tar) or pax (bsdtar)
 * headers before it reaches Info.plist.
 */
function makeAppArchive(dir, { name = 'PiBot.app', version = '1.2.3', identifier, plist = true } = {}) {
  const longDir = path.join(name, 'Contents', 'Resources', 'host-runtime', 'x'.repeat(120));
  fs.mkdirSync(path.join(dir, longDir), { recursive: true });
  fs.writeFileSync(path.join(dir, longDir, 'module.js'), 'export default 1;\n');
  const entries = [path.join(longDir, 'module.js')];
  if (plist) {
    fs.writeFileSync(path.join(dir, name, 'Contents', 'Info.plist'), infoPlist({ identifier, version }));
    entries.push(path.join(name, 'Contents', 'Info.plist'));
  }
  const archive = path.join(dir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, ...entries], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return archive;
}

function fakeSignature(version) {
  return `untrusted comment: signature from tauri secret key\nRUQ${'A'.repeat(40)}==\n` +
    `trusted comment: timestamp:1700000000\tfile:PiBot.app.tar.gz\tversion:${version}\n${'B'.repeat(40)}==\n`;
}

function ownerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(value => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function multipartBody(metadata, file, filename) {
  const boundary = '----pibot' + randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="artifact"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function openCenter() {
  const dataRoot = tempDir('el-center-macos-release-');
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(7) });
  const bridge = openHostBridge({ dataRoot, store, linkUrl: 'wss://127.0.0.1:1', relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, req, reply) => {
    let code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    reply.code(code === 'INTERNAL_ERROR' ? 500 : 400).send({ error: { code } });
  });
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash: ownerPasswordHash(PASSWORD) });
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 0 } });
  await registerClientReleaseRoutes(app, { store, dataRoot, registry: bridge.registry, internalDeviceId: bridge.deviceId, publicUrl: 'https://center.example' });
  await app.ready();
  return {
    app,
    async login() {
      let res = await app.inject({ method: 'GET', url: '/api/session' });
      let cookie = cookieOf(res);
      res = await app.inject({ method: 'POST', url: '/api/session', headers: { cookie, 'x-csrf-token': res.json().csrfToken }, payload: { password: PASSWORD } });
      assert.equal(res.statusCode, 200);
      cookie = cookieOf(res, cookie);
      res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      return { cookie: cookieOf(res, cookie), csrfToken: res.json().csrfToken };
    },
    async close() {
      await app.close();
      bridge.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function metadataFor(file, overrides = {}) {
  const bytes = fs.readFileSync(file);
  return {
    version: '1.2.3',
    platform: 'macos',
    arch: 'aarch64',
    format: 'app',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: fakeSignature(overrides.version ?? '1.2.3'),
    notes: 'PiBot 1.2.3',
    sourceCommit: COMMIT,
    ...overrides,
  };
}

test('Host reports macOS as macos and keeps other Node platform names', () => {
  assert.equal(hostDevicePlatform('darwin'), 'macos');
  assert.equal(hostDevicePlatform('linux'), 'linux');
  assert.equal(hostDevicePlatform('win32'), 'win32');
  assert.equal(hostDevicePlatform('android'), 'android');
});

test('readAppBundleInfo reads Info.plist behind long tar names and rejects other archives', async () => {
  const dir = tempDir('el-app-bundle-');
  try {
    const archive = makeAppArchive(dir, { version: '2.0.1' });
    assert.deepEqual(await readAppBundleInfo(archive), {
      bundleName: 'PiBot.app',
      identifier: 'io.github.firespoonyz.pibot',
      version: '2.0.1',
      bundleVersion: '2.0.1',
      executable: 'pibot',
    });
    const other = tempDir('el-app-bundle-noplist-');
    try {
      assert.equal(await readAppBundleInfo(makeAppArchive(other, { plist: false })), null);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    const plain = path.join(dir, 'plain.tar.gz');
    fs.writeFileSync(plain, 'not a gzip stream');
    assert.equal(await readAppBundleInfo(plain), null);
    assert.equal(await readAppBundleInfo(path.join(dir, 'missing.tar.gz')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('center stores, publishes and serves the macOS updater bundle', async () => {
  const dir = tempDir('el-app-upload-');
  const center = await openCenter();
  try {
    const { cookie, csrfToken } = await center.login();
    const archive = makeAppArchive(dir, { version: '1.2.3' });
    const file = fs.readFileSync(archive);
    const upload = (metadata) => {
      const { body, contentType } = multipartBody(metadata, file, 'PiBot.app.tar.gz');
      return center.app.inject({ method: 'POST', url: '/api/client-releases', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': contentType }, payload: body });
    };

    let res = await upload(metadataFor(archive, { arch: 'x86_64' }));
    assert.equal(res.json().error.code, 'INVALID_ARGUMENT');
    res = await upload(metadataFor(archive, { version: '1.2.4' }));
    assert.equal(res.json().error.code, 'VALIDATION_FAILED');

    res = await upload(metadataFor(archive));
    assert.equal(res.statusCode, 201);
    const record = res.json();
    assert.equal(record.filename, 'pibot-1.2.3-macos-aarch64.app.tar.gz');
    assert.equal(record.format, 'app');

    res = await center.app.inject({ method: 'POST', url: `/api/client-releases/${record.id}/publish`, headers: { cookie, 'x-csrf-token': csrfToken }, payload: { published: true } });
    assert.equal(res.statusCode, 200);
    res = await center.app.inject({ method: 'GET', url: '/api/client-updates/macos/aarch64/app/1.0.0', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const update = res.json();
    assert.equal(update.version, '1.2.3');
    assert.deepEqual([update.platform, update.arch, update.format], ['macos', 'aarch64', 'app']);
    assert.equal(update.url, `https://center.example/api/client-releases/${record.id}/download`);
    res = await center.app.inject({ method: 'GET', url: '/api/client-updates/macos/x86_64/app/1.0.0', headers: { cookie } });
    assert.equal(res.json().error.code, 'INVALID_ARGUMENT');
  } finally {
    await center.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release-artifact emits app metadata only for the PiBot bundle identity', () => {
  const dir = tempDir('el-app-release-');
  try {
    const run = (archive, version) => spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release-artifact.mjs'),
      '--version', version, '--commit', COMMIT, '--notes', 'PiBot test',
      '--platform', 'macos', '--arch', 'aarch64', '--format', 'app', '--file', archive,
    ], { encoding: 'utf8' });
    const archive = makeAppArchive(dir, { version: '3.4.5' });
    fs.writeFileSync(archive + '.sig', fakeSignature('3.4.5'));
    const ok = run(archive, '3.4.5');
    assert.equal(ok.status, 0, ok.stderr);
    const entry = JSON.parse(ok.stdout);
    assert.deepEqual([entry.platform, entry.arch, entry.format, entry.version], ['macos', 'aarch64', 'app', '3.4.5']);
    assert.equal(entry.size, fs.statSync(archive).size);

    assert.notEqual(run(archive, '3.4.6').status, 0);
    const foreign = tempDir('el-app-release-foreign-');
    try {
      const other = makeAppArchive(foreign, { version: '3.4.5', identifier: 'com.example.other' });
      fs.writeFileSync(other + '.sig', fakeSignature('3.4.5'));
      const rejected = run(other, '3.4.5');
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /identity\/version does not match/);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
