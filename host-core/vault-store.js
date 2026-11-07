import { scrypt, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeVaultControl, normalizeVaultItem, vaultError, safeVaultError, VAULT_MAX_ITEMS } from './vault-protocol.js';

const derive = promisify(scrypt);
const KDF = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const IDLE_MS = 15 * 60 * 1000;
function header(salt, revision) { return { version: 1, kdf: KDF, salt, revision }; }
function aad(value) { return Buffer.from(JSON.stringify(header(value.salt, value.revision))); }
function decode(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw vaultError('VAULT_UNLOCK_FAILED');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw vaultError('VAULT_UNLOCK_FAILED');
  return bytes;
}
function envelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['version', 'kdf', 'salt', 'revision', 'nonce', 'tag', 'data'].includes(key))) {
    throw vaultError('VAULT_UNLOCK_FAILED');
  }
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !value.kdf || Object.keys(KDF).some(key => value.kdf[key] !== KDF[key]) ||
      Object.keys(value.kdf).length !== 4) throw vaultError('VAULT_UNLOCK_FAILED');
  decode(value.salt, 16); decode(value.nonce, 12); decode(value.tag, 16); decode(value.data);
  return value;
}
function encrypt(doc, key, salt) {
  const value = header(salt, doc.revision);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(value));
  const plain = Buffer.from(JSON.stringify(doc));
  try {
    return { ...value, nonce: nonce.toString('base64'),
      data: Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('base64') };
  } finally { plain.fill(0); }
}
function decrypt(value, key) {
  let plain;
  let chunk;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(value.nonce, 12));
    decipher.setAAD(aad(value)); decipher.setAuthTag(decode(value.tag, 16));
    chunk = decipher.update(decode(value.data));
    plain = Buffer.concat([chunk, decipher.final()]);
    const doc = JSON.parse(plain.toString('utf8'));
    if (doc.revision !== value.revision || !Array.isArray(doc.items) || doc.items.length > VAULT_MAX_ITEMS) throw 0;
    const refs = new Set();
    for (const item of doc.items) {
      normalizeVaultItem({ secretRef: item.secretRef, label: item.label, username: item.username,
        password: item.password, allowedBotIds: item.allowedBotIds });
      if (typeof item.secretRef !== 'string' || !item.secretRef || refs.has(item.secretRef) ||
          typeof item.username !== 'string' || typeof item.password !== 'string' || !item.password ||
          typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') throw 0;
      refs.add(item.secretRef);
    }
    return doc;
  } catch { throw vaultError('VAULT_UNLOCK_FAILED'); }
  finally { plain?.fill(0); chunk?.fill(0); }
}
function meta(item) {
  return { secretRef: item.secretRef, label: item.label, username: item.username,
    allowedBotIds: [...item.allowedBotIds], createdAt: item.createdAt, updatedAt: item.updatedAt };
}

export async function openVaultStore({ dataRoot, isLocalBot }) {
  const directory = join(dataRoot, 'vault');
  const path = join(directory, 'vault.json');
  let encrypted = null;
  let damaged = false;
  let exists = false;
  try {
    const file = await open(path, 'r');
    exists = true;
    try {
      if ((await file.stat()).size > MAX_FILE_BYTES) throw 0;
      encrypted = envelope(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== 'ENOENT') { exists = true; damaged = true; }
  }
  let key = null;
  let timer = null;
  let expiresAt = null;
  let epoch = 0;
  let closed = false;
  let tail = Promise.resolve();
  function lock() {
    epoch++;
    clearTimeout(timer); timer = null; expiresAt = null;
    key?.fill(0); key = null;
    return status();
  }
  function status() {
    if (key && Date.now() >= expiresAt) lock();
    return { initialized: exists, locked: key === null, revision: encrypted?.revision ?? 0,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
  }
  function touch() {
    clearTimeout(timer);
    expiresAt = Date.now() + IDLE_MS;
    timer = setTimeout(lock, IDLE_MS); timer.unref?.();
  }
  function guard(ticket) {
    if (closed || epoch !== ticket) throw vaultError('VAULT_LOCKED');
  }
  function unlocked(ticket) {
    status(); guard(ticket);
    if (!key) throw vaultError('VAULT_LOCKED');
  }
  function serial(operation) {
    const ticket = epoch;
    const running = tail.then(() => { guard(ticket); return operation(ticket); });
    tail = running.catch(() => {});
    return running.catch(error => { throw safeVaultError(error); });
  }
  async function persist(value, ticket, assertCurrent) {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw vaultError('VAULT_INVALID_ARGUMENT');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, randomUUID() + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      guard(ticket);
      assertCurrent?.();
      await rename(temporary, path);
      encrypted = value; exists = true;
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function read(ticket) { unlocked(ticket); return decrypt(encrypted, key); }
  function permitted(doc, secretRef, botId) {
    const item = doc.items.find(item => item.secretRef === secretRef);
    if (!isLocalBot(botId) || !item?.allowedBotIds.includes(botId)) throw vaultError('VAULT_NOT_FOUND');
    return item;
  }
  async function control(raw, unlockRequest) {
    try {
      const input = normalizeVaultControl(raw);
      // Chat replies are consumed by the Host service, never by CRUD dispatch.
      if (input.action === 'respondUnlock') throw vaultError('VAULT_INVALID_ARGUMENT');
      if (input.action === 'lock') return lock();
      if (input.action === 'status') return status();
      return await serial(async ticket => {
        unlockRequest?.guard();
        if (damaged) throw vaultError('VAULT_UNLOCK_FAILED');
        if (input.action === 'initialize' || input.action === 'unlock' || input.action === 'changePassword') {
          if (input.action === 'initialize' && exists) throw vaultError('VAULT_ALREADY_INITIALIZED');
          if (input.action !== 'initialize' && !exists) throw vaultError('VAULT_NOT_INITIALIZED');
          if (input.action === 'changePassword') unlocked(ticket);
          let candidate;
          let replacement;
          try {
            const salt = input.action === 'initialize' ? randomBytes(16).toString('base64') : encrypted.salt;
            candidate = await derive(input.masterPassword, decode(salt, 16), 32, KDF);
            guard(ticket);
            unlockRequest?.guard();
            let doc = input.action === 'initialize' ? { revision: 1, items: [] } : decrypt(encrypted, candidate);
            if (input.action === 'changePassword') {
              const newSalt = randomBytes(16).toString('base64');
              replacement = await derive(input.newMasterPassword, decode(newSalt, 16), 32, KDF);
              unlocked(ticket);
              doc.revision++;
              await persist(encrypt(doc, replacement, newSalt), ticket);
            } else if (input.action === 'initialize') {
              await persist(encrypt(doc, candidate, salt), ticket, unlockRequest?.guard);
            }
            // Reauthorize after async work, then check cancellation without another await before installing the key.
            if (unlockRequest) await unlockRequest.authorize();
            guard(ticket);
            unlockRequest?.guard();
            key?.fill(0); key = replacement ?? candidate;
            if (replacement) replacement = null; else candidate = null;
            touch();
            unlockRequest?.complete();
            return status();
          } finally { candidate?.fill(0); replacement?.fill(0); }
        }
        const doc = read(ticket);
        if (input.action === 'list') return { revision: doc.revision, items: doc.items.map(meta) };
        if (input.expectedRevision !== doc.revision) throw vaultError('VAULT_CONFLICT');
        let item;
        if (input.action === 'save') {
          for (const botId of input.item.allowedBotIds) {
            if (!isLocalBot(botId)) throw vaultError('VAULT_FORBIDDEN');
          }
          const previous = input.item.secretRef ? doc.items.find(item => item.secretRef === input.item.secretRef) : null;
          if (input.item.secretRef && !previous) throw vaultError('VAULT_NOT_FOUND');
          if (!previous && doc.items.length >= VAULT_MAX_ITEMS) throw vaultError('VAULT_INVALID_ARGUMENT');
          const now = new Date().toISOString();
          item = { secretRef: previous?.secretRef ?? randomUUID(), label: input.item.label,
            username: input.item.username ?? previous?.username ?? '',
            password: input.item.password ?? previous?.password,
            allowedBotIds: input.item.allowedBotIds, createdAt: previous?.createdAt ?? now, updatedAt: now };
          if (previous) doc.items[doc.items.indexOf(previous)] = item; else doc.items.push(item);
        } else {
          const index = doc.items.findIndex(item => item.secretRef === input.secretRef);
          if (index < 0) throw vaultError('VAULT_NOT_FOUND');
          doc.items.splice(index, 1);
        }
        doc.revision++;
        await persist(encrypt(doc, key, encrypted.salt), ticket);
        guard(ticket); touch();
        return { revision: doc.revision, ...(item ? { item: meta(item) } : {}) };
      });
    } catch (error) { throw safeVaultError(error); }
  }
  return {
    control,
    find(botId, query) {
      try {
        const doc = read(epoch);
        if (!isLocalBot(botId)) throw vaultError('VAULT_FORBIDDEN');
        const items = doc.items.filter(item => item.allowedBotIds.includes(botId) &&
          (item.label.toLowerCase().includes(query) || item.username.toLowerCase().includes(query)));
        return { items: items.slice(0, 50).map(meta), hasMore: items.length > 50 };
      } catch (error) { throw safeVaultError(error); }
    },
    // Private to the Host service; never supplied to plugin services or the model.
    secretReader(secretRef, botId) {
      const ticket = epoch;
      const revision = encrypted?.revision;
      permitted(read(ticket), secretRef, botId);
      return () => {
        try {
          const doc = read(ticket);
          if (doc.revision !== revision) throw vaultError('VAULT_CONFLICT');
          const item = permitted(doc, secretRef, botId);
          touch();
          return item.password;
        } catch (error) { throw safeVaultError(error); }
      };
    },
    async close() { closed = true; lock(); await tail; },
  };
}
