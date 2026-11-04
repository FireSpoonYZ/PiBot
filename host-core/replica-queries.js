import { messageError, streamIdForScope } from './message-protocol.js';
import {
  MAX_SCOPE_SYNC_BYTES,
  MAX_SCOPE_CONTROL_BYTES,
} from './scope-protocol.js';

// 只读复制查询层：仅 prepared SELECT。授权/写/事务归 scope-store.js 与 Core，
// 本文件不执行任何写入、迁移、计时器或网络。
// 精确序列化字节数：对最终页候选对象做 JSON.stringify 后按 UTF-8 计字节，
// 直接度量实际最终页（含转义 ID/record/包装/nextCursor），不做增量估算。
function jsonUtf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function createReplicaQueries(db, { deviceId, queries, scopeStore }) {
  const stmtInventory = db.prepare(
    `SELECT s.source_device_id AS source_device_id,
            s.stream_id AS stream_id,
            s.scope_id AS scope_id,
            s.revision AS revision,
            s.highest_seq AS highest_seq,
            s.contiguous_seq AS contiguous_seq
       FROM message_streams s
       JOIN message_scope_revisions r
         ON r.scope_id = s.scope_id AND r.revision = s.revision
      WHERE s.scope_id = ?
        AND (? IS NULL OR s.source_device_id > ? OR (s.source_device_id = ? AND s.stream_id > ?))
        AND EXISTS (
          SELECT 1 FROM json_each(r.members_json) AS j
           WHERE json_extract(j.value, '$.deviceId') = ?
        )
        AND EXISTS (
          SELECT 1 FROM json_each(r.members_json) AS j
           WHERE json_extract(j.value, '$.deviceId') = ?
        )
      ORDER BY s.source_device_id ASC, s.stream_id ASC
      LIMIT ?`
  );
  const stmtStreamEventCount = db.prepare(
    'SELECT COUNT(*) AS n FROM message_events WHERE source_device_id = ? AND stream_id = ?'
  );
  const stmtHistoryPage = db.prepare(
    `SELECT envelope_json, source_seq
       FROM message_events
      WHERE source_device_id = ? AND stream_id = ?
        AND source_seq > ? AND source_seq <= ?
      ORDER BY source_seq ASC
      LIMIT ?`
  );
  const stmtFirstSeqInRange = db.prepare(
    'SELECT source_seq FROM message_events WHERE source_device_id = ? AND stream_id = ? AND source_seq > ? AND source_seq <= ? ORDER BY source_seq ASC LIMIT 1'
  );
  const stmtFirstGapInRange = db.prepare(
    `SELECT cur, next FROM (
         SELECT source_seq AS cur, LEAD(source_seq) OVER (ORDER BY source_seq) AS next
           FROM message_events
          WHERE source_device_id = ? AND stream_id = ?
            AND source_seq > ? AND source_seq <= ?
       ) WHERE next IS NULL OR next - cur > 1
       ORDER BY cur ASC
       LIMIT 1`
  );
  const stmtReplicaList = db.prepare(
    `SELECT peer_device_id,
            source_device_id,
            stream_id,
            scope_id,
            revision,
            snapshot_json,
            observed_at,
            last_scanned_at,
            last_error_code
       FROM message_replica_streams
      WHERE scope_id = ?
        AND (? IS NULL OR peer_device_id > ?
             OR (peer_device_id = ? AND (source_device_id > ? OR (source_device_id = ? AND stream_id > ?))))
      ORDER BY peer_device_id ASC, source_device_id ASC, stream_id ASC
      LIMIT ?`
  );

  function ensureScopeExists(scopeId) {
    if (!queries.getScope(scopeId)) {
      throw messageError('SCOPE_NOT_FOUND', 'scope not found');
    }
  }

  function inventory(peer, query) {
    scopeStore.assertReplicaPeer(peer, query.scopeId);
    const afterSource = query.cursor ? query.cursor.afterSourceDeviceId : null;
    const afterStream = query.cursor ? query.cursor.afterStreamId : null;
    if (query.cursor) {
      if (
        query.cursor.deviceId !== deviceId ||
        query.cursor.requesterDeviceId !== peer.deviceId ||
        query.cursor.scopeId !== query.scopeId
      ) {
        throw messageError('INVALID_ARGUMENT', 'cursor does not match this inventory query');
      }
    }
    const rows = stmtInventory.all(
      query.scopeId,
      afterSource,
      afterSource,
      afterSource,
      afterStream,
      peer.deviceId,
      deviceId,
      query.limit + 1
    );
    const items = [];
    let withheld = false;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const count = stmtStreamEventCount.get(row.source_device_id, row.stream_id).n;
      const item = {
        scopeId: row.scope_id,
        revision: row.revision,
        sourceDeviceId: row.source_device_id,
        streamId: row.stream_id,
        contiguous: row.contiguous_seq,
        highest: row.highest_seq,
        count,
      };
      const hasMore = i + 1 < rows.length;
      // 直接度量“若该项为最后返回项”时的实际最终页（含 nextCursor 替换 null 的字节）。
      const candidate = {
        scopeId: query.scopeId,
        items: items.concat(item),
        nextCursor: hasMore
          ? {
              deviceId,
              requesterDeviceId: peer.deviceId,
              scopeId: query.scopeId,
              afterSourceDeviceId: item.sourceDeviceId,
              afterStreamId: item.streamId,
            }
          : null,
      };
      if (jsonUtf8Bytes(candidate) > MAX_SCOPE_SYNC_BYTES) {
        if (items.length === 0) {
          throw messageError('RESPONSE_TOO_LARGE', 'inventory item exceeds sync byte budget');
        }
        withheld = true;
        break;
      }
      items.push(item);
      if (items.length >= query.limit) {
        if (hasMore) withheld = true;
        break;
      }
    }
    const last = items[items.length - 1];
    const nextCursor =
      withheld && last
        ? {
            deviceId,
            requesterDeviceId: peer.deviceId,
            scopeId: query.scopeId,
            afterSourceDeviceId: last.sourceDeviceId,
            afterStreamId: last.streamId,
          }
        : null;
    return { scopeId: query.scopeId, items, nextCursor };
  }

  function historyPage(peer, query) {
    scopeStore.assertReplicaPeer(peer, query.scopeId);
    const record = scopeStore.getScopeRecord(query.scopeId, query.revision);
    if (!record) {
      throw messageError('SCOPE_NOT_FOUND', 'requested scope revision is not stored locally');
    }
    const memberDeviceIds = new Set(record.scope.members.map((member) => member.deviceId));
    if (!memberDeviceIds.has(peer.deviceId)) {
      throw messageError('SCOPE_FORBIDDEN', 'requester is not a member of the requested revision');
    }
    if (!memberDeviceIds.has(deviceId)) {
      throw messageError('SCOPE_FORBIDDEN', 'serving device is not a member of the requested revision');
    }
    if (!memberDeviceIds.has(query.sourceDeviceId)) {
      throw messageError('SCOPE_FORBIDDEN', 'source device is not a member of the requested revision');
    }
    const streamId = streamIdForScope(query.scopeId, query.revision);
    const items = [];
    let withheld = false;
    // iterate(limit+1)：流式逐行，配合单行前瞻区分“扣留/耗尽”，不物化整页超大 envelope。
    const iterator = stmtHistoryPage.iterate(
      query.sourceDeviceId,
      streamId,
      query.afterSequence,
      query.throughSequence,
      query.limit + 1
    );
    try {
      let pending = iterator.next();
      while (!pending.done && !withheld) {
        const envelope = JSON.parse(pending.value.envelope_json);
        const next = iterator.next();
        const hasMore = !next.done;
        // 直接度量实际最终页：扣留时 nextAfterSequence=该项 sequence，耗尽时 null。
        const candidate = {
          record,
          sourceDeviceId: query.sourceDeviceId,
          afterSequence: query.afterSequence,
          throughSequence: query.throughSequence,
          items: items.concat(envelope),
          nextAfterSequence: hasMore ? envelope.sequence : null,
        };
        if (jsonUtf8Bytes(candidate) > MAX_SCOPE_SYNC_BYTES) {
          if (items.length === 0) {
            throw messageError('RESPONSE_TOO_LARGE', 'history envelope exceeds sync byte budget');
          }
          withheld = true;
          break;
        }
        items.push(envelope);
        if (items.length >= query.limit) {
          if (hasMore) withheld = true;
          break;
        }
        pending = next;
      }
    } finally {
      // 自然耗尽、limit/预算提前退出或异常时都释放活动语句。
      iterator.return();
    }
    const last = items[items.length - 1] ?? null;
    // 仅当因 limit/预算扣留了至少一项时给出 nextAfter（最后已返回项）；
    // 实际查询耗尽（即使末项 seq < through）必须返回 null。
    const nextAfterSequence = withheld && last ? last.sequence : null;
    return {
      record,
      sourceDeviceId: query.sourceDeviceId,
      afterSequence: query.afterSequence,
      throughSequence: query.throughSequence,
      items,
      nextAfterSequence,
    };
  }

  function nextMissingRange(query) {
    ensureScopeExists(query.scopeId);
    const after = query.afterSequence;
    const through = query.throughSequence;
    if (after >= through) return null;
    const streamId = streamIdForScope(query.scopeId, query.revision);
    const first = stmtFirstSeqInRange.get(query.sourceDeviceId, streamId, after, through);
    if (!first) {
      return { from: after + 1, to: through };
    }
    if (first.source_seq > after + 1) {
      return { from: after + 1, to: first.source_seq - 1 };
    }
    const gap = stmtFirstGapInRange.get(query.sourceDeviceId, streamId, after, through);
    if (!gap) return null;
    if (gap.next === null) {
      return gap.cur < through ? { from: gap.cur + 1, to: through } : null;
    }
    return { from: gap.cur + 1, to: gap.next - 1 };
  }

  function listScopeReplicas(scopeId, options) {
    ensureScopeExists(scopeId);
    const afterPeer = options.cursor ? options.cursor.afterPeerDeviceId : null;
    const afterSource = options.cursor ? options.cursor.afterSourceDeviceId : null;
    const afterStream = options.cursor ? options.cursor.afterStreamId : null;
    if (options.cursor) {
      if (options.cursor.deviceId !== deviceId || options.cursor.scopeId !== scopeId) {
        throw messageError('INVALID_ARGUMENT', 'cursor does not match this replica list query');
      }
    }
    const rows = stmtReplicaList.all(
      scopeId,
      afterPeer,
      afterPeer,
      afterPeer,
      afterSource,
      afterSource,
      afterStream,
      options.limit + 1
    );
    const items = [];
    let withheld = false;
    let lastPushed = null;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const stream = JSON.parse(row.snapshot_json);
      const item = {
        peerDeviceId: row.peer_device_id,
        stream,
        observedAt: row.observed_at,
        lastScannedAt: row.last_scanned_at,
        lastErrorCode: row.last_error_code,
      };
      const hasMore = i + 1 < rows.length;
      // 直接度量实际最终页（含 nextCursor 替换 null 的字节）。
      const candidate = {
        deviceId,
        scopeId,
        items: items.concat(item),
        nextCursor: hasMore
          ? {
              deviceId,
              scopeId,
              afterPeerDeviceId: row.peer_device_id,
              afterSourceDeviceId: row.source_device_id,
              afterStreamId: row.stream_id,
            }
          : null,
      };
      if (jsonUtf8Bytes(candidate) > MAX_SCOPE_CONTROL_BYTES) {
        if (items.length === 0) {
          throw messageError('RESPONSE_TOO_LARGE', 'replica observation exceeds control byte budget');
        }
        withheld = true;
        break;
      }
      items.push(item);
      // 游标只取最后已 push 行，排除被预算/限额扣留的 lookahead 行。
      lastPushed = row;
      if (items.length >= options.limit) {
        if (hasMore) withheld = true;
        break;
      }
    }
    const nextCursor =
      withheld && lastPushed
        ? {
            deviceId,
            scopeId,
            afterPeerDeviceId: lastPushed.peer_device_id,
            afterSourceDeviceId: lastPushed.source_device_id,
            afterStreamId: lastPushed.stream_id,
          }
        : null;
    return { deviceId, scopeId, items, nextCursor };
  }

  return {
    inventory,
    historyPage,
    nextMissingRange,
    listScopeReplicas,
  };
}
