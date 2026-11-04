import {
  assertId,
  messageError,
  normalizePageOptions,
  normalizeScopeHistoryOptions,
  digest,
  streamIdForScope,
} from './message-protocol.js';

const MAX_GAP_INTERVALS = 100;
const INBOX_OPTION_KEYS = new Set(['scopeId', 'limit', 'cursor']);
const OUTBOX_OPTION_KEYS = new Set(['scopeId', 'targetDeviceId', 'limit', 'cursor']);

export function inboxQueryKey(botId, scopeId) {
  return scopeId === undefined ? botId : 'scope:' + digest([botId, scopeId]);
}

// 只读查询层：仅 prepared SELECT，事务/写入/连接生命周期归 message-store.js。
export function createMessageQueries(db, { deviceId }) {
  const stmtGetScopeLatest = db.prepare(
    `SELECT s.kind AS kind, r.revision AS revision, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at
       FROM message_scopes s
       JOIN message_scope_revisions r ON r.scope_id = s.scope_id
       WHERE s.scope_id = ?
       ORDER BY r.revision DESC
       LIMIT 1`
  );
  const stmtGetScopeRevision = db.prepare(
    `SELECT s.kind AS kind, r.revision AS revision, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at
       FROM message_scopes s
       JOIN message_scope_revisions r ON r.scope_id = s.scope_id
       WHERE s.scope_id = ? AND r.revision = ?`
  );
  // 活跃列表只含未删除 scope：墓碑 revision 仍可读历史/状态，但不列活跃群。
  const stmtListScopes = db.prepare(
    `SELECT s.scope_id AS scope_id, s.kind AS kind, r.revision AS revision, r.members_json AS members_json, r.title AS title, r.deleted_at AS deleted_at
       FROM message_scopes s
       JOIN message_scope_revisions r ON r.scope_id = s.scope_id
       WHERE r.revision = (SELECT MAX(revision) FROM message_scope_revisions WHERE scope_id = s.scope_id)
         AND r.deleted_at IS NULL
       ORDER BY s.scope_id ASC`
  );
  const stmtGetEventByMessageId = db.prepare('SELECT * FROM message_events WHERE message_id = ?');
  const stmtScopeExists = db.prepare('SELECT 1 AS x FROM message_scopes WHERE scope_id = ?');
  // missingRefs 现场算：仅同一 scope 内已存判定，不递归 getMessage。
  const stmtGetMissingRefs = db.prepare(
    'SELECT message_id FROM message_events WHERE scope_id = ? AND message_id IN (?, ?)'
  );
  const stmtGetStream = db.prepare(
    'SELECT source_device_id, stream_id, scope_id, revision, highest_seq, contiguous_seq FROM message_streams WHERE source_device_id = ? AND stream_id = ?'
  );
  const stmtGetStreamFirstSeq = db.prepare(
    'SELECT source_seq FROM message_events WHERE source_device_id = ? AND stream_id = ? ORDER BY source_seq ASC LIMIT 1'
  );
  // SQL LAG 相邻已存在 seq 产出缺口，不遍历 1..highest、不取全部行到 JS。
  const stmtGetStreamGaps = db.prepare(
    `SELECT prev, cur FROM (
         SELECT source_seq AS cur, LAG(source_seq) OVER (ORDER BY source_seq) AS prev
         FROM message_events WHERE source_device_id = ? AND stream_id = ?
       ) WHERE prev IS NOT NULL AND cur - prev > 1
       ORDER BY cur ASC
       LIMIT ?`
  );
  const stmtHistory = db.prepare(
    'SELECT * FROM message_events WHERE scope_id = ? ORDER BY local_id ASC LIMIT ?'
  );
  const stmtHistoryAfter = db.prepare(
    'SELECT * FROM message_events WHERE scope_id = ? AND local_id > ? ORDER BY local_id ASC LIMIT ?'
  );
  const stmtHistoryDesc = db.prepare(
    'SELECT * FROM message_events WHERE scope_id = ? ORDER BY local_id DESC LIMIT ?'
  );
  const stmtHistoryBefore = db.prepare(
    'SELECT * FROM message_events WHERE scope_id = ? AND local_id < ? ORDER BY local_id DESC LIMIT ?'
  );
  const stmtInbox = db.prepare(
    `SELECT e.* FROM message_events e
       JOIN message_local_targets t ON t.message_id = e.message_id
       WHERE t.bot_id = ?
       ORDER BY e.local_id ASC
       LIMIT ?`
  );
  const stmtInboxAfter = db.prepare(
    `SELECT e.* FROM message_events e
       JOIN message_local_targets t ON t.message_id = e.message_id
       WHERE t.bot_id = ? AND e.local_id > ?
       ORDER BY e.local_id ASC
       LIMIT ?`
  );
  const stmtInboxScoped = db.prepare(
    `SELECT e.* FROM message_events e
       WHERE e.scope_id = ? AND e.local_id > ?
         AND EXISTS (
           SELECT 1 FROM message_local_targets t
           WHERE t.message_id = e.message_id AND t.bot_id = ?
         )
       ORDER BY e.local_id ASC
       LIMIT ?`
  );
  const stmtReplies = db.prepare(
    `SELECT e.* FROM message_events e
       WHERE e.scope_id = ? AND e.local_id > ?
         AND EXISTS (
           SELECT 1 FROM message_local_targets t
           WHERE t.message_id = e.message_id AND t.bot_id = ?
         )
         AND json_extract(e.envelope_json, '$.category') = 'reply'
         AND json_extract(e.envelope_json, '$.replyTo') = ?
         AND json_extract(e.envelope_json, '$.author.kind') = 'bot'
         AND json_extract(e.envelope_json, '$.author.botId') <> ?
       ORDER BY e.local_id ASC
       LIMIT ?`
  );
  const stmtOutbox = db.prepare(
    `SELECT e.*, o.target_device_id AS outbox_target_device_id
       FROM message_outbox o
       JOIN message_events e ON e.message_id = o.message_id
       WHERE o.state = 'pending'
         AND (? IS NULL OR e.scope_id = ?)
         AND (? IS NULL OR o.target_device_id = ?)
       ORDER BY e.local_id ASC, o.target_device_id ASC
       LIMIT ?`
  );
  const stmtOutboxAfter = db.prepare(
    `SELECT e.*, o.target_device_id AS outbox_target_device_id
       FROM message_outbox o
       JOIN message_events e ON e.message_id = o.message_id
       WHERE o.state = 'pending'
         AND (? IS NULL OR e.scope_id = ?)
         AND (? IS NULL OR o.target_device_id = ?)
         AND (e.local_id > ? OR (e.local_id = ? AND o.target_device_id > ?))
       ORDER BY e.local_id ASC, o.target_device_id ASC
       LIMIT ?`
  );
  const stmtDeliveryTargets = db.prepare(
    'SELECT target_device_id, state, acked_at FROM message_outbox WHERE message_id = ? ORDER BY target_device_id ASC'
  );

  function bindCursor(cursor, kind, key, requireTarget) {
    if (!cursor) return;
    if (
      cursor.deviceId !== deviceId ||
      cursor.kind !== kind ||
      cursor.key !== key ||
      (kind === 'history-before'
        ? typeof cursor.beforeLocalId !== 'number'
        : typeof cursor.afterLocalId !== 'number')
    ) {
      throw messageError('INVALID_ARGUMENT', 'cursor does not match this query');
    }
    if (requireTarget) {
      if (typeof cursor.afterTargetDeviceId !== 'string') {
        throw messageError('INVALID_ARGUMENT', 'cursor missing afterTargetDeviceId');
      }
    } else if (cursor.afterTargetDeviceId !== undefined) {
      throw messageError('INVALID_ARGUMENT', 'cursor must not include afterTargetDeviceId');
    }
  }

  function toStoredMessage(row) {
    const message = JSON.parse(row.envelope_json);
    const candidates = [];
    if (message.rootId && message.rootId !== message.messageId) candidates.push(message.rootId);
    if (
      message.replyTo &&
      message.replyTo !== message.messageId &&
      message.replyTo !== message.rootId
    ) {
      candidates.push(message.replyTo);
    }
    let missingRefs = [];
    if (candidates.length > 0) {
      const found = new Set();
      const rows = stmtGetMissingRefs.all(row.scope_id, candidates[0], candidates[1] ?? null);
      for (const hit of rows) found.add(hit.message_id);
      missingRefs = candidates.filter((id) => !found.has(id));
    }
    return {
      localId: row.local_id,
      message,
      digest: row.digest,
      storedAt: row.stored_at,
      missingRefs,
    };
  }

  function buildStreamStatus(row, scopeId, revision, sourceDeviceId, streamId) {
    const highest = row.highest_seq;
    const contiguous = row.contiguous_seq;
    const first = stmtGetStreamFirstSeq.get(sourceDeviceId, streamId);
    const gaps = [];
    let gapsTruncated = false;
    // 首段缺口位于 contiguous+1 与首个已存在 seq 之间；LAG 只覆盖相邻已存在对。
    if (first && first.source_seq > contiguous + 1) {
      gaps.push({ from: contiguous + 1, to: first.source_seq - 1 });
    }
    const sqlGaps = stmtGetStreamGaps.all(sourceDeviceId, streamId, MAX_GAP_INTERVALS + 1);
    if (sqlGaps.length > MAX_GAP_INTERVALS) gapsTruncated = true;
    for (const gap of sqlGaps) {
      if (gaps.length >= MAX_GAP_INTERVALS) {
        gapsTruncated = true;
        break;
      }
      gaps.push({ from: gap.prev + 1, to: gap.cur - 1 });
    }
    return { scopeId, revision, sourceDeviceId, streamId, contiguous, highest, gaps, gapsTruncated };
  }

  function streamStatusFor(scopeId, revision, sourceDeviceId) {
    const streamId = streamIdForScope(scopeId, revision);
    const row = stmtGetStream.get(sourceDeviceId, streamId);
    if (!row) return null;
    return buildStreamStatus(row, scopeId, revision, sourceDeviceId, streamId);
  }

  function collectPageStreams(rows) {
    const byStream = new Map();
    for (const row of rows) {
      const sourceDeviceId = row.source_device_id;
      const streamId = row.stream_id;
      // 同一 streamId 可对应多个 source 设备，按 (source, stream) 去重。
      const key = sourceDeviceId + '\u0000' + streamId;
      if (byStream.has(key)) continue;
      const stream = stmtGetStream.get(sourceDeviceId, streamId);
      if (stream) byStream.set(key, { stream, sourceDeviceId, streamId });
    }
    return [...byStream.values()]
      .sort((a, b) =>
        a.sourceDeviceId < b.sourceDeviceId
          ? -1
          : a.sourceDeviceId > b.sourceDeviceId
            ? 1
            : a.streamId < b.streamId
              ? -1
              : a.streamId > b.streamId
                ? 1
                : 0
      )
      .map(({ stream, sourceDeviceId, streamId }) =>
        buildStreamStatus(stream, stream.scope_id, stream.revision, sourceDeviceId, streamId)
      );
  }

  function rowToScope(row, scopeId) {
    const scope = { scopeId, kind: row.kind, revision: row.revision, members: JSON.parse(row.members_json) };
    if (row.title !== null && row.title !== undefined) scope.title = row.title;
    if (row.deleted_at !== null && row.deleted_at !== undefined) scope.deletedAt = row.deleted_at;
    return scope;
  }

  function getScope(scopeId, revision) {
    const row = revision == null ? stmtGetScopeLatest.get(scopeId) : stmtGetScopeRevision.get(scopeId, revision);
    if (!row) return null;
    return rowToScope(row, scopeId);
  }

  function listScopes() {
    return stmtListScopes.all().map((row) => rowToScope(row, row.scope_id));
  }

  function getMessage(messageId) {
    const row = stmtGetEventByMessageId.get(messageId);
    return row ? toStoredMessage(row) : null;
  }

  function history(scopeId, options) {
    if (!stmtScopeExists.get(scopeId)) {
      throw messageError('SCOPE_NOT_FOUND', 'scope not found');
    }
    const { limit, cursor, order } = normalizeScopeHistoryOptions(options ?? {});
    let rows;
    if (order === 'descending') {
      bindCursor(cursor, 'history-before', scopeId, false);
      rows = cursor
        ? stmtHistoryBefore.all(scopeId, cursor.beforeLocalId, limit + 1)
        : stmtHistoryDesc.all(scopeId, limit + 1);
    } else {
      bindCursor(cursor, 'history', scopeId, false);
      rows = cursor
        ? stmtHistoryAfter.all(scopeId, cursor.afterLocalId, limit + 1)
        : stmtHistory.all(scopeId, limit + 1);
    }
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toStoredMessage);
    const streams = collectPageStreams(pageRows);
    // nextCursor 延续请求方向：升序翻更新、history-before 翻更旧；tailCursor 总是
    // 本页最高 localId 的升序游标，增量轮询从最新页锚点续读而不回卷起点。
    const nextCursor =
      rows.length > limit
        ? order === 'descending'
          ? {
              deviceId,
              kind: 'history-before',
              key: scopeId,
              beforeLocalId: pageRows[pageRows.length - 1].local_id,
            }
          : {
              deviceId,
              kind: 'history',
              key: scopeId,
              afterLocalId: pageRows[pageRows.length - 1].local_id,
            }
        : null;
    const tailCursor =
      pageRows.length > 0
        ? {
            deviceId,
            kind: 'history',
            key: scopeId,
            afterLocalId: pageRows[order === 'descending' ? 0 : pageRows.length - 1].local_id,
          }
        : null;
    return { deviceId, scopeId, items, nextCursor, tailCursor, streams };
  }

  function inbox(botId, options) {
    const opts = options ?? {};
    if (typeof opts !== 'object' || Array.isArray(opts)) {
      throw messageError('INVALID_ARGUMENT', 'page options must be an object');
    }
    for (const optionKey of Object.keys(opts)) {
      if (!INBOX_OPTION_KEYS.has(optionKey)) {
        throw messageError('INVALID_ARGUMENT', 'page options has unknown field: ' + optionKey);
      }
    }
    const scopeId = opts.scopeId;
    if (scopeId !== undefined) {
      assertId(scopeId, 'scopeId');
      if (!stmtScopeExists.get(scopeId)) {
        throw messageError('SCOPE_NOT_FOUND', 'scope not found');
      }
    }
    const { limit, cursor } = normalizePageOptions({ limit: opts.limit, cursor: opts.cursor });
    const key = inboxQueryKey(botId, scopeId);
    bindCursor(cursor, 'inbox', key, false);
    const rows =
      scopeId !== undefined
        ? stmtInboxScoped.all(scopeId, cursor?.afterLocalId ?? 0, botId, limit + 1)
        : cursor
          ? stmtInboxAfter.all(botId, cursor.afterLocalId, limit + 1)
          : stmtInbox.all(botId, limit + 1);
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => {
      const stored = toStoredMessage(row);
      const author = stored.message.author;
      stored.selfEcho =
        row.source_device_id === deviceId && author.kind === 'bot' && author.botId === botId;
      return stored;
    });
    const nextCursor =
      rows.length > limit
        ? {
            deviceId,
            kind: 'inbox',
            key,
            afterLocalId: pageRows[pageRows.length - 1].local_id,
          }
        : null;
    return { deviceId, botId, items, nextCursor };
  }

  function replies(botId, requestMessageId, options) {
    const event = stmtGetEventByMessageId.get(requestMessageId);
    if (!event) throw messageError('MESSAGE_NOT_FOUND', 'message not found');
    const request = JSON.parse(event.envelope_json);
    if (
      request.sourceDeviceId !== deviceId ||
      request.author.kind !== 'bot' ||
      request.author.botId !== botId ||
      request.category !== 'request' ||
      getScope(event.scope_id, event.revision)?.kind !== 'dm'
    ) {
      throw messageError('SCOPE_FORBIDDEN', 'replies only available for the calling local bot\'s DM request');
    }
    const scopeId = event.scope_id;
    const { limit, cursor } = normalizePageOptions(options);
    const key = 'reply:' + digest([botId, requestMessageId]);
    bindCursor(cursor, 'inbox', key, false);
    // 恢复时 reply 可能先于 request 入库，初始游标不能用请求的 localId。
    const rows = stmtReplies.all(scopeId, cursor?.afterLocalId ?? 0, botId, requestMessageId, botId, limit + 1);
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => ({ ...toStoredMessage(row), selfEcho: false }));
    const nextCursor =
      rows.length > limit
        ? {
            deviceId,
            kind: 'inbox',
            key,
            afterLocalId: pageRows[pageRows.length - 1].local_id,
          }
        : null;
    return { botId, requestMessageId, scopeId, items, nextCursor };
  }

  function outbox(options) {
    const opts = options ?? {};
    if (typeof opts !== 'object' || Array.isArray(opts)) {
      throw messageError('INVALID_ARGUMENT', 'outbox options must be a plain object');
    }
    for (const optionKey of Object.keys(opts)) {
      if (!OUTBOX_OPTION_KEYS.has(optionKey)) {
        throw messageError('INVALID_ARGUMENT', 'unknown outbox option: ' + optionKey);
      }
    }
    const scopeId =
      opts.scopeId === undefined ? null : (assertId(opts.scopeId, 'scopeId'), opts.scopeId);
    const targetDeviceId =
      opts.targetDeviceId === undefined
        ? null
        : (assertId(opts.targetDeviceId, 'targetDeviceId'), opts.targetDeviceId);
    const key = digest([scopeId, targetDeviceId]);
    const { limit, cursor } = normalizePageOptions({ limit: opts.limit, cursor: opts.cursor });
    bindCursor(cursor, 'outbox', key, true);
    const rows = cursor
      ? stmtOutboxAfter.all(
          scopeId,
          scopeId,
          targetDeviceId,
          targetDeviceId,
          cursor.afterLocalId,
          cursor.afterLocalId,
          cursor.afterTargetDeviceId,
          limit + 1
        )
      : stmtOutbox.all(scopeId, scopeId, targetDeviceId, targetDeviceId, limit + 1);
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => ({
      targetDeviceId: row.outbox_target_device_id,
      message: JSON.parse(row.envelope_json),
    }));
    const nextCursor =
      rows.length > limit
        ? {
            deviceId,
            kind: 'outbox',
            key,
            afterLocalId: pageRows[pageRows.length - 1].local_id,
            afterTargetDeviceId: pageRows[pageRows.length - 1].outbox_target_device_id,
          }
        : null;
    return { deviceId, items, nextCursor };
  }

  function deliveryStatus(messageId) {
    const event = stmtGetEventByMessageId.get(messageId);
    if (!event) throw messageError('MESSAGE_NOT_FOUND', 'message not found');
    if (event.source_device_id !== deviceId) {
      throw messageError('SCOPE_FORBIDDEN', 'delivery status only available for local-source messages');
    }
    const targets = [{ deviceId, state: 'stored', acknowledgedAt: null }];
    for (const row of stmtDeliveryTargets.all(messageId)) {
      if (row.target_device_id === deviceId) continue;
      targets.push({ deviceId: row.target_device_id, state: row.state, acknowledgedAt: row.acked_at });
    }
    return { messageId, targets };
  }

  return {
    getScope,
    listScopes,
    getMessage,
    history,
    inbox,
    replies,
    outbox,
    deliveryStatus,
    streamStatus: streamStatusFor,
  };
}
