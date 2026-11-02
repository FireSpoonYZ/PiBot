// Module 12 scope protocol boundary helpers. Canonical normalization and page
// validation for managed scope create/update/list, offers, replica inventory,
// history and missing-range queries. No database, transport or runtime code.
// Reuses existing message-protocol.js; this file owns only the M12 shapes.
import {
  messageError,
  assertId,
  assertRevision,
  normalizeScope,
  normalizeScopeTitle,
  normalizePublish,
  normalizeEnvelope,
  streamIdForScope,
} from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const RESPONSE_TOO_LARGE = 'RESPONSE_TOO_LARGE';

export const MAX_SCOPE_SYNC_BYTES = 2088960;
export const MAX_SCOPE_CONTROL_BYTES = 1040384;
const DEFAULT_SCOPE_LIMIT = 50;
const MAX_SCOPE_LIMIT = 200;
const PLACEHOLDER_SCOPE_ID = 'placeholder';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw invalid('digest must be a lowercase 64-character hex SHA-256');
  }
}

function assertNonnegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a non-negative safe integer`);
  }
}

function normalizeLimit(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SCOPE_LIMIT
  ) {
    throw invalid('limit must be a positive integer between 1 and 200');
  }
  return value;
}

function chooseLimit(options) {
  return options.limit === undefined ? DEFAULT_SCOPE_LIMIT : normalizeLimit(options.limit);
}

/**
 * Final serialized page payload budget. Pages are checked on the full canonical
 * JSON; oversize surfaces as RESPONSE_TOO_LARGE rather than dropping items.
 */
function assertSyncBudget(serialized, label) {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCOPE_SYNC_BYTES) {
    throw messageError(
      RESPONSE_TOO_LARGE,
      `${label} exceeds ${MAX_SCOPE_SYNC_BYTES} UTF-8 bytes`
    );
  }
}

function normalizeScopeListCursor(cursor, label) {
  if (!isPlainObject(cursor)) throw invalid(`${label} must be an object`);
  rejectUnknownFields(cursor, new Set(['deviceId', 'afterScopeId']), label);
  assertId(cursor.deviceId, `${label}.deviceId`);
  assertId(cursor.afterScopeId, `${label}.afterScopeId`);
  return { deviceId: cursor.deviceId, afterScopeId: cursor.afterScopeId };
}

function normalizeOfferCursor(cursor, label) {
  if (!isPlainObject(cursor)) throw invalid(`${label} must be an object`);
  rejectUnknownFields(cursor, new Set(['scopeId', 'revision', 'targetDeviceId']), label);
  assertId(cursor.scopeId, `${label}.scopeId`);
  assertRevision(cursor.revision, `${label}.revision`);
  assertId(cursor.targetDeviceId, `${label}.targetDeviceId`);
  return { scopeId: cursor.scopeId, revision: cursor.revision, targetDeviceId: cursor.targetDeviceId };
}

function normalizeInventoryCursor(cursor, label, scopeId) {
  if (!isPlainObject(cursor)) throw invalid(`${label} must be an object`);
  rejectUnknownFields(
    cursor,
    new Set([
      'deviceId',
      'requesterDeviceId',
      'scopeId',
      'afterSourceDeviceId',
      'afterStreamId',
    ]),
    label
  );
  assertId(cursor.deviceId, `${label}.deviceId`);
  assertId(cursor.requesterDeviceId, `${label}.requesterDeviceId`);
  assertId(cursor.scopeId, `${label}.scopeId`);
  assertId(cursor.afterSourceDeviceId, `${label}.afterSourceDeviceId`);
  assertId(cursor.afterStreamId, `${label}.afterStreamId`);
  if (cursor.scopeId !== scopeId) {
    throw invalid(`${label}.scopeId must match page scopeId`);
  }
  return {
    deviceId: cursor.deviceId,
    requesterDeviceId: cursor.requesterDeviceId,
    scopeId: cursor.scopeId,
    afterSourceDeviceId: cursor.afterSourceDeviceId,
    afterStreamId: cursor.afterStreamId,
  };
}

function normalizeReplicaListCursor(cursor, label) {
  if (!isPlainObject(cursor)) throw invalid(`${label} must be an object`);
  rejectUnknownFields(
    cursor,
    new Set([
      'deviceId',
      'scopeId',
      'afterPeerDeviceId',
      'afterSourceDeviceId',
      'afterStreamId',
    ]),
    label
  );
  assertId(cursor.deviceId, `${label}.deviceId`);
  assertId(cursor.scopeId, `${label}.scopeId`);
  assertId(cursor.afterPeerDeviceId, `${label}.afterPeerDeviceId`);
  assertId(cursor.afterSourceDeviceId, `${label}.afterSourceDeviceId`);
  assertId(cursor.afterStreamId, `${label}.afterStreamId`);
  return {
    deviceId: cursor.deviceId,
    scopeId: cursor.scopeId,
    afterPeerDeviceId: cursor.afterPeerDeviceId,
    afterSourceDeviceId: cursor.afterSourceDeviceId,
    afterStreamId: cursor.afterStreamId,
  };
}

/**
 * Managed scope create input. Members are validated through the existing scope
 * normalizer (placeholder scopeId, revision 1); the store generates the UUID
 * scopeId inside its transaction.
 */
export function normalizeScopeCreate(input) {
  if (!isPlainObject(input)) throw invalid('scope create input must be an object');
  rejectUnknownFields(input, new Set(['requestId', 'kind', 'members', 'title']), 'scope create input');
  assertId(input.requestId, 'requestId');
  const scope = normalizeScope({
    scopeId: PLACEHOLDER_SCOPE_ID,
    kind: input.kind,
    revision: 1,
    members: input.members,
    ...(input.title !== undefined ? { title: input.title } : {}),
  });
  const normalized = { requestId: input.requestId, kind: scope.kind, members: scope.members };
  if (scope.title !== undefined) normalized.title = scope.title;
  return normalized;
}

/**
 * Managed scope update input; scopeId is a separate path/argument. Member shape
 * uses room bounds here; the immutable DM rule is enforced against the stored
 * kind by the store.
 */
export function normalizeScopeUpdate(input) {
  if (!isPlainObject(input)) throw invalid('scope update input must be an object');
  rejectUnknownFields(
    input,
    new Set(['requestId', 'expectedRevision', 'members', 'title']),
    'scope update input'
  );
  assertId(input.requestId, 'requestId');
  assertRevision(input.expectedRevision, 'expectedRevision');
  // members/title 各自可选，省略字段由 store 保留旧值；至少提供一项才构成更新。
  const normalized = {
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
  };
  if (input.members !== undefined) {
    normalized.members = normalizeScope({
      scopeId: PLACEHOLDER_SCOPE_ID,
      kind: 'room',
      revision: 1,
      members: input.members,
    }).members;
  }
  const title = normalizeScopeTitle(input.title);
  if (title !== undefined) normalized.title = title;
  return normalized;
}

/**
 * Managed scope delete input（权威墓碑）：仅 requestId + expectedRevision；
 * CAS/幂等与 update 同口径，成员表由 store 沿最新 revision 保留。
 */
export function normalizeScopeDelete(input) {
  if (!isPlainObject(input)) throw invalid('scope delete input must be an object');
  rejectUnknownFields(input, new Set(['requestId', 'expectedRevision']), 'scope delete input');
  assertId(input.requestId, 'requestId');
  assertRevision(input.expectedRevision, 'expectedRevision');
  return { requestId: input.requestId, expectedRevision: input.expectedRevision };
}

/**
 * Canonical (scope, authorityDeviceId) record. authorityDeviceId may be null
 * only for legacy records; live offers reject null at the store/service layer.
 */
export function normalizeScopeRecord(record) {
  if (!isPlainObject(record)) throw invalid('scope record must be an object');
  rejectUnknownFields(record, new Set(['scope', 'authorityDeviceId']), 'scope record');
  const scope = normalizeScope(record.scope);
  const authorityDeviceId = record.authorityDeviceId === null ? null : record.authorityDeviceId;
  if (authorityDeviceId !== null) {
    assertId(authorityDeviceId, 'authorityDeviceId');
  }
  return { scope, authorityDeviceId };
}

/**
 * Stable scope list options. cursor is {deviceId,afterScopeId}; pages ascend by
 * scope_id, so the cursor reflects the last returned scopeId.
 */
export function normalizeScopeListOptions(options) {
  if (options === undefined) options = {};
  if (!isPlainObject(options)) throw invalid('scope list options must be an object');
  rejectUnknownFields(options, new Set(['limit', 'cursor']), 'scope list options');
  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = normalizeScopeListCursor(options.cursor, 'cursor');
  }
  return { limit: chooseLimit(options), cursor };
}

/**
 * Offer scan options. cursor is {scopeId,revision,targetDeviceId}; all three
 * fields are required together and sort by scope_id/revision/target_device_id.
 */
export function normalizeScopeOfferOptions(options) {
  if (options === undefined) options = {};
  if (!isPlainObject(options)) throw invalid('scope offer options must be an object');
  rejectUnknownFields(options, new Set(['limit', 'cursor']), 'scope offer options');
  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = normalizeOfferCursor(options.cursor, 'cursor');
  }
  return { limit: chooseLimit(options), cursor };
}

/**
 * Scope revision acknowledgement. Peer identity is supplied separately by the
 * authenticated transport, so it never appears in the ack payload.
 */
export function normalizeScopeAck(ack) {
  if (!isPlainObject(ack)) throw invalid('scope ack must be an object');
  rejectUnknownFields(ack, new Set(['scopeId', 'revision', 'digest']), 'scope ack');
  assertId(ack.scopeId, 'scopeId');
  assertRevision(ack.revision, 'revision');
  assertSha256Hex(ack.digest);
  return { scopeId: ack.scopeId, revision: ack.revision, digest: ack.digest };
}

/**
 * Replica inventory query. The cursor is bound to the serving device, the
 * authenticated requester and the scope; afterSourceDeviceId/afterStreamId
 * follow the source/stream SQL ordering.
 */
export function normalizeInventoryQuery(query) {
  if (!isPlainObject(query)) throw invalid('inventory query must be an object');
  rejectUnknownFields(query, new Set(['scopeId', 'limit', 'cursor']), 'inventory query');
  assertId(query.scopeId, 'scopeId');
  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== null) {
    cursor = normalizeInventoryCursor(query.cursor, 'cursor', query.scopeId);
  }
  return { scopeId: query.scopeId, limit: chooseLimit(query), cursor };
}

/**
 * Peer-observed replica stream holdings. Stream identity must derive from
 * scopeId/revision; contiguous <= count <= highest.
 */
export function normalizeReplicaStream(stream) {
  if (!isPlainObject(stream)) throw invalid('replica stream must be an object');
  rejectUnknownFields(
    stream,
    new Set([
      'scopeId',
      'revision',
      'sourceDeviceId',
      'streamId',
      'contiguous',
      'highest',
      'count',
    ]),
    'replica stream'
  );
  assertId(stream.scopeId, 'scopeId');
  assertRevision(stream.revision, 'revision');
  assertId(stream.sourceDeviceId, 'sourceDeviceId');
  assertId(stream.streamId, 'streamId');
  if (stream.streamId !== streamIdForScope(stream.scopeId, stream.revision)) {
    throw invalid('streamId does not match scopeId/revision');
  }
  assertNonnegativeSafeInteger(stream.contiguous, 'contiguous');
  if (!Number.isSafeInteger(stream.highest) || stream.highest < 1) {
    throw invalid('highest must be a positive safe integer');
  }
  if (!Number.isSafeInteger(stream.count) || stream.count < 1) {
    throw invalid('count must be a positive safe integer');
  }
  if (stream.contiguous > stream.count || stream.count > stream.highest) {
    throw invalid('replica stream requires contiguous <= count <= highest');
  }
  return {
    scopeId: stream.scopeId,
    revision: stream.revision,
    sourceDeviceId: stream.sourceDeviceId,
    streamId: stream.streamId,
    contiguous: stream.contiguous,
    highest: stream.highest,
    count: stream.count,
  };
}

/**
 * Replica inventory page (output). At most 200 streams; nextCursor, when
 * present, must match the page scope and the last returned item.
 */
export function normalizeInventoryPage(page) {
  if (!isPlainObject(page)) throw invalid('inventory page must be an object');
  rejectUnknownFields(page, new Set(['scopeId', 'items', 'nextCursor']), 'inventory page');
  assertId(page.scopeId, 'scopeId');
  if (!Array.isArray(page.items)) throw invalid('items must be an array');
  if (page.items.length > MAX_SCOPE_LIMIT) {
    throw invalid('items must have at most 200 entries');
  }
  const items = page.items.map((item) => {
    const stream = normalizeReplicaStream(item);
    if (stream.scopeId !== page.scopeId) {
      throw invalid('item scopeId must match page scopeId');
    }
    return stream;
  });
  let nextCursor = null;
  if (page.nextCursor !== undefined && page.nextCursor !== null) {
    if (items.length === 0) {
      throw invalid('nextCursor must be null on an empty page');
    }
    const last = items[items.length - 1];
    nextCursor = normalizeInventoryCursor(page.nextCursor, 'nextCursor', page.scopeId);
    if (nextCursor.afterSourceDeviceId !== last.sourceDeviceId) {
      throw invalid('nextCursor.afterSourceDeviceId must match the last returned item');
    }
    if (nextCursor.afterStreamId !== last.streamId) {
      throw invalid('nextCursor.afterStreamId must match the last returned item');
    }
  } else if (page.nextCursor === undefined) {
    throw invalid('nextCursor is required');
  }
  const normalized = { scopeId: page.scopeId, items, nextCursor };
  assertSyncBudget(JSON.stringify(normalized), 'inventory page');
  return normalized;
}

/**
 * History (sequence) query. afterSequence defaults to 0; throughSequence must be
 * positive and at least afterSequence. Stream identity derives from
 * scope/revision; pagination is by source sequence, not localId.
 */
export function normalizeHistoryQuery(query) {
  if (!isPlainObject(query)) throw invalid('history query must be an object');
  rejectUnknownFields(
    query,
    new Set(['scopeId', 'revision', 'sourceDeviceId', 'afterSequence', 'throughSequence', 'limit']),
    'history query'
  );
  assertId(query.scopeId, 'scopeId');
  assertRevision(query.revision, 'revision');
  assertId(query.sourceDeviceId, 'sourceDeviceId');
  let afterSequence = 0;
  if (query.afterSequence !== undefined) {
    assertNonnegativeSafeInteger(query.afterSequence, 'afterSequence');
    afterSequence = query.afterSequence;
  }
  if (!Number.isSafeInteger(query.throughSequence) || query.throughSequence < 1) {
    throw invalid('throughSequence must be a positive safe integer');
  }
  if (afterSequence > query.throughSequence) {
    throw invalid('afterSequence must not exceed throughSequence');
  }
  return {
    scopeId: query.scopeId,
    revision: query.revision,
    sourceDeviceId: query.sourceDeviceId,
    afterSequence,
    throughSequence: query.throughSequence,
    limit: chooseLimit(query),
  };
}

/**
 * History page (output). Envelopes are canonical, strict-ascending source
 * sequence, bounded by afterSequence < sequence <= throughSequence and matched
 * to the record scope/revision and source device. nextAfterSequence is null
 * on an empty page or on a nonempty exhausted page (e.g. the last envelope
 * ends exactly at throughSequence); when non-null it must equal the last
 * returned envelope sequence and stay strictly between after/through.
 */
export function normalizeHistoryPage(page) {
  if (!isPlainObject(page)) throw invalid('history page must be an object');
  rejectUnknownFields(
    page,
    new Set([
      'record',
      'sourceDeviceId',
      'afterSequence',
      'throughSequence',
      'items',
      'nextAfterSequence',
    ]),
    'history page'
  );
  const record = normalizeScopeRecord(page.record);
  assertId(page.sourceDeviceId, 'sourceDeviceId');
  assertNonnegativeSafeInteger(page.afterSequence, 'afterSequence');
  if (!Number.isSafeInteger(page.throughSequence) || page.throughSequence < 1) {
    throw invalid('throughSequence must be a positive safe integer');
  }
  if (page.afterSequence > page.throughSequence) {
    throw invalid('afterSequence must not exceed throughSequence');
  }
  if (!Array.isArray(page.items)) throw invalid('items must be an array');
  if (page.items.length > MAX_SCOPE_LIMIT) {
    throw invalid('items must have at most 200 envelopes');
  }
  const items = [];
  let previousSequence = -1;
  for (const raw of page.items) {
    const envelope = normalizeEnvelope(raw);
    if (
      envelope.scopeId !== record.scope.scopeId ||
      envelope.revision !== record.scope.revision
    ) {
      throw invalid('envelope scopeId/revision must match the record scope');
    }
    if (envelope.sourceDeviceId !== page.sourceDeviceId) {
      throw invalid('envelope sourceDeviceId must match the page source device');
    }
    if (envelope.sequence <= page.afterSequence || envelope.sequence > page.throughSequence) {
      throw invalid('envelope sequence must satisfy afterSequence < sequence <= throughSequence');
    }
    if (envelope.sequence <= previousSequence) {
      throw invalid('envelopes must be strictly ascending by source sequence');
    }
    previousSequence = envelope.sequence;
    items.push(envelope);
  }
  let nextAfterSequence = null;
  if (page.nextAfterSequence !== undefined && page.nextAfterSequence !== null) {
    assertNonnegativeSafeInteger(page.nextAfterSequence, 'nextAfterSequence');
    if (items.length === 0) {
      throw invalid('nextAfterSequence must be null on an empty page');
    }
    if (page.nextAfterSequence !== items[items.length - 1].sequence) {
      throw invalid('nextAfterSequence must equal the last returned envelope sequence');
    }
    if (
      page.nextAfterSequence <= page.afterSequence ||
      page.nextAfterSequence >= page.throughSequence
    ) {
      throw invalid('nextAfterSequence must be strictly between afterSequence and throughSequence');
    }
    nextAfterSequence = page.nextAfterSequence;
  } else if (page.nextAfterSequence === undefined) {
    throw invalid('nextAfterSequence is required');
  }

  const normalized = {
    record,
    sourceDeviceId: page.sourceDeviceId,
    afterSequence: page.afterSequence,
    throughSequence: page.throughSequence,
    items,
    nextAfterSequence,
  };
  assertSyncBudget(JSON.stringify(normalized), 'history page');
  return normalized;
}

/**
 * Missing-range query (no limit). All five fields are required; the store
 * resolves the first missing interval without enumerating integer ranges.
 */
export function normalizeMissingRangeQuery(query) {
  if (!isPlainObject(query)) throw invalid('missing range query must be an object');
  rejectUnknownFields(
    query,
    new Set(['scopeId', 'revision', 'sourceDeviceId', 'afterSequence', 'throughSequence']),
    'missing range query'
  );
  assertId(query.scopeId, 'scopeId');
  assertRevision(query.revision, 'revision');
  assertId(query.sourceDeviceId, 'sourceDeviceId');
  assertNonnegativeSafeInteger(query.afterSequence, 'afterSequence');
  if (!Number.isSafeInteger(query.throughSequence) || query.throughSequence < 1) {
    throw invalid('throughSequence must be a positive safe integer');
  }
  if (query.afterSequence > query.throughSequence) {
    throw invalid('afterSequence must not exceed throughSequence');
  }
  return {
    scopeId: query.scopeId,
    revision: query.revision,
    sourceDeviceId: query.sourceDeviceId,
    afterSequence: query.afterSequence,
    throughSequence: query.throughSequence,
  };
}

/**
 * Replica list options. Cursor is bound to the local device/scope and follows
 * peer/source/stream ordering.
 */
export function normalizeReplicaListOptions(options) {
  if (options === undefined) options = {};
  if (!isPlainObject(options)) throw invalid('replica list options must be an object');
  rejectUnknownFields(options, new Set(['limit', 'cursor']), 'replica list options');
  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = normalizeReplicaListCursor(options.cursor, 'cursor');
  }
  return { limit: chooseLimit(options), cursor };
}

/**
 * User publish input: {messageId,text,replyTo?}. author/category/source/guard
 * are rejected at this boundary; normalization reuses normalizePublish with a
 * canonical user author and public category. Room-only rules and member checks
 * are enforced by the existing publish layer.
 */
export function normalizeUserMessage(scopeId, input) {
  if (!isPlainObject(input)) throw invalid('user message must be an object');
  rejectUnknownFields(input, new Set(['messageId', 'text', 'replyTo']), 'user message');
  return normalizePublish({
    messageId: input.messageId,
    scopeId,
    author: { kind: 'user' },
    category: 'public',
    text: input.text,
    replyTo: input.replyTo,
  });
}
