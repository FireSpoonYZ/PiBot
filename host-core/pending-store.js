// host-core/pending-store.js
// Module 14: 客户端待发送持久存储。独占 client-pending.sqlite（schema v1，
// 绑定 deviceId）与 pending-owner.sqlite 生命周期租约，同一 dataRoot 同时
// 仅一个写入/恢复进程。纯存储层：无网络、无调度、无 CLI。
import { mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { messageError, assertId } from './message-protocol.js';

const SCHEMA_VERSION = 1;
const DB_FILE = 'client-pending.sqlite';
const OWNER_DB = 'pending-owner.sqlite';
const STATES = new Set(['pending', 'sending', 'unconfirmed', 'accepted', 'rejected']);
const MAX_TEXT_BYTES = 262144;
const MAX_RECEIPT_BYTES = 1048576; // 1 MiB
const MAX_ATTACHMENTS = 16;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// SQLITE_BUSY (5) / SQLITE_LOCKED (6): 另一进程正持有 pending 存储。
const BUSY_ERRCODES = new Set([5, 6]);

const SCHEMA_SQL = `
  CREATE TABLE pending_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
  );
  CREATE TABLE pending_rows (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('primary', 'room')),
    target_device_id TEXT NOT NULL,
    bot_id TEXT,
    scope_id TEXT,
    request_id TEXT,
    message_id TEXT,
    text TEXT NOT NULL,
    reply_to TEXT,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'unconfirmed', 'accepted', 'rejected')),
    receipt_json TEXT,
    last_error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_pending_primary_key ON pending_rows(target_device_id, bot_id, request_id)
    WHERE kind = 'primary';
  CREATE UNIQUE INDEX idx_pending_room_key ON pending_rows(target_device_id, scope_id, message_id)
    WHERE kind = 'room';
`;

const REQUIRED_TABLES = ['pending_identity', 'pending_rows'];
const REQUIRED_COLUMNS = {
  pending_identity: ['id', 'device_id'],
  pending_rows: ['id', 'device_id', 'kind', 'target_device_id', 'bot_id', 'scope_id', 'request_id',
    'message_id', 'text', 'reply_to', 'fingerprint', 'state', 'receipt_json', 'last_error_json',
    'created_at', 'updated_at', 'attachments_json', 'delivery'],
};
const REQUIRED_UNIQUE_INDEXES = ['idx_pending_primary_key', 'idx_pending_room_key'];

export function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw messageError('INVALID_ARGUMENT', `${name} must be a UUID`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(input, allowed, label) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw messageError('INVALID_ARGUMENT', `${label} has unknown field: ${key}`);
    }
  }
}

function assertPendingText(value, attachments) {
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    (!hasAttachments && value.trim() === '') ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw messageError(
      'INVALID_ARGUMENT',
      hasAttachments
        ? 'text must be a well-formed string of at most 262144 UTF-8 bytes'
        : 'text must be a well-formed non-blank string of at most 262144 UTF-8 bytes'
    );
  }
}

// 附件只按 ID 有序保留（最多 16 个 64hex SHA-256）；内容归属由 Host runtime 校验。
function normalizeAttachments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS) {
    throw messageError('INVALID_ARGUMENT', `attachments must be an array of 1-${MAX_ATTACHMENTS} attachment IDs`);
  }
  for (const id of value) {
    if (typeof id !== 'string' || !SHA256_HEX_RE.test(id)) {
      throw messageError('INVALID_ARGUMENT', 'attachments[] must be lowercase 64-character hex SHA-256 IDs');
    }
  }
  return [...value];
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw messageError('STORE_FAILED', 'pending record json field is corrupt');
  }
}

function toRecord(row) {
  const record = {
    id: row.id,
    deviceId: row.device_id,
    kind: row.kind,
    targetDeviceId: row.target_device_id,
    text: row.text,
    state: row.state,
    receipt: parseJson(row.receipt_json),
    lastError: parseJson(row.last_error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === 'primary') {
    record.botId = row.bot_id;
    record.requestId = row.request_id;
    const attachments = parseJson(row.attachments_json);
    if (attachments !== null) record.attachments = attachments;
    if (row.delivery === 'steer') record.delivery = 'steer';
  } else {
    record.scopeId = row.scope_id;
    record.messageId = row.message_id;
    record.replyTo = row.reply_to;
  }
  return record;
}

function normalizeEnqueue(input) {
  if (!isPlainObject(input)) {
    throw messageError('INVALID_ARGUMENT', 'enqueue input must be an object');
  }
  if (input.kind === 'primary') {
    rejectUnknownFields(input, new Set(['kind', 'targetDeviceId', 'botId', 'requestId', 'text', 'attachments', 'delivery']), 'enqueue input');
    assertId(input.targetDeviceId, 'targetDeviceId');
    assertId(input.botId, 'botId');
    assertId(input.requestId, 'requestId');
    if (input.delivery !== undefined && input.delivery !== 'followUp' && input.delivery !== 'steer') {
      throw messageError('INVALID_ARGUMENT', "delivery must be 'followUp' or 'steer'");
    }
    const attachments = input.attachments === undefined ? null : normalizeAttachments(input.attachments);
    assertPendingText(input.text, attachments);
    const normalized = {
      kind: 'primary',
      targetDeviceId: input.targetDeviceId,
      botId: input.botId,
      requestId: input.requestId,
      text: input.text,
    };
    if (attachments !== null) normalized.attachments = attachments;
    if (input.delivery === 'steer') normalized.delivery = 'steer';
    return normalized;
  }
  if (input.kind === 'room') {
    rejectUnknownFields(input, new Set(['kind', 'targetDeviceId', 'scopeId', 'messageId', 'text', 'replyTo']), 'enqueue input');
    assertId(input.targetDeviceId, 'targetDeviceId');
    assertId(input.scopeId, 'scopeId');
    assertId(input.messageId, 'messageId');
    assertPendingText(input.text, null);
    let replyTo = null;
    if (input.replyTo !== undefined && input.replyTo !== null) {
      assertId(input.replyTo, 'replyTo');
      replyTo = input.replyTo;
    }
    return {
      kind: 'room',
      targetDeviceId: input.targetDeviceId,
      scopeId: input.scopeId,
      messageId: input.messageId,
      text: input.text,
      replyTo,
    };
  }
  throw messageError('INVALID_ARGUMENT', "kind must be 'primary' or 'room'");
}

// 指纹只覆盖冻结业务键与载荷：同键同正文幂等，异正文冲突。
function fingerprintFor(normalized) {
  const payload = normalized.kind === 'primary'
    ? {
        kind: 'primary',
        targetDeviceId: normalized.targetDeviceId,
        botId: normalized.botId,
        requestId: normalized.requestId,
        text: normalized.text,
        ...(normalized.attachments !== undefined ? { attachments: normalized.attachments } : {}),
        ...(normalized.delivery === 'steer' ? { delivery: 'steer' } : {}),
      }
    : {
        kind: 'room',
        targetDeviceId: normalized.targetDeviceId,
        scopeId: normalized.scopeId,
        messageId: normalized.messageId,
        text: normalized.text,
        replyTo: normalized.replyTo,
      };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function assertInventory(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((row) => row.name);
  if (tables.length !== REQUIRED_TABLES.length || !REQUIRED_TABLES.every((t) => tables.includes(t))) {
    throw messageError('UNSUPPORTED_SCHEMA', 'pending database table inventory does not match schema v1');
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const column of columns) {
      if (!actual.has(column)) {
        throw messageError('UNSUPPORTED_SCHEMA', `pending database table ${table} is missing column ${column}`);
      }
    }
  }
  for (const index of REQUIRED_UNIQUE_INDEXES) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index);
    if (!row || typeof row.sql !== 'string' || !row.sql.includes('UNIQUE')) {
      throw messageError('UNSUPPORTED_SCHEMA', `pending database is missing unique index ${index}`);
    }
  }
}

function initSchema(db, deviceId) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw messageError('UNSUPPORTED_SCHEMA', 'pending database schema version is not supported');
    }
    if (version === 0) {
      const existingTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      if (existingTables.length > 0) {
        throw messageError('UNSUPPORTED_SCHEMA', 'pending database file already contains unrecognized tables');
      }
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO pending_identity (id, device_id) VALUES (1, ?)').run(deviceId);
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
      // 新建库即含附件列与投递模式列；既有 schema v1 库走下方平滑迁移。
      db.exec('ALTER TABLE pending_rows ADD COLUMN attachments_json TEXT');
      db.exec('ALTER TABLE pending_rows ADD COLUMN delivery TEXT');
    } else {
      // schema v1 平滑迁移：旧库没有扩展列时补列；assertInventory 只要求列存在。
      const columns = new Set(db.prepare('PRAGMA table_info(pending_rows)').all().map((row) => row.name));
      if (!columns.has('attachments_json')) {
        db.exec('ALTER TABLE pending_rows ADD COLUMN attachments_json TEXT');
      }
      if (!columns.has('delivery')) {
        db.exec('ALTER TABLE pending_rows ADD COLUMN delivery TEXT');
      }
      // 既有库先校验准确 inventory 与设备绑定，再恢复；失败不重置。
      assertInventory(db);
      const row = db.prepare('SELECT device_id FROM pending_identity WHERE id = 1').get();
      if (!row) {
        throw messageError('UNSUPPORTED_SCHEMA', 'pending database is missing identity row');
      }
      if (row.device_id !== deviceId) {
        throw messageError('REQUEST_CONFLICT', 'pending database owner deviceId does not match client deviceId');
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

function normalizeListOptions(options) {
  if (options === null || options === undefined) {
    throw messageError('INVALID_ARGUMENT', 'list options must be an object');
  }
  if (!isPlainObject(options)) {
    throw messageError('INVALID_ARGUMENT', 'list options must be an object');
  }
  rejectUnknownFields(options, new Set(['state', 'limit', 'cursor']), 'list options');
  let limit = DEFAULT_LIMIT;
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
      throw messageError('INVALID_ARGUMENT', 'limit must be a positive integer between 1 and 200');
    }
    limit = options.limit;
  }
  let state = null;
  if (options.state !== undefined && options.state !== null) {
    if (!STATES.has(options.state)) {
      throw messageError('INVALID_ARGUMENT', 'state must be one of pending, sending, unconfirmed, accepted, rejected');
    }
    state = options.state;
  }
  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    if (!isPlainObject(options.cursor)) {
      throw messageError('INVALID_ARGUMENT', 'cursor must be an object');
    }
    rejectUnknownFields(options.cursor, new Set(['deviceId', 'state', 'afterId']), 'cursor');
    assertId(options.cursor.deviceId, 'cursor.deviceId');
    // cursor 必须自带 state 且等于本次 filter（省略 filter 表示 null），禁止推导/冲突。
    if (options.cursor.state !== null && options.cursor.state !== undefined) {
      if (!STATES.has(options.cursor.state)) {
        throw messageError('INVALID_ARGUMENT', 'cursor.state must be null or one of pending, sending, unconfirmed, accepted, rejected');
      }
    }
    if (options.cursor.state !== state) {
      throw messageError('INVALID_ARGUMENT', 'cursor state must equal the list state filter');
    }
    assertUuid(options.cursor.afterId, 'cursor.afterId');
    cursor = { deviceId: options.cursor.deviceId, state, afterId: options.cursor.afterId };
  }
  return { limit, state, cursor };
}

function pendingBusy(message) {
  const err = new Error(message);
  err.code = 'PENDING_BUSY';
  return err;
}

function mapOwnerError(err) {
  if (BUSY_ERRCODES.has(err?.errcode) || err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_LOCKED') {
    return pendingBusy('pending store is locked by another process');
  }
  return err;
}

/**
 * Acquire exclusive ownership of the pending store for this dataRoot. Holding a
 * BEGIN IMMEDIATE transaction on dataRoot/pending-owner.sqlite blocks other
 * processes (busy_timeout=0, so contention fails fast); a crash releases the
 * lock via the OS file lock, so nothing needs stale/host cleanup.
 * Returns an idempotent release() that rolls back and closes the connection.
 */
function acquirePendingOwner(dataRoot) {
  let db;
  try {
    db = new DatabaseSync(join(dataRoot, OWNER_DB));
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    try { db?.close(); } catch { /* close 失败不掩盖原错误 */ }
    throw mapOwnerError(err);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  return () => {
    if (closed) return;
    try {
      db.exec('ROLLBACK');
    } finally {
      close();
    }
  };
}

export function openPendingStore(dataRoot, deviceId) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !isAbsolute(dataRoot)) {
    throw messageError('INVALID_ARGUMENT', 'dataRoot must be an absolute non-blank path');
  }
  assertId(deviceId, 'deviceId');
  mkdirSync(dataRoot, { recursive: true });
  const releaseOwner = acquirePendingOwner(dataRoot);
  let db;
  try {
    db = new DatabaseSync(join(dataRoot, DB_FILE));
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db, deviceId);

    // 独占重开：遗留 sending（崩溃残留）归为 unconfirmed，绝不自动重发。
    db.prepare(
      "UPDATE pending_rows SET state = 'unconfirmed', updated_at = ? WHERE state = 'sending'"
    ).run(new Date().toISOString());

    const stmtGet = db.prepare('SELECT * FROM pending_rows WHERE id = ?');
    const stmtInsert = db.prepare(
      `INSERT INTO pending_rows (id, device_id, kind, target_device_id, bot_id, scope_id, request_id,
                                 message_id, text, reply_to, fingerprint, state, receipt_json,
                                 last_error_json, created_at, updated_at, attachments_json, delivery)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?)`
    );
    const stmtFindPrimary = db.prepare(
      "SELECT * FROM pending_rows WHERE target_device_id = ? AND kind = 'primary' AND bot_id = ? AND request_id = ?"
    );
    const stmtFindRoom = db.prepare(
      "SELECT * FROM pending_rows WHERE target_device_id = ? AND kind = 'room' AND scope_id = ? AND message_id = ?"
    );
    const stmtMarkSending = db.prepare(
      "UPDATE pending_rows SET state = 'sending', updated_at = ? WHERE id = ?"
    );
    const stmtTransition = db.prepare(
      'UPDATE pending_rows SET state = ?, receipt_json = ?, last_error_json = ?, updated_at = ? WHERE id = ?'
    );

    const enqueue = (input) => {
      const normalized = normalizeEnqueue(input);
      const fingerprint = fingerprintFor(normalized);
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const existing = normalized.kind === 'primary'
          ? stmtFindPrimary.get(normalized.targetDeviceId, normalized.botId, normalized.requestId)
          : stmtFindRoom.get(normalized.targetDeviceId, normalized.scopeId, normalized.messageId);
        if (existing) {
          if (existing.fingerprint === fingerprint) return toRecord(existing);
          throw messageError(
            'REQUEST_CONFLICT',
            existing.kind === 'primary'
              ? 'requestId already used with different text or attachments'
              : 'messageId already used with different text or replyTo'
          );
        }
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        stmtInsert.run(
          id,
          deviceId,
          normalized.kind,
          normalized.targetDeviceId,
          normalized.kind === 'primary' ? normalized.botId : null,
          normalized.kind === 'room' ? normalized.scopeId : null,
          normalized.kind === 'primary' ? normalized.requestId : null,
          normalized.kind === 'room' ? normalized.messageId : null,
          normalized.text,
          normalized.kind === 'room' ? normalized.replyTo : null,
          fingerprint,
          timestamp,
          timestamp,
          normalized.kind === 'primary' && normalized.attachments !== undefined
            ? JSON.stringify(normalized.attachments)
            : null,
          normalized.kind === 'primary' && normalized.delivery === 'steer'
            ? 'steer'
            : null
        );
        db.exec('COMMIT');
        committed = true;
        return toRecord(stmtGet.get(id));
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    const get = (id) => {
      const row = stmtGet.get(id);
      return row ? toRecord(row) : null;
    };

    const markSending = (id) => {
      const row = stmtGet.get(id);
      if (!row) throw messageError('INVALID_ARGUMENT', 'pending record not found');
      // accepted 永不再次 mutation；已 sending 维持。
      if (row.state === 'accepted' || row.state === 'sending') {
        return toRecord(row);
      }
      stmtMarkSending.run(new Date().toISOString(), id);
      return toRecord(stmtGet.get(id));
    };

    const transition = (id, patch) => {
      const row = stmtGet.get(id);
      if (!row) throw messageError('INVALID_ARGUMENT', 'pending record not found');
      if (row.state === 'accepted' && patch.state !== undefined && patch.state !== 'accepted') {
        return toRecord(row);
      }
      const state = patch.state ?? row.state;
      const receipt = patch.receipt === undefined ? parseJson(row.receipt_json) : patch.receipt;
      const lastError = patch.lastError === undefined ? parseJson(row.last_error_json) : patch.lastError;
      const receiptJson = receipt === null ? null : JSON.stringify(receipt);
      if (receiptJson !== null && Buffer.byteLength(receiptJson, 'utf8') > MAX_RECEIPT_BYTES) {
        throw messageError('STORE_FAILED', 'receipt exceeds 1MiB serialization limit');
      }
      stmtTransition.run(
        state,
        receiptJson,
        lastError === null ? null : JSON.stringify(lastError),
        new Date().toISOString(),
        id
      );
      return toRecord(stmtGet.get(id));
    };

    const list = (options = {}) => {
      const { limit, state, cursor } = normalizeListOptions(options);
      const where = [];
      const params = [];
      if (state !== null) {
        where.push('state = ?');
        params.push(state);
      }
      if (cursor) {
        if (cursor.deviceId !== deviceId) {
          throw messageError('INVALID_ARGUMENT', 'cursor deviceId does not match pending client device');
        }
        where.push('id > ?');
        params.push(cursor.afterId);
      }
      const sql =
        `SELECT * FROM pending_rows` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY id COLLATE BINARY ASC LIMIT ?`;
      const rows = db.prepare(sql).all(...params, limit + 1);
      const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
      const nextCursor =
        rows.length > limit
          ? { deviceId, state, afterId: pageRows[pageRows.length - 1].id }
          : null;
      return { items: pageRows.map(toRecord), nextCursor };
    };

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        releaseOwner();
      }
    };

    return { deviceId, enqueue, get, list, markSending, transition, close };
  } catch (err) {
    try { db?.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { releaseOwner(); } catch { /* release 失败不掩盖原错误 */ }
    throw err;
  }
}
