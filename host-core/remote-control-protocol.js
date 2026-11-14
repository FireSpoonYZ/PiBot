// host-core/remote-control-protocol.js
// Module 9 pure boundary parsers for authenticated remote Host JSON control.
// Module 14 adds v2 work/scope/memory methods and the v1/v2 negotiation
// surface; frame readers stay directional with no ws/network/Runtime/storage.
// The managed-extension/SOUL methods are additive v2 and share the fixed
// per-hop memory timeout budgets exported below.
// The unified Shower six (status/create/frame/input/takeover/release) are also
// additive v2 and normalize through shower-protocol so every platform agrees.

import { messageError, assertId, normalizeScopeHistoryOptions } from './message-protocol.js';
import { normalizeBotBoardParams } from './bot-board-protocol.js';
import { normalizeSkillReviewInput } from './skill-review-protocol.js';
import {
  normalizeScopeListOptions,
  normalizeScopeCreate,
  normalizeScopeUpdate,
  normalizeScopeDelete,
  normalizeUserMessage,
  normalizeReplicaListOptions,
} from './scope-protocol.js';
import {
  normalizeMemoryStatus,
  normalizeMemoryQuery,
  normalizeMemoryRetain,
  normalizeMemoryLookup,
  normalizeMemorySource,
  normalizeMemoryCorrection,
  normalizeMemoryRetry,
} from './hindsight-protocol.js';
import {
  SHOWER_ERROR_CODES,
  normalizeShowerTarget,
  normalizeShowerCreate,
  normalizeShowerInput,
  normalizeShowerFrameLimits,
  normalizeShowerSessionId,
} from './shower-protocol.js';
import { normalizeScheduleControlParams } from './schedule-protocol.js';
import { normalizeBotFileChunk } from './bot-file-protocol.js';
import { normalizeVaultControl, VAULT_ERROR_CODES } from './vault-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MAX_SOUL_BYTES = 65536; // 64 KiB public SOUL.md text limit
const MAX_SUBMIT_ATTACHMENTS = 16;
const MAX_ATTACHMENT_NAME_BYTES = 256;
const MAX_ATTACHMENT_BYTES = 16777216; // 16 MiB decoded image payload
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

export const MAX_CONTROL_JSON_BYTES = 33554432; // 32 MiB, params/result JSON UTF-8 bytes
export const CONTROL_TIMEOUT_MS = 20000;
export const CONTROL_CLIENT_TIMEOUT_MS = 25000;
export const CONTROL_MAX_CLIENT_CALLS = 8;
export const CONTROL_MAX_HOST_CALLS = 8;
export const CONTROL_MAX_PENDING = 128;

// Hindsight memory calls are the only slow RPCs: the backend request cap is
// 120s (HINDSIGHT_MAX_TIMEOUT_MS, reflect), so each hop gets a fixed budget that
// strictly contains the inner one and the 150s native outer deadline: relay
// execution -> 135s, remote/local client wait -> 140s, desktop broker wrapper
// -> 145s, and the local control HTTP socket must stay idle >=130s.
export const CONTROL_MEMORY_DEADLINE_MS = 135000;
export const CONTROL_MEMORY_CLIENT_DEADLINE_MS = 140000;
export const CONTROL_MEMORY_BROKER_DEADLINE_MS = 145000;
export const MEMORY_HTTP_INACTIVITY_MS = 130000;

const MEMORY_METHODS = new Set([
  'memoryStatus',
  'recallMemory',
  'reflectMemory',
  'retainMemory',
  'getMemory',
  'getMemorySource',
  'correctMemory',
  'retryMemory',
]);

/** True only for the eight Hindsight memory control methods. */
export function isMemoryControlMethod(method) {
  return MEMORY_METHODS.has(method);
}

// Slow RPCs share the memory timeout chain: one manual compaction waits on a
// model summarization request and must not be cut off by the 20s/25s default.
function isSlowControlMethod(method) {
  return method === 'compact' || method === 'vaultControl' || isMemoryControlMethod(method);
}

/** Relay/target execution deadline for one control method. */
export function controlMethodTimeoutMs(method) {
  return isSlowControlMethod(method) ? CONTROL_MEMORY_DEADLINE_MS : CONTROL_TIMEOUT_MS;
}

/** Remote/local control client call deadline for one control method. */
export function controlClientTimeoutMs(method) {
  return isSlowControlMethod(method) ? CONTROL_MEMORY_CLIENT_DEADLINE_MS : CONTROL_CLIENT_TIMEOUT_MS;
}

/** Desktop broker wrapper deadline for one control method. */
export function controlBrokerTimeoutMs(method) {
  return isSlowControlMethod(method) ? CONTROL_MEMORY_BROKER_DEADLINE_MS : CONTROL_CLIENT_TIMEOUT_MS;
}

// Legacy v1 method table (unchanged wire shape).
export const CONTROL_V1_METHODS = Object.freeze([
  'getHostInfo',
  'listBots',
  'createBot',
  'getBot',
  'findByRequest',
  'submit',
  'getSubmission',
  'history',
  'abort',
  'contextStatus',
]);

// Fixed v2 additions (module 14, plus the managed-extension/SOUL additions and
// the unified Shower six).
const CONTROL_V2_METHODS = Object.freeze([
  'vaultControl',
  'getServiceStatus',
  'updateBotProfile',
  'setPrimaryBot',
  'archiveBot',
  'unarchiveBot',
  'deleteBot',
  'getModelCatalog',
  'getWorkContext',
  'syncWorkContext',
  'workHistory',
  'workContextStatus',
  'getWorkActivity',
  'stopWork',
  'resumeWork',
  'listScopeStates',
  'createScope',
  'getScopeState',
  'updateScope',
  'deleteScope',
  'publishUserMessage',
  'listScopeReplicas',
  'scopeHistory',
  'getScopeMessage',
  'getScopeMessageDelivery',
  'memoryStatus',
  'recallMemory',
  'reflectMemory',
  'retainMemory',
  'getMemory',
  'getMemorySource',
  'correctMemory',
  'retryMemory',
  'getBotSoul',
  'setBotSoul',
  'discoverProviderModels',
  'validateCenterProvider',
  'discoverCenterProviderModels',
  'callCapabilityAction',
  'getShowerStatus',
  'createShowerSession',
  'getShowerFrame',
  'sendShowerInput',
  'takeoverShower',
  'releaseShowerSession',
  'getBotBoard',
  // 对话命令：/clear 与 /compact 是 additive v2，只接 {botId}。
  'clearHistory',
  'compact',
  // 流控制与历史编辑：撤回排队消息、将排队项提升为立即打断发送（steer）、编辑历史消息重生成。
  'withdrawQueued',
  'steerQueued',
  'editMessage',
  'scheduleTask',
  // 图片附件：上传与读取是 additive v2；submit 通过 attachments 引用已上传 ID。
  'uploadAttachment',
  'getAttachment',
  'putBotFileChunk',
  // Bot 学习管理（后台 review/learn/curate 作业）：params {botId,input}。
  'manageBotLearning',
  'reviewBotSkills',
  'manageTasks',
]);

export const CONTROL_METHODS = Object.freeze([...CONTROL_V1_METHODS, ...CONTROL_V2_METHODS]);

/**
 * Wire version of a control method: 1 for the legacy ten, 2 for the fixed
 * v2 additions. Unknown methods throw INVALID_ARGUMENT.
 */
export function controlMethodVersion(method) {
  if (CONTROL_V1_METHODS.includes(method)) return 1;
  if (CONTROL_V2_METHODS.includes(method)) return 2;
  throw invalid('unknown control method');
}

// Never mutate this Set; it is the complete wire error code table.
export const CONTROL_ERROR_CODES = new Set([
  'INVALID_ARGUMENT',
  'CENTER_OFFLINE',
  'INVALID_CWD',
  'REQUEST_CONFLICT',
  'REVISION_CONFLICT',
  'NOT_FOUND',
  'FORBIDDEN',
  'BOT_NOT_FOUND',
  'BOT_REQUEST_NOT_FOUND',
  'SUBMISSION_NOT_FOUND',
  'TASK_NOT_FOUND',
  'MODEL_REQUIRED',
  'MODEL_NOT_FOUND',
  'COMPACTION_FAILED',
  'RUNTIME_BUSY',
  'PRIMARY_BOT_PROTECTED',
  'BOT_ARCHIVED',
  'INVALID_STATE',
  'UNSUPPORTED_SCHEMA',
  'INTERNAL',
  'REQUEST_TOO_LARGE',
  'INVALID_UTF8',
  'INVALID_JSON',
  'INVALID_BODY',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNAUTHORIZED',
  'ORIGIN_FORBIDDEN',
  'NETWORK',
  'BAD_RESPONSE',
  'OFFLINE',
  'BACKPRESSURE',
  'RPC_BUSY',
  'TIMEOUT',
  'DISCONNECTED',
  'CANCELLED',
  'NOT_CONNECTED',
  'REVOKED',
  'BAD_FRAME',
  'CONNECT_FAILED',
  'CONTROL_UNAVAILABLE',
  'CONTROL_IDENTITY_MISMATCH',
  'CONTROL_UNAUTHORIZED',
  'RESPONSE_TOO_LARGE',
  'SCOPE_NOT_FOUND',
  'SCOPE_FORBIDDEN',
  'SCOPE_UNMANAGED',
  'SCOPE_AUTHORITY_REQUIRED',
  'WORK_CONTEXT_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'DELIVERY_NOT_FOUND',
  'STORE_FAILED',
  'STALE_INPUT',
  'WORK_STOPPED',
  'WORK_CONTEXT_INACTIVE',
  'CONTEXT_LIMIT',
  'WORK_GENERATION_FAILED',
  'HINDSIGHT_NOT_CONFIGURED',
  'HINDSIGHT_SHARED_DISABLED',
  'HINDSIGHT_CLOSED',
  'HINDSIGHT_UNAVAILABLE',
  'HINDSIGHT_AUTH_FAILED',
  'HINDSIGHT_NOT_FOUND',
  'HINDSIGHT_CONFLICT',
  'HINDSIGHT_INVALID_REQUEST',
  'HINDSIGHT_PROTOCOL_ERROR',
  'HINDSIGHT_STORE_FAILED',
  'HINDSIGHT_BINDING_MISMATCH',
  'EXTENSION_DISABLED',
  'EXTENSION_READ_ONLY',
  'ATTACHMENT_NOT_FOUND',
  'MODEL_NO_VISION',
  // Per-turn Center admission failures (contract §7 wire errors).
  'TURN_SET_CHANGED',
  'TURN_SYNC_FAILED',
  'TURN_RECOVERY_REQUIRED',
  ...SHOWER_ERROR_CODES,
  ...VAULT_ERROR_CODES,
]);

// Failure outcome semantics across the control protocol.
export const CONTROL_OUTCOMES = new Set(['not-sent', 'unconfirmed', 'responded']);

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

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim() === '') {
    throw invalid(`${name} must be a well-formed non-empty string`);
  }
}

// 附件 ID 是解码图像字节的小写 hex SHA-256；与通用 assertId 不同，严格 64hex。
function assertAttachmentId(value, name) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw invalid(`${name} must be a lowercase 64-character hex SHA-256`);
  }
}

function assertBase64(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw invalid(`${name} must be canonical base64`);
  }
}

// submit 附件引用：至多 16 个有序 64hex ID。
function normalizeAttachmentIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SUBMIT_ATTACHMENTS) {
    throw invalid(`attachments must be an array of 1-${MAX_SUBMIT_ATTACHMENTS} attachment IDs`);
  }
  const out = [];
  for (const item of value) {
    assertAttachmentId(item, 'attachments[]');
    out.push(item);
  }
  return out;
}

// Unified Shower wire params stay flat ({botId,scopeId?,...}) to match
// RemoteControlMethodMap; shower-protocol owns every value check.
function showerTargetParams(params) {
  return normalizeShowerTarget({ botId: params.botId, scopeId: params.scopeId });
}

// Params normalize per method; unknown keys, missing required fields and
// malformed values are rejected. cwd/role/text are only checked as strings;
// no source-device resolution happens here.
function normalizeControlParams(method, params) {
  switch (method) {
    case 'getBotBoard':
      return normalizeBotBoardParams(params);
    case 'getHostInfo':
    case 'getServiceStatus':
    case 'listBots': {
      rejectUnknownFields(params, new Set(), 'params');
      return {};
    }
    case 'createBot': {
      rejectUnknownFields(params, new Set(['requestId', 'role', 'cwd', 'modelRef', 'description', 'makePrimary']), 'params');
      assertId(params.requestId, 'requestId');
      assertNonEmptyString(params.role, 'role');
      if (params.cwd !== undefined) assertNonEmptyString(params.cwd, 'cwd');
      if (params.description !== undefined && (typeof params.description !== 'string' || params.description.length > 2000)) throw invalid('description must be a string of at most 2000 characters');
      if (params.makePrimary !== undefined && typeof params.makePrimary !== 'boolean') throw invalid('makePrimary must be a boolean');
      let modelRef = null;
      if (params.modelRef !== undefined && params.modelRef !== null) {
        assertNonEmptyString(params.modelRef, 'modelRef');
        modelRef = params.modelRef;
      }
      return {
        requestId: params.requestId,
        role: params.role,
        cwd: params.cwd,
        modelRef,
        description: params.description,
        ...(params.makePrimary !== undefined ? { makePrimary: params.makePrimary } : {}),
      };
    }
    case 'updateBotProfile': {
      rejectUnknownFields(params, new Set(['botId', 'name', 'description']), 'params');
      assertId(params.botId, 'botId');
      if (params.name !== undefined && (typeof params.name !== 'string' || params.name.trim().length < 1 || params.name.trim().length > 120)) throw invalid('name must be 1 to 120 non-blank characters');
      if (params.description !== undefined && (typeof params.description !== 'string' || params.description.length > 2000)) throw invalid('description must be a string of at most 2000 characters');
      return { botId: params.botId, name: params.name, description: params.description };
    }
    case 'getBot':
    case 'setPrimaryBot':
    case 'archiveBot':
    case 'unarchiveBot':
    case 'deleteBot':
    case 'abort':
    case 'contextStatus':
    case 'clearHistory':
    case 'compact': {
      rejectUnknownFields(params, new Set(['botId']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId };
    }
    case 'findByRequest': {
      rejectUnknownFields(params, new Set(['requestId']), 'params');
      assertId(params.requestId, 'requestId');
      return { requestId: params.requestId };
    }
    case 'submit': {
      rejectUnknownFields(params, new Set(['botId', 'requestId', 'text', 'attachments', 'delivery']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.requestId, 'requestId');
      if (params.delivery !== undefined && params.delivery !== 'followUp' && params.delivery !== 'steer') {
        throw invalid("delivery must be 'followUp' or 'steer'");
      }
      const attachments = params.attachments === undefined
        ? null
        : normalizeAttachmentIds(params.attachments);
      // 纯文本提交要求非空文本；带附件时允许空文本（UI 的只发图片消息）。
      if (attachments === null) assertNonEmptyString(params.text, 'text');
      else if (typeof params.text !== 'string' || !params.text.isWellFormed()) {
        throw invalid('text must be a well-formed string');
      }
      const normalized = { botId: params.botId, requestId: params.requestId, text: params.text };
      if (attachments !== null) normalized.attachments = attachments;
      if (params.delivery !== undefined) normalized.delivery = params.delivery;
      return normalized;
    }
    case 'withdrawQueued': {
      rejectUnknownFields(params, new Set(['botId', 'requestId']), 'params');
      assertId(params.botId, 'botId');
      const normalized = { botId: params.botId };
      if (params.requestId !== undefined && params.requestId !== null) {
        assertId(params.requestId, 'requestId');
        normalized.requestId = params.requestId;
      }
      return normalized;
    }
    case 'steerQueued': {
      rejectUnknownFields(params, new Set(['botId', 'requestId']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.requestId, 'requestId');
      return { botId: params.botId, requestId: params.requestId };
    }
    case 'editMessage': {
      rejectUnknownFields(params, new Set(['botId', 'entryId', 'requestId', 'text', 'attachments']), 'params');
      assertId(params.botId, 'botId');
      if (!Number.isSafeInteger(params.entryId) || params.entryId < 1) {
        throw invalid('entryId must be a positive safe integer');
      }
      assertId(params.requestId, 'requestId');
      const attachments = params.attachments === undefined
        ? null
        : normalizeAttachmentIds(params.attachments);
      if (attachments === null) assertNonEmptyString(params.text, 'text');
      else if (typeof params.text !== 'string' || !params.text.isWellFormed()) {
        throw invalid('text must be a well-formed string');
      }
      const normalized = {
        botId: params.botId,
        entryId: params.entryId,
        requestId: params.requestId,
        text: params.text,
      };
      if (attachments !== null) normalized.attachments = attachments;
      return normalized;
    }
    case 'getSubmission': {
      rejectUnknownFields(params, new Set(['botId', 'requestId']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.requestId, 'requestId');
      return { botId: params.botId, requestId: params.requestId };
    }
    case 'history': {
      rejectUnknownFields(params, new Set(['botId', 'limit', 'cursor', 'chunked']), 'params');
      assertId(params.botId, 'botId');
      const normalized = { botId: params.botId, cursor: null };
      if (params.chunked !== undefined) {
        if (typeof params.chunked !== 'boolean') throw invalid('chunked must be a boolean');
        normalized.chunked = params.chunked;
      }
      if (params.limit !== undefined) {
        if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) {
          throw invalid('limit must be a positive integer between 1 and 200');
        }
        normalized.limit = params.limit;
      }
      if (params.cursor !== undefined && params.cursor !== null) {
        if (!isPlainObject(params.cursor)) {
          throw invalid('cursor must be a plain JSON object or null');
        }
        normalized.cursor = params.cursor;
      }
      return normalized;
    }
    case 'getModelCatalog': {
      rejectUnknownFields(params, new Set(), 'params');
      return {};
    }
    case 'getWorkContext':
    case 'workContextStatus':
    case 'getWorkActivity':
    case 'stopWork':
    case 'resumeWork': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.scopeId, 'scopeId');
      return { botId: params.botId, scopeId: params.scopeId };
    }
    case 'syncWorkContext': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId', 'input']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.scopeId, 'scopeId');
      let input = {};
      if (params.input !== undefined) {
        if (!isPlainObject(params.input)) {
          throw invalid('input must be an object');
        }
        rejectUnknownFields(params.input, new Set(['limit']), 'sync input');
        if (params.input.limit !== undefined) {
          if (!Number.isSafeInteger(params.input.limit) || params.input.limit < 1 || params.input.limit > 200) {
            throw invalid('limit must be a positive integer between 1 and 200');
          }
          input = { limit: params.input.limit };
        }
      }
      return { botId: params.botId, scopeId: params.scopeId, input };
    }
    case 'workHistory': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId', 'limit', 'cursor']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.scopeId, 'scopeId');
      const normalized = { botId: params.botId, scopeId: params.scopeId, cursor: null };
      if (params.limit !== undefined) {
        if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) {
          throw invalid('limit must be a positive integer between 1 and 200');
        }
        normalized.limit = params.limit;
      }
      if (params.cursor !== undefined && params.cursor !== null) {
        if (!isPlainObject(params.cursor)) {
          throw invalid('cursor must be a plain JSON object or null');
        }
        rejectUnknownFields(params.cursor, new Set(['conversationId', 'position']), 'cursor');
        assertId(params.cursor.conversationId, 'cursor.conversationId');
        if (!isPlainObject(params.cursor.position)) {
          throw invalid('cursor.position must be a plain JSON object');
        }
        normalized.cursor = { conversationId: params.cursor.conversationId, position: params.cursor.position };
      }
      return normalized;
    }
    case 'listScopeStates': {
      rejectUnknownFields(params, new Set(['limit', 'cursor']), 'params');
      return normalizeScopeListOptions(params);
    }
    case 'createScope': {
      rejectUnknownFields(params, new Set(['input']), 'params');
      return { input: normalizeScopeCreate(params.input) };
    }
    case 'getScopeState': {
      rejectUnknownFields(params, new Set(['scopeId']), 'params');
      assertId(params.scopeId, 'scopeId');
      return { scopeId: params.scopeId };
    }
    case 'updateScope': {
      rejectUnknownFields(params, new Set(['scopeId', 'input']), 'params');
      assertId(params.scopeId, 'scopeId');
      return { scopeId: params.scopeId, input: normalizeScopeUpdate(params.input) };
    }
    case 'deleteScope': {
      rejectUnknownFields(params, new Set(['scopeId', 'input']), 'params');
      assertId(params.scopeId, 'scopeId');
      return { scopeId: params.scopeId, input: normalizeScopeDelete(params.input) };
    }
    case 'publishUserMessage': {
      rejectUnknownFields(params, new Set(['scopeId', 'input']), 'params');
      assertId(params.scopeId, 'scopeId');
      normalizeUserMessage(params.scopeId, params.input); // validate; never echo normalized author/category/scopeId
      const input = { messageId: params.input.messageId, text: params.input.text };
      if (params.input.replyTo !== undefined) input.replyTo = params.input.replyTo;
      return { scopeId: params.scopeId, input };
    }
    case 'listScopeReplicas': {
      rejectUnknownFields(params, new Set(['scopeId', 'limit', 'cursor']), 'params');
      assertId(params.scopeId, 'scopeId');
      return { scopeId: params.scopeId, ...normalizeReplicaListOptions({ limit: params.limit, cursor: params.cursor }) };
    }
    case 'scopeHistory': {
      rejectUnknownFields(params, new Set(['scopeId', 'limit', 'cursor', 'order']), 'params');
      assertId(params.scopeId, 'scopeId');
      return {
        scopeId: params.scopeId,
        ...normalizeScopeHistoryOptions({ limit: params.limit, cursor: params.cursor, order: params.order }),
      };
    }
    case 'getScopeMessage':
    case 'getScopeMessageDelivery': {
      rejectUnknownFields(params, new Set(['scopeId', 'messageId']), 'params');
      assertId(params.scopeId, 'scopeId');
      assertId(params.messageId, 'messageId');
      return { scopeId: params.scopeId, messageId: params.messageId };
    }
    case 'memoryStatus': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      const statusInput = params.input === undefined ? {} : params.input; // explicit null stays invalid
      return { botId: params.botId, input: normalizeMemoryStatus(statusInput) };
    }
    case 'recallMemory':
    case 'reflectMemory': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeMemoryQuery(params.input) };
    }
    case 'retainMemory': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeMemoryRetain(params.input) };
    }
    case 'getMemory': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeMemoryLookup(params.input) };
    }
    case 'getMemorySource': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeMemorySource(params.input) };
    }
    case 'correctMemory': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeMemoryCorrection(params.input) };
    }
    case 'retryMemory': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeMemoryRetry(params.input) };
    }
    case 'getBotSoul': {
      rejectUnknownFields(params, new Set(['botId']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId };
    }
    case 'setBotSoul': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      if (!isPlainObject(params.input)) throw invalid('input must be an object');
      rejectUnknownFields(params.input, new Set(['expectedRevision', 'text', 'self']), 'input');
      if (typeof params.input.expectedRevision !== 'string' || !SHA256_HEX_RE.test(params.input.expectedRevision)) {
        throw invalid('expectedRevision must be a lowercase 64-character hex SHA-256');
      }
      if (typeof params.input.text !== 'string' || !params.input.text.isWellFormed()) {
        throw invalid('text must be well-formed UTF-8 text');
      }
      if (Buffer.byteLength(params.input.text, 'utf8') > MAX_SOUL_BYTES) {
        throw invalid('text exceeds the 64 KiB SOUL limit');
      }
      return {
        botId: params.botId,
        input: {
          expectedRevision: params.input.expectedRevision,
          text: params.input.text,
          ...(params.input.self === true ? { self: true } : {}),
        },
      };
    }
    case 'validateCenterProvider':
    case 'discoverCenterProviderModels': {
      rejectUnknownFields(params, new Set(['provider', 'models', 'credential']), 'params');
      if (!isPlainObject(params.provider) || !Array.isArray(params.models) ||
          (params.credential !== undefined && typeof params.credential !== 'string')) throw invalid('invalid provider probe');
      return params;
    }
    case 'callCapabilityAction': {
      rejectUnknownFields(params, new Set(['installationId', 'action', 'request']), 'params');
      assertId(params.installationId, 'installationId');
      assertNonEmptyString(params.action, 'action');
      if (!isPlainObject(params.request)) throw invalid('invalid action request');
      return params;
    }
    case 'discoverProviderModels': {
      rejectUnknownFields(params, new Set(['input']), 'params');
      if (!isPlainObject(params.input)) throw invalid('input must be an object');
      rejectUnknownFields(
        params.input,
        new Set(['baseUrl', 'apiKey', 'apiKeyEnv', 'api', 'syncEnvOnly']),
        'input',
      );
      const out = {};
      if (typeof params.input.baseUrl === 'string') out.baseUrl = params.input.baseUrl;
      if (typeof params.input.apiKey === 'string') out.apiKey = params.input.apiKey;
      if (typeof params.input.apiKeyEnv === 'string') out.apiKeyEnv = params.input.apiKeyEnv;
      if (typeof params.input.api === 'string') out.api = params.input.api;
      if (typeof params.input.syncEnvOnly === 'boolean') out.syncEnvOnly = params.input.syncEnvOnly;
      return {
        input: out,
      };
    }
    case 'vaultControl': return normalizeVaultControl(params);
    case 'getShowerStatus': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId']), 'params');
      return showerTargetParams(params);
    }
    case 'createShowerSession': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId', 'input']), 'params');
      return { ...showerTargetParams(params), input: normalizeShowerCreate(params.input) };
    }
    case 'getShowerFrame': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId', 'sessionId', 'limits']), 'params');
      return {
        ...showerTargetParams(params),
        sessionId: normalizeShowerSessionId(params.sessionId),
        limits: normalizeShowerFrameLimits(params.limits),
      };
    }
    case 'sendShowerInput': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId', 'sessionId', 'input']), 'params');
      return {
        ...showerTargetParams(params),
        sessionId: normalizeShowerSessionId(params.sessionId),
        input: normalizeShowerInput(params.input),
      };
    }
    case 'takeoverShower':
    case 'releaseShowerSession': {
      rejectUnknownFields(params, new Set(['botId', 'scopeId', 'sessionId']), 'params');
      return { ...showerTargetParams(params), sessionId: normalizeShowerSessionId(params.sessionId) };
    }
    case 'scheduleTask': {
      return normalizeScheduleControlParams(params);
    }
    case 'putBotFileChunk':
      return normalizeBotFileChunk(params);
    case 'uploadAttachment': {
      rejectUnknownFields(params, new Set(['botId', 'name', 'mimeType', 'data']), 'params');
      assertId(params.botId, 'botId');
      assertNonEmptyString(params.name, 'name');
      if (Buffer.byteLength(params.name, 'utf8') > MAX_ATTACHMENT_NAME_BYTES) {
        throw invalid('name must be at most 256 UTF-8 bytes');
      }
      if (typeof params.mimeType !== 'string' || !IMAGE_MIME_TYPES.has(params.mimeType)) {
        throw invalid('mimeType must be image/jpeg or image/png');
      }
      assertBase64(params.data, 'data');
      // base64 严格编码使解码长度可由长度推出；解码上限 16 MiB。
      if (Math.floor(params.data.length / 4) * 3 - (params.data.endsWith('==') ? 2 : params.data.endsWith('=') ? 1 : 0) > MAX_ATTACHMENT_BYTES) {
        throw invalid('data exceeds the 16 MiB decoded image limit');
      }
      return { botId: params.botId, name: params.name, mimeType: params.mimeType, data: params.data };
    }
    case 'getAttachment': {
      rejectUnknownFields(params, new Set(['botId', 'attachmentId']), 'params');
      assertId(params.botId, 'botId');
      assertAttachmentId(params.attachmentId, 'attachmentId');
      return { botId: params.botId, attachmentId: params.attachmentId };
    }
    case 'manageBotLearning': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      if (!isPlainObject(params.input)) throw invalid('input must be an object');
      if (typeof params.input.action !== 'string' ||
          !['status', 'configure', 'learn', 'review', 'curate', 'cancel'].includes(params.input.action)) {
        throw invalid('input.action must be one of status|configure|learn|review|curate|cancel');
      }
      return { botId: params.botId, input: params.input };
    }
    case 'reviewBotSkills': {
      rejectUnknownFields(params, new Set(['botId', 'input']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId, input: normalizeSkillReviewInput(params.input) };
    }
    case 'manageTasks': {
      const allowedActions = new Set([
        'list',
        'get',
        'create',
        'update',
        'assign',
        'confirm_plan',
        'answer_prompt',
        'resolve_adoption_scope',
        'dismiss_adoption',
        'delete',
      ]);
      if (!isPlainObject(params) || typeof params.action !== 'string' || !allowedActions.has(params.action)) {
        throw invalid('params.action must be a valid global task action');
      }
      return params;
    }
    default:
      throw invalid('unknown control method');
  }
}

/**
 * Validate a control method name and its params object against the fixed
 * method table. Throws messageError INVALID_ARGUMENT on unknown method/invalid
 * params, REQUEST_TOO_LARGE when normalized params exceed 32 MiB UTF-8.
 */
export function normalizeControlCall(method, params) {
  if (typeof method !== 'string' || !CONTROL_METHODS.includes(method)) {
    throw invalid('unknown control method');
  }
  if (params === undefined) params = {};
  if (!isPlainObject(params)) {
    throw invalid('params must be an object');
  }
  const normalized = normalizeControlParams(method, params);
  let json;
  try {
    json = JSON.stringify(normalized);
  } catch {
    throw invalid('params must be JSON-serializable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_CONTROL_JSON_BYTES) {
    throw messageError('REQUEST_TOO_LARGE', 'control params exceed 32 MiB');
  }
  return { method, params: normalized };
}

// Shared success/failure half of a control-result frame. Success carries only
// a non-null JSON object/array result; failure carries only an allowed code +
// outcome. No free-form message/stack/status on the wire.
function normalizeControlResult(parsed, label) {
  if (typeof parsed.ok !== 'boolean') {
    throw invalid(`${label}.ok must be a boolean`);
  }
  if (parsed.ok) {
    if (parsed.code !== undefined || parsed.outcome !== undefined) {
      throw invalid(`${label} success must not carry code/outcome`);
    }
    if (!isPlainObject(parsed.result) && !Array.isArray(parsed.result)) {
      throw invalid(`${label}.result must be a non-null JSON object or array`);
    }
    let json;
    try {
      json = JSON.stringify(parsed.result);
    } catch {
      throw invalid(`${label}.result must be JSON-serializable`);
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_CONTROL_JSON_BYTES) {
      throw messageError('RESPONSE_TOO_LARGE', `${label} result exceeds 32 MiB`);
    }
    return { ok: true, result: parsed.result };
  }
  if (parsed.result !== undefined) {
    throw invalid(`${label} failure must not carry result`);
  }
  if (typeof parsed.code !== 'string' || !CONTROL_ERROR_CODES.has(parsed.code)) {
    throw invalid(`${label}.code must be an allowed control error code`);
  }
  if (typeof parsed.outcome !== 'string' || !CONTROL_OUTCOMES.has(parsed.outcome)) {
    throw invalid(`${label}.outcome must be one of not-sent, unconfirmed, responded`);
  }
  return { ok: false, code: parsed.code, outcome: parsed.outcome };
}

/**
 * Parse a control frame sent by a remote client to the relay: control-call or
 * control-cancel(callId). Throws INVALID_ARGUMENT on any protocol violation.
 */
export function readControlClientFrame(parsed) {
  if (!isPlainObject(parsed)) {
    throw invalid('control frame must be an object');
  }
  switch (parsed.type) {
    case 'control-call': {
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'targetDeviceId', 'method', 'params']), 'control-call frame');
      assertId(parsed.callId, 'callId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      const { method, params } = normalizeControlCall(parsed.method, parsed.params);
      return {
        type: 'control-call',
        callId: parsed.callId,
        targetDeviceId: parsed.targetDeviceId,
        method,
        params,
      };
    }
    case 'control-cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'callId']), 'control-cancel frame');
      assertId(parsed.callId, 'callId');
      return { type: 'control-cancel', callId: parsed.callId };
    }
    default:
      throw invalid('unknown control client frame type');
  }
}

/**
 * Parse a control frame sent by a Host to the relay: control-result(routeId).
 * Throws INVALID_ARGUMENT on any protocol violation. (Extra directional helper
 * used by relay-protocol.js; host control-result has no callId/targetDeviceId.)
 */
export function readControlHostFrame(parsed) {
  if (!isPlainObject(parsed)) {
    throw invalid('control frame must be an object');
  }
  if (parsed.type !== 'control-result') {
    throw invalid('unknown control host frame type');
  }
  rejectUnknownFields(parsed, new Set(['type', 'routeId', 'ok', 'result', 'code', 'outcome']), 'control-result frame');
  assertId(parsed.routeId, 'routeId');
  const result = normalizeControlResult(parsed, 'control-result');
  return { type: 'control-result', routeId: parsed.routeId, ...result };
}

/**
 * Parse a control frame sent by the relay server: control-request,
 * control-cancel(routeId), or control-result(callId,targetDeviceId). Throws
 * INVALID_ARGUMENT on any protocol violation.
 */
export function readControlServerFrame(parsed) {
  if (!isPlainObject(parsed)) {
    throw invalid('control frame must be an object');
  }
  switch (parsed.type) {
    case 'control-request': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId', 'fromDeviceId', 'method', 'params']), 'control-request frame');
      assertId(parsed.routeId, 'routeId');
      assertId(parsed.fromDeviceId, 'fromDeviceId');
      const { method, params } = normalizeControlCall(parsed.method, parsed.params);
      return {
        type: 'control-request',
        routeId: parsed.routeId,
        fromDeviceId: parsed.fromDeviceId,
        method,
        params,
      };
    }
    case 'control-cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId']), 'control-cancel frame');
      assertId(parsed.routeId, 'routeId');
      return { type: 'control-cancel', routeId: parsed.routeId };
    }
    case 'control-result': {
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'targetDeviceId', 'ok', 'result', 'code', 'outcome']), 'control-result frame');
      assertId(parsed.callId, 'callId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      const result = normalizeControlResult(parsed, 'control-result');
      return {
        type: 'control-result',
        callId: parsed.callId,
        targetDeviceId: parsed.targetDeviceId,
        ...result,
      };
    }
    default:
      throw invalid('unknown control server frame type');
  }
}
