// host-core/bot-management-tools.js
//
// manage_bot_skill / manage_bot_learning / manage_bot_installation model tool
// specs. createCommunicationTools wraps each spec in its shared tool() helper,
// so Bot identity resolution, abort checks and typed error output stay
// identical to the other collaboration tools. boundedCodes marks every
// uppercase service code as a tool-visible error result — the Center bot
// endpoints return bounded typed errors (CAS conflicts included).
import { assertId } from './message-protocol.js';

const ID_SCHEMA = { type: 'string', minLength: 1 };
const REVISION_SCHEMA = { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] };
const MEMBER_SCHEMA = {
  type: 'object',
  properties: { deviceId: ID_SCHEMA, botId: ID_SCHEMA },
  required: ['deviceId', 'botId'],
  additionalProperties: false,
};

const SKILL_ACTIONS = [
  'list', 'read', 'create', 'update', 'delete', 'archive', 'restore',
  'pin', 'lock', 'history', 'rollback', 'publish', 'adopt', 'snapshots', 'restore_snapshot',
];
const LEARNING_ACTIONS = ['status', 'configure', 'learn', 'review', 'curate', 'cancel'];
const INSTALLATION_ACTIONS = [
  'inspect', 'install', 'update', 'rollback', 'enable', 'disable',
  'uninstall', 'operation', 'deployments', 'catalog', 'describe', 'check', 'probe',
];

function assertTargetBot(args) {
  assertId(args.deviceId, 'deviceId');
  assertId(args.botId, 'botId');
}

export function createBotManagementTools({ collaboration, memoRequestId }) {
  // Everything except the target pair plus a memoized requestId goes to the
  // service verbatim; per-action fields stay owned by the service contract.
  async function scopedCall(args, api, context, invoke) {
    const { deviceId, botId, ...fields } = args;
    const requestId = fields.requestId ?? await memoRequestId(api, context);
    return invoke({ deviceId, botId, input: { ...fields, requestId }, signal: context.abortSignal });
  }

  return [
    {
      name: 'manage_bot_skill',
      description:
        "Manage the target Bot's Center-managed skills. Actions: list, read, create, update, delete, " +
        'archive, restore, pin, lock, history, rollback, publish, adopt, snapshots, restore_snapshot. ' +
        'Snapshot restore requires snapshotId, expectedRevisions from snapshots, and requestId; it restores drafts only, not live state or queued deployments. Use restore for archived skills then publish. Other mutations require ' +
        'expectedRevision (create passes expectedRevision null). publish packages the draft, enables ' +
        'it and binds it to this Bot only; the returned deployment receipt is a queued plan, not an ' +
        'applied install. This Bot may target itself.',
      properties: {
        deviceId: ID_SCHEMA,
        botId: ID_SCHEMA,
        action: { type: 'string', enum: SKILL_ACTIONS },
        snapshotId: ID_SCHEMA,
        expectedRevisions: {
          type: 'object', additionalProperties: { anyOf: [{ type: 'null' }, {
            type: 'object', properties: { skillId: ID_SCHEMA, revision: { type: 'integer', minimum: 0 },
              stateRevision: { type: 'integer', minimum: 0 } },
            required: ['skillId', 'revision', 'stateRevision'], additionalProperties: false,
          }] },
        },
        skillId: ID_SCHEMA,
        name: { type: 'string', minLength: 1 },
        category: { type: 'string' },
        skillName: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        files: {
          type: 'object',
          additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          description: 'Map of relative file path to UTF-8 content; null deletes a file on update.',
        },
        path: { type: 'string', minLength: 1 },
        content: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        requestId: ID_SCHEMA,
        expectedRevision: REVISION_SCHEMA,
        pinned: { type: 'boolean' },
        locked: { type: 'boolean' },
        revision: { type: 'integer', minimum: 0 },
        installationId: ID_SCHEMA,
      },
      required: ['deviceId', 'botId', 'action'],
      boundedCodes: true,
      async run(args, _identity, _log, api, context) {
        assertTargetBot(args);
        return scopedCall(args, api, context, collaboration.manageBotSkill);
      },
    },
    {
      name: 'manage_bot_learning',
      description:
        "Manage the target Bot's skill-learning service. Actions: status (config, counters and " +
        'active/last job), configure (settings plus expectedRevision CAS), learn/review/curate ' +
        '(start a Host-driven background job and return its job receipt — the job is not finished ' +
        'when the call returns; poll status for the outcome), cancel (jobId or the active job). ' +
        'learn/review/curate only work where the target Bot runs. learn accepts explicit sources ' +
        '(local paths or http(s) URLs); material tools never run in review/curate. Auxiliary model refs must already be usable on that Host.',
      properties: {
        deviceId: ID_SCHEMA,
        botId: ID_SCHEMA,
        action: { type: 'string', enum: LEARNING_ACTIONS },
        jobId: ID_SCHEMA,
        focus: { type: 'string' },
        sources: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 4096 }, description: 'Manual learn only: explicit files/directories relative to target Bot cwd, or http(s) URLs. Never infer sources from focus.' },
        requestId: ID_SCHEMA,
        config: {
          type: 'object',
          description: 'Learning settings with CAS: enabled, review, curator, budget, reviewModelRef, curatorModelRef. Null model refs follow the Bot model; explicit refs must be configured and usable on this Host.',
          properties: {
            reviewModelRef: { type: ['string', 'null'] },
            curatorModelRef: { type: ['string', 'null'] },
          },
        },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      required: ['deviceId', 'botId', 'action'],
      boundedCodes: true,
      async run(args, _identity, _log, api, context) {
        assertTargetBot(args);
        return scopedCall(args, api, context, collaboration.manageBotLearning);
      },
    },
    {
      name: 'manage_bot_installation',
      description:
        'Manage Center capability installations scoped to the target Bot. Actions: catalog (minimal metadata), ' +
        'describe (schema and credential-reference status, no secret values), check (configuration versus ' +
        'deployment receipts, no network), probe (explicit read-only Webfox/Hindsight request, may incur cost). ' +
        'UNSUPPORTED_TARGET means this installation/version cannot be probed; use describe/check instead of retrying. ' +
        'Enter secrets only in the Center credential UI, never chat/questionnaires. Other actions: inspect, install ' +
        '(creates the installation, globally enables it, then binds this Bot — the reply reports the ' +
        'stage reached; bound means saved binding plus a queued deployment plan), update, rollback, ' +
        'enable, disable, uninstall, operation (poll one operation receipt by operationId), ' +
        'deployments (current plan and Host receipts for the target device). Mutations are rejected ' +
        'when the installation is bound to Bots outside the target; use operation/deployments for ' +
        'honest status — a queued plan is never an applied deployment.',
      properties: {
        deviceId: ID_SCHEMA,
        botId: ID_SCHEMA,
        action: { type: 'string', enum: INSTALLATION_ACTIONS },
        requestId: ID_SCHEMA,
        installationId: ID_SCHEMA,
        operationId: ID_SCHEMA,
        kind: { type: 'string', enum: ['plugin', 'mcp', 'skill'] },
        source: {
          type: 'object',
          description: 'Package source: {type:"npm",spec}, {type:"artifact",artifactRef} or {type:"http",url}.',
        },
        target: { type: 'string', enum: ['host', 'center'] },
        displayName: { type: 'string', minLength: 1 },
        targetVersion: { type: 'string', minLength: 1 },
        validationBot: MEMBER_SCHEMA,
      },
      required: ['deviceId', 'botId', 'action'],
      boundedCodes: true,
      async run(args, _identity, _log, api, context) {
        assertTargetBot(args);
        return scopedCall(args, api, context, collaboration.manageBotInstallation);
      },
    },
  ];
}
