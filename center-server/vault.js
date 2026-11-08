// center-server/vault.js
//
// Center-side external Vault (Vaultwarden) service. Owns a private state file
// (source, serverUrl, opaque secretRef -> provider itemId map, per-item Bot
// grants and the shared CAS revision) encrypted with the center key under its
// own AAD — never the generic credentials table or device snapshots. The
// adapter owns the bw process, account and lock state; secrets cross this
// module only inside resolve(), in local scope, straight back to the paired
// Host caller. No raw upstream error ever leaves the boundary.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openVaultwardenClient } from './vaultwarden-client.js';

const VAULT_PACKAGE_ID = 'e-launcher.vault';
const STATE_AAD = Buffer.from('center-vault-state-v1', 'utf8');
const IDLE_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 1000;
const MAX_FIND_ITEMS = 50;
const PROBE_TIMEOUT_MS = 5000;

const MESSAGES = Object.freeze({
  VAULT_INVALID_ARGUMENT: 'Invalid Vault request.',
  VAULT_NOT_CONFIGURED: 'External Vault is not configured.',
  VAULT_NEEDS_LOGIN: 'External Vault requires login.',
  VAULT_CONNECTION_FAILED: 'External Vault could not be reached.',
  VAULT_UNSUPPORTED: 'External Vault is not supported.',
  VAULT_STALE_SESSION: 'Vault state changed. Refresh and try again.',
  VAULT_CONFLICT: 'Vault changed. Refresh and try again.',
  VAULT_FORBIDDEN: 'Vault access is not permitted.',
  VAULT_UNLOCK_FAILED: 'Vault could not be unlocked.',
  VAULT_LOGIN_CHALLENGE: 'The account requires additional login verification.',
  VAULT_REQUEST_EXPIRED: 'Vault request expired.',
  VAULT_REQUEST_BUSY: 'Vault request is already being processed.',
  VAULT_NOT_FOUND: 'Vault item is unavailable.',
  VAULT_LOCKED: 'Vault is locked.',
  VAULT_NOT_INITIALIZED: 'Vault is not initialized.',
  VAULT_ALREADY_INITIALIZED: 'Vault is already initialized.',
  VAULT_UNAVAILABLE: 'Vault is unavailable.',
});
function vaultError(code) {
  return Object.assign(new Error(MESSAGES[code] ?? MESSAGES.VAULT_UNAVAILABLE), {
    code: Object.hasOwn(MESSAGES, code) ? code : 'VAULT_UNAVAILABLE',
  });
}
const fail = (code) => { throw vaultError(code); };
const failCode = (code, message) => { throw Object.assign(new Error(message), { code }); };
/** Adapter/upstream exceptions never cross: an allowlisted code with our fixed message, else the fallback. */
const clean = (error, fallback) =>
  vaultError(typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code) ? error.code : fallback);

const bound = (value, max, min = 1) =>
  typeof value === 'string' && value.isWellFormed() && value.length >= min && value.length <= max
    ? value : fail('VAULT_INVALID_ARGUMENT');
const int = (value) => Number.isSafeInteger(value) && value >= 0 ? value : fail('VAULT_INVALID_ARGUMENT');
const shape = (raw, fields) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !fields.includes(key))) fail('VAULT_INVALID_ARGUMENT');
  return raw;
};

const CONTROL_FIELDS = Object.freeze({
  status: [], check: [], list: [], logout: [], lock: [], sync: [],
  configure: ['expectedRevision', 'source', 'serverUrl', 'email'],
  unlock: ['masterPassword', 'expectedEpoch'],
  setGrants: ['expectedRevision', 'secretRef', 'allowedBots'],
});
function normalizeGrants(raw) {
  if (!Array.isArray(raw) || raw.length > 256) fail('VAULT_INVALID_ARGUMENT');
  const seen = new Set();
  return raw.map(grant => {
    shape(grant, ['deviceId', 'botId']);
    const value = { deviceId: bound(grant.deviceId, 128), botId: bound(grant.botId, 128) };
    const key = value.deviceId + '\0' + value.botId;
    if (seen.has(key)) fail('VAULT_INVALID_ARGUMENT');
    seen.add(key);
    return value;
  });
}
function normalizeControl(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(CONTROL_FIELDS, raw.action)) {
    fail('VAULT_INVALID_ARGUMENT');
  }
  shape(raw, ['action', ...CONTROL_FIELDS[raw.action]]);
  switch (raw.action) {
    case 'configure': {
      if (!['local', 'vaultwarden'].includes(raw.source)) fail('VAULT_INVALID_ARGUMENT');
      const value = { action: 'configure', expectedRevision: int(raw.expectedRevision), source: raw.source };
      if (raw.serverUrl !== undefined) value.serverUrl = bound(raw.serverUrl, 512);
      if (raw.email !== undefined) value.email = emailOf(raw.email);
      return value;
    }
    case 'unlock':
      return { action: 'unlock', masterPassword: bound(raw.masterPassword, 1024), expectedEpoch: bound(raw.expectedEpoch, 128) };
    case 'setGrants':
      return { action: 'setGrants', expectedRevision: int(raw.expectedRevision), secretRef: bound(raw.secretRef, 128), allowedBots: normalizeGrants(raw.allowedBots) };
    default:
      return { action: raw.action };
  }
}
/** Administrator-configured endpoint: HTTPS origin only — no plain HTTP, credentials, path or query. */
function serverUrlOf(value) {
  let url;
  try { url = new URL(bound(value, 512)); } catch { fail('VAULT_INVALID_ARGUMENT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('VAULT_INVALID_ARGUMENT');
  }
  return url.origin;
}

function emailOf(raw) {
  const email = bound(raw, 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) fail('VAULT_INVALID_ARGUMENT');
  return email;
}

export async function openCenterVault({ dataRoot, encryptionKey, store, client: injected }) {
  if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) {
    throw Object.assign(new Error('encryptionKey must contain 32 bytes'), { code: 'INVALID_ARGUMENT' });
  }
  const key = Buffer.from(encryptionKey);
  const directory = join(dataRoot, 'vault');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const statePath = join(directory, 'state.json');

  function load() {
    let record;
    try { record = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { revision: 0, source: 'local', serverUrl: null, email: null, entries: {} };
      throw error;
    }
    // An unreadable or tampered state must fail closed — silently resetting to
    // local would be an implicit fallback the operator never asked for.
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64'));
      decipher.setAAD(STATE_AAD);
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          !Number.isSafeInteger(value.revision) || value.revision < 0 ||
          !['local', 'vaultwarden'].includes(value.source) ||
          (value.serverUrl !== null && typeof value.serverUrl !== 'string') ||
          (value.email != null && typeof value.email !== 'string') ||
          !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) ||
          Object.values(value.entries).some(entry => !entry || typeof entry !== 'object' ||
            typeof entry.itemId !== 'string' || typeof entry.label !== 'string' || typeof entry.username !== 'string' ||
            !Array.isArray(entry.allowedBots) || entry.allowedBots.some(g => !g || typeof g.deviceId !== 'string' || typeof g.botId !== 'string'))) {
        throw new Error('invalid vault state');
      }
      value.email ??= null;
      return value;
    } catch {
      throw new Error('Center vault state is unreadable; refusing an implicit fallback');
    }
  }
  function persist() {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(STATE_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    const tmp = statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify({
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }), { mode: 0o600 });
    renameSync(tmp, statePath);
  }

  const state = load();
  // The epoch exists only in memory: every start, lock and configuration or
  // grant change mints a new one so stale resolve tickets can never replay.
  // revGen is the request-time counterpart: it invalidates an in-flight unlock
  // the moment a revoker is asked, before its queue slot ever runs.
  let epoch = randomBytes(16).toString('base64url');
  const rekey = () => { epoch = randomBytes(16).toString('base64url'); };
  let revGen = 0;
  let expiresAt = null;
  const expired = () => expiresAt !== null && Date.now() >= Date.parse(expiresAt);
  let closed = false;

  let idleTimer = null;
  const clearIdle = () => { if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; } };
  function touch() {
    if (closed) return;
    expiresAt = new Date(Date.now() + IDLE_MS).toISOString();
    clearIdle();
    idleTimer = setTimeout(onIdle, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }
  function onIdle() {
    idleTimer = null;
    if (closed || expiresAt === null || Date.now() < Date.parse(expiresAt)) return;
    // Real expiry: revoke the epoch and window immediately, then queue the
    // adapter lock; a failed lock closes the decryption context entirely.
    expiresAt = null;
    revGen++;
    rekey();
    void serialized(async () => {
      if (state.source !== 'vaultwarden' || !client) return;
      await lockAdapter(client);
    });
  }

  // The adapter is created lazily: a missing bw or a broken runtime must never
  // stop the whole center — local mode never spawns the CLI at all.
  let client = injected ?? null;
  let clientOpening = null;
  async function getClient() {
    if (closed) fail('VAULT_UNAVAILABLE');
    if (client) return client;
    if (!clientOpening) {
      clientOpening = openVaultwardenClient({ dataRoot: join(directory, 'vaultwarden'), encryptionKey: key })
        .then(opened => {
          // An open that lands after close() must never leave a live adapter behind.
          if (closed) { opened.close().catch(() => {}); return client; }
          return (client = opened);
        }, error => { clientOpening = null; throw clean(error, 'VAULT_UNSUPPORTED'); });
    }
    return clientOpening;
  }
  async function closeAdapter(c) {
    if (client === c) { client = null; clientOpening = null; adapterReady = false; }
    if (c) await c.close().catch(() => {});
  }
  /** A failed adapter lock must not leave a decryption context behind. */
  async function lockAdapter(c) {
    try { await c.lock(); }
    catch { await closeAdapter(c); }
  }
  let adapterReady = false;

  // Session, configuration and grant operations share one serialized lane so a
  // queued lock/configure can never interleave with an in-flight unlock.
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const run = queue.then(fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function ensureAdapter() {
    if (state.source !== 'vaultwarden' || state.serverUrl === null || state.email === null) fail('VAULT_NOT_CONFIGURED');
    const c = await getClient();
    if (!adapterReady) {
      try { await c.configure({ serverUrl: state.serverUrl, email: state.email }); adapterReady = true; }
      catch (error) { adapterReady = false; throw clean(error, 'VAULT_CONNECTION_FAILED'); }
    }
    return c;
  }
  async function adapterStatus(c) {
    let current;
    try { current = await c.status(); }
    catch (error) { throw clean(error, 'VAULT_CONNECTION_FAILED'); }
    if (!current || typeof current !== 'object' || Array.isArray(current)) fail('VAULT_UNAVAILABLE');
    return current;
  }
  async function requireSession() {
    if (state.email === null) fail('VAULT_NOT_CONFIGURED');
    const c = await ensureAdapter();
    const current = await adapterStatus(c);
    if (current.authenticated !== true) fail('VAULT_NEEDS_LOGIN');
    // Only a center-tracked unlock window counts; an out-of-band unlocked
    // session without a center expiry is re-locked rather than trusted.
    if (current.locked === true || expiresAt === null || expired()) {
      if (current.locked !== true) await lockAdapter(c);
      expiresAt = null;
      fail('VAULT_LOCKED');
    }
    return c;
  }
  const checkAlive = (signal) => {
    if (closed) fail('VAULT_UNAVAILABLE');
    if (signal?.aborted) fail('VAULT_REQUEST_EXPIRED');
  };

  function statusShape(current) {
    const configured = state.source === 'vaultwarden' && state.serverUrl !== null && state.email !== null;
    const authenticated = configured && current?.authenticated === true;
    const locked = !authenticated || current?.locked !== false;
    return {
      source: state.source,
      revision: state.revision,
      configured,
      authenticated,
      locked,
      expiresAt: authenticated && !locked ? expiresAt : null,
      serverUrl: state.serverUrl,
      email: state.email,
      accountId: authenticated && typeof current.accountId === 'string' ? current.accountId : null,
      lastSyncAt: authenticated && typeof current.lastSyncAt === 'string' ? current.lastSyncAt : null,
      epoch,
    };
  }
  async function statusOp() {
    let current = null;
    if (state.source === 'vaultwarden' && state.email !== null) {
      const c = await ensureAdapter();
      // A dead adapter is a connection error, not a fake "needs login".
      current = await adapterStatus(c);
      if (current.authenticated === true && current.locked === false) {
        // Status does not renew the idle window; an expired or untracked session is locked on sight.
        if (expiresAt === null || expired()) {
          await lockAdapter(c);
          expiresAt = null;
          current = { ...current, locked: true };
        }
      } else expiresAt = null;
    } else expiresAt = null;
    return statusShape(current);
  }
  /** Bounded anonymous probe of the configured HTTPS service — no credentials, no redirects. */
  async function probe() {
    if (state.source !== 'vaultwarden' || state.serverUrl === null) return false;
    try {
      const response = await fetch(new URL('/api/config', state.serverUrl), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      await response.body?.cancel().catch(() => {});
      return response.ok;
    } catch { return false; }
  }
  async function checkOp() {
    // Reachability is the anonymous HTTP probe alone; login/lock state is
    // reported separately in status — never conflated.
    return { reachable: await probe(), status: await statusOp() };
  }
  async function configureOp(input) {
    if (input.expectedRevision !== state.revision) fail('VAULT_CONFLICT');
    const serverUrl = input.source === 'vaultwarden' ? serverUrlOf(input.serverUrl ?? state.serverUrl) : state.serverUrl;
    const email = input.source === 'vaultwarden' ? emailOf(input.email ?? state.email) : state.email;
    // A source, URL or email change locks the session and revokes every stored item
    // reference and grant before the new configuration is saved. The revoke
    // happens only on a real switch — a CAS failure changes nothing.
    if (input.source !== state.source || (input.source === 'vaultwarden' && (serverUrl !== state.serverUrl || email !== state.email))) {
      if (client) await lockAdapter(client);
      state.entries = {};
      expiresAt = null;
      revGen++;
      rekey();
    }
    state.source = input.source;
    state.serverUrl = serverUrl;
    state.email = email;
    state.revision += 1;
    persist();
    // An explicit switch to external never falls back to local: the choice is
    // already persisted, and a failed bring-up reports a fixed error.
    if (input.source === 'vaultwarden') {
      const c = await getClient();
      try { await c.configure({ serverUrl, email }); adapterReady = true; }
      catch (error) { adapterReady = false; throw clean(error, 'VAULT_CONNECTION_FAILED'); }
    }
    return statusOp();
  }
  async function logoutOp() {
    const c = await ensureAdapter();
    // Local revocation must outlive a failed upstream logout.
    await c.logout().catch(() => {});
    state.entries = {};
    state.revision += 1;
    persist();
    rekey();
    expiresAt = null;
    return statusOp();
  }
  async function unlockOp(input, signal) {
    if (input.expectedEpoch !== epoch) fail('VAULT_STALE_SESSION');
    if (state.email === null) fail('VAULT_NOT_CONFIGURED');
    const c = await ensureAdapter();
    const current = await adapterStatus(c);
    const guard = revGen;
    try {
      // First sign-in happens only after the user submits the private unlock form.
      if (current.authenticated !== true) {
        await c.login({ email: state.email, masterPassword: input.masterPassword, signal });
      }
      if (guard !== revGen || input.expectedEpoch !== epoch) fail('VAULT_STALE_SESSION');
      checkAlive(signal);
      await c.unlock({ masterPassword: input.masterPassword });
    } catch (error) {
      await lockAdapter(c);
      checkAlive(signal);
      throw clean(error, 'VAULT_UNLOCK_FAILED');
    }
    // A revoke or cancel that slipped past the unlock must never keep the key:
    // lock first, then report the fixed error.
    if (guard !== revGen || input.expectedEpoch !== epoch || signal?.aborted || closed) {
      await lockAdapter(c);
      expiresAt = null;
      checkAlive(signal);
      fail('VAULT_STALE_SESSION');
    }
    touch();
    return statusOp();
  }
  async function lockOp() {
    const c = await ensureAdapter();
    try { await c.lock(); }
    catch (error) {
      // Even on failure the center-side session is dead and the adapter context is closed.
      expiresAt = null;
      rekey();
      await closeAdapter(c);
      throw clean(error, 'VAULT_UNAVAILABLE');
    }
    expiresAt = null;
    rekey();
    return statusOp();
  }
  async function syncOp() {
    const c = await requireSession();
    let items;
    try {
      await c.sync();
      items = await c.listItems();
    } catch (error) { throw clean(error, 'VAULT_CONNECTION_FAILED'); }
    if (!Array.isArray(items)) fail('VAULT_UNAVAILABLE');
    const previous = new Map(Object.entries(state.entries).map(([ref, entry]) => [entry.itemId, { ref, entry }]));
    const keep = (item) => ({
      itemId: item.itemId,
      label: typeof item.label === 'string' ? item.label : '',
      username: typeof item.username === 'string' ? item.username : '',
      allowedBots: previous.get(item.itemId)?.entry.allowedBots ?? [],
    });
    const entries = {};
    // Upstream-confirmed removals drop the ref and its grants; surviving items
    // keep their ref and grants; new items start ungranted.
    for (const item of items) {
      if (!item || typeof item.itemId !== 'string') continue;
      const known = previous.get(item.itemId);
      if (known) entries[known.ref] = keep(item);
    }
    for (const item of items) {
      if (Object.keys(entries).length >= MAX_ENTRIES) break;
      if (!item || typeof item.itemId !== 'string' || previous.has(item.itemId)) continue;
      entries['vw-' + randomBytes(16).toString('base64url')] = keep(item);
    }
    state.entries = entries;
    state.revision += 1;
    persist();
    // A committed sync invalidates every in-flight resolve epoch.
    rekey();
    touch();
    return statusOp();
  }
  async function listOp() {
    if (state.source !== 'vaultwarden') fail('VAULT_NOT_CONFIGURED');
    await requireSession();
    return {
      revision: state.revision,
      items: Object.entries(state.entries).map(([secretRef, entry]) => ({
        secretRef, label: entry.label, username: entry.username,
        allowedBots: entry.allowedBots.map(grant => ({ deviceId: grant.deviceId, botId: grant.botId })),
      })).sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    };
  }
  async function grantsOp(input) {
    if (state.source !== 'vaultwarden') fail('VAULT_NOT_CONFIGURED');
    await requireSession();
    if (input.expectedRevision !== state.revision) fail('VAULT_CONFLICT');
    const entry = state.entries[input.secretRef];
    if (!entry) fail('VAULT_NOT_FOUND');
    for (const grant of input.allowedBots) {
      if (!store.listDeviceBots(grant.deviceId).some(bot => bot.botId === grant.botId)) {
        failCode('BOT_NOT_FOUND', 'Bot not found');
      }
    }
    entry.allowedBots = input.allowedBots;
    state.revision += 1;
    persist();
    rekey();
    touch();
    return statusOp();
  }

  function assertScope(deviceId, botId, installationId) {
    const bot = store.listDeviceBots(deviceId).find(item => item.botId === botId);
    if (!bot) failCode('BOT_NOT_FOUND', 'Bot not found');
    if (bot.archivedAt) failCode('BOT_ARCHIVED', 'Bot is archived');
    const installation = store.getInstallation(installationId);
    if (!installation || installation.packageId !== VAULT_PACKAGE_ID || installation.kind !== 'plugin' ||
        installation.target !== 'host' || !store.isActive(installation) ||
        !store.getBotCapability(deviceId, botId, installationId).enabled) {
      fail('VAULT_FORBIDDEN');
    }
  }

  async function find(raw) {
    shape(raw, ['deviceId', 'botId', 'installationId', 'query']);
    const deviceId = bound(raw.deviceId, 128);
    const botId = bound(raw.botId, 128);
    const installationId = bound(raw.installationId, 128);
    const needle = (raw.query === undefined ? '' : bound(raw.query, 200, 0)).toLowerCase();
    return serialized(async () => {
      assertScope(deviceId, botId, installationId);
      if (state.source !== 'vaultwarden') fail('VAULT_NOT_CONFIGURED');
      await requireSession();
      const items = Object.entries(state.entries)
        .filter(([, entry]) => entry.allowedBots.some(g => g.deviceId === deviceId && g.botId === botId))
        .map(([secretRef, entry]) => ({ secretRef, label: entry.label, username: entry.username }))
        .filter(item => needle === '' || item.label.toLowerCase().includes(needle) || item.username.toLowerCase().includes(needle))
        .sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
        .slice(0, MAX_FIND_ITEMS);
      return { items };
    });
  }

  async function resolve(raw) {
    shape(raw, ['deviceId', 'botId', 'installationId', 'secretRef', 'expectedEpoch']);
    const deviceId = bound(raw.deviceId, 128);
    const botId = bound(raw.botId, 128);
    const installationId = bound(raw.installationId, 128);
    const secretRef = bound(raw.secretRef, 128);
    const expectedEpoch = bound(raw.expectedEpoch, 128);
    if (closed) fail('VAULT_UNAVAILABLE');
    assertScope(deviceId, botId, installationId);
    if (state.source !== 'vaultwarden') fail('VAULT_NOT_CONFIGURED');
    if (expectedEpoch !== epoch) fail('VAULT_STALE_SESSION');
    return serialized(async () => {
      // Every check re-runs inside the lane and again after each await: a queued
      // revoke, account switch, entry removal or binding change must never hand
      // out the password, and no pre-queue entry object is trusted for the lookup.
      const verify = () => {
        if (closed) fail('VAULT_UNAVAILABLE');
        assertScope(deviceId, botId, installationId);
        if (state.source !== 'vaultwarden') fail('VAULT_NOT_CONFIGURED');
        if (expectedEpoch !== epoch) fail('VAULT_STALE_SESSION');
        const entry = state.entries[secretRef];
        if (!entry) fail('VAULT_NOT_FOUND');
        if (!entry.allowedBots.some(g => g.deviceId === deviceId && g.botId === botId)) fail('VAULT_FORBIDDEN');
        return entry;
      };
      verify();
      const c = await requireSession();
      const entry = verify();
      const value = await c.getPassword({ itemId: entry.itemId })
        .catch(error => { throw clean(error, 'VAULT_UNAVAILABLE'); });
      verify();
      if (typeof value !== 'string' || value.length === 0) fail('VAULT_UNAVAILABLE');
      touch();
      return { password: value, epoch };
    });
  }

  // Revoke before queuing so an in-flight first login cannot restore an unlock.
  const HARD_REVOKERS = new Set(['lock', 'logout']);
  async function control(raw, options) {
    if (closed) fail('VAULT_UNAVAILABLE');
    const input = normalizeControl(raw);
    const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
    if (HARD_REVOKERS.has(input.action)) {
      revGen++;
      rekey();
      expiresAt = null;
    }
    checkAlive(signal);
    return serialized(async () => {
      checkAlive(signal);
      switch (input.action) {
        case 'status': return statusOp();
        case 'check': return checkOp();
        case 'configure': return configureOp(input);
        case 'logout': return logoutOp();
        case 'unlock': return unlockOp(input, signal);
        case 'lock': return lockOp();
        case 'sync': return syncOp();
        case 'list': return listOp();
        case 'setGrants': return grantsOp(input);
      }
    });
  }

  return {
    control, find, resolve,
    async close() {
      if (closed) return;
      closed = true;
      revGen++;
      rekey();
      expiresAt = null;
      clearIdle();
      await closeAdapter(client);
    },
  };
}
