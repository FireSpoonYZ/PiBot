// center-server/bot-management.js
//
// Bot-scoped capability-installation service shared by the owner admin route
// (/api/devices/:deviceId/bots/:botId/installations) and the paired-device route
// (/api/host/devices/:deviceId/bots/:botId/installations). Every action is a
// fixed call into the existing store/packages services — no arbitrary HTTP.
// Device-token calls stay scoped to the target Bot: an installation bound to
// Bots outside the target is shared: legacy reads/mutations require owner
// authority. Setup reads/probes below expose only the target Bot's status.

import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';

const ajv = new Ajv({ strict: false });
ajv.addFormat('credential-ref', { type: 'string', validate: value => value.length > 0 });
const metadata = ({ installationId, packageId, displayName, kind, target, targetVersion, enabled }) =>
  ({ installationId, packageId, displayName, kind, target, targetVersion, enabled });
const SETUP_GUIDANCE = 'Configure secrets only in Center Credentials / the capability configuration UI, then select credential references. Never request secret values in chat or questionnaires. Save the Bot binding, wait for deployment/configuration receipts, then explicitly probe (may incur provider charges).';

// Walk only schema-declared credential slots; never echo configuration values or resolve secrets.
function credentialStatus(store, schema, value, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.format === 'credential-ref') {
    const ref = typeof value === 'string' ? value : null;
    const record = ref ? store.getCredential(ref) : null;
    return [{ path, credentialRef: ref, configured: record?.configured === true, revision: record?.revision ?? null }];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => credentialStatus(store, schema.items, item, path + '/' + i));
  const properties = { ...schema.properties };
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const key of Object.keys(value ?? {})) properties[key] ??= schema.additionalProperties;
  }
  return Object.entries(properties).flatMap(([key, child]) =>
    credentialStatus(store, child, value?.[key], path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')));
}

const error = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw error(code, message); };
const text = (value, name) => typeof value === 'string' && value ? value : fail('INVALID_ARGUMENT', `Invalid ${name}`);

const READ_ACTIONS = new Set(['catalog', 'describe', 'check', 'probe', 'inspect', 'operation', 'deployments']);
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

  async function execute({ deviceId, botId }, input, { allowShared = false, callAction } = {}) {
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

    if (action === 'catalog') {
      return {
        installations: store.listInstallations()
          .filter((inst) => allowShared || store.isVisibleToBot(inst, deviceId, botId))
          .map(metadata),
      };
    }

    if (['describe', 'check', 'probe'].includes(action)) {
      const installationId = text(input.installationId, 'installationId');
      const installation = existing(installationId);
      if (!allowShared && !store.isVisibleToBot(installation, deviceId, botId)) {
        fail('NOT_FOUND', 'Installation not found');
      }
      const bound = () => bindingsOf(installationId).some(binding => binding.deviceId === deviceId && binding.botId === botId);
      const config = store.getInstallationConfig(installationId);
      const pkg = store.getPackageVersion(installation.packageId, installation.targetVersion);
      const descriptors = pkg.manifest.actions ?? [];
      const probeSupported = installation.target === 'host' &&
        ['e-launcher.webfox', 'e-launcher.hindsight'].includes(pkg.manifest.id) &&
        descriptors.some(item => item.id === 'probe');
      const binding = store.getBotCapability(deviceId, botId, installationId);
      const mayReadConfig = bound() || owned(installationId);
      const refs = mayReadConfig ? credentialStatus(store, config.configSchema, binding.effectiveConfig) : null;
      if (action === 'describe') {
        return { installation: metadata(installation), configSchema: config.configSchema,
          actions: descriptors, credentialRefs: refs, probeSupported, guidance: SETUP_GUIDANCE };
      }
      if (!bound()) fail('FORBIDDEN', 'Check/probe requires a binding to the target Bot');
      const readCheck = () => {
        if (!bound()) fail('FORBIDDEN', 'Capability binding was removed');
        const current = existing(installationId);
        const global = store.getInstallationConfig(installationId);
        const botConfig = store.getBotCapability(deviceId, botId, installationId);
        const credentials = credentialStatus(store, global.configSchema, botConfig.effectiveConfig);
        const schemaValid = ajv.validate(global.configSchema, botConfig.effectiveConfig);
        const configured = schemaValid && credentials.every(ref => ref.credentialRef === null || ref.configured);
        const deploymentDevice = current.target === 'center' ? null : deviceId;
        const plan = store.listDeploymentPlans(deploymentDevice).find(item => item.installationId === installationId);
        const receipt = deviceReceipts(installationId, deploymentDevice).find(item => item.planId === plan?.planId) ?? null;
        const runtime = store.getDeviceRuntimeStatus(deviceId, false);
        const lastRuntime = store.getRuntimeReceipt(deviceId);
        const botReceipt = lastRuntime?.bots?.find(item => item.botId === botId) ?? null;
        const currentBotReceipt = botReceipt?.desiredRevision === runtime.desiredRevision;
        const packageApplied = plan && receipt?.phase === 'applied' && receipt.health === 'ready' &&
          receipt.appliedRevision === plan.desiredRevision && receipt.actualVersion === current.targetVersion &&
          plan.targetVersion === current.targetVersion && !['disable', 'uninstall'].includes(plan.action);
        const configApplied = currentBotReceipt && botReceipt.status === 'applied' &&
          botReceipt.appliedRevision === runtime.desiredRevision;
        const status = receipt?.phase === 'failed' || (currentBotReceipt && botReceipt.status === 'failed') ? 'failed'
          : packageApplied && configApplied ? 'deployed' : receipt ? 'stale' : 'not-deployed';
        return { installation: metadata(current), configured: Boolean(configured),
          configuration: { schemaValid: Boolean(schemaValid), globalRevision: global.revision,
            bindingRevision: botConfig.revision, enabled: store.isActive(current) && botConfig.enabled,
            credentialRefs: credentials, desiredRevision: runtime.desiredRevision,
            appliedRevision: botReceipt?.appliedRevision ?? null,
            receipt: botReceipt ? { botId, desiredRevision: botReceipt.desiredRevision,
              appliedRevision: botReceipt.appliedRevision, status: botReceipt.status } : null },
          deployment: { status, desiredRevision: plan?.desiredRevision ?? null,
            planId: plan?.planId ?? null, receipt },
          probe: { status: 'not-run', supported: probeSupported }, guidance: SETUP_GUIDANCE };
      };
      const before = readCheck();
      if (action === 'check') return before;
      if (!probeSupported) fail('UNSUPPORTED_TARGET', 'Probe requires a compatible Host Webfox/Hindsight installation; use describe/check to inspect support');
      if (!before.configuration.enabled) fail('FORBIDDEN', 'Capability is not enabled for this Bot');
      if (!before.configured || before.deployment.status !== 'deployed') {
        return { ...before, probe: { status: 'blocked', reason: 'Wait for valid configuration and matching deployment/configuration receipts' } };
      }
      let response;
      try {
        response = await callAction(installationId, 'probe', {
          deviceId, botId, requestId: randomUUID(), input: {},
        });
      } catch {
        // Provider and transport errors may contain credentials; expose no raw messages.
        return { ...readCheck(), probe: { status: 'failed', message: 'Read-only probe failed or timed out; check provider credentials, Host authorization and connectivity in Center' } };
      }
      const after = readCheck();
      const unchanged = bound() && after.configuration.enabled && after.configured &&
        after.deployment.status === 'deployed' &&
        before.configuration.desiredRevision === after.configuration.desiredRevision &&
        before.deployment.planId === after.deployment.planId &&
        response.result?.version === after.installation.targetVersion;
      return { ...after, probe: unchanged && response.result?.ok === true
        ? { status: 'verified', version: response.result.version, operation: response.result.operation, checkedAt: new Date().toISOString() }
        : { status: 'stale', message: 'Desired configuration/version changed or is not applied; retry after deployment' } };
    }

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
