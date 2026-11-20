import { defineOperation } from './schema.js';

export const operations = [
  defineOperation({
    name: 'dispatch_send_bot_message',
    description:
      'Durably dispatch a message to an authorized target Bot via Center Webhook delivery. ' +
      'Requires a stable caller-generated requestId for idempotency (retrying with the same requestId and payload returns the existing dispatch record; different payloads fail with REQUEST_CONFLICT). ' +
      'Returns acceptance/delivery status distinct from completion; poll dispatch_get_bot_message for completion and final answerText. ' +
      'External MCP-triggered turns run on Host in an isolated request-scoped zero-tool Durable session using only the target Bot model configuration and safe public persona fields, without reading private chat history, Hindsight memory, enabled plugins, or SOUL private documents, and without writing replies into the Bot private chat. ' +
      'External OAuth callers cannot select webhook routeId by default unless explicitly approved by an administrator on the target grant.',
    properties: {
      deviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target device ID hosting the Bot.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target Bot ID to receive the message.',
      },
      requestId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Stable caller-generated idempotency key for this dispatch request.',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 32000,
        description: 'Message text delivered to the target Bot as untrusted external data.',
      },
      routeId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Optional admin-approved fixed Webhook route ID bound to the same target deviceId and botId. Rejected by default for external OAuth callers unless explicitly approved on the target grant.',
      },
      metadata: {
        type: 'object',
        description: 'Optional structured JSON metadata passed alongside the message as untrusted external data.',
        additionalProperties: true,
      },
    },
    required: ['deviceId', 'botId', 'requestId', 'message'],
    readOnly: false,
    destructive: false,
  }),
  defineOperation({
    name: 'dispatch_get_bot_message',
    description:
      'Read the durable delivery status and, once status is "succeeded", the single corresponding answerText for a previously dispatched Bot message. ' +
      'Strictly bound to the same authenticated client, target deviceId/botId, and requestId. ' +
      'Does not read private chat history, other turns, tool logs, or credentials.',
    properties: {
      deviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target device ID used when dispatching the message.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target Bot ID used when dispatching the message.',
      },
      requestId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Caller requestId used when dispatching the message.',
      },
    },
    required: ['deviceId', 'botId', 'requestId'],
    readOnly: true,
    destructive: false,
  }),
  defineOperation({
    name: 'dispatch_list_targets',
    description:
      'List active, non-archived Bot targets authorized for the authenticated caller so messages can be dispatched without manually copying deviceId/botId or granting pibot:bots:read. ' +
      'Reads targets exclusively from the trusted OAuth actor grant and returns only { targets: [{ deviceId, botId, name }] }, without exposing SOUL documents, cwd, descriptions, or tokens.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
    audiences: ['oauth'],
  }),
];
