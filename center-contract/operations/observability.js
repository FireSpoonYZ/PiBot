import { defineOperation } from './schema.js';

const DEVICE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Paired Host device identifier.',
};

const RELEASE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Identifier of an already-signed, already-uploaded client release stored in Center.',
};

const BOT_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Bot identifier on the target Host device.',
};

/**
 * Slim, typed Center operations to be merged into the `center` domain:
 * - Client release publish/unpublish toggle (boolean only; no uploads or signing keys).
 * - Host read-only observability via the fixed Host Bridge (`getHostInfo`,
 *   `getServiceStatus`, `getBotBoard`), masking credentials/internal environment and
 *   never exporting primary conversation history.
 */
export const operations = Object.freeze([
  defineOperation({
    name: 'center_set_client_release_published',
    description: 'Publish or unpublish an already-signed, already-uploaded client release stored in Center by toggling only its published boolean. Never uploads artifacts, modifies signatures/metadata, or reads signing keys.',
    properties: {
      releaseId: RELEASE_ID_SCHEMA,
      published: {
        type: 'boolean',
        description: 'True to publish the release to update channels, false to unpublish it.',
      },
    },
    required: ['releaseId', 'published'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_host_info',
    description: 'Read sanitized Host identity and platform metadata for an online paired device over the fixed Host Bridge. Omits local filesystem paths, credentials, and internal environment details.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
    },
    required: ['deviceId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_host_service_status',
    description: 'Read sanitized Host service, relay link, settings revision, and Center connection health for an online paired device over the fixed Host Bridge. Omits local control URLs, Center URLs, credentials, and internal environment details.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
    },
    required: ['deviceId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_bot_board',
    description: 'Read bounded live status board snapshots (activity phase, queue count, pending attention summary, progress, task status, and last committed result summary) for explicitly specified Bots on an online paired Host over the fixed Host Bridge. Requires explicit management read authorization and never exports primary conversation history.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botIds: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: BOT_ID_SCHEMA,
        description: 'One to 64 Bot identifiers on the target Host device (duplicates are deduplicated in input order).',
      },
    },
    required: ['deviceId', 'botIds'],
    readOnly: true,
    destructive: false,
  }),
]);
