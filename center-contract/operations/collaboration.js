// Shared collaboration & session-control operation descriptors.
// Pure plain JSON Schema definitions backed strictly by normalized Host Bridge
// control methods (no generic HTTP/RPC/file-path capabilities, no secret output).

import { defineOperation } from './schema.js';

const ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
};

const DEVICE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Target online Host device ID (cannot be Center\'s internal relay ID).',
};

const SCOPE_ID_SCHEMA = {
  ...ID_SCHEMA,
  description: 'Collaboration scope ID (room or DM).',
};

const BOT_ID_SCHEMA = {
  ...ID_SCHEMA,
  description: 'Target Bot ID on the specified Host device.',
};

const REVISION_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description: 'Expected current scope revision for optimistic CAS concurrency control.',
};

const REQUEST_ID_SCHEMA = {
  ...ID_SCHEMA,
  description: 'Optional idempotency key. Reuse the same requestId when retrying an uncertain call; generated automatically if omitted.',
};

const PAGE_LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 50,
  description: 'Maximum items to return in one bounded page (1-50, default 20).',
};

const MEMBER_SCHEMA = {
  type: 'object',
  properties: {
    deviceId: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Host device ID owning this member Bot.',
    },
    botId: {
      ...ID_SCHEMA,
      description: 'Member Bot ID on that Host device.',
    },
  },
  required: ['deviceId', 'botId'],
  additionalProperties: false,
};

const MEMBERS_SCHEMA = {
  type: 'array',
  items: MEMBER_SCHEMA,
  minItems: 2,
  maxItems: 64,
  description: 'Complete list of 2-64 distinct room members ({ deviceId, botId }).',
};

const SCOPE_LIST_CURSOR_SCHEMA = {
  type: 'object',
  properties: {
    deviceId: ID_SCHEMA,
    afterScopeId: ID_SCHEMA,
  },
  required: ['deviceId', 'afterScopeId'],
  additionalProperties: false,
  description: 'Opaque continuation cursor returned as nextCursor by a prior collaboration_list_scopes call.',
};

const REPLICA_LIST_CURSOR_SCHEMA = {
  type: 'object',
  properties: {
    deviceId: ID_SCHEMA,
    scopeId: ID_SCHEMA,
    afterPeerDeviceId: ID_SCHEMA,
    afterSourceDeviceId: ID_SCHEMA,
    afterStreamId: ID_SCHEMA,
  },
  required: ['deviceId', 'scopeId', 'afterPeerDeviceId', 'afterSourceDeviceId', 'afterStreamId'],
  additionalProperties: false,
  description: 'Opaque continuation cursor returned as nextCursor by a prior collaboration_list_scope_replicas call.',
};

const SCOPE_HISTORY_CURSOR_SCHEMA = {
  type: 'object',
  properties: {
    deviceId: ID_SCHEMA,
    kind: {
      type: 'string',
      enum: ['history', 'history-before'],
      description: 'Cursor direction: "history" for ascending pagination or tailCursor, "history-before" for descending pagination.',
    },
    key: ID_SCHEMA,
    afterLocalId: {
      type: 'integer',
      minimum: 1,
      description: 'Required when kind is "history".',
    },
    beforeLocalId: {
      type: 'integer',
      minimum: 1,
      description: 'Required when kind is "history-before".',
    },
  },
  required: ['deviceId', 'kind', 'key'],
  additionalProperties: false,
  description: 'Opaque continuation cursor returned as nextCursor or tailCursor by a prior collaboration_list_scope_history call.',
};

const ATTACHMENT_ID_SCHEMA = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
  minLength: 64,
  maxLength: 64,
  description: 'Lowercase 64-character SHA-256 ID of an image attachment already uploaded on the target Host.',
};

export const operations = Object.freeze([
  // ── Scope / Room Queries (read-only) ──────────────────────────────────────
  defineOperation({
    name: 'collaboration_list_scopes',
    description:
      'List active installed collaboration scopes (rooms and DMs) on a target Host device with bounded pagination (up to 50 items per page, 50 KiB response cap). For Bot callers, private DM scopes where the calling Bot is not a member are excluded.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      limit: PAGE_LIMIT_SCHEMA,
      cursor: SCOPE_LIST_CURSOR_SCHEMA,
    },
    required: ['deviceId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_get_scope',
    description:
      'Inspect one installed collaboration scope on a target Host, including scope kind, current revision (for CAS writes), members, room title, deletedAt tombstone, authorityDeviceId, isAuthority, and authority delivery receipts. For Bot callers, non-member DM scopes are forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
    },
    required: ['deviceId', 'scopeId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_list_scope_replicas',
    description:
      'List peer replica synchronization streams for a scope on a target Host with bounded pagination. For Bot callers, non-member DM scopes are forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
      limit: PAGE_LIMIT_SCHEMA,
      cursor: REPLICA_LIST_CURSOR_SCHEMA,
    },
    required: ['deviceId', 'scopeId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_list_scope_history',
    description:
      'Read one bounded page of messages from a scope ledger on a target Host (1-50 messages per page, bounded text previews, 50 KiB response cap; never returns unbounded history). Supports ascending or descending order with exact nextCursor and tailCursor. Bot callers must be a member of the scope.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
      order: {
        type: 'string',
        enum: ['ascending', 'descending'],
        description: 'Page order: "ascending" (oldest first, default) or "descending" (newest first).',
      },
      limit: PAGE_LIMIT_SCHEMA,
      cursor: SCOPE_HISTORY_CURSOR_SCHEMA,
    },
    required: ['deviceId', 'scopeId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_get_scope_message',
    description:
      'Read one stored message by messageId within a specific scope on a target Host, with bounded text preview metadata. Bot callers must be a member of the scope.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
      messageId: {
        ...ID_SCHEMA,
        description: 'Stored message ID within scopeId.',
      },
    },
    required: ['deviceId', 'scopeId', 'messageId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_get_scope_message_delivery',
    description:
      'Inspect per-device delivery and ACK receipt status for a scope message on its sourceDeviceId Host. Host rejects queries sent to non-source devices. Bot callers must be a member of the scope.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Source Host device ID that originally published the message.',
      },
      scopeId: SCOPE_ID_SCHEMA,
      messageId: {
        ...ID_SCHEMA,
        description: 'Stored message ID whose per-device delivery status is requested.',
      },
    },
    required: ['deviceId', 'scopeId', 'messageId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_get_work_activity',
    description:
      'Inspect a Bot\'s current collaboration work activity state (stopped, error, active pending work, membership) for a specific scope on its Host. For Bot callers, non-member DM scopes are forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
    },
    required: ['deviceId', 'botId', 'scopeId'],
    readOnly: true,
    destructive: false,
  }),

  // ── Room Lifecycle Management (write / destructive) ───────────────────────
  defineOperation({
    name: 'collaboration_create_room',
    description:
      'Create a managed group chat room (kind: "room") with deviceId as its immutable authority Host. The authority Host must have at least one local member Bot in members (2-64 distinct Bots). Supports idempotent retries via requestId. Receipt confirms local creation only, not remote peer ACK or started work.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Authority Host device ID for the new room (must include at least one local member in members).',
      },
      members: MEMBERS_SCHEMA,
      title: {
        type: 'string',
        maxLength: 120,
        description: 'Optional room display name (up to 120 characters).',
      },
      requestId: REQUEST_ID_SCHEMA,
    },
    required: ['deviceId', 'members'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_rename_room',
    description:
      'Rename a managed room on its authority Host using optimistic CAS (expectedRevision) and requestId idempotency. Updates only the room title without modifying members; pass an empty string "" to clear the custom title back to the default member-derived name. Only room scopes may be renamed.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Authority Host device ID of the room.',
      },
      scopeId: SCOPE_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      title: {
        type: 'string',
        maxLength: 120,
        description: 'New room title (up to 120 characters), or "" to clear back to the default member-derived name.',
      },
      requestId: REQUEST_ID_SCHEMA,
    },
    required: ['deviceId', 'scopeId', 'expectedRevision', 'title'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_update_room_members',
    description:
      'Replace the member list of a managed room (2-64 distinct Bots) on its authority Host using optimistic CAS (expectedRevision) and requestId idempotency. Read collaboration_get_scope first for the latest revision and members; updates only members without modifying title. Only room scopes support membership updates (DM participants are immutable).',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Authority Host device ID of the room.',
      },
      scopeId: SCOPE_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      members: MEMBERS_SCHEMA,
      requestId: REQUEST_ID_SCHEMA,
    },
    required: ['deviceId', 'scopeId', 'expectedRevision', 'members'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_leave_room',
    description:
      'Remove a member Bot from a managed room on its authority Host via CAS updateScope (no standalone leaveScope Host primitive exists). For Bot callers, this always removes the calling Bot itself (derived from trusted actor identity). For OAuth callers, member ({ deviceId, botId }) is required. Rooms must keep at least 2 members; dissolve a 2-member room with collaboration_delete_room instead.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Authority Host device ID of the room.',
      },
      scopeId: SCOPE_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      member: {
        ...MEMBER_SCHEMA,
        description: 'Required for OAuth callers to specify which Bot leaves. For Bot callers, omit or match the calling Bot itself.',
      },
      requestId: REQUEST_ID_SCHEMA,
    },
    required: ['deviceId', 'scopeId', 'expectedRevision'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'collaboration_delete_room',
    description:
      'Permanently dissolve (tombstone) a managed room on its authority Host using optimistic CAS (expectedRevision) and requestId idempotency. Stops bound room collaboration work and propagates the tombstone revision to peers; historical ledger messages remain readable but no further updates or messages are accepted. Only room scopes may be dissolved.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Authority Host device ID of the room.',
      },
      scopeId: SCOPE_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      requestId: REQUEST_ID_SCHEMA,
    },
    required: ['deviceId', 'scopeId', 'expectedRevision'],
    readOnly: false,
    destructive: true,
  }),

  // ── Owner-Delegated Room Message Publish (OAuth-only, room-only) ──────────
  defineOperation({
    name: 'collaboration_publish_room_message',
    description:
      'Publish an owner-delegated user message (author: { kind: "user" }, category: "public") to an explicit room scope (room-only; DMs are rejected by protocol) through a Host that has a member Bot in that room. Restricted strictly to authorized OAuth callers acting on behalf of the owner; Bot callers are rejected and must use their local send_to tool inside their own turn so Bot identity and reply linkage are preserved. Rejects arbitrary authors, Bot impersonation, and file-path attachments. Always prepends a fixed provenance header "[Owner-delegated via OAuth: <clientId>]\\n" to published text so room members see the exact source. Returns only a local stored receipt (not proof of remote delivery or Bot replies); inspect collaboration_get_scope_message_delivery for peer ACK status.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Online Host device ID that has at least one member Bot in the target room.',
      },
      scopeId: {
        ...SCOPE_ID_SCHEMA,
        description: 'Explicit target room scope ID (required; never inferred).',
      },
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 262144,
        description: 'Plain message text to publish as an owner-delegated room user message (no arbitrary file-path attachments).',
      },
      messageId: {
        ...ID_SCHEMA,
        description: 'Optional idempotency key for this publication. Reuse on uncertain retries; generated automatically if omitted.',
      },
      replyTo: {
        ...ID_SCHEMA,
        description: 'Optional messageId of an existing stored message in the same room.',
      },
    },
    required: ['deviceId', 'scopeId', 'text'],
    readOnly: false,
    destructive: false,
  }),

  // ── Primary Session Queue & Edit Controls (OAuth-only) ────────────────────
  defineOperation({
    name: 'collaboration_withdraw_queued',
    description:
      'Withdraw one queued primary-chat user message (when requestId is provided) or all unplaced queued primary-chat user messages (when requestId is omitted) for a Bot without stopping its currently active turn. Preserves Host checks (already placed/done turns are untouched). Restricted to owner-delegated OAuth callers.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      requestId: {
        ...ID_SCHEMA,
        description: 'Optional queued submission requestId to withdraw. Omit to withdraw all unplaced queued primary user messages.',
      },
    },
    required: ['deviceId', 'botId'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'collaboration_steer_queued',
    description:
      'Promote an already-queued primary-chat user message (requestId) to steer delivery so the Host injects it at the next post-tools boundary of the active turn without reordering remaining follow-ups. Preserves Host checks (BOT_ARCHIVED, SUBMISSION_NOT_FOUND, already_placed). Restricted to owner-delegated OAuth callers.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      requestId: {
        ...ID_SCHEMA,
        description: 'Queued primary user submission requestId to promote to steer.',
      },
    },
    required: ['deviceId', 'botId', 'requestId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'collaboration_edit_message',
    description:
      'Edit a historical primary-chat user message (entryId) of an idle, non-archived Bot, fork the conversation before that entry, and enqueue regeneration as a new turn. Preserves all Host checks (RUNTIME_BUSY, BOT_ARCHIVED, primary user entry only, post-reset only, model vision checks). Optional attachments accept only already-uploaded 64-character SHA-256 Host attachment IDs — arbitrary file paths are rejected. Restricted to owner-delegated OAuth callers.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      entryId: {
        type: 'integer',
        minimum: 1,
        description: 'Positive integer entry ID of the historical primary user message to edit.',
      },
      text: {
        type: 'string',
        maxLength: 262144,
        description: 'Replacement message text (must be non-blank unless attachments are provided).',
      },
      attachments: {
        type: 'array',
        items: ATTACHMENT_ID_SCHEMA,
        minItems: 1,
        maxItems: 16,
        description: 'Optional list of 1-16 already-uploaded Host attachment IDs (lowercase 64-hex SHA-256). Arbitrary file paths are not allowed.',
      },
      requestId: REQUEST_ID_SCHEMA,
    },
    required: ['deviceId', 'botId', 'entryId', 'text'],
    readOnly: false,
    destructive: true,
  }),

  // ── Collaboration Work Stop / Resume Controls ─────────────────────────────
  defineOperation({
    name: 'collaboration_stop_work',
    description:
      'Stop a Bot\'s active or pending collaboration work in a specific scope and mark that scope\'s work as persistently stopped until resumed. Preserves all Host checks (BOT_NOT_FOUND, SCOPE_NOT_FOUND, SCOPE_DELETED, SCOPE_FORBIDDEN). Bot callers cannot stop themselves mid-turn and cannot access non-member DM scopes.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
    },
    required: ['deviceId', 'botId', 'scopeId'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'collaboration_resume_work',
    description:
      'Clear persistent stopped/error state and resume a Bot\'s collaboration work in a specific scope. Preserves all Host checks (BOT_NOT_FOUND, SCOPE_NOT_FOUND, SCOPE_DELETED, SCOPE_FORBIDDEN including current scope membership). For Bot callers, non-member DM scopes are forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      scopeId: SCOPE_ID_SCHEMA,
    },
    required: ['deviceId', 'botId', 'scopeId'],
    readOnly: false,
    destructive: false,
  }),
]);
