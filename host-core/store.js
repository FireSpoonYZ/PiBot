import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 5;
const DB_FILE = 'host.sqlite';
const PRIMARY_KIND = 'primary';

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toBot(row, primaryBotId) {
  if (!row) return null;
  return {
    botId: row.bot_id,
    deviceId: row.device_id,
    role: row.role,
    description: row.description ?? '',
    cwd: row.cwd,
    modelRef: row.model_ref,
    primaryConversationId: row.primary_conversation_id,
    createdAt: row.created_at,
    isPrimary: Boolean(primaryBotId && row.bot_id === primaryBotId),
    lastActivityAt: row.last_activity_at ?? null,
    lastPreview: row.last_preview ?? null,
    archivedAt: row.archived_at ?? null,
  };
}

// v3+：每 Bot 扩展设置。revision 从 0 起，每次成功 CAS +1；retention_floor 由 Runtime
// 在离开关闭/只读期时写入，默认 0 表示不裁剪既有条目。
const BOT_EXTENSION_SETTINGS_DDL = `
  CREATE TABLE bot_extension_settings (
    bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    extensions_json TEXT NOT NULL,
    retention_floor INTEGER NOT NULL DEFAULT 0
  );
`;

function toBotExtensionSettings(row) {
  if (!row) return null;
  return {
    botId: row.bot_id,
    revision: row.revision,
    extensions: JSON.parse(row.extensions_json),
    retentionFloor: row.retention_floor,
  };
}

// 先取写锁再读版本：并发首次 open 不会都读到 0 而重复插身份。
function initSchema(db, expectedDeviceId) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    // Existing older schemas are never rebuilt automatically: preserve all Host data.
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw errWithCode('database schema version is not supported', 'UNSUPPORTED_SCHEMA');
    }
    if (version === 0) {
      const deviceId = expectedDeviceId ?? randomUUID();
      db.exec(`
        CREATE TABLE host_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          device_id TEXT NOT NULL
        );
        CREATE TABLE bots (
          bot_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          role TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL,
          model_ref TEXT,
          primary_conversation_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_activity_at TEXT,
          last_preview TEXT,
          archived_at TEXT
        );
        CREATE TABLE host_profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          primary_bot_id TEXT REFERENCES bots(bot_id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE conversations (
          conversation_id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL UNIQUE REFERENCES bots(bot_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind = 'primary')
        );
        CREATE TABLE bot_create_requests (
          request_id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL,
          model_ref TEXT
        );
        ${BOT_EXTENSION_SETTINGS_DDL}
      `);
      db.prepare('INSERT INTO host_identity (id, device_id) VALUES (1, ?)').run(deviceId);
      db.prepare('INSERT INTO host_profile (id, primary_bot_id, updated_at) VALUES (1, NULL, ?)').run(new Date().toISOString());
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else {
      // 已是 v5 的库校验必要列可读取且身份行与 profile 行存在；损坏库在此报错回滚。
      db.prepare('SELECT id, device_id FROM host_identity LIMIT 0').all();
      db.prepare('SELECT bot_id, device_id, role, description, cwd, model_ref, primary_conversation_id, created_at, last_activity_at, last_preview, archived_at FROM bots LIMIT 0').all();
      db.prepare('SELECT id, primary_bot_id, updated_at FROM host_profile LIMIT 0').all();
      db.prepare('SELECT conversation_id, bot_id, kind FROM conversations LIMIT 0').all();
      db.prepare('SELECT request_id, bot_id, role, description, cwd, model_ref FROM bot_create_requests LIMIT 0').all();
      db.prepare('SELECT bot_id, revision, extensions_json, retention_floor FROM bot_extension_settings LIMIT 0').all();
      if (!db.prepare('SELECT 1 AS x FROM host_identity WHERE id = 1').get()) {
        throw new Error('host database is missing identity row');
      }
      if (!db.prepare('SELECT 1 AS x FROM host_profile WHERE id = 1').get()) {
        throw new Error('host database is missing profile row');
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

export function openStore(dataRoot, expectedDeviceId) {
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(join(dataRoot, DB_FILE));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db, expectedDeviceId);

    const deviceId = db.prepare('SELECT device_id FROM host_identity WHERE id = 1').get().device_id;
    if (expectedDeviceId !== undefined && deviceId !== expectedDeviceId) {
      throw errWithCode('host identity does not match expected device id', 'IDENTITY_MISMATCH');
    }

    const stmtGetBot = db.prepare('SELECT * FROM bots WHERE bot_id = ?');
    const stmtGetHostProfile = db.prepare('SELECT primary_bot_id, updated_at FROM host_profile WHERE id = 1');
    const stmtSetPrimaryBot = db.prepare('UPDATE host_profile SET primary_bot_id = ?, updated_at = ? WHERE id = 1');
    const stmtGetRequest = db.prepare('SELECT * FROM bot_create_requests WHERE request_id = ?');
    const stmtListBots = db.prepare('SELECT * FROM bots ORDER BY created_at ASC, bot_id ASC');
    const stmtInsertBot = db.prepare(
      'INSERT INTO bots (bot_id, device_id, role, cwd, model_ref, primary_conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const stmtInsertConversation = db.prepare(
      'INSERT INTO conversations (conversation_id, bot_id, kind) VALUES (?, ?, ?)'
    );
    const stmtInsertRequest = db.prepare(
      'INSERT INTO bot_create_requests (request_id, bot_id, role, cwd, model_ref, description) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const stmtArchiveBot = db.prepare('UPDATE bots SET archived_at = COALESCE(archived_at, ?) WHERE bot_id = ?');
    const stmtUnarchiveBot = db.prepare('UPDATE bots SET archived_at = NULL WHERE bot_id = ?');
    const stmtDeleteBot = db.prepare('DELETE FROM bots WHERE bot_id = ?');
    const stmtRecordBotActivity = db.prepare('UPDATE bots SET last_activity_at = ?, last_preview = ? WHERE bot_id = ?');
    const stmtListExpiredArchivedBots = db.prepare(
      'SELECT * FROM bots WHERE archived_at IS NOT NULL AND archived_at <= ? ORDER BY archived_at ASC, bot_id ASC'
    );
    const stmtGetBotExtensionSettings = db.prepare('SELECT * FROM bot_extension_settings WHERE bot_id = ?');
    const stmtUpdateBotCwd = db.prepare('UPDATE bots SET cwd = ? WHERE bot_id = ?');
    const stmtUpdateBotProfile = db.prepare('UPDATE bots SET role = COALESCE(?, role), description = COALESCE(?, description) WHERE bot_id = ?');

    const getPrimaryBotId = () => {
      const profile = stmtGetHostProfile.get();
      if (!profile || !profile.primary_bot_id) return null;
      return stmtGetBot.get(profile.primary_bot_id) ? profile.primary_bot_id : null;
    };
    const getHostProfile = () => {
      const profile = stmtGetHostProfile.get();
      return {
        deviceId,
        primaryBotId: getPrimaryBotId(),
        updatedAt: profile?.updated_at ?? null,
      };
    };
    const getBot = (botId) => toBot(stmtGetBot.get(botId), getPrimaryBotId());
    const updateBotProfile = (botId, name, description) => {
      stmtUpdateBotProfile.run(name ?? null, description ?? null, botId);
      return getBot(botId);
    };
    // Center-driven cwd switch: rewrites only the persisted directory; runtime apply
    // performs the idle check and profile refresh, and nothing moves files.
    const setBotCwd = (botId, cwd) => {
      stmtUpdateBotCwd.run(cwd, botId);
      return getBot(botId);
    };
    const findByRequest = (requestId) => {
      const row = stmtGetRequest.get(requestId);
      return row ? getBot(row.bot_id) : null;
    };
    const listBots = () => {
      const primaryBotId = getPrimaryBotId();
      return stmtListBots.all().map((row) => toBot(row, primaryBotId));
    };

    const createBot = (input) => {
      const requestId = input.requestId;
      const role = input.role;
      const cwd = input.cwd;
      const modelRef = input.modelRef == null ? null : input.modelRef;
      const description = input.description ?? '';

      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        // 事务内查重：并发同 requestId 串行化后在此看到已受理记录
        const existing = stmtGetRequest.get(requestId);
        if (existing) {
          if (existing.role === role && existing.cwd === cwd && existing.model_ref === modelRef && existing.description === description) {
            return getBot(existing.bot_id);
          }
          throw errWithCode('requestId already used with different definition', 'REQUEST_CONFLICT');
        }
        const botId = randomUUID();
        const conversationId = randomUUID();
        const createdAt = new Date().toISOString();
        stmtInsertBot.run(botId, deviceId, input.persistedRole ?? role, cwd, modelRef, conversationId, createdAt);
        stmtUpdateBotProfile.run(null, description, botId);
        stmtInsertConversation.run(conversationId, botId, PRIMARY_KIND);
        stmtInsertRequest.run(requestId, botId, role, cwd, modelRef, description);
        if (getPrimaryBotId() === null || input.makePrimary === true) {
          stmtSetPrimaryBot.run(botId, createdAt);
        }
        db.exec('COMMIT');
        committed = true;
        return getBot(botId);
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    const setPrimaryBot = (botId) => {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const row = stmtGetBot.get(botId);
        if (!row) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
        if (row.archived_at !== null) {
          throw errWithCode('archived bot cannot be set as primary', 'BOT_ARCHIVED');
        }
        stmtSetPrimaryBot.run(botId, new Date().toISOString());
        db.exec('COMMIT');
        committed = true;
        return getBot(botId);
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    const archiveBot = (botId) => {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const row = stmtGetBot.get(botId);
        if (!row) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
        if (getPrimaryBotId() === botId) {
          throw errWithCode('primary bot cannot be archived', 'PRIMARY_BOT_PROTECTED');
        }
        stmtArchiveBot.run(new Date().toISOString(), botId);
        db.exec('COMMIT');
        committed = true;
        return getBot(botId);
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    const unarchiveBot = (botId) => {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const row = stmtGetBot.get(botId);
        if (!row) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
        stmtUnarchiveBot.run(botId);
        db.exec('COMMIT');
        committed = true;
        return getBot(botId);
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    const deleteBot = (botId) => {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const row = stmtGetBot.get(botId);
        if (!row) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
        if (getPrimaryBotId() === botId) {
          throw errWithCode('primary bot cannot be deleted', 'PRIMARY_BOT_PROTECTED');
        }
        stmtDeleteBot.run(botId);
        db.exec('COMMIT');
        committed = true;
        return { botId, deleted: true };
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    const recordBotActivity = (botId, { lastActivityAt, lastPreview } = {}) => {
      const activityAt = typeof lastActivityAt === 'string' && lastActivityAt.trim() !== ''
        ? lastActivityAt
        : new Date().toISOString();
      const preview = typeof lastPreview === 'string' ? lastPreview.slice(0, 160) : (lastPreview ?? null);
      stmtRecordBotActivity.run(activityAt, preview, botId);
      return getBot(botId);
    };

    const listExpiredArchivedBots = (cutoffIso) => {
      const primaryBotId = getPrimaryBotId();
      return stmtListExpiredArchivedBots
        .all(cutoffIso)
        .filter((row) => row.bot_id !== primaryBotId)
        .map((row) => toBot(row, primaryBotId));
    };

    const getBotExtensionSettings = (botId) => toBotExtensionSettings(stmtGetBotExtensionSettings.get(botId));

    return {
      deviceId, getPrimaryBotId, getHostProfile,
      createBot, getBot, setBotCwd, updateBotProfile, findByRequest, listBots,
      setPrimaryBot, archiveBot, unarchiveBot, deleteBot, recordBotActivity, listExpiredArchivedBots,
      getBotExtensionSettings,
      close,
    };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    throw err;
  }
}
