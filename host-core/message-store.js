import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMessageQueries } from './message-queries.js';
import {
  messageError,
  streamIdForScope,
  normalizeEnvelope,
  normalizePublish,
  digest,
  assertScopeMessage,
} from './message-protocol.js';
import { SCOPE_SCHEMA_SQL, createScopeStore } from './scope-store.js';
import { createReplicaQueries } from './replica-queries.js';

const SCHEMA_VERSION = 3;
const DB_FILE = 'messages.sqlite';

// 模块 7 消息账本 schema：7 张表 + queries 需要的索引，参数化 SQL 各处使用。
const SCHEMA_SQL = `
  CREATE TABLE message_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
  );
  CREATE TABLE message_scopes (
    scope_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'room'))
  );
  CREATE TABLE message_scope_revisions (
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    members_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    title TEXT,
    deleted_at TEXT,
    PRIMARY KEY (scope_id, revision),
    FOREIGN KEY (scope_id) REFERENCES message_scopes(scope_id)
  );
  CREATE TABLE message_events (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    source_device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    envelope_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    publish_fingerprint TEXT,
    stored_at TEXT NOT NULL,
    UNIQUE (source_device_id, stream_id, source_seq),
    FOREIGN KEY (scope_id, revision) REFERENCES message_scope_revisions(scope_id, revision)
  );
  CREATE TABLE message_outbox (
    message_id TEXT NOT NULL,
    target_device_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'acked')),
    acked_at TEXT,
    PRIMARY KEY (message_id, target_device_id),
    FOREIGN KEY (message_id) REFERENCES message_events(message_id)
  );
  CREATE TABLE message_local_targets (
    message_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    PRIMARY KEY (message_id, bot_id),
    FOREIGN KEY (message_id) REFERENCES message_events(message_id)
  );
  CREATE TABLE message_streams (
    source_device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    highest_seq INTEGER NOT NULL,
    contiguous_seq INTEGER NOT NULL,
    PRIMARY KEY (source_device_id, stream_id),
    FOREIGN KEY (scope_id, revision) REFERENCES message_scope_revisions(scope_id, revision)
  );
  CREATE INDEX idx_message_events_scope_local ON message_events(scope_id, local_id);
  CREATE INDEX idx_message_local_targets_bot ON message_local_targets(bot_id, message_id);
  CREATE INDEX idx_message_outbox_state_target ON message_outbox(state, target_device_id);
`;

function initSchema(db, deviceId) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) {
      throw messageError('UNSUPPORTED_SCHEMA', 'message database schema version is newer than supported');
    }
    if (version === 0) {
      const existingTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      if (existingTables.length > 0) {
        throw messageError('UNSUPPORTED_SCHEMA', 'database file already contains unrecognized tables');
      }
      // 全新库：旧 M7 表 + M12 托管/副本表在同一事务内创建，随后写身份并置 v2。
      db.exec(SCHEMA_SQL);
      db.exec(SCOPE_SCHEMA_SQL);
      db.prepare('INSERT INTO message_meta (id, device_id) VALUES (1, ?)').run(deviceId);
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else {
      // v1/v2 先校验身份行与宿主 deviceId，再做 v1->v2 增量迁移。
      const row = db.prepare('SELECT device_id FROM message_meta WHERE id = 1').get();
      if (!row) {
        throw messageError('UNSUPPORTED_SCHEMA', 'message database is missing identity row');
      }
      if (row.device_id !== deviceId) {
        throw messageError('REQUEST_CONFLICT', 'message database owner deviceId does not match host deviceId');
      }
      if (version === 1) {
        db.exec(SCOPE_SCHEMA_SQL);
        db.exec('PRAGMA user_version = 2');
      }
      // v2->v3：scope revision 增加 room title 与删除墓碑列；旧行保持 NULL，
      // 规范化值不携带对应键，digest 与 v2 行为一致。
      if (db.prepare('PRAGMA user_version').get().user_version === 2) {
        db.exec('ALTER TABLE message_scope_revisions ADD COLUMN title TEXT');
        db.exec('ALTER TABLE message_scope_revisions ADD COLUMN deleted_at TEXT');
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
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

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const result = fn();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

export function openMessageStore(dataRoot, deviceId) {
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
    initSchema(db, deviceId);

    const stmtGetScopeRev = db.prepare('SELECT * FROM message_scope_revisions WHERE scope_id = ? AND revision = ?');
    const stmtGetScopeKind = db.prepare('SELECT kind FROM message_scopes WHERE scope_id = ?');
    const stmtCountScopeRevs = db.prepare('SELECT COUNT(*) AS n FROM message_scope_revisions WHERE scope_id = ?');
    const stmtGetLatestScope = db.prepare(
      'SELECT * FROM message_scope_revisions WHERE scope_id = ? ORDER BY revision DESC LIMIT 1'
    );
    const stmtInsertScope = db.prepare('INSERT INTO message_scopes (scope_id, kind) VALUES (?, ?)');
    const stmtInsertRevision = db.prepare(
      'INSERT INTO message_scope_revisions (scope_id, revision, members_json, fingerprint, title, deleted_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const stmtGetEventByMsg = db.prepare('SELECT * FROM message_events WHERE message_id = ?');
    const stmtGetEventBySrcStreamSeq = db.prepare(
      'SELECT * FROM message_events WHERE source_device_id = ? AND stream_id = ? AND source_seq = ?'
    );
    const stmtHasNewInput = db.prepare(
      `SELECT 1 FROM message_events e
         WHERE e.scope_id = ? AND e.local_id > ?
           AND EXISTS (
             SELECT 1 FROM message_local_targets t
             WHERE t.message_id = e.message_id AND t.bot_id = ?
           )
           AND NOT (
             e.source_device_id = ?
             AND json_extract(e.envelope_json, '$.author.kind') = 'bot'
             AND json_extract(e.envelope_json, '$.author.botId') = ?
           )
         ORDER BY e.local_id ASC
         LIMIT 1`
    );
    const stmtInsertEvent = db.prepare(
      'INSERT INTO message_events (message_id, source_device_id, stream_id, source_seq, scope_id, revision, envelope_json, digest, publish_fingerprint, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const stmtInsertOutbox = db.prepare(
      "INSERT INTO message_outbox (message_id, target_device_id, state, acked_at) VALUES (?, ?, 'pending', NULL)"
    );
    const stmtInsertLocalTarget = db.prepare(
      'INSERT INTO message_local_targets (message_id, bot_id) VALUES (?, ?)'
    );
    const stmtGetAuthPublic = db.prepare('SELECT authority_device_id FROM message_scope_authorities WHERE scope_id = ?');
    const stmtSetFingerprint = db.prepare('UPDATE message_events SET publish_fingerprint = ? WHERE message_id = ?');
    const stmtInsertOutboxIgnore = db.prepare(
      "INSERT OR IGNORE INTO message_outbox (message_id, target_device_id, state, acked_at) VALUES (?, ?, 'pending', NULL)"
    );
    const stmtInsertHistorySource = db.prepare(
      'INSERT OR IGNORE INTO message_history_sources (message_id, peer_device_id, received_at) VALUES (?, ?, ?)'
    );
    const stmtUpsertReplicaStream = db.prepare(
      `INSERT INTO message_replica_streams (peer_device_id, source_device_id, stream_id, scope_id, revision, snapshot_json, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_device_id, source_device_id, stream_id)
       DO UPDATE SET scope_id = excluded.scope_id, revision = excluded.revision,
                    snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at`
    );
    const stmtUpdateObservedScan = db.prepare(
      `UPDATE message_replica_streams
          SET last_scanned_at = ?, last_error_code = ?
        WHERE peer_device_id = ? AND source_device_id = ? AND stream_id = ?
          AND scope_id = ? AND revision = ?`
    );
    // 墓碑安装时的 scope 数据清理：删除该 scope 的消息账本/投递/本地目标/
    // 流进度/历史来源/副本观测行（同一事务）。托管 deliveries/operations/
    // revisions 保留——墓碑与投递记录仍需传播与幂等对账。
    const stmtDeleteScopeOutbox = db.prepare(
      'DELETE FROM message_outbox WHERE message_id IN (SELECT message_id FROM message_events WHERE scope_id = ?)'
    );
    const stmtDeleteScopeLocalTargets = db.prepare(
      'DELETE FROM message_local_targets WHERE message_id IN (SELECT message_id FROM message_events WHERE scope_id = ?)'
    );
    const stmtDeleteScopeHistorySources = db.prepare(
      'DELETE FROM message_history_sources WHERE message_id IN (SELECT message_id FROM message_events WHERE scope_id = ?)'
    );
    const stmtDeleteScopeEvents = db.prepare('DELETE FROM message_events WHERE scope_id = ?');
    const stmtDeleteScopeStreams = db.prepare('DELETE FROM message_streams WHERE scope_id = ?');
    const stmtDeleteScopeReplicaStreams = db.prepare('DELETE FROM message_replica_streams WHERE scope_id = ?');
    const purgeScopeData = (scopeId) => {
      stmtDeleteScopeOutbox.run(scopeId);
      stmtDeleteScopeLocalTargets.run(scopeId);
      stmtDeleteScopeHistorySources.run(scopeId);
      stmtDeleteScopeEvents.run(scopeId);
      stmtDeleteScopeStreams.run(scopeId);
      stmtDeleteScopeReplicaStreams.run(scopeId);
    };

    const stmtReplicaPeers = db.prepare(
      `SELECT DISTINCT x.device_id AS device_id
         FROM (
           SELECT json_extract(m.value, '$.deviceId') AS device_id
             FROM message_scope_revisions r, json_each(r.members_json) m
            WHERE r.scope_id = ?
           UNION
           SELECT authority_device_id AS device_id FROM message_scope_authorities WHERE scope_id = ?
         ) x
        WHERE x.device_id IS NOT NULL AND x.device_id <> ?
        ORDER BY x.device_id ASC`
    );

    const stmtGetStream = db.prepare('SELECT * FROM message_streams WHERE source_device_id = ? AND stream_id = ?');
    const stmtInsertStream = db.prepare(
      'INSERT INTO message_streams (source_device_id, stream_id, scope_id, revision, highest_seq, contiguous_seq) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const stmtUpdateStream = db.prepare(
      'UPDATE message_streams SET highest_seq = ?, contiguous_seq = ?, scope_id = ?, revision = ? WHERE source_device_id = ? AND stream_id = ?'
    );
    const stmtHasSeq = db.prepare(
      'SELECT 1 FROM message_events WHERE source_device_id = ? AND stream_id = ? AND source_seq = ?'
    );

    const stmtGetOutbox = db.prepare('SELECT * FROM message_outbox WHERE message_id = ? AND target_device_id = ?');
    const stmtUpdateOutboxAcked = db.prepare(
      "UPDATE message_outbox SET state = 'acked', acked_at = ? WHERE message_id = ? AND target_device_id = ?"
    );

    const queries = createMessageQueries(db, { deviceId });

    const makeAck = (row, sourceDeviceId) => ({
      protocolVersion: 1,
      messageId: row.message_id,
      sourceDeviceId,
      recipientDeviceId: deviceId,
      digest: row.digest,
      storedAt: row.stored_at,
    });

    const applyStreamPublish = (scopeId, revision, streamId, seq) => {
      const row = stmtGetStream.get(deviceId, streamId);
      if (!row) {
        stmtInsertStream.run(deviceId, streamId, scopeId, revision, seq, seq === 1 ? 1 : 0);
        return;
      }
      const contiguous = row.contiguous_seq === row.highest_seq ? seq : row.contiguous_seq;
      stmtUpdateStream.run(seq, contiguous, scopeId, revision, deviceId, streamId);
    };

    // 只沿已存在的序列推进 contiguous；绝不按 1..highest 整数范围循环。
    const applyStreamReceive = (sourceDeviceId, scopeId, revision, streamId, seq) => {
      const row = stmtGetStream.get(sourceDeviceId, streamId);
      if (!row) {
        stmtInsertStream.run(sourceDeviceId, streamId, scopeId, revision, seq, seq === 1 ? 1 : 0);
        return;
      }
      const highest = Math.max(row.highest_seq, seq);
      let contiguous = row.contiguous_seq;
      if (seq === contiguous + 1) {
        let c = seq;
        while (c < highest && stmtHasSeq.get(sourceDeviceId, streamId, c + 1)) c += 1;
        contiguous = c;
      }
      if (highest !== row.highest_seq || contiguous !== row.contiguous_seq) {
        stmtUpdateStream.run(highest, contiguous, scopeId, revision, sourceDeviceId, streamId);
      }
    };

    // 自源恢复：用 INSERT OR IGNORE 补远程目标 outbox 行，保留已 ack/已存在行。
    const restoreOutboxTargets = (envelope) => {
      for (const member of envelope.targets) {
        if (member.deviceId !== deviceId) {
          stmtInsertOutboxIgnore.run(envelope.messageId, member.deviceId);
        }
      }
    };

    // 私有同步 ingest：已验证封套的去重/引用/来源序列冲突检查、写入、本地目标与流推进。
    // 不开启事务（调用方持锁），不与 peer 身份绑定；普通 receive 与副本导入共用。
    // publishFingerprint 非 null 时作为事件发布指纹存储（仅自源恢复路径使用）。
    const ingestEnvelopeWithinTransaction = (envelope, { publishFingerprint = null, restoreOutbox = false } = {}) => {
      const envelopeDigest = digest(envelope);
      const existing = stmtGetEventByMsg.get(envelope.messageId);
      if (existing) {
        if (existing.digest !== envelopeDigest) {
          throw messageError('REQUEST_CONFLICT', 'messageId already used with a different envelope');
        }
        if (restoreOutbox) {
          // 匹配的完整封套只补空指纹，绝不覆盖已有指纹。
          if (existing.publish_fingerprint === null && publishFingerprint !== null) {
            stmtSetFingerprint.run(publishFingerprint, envelope.messageId);
          }
          restoreOutboxTargets(envelope);
        }
        return {
          message: queries.getMessage(existing.message_id),
          ack: makeAck(existing, envelope.sourceDeviceId),
          duplicate: true,
        };
      }
      const seqUsed = stmtGetEventBySrcStreamSeq.get(envelope.sourceDeviceId, envelope.streamId, envelope.sequence);
      if (seqUsed) {
        throw messageError('REQUEST_CONFLICT', 'source sequence already used by a different message');
      }
      for (const ref of [envelope.rootId, envelope.replyTo]) {
        if (!ref || ref === envelope.messageId) continue;
        const known = stmtGetEventByMsg.get(ref);
        if (known && known.scope_id !== envelope.scopeId) {
          throw messageError('REQUEST_CONFLICT', 'reference points outside the message scope');
        }
      }
      const storedAt = new Date().toISOString();
      stmtInsertEvent.run(
        envelope.messageId,
        envelope.sourceDeviceId,
        envelope.streamId,
        envelope.sequence,
        envelope.scopeId,
        envelope.revision,
        JSON.stringify(envelope),
        envelopeDigest,
        publishFingerprint,
        storedAt
      );
      for (const member of envelope.targets) {
        if (member.deviceId === deviceId) {
          stmtInsertLocalTarget.run(envelope.messageId, member.botId);
        }
      }
      if (restoreOutbox) {
        restoreOutboxTargets(envelope);
      }
      applyStreamReceive(envelope.sourceDeviceId, envelope.scopeId, envelope.revision, envelope.streamId, envelope.sequence);
      const row = stmtGetEventByMsg.get(envelope.messageId);
      return {
        message: queries.getMessage(row.message_id),
        ack: makeAck(row, envelope.sourceDeviceId),
        duplicate: false,
      };
    };

    // 无 BEGIN 的 M7 scope 安装体（scopeStore 回调与公开 installScope 共用）。
    // 规范化行 -> 存储行：title/deletedAt 缺省存 NULL；行 -> 返回值只补已存键。
    const scopeRowToValue = (row, scopeId, kind, revision) => {
      const scope = { scopeId, kind, revision, members: JSON.parse(row.members_json) };
      if (row.title !== null && row.title !== undefined) scope.title = row.title;
      if (row.deleted_at !== null && row.deleted_at !== undefined) scope.deletedAt = row.deleted_at;
      return scope;
    };
    const installScopeRevision = (input) => {
      const fingerprint = digest(input);
      const existing = stmtGetScopeRev.get(input.scopeId, input.revision);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw messageError('REQUEST_CONFLICT', 'scope revision already installed with a different definition');
        }
        const kindRow = stmtGetScopeKind.get(input.scopeId);
        return scopeRowToValue(existing, input.scopeId, kindRow.kind, input.revision);
      }
      const kindRow = stmtGetScopeKind.get(input.scopeId);
      if (kindRow && kindRow.kind !== input.kind) {
        throw messageError('REQUEST_CONFLICT', 'scope kind cannot change across revisions');
      }
      if (kindRow?.kind === 'dm' && stmtGetLatestScope.get(input.scopeId).members_json !== JSON.stringify(input.members)) {
        throw messageError('REQUEST_CONFLICT', 'DM participants are fixed; create a different scope for another pair');
      }
      if (stmtCountScopeRevs.get(input.scopeId).n === 0 && input.deletedAt === undefined) {
        const hasLocalMember = input.members.some((member) => member.deviceId === deviceId);
        if (!hasLocalMember) {
          throw messageError('SCOPE_FORBIDDEN', 'first installed scope revision must include a local member bot');
        }
      }
      if (!kindRow) {
        stmtInsertScope.run(input.scopeId, input.kind);
      }
      stmtInsertRevision.run(
        input.scopeId,
        input.revision,
        JSON.stringify(input.members),
        fingerprint,
        // 规范化层已把 '' 归一为空（不携带键）；防御性再映射，避免任何路径
        // 把空串当真实 title 存储而破坏“title:''=缺省”的 digest 口径。
        input.title === undefined || input.title === '' ? null : input.title,
        input.deletedAt ?? null
      );
      // 墓碑落定即清该 scope 本地账本数据：权威删除与 peer 接收/导入同口径，
      // 之后旧 replica/晚到消息在接收侧被墓碑检查拦截，本地不再残留可复活数据。
      if (input.deletedAt !== undefined) purgeScopeData(input.scopeId);
      return { scopeId: input.scopeId, kind: input.kind, revision: input.revision, members: input.members,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.deletedAt !== undefined ? { deletedAt: input.deletedAt } : {}) };
    };

    // 公开遗留安装仍走自己的事务；托管 scope 仅接受完全一致的已装版本幂等重试。
    const installScope = (input) => inTransaction(db, () => {
      const authorityRow = stmtGetAuthPublic.get(input.scopeId);
      if (authorityRow) {
        const existing = stmtGetScopeRev.get(input.scopeId, input.revision);
        if (!existing || existing.fingerprint !== digest(input)) {
          throw messageError('SCOPE_AUTHORITY_REQUIRED', 'managed scope requires the create/update APIs');
        }
        const kindRow = stmtGetScopeKind.get(input.scopeId);
        return scopeRowToValue(existing, input.scopeId, kindRow.kind, input.revision);
      }
      return installScopeRevision(input);
    });

    const scopeStore = createScopeStore(db, {
      deviceId,
      transaction: (fn) => inTransaction(db, fn),
      queries,
      installScopeRevision,
    });
    const replicaQueries = createReplicaQueries(db, { deviceId, queries, scopeStore });

    const publish = (input, guard = null) => inTransaction(db, () => {
      const fingerprint = digest(input);
      // 去重先于目标/来源 scope 与新输入检查：同请求重试返回原封套（保留老目标/序号）。
      const existing = stmtGetEventByMsg.get(input.messageId);
      if (existing) {
        if (existing.publish_fingerprint !== null && existing.publish_fingerprint === fingerprint) {
          return queries.getMessage(existing.message_id);
        }
        throw messageError('REQUEST_CONFLICT', 'messageId already used with a different publish request');
      }

      const scope = stmtGetLatestScope.get(input.scopeId);
      if (!scope) {
        throw messageError('SCOPE_NOT_FOUND', 'scope not installed');
      }
      // 墓碑上的写入一律拒绝：已删除群不再产生新消息（历史仍可读）。
      if (scope.deleted_at !== null && scope.deleted_at !== undefined) {
        throw messageError('SCOPE_DELETED', 'scope has been deleted');
      }
      const members = JSON.parse(scope.members_json);

      let rootId = input.messageId;
      if (input.replyTo) {
        const parentRow = stmtGetEventByMsg.get(input.replyTo);
        if (!parentRow || parentRow.scope_id !== input.scopeId) {
          throw messageError('MESSAGE_NOT_FOUND', 'replyTo does not reference a stored message in the same scope');
        }
        rootId = JSON.parse(parentRow.envelope_json).rootId;
      }
      if (input.author.kind === 'user') {
        rootId = input.messageId;
      }

      const streamId = streamIdForScope(input.scopeId, scope.revision);
      const streamRow = stmtGetStream.get(deviceId, streamId);
      const sequence = (streamRow ? streamRow.highest_seq : 0) + 1;

      const envelope = normalizeEnvelope({
        protocolVersion: 1,
        messageId: input.messageId,
        sourceDeviceId: deviceId,
        streamId,
        sequence,
        scopeId: input.scopeId,
        revision: scope.revision,
        author: input.author,
        category: input.category,
        rootId,
        replyTo: input.replyTo,
        text: input.text,
        targets: members,
        createdAt: new Date().toISOString(),
      });
      // 与 receive 相同的协议检查：作者成员资格/类别/scope 参与，杜绝非成员 Bot、human 进 DM、wrong category、Host 退出后发信。
      const scopeObj = {
        scopeId: input.scopeId,
        kind: stmtGetScopeKind.get(input.scopeId).kind,
        revision: scope.revision,
        members,
      };
      assertScopeMessage(scopeObj, envelope, deviceId);
      if (guard !== null) {
        // guard 绑定模型读取的来源 scope，不一定是本次发送目标。
        const originScope = stmtGetLatestScope.get(guard.scopeId);
        if (!originScope) {
          throw messageError('SCOPE_NOT_FOUND', 'origin scope not installed');
        }
        const originMembers = JSON.parse(originScope.members_json);
        const botId = input.author.botId;
        if (!originMembers.some((member) => member.deviceId === deviceId && member.botId === botId)) {
          throw messageError('SCOPE_FORBIDDEN', 'publisher bot must be a current member of the origin scope');
        }
        if (stmtHasNewInput.get(guard.scopeId, guard.afterLocalId, botId, deviceId, botId)) {
          throw messageError('STALE_INPUT', 'new input arrived before publication');
        }
      }
      const envelopeDigest = digest(envelope);
      const storedAt = new Date().toISOString();
      stmtInsertEvent.run(
        envelope.messageId,
        envelope.sourceDeviceId,
        envelope.streamId,
        envelope.sequence,
        envelope.scopeId,
        envelope.revision,
        JSON.stringify(envelope),
        envelopeDigest,
        fingerprint,
        storedAt
      );
      const localTargets = [];
      const remoteHosts = new Set();
      for (const member of envelope.targets) {
        if (member.deviceId === deviceId) {
          localTargets.push(member.botId);
        } else {
          remoteHosts.add(member.deviceId);
        }
      }
      for (const botId of localTargets) {
        stmtInsertLocalTarget.run(envelope.messageId, botId);
      }
      for (const targetDeviceId of remoteHosts) {
        stmtInsertOutbox.run(envelope.messageId, targetDeviceId);
      }
      applyStreamPublish(envelope.scopeId, envelope.revision, envelope.streamId, envelope.sequence);
      return queries.getMessage(envelope.messageId);
    });

    const receive = (peer, envelope) => inTransaction(db, () => {
      if (peer.deviceId !== envelope.sourceDeviceId) {
        throw messageError('PEER_MISMATCH', 'peer deviceId does not match envelope sourceDeviceId');
      }
      // 墓碑先于历史 revision 命中检查：删除后一切晚到消息拒绝入库，
      // 已删除 scope 绝不能被旧流量复活。
      const latestScope = stmtGetLatestScope.get(envelope.scopeId);
      if (latestScope && latestScope.deleted_at !== null && latestScope.deleted_at !== undefined) {
        throw messageError('SCOPE_DELETED', 'scope has been deleted');
      }
      const scope = stmtGetScopeRev.get(envelope.scopeId, envelope.revision);
      if (!scope) {
        throw messageError('SCOPE_NOT_FOUND', 'scope revision not installed');
      }
      const kindRow = stmtGetScopeKind.get(envelope.scopeId);
      const scopeObj = {
        scopeId: envelope.scopeId,
        kind: kindRow.kind,
        revision: envelope.revision,
        members: JSON.parse(scope.members_json),
      };
      // 作者/类别/scope 目标（含 streamId）检查由协议 assertScopeMessage 完成；本机 Bot 存在性由 facade 检查。
      assertScopeMessage(scopeObj, envelope, deviceId);
      return ingestEnvelopeWithinTransaction(envelope, { publishFingerprint: null });
    });

    const acknowledge = (peer, ack) => {
      inTransaction(db, () => {
        if (peer.deviceId !== ack.recipientDeviceId) {
          throw messageError('PEER_MISMATCH', 'peer deviceId does not match ack recipientDeviceId');
        }
        if (ack.sourceDeviceId !== deviceId) {
          throw messageError('REQUEST_CONFLICT', 'ack sourceDeviceId is not this host');
        }
        const event = stmtGetEventByMsg.get(ack.messageId);
        if (!event) {
          throw messageError('MESSAGE_NOT_FOUND', 'message not found');
        }
        if (event.source_device_id !== deviceId) {
          throw messageError('SCOPE_FORBIDDEN', 'message was not originated on this host');
        }
        if (event.digest !== ack.digest) {
          throw messageError('REQUEST_CONFLICT', 'ack digest does not match stored message');
        }
        const outbox = stmtGetOutbox.get(ack.messageId, ack.recipientDeviceId);
        if (!outbox) {
          throw messageError('DELIVERY_NOT_FOUND', 'delivery target not found');
        }
        if (outbox.state === 'pending') {
          stmtUpdateOutboxAcked.run(new Date().toISOString(), ack.messageId, ack.recipientDeviceId);
        }
      });
      return queries.deliveryStatus(ack.messageId);
    };

    // 内部 peer 发现：只读已装修订成员与存储 authority，排除本机，不做网络/目录查找。
    const listReplicaPeers = (scopeId) => {
      if (!queries.getScope(scopeId)) {
        throw messageError('SCOPE_NOT_FOUND', 'scope not found');
      }
      return stmtReplicaPeers.all(scopeId, scopeId, deviceId).map((row) => row.device_id);
    };

    // 观测写入：整页校验全部完成后原子 upsert 快照；不证明本地完整覆盖或在线活性。
    const recordReplicaInventory = (peer, query, page) => {
      if (page.scopeId !== query.scopeId) {
        throw messageError('INVALID_ARGUMENT', 'page scopeId must match query scopeId');
      }
      if (page.items.length > query.limit) {
        throw messageError('INVALID_ARGUMENT', 'page items exceed query limit');
      }
      if (page.nextCursor !== null) {
        if (
          page.nextCursor.deviceId !== peer.deviceId ||
          page.nextCursor.requesterDeviceId !== deviceId ||
          page.nextCursor.scopeId !== query.scopeId
        ) {
          throw messageError('INVALID_ARGUMENT', 'response cursor is not bound to this peer/requester/scope');
        }
        const last = page.items[page.items.length - 1];
        if (
          page.nextCursor.afterSourceDeviceId !== last.sourceDeviceId ||
          page.nextCursor.afterStreamId !== last.streamId
        ) {
          throw messageError('INVALID_ARGUMENT', 'response cursor must reference the last returned stream');
        }
      }
      // 输入游标必须绑定 serving peer、本机 requester 与 query scope，空页同样要求。
      if (query.cursor !== null) {
        if (
          query.cursor.deviceId !== peer.deviceId ||
          query.cursor.requesterDeviceId !== deviceId ||
          query.cursor.scopeId !== query.scopeId
        ) {
          throw messageError('INVALID_ARGUMENT', 'input cursor must bind serving peer, this host as requester and the query scope');
        }
      }
      // 每个返回 key 都必须严格大于上一 tuple（SQLite BINARY UTF-8 序），拒绝重复/乱序；
      // 首页无输入游标时也强制页内严格递增。
      let prevSource = query.cursor ? query.cursor.afterSourceDeviceId : null;
      let prevStream = query.cursor ? query.cursor.afterStreamId : null;
      for (const item of page.items) {
        if (prevSource !== null) {
          const cmpSource = Buffer.compare(Buffer.from(item.sourceDeviceId, 'utf8'), Buffer.from(prevSource, 'utf8'));
          const cmpStream = Buffer.compare(Buffer.from(item.streamId, 'utf8'), Buffer.from(prevStream, 'utf8'));
          if (cmpSource < 0 || (cmpSource === 0 && cmpStream <= 0)) {
            throw messageError('INVALID_ARGUMENT', 'stream keys must strictly increase in SQLite BINARY UTF-8 order');
          }
        }
        prevSource = item.sourceDeviceId;
        prevStream = item.streamId;
      }
      return inTransaction(db, () => {
        scopeStore.assertReplicaPeer(peer, query.scopeId);
        // 墓碑 scope 不再记录副本观测：已删除群的数据面已清理，观测行无意义。
        const latestScope = stmtGetLatestScope.get(query.scopeId);
        if (latestScope && latestScope.deleted_at !== null && latestScope.deleted_at !== undefined) {
          throw messageError('SCOPE_DELETED', 'scope has been deleted');
        }
        // 已装修订成员检查属 DB 依赖，必须在 peer 授权之后的同一写事务内执行，
        // 避免并发安装者在检查与提交之间把未知修订变为已知。
        for (const item of page.items) {
          const localScope = queries.getScope(query.scopeId, item.revision);
          if (localScope) {
            const memberIds = new Set(localScope.members.map((member) => member.deviceId));
            if (!memberIds.has(peer.deviceId) || !memberIds.has(deviceId) || !memberIds.has(item.sourceDeviceId)) {
              throw messageError('SCOPE_FORBIDDEN', 'installed revision must include serving peer, local device and source device');
            }
          }
        }
        const observedAt = new Date().toISOString();
        for (const item of page.items) {
          stmtUpsertReplicaStream.run(
            peer.deviceId,
            item.sourceDeviceId,
            item.streamId,
            query.scopeId,
            item.revision,
            JSON.stringify(item),
            observedAt
          );
        }
      });
    };

    // 授权副本历史导入：整页元数据/消息/目标/流/来源记录原子回滚。
    const importReplicaHistory = (peer, query, page) => {
      if (
        page.record.scope.scopeId !== query.scopeId ||
        page.record.scope.revision !== query.revision ||
        page.sourceDeviceId !== query.sourceDeviceId ||
        page.afterSequence !== query.afterSequence ||
        page.throughSequence !== query.throughSequence
      ) {
        throw messageError('INVALID_ARGUMENT', 'history page echo must match the originating query');
      }
      if (page.items.length > query.limit) {
        throw messageError('INVALID_ARGUMENT', 'history page items exceed query limit');
      }
      // 即使空页，源设备也必须是该修订成员（不制造未观测的非成员源）。
      if (!page.record.scope.members.some((member) => member.deviceId === query.sourceDeviceId)) {
        throw messageError('SCOPE_FORBIDDEN', 'source device must be a member of the record revision');
      }
      // 墓碑 revision 没有合法历史页（删除后不允许任何封套）：整条拒绝，
      // 绝不通过 ensureReplicaRecord 引入墓碑后再塞进同 revision 消息复活。
      if (page.record.scope.deletedAt !== undefined) {
        throw messageError('SCOPE_DELETED', 'deleted scope has no valid history pages');
      }
      return inTransaction(db, () => {
        // 已删除 scope 的副本历史同样拒绝：墓碑是终态，旧 history 导入不得复活。
        const latestScope = stmtGetLatestScope.get(page.record.scope.scopeId);
        if (latestScope && latestScope.deleted_at !== null && latestScope.deleted_at !== undefined) {
          throw messageError('SCOPE_DELETED', 'scope has been deleted');
        }
        scopeStore.ensureReplicaRecord(peer, page.record);
        let imported = 0;
        let duplicates = 0;
        const receivedAt = new Date().toISOString();
        for (const envelope of page.items) {
          // 业务校验（冻结目标/作者/类别/本地参与）对每个封套执行，含重复；
          // 仅授权副本导入路径允许 source!=serving peer，assertScopeMessage 不比较 peer。
          assertScopeMessage(page.record.scope, envelope, deviceId);
          const selfOrigin = envelope.sourceDeviceId === deviceId;
          // 自源恢复：按原发布输入重建指纹；第三方历史保持 null 指纹与无 outbox。
          const fingerprint = selfOrigin
            ? digest(
                normalizePublish({
                  messageId: envelope.messageId,
                  scopeId: envelope.scopeId,
                  author: envelope.author,
                  category: envelope.category,
                  text: envelope.text,
                  replyTo: envelope.replyTo,
                })
              )
            : null;
          const result = ingestEnvelopeWithinTransaction(envelope, {
            publishFingerprint: fingerprint,
            restoreOutbox: selfOrigin,
          });
          if (result.duplicate) duplicates += 1;
          else imported += 1;
          stmtInsertHistorySource.run(envelope.messageId, peer.deviceId, receivedAt);
        }
        return {
          scopeId: query.scopeId,
          revision: query.revision,
          sourceDeviceId: query.sourceDeviceId,
          imported,
          duplicates,
          nextAfterSequence: page.nextAfterSequence,
        };
      });
    };

    // 记录请求区间扫描结果：只更新已存在观测，绝不虚构观测。
    const recordReplicaScan = (peer, query, code = null) => {
      if (code !== null && (typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code))) {
        throw messageError('INVALID_ARGUMENT', 'error code must be null or a stable uppercase/underscore code up to 64 chars');
      }
      scopeStore.assertReplicaPeer(peer, query.scopeId);
      const streamId = streamIdForScope(query.scopeId, query.revision);
      stmtUpdateObservedScan.run(
        new Date().toISOString(),
        code,
        peer.deviceId,
        query.sourceDeviceId,
        streamId,
        query.scopeId,
        query.revision
      );
    };

    return {
      deviceId,
      ...queries,
      installScope,
      publish,
      receive,
      acknowledge,
      createScope: scopeStore.createScope,
      updateScope: scopeStore.updateScope,
      deleteScope: scopeStore.deleteScope,
      getScopeState: scopeStore.getScopeState,
      listScopeStates: scopeStore.listScopeStates,
      getScopeRecord: scopeStore.getScopeRecord,
      acceptScopeOffer: scopeStore.acceptScopeOffer,
      acknowledgeScope: scopeStore.acknowledgeScope,
      recordScopeError: scopeStore.recordScopeError,
      scopeOffers: scopeStore.scopeOffers,
      replicaInventory: replicaQueries.inventory,
      replicaHistory: replicaQueries.historyPage,
      nextMissingRange: replicaQueries.nextMissingRange,
      listScopeReplicas: replicaQueries.listScopeReplicas,
      listReplicaPeers,
      recordReplicaInventory,
      importReplicaHistory,
      recordReplicaScan,
      close,
    };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    throw err;
  }
}
