// host-core/desktop-ui-store.js
// Module 17: private client-side UI state store (desktop-ui.sqlite, schema v1).
// Owns the persistent generated clientId and one revisioned JSON state
// {version:1, profiles:[], drafts:{}, intents:[]}. Strictly client-local:
// never stores tokens/CAs, never executes intents, never resets corrupt/future
// databases.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { messageError, assertId, assertRevision } from './message-protocol.js';
import { parseRelayUrl } from './relay-protocol.js';
import {
  CONTROL_ERROR_CODES,
  CONTROL_OUTCOMES,
  normalizeControlCall,
} from './remote-control-protocol.js';

const SCHEMA_VERSION = 1;
const DB_FILE = 'desktop-ui.sqlite';
export const MAX_UI_STATE_JSON_BYTES = 1048576; // 1 MiB
export const MAX_UI_PROFILES = 16;
export const MAX_UI_INTENTS = 128;
const MAX_DRAFT_TARGETS = 256;
const MAX_DRAFT_FILES = 64;
const MAX_DRAFT_ATTACHMENTS = 16;
const MAX_DRAFT_TEXT_BYTES = 262144;
const MAX_TITLE_BYTES = 256;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_PATH_BYTES = 4096;
const MAX_ERROR_MESSAGE_BYTES = 512;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);
const INTENT_METHODS = new Set(['createBot', 'setPrimaryBot', 'archiveBot', 'unarchiveBot', 'deleteBot', 'updateBotProfile', 'createScope', 'updateScope', 'deleteScope']);
const INITIAL_STATE = Object.freeze({
  version: 1,
  profiles: [],
  drafts: {},
  intents: [],
});

const SCHEMA_SQL = `
  CREATE TABLE ui_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT NOT NULL
  );
  CREATE TABLE ui_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    state_json TEXT NOT NULL
  );
`;

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function conflict(message) {
  return messageError('REQUEST_CONFLICT', message);
}

function unsupportedSchema(message) {
  return messageError('UNSUPPORTED_SCHEMA', message);
}

function storeFailed(message) {
  return messageError('STORE_FAILED', message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

function assertNonBlankText(value, name, maxBytes) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalid(`${name} must be a well-formed non-blank string within ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function assertBoundedText(value, name, maxBytes) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalid(`${name} must be a well-formed string within ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

export function validateLocalControlUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.isWellFormed() || rawUrl.trim() === '') {
    throw invalid('local url must be a valid http loopback URL');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid('local url must be a valid http URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw invalid('local url must be http://127.0.0.1 or http://[::1]');
  }
  if (url.pathname !== '/') {
    throw invalid('local url path must be exactly /');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid('local url must not contain user info');
  }
  if (url.search !== '') {
    throw invalid('local url must not contain a query string');
  }
  if (url.hash !== '') {
    throw invalid('local url must not contain a fragment');
  }
  return rawUrl;
}

export function validateRelayControlUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.isWellFormed() || rawUrl.trim() === '') {
    throw invalid('relay url must be a valid ws:// or wss:// URL');
  }
  parseRelayUrl(rawUrl);
  return rawUrl;
}

function normalizeProfile(raw) {
  if (!isPlainObject(raw)) throw invalid('profile must be a plain object');
  assertId(raw.id, 'profile.id');
  const title = assertNonBlankText(raw.title, 'profile.title', MAX_TITLE_BYTES);
  if (raw.kind === 'local') {
    rejectUnknownFields(raw, new Set(['id', 'title', 'kind', 'url', 'expectedDeviceId']), 'local profile');
    const url = validateLocalControlUrl(raw.url);
    const out = { id: raw.id, title, kind: 'local', url };
    if (raw.expectedDeviceId !== undefined) {
      assertId(raw.expectedDeviceId, 'profile.expectedDeviceId');
      out.expectedDeviceId = raw.expectedDeviceId;
    }
    return out;
  }
  if (raw.kind === 'relay') {
    rejectUnknownFields(raw, new Set(['id', 'title', 'kind', 'url', 'deviceId']), 'relay profile');
    const url = validateRelayControlUrl(raw.url);
    assertId(raw.deviceId, 'profile.deviceId');
    return {
      id: raw.id,
      title,
      kind: 'relay',
      url,
      deviceId: raw.deviceId,
    };
  }
  throw invalid("profile.kind must be 'local' or 'relay'");
}

function normalizeDraftFile(raw) {
  if (!isPlainObject(raw)) throw invalid('draft file must be a plain object');
  rejectUnknownFields(raw, new Set(['name', 'path', 'size']), 'draft file');
  const name = assertNonBlankText(raw.name, 'draft file.name', MAX_TITLE_BYTES);
  const filePath = assertNonBlankText(raw.path, 'draft file.path', MAX_PATH_BYTES);
  if (!path.isAbsolute(filePath)) {
    throw invalid('draft file.path must be an absolute path');
  }
  if (!Number.isSafeInteger(raw.size) || raw.size < 0) {
    throw invalid('draft file.size must be a non-negative safe integer');
  }
  return { name, path: filePath, size: raw.size };
}

// 草稿附件是已上传图片的元数据（提交时只发 id）；与 files 本地路径引用无关。
function normalizeDraftAttachment(raw) {
  if (!isPlainObject(raw)) throw invalid('draft attachment must be a plain object');
  rejectUnknownFields(raw, new Set(['id', 'name', 'mimeType', 'size', 'width', 'height']), 'draft attachment');
  if (typeof raw.id !== 'string' || !SHA256_HEX_RE.test(raw.id)) {
    throw invalid('draft attachment.id must be a lowercase 64-character hex SHA-256');
  }
  const name = assertNonBlankText(raw.name, 'draft attachment.name', MAX_TITLE_BYTES);
  if (typeof raw.mimeType !== 'string' || !IMAGE_MIME_TYPES.has(raw.mimeType)) {
    throw invalid('draft attachment.mimeType must be image/jpeg or image/png');
  }
  for (const field of ['size', 'width', 'height']) {
    if (!Number.isSafeInteger(raw[field]) || raw[field] < 0) {
      throw invalid(`draft attachment.${field} must be a non-negative safe integer`);
    }
  }
  return { id: raw.id, name, mimeType: raw.mimeType, size: raw.size, width: raw.width, height: raw.height };
}

function normalizeDrafts(raw) {
  if (!isPlainObject(raw)) throw invalid('drafts must be a plain object');
  const keys = Object.keys(raw);
  if (keys.length > MAX_DRAFT_TARGETS) {
    throw invalid(`drafts must have at most ${MAX_DRAFT_TARGETS} target keys`);
  }
  // Null-prototype dictionary so keys like "__proto__" (already accepted by
  // assertId) stay own enumerable string keys instead of mutating the prototype.
  const out = Object.create(null);
  for (const key of keys) {
    assertId(key, 'draft target key');
    const entry = raw[key];
    if (!isPlainObject(entry)) throw invalid('draft entry must be a plain object');
    rejectUnknownFields(entry, new Set(['text', 'files', 'attachments']), 'draft entry');
    const text = assertBoundedText(entry.text, 'draft.text', MAX_DRAFT_TEXT_BYTES);
    if (!Array.isArray(entry.files) || entry.files.length > MAX_DRAFT_FILES) {
      throw invalid(`draft.files must be an array of at most ${MAX_DRAFT_FILES} items`);
    }
    const files = entry.files.map(normalizeDraftFile);
    const outEntry = { text, files };
    // 旧草稿无 attachments 字段保持有效；只在新字段出现时校验。
    if (entry.attachments !== undefined) {
      if (!Array.isArray(entry.attachments) || entry.attachments.length > MAX_DRAFT_ATTACHMENTS) {
        throw invalid(`draft.attachments must be an array of at most ${MAX_DRAFT_ATTACHMENTS} items`);
      }
      outEntry.attachments = entry.attachments.map(normalizeDraftAttachment);
    }
    out[key] = outEntry;
  }
  return out;
}

function normalizeIntentError(raw) {
  if (!isPlainObject(raw)) throw invalid('intent.error must be a plain object');
  rejectUnknownFields(raw, new Set(['code', 'message', 'outcome']), 'intent.error');
  if (typeof raw.code !== 'string' || (!CONTROL_ERROR_CODES.has(raw.code) && raw.code !== 'REPLACED')) {
    throw invalid('intent.error.code must be a valid control error code');
  }
  if (typeof raw.outcome !== 'string' || !CONTROL_OUTCOMES.has(raw.outcome)) {
    throw invalid('intent.error.outcome must be one of not-sent, unconfirmed, responded');
  }
  const out = { code: raw.code, outcome: raw.outcome };
  if (raw.message !== undefined) {
    out.message = assertBoundedText(raw.message, 'intent.error.message', MAX_ERROR_MESSAGE_BYTES);
  }
  return out;
}

function normalizeIntentResult(raw) {
  if (!isPlainObject(raw)) throw invalid('intent.result must be a plain JSON object');
  let json;
  try {
    json = JSON.stringify(raw);
  } catch {
    throw invalid('intent.result must be JSON-serializable');
  }
  return JSON.parse(json);
}

function normalizeIntent(raw) {
  if (!isPlainObject(raw)) throw invalid('intent must be a plain object');
  rejectUnknownFields(
    raw,
    new Set(['id', 'profileId', 'targetDeviceId', 'method', 'params', 'outcome', 'result', 'error']),
    'intent',
  );
  assertId(raw.id, 'intent.id');
  assertId(raw.profileId, 'intent.profileId');
  assertId(raw.targetDeviceId, 'intent.targetDeviceId');
  if (typeof raw.method !== 'string' || !INTENT_METHODS.has(raw.method)) {
    throw invalid("intent.method must be a supported intent method");
  }
  const { params } = normalizeControlCall(raw.method, raw.params);
  if (typeof raw.outcome !== 'string' || !CONTROL_OUTCOMES.has(raw.outcome)) {
    throw invalid('intent.outcome must be one of unconfirmed, not-sent, responded');
  }
  if (raw.result !== undefined && raw.error !== undefined) {
    throw invalid('intent cannot carry both result and error');
  }
  const out = {
    id: raw.id,
    profileId: raw.profileId,
    targetDeviceId: raw.targetDeviceId,
    method: raw.method,
    params,
    outcome: raw.outcome,
  };
  if (raw.result !== undefined) {
    if (raw.outcome !== 'responded') {
      throw invalid('intent.result is only allowed when outcome is responded');
    }
    out.result = normalizeIntentResult(raw.result);
  }
  if (raw.error !== undefined) {
    out.error = normalizeIntentError(raw.error);
  }
  return out;
}

export function normalizeDesktopUiState(raw) {
  if (!isPlainObject(raw)) throw invalid('ui state must be a plain object');
  rejectUnknownFields(raw, new Set(['version', 'profiles', 'drafts', 'intents']), 'ui state');
  if (raw.version !== 1) {
    throw invalid('ui state version must be 1');
  }
  let rawJson;
  try {
    rawJson = JSON.stringify(raw);
  } catch {
    throw invalid('ui state must be JSON-serializable');
  }
  if (Buffer.byteLength(rawJson, 'utf8') > MAX_UI_STATE_JSON_BYTES) {
    throw messageError('REQUEST_TOO_LARGE', 'ui state exceeds 1 MiB limit');
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length > MAX_UI_PROFILES) {
    throw invalid(`profiles must be an array of at most ${MAX_UI_PROFILES} items`);
  }
  const seenProfiles = new Set();
  const profiles = raw.profiles.map((item) => {
    const profile = normalizeProfile(item);
    if (seenProfiles.has(profile.id)) {
      throw invalid(`duplicate profile id: ${profile.id}`);
    }
    seenProfiles.add(profile.id);
    return profile;
  });

  const drafts = normalizeDrafts(raw.drafts);

  if (!Array.isArray(raw.intents) || raw.intents.length > MAX_UI_INTENTS) {
    throw invalid(`intents must be an array of at most ${MAX_UI_INTENTS} items`);
  }
  const seenIntents = new Set();
  const intents = raw.intents.map((item) => {
    const intent = normalizeIntent(item);
    if (seenIntents.has(intent.id)) {
      throw invalid(`duplicate intent id: ${intent.id}`);
    }
    seenIntents.add(intent.id);
    return intent;
  });

  const normalized = { version: 1, profiles, drafts, intents };
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > MAX_UI_STATE_JSON_BYTES) {
    throw messageError('REQUEST_TOO_LARGE', 'ui state exceeds 1 MiB limit');
  }
  return normalized;
}

function initSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw unsupportedSchema('desktop ui database schema version is not supported');
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    if (version === 0) {
      if (tables.length > 0) {
        throw unsupportedSchema('desktop ui database file already contains unrecognized tables');
      }
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO ui_identity (id, client_id) VALUES (1, ?)').run(randomUUID());
      db.prepare('INSERT INTO ui_state (id, revision, state_json) VALUES (1, 1, ?)').run(JSON.stringify(INITIAL_STATE));
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else {
      const expected = ['ui_identity', 'ui_state'];
      if (tables.length !== expected.length || !expected.every((name) => tables.includes(name))) {
        throw unsupportedSchema('desktop ui database table inventory mismatch');
      }
      const idCols = db.prepare('PRAGMA table_info(ui_identity)').all().map((c) => c.name);
      const stateCols = db.prepare('PRAGMA table_info(ui_state)').all().map((c) => c.name);
      const hasCols = (cols, ...need) => need.every((name) => cols.includes(name));
      if (!hasCols(idCols, 'id', 'client_id') || !hasCols(stateCols, 'id', 'revision', 'state_json')) {
        throw unsupportedSchema('desktop ui database is missing required columns');
      }
      const identity = db.prepare('SELECT client_id FROM ui_identity WHERE id = 1').get();
      if (!identity) {
        throw unsupportedSchema('desktop ui database is missing identity row');
      }
      try {
        assertId(identity.client_id, 'clientId');
      } catch {
        throw unsupportedSchema('desktop ui database identity client_id is invalid');
      }
      const row = db.prepare('SELECT revision, state_json FROM ui_state WHERE id = 1').get();
      if (!row) {
        throw unsupportedSchema('desktop ui database is missing state row');
      }
      if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
        throw unsupportedSchema('desktop ui state revision must be a positive safe integer');
      }
      if (typeof row.state_json !== 'string' || Buffer.byteLength(row.state_json, 'utf8') > MAX_UI_STATE_JSON_BYTES) {
        throw unsupportedSchema('desktop ui state row exceeds 1 MiB limit');
      }
      let parsed;
      try {
        parsed = JSON.parse(row.state_json);
      } catch {
        throw unsupportedSchema('desktop ui state row is not valid JSON');
      }
      try {
        normalizeDesktopUiState(parsed);
      } catch {
        throw unsupportedSchema('desktop ui state row failed validation');
      }
    }
    db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback failure does not mask original error */ }
    }
  }
}

export function openDesktopUiStore({ dataRoot }) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalid('dataRoot must be a non-empty absolute path');
  }
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(path.join(dataRoot, DB_FILE));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db);

    const clientId = db.prepare('SELECT client_id FROM ui_identity WHERE id = 1').get().client_id;
    const stmtGetState = db.prepare('SELECT revision, state_json FROM ui_state WHERE id = 1');
    const stmtReplaceState = db.prepare('UPDATE ui_state SET revision = ?, state_json = ? WHERE id = 1');

    const assertOpen = () => {
      if (closed) throw storeFailed('desktop ui store is closed');
    };

    const parseStoredState = (row) => {
      if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.state_json !== 'string') {
        throw storeFailed('desktop ui state row is missing or corrupt');
      }
      let parsed;
      try {
        parsed = JSON.parse(row.state_json);
      } catch {
        throw storeFailed('desktop ui state json is corrupt');
      }
      return normalizeDesktopUiState(parsed);
    };

    const get = () => {
      assertOpen();
      const row = stmtGetState.get();
      const state = parseStoredState(row);
      return { clientId, revision: row.revision, state };
    };

    const profileIdentity = (profile) =>
      profile.kind === 'local'
        ? {
            kind: profile.kind,
            url: profile.url,
            ...(profile.expectedDeviceId !== undefined ? { expectedDeviceId: profile.expectedDeviceId } : {}),
          }
        : { kind: profile.kind, url: profile.url, deviceId: profile.deviceId };

    const replace = (input) => {
      assertOpen();
      if (!isPlainObject(input)) throw invalid('ui_set params must be a plain object');
      rejectUnknownFields(input, new Set(['expectedRevision', 'state']), 'ui_set params');
      assertRevision(input.expectedRevision, 'expectedRevision');
      const normalized = normalizeDesktopUiState(input.state);
      const json = JSON.stringify(normalized);

      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const row = stmtGetState.get();
        const current = parseStoredState(row);
        if (row.revision !== input.expectedRevision) {
          throw conflict(`ui state revision mismatch: expected ${input.expectedRevision}, current ${row.revision}`);
        }
        // Any retained intent id keeps its frozen identity fields (profileId/
        // targetDeviceId/method/normalized params); only outcome/result/error
        // may update with a definitive receipt. Pruning and profile-identity
        // protection apply only to unconfirmed intents.
        const nextIntents = new Map(normalized.intents.map((item) => [item.id, item]));
        const nextProfiles = new Map(normalized.profiles.map((profile) => [profile.id, profile]));
        for (const prev of current.intents) {
          const nextIntent = nextIntents.get(prev.id);
          if (nextIntent) {
            if (
              nextIntent.profileId !== prev.profileId ||
              nextIntent.targetDeviceId !== prev.targetDeviceId ||
              nextIntent.method !== prev.method ||
              !isDeepStrictEqual(nextIntent.params, prev.params)
            ) {
              throw conflict(`intent ${prev.id} identity fields cannot change`);
            }
          } else if (prev.outcome === 'unconfirmed') {
            throw conflict(`unconfirmed intent ${prev.id} cannot be pruned without explicit resolution`);
          }
          if (prev.outcome === 'unconfirmed') {
            const prevProfile = current.profiles.find((profile) => profile.id === prev.profileId);
            const nextProfile = nextProfiles.get(prev.profileId);
            if (!nextProfile) {
              throw conflict(`profile ${prev.profileId} referenced by unconfirmed intent ${prev.id} cannot be removed`);
            }
            if (prevProfile && !isDeepStrictEqual(profileIdentity(prevProfile), profileIdentity(nextProfile))) {
              throw conflict(`profile ${prev.profileId} connection identity cannot change while referenced by unconfirmed intent ${prev.id}`);
            }
          }
        }
        if (!Number.isSafeInteger(row.revision + 1)) {
          throw storeFailed('ui state revision overflow');
        }
        const nextRevision = row.revision + 1;
        const result = stmtReplaceState.run(nextRevision, json);
        if (result.changes !== 1) {
          throw storeFailed('desktop ui state row is missing');
        }
        db.exec('COMMIT');
        committed = true;
        return { clientId, revision: nextRevision, state: JSON.parse(json) };
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback failure does not mask original error */ }
        }
      }
    };

    return { clientId, get, replace, close };
  } catch (err) {
    try { close(); } catch { /* close failure does not mask original error */ }
    throw err;
  }
}
