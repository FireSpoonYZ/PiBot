// center-server/bot-management.js
//
// Bot-scoped capability-installation service shared by the owner admin route
// (/api/devices/:deviceId/bots/:botId/installations) and the paired-device route
// (/api/host/devices/:deviceId/bots/:botId/installations). Every action is a
// fixed call into the existing store/packages services — no arbitrary HTTP.
// Device-token calls stay scoped to the target Bot: an installation bound to
// Bots outside the target is shared, and reads/mutations return FORBIDDEN so
// the owner admin authority (allowShared) is required.

import { createHash } from 'node:crypto';

const error = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw error(code, message); };
const text = (value, name) => typeof value === 'string' && value ? value : fail('INVALID_ARGUMENT', `Invalid ${name}`);

const READ_ACTIONS = new Set(['inspect', 'operation', 'deployments']);
const MUTATIONS = new Set(['update', 'rollback', 'enable', 'disable', 'uninstall']);
export const BOT_INSTALLATION_ACTIONS = new Set([...READ_ACTIONS, ...MUTATIONS, 'install']);

// Phases that conclude a bounded wait: terminal results plus 'waiting-idle',
// which is itself the honest reportable state for a Host-gated deployment.
const SETTLED_PHASES = new Set(['applied', 'removed', 'failed', 'waiting-idle']);
const OPERATION_WAIT_MS = 20000;
const OPERATION_POLL_MS = 250;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openBotManagement({ store, packages, notify }) {
  const notifyDevice = typeof notify === 'function' ? notify : () => {};

  /** Poll one operation until it settles or the caller's shared deadline expires; always returns the real stored phase. */
  async function waitOperation(operationId, deadline) {
    for (;;) {
      const operation = store.getOperation(operationId);
      if (!operation) fail('NOT_FOUND', 'Operation not found');
      if (SETTLED_PHASES.has(operation.phase) || Date.now() >= deadline) return operation;
      await delay(OPERATION_POLL_MS);
    }
  }

  function deviceReceipts(installationId, deviceId) {
    return store.listDeploymentReceipts(installationId).filter((receipt) => receipt.deviceId === deviceId);
  }

  async function execute({ deviceId, botId }, input, { allowShared = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ARGUMENT', 'Expected an object');
    const action = input.action;
    if (!BOT_INSTALLATION_ACTIONS.has(action)) fail('INVALID_ARGUMENT', 'Invalid action');

    // Device-owned install operations carry a persistent, scoped namespace.
    const scope = createHash('sha256').update(JSON.stringify([deviceId, botId])).digest('hex');
    const prefix = 'bot:' + scope + ':';
    const scopedRequestId = (requestId) => allowShared ? requestId
      : prefix + createHash('sha256').update(requestId).digest('hex');
    const bindingsOf = (installationId) => store.listBotBindings({ installationId });
    const owned = (installationId) => store.listOperations({ installationId, action: 'install' })
      .some((operation) => operation.requestId?.startsWith(prefix));
    const scoped = (installationId) => {
      if (allowShared) return;
      const outside = bindingsOf(installationId)
        .filter((binding) => binding.deviceId !== deviceId || binding.botId !== botId);
      if (outside.length) {
        fail('FORBIDDEN', 'Installation is bound to Bots outside the target; use the owner admin route');
      }
      const bound = bindingsOf(installationId)
        .some((binding) => binding.deviceId === deviceId && binding.botId === botId);
      if (!bound && !owned(installationId)) {
        fail('FORBIDDEN', 'Installation is not owned by or bound to the target Bot');
      }
    };
    // Device-token mutations additionally require the installation to actually
    // belong to this scope: bound to the target Bot (and nothing outside), or
    // provably created by this caller's install requestId — the operations
    // table is the persistent ownership record. Unbound admin/foreign installs
    // are owner-route territory; read actions above stay on scoped() alone.
    const scopedMutation = (installationId) => scoped(installationId);
    const existing = (installationId) => {
      const installation = store.getInstallation(installationId);
      if (!installation) fail('NOT_FOUND', 'Installation not found');
      return installation;
    };

    if (action === 'inspect') {
      const installationId = text(input.installationId, 'installationId');
      const installation = existing(installationId);
      scoped(installationId);
      return {
        installation,
        binding: store.getBotCapability(deviceId, botId, installationId),
        operations: store.listOperations({ installationId }),
        receipts: deviceReceipts(installationId, deviceId),
      };
    }

    if (action === 'deployments') {
      const installationId = text(input.installationId, 'installationId');
      existing(installationId);
      scoped(installationId);
      const plans = (await packages.listDeploymentPlans(deviceId))
        .filter((plan) => plan.installationId === installationId);
      return { installationId, plans, receipts: deviceReceipts(installationId, deviceId) };
    }

    if (action === 'operation') {
      const operationId = text(input.operationId, 'operationId');
      const operation = store.getOperation(operationId);
      if (!operation) fail('NOT_FOUND', 'Operation not found');
      if (operation.installationId) scoped(operation.installationId);
      else if (!allowShared && !operation.requestId?.startsWith(prefix)) fail('FORBIDDEN', 'Operation is not owned by the target Bot');
      return { operation };
    }

    const requestId = scopedRequestId(text(input.requestId, 'requestId'));
    // One deadline per execute: install+enable must fit inside the client's
    // 30s request timeout; an expired wait returns the current stage's
    // retryable receipt instead of another 20s block.
    const deadline = Date.now() + OPERATION_WAIT_MS;

    if (action === 'install') {
      const kind = text(input.kind, 'kind');
      if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) {
        fail('INVALID_ARGUMENT', 'Invalid source');
      }
      // Stage 1: create the installation record; identical requestId retries
      // resume the composite instead of duplicating the operation.
      const accepted = await packages.install({
        requestId,
        kind,
        source: input.source,
        target: input.target === undefined ? 'host' : text(input.target, 'target'),
        ...(input.displayName !== undefined ? { displayName: text(input.displayName, 'displayName') } : {}),
      });
      const installOperation = await waitOperation(accepted.operationId, deadline);
      const installationId = installOperation.installationId;
      if (installOperation.phase === 'failed') {
        return { status: 'failed', stage: 'install', installationId, operation: installOperation };
      }
      if (!store.getInstallation(installationId)) {
        return { status: 'queued', stage: 'install', installationId, operation: installOperation };
      }
      // Stage 2: global enable. Ownership is proven by this requestId, but
      // an idempotent retry must recheck outside bindings — the install may
      // have become shared since the operation was accepted.
      scoped(installationId);
      const enabled = await packages.enable(installationId, { requestId: requestId + ':enable' });
      const enableOperation = await waitOperation(enabled.operationId, deadline);
      if (enableOperation.phase === 'failed') {
        return { status: 'failed', stage: 'enable', installationId, operation: enableOperation };
      }
      const installation = store.getInstallation(installationId);
      if (!installation || !store.isActive(installation)) {
        return { status: 'enabling', stage: 'enable', installationId, installation, operation: enableOperation };
      }
      // Stage 3: the Bot's own binding. An already-enabled row makes a retry
      // a no-op; the deployment plan stays queued until the Host applies it.
      let binding = store.getBotCapability(deviceId, botId, installationId);
      if (!binding.enabled) {
        binding = store.putBotCapability(deviceId, botId, installationId, {
          expectedRevision: binding.revision,
          enabled: true,
          overrides: binding.overrides,
        });
        try { await packages.reconcileDevice(deviceId); } finally { notifyDevice(deviceId); }
      }
      const plan = (await packages.listDeploymentPlans(deviceId))
        .find((item) => item.installationId === installationId) ?? null;
      return {
        // 'bound' means saved binding plus a queued deployment plan — the Host
        // has not applied anything yet and reports its own receipt later.
        status: 'bound',
        stage: 'deployment',
        installationId,
        installation: store.getInstallation(installationId),
        binding,
        operations: [installOperation, enableOperation],
        deployment: plan
          ? { planId: plan.planId, desiredRevision: plan.desiredRevision, action: plan.action }
          : null,
      };
    }

    // update/rollback/enable/disable/uninstall — scoped package mutations.
    const installationId = text(input.installationId, 'installationId');
    existing(installationId);
    scopedMutation(installationId);
    const request = { requestId };
    let accepted;
    if (action === 'update') {
      request.targetVersion = text(input.targetVersion, 'targetVersion');
      if (input.source !== undefined) request.source = input.source;
      accepted = await packages.update(installationId, request);
    } else if (action === 'enable') {
      if (input.validationBot !== undefined) {
        const validationBot = input.validationBot;
        if (!validationBot || validationBot.deviceId !== deviceId || validationBot.botId !== botId) {
          fail('INVALID_ARGUMENT', 'validationBot must be the target Bot');
        }
        request.validationBot = { deviceId, botId };
      }
      accepted = await packages.enable(installationId, request);
    } else {
      accepted = await packages[action](installationId, request);
    }
    const operation = await waitOperation(accepted.operationId, deadline);
    return {
      status: operation.phase,
      installationId,
      operation,
      installation: store.getInstallation(installationId) ?? null,
    };
  }

  return { execute };
}
