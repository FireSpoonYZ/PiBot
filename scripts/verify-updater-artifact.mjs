#!/usr/bin/env node
// scripts/verify-updater-artifact.mjs — check one signed desktop updater
// artifact end to end, using whatever key signed it (CI uses a throwaway key,
// never the release key):
//
//   1. <file>.sig is a valid Tauri (minisign) signature of the file by the
//      updater public key compiled into the client, bound to the file name
//      and version;
//   2. scripts/release-artifact.mjs accepts it (bundle identity, version);
//   3. an in-process center accepts the upload, publishes it, offers it to
//      an older client via /api/client-updates, offers nothing to a current
//      one, and serves the same bytes with a signature that still verifies —
//      the checks the desktop updater performs before installing.
//
//   node scripts/verify-updater-artifact.mjs --file PiBot.app.tar.gz \
//     --public-key <Tauri public key | @path/to/key.pub> --version 1.2.3 \
//     --platform macos --arch aarch64 --format app
import { createHash, createPublicKey, randomBytes, scryptSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Same limits as center-server/server.js; uploads stream past bodyLimit. */
const BODY_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 100 * 1024 * 1024;
const PUBLIC_URL = 'https://center.example';

function decodeBase64(text, what) {
  const value = String(text).trim();
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) throw new Error(`${what} is not base64`);
  return Buffer.from(value, 'base64');
}

/** Minisign text, accepting either the raw text or Tauri's base64 wrapping. */
function minisignText(value, what) {
  const text = String(value).trim();
  return text.startsWith('untrusted comment:') ? text : decodeBase64(text, what).toString('utf8');
}

/** Key id as minisign prints it (little-endian u64 in hex). */
function keyIdText(raw) {
  return Buffer.from(raw).reverse().toString('hex').toUpperCase();
}

/**
 * Parses a Tauri updater public key (base64 of a minisign public key file).
 * Returns the 8-byte key id and the Ed25519 key.
 */
export function parsePublicKey(value) {
  const lines = minisignText(value, 'public key').split('\n').map((line) => line.trim()).filter(Boolean);
  const raw = decodeBase64(lines[1] ?? '', 'public key');
  if (!lines[0]?.startsWith('untrusted comment:') || raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('public key is not a minisign Ed25519 key');
  }
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') }, format: 'jwk' });
  return { keyId: raw.subarray(2, 10), key };
}

/**
 * Verifies a Tauri updater signature the way minisign does: the signature
 * over the file (BLAKE2b-512 prehashed for `ED`), the key id, and the global
 * signature over the trusted comment. With `fileName`/`version`, the trusted
 * comment must name them. Returns the trusted comment fields.
 */
export function verifyUpdaterSignature({ bytes, signature, publicKey, fileName, version }) {
  const { keyId, key } = parsePublicKey(publicKey);
  const lines = minisignText(signature, 'signature').split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('signature is not a minisign signature');
  }
  const sig = decodeBase64(lines[1], 'signature');
  if (sig.length !== 74) throw new Error('signature has the wrong length');
  const algorithm = sig.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error(`unsupported signature algorithm ${algorithm}`);
  if (!sig.subarray(2, 10).equals(keyId)) {
    throw new Error(`signed by key ${keyIdText(sig.subarray(2, 10))}, expected ${keyIdText(keyId)}`);
  }
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  if (!verify(null, message, key, sig.subarray(10))) throw new Error('signature does not match the file');
  const trusted = lines[2].slice('trusted comment: '.length);
  const global = decodeBase64(lines[3], 'global signature');
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, 'utf8')]), key, global)) {
    throw new Error('trusted comment signature is invalid');
  }
  const fields = Object.fromEntries(trusted.split('\t').map((part) => {
    const at = part.indexOf(':');
    return at === -1 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
  }));
  if (fileName !== undefined && fields.file !== fileName) throw new Error(`signature names file ${fields.file}, expected ${fileName}`);
  if (version !== undefined && fields.version !== version) throw new Error(`signature names version ${fields.version}, expected ${version}`);
  return fields;
}

function centerModule(relative) {
  return import(pathToFileURL(path.join(ROOT, 'center-server', relative)).href);
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((value) => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function expectStatus(res, status, what) {
  if (res.statusCode !== status) throw new Error(`${what}: HTTP ${res.statusCode} ${res.body}`);
  return res;
}

/** multipart/form-data body with the `metadata` field and the `artifact` file. */
export function multipartBody(metadata, file, filename) {
  const boundary = '----pibot' + randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="artifact"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * An in-process center with the owner auth and client-release routes, backed
 * by a temporary data root. Needs `npm ci --prefix center-server`.
 */
export async function openTestCenter({ password = randomBytes(12).toString('base64url') } = {}) {
  const centerRequire = createRequire(path.join(ROOT, 'center-server', 'package.json'));
  const Fastify = centerRequire('fastify');
  const multipart = centerRequire('@fastify/multipart');
  const { openCenterStore } = await centerModule('data/index.js');
  const { openHostBridge } = await centerModule('host-bridge.js');
  const { registerAuth } = await centerModule('auth.js');
  const { registerClientReleaseRoutes } = await centerModule('client-releases.js');

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-updater-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(7) });
  const bridge = openHostBridge({ dataRoot, store, linkUrl: 'wss://127.0.0.1:1', relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT });
  app.setErrorHandler((error, req, reply) => {
    let code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    reply.code(code === 'INTERNAL_ERROR' ? 500 : 400).send({ error: { code, message: error.message } });
  });
  const salt = randomBytes(16);
  const ownerPasswordHash = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
  await registerAuth(app, { sessionKey: randomBytes(32), ownerPasswordHash });
  await app.register(multipart, { limits: { files: 1, fileSize: UPLOAD_LIMIT, fields: 0 } });
  await registerClientReleaseRoutes(app, { store, dataRoot, registry: bridge.registry, internalDeviceId: bridge.deviceId, publicUrl: PUBLIC_URL });
  await app.ready();
  return {
    app,
    publicUrl: PUBLIC_URL,
    /** Owner session: `{ cookie, csrfToken }`. */
    async login() {
      let res = await app.inject({ method: 'GET', url: '/api/session' });
      let cookie = cookieOf(res);
      res = await app.inject({ method: 'POST', url: '/api/session', headers: { cookie, 'x-csrf-token': res.json().csrfToken }, payload: { password } });
      expectStatus(res, 200, 'owner login');
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

/** Center-import metadata from scripts/release-artifact.mjs (the release job's generator). */
function releaseMetadata({ file, version, platform, arch, format, commit }) {
  const run = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'release-artifact.mjs'),
    '--version', version, '--commit', commit, '--notes', `PiBot ${version}`,
    '--platform', platform, '--arch', arch, '--format', format, '--file', file,
  ], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`release-artifact.mjs rejected the artifact: ${run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}

/** Runs every check above; resolves to a summary or throws on the first failure. */
export async function verifyUpdaterArtifact({ file, publicKey, version, platform, arch, format, commit = '0'.repeat(40) }) {
  const bytes = fs.readFileSync(file);
  const signaturePath = `${file}.sig`;
  if (!fs.existsSync(signaturePath)) throw new Error(`missing ${signaturePath}`);
  const signature = fs.readFileSync(signaturePath, 'utf8');
  const fileName = path.basename(file);
  const signed = verifyUpdaterSignature({ bytes, signature, publicKey, fileName, version });
  if (bytes.length > UPLOAD_LIMIT) throw new Error(`artifact is ${bytes.length} bytes, above the center upload limit ${UPLOAD_LIMIT}`);

  const metadata = releaseMetadata({ file, version, platform, arch, format, commit });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (metadata.sha256 !== sha256 || metadata.size !== bytes.length) throw new Error('release metadata does not describe the artifact');

  const center = await openTestCenter();
  try {
    const { cookie, csrfToken } = await center.login();
    const owner = { cookie, 'x-csrf-token': csrfToken };
    const { body, contentType } = multipartBody(metadata, bytes, fileName);
    let res = expectStatus(await center.app.inject({ method: 'POST', url: '/api/client-releases', headers: { ...owner, 'content-type': contentType }, payload: body }), 201, 'upload');
    const record = res.json();
    const target = `/api/client-updates/${platform}/${arch}/${format}`;
    res = expectStatus(await center.app.inject({ method: 'GET', url: `${target}/0.0.1`, headers: { cookie } }), 204, 'query before publish');
    expectStatus(await center.app.inject({ method: 'POST', url: `/api/client-releases/${record.id}/publish`, headers: owner, payload: { published: true } }), 200, 'publish');

    res = expectStatus(await center.app.inject({ method: 'GET', url: `${target}/0.0.1`, headers: { cookie } }), 200, 'query from an older client');
    const offer = res.json();
    if (offer.version !== version || offer.sha256 !== sha256 || offer.size !== bytes.length) throw new Error(`center offered ${JSON.stringify(offer)}`);
    expectStatus(await center.app.inject({ method: 'GET', url: `${target}/${version}`, headers: { cookie } }), 204, 'query from a current client');

    const url = new URL(offer.url);
    if (url.origin !== center.publicUrl) throw new Error(`download URL ${offer.url} is not on the center`);
    res = expectStatus(await center.app.inject({ method: 'GET', url: url.pathname, headers: { cookie } }), 200, 'download');
    const served = res.rawPayload;
    if (!served.equals(bytes)) throw new Error('center served different bytes');
    verifyUpdaterSignature({ bytes: served, signature: offer.signature, publicKey, fileName, version });
    return { file: fileName, version, keyId: keyIdText(parsePublicKey(publicKey).keyId), size: bytes.length, sha256, timestamp: signed.timestamp, releaseId: record.id };
  } finally {
    await center.close();
  }
}

function cliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    if (!name || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[name] = argv[i + 1];
  }
  for (const key of ['file', 'public-key', 'version', 'platform', 'arch', 'format']) {
    if (!out[key]) throw new Error(`--${key} is required`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = cliArgs(process.argv.slice(2));
    const publicKey = args['public-key'].startsWith('@') ? fs.readFileSync(args['public-key'].slice(1), 'utf8') : args['public-key'];
    const summary = await verifyUpdaterArtifact({
      file: path.resolve(args.file), publicKey, version: args.version,
      platform: args.platform, arch: args.arch, format: args.format, commit: args.commit,
    });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (error) {
    console.error(`updater artifact check failed: ${error.message}`);
    process.exit(1);
  }
}
