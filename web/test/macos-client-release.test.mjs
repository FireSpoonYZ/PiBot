import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readAppBundleInfo } from '../../center-server/app-bundle.js';
import { hostDevicePlatform } from '../../host-core/device-metadata.js';
import { multipartBody, openTestCenter, verifyUpdaterArtifact, verifyUpdaterSignature } from '../../scripts/verify-updater-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAURI_CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
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

/** Throwaway updater key from the Tauri CLI (never the release key). */
function tauriKey(dir, name = 'updater.key') {
  const key = path.join(dir, name);
  execFileSync(process.execPath, [TAURI_CLI, 'signer', 'generate', '--ci', '-p', '', '-w', key, '-f'], { stdio: 'pipe' });
  return { key, publicKey: fs.readFileSync(`${key}.pub`, 'utf8') };
}

/** Signs like the Tauri bundler does: base64 minisign text in <file>.sig. */
function tauriSign(file, key, version) {
  const args = [TAURI_CLI, 'signer', 'sign', '-f', key, '-p', ''];
  if (version) args.push('--app-version', version);
  execFileSync(process.execPath, [...args, file], { stdio: 'pipe' });
  return fs.readFileSync(`${file}.sig`, 'utf8');
}

async function openCenter() {
  return openTestCenter();
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

test('Tauri-signed updater bundle passes signature, release metadata and center publish/query/download', async () => {
  const dir = tempDir('el-updater-chain-');
  try {
    const { key, publicKey } = tauriKey(dir);
    const archive = makeAppArchive(dir, { version: '1.2.3' });
    tauriSign(archive, key, '1.2.3');
    const summary = await verifyUpdaterArtifact({ file: archive, publicKey, version: '1.2.3', platform: 'macos', arch: 'aarch64', format: 'app' });
    assert.equal(summary.version, '1.2.3');
    assert.equal(summary.sha256, createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
    // Same key id the Tauri CLI wrote into the public key comment.
    assert.match(Buffer.from(publicKey, 'base64').toString('utf8'), new RegExp(`minisign public key: ${summary.keyId}\\n`));

    // release-artifact.mjs (and so the chain) refuses a bundle whose Info.plist version differs.
    const other = tempDir('el-updater-chain-other-');
    try {
      const stale = makeAppArchive(other, { version: '1.2.2' });
      tauriSign(stale, key, '1.2.3');
      await assert.rejects(
        verifyUpdaterArtifact({ file: stale, publicKey, version: '1.2.3', platform: 'macos', arch: 'aarch64', format: 'app' }),
        /release-artifact\.mjs rejected/,
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updater signature check rejects tampered files, foreign keys and unbound or edited comments', () => {
  const dir = tempDir('el-updater-sig-');
  try {
    const { key, publicKey } = tauriKey(dir);
    const { publicKey: foreignKey } = tauriKey(dir, 'foreign.key');
    const archive = makeAppArchive(dir, { version: '1.2.3' });
    const bytes = fs.readFileSync(archive);
    const signature = tauriSign(archive, key, '1.2.3');
    const check = (overrides = {}) => verifyUpdaterSignature({ bytes, signature, publicKey, fileName: 'PiBot.app.tar.gz', version: '1.2.3', ...overrides });

    assert.equal(check().version, '1.2.3');
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => check({ bytes: tampered }), /does not match the file/);
    assert.throws(() => check({ publicKey: foreignKey }), /signed by key/);
    assert.throws(() => check({ version: '1.2.4' }), /names version 1\.2\.3/);
    assert.throws(() => check({ fileName: 'Other.app.tar.gz' }), /names file/);
    assert.throws(() => check({ signature: fakeSignature('1.2.3') }));
    // `tauri signer sign` without --app-version: not bound to any version.
    assert.throws(() => check({ signature: tauriSign(archive, key) }), /names version undefined/);
    // Trusted comment edited after signing.
    const edited = Buffer.from(signature, 'base64').toString('utf8').replace('version:1.2.3', 'version:9.9.9');
    assert.throws(() => check({ signature: Buffer.from(edited).toString('base64'), version: '9.9.9' }), /trusted comment signature is invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
