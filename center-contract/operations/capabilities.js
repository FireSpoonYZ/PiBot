// Capabilities domain operation descriptors: Bot skills, Bot learning,
// Bot capability bindings, installation catalog/lifecycle, safe non-secret
// configuration, sharing, and allowlisted read-only diagnostics.
import { defineOperation } from './schema.js';

export const SAFE_CAPABILITY_ACTIONS = Object.freeze(['listTools', 'validate', 'probe']);

const idSchema = { type: 'string', minLength: 1, maxLength: 128 };
const revisionSchema = { type: 'integer', minimum: 0 };
const skillNameSchema = { type: 'string', minLength: 1, maxLength: 64 };
const relativePathSchema = { type: 'string', minLength: 1, maxLength: 240 };
const botTargetProps = {
  deviceId: {
    ...idSchema,
    description: 'Target device ID. Omit together with botId to target the calling Bot; required for OAuth clients.',
  },
  botId: {
    ...idSchema,
    description: 'Target Bot ID. Omit together with deviceId to target the calling Bot; required for OAuth clients.',
  },
};

const skillFilesWriteMapSchema = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Map of skill-relative paths (must include SKILL.md; optional non-executable references/, templates/, assets/) to UTF-8 text. Script files, executable extensions, shebangs, and local/traversal file links are forbidden.',
};

const skillFilesPatchMapSchema = {
  type: 'object',
  additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  description: 'Map of skill-relative paths to UTF-8 text (SKILL.md or non-executable references/, templates/, assets/), or null to remove an extra supporting file.',
};

const safeConfigPatchSchema = {
  type: 'object',
  description:
    'Validated non-secret configuration fields to merge. Restricted fields (credential refs, secrets, external service/provider names, URLs/endpoints, env, headers, commands, host file/directory paths, or free-form maps) are rejected and must be configured in Center UI. Pass null for an optional safe field to unset it.',
};

const learningConfigSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Learning settings patch: review cadence, curator cadence, runtime budget, and auxiliary model refs (null follows the Bot model; explicit provider/model refs must already be enabled and granted to the target Host).',
  properties: {
    reviewModelRef: {
      anyOf: [{ type: 'string', minLength: 1, maxLength: 512 }, { type: 'null' }],
    },
    curatorModelRef: {
      anyOf: [{ type: 'string', minLength: 1, maxLength: 512 }, { type: 'null' }],
    },
    review: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryEvery: { type: 'integer', minimum: 1, maximum: 10000 },
        skillEvery: { type: 'integer', minimum: 1, maximum: 10000 },
      },
    },
    curator: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intervalHours: { type: 'integer', minimum: 1, maximum: 100000 },
        minIdleHours: { type: 'number', minimum: 0, maximum: 10000 },
        staleAfterDays: { type: 'integer', minimum: 1, maximum: 100000 },
        archiveAfterDays: { type: 'integer', minimum: 1, maximum: 100000 },
        consolidate: { type: 'boolean' },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxIterations: { type: 'integer', minimum: 1, maximum: 128 },
        maxInputTokens: { anyOf: [{ type: 'integer', minimum: 1, maximum: 10000000 }, { type: 'null' }] },
        callTimeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
        jobTimeoutMs: { type: 'integer', minimum: 10000, maximum: 14400000 },
        pollTimeoutMs: { type: 'integer', minimum: 1000, maximum: 20000 },
      },
    },
  },
};

export const operations = Object.freeze([
  // --- Bot Skills ---
  defineOperation({
    name: 'capability_skill_list',
    description:
      'List Center-managed skills and bound installed skills for a Bot, including visibility scope, curation flags, usage summary, enabled vs effectively active status, and Host deployment state.',
    properties: {
      ...botTargetProps,
      includeArchived: {
        type: 'boolean',
        description: 'Include archived managed skills in the result (default true).',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_skill_read',
    description:
      'Read a Bot-managed skill or bound installed skill by skillId, name, or installationId. Returns all skill files or a single skill-relative path.',
    properties: {
      ...botTargetProps,
      skillId: { ...idSchema, description: 'Managed skill ID.' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Skill name (or category/name).' },
      installationId: { ...idSchema, description: 'Bound installed skill installationId.' },
      skillName: { type: 'string', minLength: 1, maxLength: 128, description: 'Skill name/dir when reading a multi-skill installation.' },
      path: { ...relativePathSchema, description: 'Optional relative file path inside the skill (e.g. SKILL.md or references/guide.md).' },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_skill_create',
    description:
      'Create a new Center-managed skill for a Bot and publish it immediately in one step. Provide either content (full SKILL.md) or files (map including SKILL.md).',
    properties: {
      ...botTargetProps,
      name: { ...skillNameSchema, description: 'Unique skill name (lowercase letters, digits, dots, hyphens, underscores).' },
      category: { ...skillNameSchema, description: 'Optional single-segment category name.' },
      description: { type: 'string', minLength: 1, maxLength: 1024, description: 'Optional frontmatter description override.' },
      content: { type: 'string', minLength: 1, description: 'Full SKILL.md UTF-8 text (use either content or files, not both).' },
      files: skillFilesWriteMapSchema,
      requestId: { ...idSchema, description: 'Optional idempotency key for safe retries.' },
    },
    required: ['name'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_skill_edit',
    description:
      'Edit an existing Bot-managed skill and publish the new revision automatically (unless archived). Use mode="update" for files/path+content/description changes, or mode="patch" for targeted oldText/newText replacement.',
    properties: {
      ...botTargetProps,
      mode: { type: 'string', enum: ['update', 'patch'], description: 'Edit mode: update (files/path/description) or patch (oldText/newText).' },
      skillId: { ...idSchema, description: 'Managed skill ID (provide skillId or name).' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Managed skill name (provide skillId or name).' },
      files: skillFilesPatchMapSchema,
      path: { ...relativePathSchema, description: 'Skill-relative file path (for update with content, or target file for patch; defaults to SKILL.md on patch).' },
      content: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'UTF-8 content for mode="update" with path; null removes a non-SKILL.md file.' },
      description: { type: 'string', minLength: 1, maxLength: 1024, description: 'Frontmatter description update for mode="update".' },
      oldText: { type: 'string', minLength: 1, description: 'Exact text to replace (required for mode="patch").' },
      newText: { type: 'string', description: 'Replacement text (required for mode="patch"; empty string deletes match).' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText in mode="patch" (default false).' },
      requestId: { ...idSchema, description: 'Optional idempotency key for safe retries.' },
    },
    required: ['mode'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_skill_adopt',
    description:
      'Copy a read-only installed or shared skill bound to a Bot into a Bot-owned editable managed skill and publish it.',
    properties: {
      ...botTargetProps,
      installationId: { ...idSchema, description: 'Installed skill installationId to adopt (provide installationId or name).' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Installed skill name (or selector within installationId).' },
      newName: { ...skillNameSchema, description: 'Optional new managed skill name.' },
      requestId: { ...idSchema, description: 'Optional idempotency key for safe retries.' },
    },
    required: [],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_skill_lifecycle',
    description:
      'Change non-destructive curation or lifecycle state of a Bot skill: pin, lock, archive (disables publication; pass forceUnshare=true to unshare first), or restore. To toggle an installed/shared skill per Bot without archiving, use capability_bot_binding_set.',
    properties: {
      ...botTargetProps,
      action: { type: 'string', enum: ['pin', 'lock', 'archive', 'restore'], description: 'Lifecycle/curation action.' },
      skillId: { ...idSchema, description: 'Managed skill ID (provide skillId or name).' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Skill name (provide skillId or name).' },
      pinned: { type: 'boolean', description: 'Required when action="pin".' },
      locked: { type: 'boolean', description: 'Required when action="lock".' },
      forceUnshare: { type: 'boolean', description: 'Optional when action="archive": switch a shared/global managed skill back to private before archiving.' },
      requestId: { ...idSchema, description: 'Optional idempotency key for safe retries.' },
    },
    required: ['action'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_skill_delete',
    description:
      'Permanently delete a Bot-managed skill and queue uninstallation of its published skill installation if present.',
    properties: {
      ...botTargetProps,
      skillId: { ...idSchema, description: 'Managed skill ID (provide skillId or name).' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Managed skill name (provide skillId or name).' },
      requestId: { ...idSchema, description: 'Optional idempotency key for safe retries.' },
    },
    required: [],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'capability_installation_skill_files_read',
    description:
      'Read the skill files and editability status of an already-installed skill package by installationId.',
    properties: {
      installationId: { ...idSchema, description: 'Target skill installationId.' },
    },
    required: ['installationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_skill_files_write',
    description:
      'Replace and publish all files of an editable skill installation (must include valid SKILL.md). Multi-skill or subdirectory packages are read-only.',
    properties: {
      installationId: { ...idSchema, description: 'Target editable skill installationId.' },
      files: skillFilesWriteMapSchema,
      requestId: { ...idSchema, description: 'Optional idempotency key for safe retries.' },
    },
    required: ['installationId', 'files'],
    readOnly: false,
    destructive: false,
  }),

  // --- Bot Learning ---
  defineOperation({
    name: 'capability_learning_status',
    description:
      'Read a Bot learning service status: settings (with CAS revision), automatic trigger counters, activeJob, lastJob, and nextCuratorEligibleAt.',
    properties: {
      ...botTargetProps,
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_learning_configure',
    description:
      'Update a Bot learning configuration using CAS expectedRevision. Auxiliary model refs must already be enabled and granted to the target Host.',
    properties: {
      ...botTargetProps,
      expectedRevision: { ...revisionSchema, description: 'Expected current settings.revision for CAS.' },
      config: learningConfigSchema,
    },
    required: ['expectedRevision', 'config'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_learning_run',
    description:
      'Trigger a Host-driven background review or curate learning job for a Bot and return the accepted job receipt (poll capability_learning_status for completion). Explicit local-source learn runs remain exclusive to the Host local tool.',
    properties: {
      ...botTargetProps,
      mode: { type: 'string', enum: ['review', 'curate'], description: 'Background learning job mode.' },
      focus: { type: 'string', minLength: 1, maxLength: 4000, description: 'Optional focus topic or guidance.' },
    },
    required: ['mode'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_learning_cancel',
    description:
      'Cancel a queued or running Bot learning job by jobId. Returns terminal status or cancelling=true when graceful cancellation was accepted.',
    properties: {
      ...botTargetProps,
      jobId: { ...idSchema, description: 'Learning job ID to cancel.' },
    },
    required: ['jobId'],
    readOnly: false,
    destructive: false,
  }),

  // --- Bot Capability Availability & Safe Overrides ---
  defineOperation({
    name: 'capability_bot_list',
    description:
      'List all capabilities visible to a Bot with sanitized non-secret configuration only and explicit distinction between globalEnabled, globallyEffective, botEnabled, effectivelyEnabled, deploymentStatus, and runtimeApplied.',
    properties: {
      ...botTargetProps,
      kind: { type: 'string', enum: ['plugin', 'mcp', 'skill'], description: 'Optional filter by capability kind.' },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_bot_get',
    description:
      'Inspect one capability for a Bot: sanitized safe global/override/effective config, editable vs restricted fields, credential slot readiness (no secret values or raw refs), enabled vs effectively active state, and Host deployment/runtime receipt convergence.',
    properties: {
      ...botTargetProps,
      installationId: { ...idSchema, description: 'Target capability installationId.' },
    },
    required: ['installationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_bot_binding_set',
    description:
      'Enable or disable an already-installed capability for a Bot and/or patch validated safe non-secret per-Bot override fields using CAS expectedRevision. Restricted fields (credentials, URLs, env, headers, commands, providers) are rejected and existing UI-configured restricted overrides are preserved. Saving queues Host deployment; poll capability_bot_get to verify runtimeApplied.',
    properties: {
      ...botTargetProps,
      installationId: { ...idSchema, description: 'Target capability installationId.' },
      expectedRevision: { ...revisionSchema, description: 'Expected current Bot binding revision for CAS.' },
      enabled: { type: 'boolean', description: 'Desired per-Bot enabled state.' },
      safeOverridesPatch: safeConfigPatchSchema,
    },
    required: ['installationId', 'expectedRevision', 'enabled'],
    readOnly: false,
    destructive: false,
  }),

  // --- Installation Catalog, Details, Global Safe Config, Sharing, Diagnostics & Lifecycle ---
  defineOperation({
    name: 'capability_installation_list',
    description:
      'List installed capabilities with sanitized metadata (no raw URLs or secrets) and explicit globalEnabled vs activationStatus vs globallyEffective states.',
    properties: {
      kind: { type: 'string', enum: ['plugin', 'mcp', 'skill'], description: 'Optional filter by capability kind.' },
      target: { type: 'string', enum: ['host', 'center'], description: 'Optional filter by execution target.' },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_get',
    description:
      'Get sanitized details for an installed capability: globalEnabled vs globallyEffective status, safe global config and safe schema, editable vs restricted fields, credential slot status (configured booleans only), allowlisted diagnostic actions, and optional Bot bindings or deployment receipts.',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
      includeBindings: { type: 'boolean', description: 'Include sanitized Bot capability bindings (default false).' },
      includeDeployments: { type: 'boolean', description: 'Include deployment receipts across devices (default false).' },
    },
    required: ['installationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_deployments',
    description:
      'Read Host/Center deployment receipts for an installation, and optionally current deployment plans for a specific target device/Bot.',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
      deviceId: { ...idSchema, description: 'Optional target deviceId (provide together with botId to include device deployment plans).' },
      botId: { ...idSchema, description: 'Optional target botId (provide together with deviceId to include device deployment plans).' },
    },
    required: ['installationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_operation_get',
    description:
      'Poll the status of an async installation lifecycle operation (enable, disable, uninstall) by operationId.',
    properties: {
      operationId: { ...idSchema, description: 'Operation ID returned by an async lifecycle mutation.' },
    },
    required: ['operationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_diagnose',
    description:
      'Run one explicitly allowlisted read-only diagnostic action on an already-installed capability: "listTools" (MCP/builtin tools), "validate" (connection validation), or "probe" (Webfox/Hindsight read-only probe; may incur provider charges). Arbitrary plugin actions are not allowed.',
    properties: {
      ...botTargetProps,
      installationId: { ...idSchema, description: 'Target installationId (or builtin capability ID for listTools).' },
      action: { type: 'string', enum: [...SAFE_CAPABILITY_ACTIONS], description: 'Allowlisted read-only diagnostic action.' },
    },
    required: ['installationId', 'action'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_updates_check',
    description:
      'Check whether a newer registry version is available for an already-installed npm capability without modifying it.',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
    },
    required: ['installationId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_config_set',
    description:
      'Patch validated safe non-secret global configuration fields on an already-installed capability using CAS expectedRevision. Restricted fields (credentials, URLs, env, headers, commands, providers) are rejected while existing Center UI restricted fields are preserved. If globally enabled, Center revalidates activation.',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
      expectedRevision: { ...revisionSchema, description: 'Expected current global config revision for CAS.' },
      safeConfigPatch: safeConfigPatchSchema,
    },
    required: ['installationId', 'expectedRevision', 'safeConfigPatch'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_sharing_set',
    description:
      'Rename an installation and/or change a Bot-owned skill visibilityScope ("private", "assigned", or "global") using CAS expectedRevision. Changing visibilityScope reconciles affected devices and revokes or seeds Bot bindings per Center policy.',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
      expectedRevision: { ...revisionSchema, description: 'Expected current installation revision for CAS.' },
      displayName: { type: 'string', minLength: 1, maxLength: 120, description: 'Optional updated display name.' },
      visibilityScope: {
        type: 'string',
        enum: ['private', 'assigned', 'global'],
        description: 'Optional visibility scope (supported on Bot-owned skills only).',
      },
    },
    required: ['installationId', 'expectedRevision'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_toggle',
    description:
      'Request async global disable of an already-installed capability (returns an accepted operationId; poll capability_operation_get). Globally enabling an installed capability requires explicit owner approval in Center UI; use capability_bot_binding_set to toggle an already globally active capability per Bot.',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
      action: { type: 'string', enum: ['disable'], description: 'Global lifecycle toggle action ("disable" only; global enable requires Center UI approval).' },
      requestId: { ...idSchema, description: 'Required idempotency key for safe retries.' },
    },
    required: ['installationId', 'action', 'requestId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'capability_installation_uninstall',
    description:
      'Permanently uninstall an already-installed capability across Center and Hosts (async operation; poll capability_operation_get until removed).',
    properties: {
      installationId: { ...idSchema, description: 'Target installationId.' },
      requestId: { ...idSchema, description: 'Required idempotency key for safe retries.' },
    },
    required: ['installationId', 'requestId'],
    readOnly: false,
    destructive: true,
  }),
]);
