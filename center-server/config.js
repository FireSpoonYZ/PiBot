// center-server/config.js
// Pre-store bootstrap resolution. Classifies how the center may start before
// any store is opened: a complete legacy env or a persisted center-config.json
// starts immediately, a truly empty data root (or this feature's own setup
// files) enters first-run onboarding, and existing data without configuration
// refuses to start rather than silently rotating keys.

import { randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';

export const CENTER_CONFIG_FILE = 'center-config.json';
export const CENTER_SETUP_TOKEN_FILE = 'center-setup-token';
// Unique per-attempt tmp names written by writeCenterConfig below; a crashed
// attempt leaves one behind without ever making the data root "foreign".
const CENTER_CONFIG_TMP_PATTERN = /^center-config\.json\.\d+\.[0-9a-f]{12}\.tmp$/;
// A data root holding only these entries still counts as new: this feature's
// own setup state plus common filesystem noise, never center data.
const SETUP_STATE_FILES = new Set([CENTER_SETUP_TOKEN_FILE, 'lost+found', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const isSetupStateEntry = (entry) => SETUP_STATE_FILES.has(entry) || CENTER_CONFIG_TMP_PATTERN.test(entry);

const HEX64 = /^[0-9a-f]{64}$/i;
const OWNER_HASH_FORMAT = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/i;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function hexKey(value, name) {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new Error(name + ' must be 32 bytes in hex');
  return Buffer.from(value, 'hex');
}

function checkedKeys(encryptionKeyHex, sessionKeyHex, label) {
  const encryptionKey = hexKey(encryptionKeyHex, label + ' encryption key');
  const sessionKey = hexKey(sessionKeyHex, label + ' session key');
  if (encryptionKey.equals(sessionKey)) throw new Error(label + ' encryption and session keys must be independent');
  return { encryptionKey, sessionKey };
}

function checkedHash(ownerPasswordHash, label) {
  if (typeof ownerPasswordHash !== 'string' || !OWNER_HASH_FORMAT.test(ownerPasswordHash)) {
    throw new Error(label + ' owner password hash must be scrypt$<16-byte salt hex>$<64-byte key hex>');
  }
  return ownerPasswordHash;
}

function boundedUrl(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || value.trim() !== value) throw invalid(name + ' must be a URL string');
  let url;
  try { url = new URL(value); } catch { throw invalid(name + ' must be a valid URL'); }
  if (url.username || url.password || url.search || url.hash) throw invalid(name + ' must not contain credentials, query or fragment');
  return url;
}

/** Public center URL reachable by devices; always https even in proxy TLS mode.
 *  Clients (host-core validateCenterUrl) accept an origin root only, so a
 *  path-prefixed URL must be rejected here instead of persisted unusable. */
export function normalizePublicUrl(value, name = 'publicUrl') {
  const url = boundedUrl(value, name);
  if (url.protocol !== 'https:') throw invalid(name + ' must be an https URL');
  if (url.pathname !== '' && url.pathname !== '/') throw invalid(name + ' must be an https origin without a path');
  return url.href.replace(/\/+$/, '');
}

/** Public relay link URL reachable by devices; always wss even in proxy TLS mode. */
export function normalizeLinkUrl(value, name = 'linkUrl') {
  const url = boundedUrl(value, name);
  if (url.protocol !== 'wss:') throw invalid(name + ' must be a wss URL');
  return url.href.replace(/\/+$/, '');
}

/** Same-origin default: the relay upgrade path is fixed at /v1/link. */
export function deriveLinkUrl(publicUrl) {
  return 'wss://' + new URL(publicUrl).host + '/v1/link';
}

/** Same scrypt format produced by the CLI password-hash command. */
export function hashOwnerPassword(password) {
  const salt = randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + scryptSync(password, salt, 64).toString('hex');
}

function loadCenterConfigFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Parse errors may embed raw file fragments; surface path + recovery only.
      throw new Error(path + ' is not valid JSON; restore the original ' + CENTER_CONFIG_FILE + ' (it cannot be regenerated without losing access to stored credentials)');
    }
    throw new Error(path + ' cannot be read' + (typeof error.code === 'string' ? ': ' + error.code : ''));
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) throw new Error(path + ' is not a version:1 center configuration');
  const { encryptionKey, sessionKey } = checkedKeys(parsed.encryptionKeyHex, parsed.sessionKeyHex, path);
  return {
    version: 1,
    encryptionKey, sessionKey,
    encryptionKeyHex: String(parsed.encryptionKeyHex).toLowerCase(),
    sessionKeyHex: String(parsed.sessionKeyHex).toLowerCase(),
    ownerPasswordHash: checkedHash(parsed.ownerPasswordHash, path),
    publicUrl: normalizePublicUrl(parsed.publicUrl, path + ' publicUrl'),
    linkUrl: deriveLinkUrl(normalizePublicUrl(parsed.publicUrl)),
  };
}

/**
 * Resolves the startup plan without opening any store.
 * mode 'start': config is complete (persisted file or full legacy env).
 * mode 'setup': data root is new; run first-run onboarding.
 * URL precedence: explicit CENTER_PUBLIC_URL env wins over a
 * persisted or submitted value; credential envs may only match the file.
 */
export function resolveCenterPlan(env) {
  const dataRoot = env.CENTER_DATA_ROOT || '/data';
  if (!isAbsolute(dataRoot)) throw new Error('CENTER_DATA_ROOT must be an absolute path');
  const listenHost = env.CENTER_LISTEN_HOST || '0.0.0.0';
  if (isIP(listenHost) === 0) throw new Error('CENTER_LISTEN_HOST must be a literal IP address');
  const plan = {
    dataRoot,
    listenHost,
    port: checkedPort(env.CENTER_PORT || 8080, 'CENTER_PORT'),
    trustProxy: parseTrustProxy(env.CENTER_TRUST_PROXY),
    webRoot: env.CENTER_WEB_ROOT || '/app/center-web/dist',
    npmPath: env.CENTER_NPM_PATH,
  };

  const envEncryptionHex = env.CENTER_ENCRYPTION_KEY_HEX;
  const envSessionHex = env.CENTER_SESSION_KEY_HEX;
  const envOwnerHash = env.CENTER_OWNER_PASSWORD_HASH;
  const envPublicUrl = env.CENTER_PUBLIC_URL ? normalizePublicUrl(env.CENTER_PUBLIC_URL, 'CENTER_PUBLIC_URL') : undefined;
  const envLinkUrl = envPublicUrl ? deriveLinkUrl(envPublicUrl) : undefined;

  const configPath = join(dataRoot, CENTER_CONFIG_FILE);
  if (existsSync(configPath)) {
    const file = loadCenterConfigFile(configPath);
    for (const [name, envValue, fileValue] of [
      ['CENTER_ENCRYPTION_KEY_HEX', envEncryptionHex, file.encryptionKeyHex],
      ['CENTER_SESSION_KEY_HEX', envSessionHex, file.sessionKeyHex],
      ['CENTER_OWNER_PASSWORD_HASH', envOwnerHash, file.ownerPasswordHash],
    ]) {
      if (envValue !== undefined && envValue !== '' && envValue.toLowerCase() !== fileValue.toLowerCase()) {
        throw new Error(name + ' conflicts with ' + configPath + '; remove the env override or restore the original managed value. Refusing to change configured keys.');
      }
    }
    plan.mode = 'start';
    plan.config = {
      encryptionKey: file.encryptionKey,
      sessionKey: file.sessionKey,
      ownerPasswordHash: file.ownerPasswordHash,
      publicUrl: envPublicUrl ?? file.publicUrl,
      linkUrl: deriveLinkUrl(envPublicUrl ?? file.publicUrl),
    };
    return plan;
  }

  const credentialCount = [envEncryptionHex, envSessionHex, envOwnerHash].filter((value) => value !== undefined && value !== '').length;
  if (credentialCount === 3) {
    // Complete legacy env: starts as-is, no migration and no setup token.
    if (!envPublicUrl) throw new Error('CENTER_PUBLIC_URL is required');
    const { encryptionKey, sessionKey } = checkedKeys(envEncryptionHex, envSessionHex, 'env');
    plan.mode = 'start';
    plan.config = {
      encryptionKey, sessionKey,
      ownerPasswordHash: checkedHash(envOwnerHash, 'env'),
      publicUrl: envPublicUrl,
      linkUrl: envLinkUrl,
    };
    return plan;
  }
  if (credentialCount > 0) {
    const missing = [
      envEncryptionHex ? null : 'CENTER_ENCRYPTION_KEY_HEX',
      envSessionHex ? null : 'CENTER_SESSION_KEY_HEX',
      envOwnerHash ? null : 'CENTER_OWNER_PASSWORD_HASH',
    ].filter(Boolean);
    throw new Error('Incomplete center credential env: missing ' + missing.join(', ') + '; provide all of CENTER_ENCRYPTION_KEY_HEX, CENTER_SESSION_KEY_HEX and CENTER_OWNER_PASSWORD_HASH or none');
  }

  let entries = [];
  if (existsSync(dataRoot)) {
    try { entries = readdirSync(dataRoot); }
    catch (error) { throw new Error('CENTER_DATA_ROOT ' + dataRoot + ' cannot be listed: ' + error.message); }
  }
  const foreign = entries.filter((entry) => !isSetupStateEntry(entry));
  if (foreign.length > 0) {
    throw new Error(
      dataRoot + ' already contains center data (' + foreign.slice(0, 3).join(', ') + (foreign.length > 3 ? ', ...' : '') + ') but no ' + CENTER_CONFIG_FILE + '; '
      + 'refusing to generate new keys over existing data. Restore the original ' + CENTER_CONFIG_FILE + ', or provide CENTER_ENCRYPTION_KEY_HEX, '
      + 'CENTER_SESSION_KEY_HEX, CENTER_OWNER_PASSWORD_HASH, CENTER_PUBLIC_URL to start.',
    );
  }
  // Env-provided defaults get persisted verbatim by setup; a link URL the
  // relay could never serve must fail here, not during the one-shot submit.
  if (envLinkUrl !== undefined && new URL(envLinkUrl).pathname !== '/v1/link') {
    throw new Error('CENTER_LINK_URL must end with /v1/link');
  }
  plan.mode = 'setup';
  plan.setupDefaults = { publicUrl: envPublicUrl, linkUrl: envLinkUrl };
  return plan;
}

/** openCenterServer options for a resolved plan plus its effective config. */
export function centerServerOptions(plan, config) {
  return {
    dataRoot: plan.dataRoot,
    encryptionKey: config.encryptionKey,
    sessionKey: config.sessionKey,
    ownerPasswordHash: config.ownerPasswordHash,
    publicUrl: config.publicUrl,
    listenHost: plan.listenHost,
    port: plan.port,
    webRoot: plan.webRoot,
    npmPath: plan.npmPath,
    trustProxy: plan.trustProxy,
  };
}

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

function checkedPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(name + ' must be an integer between 0 and 65535');
  return port;
}

/**
 * Atomic create-only write of center-config.json (0600). The tmp file is
 * unique per attempt and opened 'wx': it is never reused or truncated, so a
 * racing or repeated submit can only fail its own linkSync(EEXIST) and can
 * never rewrite an already hardlinked target inode. Requires a
 * hardlink-capable data volume (ext4/btrfs/overlay/NFS/NTFS).
 */
export function writeCenterConfig(dataRoot, record) {
  const target = join(dataRoot, CENTER_CONFIG_FILE);
  const tmp = join(dataRoot, 'center-config.json.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp');
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, target);
    } catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('Center configuration already exists'), { code: 'REQUEST_CONFLICT' });
      throw error;
    }
  } finally {
    // Only ever removes this attempt's own tmp name.
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
  try {
    const dir = openSync(dataRoot, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* directory fsync is best-effort durability */ }
}

/** One-time setup token: stable across restarts, 0600, never served over the API. */
export function loadOrCreateSetupToken(dataRoot) {
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, CENTER_SETUP_TOKEN_FILE);
  try {
    const token = readFileSync(path, 'utf8').trim();
    if (!HEX64.test(token)) throw new Error(path + ' is corrupt; delete the file to generate a new setup token');
    return { token, path, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    writeFileSync(path, token + '\n', { flag: 'wx', mode: 0o600 });
    return { token, path, created: true };
  }
}
