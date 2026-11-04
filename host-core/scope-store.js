// host-core/scope-store.js
// 模块 12 托管 scope 元数据存储：只导出 schema SQL（迁移时执行）与
// createScopeStore 工厂（单纯读写层）。不在这里执行 schema/迁移/open/close，
// 不嵌套 BEGIN（事务由注入的 transaction 包装，ensureReplicaRecord 由调用方持锁），
// 输入由 scope-protocol 规范化、本地 Bot 存在性由 facade 检查。
import { randomUUID } from 'node:crypto';
import { messageError, digest } from './message-protocol.js';
import { MAX_SCOPE_CONTROL_BYTES } from './scope-protocol.js';

export const SCOPE_SCHEMA_SQL = `
  CREATE TABLE message_scope_authorities (
    scope_id TEXT PRIMARY KEY REFERENCES message_scopes(scope_id),
    authority_device_id TEXT NOT NULL
  );
  CREATE TABLE message_scope_operations (
    request_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    FOREIGN KEY (scope_id, revision) REFERENCES message_scope_revisions(scope_id, revision)
  );
  CREATE TABLE message_scope_deliveries (
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    target_device_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'acked')),
    acked_at TEXT,
    last_error_code TEXT,
    PRIMARY KEY (scope_id, revision, target_device_id),
    FOREIGN KEY (scope_id, revision) REFERENCES message_scope_revisions(scope_id, revision)
  );
  CREATE TABLE message_replica_streams (
    peer_device_id TEXT NOT NULL,
    source_device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    scope_id TEXT NOT NULL REFERENCES message_scopes(scope_id),
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    last_scanned_at TEXT,
    last_error_code TEXT,
    PRIMARY KEY (peer_device_id, source_device_id, stream_id)
  );
  CREATE TABLE message_history_sources (
    message_id TEXT NOT NULL REFERENCES message_events(message_id),
    peer_device_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (message_id, peer_device_id)
  );
  CREATE INDEX idx_message_scope_deliveries_state ON message_scope_deliveries(state, scope_id, revision, target_device_id);
  CREATE INDEX idx_message_replica_streams_scope ON message_replica_streams(scope_id, peer_device_id, source_device_id, stream_id);
`;

export function createScopeStore(db, { deviceId, transaction, queries, installScopeRevision }) {
  const stmtGetAuth = db.prepare('SELECT authority_device_id FROM message_scope_authorities WHERE scope_id = ?');
  const stmtInsertAuth = db.prepare('INSERT INTO message_scope_authorities (scope_id, authority_device_id) VALUES (?, ?)');
  const stmtGetOp = db.prepare('SELECT fingerprint, scope_id, revision FROM message_scope_operations WHERE request_id = ?');
  // 本地 create/update 操作记录存在性：authority 恢复的 peer revision 无本地操作行。
  const stmtOpExistsForRevision = db.prepare('SELECT 1 FROM message_scope_operations WHERE scope_id = ? AND revision = ? LIMIT 1');
  const stmtInsertOp = db.prepare('INSERT INTO message_scope_operations (request_id, fingerprint, scope_id, revision) VALUES (?, ?, ?, ?)');
  const stmtInsertDelivery = db.prepare(
    "INSERT INTO message_scope_deliveries (scope_id, revision, target_device_id, state, acked_at, last_error_code) VALUES (?, ?, ?, 'pending', NULL, NULL)"
  );
  const stmtGetDelivery = db.prepare(
    'SELECT target_device_id, state, acked_at, last_error_code FROM message_scope_deliveries WHERE scope_id = ? AND revision = ? AND target_device_id = ?'
  );
  const stmtListDeliveries = db.prepare(
    'SELECT target_device_id, state, acked_at, last_error_code FROM message_scope_deliveries WHERE scope_id = ? AND revision = ? ORDER BY target_device_id ASC'
  );
  const stmtAckDelivery = db.prepare(
    "UPDATE message_scope_deliveries SET state = 'acked', acked_at = ?, last_error_code = NULL WHERE scope_id = ? AND revision = ? AND target_device_id = ?"
  );
  const stmtSetDeliveryError = db.prepare(
    "UPDATE message_scope_deliveries SET last_error_code = ? WHERE scope_id = ? AND revision = ? AND target_device_id = ? AND state = 'pending'"
  );
  // 活跃 scope 状态列表排除墓碑：已删除群只保留墓碑供传播/历史读取，不再列活跃项。
  const stmtListScopeStates = db.prepare(
    `SELECT s.scope_id AS scope_id, s.kind AS kind, r.revision AS revision, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at
       FROM message_scopes s
       JOIN message_scope_revisions r ON r.scope_id = s.scope_id
       WHERE r.revision = (SELECT MAX(revision) FROM message_scope_revisions WHERE scope_id = s.scope_id)
         AND r.deleted_at IS NULL
       ORDER BY s.scope_id ASC
       LIMIT ?`
  );
  const stmtListScopeStatesAfter = db.prepare(
    `SELECT s.scope_id AS scope_id, s.kind AS kind, r.revision AS revision, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at
       FROM message_scopes s
       JOIN message_scope_revisions r ON r.scope_id = s.scope_id
       WHERE r.revision = (SELECT MAX(revision) FROM message_scope_revisions WHERE scope_id = s.scope_id)
         AND r.deleted_at IS NULL
         AND s.scope_id > ?
       ORDER BY s.scope_id ASC
       LIMIT ?`
  );
  const stmtListOffers = db.prepare(
    `SELECT d.scope_id AS scope_id, d.revision AS revision, d.target_device_id AS target_device_id,
            s.kind AS kind, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at, a.authority_device_id AS authority_device_id
       FROM message_scope_deliveries d
       JOIN message_scope_revisions r ON r.scope_id = d.scope_id AND r.revision = d.revision
       JOIN message_scopes s ON s.scope_id = d.scope_id
       JOIN message_scope_authorities a ON a.scope_id = d.scope_id
       WHERE a.authority_device_id = ? AND d.state = 'pending'
       ORDER BY d.scope_id ASC, d.revision ASC, d.target_device_id ASC
       LIMIT ?`
  );
  const stmtListOffersAfter = db.prepare(
    `SELECT d.scope_id AS scope_id, d.revision AS revision, d.target_device_id AS target_device_id,
            s.kind AS kind, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at, a.authority_device_id AS authority_device_id
       FROM message_scope_deliveries d
       JOIN message_scope_revisions r ON r.scope_id = d.scope_id AND r.revision = d.revision
       JOIN message_scopes s ON s.scope_id = d.scope_id
       JOIN message_scope_authorities a ON a.scope_id = d.scope_id
       WHERE a.authority_device_id = ? AND d.state = 'pending'
         AND (d.scope_id > ? OR (d.scope_id = ? AND d.revision > ?) OR (d.scope_id = ? AND d.revision = ? AND d.target_device_id > ?))
       ORDER BY d.scope_id ASC, d.revision ASC, d.target_device_id ASC
       LIMIT ?`
  );
  // 墓碑投递目标：全部历史 revision 成员 deviceId 并集——中途被移除的成员
  // 设备上仍持有旧副本，漏投会让其保留未删群并可继续发信/副本复活。
  const stmtListRevisionMembers = db.prepare(
    'SELECT members_json FROM message_scope_revisions WHERE scope_id = ?'
  );
  const stmtPeerMember = db.prepare(
    `SELECT 1 FROM message_scope_revisions r, json_each(r.members_json) m
       WHERE r.scope_id = ? AND json_extract(m.value, '$.deviceId') = ?
       LIMIT 1`
  );

  // 有界整项前缀：逐条追加直到最终序列化页（UTF-8 字节）达到控制上限；
  // 仅当单条本身即超限时报 RESPONSE_TOO_LARGE，否则截断并让游标指向最后实际返回项。
  function boundedWholeItemPrefix(rows, limit, makeItem, makeCursor, makePage) {
    const candidates = rows.slice(0, limit);
    let items = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const nextItems = items.concat([makeItem(candidates[i])]);
      const page = makePage(nextItems, makeCursor(nextItems[nextItems.length - 1]));
      if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_SCOPE_CONTROL_BYTES) {
        if (i === 0) {
          throw messageError('RESPONSE_TOO_LARGE', 'first item exceeds control byte budget');
        }
        return makePage(items, makeCursor(items[items.length - 1]));
      }
      items = nextItems;
    }
    return makePage(items, rows.length > limit ? makeCursor(items[items.length - 1]) : null);
  }

  function toScopeDefinition(row) {
    const scope = {
      scopeId: row.scope_id,
      kind: row.kind,
      revision: row.revision,
      members: JSON.parse(row.members_json),
    };
    if (row.title !== null && row.title !== undefined) scope.title = row.title;
    if (row.deleted_at !== null && row.deleted_at !== undefined) scope.deletedAt = row.deleted_at;
    return scope;
  }

  // delivery 仅在本机是 authority 且该 revision 存在本地 create/update 操作记录时构建；
  // 通过 peer 历史恢复的 revision 无本地操作行（原元数据移交状态不可得），delivery 保持 null，isAuthority 仍为 true。
  function scopeInfoFromRow(scope) {
    const authority = stmtGetAuth.get(scope.scopeId);
    const authorityDeviceId = authority ? authority.authority_device_id : null;
    const isAuthority = authorityDeviceId === deviceId;
    let delivery = null;
    if (isAuthority && stmtOpExistsForRevision.get(scope.scopeId, scope.revision)) {
      const targets = stmtListDeliveries.all(scope.scopeId, scope.revision).map((drow) => ({
        deviceId: drow.target_device_id,
        state: drow.state,
        acknowledgedAt: drow.acked_at,
        lastErrorCode: drow.last_error_code,
      }));
      delivery = { fullyAcknowledged: targets.every((target) => target.state === 'acked'), targets };
    }
    return { scope, authorityDeviceId, isAuthority, delivery };
  }

  function getAuthority(scopeId) {
    const authority = stmtGetAuth.get(scopeId);
    return authority ? authority.authority_device_id : null;
  }

  function getScopeRecord(scopeId, revision) {
    const row = queries.getScope(scopeId, revision ?? null);
    if (!row) return null;
    return { scope: row, authorityDeviceId: getAuthority(scopeId) };
  }

  function getScopeState(scopeId, revision) {
    const row = queries.getScope(scopeId, revision ?? null);
    if (!row) throw messageError('SCOPE_NOT_FOUND', 'scope not found');
    return scopeInfoFromRow(row);
  }

  function createScope(input) {
    const fingerprint = digest({ operation: 'create', input });
    return transaction(() => {
      const prior = stmtGetOp.get(input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw messageError('REQUEST_CONFLICT', 'requestId already used with a different definition');
        }
        // 幂等重试返回原结果 revision，不做任何当前版本检查。
        return getScopeState(prior.scope_id, prior.revision);
      }
      if (!input.members.some((member) => member.deviceId === deviceId)) {
        throw messageError('SCOPE_FORBIDDEN', 'creator device must have a local member');
      }
      const scopeId = randomUUID();
      installScopeRevision({ scopeId, kind: input.kind, revision: 1, members: input.members,
        ...(input.title !== undefined ? { title: input.title } : {}) });
      stmtInsertAuth.run(scopeId, deviceId);
      const remoteTargets = new Set();
      for (const member of input.members) {
        if (member.deviceId !== deviceId) remoteTargets.add(member.deviceId);
      }
      for (const target of remoteTargets) {
        stmtInsertDelivery.run(scopeId, 1, target);
      }
      stmtInsertOp.run(input.requestId, fingerprint, scopeId, 1);
      return getScopeState(scopeId, 1);
    });
  }

  function updateScope(scopeId, input) {
    const fingerprint = digest({ operation: 'update', scopeId, input });
    return transaction(() => {
      const prior = stmtGetOp.get(input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw messageError('REQUEST_CONFLICT', 'requestId already used with a different definition');
        }
        if (prior.scope_id !== scopeId) {
          throw messageError('REQUEST_CONFLICT', 'requestId already used for another scope');
        }
        return getScopeState(scopeId, prior.revision);
      }
      const latest = queries.getScope(scopeId);
      if (!latest) throw messageError('SCOPE_NOT_FOUND', 'scope not found');
      const authority = stmtGetAuth.get(scopeId);
      if (!authority) {
        throw messageError('SCOPE_UNMANAGED', 'scope is not managed');
      }
      if (authority.authority_device_id !== deviceId) {
        throw messageError('SCOPE_AUTHORITY_REQUIRED', 'only the scope authority may update');
      }
      if (latest.revision !== input.expectedRevision) {
        throw messageError('REQUEST_CONFLICT', 'expectedRevision does not match latest revision');
      }
      // 墓碑是终态：已删除 scope 不再接受成员/名称修改（只能经新 scope 重建）。
      if (latest.deletedAt !== undefined) {
        throw messageError('SCOPE_DELETED', 'scope has been deleted');
      }
      // title 是 room 元数据：DM 拒绝任何显式 title 更新（含清空）。
      if (latest.kind === 'dm' && input.title !== undefined) {
        throw messageError('REQUEST_CONFLICT', 'DM scopes have no room title');
      }
      const nextMembers = input.members !== undefined ? input.members : latest.members;
      // ''/全空白 = 显式清空回成员拼接默认名：规范化为未设置（NULL），与
      // normalizeScope 的“空 title 不携带键”一致，digest 不变。
      const nextTitle = input.title !== undefined && input.title !== ''
        ? input.title
        : undefined;
      const effectiveTitle = input.title === undefined ? latest.title : nextTitle;
      if (latest.kind === 'dm' && JSON.stringify(latest.members) !== JSON.stringify(nextMembers)) {
        throw messageError('REQUEST_CONFLICT', 'DM participants are immutable');
      }
      const revision = latest.revision + 1;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw messageError('REQUEST_CONFLICT', 'revision overflow');
      }
      installScopeRevision({ scopeId, kind: latest.kind, revision, members: nextMembers,
        ...(effectiveTitle !== undefined ? { title: effectiveTitle } : {}) });
      // 目标集 = 上一版 scope.members device 并集新成员 device，剔除本机；不沿用旧 delivery 行。
      const targets = new Set();
      for (const member of latest.members) {
        targets.add(member.deviceId);
      }
      for (const member of nextMembers) {
        targets.add(member.deviceId);
      }
      targets.delete(deviceId);
      for (const target of targets) {
        stmtInsertDelivery.run(scopeId, revision, target);
      }
      stmtInsertOp.run(input.requestId, fingerprint, scopeId, revision);
      return getScopeState(scopeId, revision);
    });
  }

  // 权威删除：CAS + requestId 幂等（重复 requestId 返回原墓碑，不冲突）。
  // 新 revision 冻结最终成员并携带 deletedAt 墓碑；墓碑经同一 offer/副本
  // 通道传播，所有 peer 据此拒绝旧流量复活并清本地工作。
  function deleteScope(scopeId, input) {
    const fingerprint = digest({ operation: 'delete', scopeId, input });
    return transaction(() => {
      const prior = stmtGetOp.get(input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw messageError('REQUEST_CONFLICT', 'requestId already used with a different definition');
        }
        if (prior.scope_id !== scopeId) {
          throw messageError('REQUEST_CONFLICT', 'requestId already used for another scope');
        }
        return getScopeState(scopeId, prior.revision);
      }
      const latest = queries.getScope(scopeId);
      if (!latest) throw messageError('SCOPE_NOT_FOUND', 'scope not found');
      const authority = stmtGetAuth.get(scopeId);
      if (!authority) {
        throw messageError('SCOPE_UNMANAGED', 'scope is not managed');
      }
      if (authority.authority_device_id !== deviceId) {
        throw messageError('SCOPE_AUTHORITY_REQUIRED', 'only the scope authority may delete');
      }
      if (latest.revision !== input.expectedRevision) {
        throw messageError('REQUEST_CONFLICT', 'expectedRevision does not match latest revision');
      }
      // 重复删除（新 requestId 对已墓碑 scope）直接返回现有墓碑，保持幂等。
      if (latest.deletedAt !== undefined) {
        return getScopeState(scopeId, latest.revision);
      }
      if (latest.kind !== 'room') {
        throw messageError('SCOPE_FORBIDDEN', 'only room scopes may be deleted');
      }
      const revision = latest.revision + 1;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw messageError('REQUEST_CONFLICT', 'revision overflow');
      }
      const deletedAt = new Date().toISOString();
      installScopeRevision({ scopeId, kind: latest.kind, revision, members: latest.members,
        ...(latest.title !== undefined ? { title: latest.title } : {}), deletedAt });
      // 墓碑要到达所有设备上的历史副本持有者：并集取本 scope 全部历史
      // revision 的成员 deviceId（含已被移除成员），剔除本机。
      const targets = new Set();
      for (const row of stmtListRevisionMembers.all(scopeId)) {
        for (const member of JSON.parse(row.members_json)) {
          targets.add(member.deviceId);
        }
      }
      targets.delete(deviceId);
      for (const target of targets) {
        stmtInsertDelivery.run(scopeId, revision, target);
      }
      stmtInsertOp.run(input.requestId, fingerprint, scopeId, revision);
      return getScopeState(scopeId, revision);
    });
  }

  function listScopeStates(options) {
    const { limit, cursor } = options;
    if (cursor !== null && cursor.deviceId !== deviceId) {
      throw messageError('INVALID_ARGUMENT', 'cursor does not match this query');
    }
    const rows =
      cursor === null
        ? stmtListScopeStates.all(limit + 1)
        : stmtListScopeStatesAfter.all(cursor.afterScopeId, limit + 1);
    return boundedWholeItemPrefix(
      rows,
      limit,
      (row) => scopeInfoFromRow(toScopeDefinition(row)),
      (item) => ({ deviceId, afterScopeId: item.scope.scopeId }),
      (items, nextCursor) => ({ deviceId, items, nextCursor })
    );
  }

  function acceptScopeOffer(peer, record) {
    if (record.authorityDeviceId === null) {
      throw messageError('INVALID_ARGUMENT', 'live offer must carry an authority device');
    }
    if (record.authorityDeviceId !== peer.deviceId) {
      throw messageError('SCOPE_FORBIDDEN', 'serving peer is not the recorded authority');
    }
    const ackDigest = digest(record);
    return transaction(() => {
      const scopeId = record.scope.scopeId;
      const latest = queries.getScope(scopeId);
      if (!latest) {
        installScopeRevision(record.scope);
        stmtInsertAuth.run(scopeId, record.authorityDeviceId);
        return { scopeId, revision: record.scope.revision, digest: ackDigest };
      }
      const authority = stmtGetAuth.get(scopeId);
      if (!authority) {
        throw messageError('SCOPE_UNMANAGED', 'existing scope is not managed; cannot adopt');
      }
      if (authority.authority_device_id !== record.authorityDeviceId) {
        throw messageError('REQUEST_CONFLICT', 'installed authority is immutable');
      }
      // 已墓碑的 scope 只接受墓碑 revision：旧 offer/未删 revision 不得复活；
      // 同一墓碑 revision 的重投递由 installScopeRevision 幂等冲突检查处理。
      if (latest.deletedAt !== undefined && record.scope.deletedAt === undefined) {
        throw messageError('SCOPE_DELETED', 'scope has been deleted');
      }
      installScopeRevision(record.scope);
      return { scopeId, revision: record.scope.revision, digest: ackDigest };
    });
  }

  function requireLocalAuthority(scopeId) {
    const authority = stmtGetAuth.get(scopeId);
    if (!authority) {
      if (!queries.getScope(scopeId)) {
        throw messageError('SCOPE_NOT_FOUND', 'scope not found');
      }
      throw messageError('SCOPE_AUTHORITY_REQUIRED', 'only the scope authority may manage deliveries');
    }
    if (authority.authority_device_id !== deviceId) {
      throw messageError('SCOPE_AUTHORITY_REQUIRED', 'only the scope authority may manage deliveries');
    }
  }

  function acknowledgeScope(peer, ack) {
    return transaction(() => {
      requireLocalAuthority(ack.scopeId);
      const row = stmtGetDelivery.get(ack.scopeId, ack.revision, peer.deviceId);
      if (!row) throw messageError('SCOPE_FORBIDDEN', 'delivery target not found or not permitted');
      const record = getScopeRecord(ack.scopeId, ack.revision);
      if (!record || digest(record) !== ack.digest) {
        throw messageError('REQUEST_CONFLICT', 'ack digest does not match stored scope record');
      }
      if (row.state === 'pending') {
        stmtAckDelivery.run(new Date().toISOString(), ack.scopeId, ack.revision, peer.deviceId);
      }
    });
  }

  function recordScopeError(peer, ack, code) {
    if (typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code)) {
      throw messageError('INVALID_ARGUMENT', 'error code must be nonempty uppercase/underscore and at most 64 chars');
    }
    return transaction(() => {
      requireLocalAuthority(ack.scopeId);
      const row = stmtGetDelivery.get(ack.scopeId, ack.revision, peer.deviceId);
      if (!row) throw messageError('SCOPE_FORBIDDEN', 'delivery target not found or not permitted');
      const record = getScopeRecord(ack.scopeId, ack.revision);
      if (!record || digest(record) !== ack.digest) {
        throw messageError('REQUEST_CONFLICT', 'ack digest does not match stored scope record');
      }
      if (row.state === 'pending') {
        stmtSetDeliveryError.run(code, ack.scopeId, ack.revision, peer.deviceId);
      }
    });
  }

  function scopeOffers(options) {
    const { limit, cursor } = options;
    const rows =
      cursor === null
        ? stmtListOffers.all(deviceId, limit + 1)
        : stmtListOffersAfter.all(
            deviceId,
            cursor.scopeId,
            cursor.scopeId,
            cursor.revision,
            cursor.scopeId,
            cursor.revision,
            cursor.targetDeviceId,
            limit + 1
          );
    return boundedWholeItemPrefix(
      rows,
      limit,
      (row) => {
        const record = {
          scope: toScopeDefinition(row),
          authorityDeviceId: row.authority_device_id,
        };
        return { targetDeviceId: row.target_device_id, record, digest: digest(record) };
      },
      (item) => ({
        scopeId: item.record.scope.scopeId,
        revision: item.record.scope.revision,
        targetDeviceId: item.targetDeviceId,
      }),
      (items, nextCursor) => ({ items, nextCursor })
    );
  }

  function assertReplicaPeer(peer, scopeId) {
    if (peer.deviceId === deviceId) {
      throw messageError('SCOPE_FORBIDDEN', 'peer must be a different device');
    }
    if (!queries.getScope(scopeId)) {
      throw messageError('SCOPE_NOT_FOUND', 'scope not found');
    }
    const authority = stmtGetAuth.get(scopeId);
    if (authority && authority.authority_device_id === peer.deviceId) return;
    if (stmtPeerMember.get(scopeId, peer.deviceId)) return;
    throw messageError('SCOPE_FORBIDDEN', 'peer is not a known scope member or authority');
  }

  function ensureReplicaRecord(peer, record) {
    assertReplicaPeer(peer, record.scope.scopeId);
    const scopeId = record.scope.scopeId;
    const authority = stmtGetAuth.get(scopeId);
    const hasPeer = record.scope.members.some((member) => member.deviceId === peer.deviceId);
    const hasLocal = record.scope.members.some((member) => member.deviceId === deviceId);
    if (!hasPeer || !hasLocal) {
      throw messageError('SCOPE_FORBIDDEN', 'revision must include both peer and local devices');
    }
    if (authority) {
      if (authority.authority_device_id !== record.authorityDeviceId) {
        throw messageError('REQUEST_CONFLICT', 'record authority does not match installed authority');
      }
      const latest = queries.getScope(scopeId);
      // 墓碑终态同上：未删 record 不得覆盖已墓碑 scope；同/旧墓碑走幂等检查。
      if (latest?.deletedAt !== undefined && record.scope.deletedAt === undefined) {
        throw messageError('SCOPE_DELETED', 'scope has been deleted');
      }
      return installScopeRevision(record.scope);
    }
    // Legacy 未托管 scope：绝不安装未知新 revision，只接受完全一致的已存定义。
    if (record.authorityDeviceId !== null) {
      throw messageError('REQUEST_CONFLICT', 'legacy scope cannot adopt an authority');
    }
    const existing = queries.getScope(scopeId, record.scope.revision);
    if (
      !existing ||
      existing.kind !== record.scope.kind ||
      JSON.stringify(existing.members) !== JSON.stringify(record.scope.members)
    ) {
      throw messageError('REQUEST_CONFLICT', 'legacy scope only accepts an exact existing revision');
    }
    return existing;
  }

  return {
    createScope,
    updateScope,
    deleteScope,
    getAuthority,
    getScopeRecord,
    getScopeState,
    listScopeStates,
    acceptScopeOffer,
    acknowledgeScope,
    recordScopeError,
    scopeOffers,
    assertReplicaPeer,
    ensureReplicaRecord,
  };
}
