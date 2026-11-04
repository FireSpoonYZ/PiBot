// host-core/host-settings.js
// SQLite v1：identity + 当前行（revision + 规范 JSON）。失败回滚保原 JSON，close 后封口；
// BEGIN IMMEDIATE 保证独立进程 CAS 安全，Runtime 独占由既有 runtime-owner 锁保证。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { normalizeRuntimeConfig } from './runtime-models.js';
import { parseRelayUrl } from './relay-protocol.js';
import { assertId } from './message-protocol.js';

const SCHEMA_VERSION = 1;
const DB_FILE = 'host-settings.sqlite';
const MAX_SETTINGS_JSON_BYTES = 512 * 1024;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_SETTINGS = { runtime: { providers: [] }, relay: null };

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalidArgument(message) {
  return errWithCode(message, 'INVALID_ARGUMENT');
}

function conflict(message) {
  return errWithCode(message, 'REQUEST_CONFLICT');
}

function unsupportedSchema(message) {
  return errWithCode(message, 'UNSUPPORTED_SCHEMA');
}

function closedError() {
  return errWithCode('host settings store is closed', 'HOST_SETTINGS_CLOSED');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidArgument(`${label} has unknown field: ${key}`);
    }
  }
}

/**
 * 纯设置校验：无 env 读取/文件/网络。Settings = {runtime:<规范 runtime 配置>,
 * relay:null|{url,tokenEnv,caFile?}}。relay 复用 parseRelayUrl；tokenEnv 只校验
 * 名称不读值；caFile 仅是绝对路径引用，不读文件。
 */
export function normalizeHostSettings(value) {
  if (!isPlainObject(value)) throw invalidArgument('host settings must be a plain object');
  rejectUnknownFields(value, new Set(['runtime', 'relay']), 'host settings');
  const runtime = normalizeRuntimeConfig(value.runtime);
  let relay = null;
  if (value.relay !== null && value.relay !== undefined) {
    if (!isPlainObject(value.relay)) throw invalidArgument('relay must be null or a plain object');
    rejectUnknownFields(value.relay, new Set(['url', 'tokenEnv', 'caFile']), 'relay');
    if (typeof value.relay.url !== 'string' || value.relay.url.length === 0) {
      throw invalidArgument('relay url must be a non-empty string');
    }
    parseRelayUrl(value.relay.url);
    if (typeof value.relay.tokenEnv !== 'string' || !ENV_NAME_RE.test(value.relay.tokenEnv)) {
      throw invalidArgument('relay tokenEnv must be a standard environment variable name');
    }
    const normalizedRelay = { url: value.relay.url, tokenEnv: value.relay.tokenEnv };
    if (value.relay.caFile !== undefined) {
      if (typeof value.relay.caFile !== 'string' || value.relay.caFile.trim() === '' || !path.isAbsolute(value.relay.caFile)) {
        throw invalidArgument('relay caFile must be an absolute path');
      }
      normalizedRelay.caFile = value.relay.caFile;
    }
    relay = normalizedRelay;
  }
  const normalized = { runtime, relay };
  // 规范设置预算作为纯校验一部分，供 HostService 启动前 normalizer 复用，
  // 在任何资源/数据库打开前拒绝超大设置。
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_SETTINGS_JSON_BYTES) {
    throw invalidArgument('host settings exceed 512KiB limit');
  }
  return normalized;
}

const SCHEMA_SQL = `
  CREATE TABLE settings_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
  );
  CREATE TABLE host_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    settings_json TEXT NOT NULL
  );
`;

function initSchema(db, deviceId, seed, compareSeed, seedJson) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) {
      throw unsupportedSchema('host settings database schema version is not supported');
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    if (version === 0) {
      if (tables.length > 0) {
        throw unsupportedSchema('database file already contains unrecognized tables');
      }
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO settings_identity (id, device_id) VALUES (1, ?)').run(deviceId);
      db.prepare('INSERT INTO host_settings (id, revision, settings_json) VALUES (1, 1, ?)').run(seedJson);
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else {
      const expected = ['settings_identity', 'host_settings'];
      if (tables.length !== expected.length || !expected.every((name) => tables.includes(name))) {
        throw unsupportedSchema('host settings database table inventory mismatch');
      }
      const identityCols = db.prepare('PRAGMA table_info(settings_identity)').all().map((col) => col.name);
      const settingsCols = db.prepare('PRAGMA table_info(host_settings)').all().map((col) => col.name);
      const hasColumns = (cols, ...need) => need.every((name) => cols.includes(name));
      if (!hasColumns(identityCols, 'id', 'device_id') || !hasColumns(settingsCols, 'id', 'revision', 'settings_json')) {
        throw unsupportedSchema('host settings database is missing required columns');
      }
      const identity = db.prepare('SELECT device_id FROM settings_identity WHERE id = 1').get();
      if (!identity) throw unsupportedSchema('host settings database is missing identity row');
      if (identity.device_id !== deviceId) {
        throw conflict('host settings database owner deviceId does not match host deviceId');
      }
      const row = db.prepare('SELECT revision, settings_json FROM host_settings WHERE id = 1').get();
      if (!row) throw unsupportedSchema('host settings database is missing the current settings row');
      // 既有当前行在 open 阶段先验证，不把畸形数据读出后再 resume 模型。
      if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
        throw unsupportedSchema('host settings revision must be a positive safe integer');
      }
      if (Buffer.byteLength(row.settings_json, 'utf8') > MAX_SETTINGS_JSON_BYTES) {
        throw unsupportedSchema('host settings current row exceeds 512KiB limit');
      }
      let parsed;
      try {
        parsed = JSON.parse(row.settings_json);
      } catch {
        throw unsupportedSchema('host settings current row is not valid JSON');
      }
      try {
        normalizeHostSettings(parsed);
      } catch {
        throw unsupportedSchema('host settings current row failed validation');
      }
      // initialSettings 仅在创建时 seed；已有库只在显式提供时比较，不同即拒冲突。
      if (compareSeed && !isDeepStrictEqual(parsed, seed)) {
        throw conflict('initial settings conflict with existing host settings');
      }
    }
    db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

/**
 * 打开主机设置库。deviceId 显式绑定；数据库文件在 schema 检查前（写前）拒绝：
 * 未知版本/表库存/缺列/身份不匹配，绝不 reset/drop。
 * initialSettings 仅在创建时 seed；已有库指定不同的初始设置报 REQUEST_CONFLICT，
 * 不能静默覆盖（省略 initialSettings 表示无 seed 意图，不做比较）。
 */
export function openHostSettings({ dataRoot, deviceId, initialSettings }) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalidArgument('dataRoot must be a non-empty absolute path');
  }
  assertId(deviceId, 'deviceId');
  const seedProvided = initialSettings !== undefined;
  // 存储统一用规范化形式，保证默认与显式 seed 的后续比较一致。
  // 预算已由 normalizeHostSettings 纯校验覆盖，此处不重复。
  const seed = normalizeHostSettings(seedProvided ? initialSettings : DEFAULT_SETTINGS);
  const seedJson = JSON.stringify(seed);

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
    initSchema(db, deviceId, seed, seedProvided, seedJson);

    const stmtGetSettings = db.prepare('SELECT revision, settings_json FROM host_settings WHERE id = 1');
    const stmtReplaceSettings = db.prepare('UPDATE host_settings SET revision = ?, settings_json = ? WHERE id = 1');

    const snapshotFromRow = (row) => ({ deviceId, revision: row.revision, settings: JSON.parse(row.settings_json) });

    const assertOpen = () => {
      if (closed) throw closedError();
    };

    const get = () => {
      assertOpen();
      return snapshotFromRow(stmtGetSettings.get());
    };

    const replace = ({ expectedRevision, settings }) => {
      assertOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
        throw invalidArgument('expectedRevision must be a positive safe integer');
      }
      // 预算已在 normalizeHostSettings 纯校验中拒绝，此处不重复。
      const normalized = normalizeHostSettings(settings);
      const json = JSON.stringify(normalized);
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const row = stmtGetSettings.get();
        if (row.revision !== expectedRevision) {
          throw conflict(`settings revision mismatch: expected ${expectedRevision}, current ${row.revision}`);
        }
        if (!Number.isSafeInteger(row.revision + 1)) {
          throw errWithCode('settings revision overflow', 'STORE_FAILED');
        }
        const nextRevision = row.revision + 1;
        const result = stmtReplaceSettings.run(nextRevision, json);
        if (result.changes !== 1) {
          throw errWithCode('host settings row is missing', 'STORE_FAILED');
        }
        db.exec('COMMIT');
        committed = true;
        return { deviceId, revision: nextRevision, settings: JSON.parse(json) };
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    return { deviceId, get, replace, close };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    throw err;
  }
}
