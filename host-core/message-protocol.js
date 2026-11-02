import { createHash } from 'node:crypto';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const SCOPE_FORBIDDEN = 'SCOPE_FORBIDDEN';
const MAX_ID_BYTES = 256;
const MAX_TEXT_BYTES = 262144;
const MAX_SCOPE_MEMBERS = 64;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CATEGORIES = new Set(['public', 'notice', 'request', 'reply']);
const PAGE_KINDS = new Set(['history', 'inbox', 'outbox']);
// history-before 是 scope 历史专用倒序游标，inbox/outbox 只保留原 'history' 升序游标。
const HISTORY_PAGE_KINDS = new Set(['history', 'history-before']);
const SCOPE_HISTORY_ORDERS = new Set(['ascending', 'descending']);
const ISO_MS_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Create an Error carrying a stable machine-readable code (one of the protocol
 * error codes). Messages are human-readable; codes are the API contract.
 */
export function messageError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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

// JS string comparison orders by UTF-16 code units; localeCompare is not
// deterministic across locales and must never be used for canonical order.
function compareCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareMembers(a, b) {
  return compareCodeUnit(a.deviceId, b.deviceId) || compareCodeUnit(a.botId, b.botId);
}

export function assertId(value, name) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES
  ) {
    throw invalid(`${name} must be a well-formed non-blank string of at most 256 UTF-8 bytes`);
  }
}

export function assertRevision(value, name = 'revision') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} must be a positive safe integer`);
  }
}

function assertText(value) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw invalid('text must be a well-formed non-blank string of at most 262144 UTF-8 bytes');
  }
}

function assertCategory(value) {
  if (typeof value !== 'string' || !CATEGORIES.has(value)) {
    throw invalid('category must be one of public, notice, request, reply');
  }
}

function assertIsoMsZ(value, name) {
  if (typeof value !== 'string' || !ISO_MS_Z_RE.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalid(`${name} must be an ISO 8601 millisecond UTC string (YYYY-MM-DDTHH:mm:ss.sssZ)`);
  }
}

function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw invalid('digest must be a lowercase 64-character hex SHA-256');
  }
}

function normalizeAuthor(author) {
  if (!isPlainObject(author)) throw invalid('author must be an object');
  rejectUnknownFields(author, new Set(['kind', 'botId']), 'author');
  if (author.kind === 'bot') {
    assertId(author.botId, 'author.botId');
    return { kind: 'bot', botId: author.botId };
  }
  if (author.kind === 'user') {
    if (author.botId !== undefined) {
      throw invalid('author of kind user must not carry botId');
    }
    return { kind: 'user' };
  }
  throw invalid("author.kind must be 'bot' or 'user'");
}

function normalizeMember(member) {
  if (!isPlainObject(member)) throw invalid('member must be a plain object');
  rejectUnknownFields(member, new Set(['deviceId', 'botId']), 'member');
  assertId(member.deviceId, 'member.deviceId');
  assertId(member.botId, 'member.botId');
  return { deviceId: member.deviceId, botId: member.botId };
}

function normalizeMembers(members, label) {
  if (!Array.isArray(members)) throw invalid(`${label} must be an array`);
  if (members.length > MAX_SCOPE_MEMBERS) {
    throw invalid(`${label} must have at most 64 members`);
  }
  const seen = new Set();
  const normalized = members.map((member) => {
    const m = normalizeMember(member);
    if (seen.has(m.botId)) {
      throw invalid(`${label} has duplicate botId: ${m.botId}`);
    }
    seen.add(m.botId);
    return m;
  });
  normalized.sort(compareMembers);
  return normalized;
}

function sha256Hex(json) {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Stable digest of a normalized protocol value. Only normalized values (fixed
 * key order) may be passed; this is not a generic object canonicalizer.
 */
export function digest(normalizedValue) {
  return sha256Hex(JSON.stringify(normalizedValue));
}

// Streams are per (scopeId,revision,sourceDeviceId); the streamId is derived
// only from scope+revision, so a new membership revision starts a fresh stream.
export function streamIdForScope(scopeId, revision) {
  return 'scope:' + sha256Hex(JSON.stringify([scopeId, revision]));
}

const MAX_SCOPE_TITLE_CHARS = 120;

// Room title：trim 后 ≤120 字符；undefined/缺省 = 保留语义由调用方决定；
// ''/全空白 = 显式清空（恢复成员拼接默认名），非空白 = 设名。
export function normalizeScopeTitle(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw invalid('scope.title must be a well-formed string');
  }
  const title = value.trim();
  if ([...title].length > MAX_SCOPE_TITLE_CHARS) {
    throw invalid('scope.title must be at most 120 characters');
  }
  return title;
}

export function normalizeScope(input) {
  if (!isPlainObject(input)) throw invalid('scope must be an object');
  rejectUnknownFields(input, new Set(['scopeId', 'kind', 'revision', 'members', 'title', 'deletedAt']), 'scope');
  assertId(input.scopeId, 'scopeId');
  const { kind, revision } = input;
  if (kind !== 'dm' && kind !== 'room') {
    throw invalid("scope.kind must be 'dm' or 'room'");
  }
  assertRevision(revision, 'revision');
  const members = normalizeMembers(input.members, 'scope.members');
  if (kind === 'dm') {
    if (members.length !== 2) {
      throw invalid('dm scope must have exactly 2 distinct members');
    }
  } else if (members.length < 2) {
    throw invalid('room scope must have at least 2 members');
  }
  const scope = { scopeId: input.scopeId, kind, revision, members };
  // room 元数据仅 room 可携带：DM 拒绝 title/deletedAt，杜绝半规范形态。
  if (kind === 'dm' && (input.title !== undefined || input.deletedAt !== undefined)) {
    throw invalid('dm scope must not carry room metadata (title/deletedAt)');
  }
  const title = normalizeScopeTitle(input.title);
  // 空 title 规范化为缺省（无 title 键）：'清空' 意图由 update 输入层携带，
  // 规范化 scope 值上 title 只在有真实名称时出现，保持旧无字段 digest 不变。
  if (title !== undefined && title !== '') scope.title = title;
  // deletedAt 是 room 删除墓碑（ISO UTC）；只在规范化值上可选携带，旧记录无此键。
  if (input.deletedAt !== undefined) {
    assertIsoMsZ(input.deletedAt, 'deletedAt');
    scope.deletedAt = input.deletedAt;
  }
  return scope;
}

export function normalizePublish(input) {
  if (!isPlainObject(input)) throw invalid('publish input must be an object');
  rejectUnknownFields(input, new Set(['messageId', 'scopeId', 'author', 'category', 'text', 'replyTo']), 'publish input');
  assertId(input.messageId, 'messageId');
  assertId(input.scopeId, 'scopeId');
  const author = normalizeAuthor(input.author);
  assertCategory(input.category);
  assertText(input.text);
  let replyTo = null;
  if (input.replyTo !== undefined && input.replyTo !== null) {
    assertId(input.replyTo, 'replyTo');
    replyTo = input.replyTo;
  }
  return {
    messageId: input.messageId,
    scopeId: input.scopeId,
    author,
    category: input.category,
    text: input.text,
    replyTo,
  };
}

export function normalizePublishGuard(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) throw invalid('publish guard must be an object');
  rejectUnknownFields(value, new Set(['scopeId', 'afterLocalId']), 'publish guard');
  assertId(value.scopeId, 'guard.scopeId');
  if (!Number.isSafeInteger(value.afterLocalId) || value.afterLocalId < 0) {
    throw invalid('guard.afterLocalId must be a non-negative safe integer');
  }
  return { scopeId: value.scopeId, afterLocalId: value.afterLocalId };
}

export function normalizeEnvelope(envelope) {
  if (!isPlainObject(envelope)) throw invalid('envelope must be an object');
  rejectUnknownFields(
    envelope,
    new Set([
      'protocolVersion',
      'messageId',
      'sourceDeviceId',
      'streamId',
      'sequence',
      'scopeId',
      'revision',
      'author',
      'category',
      'rootId',
      'replyTo',
      'text',
      'targets',
      'createdAt',
    ]),
    'envelope'
  );
  if (envelope.protocolVersion !== 1) throw invalid('envelope.protocolVersion must be 1');
  assertId(envelope.messageId, 'messageId');
  assertId(envelope.sourceDeviceId, 'sourceDeviceId');
  assertId(envelope.streamId, 'streamId');
  assertRevision(envelope.sequence, 'sequence');
  assertId(envelope.scopeId, 'scopeId');
  assertRevision(envelope.revision, 'revision');
  const author = normalizeAuthor(envelope.author);
  assertCategory(envelope.category);
  assertId(envelope.rootId, 'rootId');
  let replyTo = null;
  if (envelope.replyTo !== undefined && envelope.replyTo !== null) {
    assertId(envelope.replyTo, 'replyTo');
    replyTo = envelope.replyTo;
  }
  assertText(envelope.text);
  const targets = normalizeMembers(envelope.targets, 'envelope.targets');
  assertIsoMsZ(envelope.createdAt, 'createdAt');
  const expectedStreamId = streamIdForScope(envelope.scopeId, envelope.revision);
  if (envelope.streamId !== expectedStreamId) {
    throw invalid('envelope.streamId does not match scopeId/revision');
  }
  return {
    protocolVersion: 1,
    messageId: envelope.messageId,
    sourceDeviceId: envelope.sourceDeviceId,
    streamId: envelope.streamId,
    sequence: envelope.sequence,
    scopeId: envelope.scopeId,
    revision: envelope.revision,
    author,
    category: envelope.category,
    rootId: envelope.rootId,
    replyTo,
    text: envelope.text,
    targets,
    createdAt: envelope.createdAt,
  };
}

export function normalizePeer(peer) {
  if (!isPlainObject(peer)) throw invalid('peer must be an object');
  rejectUnknownFields(peer, new Set(['deviceId']), 'peer');
  assertId(peer.deviceId, 'deviceId');
  return { deviceId: peer.deviceId };
}

export function normalizeAck(ack) {
  if (!isPlainObject(ack)) throw invalid('ack must be an object');
  rejectUnknownFields(
    ack,
    new Set(['protocolVersion', 'messageId', 'sourceDeviceId', 'recipientDeviceId', 'digest', 'storedAt']),
    'ack'
  );
  if (ack.protocolVersion !== 1) throw invalid('ack.protocolVersion must be 1');
  assertId(ack.messageId, 'messageId');
  assertId(ack.sourceDeviceId, 'sourceDeviceId');
  assertId(ack.recipientDeviceId, 'recipientDeviceId');
  assertSha256Hex(ack.digest);
  assertIsoMsZ(ack.storedAt, 'storedAt');
  return {
    protocolVersion: 1,
    messageId: ack.messageId,
    sourceDeviceId: ack.sourceDeviceId,
    recipientDeviceId: ack.recipientDeviceId,
    digest: ack.digest,
    storedAt: ack.storedAt,
  };
}

function normalizeCursor(cursor) {
  if (!isPlainObject(cursor)) throw invalid('cursor must be an object');
  rejectUnknownFields(
    cursor,
    new Set(['deviceId', 'kind', 'key', 'afterLocalId', 'afterTargetDeviceId']),
    'cursor'
  );
  assertId(cursor.deviceId, 'cursor.deviceId');
  if (typeof cursor.kind !== 'string' || !PAGE_KINDS.has(cursor.kind)) {
    throw invalid("cursor.kind must be 'history', 'inbox', or 'outbox'");
  }
  assertId(cursor.key, 'cursor.key');
  assertRevision(cursor.afterLocalId, 'afterLocalId');
  const normalized = {
    deviceId: cursor.deviceId,
    kind: cursor.kind,
    key: cursor.key,
    afterLocalId: cursor.afterLocalId,
  };
  if (cursor.afterTargetDeviceId !== undefined) {
    assertId(cursor.afterTargetDeviceId, 'afterTargetDeviceId');
    normalized.afterTargetDeviceId = cursor.afterTargetDeviceId;
  }
  return normalized;
}

function normalizeHistoryCursor(cursor) {
  if (!isPlainObject(cursor)) throw invalid('cursor must be an object');
  rejectUnknownFields(
    cursor,
    new Set(['deviceId', 'kind', 'key', 'afterLocalId', 'beforeLocalId']),
    'cursor'
  );
  assertId(cursor.deviceId, 'cursor.deviceId');
  if (typeof cursor.kind !== 'string' || !HISTORY_PAGE_KINDS.has(cursor.kind)) {
    throw invalid("cursor.kind must be 'history' or 'history-before'");
  }
  assertId(cursor.key, 'cursor.key');
  if (cursor.kind === 'history') {
    assertRevision(cursor.afterLocalId, 'afterLocalId');
    if (cursor.beforeLocalId !== undefined) {
      throw invalid("'history' cursor must not include beforeLocalId");
    }
    return {
      deviceId: cursor.deviceId,
      kind: 'history',
      key: cursor.key,
      afterLocalId: cursor.afterLocalId,
    };
  }
  assertRevision(cursor.beforeLocalId, 'beforeLocalId');
  if (cursor.afterLocalId !== undefined) {
    throw invalid("'history-before' cursor must not include afterLocalId");
  }
  return {
    deviceId: cursor.deviceId,
    kind: 'history-before',
    key: cursor.key,
    beforeLocalId: cursor.beforeLocalId,
  };
}

function normalizePageLimit(value) {
  let limit = DEFAULT_LIMIT;
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw invalid('limit must be a positive integer between 1 and 200');
    }
    limit = value;
  }
  return limit;
}

export function normalizePageOptions(options) {
  if (options === undefined || options === null) options = {};
  if (!isPlainObject(options)) throw invalid('page options must be an object');
  rejectUnknownFields(options, new Set(['limit', 'cursor']), 'page options');
  const limit = normalizePageLimit(options.limit);
  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = normalizeCursor(options.cursor);
  }
  return { limit, cursor };
}

/**
 * scopeHistory 专用：在原分页基础上允许 order。默认 'ascending' 保持既有行为；
 * 'descending' 配 kind:'history-before' 游标向更旧翻页，tailCursor 始终为升序续读游标。
 */
export function normalizeScopeHistoryOptions(options) {
  if (options === undefined || options === null) options = {};
  if (!isPlainObject(options)) throw invalid('page options must be an object');
  rejectUnknownFields(options, new Set(['limit', 'cursor', 'order']), 'page options');
  const limit = normalizePageLimit(options.limit);
  let order = 'ascending';
  if (options.order !== undefined) {
    if (typeof options.order !== 'string' || !SCOPE_HISTORY_ORDERS.has(options.order)) {
      throw invalid("order must be 'ascending' or 'descending'");
    }
    order = options.order;
  }
  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = normalizeHistoryCursor(options.cursor);
    if (cursor.kind === 'history' && order === 'descending') {
      throw invalid("descending order requires no cursor or a 'history-before' cursor");
    }
    if (cursor.kind === 'history-before' && order === 'ascending') {
      throw invalid("ascending order requires no cursor or a 'history' cursor");
    }
  }
  return { limit, cursor, order };
}

function sameMembers(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].deviceId !== b[i].deviceId || a[i].botId !== b[i].botId) return false;
  }
  return true;
}

/**
 * Pure protocol invariants of a message against an installed scope revision:
 * exact frozen target list, category/kind legality, author membership on the
 * source device, and local-host participation. Local Bot existence and
 * reference resolution are the store/facade's job.
 */
export function assertScopeMessage(scope, envelope, localDeviceId) {
  assertId(localDeviceId, 'localDeviceId');
  if (envelope.scopeId !== scope.scopeId) {
    throw invalid('envelope.scopeId does not match scope');
  }
  if (envelope.revision !== scope.revision) {
    throw invalid('envelope.revision does not match scope revision');
  }
  if (envelope.streamId !== streamIdForScope(scope.scopeId, scope.revision)) {
    throw invalid('envelope.streamId does not match scope revision');
  }
  if (!sameMembers(envelope.targets, scope.members)) {
    throw messageError(SCOPE_FORBIDDEN, 'envelope.targets must equal the canonical scope revision member list');
  }
  if (scope.kind === 'room') {
    if (envelope.category !== 'public') {
      throw messageError(SCOPE_FORBIDDEN, 'room messages must have category public');
    }
  } else {
    if (envelope.category === 'public') {
      throw messageError(SCOPE_FORBIDDEN, 'dm messages must not have category public');
    }
    if (envelope.category === 'reply' && envelope.replyTo === null) {
      throw messageError(SCOPE_FORBIDDEN, 'dm reply messages must reference replyTo');
    }
  }
  if (envelope.author.kind === 'bot') {
    if (!scope.members.some((m) => m.botId === envelope.author.botId && m.deviceId === envelope.sourceDeviceId)) {
      throw messageError(SCOPE_FORBIDDEN, 'author bot must be a scope member on the source device');
    }
  } else if (
    scope.kind !== 'room' ||
    !scope.members.some((m) => m.deviceId === envelope.sourceDeviceId)
  ) {
    throw messageError(SCOPE_FORBIDDEN, 'user author requires a room scope with a member bot on the source device');
  }
  if (!scope.members.some((m) => m.deviceId === localDeviceId)) {
    throw messageError(SCOPE_FORBIDDEN, 'scope must include a local member bot');
  }
}
