import { defineOperation } from './schema.js';

const DEVICE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Paired device identifier.',
};

const PROVIDER_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Model provider identifier.',
};

const MODEL_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description: 'Provider-scoped model identifier.',
};

const REVISION_SCHEMA = {
  type: 'integer',
  minimum: 0,
  description: 'Expected CAS revision returned by the latest read.',
};

const NON_SECRET_MODEL_OPTIONAL_PROPERTIES = {
  thinkingLevelMap: {
    type: 'object',
    description: 'Optional mapping from Pi thinking levels to provider thinking levels.',
  },
  cost: {
    type: 'object',
    description: 'Optional token pricing metadata.',
  },
  compat: {
    type: 'object',
    description: 'Optional non-secret model compatibility flags.',
  },
  inputLimits: {
    type: 'object',
    description: 'Optional input size and modality limits metadata.',
  },
  promptCache: {
    type: 'object',
    description: 'Optional prompt caching metadata.',
  },
  samplingParams: {
    type: 'object',
    description: 'Optional default sampling parameters.',
  },
  samplingParamsByThinkingLevel: {
    type: 'object',
    description: 'Optional sampling parameters keyed by thinking level.',
  },
};

const CREATE_MODEL_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning'],
  properties: {
    id: MODEL_ID_SCHEMA,
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Human-readable model display name.',
    },
    contextWindow: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum context window in tokens.',
    },
    maxTokens: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum output tokens.',
    },
    input: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1, maxLength: 64 },
      description: 'Supported input modalities (for example ["text"] or ["text", "image"]).',
    },
    reasoning: {
      type: 'boolean',
      description: 'Whether the model supports reasoning/thinking.',
    },
    enabled: {
      type: 'boolean',
      description: 'Whether the model is enabled in the picker (defaults to true).',
    },
    ...NON_SECRET_MODEL_OPTIONAL_PROPERTIES,
  },
};

export const operations = [
  defineOperation({
    name: 'center_list_devices',
    description: 'List paired devices known to Center with public display name, platform, and online status.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_rename_device',
    description: 'Rename an existing paired device in Center.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: 'New display name for the device (1-120 characters, no control characters).',
      },
    },
    required: ['deviceId', 'name'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_device_runtime_status',
    description: 'Read a device runtime config apply status, desired/applied revisions, and per-Bot or capability error diagnostics.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
    },
    required: ['deviceId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_bot_sync',
    description: 'Read the Center device and Bot directory sync snapshot or incremental events since a known epoch and sequence.',
    properties: {
      epoch: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Optional sync epoch from a previous sync response for incremental diff queries.',
      },
      sinceSeq: {
        type: 'integer',
        minimum: 0,
        description: 'Optional last seen sequence number when querying incremental events.',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_model_config',
    description: 'Read the Center global default model selection and its CAS revision.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_set_model_config',
    description: 'Update the Center global default model selection using CAS expectedRevision.',
    properties: {
      expectedRevision: REVISION_SCHEMA,
      value: {
        type: 'object',
        additionalProperties: false,
        description: 'Complete replacement value for the global default model selection.',
        properties: {
          modelRef: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 512 },
              { type: 'null' },
            ],
            description: 'Default model reference in providerId/modelId format, or null to clear.',
          },
          thinkingLevel: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 64 },
              { type: 'null' },
            ],
            description: 'Default thinking level, or null to clear.',
          },
          codemode: {
            anyOf: [
              { type: 'boolean' },
              { type: 'null' },
            ],
            description: 'Default codemode toggle, or null to clear.',
          },
          codemodeOnly: {
            anyOf: [
              { type: 'boolean' },
              { type: 'null' },
            ],
            description: 'Default codemode-only toggle, or null to clear.',
          },
        },
      },
    },
    required: ['expectedRevision', 'value'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_model_picker',
    description: 'Read the available model picker list, current default model, starred models, and catalog sync status.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_model_catalog_status',
    description: 'Read the Center model catalog synchronization status.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_sync_model_catalog',
    description: 'Trigger a Center model catalog synchronization and return the updated catalog status.',
    properties: {},
    required: [],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_set_model_star',
    description: 'Star or unstar a model in Center owner preferences.',
    properties: {
      modelRef: {
        type: 'string',
        minLength: 3,
        maxLength: 512,
        description: 'Model reference in providerId/modelId format.',
      },
      starred: {
        type: 'boolean',
        description: 'True to star the model, false to remove the star.',
      },
    },
    required: ['modelRef', 'starred'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_list_providers',
    description: 'List public non-secret metadata for Center model providers (excludes upstream URLs, credentials, headers, and raw provider config).',
    properties: {
      configuredOnly: {
        type: 'boolean',
        description: 'When true, return only configured providers.',
      },
      enabledOnly: {
        type: 'boolean',
        description: 'When true, return only enabled providers.',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_provider',
    description: 'Read public non-secret metadata for a single model provider (excludes upstream URLs, credentials, headers, and raw provider config).',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
    },
    required: ['providerId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_provider_auth_status',
    description: 'Read non-secret authentication readiness metadata (none, api_key, or oauth) for one provider or all native providers.',
    properties: {
      providerId: {
        ...PROVIDER_ID_SCHEMA,
        description: 'Optional provider ID. When omitted, returns auth status for all native providers.',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_update_provider',
    description: 'Update public non-secret metadata (name and/or enabled) of an existing provider using CAS expectedRevision. Never modifies upstream URLs, protocol, credentials, or raw overrides.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Updated display name for the provider.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the provider is enabled.',
      },
    },
    required: ['providerId', 'expectedRevision'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_validate_provider',
    description: 'Validate connectivity for an existing stored provider directly from Center without modifying credentials or upstream endpoints.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
    },
    required: ['providerId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_discover_provider_models',
    description: 'Discover available chat models from an existing stored provider directly from Center and return sanitized public model metadata.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
    },
    required: ['providerId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_list_provider_models',
    description: 'List sanitized non-secret model definitions for a provider (excludes per-model custom endpoints and headers).',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
      includeRemoved: {
        type: 'boolean',
        description: 'When true, include catalog models previously hidden/removed.',
      },
    },
    required: ['providerId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_create_provider_model',
    description: 'Create a non-secret manual model entry under an existing provider. Does not allow configuring custom upstream URLs, API protocols, or headers.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
      ...CREATE_MODEL_ITEM_SCHEMA.properties,
    },
    required: ['providerId', ...CREATE_MODEL_ITEM_SCHEMA.required],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_batch_create_provider_models',
    description: 'Batch-create multiple new non-secret manual models under an existing provider. Rejects already-existing model IDs so updates always use CAS.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
      models: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: CREATE_MODEL_ITEM_SCHEMA,
        description: 'New non-secret model definitions to add.',
      },
    },
    required: ['providerId', 'models'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_update_provider_model',
    description: 'Update non-secret metadata or enabled/removed state of an existing provider model using CAS expectedRevision. Preserves any existing upstream endpoint, protocol, or headers untouched.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
      modelId: MODEL_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Updated display name of the model.',
      },
      contextWindow: {
        type: 'integer',
        minimum: 1,
        description: 'Updated context window in tokens.',
      },
      maxTokens: {
        type: 'integer',
        minimum: 1,
        description: 'Updated maximum output tokens.',
      },
      input: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1, maxLength: 64 },
        description: 'Updated list of supported input modalities.',
      },
      reasoning: {
        type: 'boolean',
        description: 'Updated reasoning support flag.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the model is enabled in the picker.',
      },
      removed: {
        type: 'boolean',
        description: 'Set to false to restore a hidden catalog model, or true to hide it.',
      },
      ...NON_SECRET_MODEL_OPTIONAL_PROPERTIES,
    },
    required: ['providerId', 'modelId', 'expectedRevision'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'center_delete_provider_model',
    description: 'Delete a manual model or hide a catalog model under a provider, clearing associated model stars and references.',
    properties: {
      providerId: PROVIDER_ID_SCHEMA,
      modelId: MODEL_ID_SCHEMA,
    },
    required: ['providerId', 'modelId'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'center_list_client_releases',
    description: 'Read public client release metadata stored in Center with optional platform, arch, format, and published filters.',
    properties: {
      platform: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'Optional platform filter (for example windows, linux, macos, android).',
      },
      arch: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'Optional CPU architecture filter (for example x64, arm64, universal).',
      },
      format: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'Optional package format filter (for example nsis, deb, dmg, apk).',
      },
      publishedOnly: {
        type: 'boolean',
        description: 'When true, return only published releases.',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_get_operation',
    description: 'Read the status and phase of an asynchronous Center package or capability operation by operationId.',
    properties: {
      operationId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Asynchronous operation identifier returned by a 202 Accepted action.',
      },
    },
    required: ['operationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'center_list_installation_deployments',
    description: 'Read per-device deployment receipts and health status for a Center capability installation.',
    properties: {
      installationId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Capability installation identifier.',
      },
    },
    required: ['installationId'],
    readOnly: true,
    destructive: false,
  }),
];
