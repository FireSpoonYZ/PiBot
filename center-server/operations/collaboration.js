// Center server handlers for collaboration & session-control operations.
// Backed strictly by normalized Host Bridge fixed methods; never exposes
// generic HTTP/RPC/file-path capabilities, credentials, or raw config secrets.

import { randomUUID } from 'node:crypto';
import {
  assertId,
  assertRevision,
  messageError,
  normalizeScopeHistoryOptions,
} from '../../host-core/message-protocol.js';
import {
  normalizeScopeCreate,
  normalizeScopeUpdate,
  normalizeScopeDelete,
  normalizeScopeListOptions,
  normalizeReplicaListOptions,
  normalizeUserMessage,
} from '../../host-core/scope-protocol.js';
import { normalizeControlCall } from '../../host-core/remote-control-protocol.js';

const MAX_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_HISTORY_TEXT_UNITS = 4096;
const MAX_SINGLE_MESSAGE_TEXT_UNITS = 16384;
const MAX_CLIENT_ID_BYTES = 256;
const RESERVED_DEVICE_PREFIX = 'center-';

const OWNER_DELEGATED_PROVENANCE_NOTICE =
  'Published as an owner-delegated user message via authorized OAuth client (room-only; not authored by a Bot). Local receipt is not proof of remote peer delivery or Bot replies.';

const FIXED_HOST_METHODS = new Set([
  'listScopeStates',
  'getScopeState',
  'listScopeReplicas',
  'scopeHistory',
  'getScopeMessage',
  'getScopeMessageDelivery',
  'createScope',
  'updateScope',
  'deleteScope',
  'publishUserMessage',
  'withdrawQueued',
  'steerQueued',
  'editMessage',
  'getWorkActivity',
  'stopWork',
  'resumeWork',
]);

function fail(code, message) {
  throw messageError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainArgs(args, allowedKeys) {
  if (!isPlainObject(args)) {
    fail('INVALID_ARGUMENT', 'Tool arguments must be a plain JSON object');
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      fail('INVALID_ARGUMENT', `Unknown or disallowed argument: ${key}`);
    }
  }
  return args;
}

function assertClientId(value) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    /[\x00-\x1f\x7f]/.test(value) ||
    Buffer.byteLength(value.trim(), 'utf8') > MAX_CLIENT_ID_BYTES
  ) {
    fail('UNAUTHENTICATED', 'Invalid OAuth clientId');
  }
  return value.trim();
}

function isReservedDeviceId(deviceId, bridge) {
  return deviceId === bridge?.deviceId || deviceId.startsWith(RESERVED_DEVICE_PREFIX);
}

function assertTrustedActor(actor, bridge) {
  if (!isPlainObject(actor) || typeof actor.kind !== 'string') {
    fail('UNAUTHENTICATED', 'Trusted actor is required');
  }
  if (actor.kind === 'oauth') {
    return { kind: 'oauth', clientId: assertClientId(actor.clientId) };
  }
  if (actor.kind === 'bot') {
    if (
      typeof actor.deviceId !== 'string' ||
      typeof actor.botId !== 'string' ||
      !actor.deviceId.trim() ||
      !actor.botId.trim()
    ) {
      fail('UNAUTHENTICATED', 'Invalid Bot actor identity');
    }
    try {
      assertId(actor.deviceId, 'actor.deviceId');
      assertId(actor.botId, 'actor.botId');
    } catch {
      fail('UNAUTHENTICATED', 'Invalid Bot actor identity');
    }
    if (isReservedDeviceId(actor.deviceId, bridge)) {
      fail('FORBIDDEN', 'Reserved actor deviceId');
    }
    return { kind: 'bot', deviceId: actor.deviceId, botId: actor.botId };
  }
  fail('UNAUTHENTICATED', 'Unsupported actor kind');
}

function requireOAuthActor(actor, actionDescription) {
  if (actor.kind !== 'oauth') {
    fail('FORBIDDEN', `${actionDescription} is restricted to owner-delegated OAuth callers`);
  }
}

function assertTargetDevice(bridge, deviceId) {
  assertId(deviceId, 'deviceId');
  if (isReservedDeviceId(deviceId, bridge)) {
    fail('NOT_FOUND', 'Device not found');
  }
  if (!bridge || typeof bridge.call !== 'function') {
    fail('DEVICE_OFFLINE', 'Host bridge is unavailable');
  }
  if (typeof bridge.listDevices === 'function') {
    const device = bridge.listDevices().find((item) => item && item.deviceId === deviceId);
    if (!device) fail('NOT_FOUND', 'Device not found');
    if (device.online === false) fail('DEVICE_OFFLINE', 'Device offline');
  }
}

function assertNoReservedMembers(members, bridge) {
  for (const member of members) {
    if (isReservedDeviceId(member.deviceId, bridge)) {
      fail('INVALID_ARGUMENT', 'Member deviceId cannot be a reserved center device');
    }
  }
}

async function callHost(bridge, deviceId, method, params) {
  if (!FIXED_HOST_METHODS.has(method)) {
    fail('FORBIDDEN', 'Disallowed Host bridge method');
  }
  assertTargetDevice(bridge, deviceId);
  const normalized = normalizeControlCall(method, params);
  return bridge.call(deviceId, normalized.method, normalized.params);
}

function normalizeBoundedLimit(value) {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    fail('INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

function normalizeOptionalRequestId(value) {
  if (value === undefined) return randomUUID();
  assertId(value, 'requestId');
  return value;
}

function normalizeOptionalMessageId(value) {
  if (value === undefined) return randomUUID();
  assertId(value, 'messageId');
  return value;
}

function assertNonBlankWellFormedText(value, fieldName = 'text') {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim() === '') {
    fail('INVALID_ARGUMENT', `${fieldName} must be a well-formed non-blank string`);
  }
}

function isScopeMember(scope, actor) {
  if (actor.kind !== 'bot' || !Array.isArray(scope?.members)) return false;
  return scope.members.some(
    (member) => member.deviceId === actor.deviceId && member.botId === actor.botId,
  );
}

function assertActorScopeRead(state, actor, { allowNonMemberRoom }) {
  if (actor.kind === 'oauth') return;
  const scope = state?.scope;
  if (scope?.kind === 'dm') {
    if (!isScopeMember(scope, actor)) {
      fail('SCOPE_FORBIDDEN', 'Bot is not a member of this DM scope');
    }
    return;
  }
  if (!allowNonMemberRoom && !isScopeMember(scope, actor)) {
    fail('SCOPE_FORBIDDEN', 'Bot must be a member of this scope to access its messages or delivery status');
  }
}

async function enforceActorScopeAccess(bridge, deviceId, scopeId, actor, { allowNonMemberRoom }) {
  if (actor.kind === 'oauth') return null;
  const state = await callHost(bridge, deviceId, 'getScopeState', { scopeId });
  assertActorScopeRead(state, actor, { allowNonMemberRoom });
  return state;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateText(rawText, maxUnits) {
  const source = typeof rawText === 'string' ? rawText : '';
  let end = Math.min(source.length, maxUnits);
  // Preserve valid UTF-16: never split a surrogate pair at the truncation boundary.
  if (end > 0 && end < source.length) {
    const last = source.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return {
    text: source.slice(0, end),
    textTruncated: end < source.length,
    textLength: source.length,
  };
}

function projectStoredMessage(item, maxTextUnits) {
  const message = item?.message;
  const { text, textTruncated, textLength } = truncateText(message?.text, maxTextUnits);
  return {
    localId: item.localId,
    message: {
      ...message,
      text,
    },
    textTruncated,
    textLength,
    digest: item.digest,
    storedAt: item.storedAt,
    missingRefs: Array.isArray(item.missingRefs) ? item.missingRefs : [],
  };
}

function filterStreamsForItems(rawStreams, items) {
  if (!Array.isArray(rawStreams) || rawStreams.length === 0 || items.length === 0) return [];
  const referenced = new Set();
  for (const item of items) {
    const msg = item?.message;
    if (msg?.sourceDeviceId && msg?.streamId) {
      referenced.add(`${msg.sourceDeviceId}\u0000${msg.streamId}`);
    }
  }
  return rawStreams.filter(
    (stream) => stream && referenced.has(`${stream.sourceDeviceId}\u0000${stream.streamId}`),
  );
}

function boundHistoryPage(page, { deviceId, scopeId, order }) {
  const rawItems = Array.isArray(page?.items) ? page.items : [];
  const rawStreams = Array.isArray(page?.streams) ? page.streams : [];
  let kept = [];
  let truncatedBySize = false;
  let nextCursor = page?.nextCursor ?? null;
  let tailCursor = page?.tailCursor ?? null;

  for (let i = 0; i < rawItems.length; i += 1) {
    const projected = projectStoredMessage(rawItems[i], MAX_HISTORY_TEXT_UNITS);
    const candidateItems = kept.concat([projected]);
    const hasRemaining = i + 1 < rawItems.length;
    const candidateNextCursor = hasRemaining
      ? order === 'descending'
        ? { deviceId, kind: 'history-before', key: scopeId, beforeLocalId: projected.localId }
        : { deviceId, kind: 'history', key: scopeId, afterLocalId: projected.localId }
      : (page?.nextCursor ?? null);
    const candidateTailCursor =
      order === 'descending'
        ? { deviceId, kind: 'history', key: scopeId, afterLocalId: candidateItems[0].localId }
        : { deviceId, kind: 'history', key: scopeId, afterLocalId: projected.localId };
    const candidateStreams = filterStreamsForItems(rawStreams, candidateItems);
    const candidatePage = {
      deviceId,
      scopeId,
      items: candidateItems,
      nextCursor: candidateNextCursor,
      tailCursor: candidateTailCursor,
      streams: candidateStreams,
      truncatedBySize: false,
    };
    if (jsonBytes(candidatePage) > MAX_OUTPUT_BYTES) {
      if (kept.length === 0) {
        fail('RESPONSE_TOO_LARGE', 'A single scope message preview exceeds the 50 KiB response size limit');
      }
      truncatedBySize = true;
      const last = kept[kept.length - 1];
      nextCursor =
        order === 'descending'
          ? { deviceId, kind: 'history-before', key: scopeId, beforeLocalId: last.localId }
          : { deviceId, kind: 'history', key: scopeId, afterLocalId: last.localId };
      tailCursor =
        order === 'descending'
          ? { deviceId, kind: 'history', key: scopeId, afterLocalId: kept[0].localId }
          : { deviceId, kind: 'history', key: scopeId, afterLocalId: last.localId };
      break;
    }
    kept = candidateItems;
    nextCursor = candidateNextCursor;
    tailCursor = candidateTailCursor;
  }

  return {
    deviceId,
    scopeId,
    items: kept,
    nextCursor,
    tailCursor,
    streams: filterStreamsForItems(rawStreams, kept),
    truncatedBySize,
  };
}

function boundScopeListPage(page, { deviceId, actor }) {
  const rawItems = Array.isArray(page?.items) ? page.items : [];
  let kept = [];
  let lastVisibleScopeId = null;
  let overflowed = false;
  let nextCursor = page?.nextCursor ?? null;

  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i];
    if (actor.kind === 'bot' && item?.scope?.kind === 'dm' && !isScopeMember(item.scope, actor)) {
      continue;
    }
    const candidateItems = kept.concat([item]);
    const hasRemaining = i + 1 < rawItems.length;
    const candidateNextCursor = hasRemaining
      ? { deviceId, afterScopeId: item.scope.scopeId }
      : (page?.nextCursor ?? null);
    if (jsonBytes({ deviceId, items: candidateItems, nextCursor: candidateNextCursor }) > MAX_OUTPUT_BYTES) {
      if (kept.length === 0) {
        fail('RESPONSE_TOO_LARGE', 'A single scope record exceeds the 50 KiB response size limit');
      }
      overflowed = true;
      nextCursor = { deviceId, afterScopeId: lastVisibleScopeId };
      break;
    }
    kept = candidateItems;
    lastVisibleScopeId = item.scope.scopeId;
  }

  if (!overflowed) {
    nextCursor = page?.nextCursor ?? null;
  }

  return { deviceId, items: kept, nextCursor };
}

function boundReplicaListPage(page, { deviceId, scopeId }) {
  const rawItems = Array.isArray(page?.items) ? page.items : [];
  let kept = [];
  let nextCursor = page?.nextCursor ?? null;

  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i];
    const candidateItems = kept.concat([item]);
    const hasRemaining = i + 1 < rawItems.length;
    const makeCursor = (entry) => ({
      deviceId,
      scopeId,
      afterPeerDeviceId: entry.peerDeviceId,
      afterSourceDeviceId: entry.stream.sourceDeviceId,
      afterStreamId: entry.stream.streamId,
    });
    const candidateNextCursor = hasRemaining ? makeCursor(item) : (page?.nextCursor ?? null);
    if (jsonBytes({ deviceId, scopeId, items: candidateItems, nextCursor: candidateNextCursor }) > MAX_OUTPUT_BYTES) {
      if (kept.length === 0) {
        fail('RESPONSE_TOO_LARGE', 'A single replica record exceeds the 50 KiB response size limit');
      }
      nextCursor = makeCursor(kept[kept.length - 1]);
      break;
    }
    kept = candidateItems;
    nextCursor = candidateNextCursor;
  }

  return { deviceId, scopeId, items: kept, nextCursor };
}

function formatOwnerDelegatedPrefix(clientId) {
  // Neutralize '@' and bracket/control characters so clientId can never inject
  // @mentions or forge framing lines inside room messages.
  const safeClientId = clientId
    .replace(/[\x00-\x1f\x7f\r\n]+/g, ' ')
    .replaceAll('@', '(at)')
    .replaceAll('[', '(')
    .replaceAll(']', ')')
    .trim();
  return `[Owner-delegated via OAuth: ${safeClientId}]\n`;
}

function normalizeMemberInput(member, label, bridge) {
  if (!isPlainObject(member)) {
    fail('INVALID_ARGUMENT', `${label} must be a plain object`);
  }
  for (const key of Object.keys(member)) {
    if (key !== 'deviceId' && key !== 'botId') {
      fail('INVALID_ARGUMENT', `${label} has unknown field: ${key}`);
    }
  }
  assertId(member.deviceId, `${label}.deviceId`);
  assertId(member.botId, `${label}.botId`);
  if (isReservedDeviceId(member.deviceId, bridge)) {
    fail('INVALID_ARGUMENT', `${label}.deviceId cannot be a reserved center device`);
  }
  return { deviceId: member.deviceId, botId: member.botId };
}

export function createHandlers(deps = {}) {
  const { bridge } = deps;

  return {
    // ── Scope / Room Queries (read-only) ────────────────────────────────────
    async collaboration_list_scopes(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'limit', 'cursor']);
      assertId(args.deviceId, 'deviceId');
      const limit = normalizeBoundedLimit(args.limit);
      const options = normalizeScopeListOptions({
        limit,
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      });
      const page = await callHost(bridge, args.deviceId, 'listScopeStates', options);
      return boundScopeListPage(page, { deviceId: args.deviceId, actor });
    },

    async collaboration_get_scope(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      const state = await callHost(bridge, args.deviceId, 'getScopeState', { scopeId: args.scopeId });
      assertActorScopeRead(state, actor, { allowNonMemberRoom: true });
      return state;
    },

    async collaboration_list_scope_replicas(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'limit', 'cursor']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      const limit = normalizeBoundedLimit(args.limit);
      const options = normalizeReplicaListOptions({
        limit,
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      });
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: true,
      });
      const page = await callHost(bridge, args.deviceId, 'listScopeReplicas', {
        scopeId: args.scopeId,
        ...options,
      });
      return boundReplicaListPage(page, { deviceId: args.deviceId, scopeId: args.scopeId });
    },

    async collaboration_list_scope_history(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'order', 'limit', 'cursor']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      const limit = normalizeBoundedLimit(args.limit);
      const options = normalizeScopeHistoryOptions({
        limit,
        ...(args.order !== undefined ? { order: args.order } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      });
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: false,
      });
      const page = await callHost(bridge, args.deviceId, 'scopeHistory', {
        scopeId: args.scopeId,
        ...options,
      });
      return boundHistoryPage(page, {
        deviceId: args.deviceId,
        scopeId: args.scopeId,
        order: options.order,
      });
    },

    async collaboration_get_scope_message(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'messageId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertId(args.messageId, 'messageId');
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: false,
      });
      const stored = await callHost(bridge, args.deviceId, 'getScopeMessage', {
        scopeId: args.scopeId,
        messageId: args.messageId,
      });
      return projectStoredMessage(stored, MAX_SINGLE_MESSAGE_TEXT_UNITS);
    },

    async collaboration_get_scope_message_delivery(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'messageId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertId(args.messageId, 'messageId');
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: false,
      });
      const delivery = await callHost(bridge, args.deviceId, 'getScopeMessageDelivery', {
        scopeId: args.scopeId,
        messageId: args.messageId,
      });
      return {
        deviceId: args.deviceId,
        scopeId: args.scopeId,
        messageId: delivery.messageId,
        targets: delivery.targets,
      };
    },

    async collaboration_get_work_activity(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'botId', 'scopeId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.botId, 'botId');
      assertId(args.scopeId, 'scopeId');
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: true,
      });
      const activity = await callHost(bridge, args.deviceId, 'getWorkActivity', {
        botId: args.botId,
        scopeId: args.scopeId,
      });
      return { deviceId: args.deviceId, ...activity };
    },

    // ── Room Lifecycle Management (write / destructive) ─────────────────────
    async collaboration_create_room(rawArgs, rawActor) {
      assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'members', 'title', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      const requestId = normalizeOptionalRequestId(args.requestId);
      const input = normalizeScopeCreate({
        requestId,
        kind: 'room',
        members: args.members,
        ...(args.title !== undefined ? { title: args.title } : {}),
      });
      assertNoReservedMembers(input.members, bridge);
      if (!input.members.some((member) => member.deviceId === args.deviceId)) {
        fail('SCOPE_FORBIDDEN', 'Authority deviceId must have at least one local member in members');
      }
      const created = await callHost(bridge, args.deviceId, 'createScope', { input });
      return { ...created, requestId };
    },

    async collaboration_rename_room(rawArgs, rawActor) {
      assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'expectedRevision', 'title', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertRevision(args.expectedRevision, 'expectedRevision');
      if (typeof args.title !== 'string') {
        fail('INVALID_ARGUMENT', 'title must be a string (use "" to clear the custom title)');
      }
      const requestId = normalizeOptionalRequestId(args.requestId);
      const input = normalizeScopeUpdate({
        requestId,
        expectedRevision: args.expectedRevision,
        title: args.title,
      });
      const updated = await callHost(bridge, args.deviceId, 'updateScope', {
        scopeId: args.scopeId,
        input,
      });
      return { ...updated, requestId };
    },

    async collaboration_update_room_members(rawArgs, rawActor) {
      assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'expectedRevision', 'members', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertRevision(args.expectedRevision, 'expectedRevision');
      if (!Array.isArray(args.members)) {
        fail('INVALID_ARGUMENT', 'members must be an array of 2-64 members');
      }
      const requestId = normalizeOptionalRequestId(args.requestId);
      const input = normalizeScopeUpdate({
        requestId,
        expectedRevision: args.expectedRevision,
        members: args.members,
      });
      assertNoReservedMembers(input.members, bridge);
      // Verify immutable scope kind === 'room' so DMs never receive a no-op revision bump;
      // leave authority/CAS/idempotency/tombstone checks atomic on Host updateScope.
      const current = await callHost(bridge, args.deviceId, 'getScopeState', { scopeId: args.scopeId });
      if (current?.scope?.kind !== 'room') {
        fail('SCOPE_FORBIDDEN', 'Only room scopes support membership updates; DM participants are immutable');
      }
      const updated = await callHost(bridge, args.deviceId, 'updateScope', {
        scopeId: args.scopeId,
        input,
      });
      return { ...updated, requestId };
    },

    async collaboration_leave_room(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'expectedRevision', 'member', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertRevision(args.expectedRevision, 'expectedRevision');

      let leavingMember;
      if (actor.kind === 'bot') {
        if (args.member !== undefined) {
          const requested = normalizeMemberInput(args.member, 'member', bridge);
          if (requested.deviceId !== actor.deviceId || requested.botId !== actor.botId) {
            fail('FORBIDDEN', 'Bot callers may only leave a room as themselves; use collaboration_update_room_members for delegated membership changes');
          }
        }
        leavingMember = { deviceId: actor.deviceId, botId: actor.botId };
      } else {
        if (args.member === undefined) {
          fail('INVALID_ARGUMENT', 'member ({ deviceId, botId }) is required for OAuth callers');
        }
        leavingMember = normalizeMemberInput(args.member, 'member', bridge);
      }

      const explicitRequestId = args.requestId !== undefined;
      const requestId = normalizeOptionalRequestId(args.requestId);
      const state = await callHost(bridge, args.deviceId, 'getScopeState', { scopeId: args.scopeId });
      if (state?.scope?.kind !== 'room') {
        fail('SCOPE_FORBIDDEN', 'Only room scopes can be left; DM scopes are immutable');
      }
      if (state.scope.deletedAt !== undefined) {
        fail('SCOPE_DELETED', 'Scope has already been deleted');
      }
      if (!state.isAuthority) {
        fail('SCOPE_AUTHORITY_REQUIRED', 'Only the room authority Host may process leaving');
      }

      const currentMembers = state.scope.members;
      const isPresent = currentMembers.some(
        (m) => m.deviceId === leavingMember.deviceId && m.botId === leavingMember.botId,
      );
      let nextMembers;
      if (state.scope.revision === args.expectedRevision) {
        if (!isPresent) {
          fail('SCOPE_FORBIDDEN', 'Specified member is not currently in this room');
        }
        nextMembers = currentMembers.filter(
          (m) => !(m.deviceId === leavingMember.deviceId && m.botId === leavingMember.botId),
        );
        if (nextMembers.length < 2) {
          fail(
            'INVALID_ARGUMENT',
            'Room must retain at least 2 members; dissolve the room with collaboration_delete_room instead',
          );
        }
      } else if (explicitRequestId && !isPresent && currentMembers.length >= 2) {
        // Allow an exact idempotent retry with the same requestId when the prior
        // leave already applied on the authority Host and its response was lost.
        nextMembers = currentMembers;
      } else {
        fail('REQUEST_CONFLICT', 'expectedRevision does not match latest revision');
      }

      const input = normalizeScopeUpdate({
        requestId,
        expectedRevision: args.expectedRevision,
        members: nextMembers,
      });
      const updated = await callHost(bridge, args.deviceId, 'updateScope', {
        scopeId: args.scopeId,
        input,
      });
      return { ...updated, leftMember: leavingMember, requestId };
    },

    async collaboration_delete_room(rawArgs, rawActor) {
      assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'expectedRevision', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertRevision(args.expectedRevision, 'expectedRevision');
      const requestId = normalizeOptionalRequestId(args.requestId);
      const input = normalizeScopeDelete({
        requestId,
        expectedRevision: args.expectedRevision,
      });
      const deleted = await callHost(bridge, args.deviceId, 'deleteScope', {
        scopeId: args.scopeId,
        input,
      });
      return { ...deleted, requestId };
    },

    // ── Owner-Delegated Room Message Publish (OAuth-only, room-only) ────────
    async collaboration_publish_room_message(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      requireOAuthActor(
        actor,
        'Owner-delegated room publication (Bots must use local send_to in their own turn to preserve Bot identity and reply linkage)',
      );
      const args = assertPlainArgs(rawArgs, ['deviceId', 'scopeId', 'text', 'messageId', 'replyTo']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.scopeId, 'scopeId');
      assertNonBlankWellFormedText(args.text, 'text');
      const messageId = normalizeOptionalMessageId(args.messageId);
      const replyTo = args.replyTo === undefined || args.replyTo === null ? undefined : args.replyTo;
      if (replyTo !== undefined) assertId(replyTo, 'replyTo');

      const provenancePrefix = formatOwnerDelegatedPrefix(actor.clientId);
      const publishedText = provenancePrefix + args.text;
      const input = {
        messageId,
        text: publishedText,
        ...(replyTo !== undefined ? { replyTo } : {}),
      };
      // Validate final composed text and protocol bounds before hitting the Host relay.
      normalizeUserMessage(args.scopeId, input);

      const stored = await callHost(bridge, args.deviceId, 'publishUserMessage', {
        scopeId: args.scopeId,
        input,
      });
      const message = stored?.message;
      return {
        deviceId: args.deviceId,
        scopeId: args.scopeId,
        messageId: message?.messageId ?? messageId,
        localId: stored?.localId ?? null,
        status: 'stored',
        author: message?.author ?? { kind: 'user' },
        category: message?.category ?? 'public',
        rootId: message?.rootId ?? messageId,
        replyTo: message?.replyTo ?? null,
        createdAt: message?.createdAt ?? null,
        storedAt: stored?.storedAt ?? null,
        provenance: {
          kind: 'owner_delegated_oauth',
          clientId: actor.clientId,
          authorKind: 'user',
          roomOnly: true,
          header: provenancePrefix.trimEnd(),
          notice: OWNER_DELEGATED_PROVENANCE_NOTICE,
        },
      };
    },

    // ── Primary Session Queue & Edit Controls (OAuth-only) ──────────────────
    async collaboration_withdraw_queued(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      requireOAuthActor(actor, 'Withdrawing queued primary user messages');
      const args = assertPlainArgs(rawArgs, ['deviceId', 'botId', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.botId, 'botId');
      const params = {
        botId: args.botId,
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      };
      const result = await callHost(bridge, args.deviceId, 'withdrawQueued', params);
      return { deviceId: args.deviceId, ...result };
    },

    async collaboration_steer_queued(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      requireOAuthActor(actor, 'Steering queued primary user messages');
      const args = assertPlainArgs(rawArgs, ['deviceId', 'botId', 'requestId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.botId, 'botId');
      assertId(args.requestId, 'requestId');
      const result = await callHost(bridge, args.deviceId, 'steerQueued', {
        botId: args.botId,
        requestId: args.requestId,
      });
      return { deviceId: args.deviceId, ...result };
    },

    async collaboration_edit_message(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      requireOAuthActor(actor, 'Editing primary user messages and regenerating turns');
      const args = assertPlainArgs(rawArgs, [
        'deviceId',
        'botId',
        'entryId',
        'text',
        'attachments',
        'requestId',
      ]);
      assertId(args.deviceId, 'deviceId');
      assertId(args.botId, 'botId');
      if (typeof args.text === 'string' && args.text.length > 262144) {
        fail('INVALID_ARGUMENT', 'text must be at most 262144 characters');
      }
      const requestId = normalizeOptionalRequestId(args.requestId);
      const params = {
        botId: args.botId,
        entryId: args.entryId,
        requestId,
        text: args.text,
        ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
      };
      const result = await callHost(bridge, args.deviceId, 'editMessage', params);
      return {
        ...(isPlainObject(result) ? result : { receipt: result }),
        deviceId: args.deviceId,
        botId: args.botId,
        entryId: args.entryId,
        requestId,
      };
    },

    // ── Collaboration Work Stop / Resume Controls ───────────────────────────
    async collaboration_stop_work(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'botId', 'scopeId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.botId, 'botId');
      assertId(args.scopeId, 'scopeId');
      if (actor.kind === 'bot' && actor.deviceId === args.deviceId && actor.botId === args.botId) {
        fail('INVALID_ARGUMENT', 'A Bot cannot stop its own collaboration work during its own turn');
      }
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: true,
      });
      const activity = await callHost(bridge, args.deviceId, 'stopWork', {
        botId: args.botId,
        scopeId: args.scopeId,
      });
      return { deviceId: args.deviceId, ...activity };
    },

    async collaboration_resume_work(rawArgs, rawActor) {
      const actor = assertTrustedActor(rawActor, bridge);
      const args = assertPlainArgs(rawArgs, ['deviceId', 'botId', 'scopeId']);
      assertId(args.deviceId, 'deviceId');
      assertId(args.botId, 'botId');
      assertId(args.scopeId, 'scopeId');
      await enforceActorScopeAccess(bridge, args.deviceId, args.scopeId, actor, {
        allowNonMemberRoom: true,
      });
      const activity = await callHost(bridge, args.deviceId, 'resumeWork', {
        botId: args.botId,
        scopeId: args.scopeId,
      });
      return { deviceId: args.deviceId, ...activity };
    },
  };
}
