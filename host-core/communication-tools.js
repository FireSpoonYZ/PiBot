import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-durable';
import { resolveBotIdentity } from './bot-identity.js';
import { assertId, messageError } from './message-protocol.js';
import { inboxQueryKey } from './message-queries.js';
import { CONTROL_ERROR_CODES } from './remote-control-protocol.js';
import { BOT_FILE_MAX_COUNT } from './bot-file-protocol.js';
import { snapshotBotFiles, deliverBotFile } from './bot-files.js';
import { createBotManagementTools } from './bot-management-tools.js';

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_TEXT_UNITS = 4096;
const TOOL_ERROR_CODES = new Set([
  'INVALID_ARGUMENT', 'BOT_NOT_FOUND', 'BOT_CONTEXT_REQUIRED',
  'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'MESSAGE_NOT_FOUND', 'REQUEST_CONFLICT',
  'STALE_INPUT', 'WORK_STOPPED', 'WORK_CONTEXT_INACTIVE', 'RESPONSE_TOO_LARGE',
  'SCOPE_UNMANAGED', 'SCOPE_AUTHORITY_REQUIRED',
  'CENTER_REQUEST_FAILED', 'NOT_FOUND', 'FORBIDDEN', 'VALIDATION_FAILED',
  ...CONTROL_ERROR_CODES,
]);
const ID_SCHEMA = { type: 'string', minLength: 1 };
const FILES_SCHEMA = {
  type: 'array', items: { type: 'string', minLength: 1 }, maxItems: BOT_FILE_MAX_COUNT,
  description: 'Paths on this Bot\'s Host (absolute or relative to its cwd). Up to 4 regular files, no file-size limit; images keep their original bytes.',
};
const LIMIT_SCHEMA = { type: 'integer', minimum: 1, maximum: 200 };
const THINKING_LEVEL_SCHEMA = {
  anyOf: [
    { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { type: 'null' },
  ],
};
const MEMBER_SCHEMA = {
  type: 'object',
  properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
  required: ['deviceId', 'botId'],
  additionalProperties: false,
};
const MEMBERS_SCHEMA = { type: 'array', items: MEMBER_SCHEMA, maxItems: 64 };
const CURSOR_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: {
        deviceId: ID_SCHEMA,
        kind: { type: 'string', enum: ['inbox'] },
        key: ID_SCHEMA,
        afterLocalId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['deviceId', 'kind', 'key', 'afterLocalId'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

function output(result) {
  return { output: [{ type: 'text', text: JSON.stringify(result) }] };
}

function fits(result) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_OUTPUT_BYTES;
}

function preview(item) {
  const { message } = item;
  let end = Math.min(message.text.length, MAX_TEXT_UNITS);
  // Ledger text is well formed; never split a surrogate pair at the preview boundary.
  const last = message.text.charCodeAt(end - 1);
  if (end < message.text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    localId: item.localId,
    messageId: message.messageId,
    sourceDeviceId: message.sourceDeviceId,
    scopeId: message.scopeId,
    author: message.author,
    category: message.category,
    rootId: message.rootId,
    replyTo: message.replyTo,
    text: message.text.slice(0, end),
    createdAt: message.createdAt,
    selfEcho: item.selfEcho,
    textTruncated: end < message.text.length,
  };
}

function previewPage(metadata, page, key) {
  const result = { ...metadata, items: [], nextCursor: page.nextCursor };
  for (let index = 0; index < page.items.length; index += 1) {
    const item = preview(page.items[index]);
    const previousCursor = result.nextCursor;
    result.items.push(item);
    result.nextCursor = index + 1 < page.items.length
      ? { deviceId: metadata.deviceId, kind: 'inbox', key, afterLocalId: item.localId }
      : page.nextCursor;
    if (!fits(result)) {
      result.items.pop();
      result.nextCursor = previousCursor;
      // One preview fits under the protocol's ID limits; fail rather than skip input if violated.
      if (result.items.length === 0) throw new Error('message preview exceeds the tool response size limit');
      break;
    }
  }
  return result;
}


export function createCommunicationTools({ host, getHarness, getMessageLog, publishWork, collaboration, sessions }) {
  function tool({ name, description, properties, required = [], deferred, boundedCodes, run }) {
    return defineTool({
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      replay: 'safe',
      ...(deferred !== undefined ? { deferred } : {}),
      outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
      async execute(args, api, context) {
        try {
          context.abortSignal?.throwIfAborted();
          const identity = await resolveBotIdentity(host, getHarness(), api.conversationId, context);
          context.abortSignal?.throwIfAborted();
          return output(await run(args, identity, getMessageLog(), api, context));
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          if (error?.requestId) {
            return { ...output({
              code: error.code ?? 'CREATE_BOT_FAILED',
              message: 'Bot creation failed or its outcome is unknown; reconcile using this requestId on the target device before retrying.',
              requestId: error.requestId,
              deviceId: error.deviceId,
              outcome: error.outcome ?? 'unconfirmed',
            }), isError: true };
          }
          // boundedCodes tools (Center bot management) accept every
          // service-emitted uppercase code as a tool-visible error result;
          // un-coded errors still surface as failures.
          const boundedServiceCode = boundedCodes === true &&
            typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code);
          if (!TOOL_ERROR_CODES.has(error?.code) && !boundedServiceCode) throw error;
          return {
            ...output({
              code: error.code,
              message: error.message,
              ...(error.outcome ? { outcome: error.outcome } : {}),
            }),
            isError: true,
          };
        }
      },
    });
  }

  async function send(args, identity, log, api, context, turn) {
    const scope = log.getScope(args.scopeId);
    if (!scope) throw messageError('SCOPE_NOT_FOUND', 'scope not installed');
    let messageId = await api.memo('host.message-id', context);
    if (messageId === undefined) {
      messageId = await api.memo('host.message-id', randomUUID(), context);
    }
    let fileDelivery = null;
    if (args.files?.length) {
      if (!scope.members.some((member) => isMember(member, identity))) {
        throw messageError('SCOPE_FORBIDDEN', 'the sending Bot must belong to the scope');
      }
      fileDelivery = await api.memo('host.message-files-delivered', context);
      if (fileDelivery === undefined) {
        let snapshot = await api.memo('host.message-files-snapshot', context);
        if (snapshot === undefined) {
          const bot = host.getBot(identity.botId);
          snapshot = await api.memo('host.message-files-snapshot', {
            revision: scope.revision,
            files: await snapshotBotFiles(host.dataRoot, bot, args.files, context.abortSignal),
          }, context);
        }
        if (snapshot.revision !== scope.revision) {
          throw messageError('STALE_INPUT', 'scope members changed; send files again to the current scope');
        }
        const recipients = [];
        // shortcut: file-bearing sends require all recipient Hosts online; add offline blob delivery when needed.
        for (const member of scope.members) {
          if (isMember(member, identity)) continue;
          const files = [];
          for (const file of snapshot.files) {
            files.push(await deliverBotFile(file, member, collaboration, context.abortSignal));
          }
          recipients.push({ ...member, files });
        }
        fileDelivery = await api.memo('host.message-files-delivered', {
          revision: scope.revision,
          recipients,
          text: args.text + '\n\nTransferred files (choose your own deviceId/botId; paths are local to that recipient; use read to inspect files and images):\n' +
            JSON.stringify(recipients),
        }, context);
      }
    }
    // 回复关联由 Host 从冻结轮推导，模型不填写：本轮默认回应的目标是
    // responseMessageId（recordOutgoing/replyOrigin 链解析的原始请求消息；
    // null 表示解析不到，降级为新 request 绝不冒充）。升级前的直接旧 DM
    // 冻结轮（无 originRequestId、无该字段）才回退 triggerMessageId。
    const replyTarget = turn?.replyTarget;
    const originMessageId = turn?.responseMessageId !== undefined
      ? turn.responseMessageId
      : (turn?.originRequestId === undefined ? turn?.triggerMessageId : undefined);
    const isReply = scope.kind === 'dm' && replyTarget?.kind === 'dm' &&
      replyTarget.scopeId === args.scopeId && typeof originMessageId === 'string';
    const publication = {
      messageId,
      scopeId: args.scopeId,
      author: { kind: 'bot', botId: identity.botId },
      category: scope.kind === 'room' ? 'public' : (isReply ? 'reply' : 'request'),
      text: fileDelivery?.text ?? args.text,
      replyTo: isReply ? originMessageId : null,
    };
    // 统一主会话下，工作来源由冻结 turn 判定；旧原生工作会话仍按会话身份走同一路径。
    // 冻结路由是默认回复去向而非目标白名单：显式寻址的跨 scope DM 发送合法，
    // 目标成员资格与作者校验由账本承担；只有源自工作决策的轮（带 workNativeId）才把
    // 原始轮传给 driver，由其工作 scope 做 stale-source/成员/预算门禁。
    const workTurn = turn !== null && typeof turn.workNativeId === 'number';
    if (fileDelivery && !log.getMessage(messageId) && log.getScope(args.scopeId)?.revision !== fileDelivery.revision) {
      throw messageError('STALE_INPUT', 'scope members changed during file transfer; message was not published');
    }
    const stored = workTurn || identity.scopeId !== null
      ? await publishWork(publication, api, context, turn)
      : await api.commit(() => {
          context.abortSignal?.throwIfAborted();
          return log.publish(publication);
        }, context);
    // 记录本 Bot 原始 request 的来源 replyTarget：迟到回复据此回流原请求上下文（重放安全）。
    if (publication.category === 'request') await sessions.recordOutgoing(api, stored, context);
    const message = stored.message;
    return {
      messageId: message.messageId,
      scopeId: message.scopeId,
      author: message.author,
      rootId: message.rootId,
      createdAt: message.createdAt,
      status: 'stored',
      ...(fileDelivery ? { files: fileDelivery.recipients } : {}),
    };
  }

  async function memoRequestId(api, context) {
    let requestId = await api.memo('host.collaboration-request-id', context);
    if (requestId === undefined) requestId = await api.memo('host.collaboration-request-id', randomUUID(), context);
    return requestId;
  }

  const isMember = (member, identity) =>
    member.deviceId === identity.deviceId && member.botId === identity.botId;
  function assertTargetBot(args) {
    assertId(args.deviceId, 'deviceId');
    assertId(args.botId, 'botId');
  }

  function assertNotSelf(args, identity, actionLabel) {
    assertTargetBot(args);
    if (args.deviceId === identity.deviceId && args.botId === identity.botId) {
      throw messageError('INVALID_ARGUMENT', `cannot ${actionLabel} the calling Bot itself during its own turn`);
    }
  }

  return [
    ...(collaboration ? [
      tool({
        name: 'list_bots',
        description: 'List the network device and Bot directory. Pages are best effort if the directory changes; errors identify devices whose Bots could not be read.',
        properties: { offset: { type: 'integer', minimum: 0 }, limit: LIMIT_SCHEMA },
        async run(args) {
          const snapshot = await collaboration.listBots();
          const entries = [
            ...snapshot.devices.map((device) => ({ type: 'device', device })),
            ...snapshot.bots.map((bot) => ({ type: 'bot', bot: {
              botId: bot.botId, name: bot.role, description: bot.description ?? '',
              isPrimary: Boolean(bot.isPrimary), archivedAt: bot.archivedAt ?? null,
              deviceId: bot.deviceId, deviceName: bot.deviceName, platform: bot.platform, online: bot.online,
            } })),
            ...snapshot.errors.map((error) => ({ type: 'error', error })),
          ];
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 50;
          const result = { items: [], nextOffset: null };
          for (let index = offset; index < Math.min(entries.length, offset + limit); index += 1) {
            result.items.push(entries[index]);
            result.nextOffset = index + 1 < entries.length ? index + 1 : null;
            if (!fits(result)) {
              result.items.pop();
              if (result.items.length === 0) throw messageError('RESPONSE_TOO_LARGE', 'a directory item exceeds the tool response size limit');
              result.nextOffset = index;
              break;
            }
          }
          return result;
        },
      }),
      tool({
        name: 'get_bot',
        description: 'Inspect full metadata, workspace cwd, primary/archive status, and last activity of a Bot on the specified device.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.getBot({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'create_bot',
        description: 'Create a normal, user-manageable Bot on the specified device. Omit cwd to use that device\'s default workspace. A receipt does not start a task.',
        properties: {
          deviceId: ID_SCHEMA, name: { type: 'string', minLength: 1 },
          description: { type: 'string', maxLength: 2000 }, modelRef: { type: 'string' }, cwd: { type: 'string' },
        },
        required: ['deviceId', 'name', 'description'],
        async run(args, _identity, _log, api, context) {
          assertId(args.deviceId, 'deviceId');
          const requestId = await memoRequestId(api, context);
          try {
            const bot = await collaboration.createBot({ ...args, requestId, signal: context.abortSignal });
            return { ...bot, requestId };
          } catch (error) {
            context.abortSignal?.throwIfAborted();
            const failure = new Error('Bot creation failed');
            failure.code = error?.code;
            failure.outcome = error?.outcome;
            failure.requestId = requestId;
            failure.deviceId = args.deviceId;
            throw failure;
          }
        },
      }),
      tool({
        name: 'update_bot_profile',
        description: 'Update a Bot\'s display name (role) and/or responsibility description on the specified device.',
        properties: {
          deviceId: ID_SCHEMA,
          botId: ID_SCHEMA,
          name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 2000 },
        },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.updateBotProfile({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'get_bot_soul',
        description: 'Read a Bot\'s SOUL.md persona and responsibility document along with its current revision.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.getBotSoul({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'set_bot_soul',
        description: 'Update an idle Bot\'s SOUL.md persona and responsibility document. If expectedRevision is omitted, the current revision is read automatically.',
        properties: {
          deviceId: ID_SCHEMA,
          botId: ID_SCHEMA,
          text: { type: 'string', maxLength: 65536 },
          expectedRevision: { type: 'string' },
        },
        required: ['deviceId', 'botId', 'text'],
        async run(args, identity, _log, _api, context) {
          assertTargetBot(args);
          const self = args.deviceId === host.deviceId && args.botId === identity.botId;
          return collaboration.setBotSoul({ ...args, self, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'get_bot_model',
        description: 'Get a Bot\'s Center-managed model selection (modelRef and thinkingLevel) and the catalog of available models.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.getBotModel({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'set_bot_model',
        description: 'Set a Bot\'s Center-managed modelRef (provider/modelId), thinkingLevel (off, minimal, low, medium, high, xhigh, max), codemode, or codemodeOnly overrides.',
        properties: {
          deviceId: ID_SCHEMA,
          botId: ID_SCHEMA,
          modelRef: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
          thinkingLevel: THINKING_LEVEL_SCHEMA,
          codemode: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
          codemodeOnly: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
          expectedRevision: { type: 'integer', minimum: 0 },
        },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.setBotModel({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'get_bot_capabilities',
        description: 'List Center-managed capabilities (plugins, skills, MCP servers) and their per-Bot configuration (enabled, overrides, revision) for a Bot.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.getBotCapabilities({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'set_bot_capability',
        description: 'Enable/disable a Center-managed capability or update its per-Bot config overrides (such as Hindsight mode or topic) for a Bot.',
        properties: {
          deviceId: ID_SCHEMA,
          botId: ID_SCHEMA,
          installationId: ID_SCHEMA,
          enabled: { type: 'boolean' },
          overrides: { type: 'object' },
          expectedRevision: { type: 'integer', minimum: 0 },
        },
        required: ['deviceId', 'botId', 'installationId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          assertId(args.installationId, 'installationId');
          return collaboration.setBotCapability({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'abort_bot',
        description: 'Abort any active generation task in another Bot\'s primary conversation.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, identity, _log, _api, context) {
          assertNotSelf(args, identity, 'abort');
          return collaboration.abortBot({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'clear_bot_history',
        description: 'Reset/clear an idle, non-archived Bot\'s primary conversation context.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, identity, _log, _api, context) {
          assertNotSelf(args, identity, 'clear history of');
          return collaboration.clearBotHistory({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'compact_bot',
        description: 'Manually compact an idle, non-archived Bot\'s primary conversation context.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, identity, _log, _api, context) {
          assertNotSelf(args, identity, 'compact');
          return collaboration.compactBot({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'archive_bot',
        description: 'Archive an idle, non-primary Bot so it becomes read-only.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, identity, _log, _api, context) {
          assertNotSelf(args, identity, 'archive');
          return collaboration.archiveBot({ ...args, signal: context.abortSignal });
        },
      }),
      tool({
        name: 'unarchive_bot',
        description: 'Unarchive an archived Bot so it can accept tasks again.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, _identity, _log, _api, context) {
          assertTargetBot(args);
          return collaboration.unarchiveBot({ ...args, signal: context.abortSignal });
        },
      }),
      ...createBotManagementTools({ collaboration, memoRequestId }).map((spec) => tool(spec)),
      tool({
        name: 'delete_bot',
        description: 'Permanently delete an idle, non-primary Bot from the specified device.',
        properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
        required: ['deviceId', 'botId'],
        async run(args, identity, _log, _api, context) {
          assertNotSelf(args, identity, 'delete');
          return collaboration.deleteBot({ ...args, signal: context.abortSignal });
        },
      }),
    ] : []),
    tool({
      name: 'ensure_dm',
      description: 'Reuse an installed DM with this peer, or create a managed DM including this Bot. The scope receipt is not proof of remote delivery or work.',
      properties: { peer: MEMBER_SCHEMA },
      required: ['peer'],
      async run(args, identity, log, api, context) {
        assertId(args.peer.deviceId, 'peer.deviceId');
        assertId(args.peer.botId, 'peer.botId');
        if (args.peer.botId === identity.botId) throw messageError('INVALID_ARGUMENT', 'peer must be a different Bot');
        const requestId = await memoRequestId(api, context);
        return api.commit(() => {
          context.abortSignal?.throwIfAborted();
          const existing = log.listScopes().find((scope) => scope.kind === 'dm' &&
            scope.members.some((member) => isMember(member, identity)) &&
            scope.members.some((member) => member.deviceId === args.peer.deviceId && member.botId === args.peer.botId));
          if (existing) return log.getScopeState(existing.scopeId);
          return log.createScope({ requestId, kind: 'dm', members: [
            { deviceId: identity.deviceId, botId: identity.botId }, args.peer,
          ] });
        }, context);
      },
    }),
    tool({
      name: 'create_room',
      description: 'Create a managed room including this Bot and the specified members. This only creates a scope; use send_to to hand off work.',
      properties: { members: MEMBERS_SCHEMA },
      required: ['members'],
      async run(args, identity, log, api, context) {
        const requestId = await memoRequestId(api, context);
        const members = [
          { deviceId: identity.deviceId, botId: identity.botId },
          ...args.members.filter((member) => !isMember(member, identity)),
        ];
        return api.commit(() => {
          context.abortSignal?.throwIfAborted();
          return log.createScope({ requestId, kind: 'room', members });
        }, context);
      },
    }),
    tool({
      name: 'add_room_members',
      description: 'Add members to a room where this Bot is a current member and this device is the authority. A concurrent revision change returns a conflict.',
      properties: { scopeId: ID_SCHEMA, members: MEMBERS_SCHEMA },
      required: ['scopeId', 'members'],
      async run(args, identity, log, api, context) {
        const requestId = await memoRequestId(api, context);
        let input = await api.memo('host.room-update-input', context);
        if (input === undefined) {
          const state = log.getScopeState(args.scopeId);
          if (state.scope.kind !== 'room' || !state.scope.members.some((member) => isMember(member, identity))) {
            throw messageError('SCOPE_FORBIDDEN', 'current Bot must be a room member');
          }
          if (!state.isAuthority) throw messageError('SCOPE_AUTHORITY_REQUIRED', 'only the scope authority may update');
          const members = [...state.scope.members];
          for (const member of args.members) {
            if (!members.some((current) => current.deviceId === member.deviceId && current.botId === member.botId)) members.push(member);
          }
          input = await api.memo('host.room-update-input', {
            requestId, expectedRevision: state.scope.revision, members,
          }, context);
        }
        return api.commit(() => {
          context.abortSignal?.throwIfAborted();
          const state = log.getScopeState(args.scopeId);
          if (state.scope.kind !== 'room' || !state.scope.members.some((member) => isMember(member, identity))) {
            throw messageError('SCOPE_FORBIDDEN', 'current Bot must be a room member');
          }
          if (!state.isAuthority) throw messageError('SCOPE_AUTHORITY_REQUIRED', 'only the scope authority may update');
          return log.updateScope(args.scopeId, input);
        }, context);
      },
    }),
    tool({
      name: 'list_scopes',
      description: 'List installed scopes containing this Bot as a current member. Offsets are best effort when membership changes.',
      properties: { offset: { type: 'integer', minimum: 0 }, limit: LIMIT_SCHEMA },
      run(args, identity, log) {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 50;
        const scopes = log.listScopes().filter((scope) => scope.members.some(
          (member) => member.deviceId === identity.deviceId && member.botId === identity.botId,
        ));
        const result = { deviceId: identity.deviceId, botId: identity.botId, scopes: [], nextOffset: null };
        for (let index = offset; index < Math.min(scopes.length, offset + limit); index += 1) {
          result.scopes.push(scopes[index]);
          result.nextOffset = index + 1 < scopes.length ? index + 1 : null;
          if (!fits(result)) {
            result.scopes.pop();
            if (result.scopes.length === 0) {
              throw messageError('RESPONSE_TOO_LARGE', 'a scope exceeds the tool response size limit');
            }
            result.nextOffset = index;
            break;
          }
        }
        return result;
      },
    }),
    tool({
      name: 'read_scope',
      description: 'Read messages frozen for this Bot in an installed scope, including after exit. Returns bounded text previews and an exact continuation cursor; raw ledger text is unchanged.',
      properties: { scopeId: ID_SCHEMA, limit: LIMIT_SCHEMA, cursor: CURSOR_SCHEMA },
      required: ['scopeId'],
      run(args, identity, log) {
        const page = log.inbox(identity.botId, { scopeId: args.scopeId, limit: args.limit, cursor: args.cursor });
        return previewPage(
          { deviceId: identity.deviceId, botId: identity.botId, scopeId: args.scopeId },
          page,
          inboxQueryKey(identity.botId, args.scopeId),
        );
      },
    }),
    tool({
      name: 'send_to',
      description: 'Send a message as this Bot to an installed scope (a DM with one peer or a room for the group): dispatch work, add information, ask a question, or deliver a result. When this turn already answers a message in that scope, the Host links the send to the original message automatically; there is nothing extra to provide. Sending does not wait: answers and follow-ups arrive later as new rounds in this conversation, so end the turn when no independent work remains. Returns only a local stored receipt — not remote delivery, not a completed task; no scopes are created. Optional files are copied to every other member before publishing; all recipient Hosts must be online. Use original local paths (including uploaded-image paths), never base64 in text.',
      properties: {
        scopeId: ID_SCHEMA,
        text: { type: 'string', minLength: 1 },
        files: FILES_SCHEMA,
      },
      required: ['scopeId', 'text'],
      run: async (args, identity, log, api, context) => send(args, identity, log, api, context, await sessions.getTurn(api, context)),
    }),
  ];
}
