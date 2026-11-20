import { defineOperation } from './schema.js';

export const operations = [
  defineOperation({
    name: 'dispatch_send_bot_message',
    description:
      'Durably dispatch a message to an authorized target Bot via Center Webhook delivery. ' +
      'Requires a stable caller-generated requestId for idempotency (retrying with the same requestId and payload returns the existing dispatch record; different payloads fail with REQUEST_CONFLICT). ' +
      'Optionally binds to a pre-approved fixed Webhook route on the same target Bot without exposing Webhook tokens. ' +
      'Returns acceptance/delivery status distinct from completion; poll dispatch_get_bot_message for completion and final answerText. ' +
      'External MCP-triggered turns run under a restricted safe tool policy on Host without local file, CLI, or admin tools.',
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
        description: 'Optional pre-approved fixed Webhook route ID bound to the same target deviceId and botId.',
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
];
