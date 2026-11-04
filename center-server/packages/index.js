import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import pacote from 'pacote';
import semver from 'semver';
import { containedPath, digest, extractArtifact, MAX_ARTIFACT_SIZE, readJson } from '../../host-core/managed-install/archive.js';
import { openManagedInstaller, runNpm } from '../../host-core/managed-install/index.js';

const key = (value) => Buffer.from(value).toString('base64url');
const error = (code, message) => Object.assign(new Error(message), { code });
const credential = { type: 'string', format: 'credential-ref' };
const mcpActions = ['validate', 'listTools'].map(id => ({
  id, title: id === 'validate' ? 'Validate connection' : 'List tools',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}));
const mcpSchema = (url) => ({
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  properties: {
    url: { type: 'string', ...(url ? { default: url } : {}) }, command: { type: 'string' },
    bin: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' }, env: { type: 'object', additionalProperties: { type: 'string' } },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    timeoutMs: { type: 'number' }, transport: { type: 'string', enum: ['stdio', 'http'] },
    oauth: { type: 'boolean', default: false },
    apiKeyRef: credential, envRefs: { type: 'object', additionalProperties: credential },
    headerRefs: { type: 'object', additionalProperties: credential },
  }, additionalProperties: false,
});

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

export function openPackageManager({ dataRoot, store, npmPath, withActivation, onChange = () => {}, probeCenterMcp }) {
  const root = path.join(dataRoot, 'packages');
  const artifacts = path.join(root, 'artifacts');
  const metadata = path.join(root, 'metadata');
  const registry = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  const pacoteOptions = registry ? { registry } : {};
  const manifestSchema = JSON.parse(readFileSync(new URL('../../center-contract/manifest.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false });
  ajv.addFormat('credential-ref', true);
  const validateManifest = ajv.compile(manifestSchema);
  let queue = Promise.resolve();
  let closed = false;
  const waiting = new Map();
  const monitoring = new Map();
  const changing = new Set();
  const reconciling = new Map();
  // Operations whose global probe has not finished: they must never publish a terminal phase yet.
  const holding = new Set();
  let retryQueued = false;
  const activation = (status, error = null) => ({ status, error, updatedAt: new Date().toISOString() });
  // Activation errors are center-authored codes with fixed copy so no Host or npm text reaches the API.
  const ACTIVATION_MESSAGES = {
    NEEDS_AUTH: '需要先在选定的校验 Bot 完成 OAuth 授权，然后重试全局启用',
    MCP_UNREACHABLE: '中心无法连接该 MCP（connect/listTools 未通过）',
    PACKAGE_NOT_READY: '包校验或中心分发准备未完成',
    INVALID_ARGUMENT: '配置不满足全局启用条件（含校验 Bot 与全局 URL 不一致）',
    VALIDATION_FAILED: '配置或包校验未通过',
    INTERNAL_ERROR: '全局启用失败，请检查中心日志',
  };
  const ACTIVATION_CODES = Object.keys(ACTIVATION_MESSAGES);
  const activationError = (code) => ({ code, message: ACTIVATION_MESSAGES[code] });
  const activationCode = (err) => ACTIVATION_CODES.includes(err?.code) ? err.code : 'INTERNAL_ERROR';
  // Only these actions run the global validation after deployment; disable/uninstall must keep their terminal phase.
  const VALIDATING_ACTIONS = ['enable', 'update', 'rollback'];
  const needsValidation = (operationId) => VALIDATING_ACTIONS.includes(store.getOperation(operationId)?.action);
  const retryTimer = setInterval(() => {
    if ((!waiting.size && !monitoring.size) || closed || retryQueued) return;
    retryQueued = true;
    enqueue(async () => {
      try {
        for (const [id, pending] of waiting) {
          const validating = needsValidation(pending.operationId);
          if (validating) holding.add(pending.operationId);
          const receipt = await installer.apply(pending.plan);
          setOperationPhase(pending.operationId, receipt.phase, receipt.error);
          if (receipt.phase !== 'waiting-idle') {
            waiting.delete(id);
            if (receipt.phase === 'applied' || receipt.phase === 'removed') onChange(id);
            if (validating) await settleActivation(id, pending.operationId).catch(() => {});
          }
        }
        for (const operationId of monitoring.keys()) updateMonitoredOperation(operationId);
      } finally { retryQueued = false; }
    });
  }, 1000);
  retryTimer.unref?.();

  async function saveArtifact(bytes) {
    if (bytes.length > MAX_ARTIFACT_SIZE) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
    const sum = digest(bytes);
    const ref = createHash('sha256').update(bytes).digest('hex');
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, ref), bytes, { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    return { artifactRef: ref, digest: sum, size: bytes.length };
  }

  async function uploadArtifact(input) {
    let size = 0;
    const chunks = [];
    for await (const chunk of input) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_SIZE) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const temporary = path.join(root, 'upload-' + randomUUID());
    try { await extractArtifact(bytes, temporary); }
    finally { await rm(temporary, { recursive: true, force: true }); }
    return saveArtifact(bytes);
  }

  async function readArtifact(ref) {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw error('INVALID_ARGUMENT', 'Invalid artifact reference');
    try { return await readFile(path.join(artifacts, ref)); }
    catch (err) { if (err.code === 'ENOENT') throw error('NOT_FOUND', 'Artifact not found'); throw err; }
  }

  const metaFile = (id) => path.join(metadata, key(id) + '.json');
  async function getMeta(id) {
    try { return await readJson(metaFile(id)); }
    catch (err) { if (err.code === 'ENOENT') throw error('NOT_FOUND', 'Installation metadata not found'); throw err; }
  }

  async function resolveVersion(kind, source, version, target) {
    if (target === 'center' && (kind === 'plugin' || kind === 'skill')) throw error('UNSUPPORTED_TARGET', 'Native plugins and skills run on Hosts');
    if (source.type === 'http') {
      if (kind !== 'mcp') throw error('INVALID_ARGUMENT', 'HTTP source requires MCP');
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw error('INVALID_ARGUMENT', 'Invalid HTTP MCP URL');
      }
      const id = 'http-' + createHash('sha256').update(url.href).digest('hex');
      return { packageVersion: { packageId: id, version: '1.0.0', kind, digest: digest(Buffer.from(url.href)),
        artifactRef: null, manifest: { actions: mcpActions }, configSchema: mcpSchema(url.href), resolved: url.href, integrity: null }, lockfile: null };
    }
    let bytes, resolved = null, integrity = null, expected = null;
    if (source.type === 'npm') {
      const split = source.spec.lastIndexOf('@');
      const suffix = split > 0 ? source.spec.slice(split + 1) : '';
      const name = split > 0 ? source.spec.slice(0, split) : source.spec;
      if (!/^(?:@[a-z0-9][a-z0-9._~-]*\x2f)?[a-z0-9][a-z0-9._~-]*$/i.test(name) ||
          (suffix && !semver.validRange(suffix) && !/^[a-z][a-z0-9._-]*$/i.test(suffix))) {
        throw error('INVALID_ARGUMENT', 'Only npm registry package specifications are supported');
      }
      // Resolve version through pacote, then fetch the exact resolved tarball.
      const selected = version ? versionSpec(source.spec, version) : source.spec;
      expected = await pacote.manifest(selected, pacoteOptions);
      if (!semver.valid(expected.version) || !expected._resolved || !expected._integrity) {
        throw error('INVALID_ARGUMENT', 'Registry package did not resolve to an immutable version');
      }
      resolved = expected._resolved;
      const resolvedUrl = new URL(resolved);
      if (!['http:', 'https:'].includes(resolvedUrl.protocol) || resolvedUrl.username || resolvedUrl.password) {
        throw error('VALIDATION_FAILED', 'Invalid registry artifact URL');
      }
      integrity = String(expected._integrity);
      bytes = await pacote.tarball.stream(resolved, async (stream) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_ARTIFACT_SIZE) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }, { ...pacoteOptions, integrity });
    } else if (source.type === 'artifact') {
      bytes = await readArtifact(source.artifactRef);
    } else throw error('INVALID_ARGUMENT', 'Unsupported package source');
    const saved = await saveArtifact(bytes);
    const temp = path.join(root, 'stage-' + randomUUID());
    try {
      await extractArtifact(bytes, temp);
      let pkg = null;
      try { pkg = await readJson(path.join(temp, 'package.json')); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (kind !== 'skill' && !pkg) throw error('VALIDATION_FAILED', 'package.json is required');
      if (expected && (pkg?.name !== expected.name || pkg?.version !== expected.version)) {
        throw error('VALIDATION_FAILED', 'Package identity does not match registry');
      }
      let manifest = {}, configSchema = { type: 'object', properties: {}, additionalProperties: false }, uiSchema;
      let packageId = pkg?.name, packageVersion = pkg?.version;
      if (kind === 'plugin') {
        manifest = await readJson(path.join(temp, 'capability.json'));
        if (!validateManifest(manifest) || !semver.valid(manifest.version)) throw error('VALIDATION_FAILED', 'Invalid native manifest');
        if (!manifest.components[target]) throw error('INVALID_ARGUMENT', 'Package has no component for target');
        if (pkg?.version !== manifest.version) throw error('VALIDATION_FAILED', 'Package version does not match native manifest');
        for (const component of Object.values(manifest.components)) await stat(containedPath(temp, component.entry));
        configSchema = await readJson(containedPath(temp, manifest.configSchema));
        if (!ajv.validateSchema(configSchema)) throw error('VALIDATION_FAILED', 'Invalid configuration schema');
        if (manifest.uiSchema) uiSchema = await readJson(containedPath(temp, manifest.uiSchema));
        packageId = manifest.id;
        packageVersion = manifest.version;
        for (const name of ['@earendil-works/pi-durable', '@earendil-works/chord', '@earendil-works/pi-ai']) {
          if (pkg.dependencies?.[name] || pkg.optionalDependencies?.[name]) {
            throw error('VALIDATION_FAILED', 'Host engine must be a peer dependency');
          }
        }
      } else if (kind === 'mcp') {
        configSchema = mcpSchema();
        manifest = { bin: pkg.bin ?? {}, actions: mcpActions };
      } else if (kind === 'skill') {
        let capability = {};
        try { capability = await readJson(path.join(temp, 'capability.json')); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        let hasRoot = false;
        try { hasRoot = (await stat(path.join(temp, 'SKILL.md'))).isFile(); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        const dirs = hasRoot ? ['.'] : capability.skills ?? pkg?.pi?.skills ?? ['.'];
        if (!Array.isArray(dirs) || !dirs.length) throw error('VALIDATION_FAILED', 'Invalid skill directories');
        let found = false;
        async function scan(dir) {
          const entries = await readdir(dir, { withFileTypes: true });
          if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) { found = true; return; }
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await scan(path.join(dir, entry.name));
          }
        }
        for (const dir of dirs) await scan(containedPath(temp, dir));
        if (!found) throw error('VALIDATION_FAILED', 'No managed SKILL.md found');
        manifest = { skills: dirs };
        packageId ||= 'skill-' + saved.artifactRef;
        packageVersion ||= '1.0.0';
      } else throw error('INVALID_ARGUMENT', 'Unknown capability kind');
      if (!packageId || !semver.valid(packageVersion)) throw error('VALIDATION_FAILED', 'Package requires an exact version');
      let lockfile = null;
      if (kind !== 'skill') {
        const lockPath = path.join(temp, 'package-lock.json');
        try { lockfile = await readJson(lockPath); }
        catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // plugin 用 --legacy-peer-deps：npm 11 解析 peer 时会把也是 direct
          // dependency 的包误标 peer:true，host npm ci --omit=peer 会漏装它；
          // mcp 沿用默认 peer 解析。
          const args = kind === 'plugin'
            ? ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']
            : ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];
          await runNpm(npmPath, args, temp);
          lockfile = await readJson(lockPath);
        }
      }
      return { packageVersion: { packageId, version: packageVersion, kind, digest: saved.digest,
        artifactRef: saved.artifactRef, manifest, configSchema, ...(uiSchema === undefined ? {} : { uiSchema }),
        resolved, integrity }, lockfile };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  function versionSpec(spec, version) {
    if (!semver.valid(version)) throw error('INVALID_ARGUMENT', 'Update requires exact version');
    const name = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1) < 0 ? undefined : spec.indexOf('@', 1))
      : spec.split('@')[0];
    return name + '@' + version;
  }

  const installer = openManagedInstaller({
    dataRoot, npmPath, fetchArtifact: readArtifact,
    withActivation,
    report: async (receipt) => {
      store.putDeploymentReceipt(receipt);
      setOperationPhase(receipt.operationId, receipt.phase, receipt.error);
    },
  });

  function enqueue(work) {
    queue = queue.then(work).catch(() => {});
  }
  function accept(action, id, request, target, deviceIds, work) {
    if (closed) throw error('INVALID_STATE', 'Package manager is closed');
    if (!request.requestId) throw error('INVALID_ARGUMENT', 'requestId is required');
    const op = { operationId: randomUUID(), requestId: request.requestId, action,
      installationId: id, target, deviceIds, phase: 'queued', error: null };
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, id: action === 'install' ? null : id, request })).digest('hex');
    const saved = store.putOperation(op, fingerprint);
    if (saved.operationId !== op.operationId) return { operationId: saved.operationId };
    enqueue(async () => {
      try { await work(op); }
      catch (err) {
        const known = ['NPM_UNAVAILABLE', 'INVALID_ARGUMENT', 'VALIDATION_FAILED', 'INVALID_STATE', 'PAYLOAD_TOO_LARGE'];
        const code = known.includes(err.code) ? err.code : 'INSTALL_FAILED';
        store.updateOperation(op.operationId, { phase: 'failed', error: { code, message: code === 'NPM_UNAVAILABLE' ? 'npm CLI is unavailable' : 'Package operation failed' } });
      }
    });
    return { operationId: op.operationId };
  }

  function planFor(installation, meta, op, deviceId, action = op.action) {
    const v = meta.versions[installation.targetVersion];
    return { protocol: 1, target: installation.target, deviceId, operationId: op.operationId,
      installationId: installation.installationId, packageId: installation.packageId, kind: installation.kind,
      targetVersion: installation.targetVersion, manifest: v.packageVersion.manifest,
      artifactRef: v.packageVersion.artifactRef, digest: v.packageVersion.digest, resolved: v.packageVersion.resolved,
      integrity: v.packageVersion.integrity, lockfile: v.lockfile, action };
  }

  function planMeaning(plan) {
    const { planId, desiredRevision, operationId, action, ...rest } = plan;
    return { ...rest, action: action === 'uninstall' ? 'uninstall' : action === 'disable' ? 'disable' : 'active' };
  }

  function savePlan(plan, previous) {
    if (previous && isDeepStrictEqual(planMeaning(previous), planMeaning(plan))) return previous;
    const next = { ...plan, planId: randomUUID(), desiredRevision: (previous?.desiredRevision ?? 0) + 1 };
    store.putDeploymentPlan(next);
    onChange(plan.installationId);
    return next;
  }

  function updateMonitoredOperation(operationId) {
    const pending = monitoring.get(operationId);
    if (!pending) return;
    const operation = store.getOperation(operationId);
    if (!operation || ['applied', 'removed', 'failed'].includes(operation.phase)) {
      monitoring.delete(operationId);
      return;
    }
    const receipts = store.listDeploymentReceipts(operation.installationId);
    const matched = pending.plans.map((plan) => {
      const current = store.listDeploymentPlans(plan.deviceId).find((item) => item.installationId === plan.installationId);
      if (!current || current.planId !== plan.planId || current.desiredRevision !== plan.desiredRevision) return { phase: 'superseded' };
      const receipt = receipts.find((item) => item.deviceId === plan.deviceId && item.planId === plan.planId &&
        item.desiredRevision === plan.desiredRevision && item.operationId === plan.operationId);
      if (!receipt && store.getOperation(plan.operationId)?.phase === 'failed') return { phase: 'failed' };
      return receipt;
    });
    if (matched.some((receipt) => receipt?.phase === 'failed' || receipt?.phase === 'superseded')) {
      store.updateOperation(operationId, { phase: 'failed', error: { code: 'INSTALL_FAILED', message: 'Deployment failed or was superseded' } });
      monitoring.delete(operationId);
    } else if (matched.every((receipt) => receipt && ['applied', 'removed'].includes(receipt.phase))) {
      setOperationPhase(operationId, operation.action === 'uninstall' ? 'removed' : 'applied', null);
      monitoring.delete(operationId);
    }
  }

  function monitorOperation(op, plans) {
    monitoring.set(op.operationId, { plans });
    updateMonitoredOperation(op.operationId);
  }

  /** Center-side distribution/preparation facts that must hold before a global enable may succeed. */
  async function prepareGlobal(id, validationBot) {
    const installation = existing(id);
    const version = store.getPackageVersion(installation.packageId, installation.targetVersion);
    if (!version || !version.manifest) throw error('PACKAGE_NOT_READY', 'Package version is not prepared');
    if (version.artifactRef) {
      try { await readArtifact(version.artifactRef); }
      catch { throw error('PACKAGE_NOT_READY', 'Package artifact is missing'); }
    }
    if (installation.target !== 'center') return;
    const installed = await installer.getInstalled(id);
    if (!installed || installed.version !== installation.targetVersion) throw error('PACKAGE_NOT_READY', 'Center package is not installed');
    if (installation.kind !== 'mcp') return;
    const global = store.getInstallationConfig(id).globalConfig;
    if (global.oauth === true) {
      // OAuth tokens stay per Bot; a chosen existing Bot is only the validation identity.
      if (!validationBot) throw error('NEEDS_AUTH', 'OAuth validation bot is required');
      const botConfig = store.getBotCapability(validationBot.deviceId, validationBot.botId, id).effectiveConfig;
      if (botConfig.oauth !== true || botConfig.url !== global.url) throw error('INVALID_ARGUMENT', 'Validation bot does not match the global MCP configuration');
    }
    try {
      await probeCenterMcp(installation, global, validationBot);
    } catch (err) {
      if (err?.code === 'NEEDS_AUTH') throw err;
      if (err?.code === 'INVALID_ARGUMENT' || err?.code === 'INVALID_STATE') throw err;
      const authLike = /auth|token|401|403/i.test(String(err?.message ?? ''));
      throw error(authLike ? 'NEEDS_AUTH' : 'MCP_UNREACHABLE', 'Center MCP validation failed');
    }
  }

  /** Writes an activation only while the change that produced it still owns the installation metadata. */
  async function applyActivation(id, value, meta) {
    const current = await getMeta(id).catch(() => null);
    if (!current || current.operationId !== meta.operationId) return false;
    store.putInstallationActivation(id, value);
    onChange(id);
    return true;
  }

  /** The enable request's operation must not report success when the global validation failed. */
  function failOperation(operationId) {
    const operation = store.getOperation(operationId);
    if (!operation || ['failed', 'removed'].includes(operation.phase)) return;
    store.updateOperation(operationId, { phase: 'failed', error: { code: 'INTERNAL_ERROR', message: 'Global enable failed' } });
  }

  /** A held operation must not publish its terminal phase before the probe finishes; progress phases pass through. */
  function setOperationPhase(operationId, phase, error) {
    const terminal = phase === 'applied' || phase === 'removed';
    if (terminal && holding.has(operationId)) {
      store.updateOperation(operationId, { phase: 'activating', error: null });
      return;
    }
    store.updateOperation(operationId, { phase, error });
  }

  /** Publishes the terminal phase only after the probe succeeded. */
  function releaseOperation(operationId) {
    const operation = store.getOperation(operationId);
    if (operation?.phase === 'activating') store.updateOperation(operationId, { phase: 'applied', error: null });
  }

  /** Settles 'enabling' into 'enabled'/'failed' from the current operation and real preparation results. */
  async function settleActivation(id, operationId) {
    if (operationId) holding.add(operationId);
    try {
      const installation = store.getInstallation(id);
      if (!installation || !installation.enabled) return false;
      const meta = await getMeta(id).catch(() => null);
      if (!meta) return false;
      const op = store.getOperation(meta.operationId);
      if (op?.phase === 'failed') return applyActivation(id, activation('failed', activationError('INTERNAL_ERROR')), meta);
      // A center deployment that has not landed yet keeps the installation in 'enabling'.
      const installed = installation.target === 'center' ? await installer.getInstalled(id).catch(() => null) : null;
      if (installation.target === 'center' && (!installed || installed.version !== installation.targetVersion)) return false;
      try {
        await prepareGlobal(id, meta.validationBot);
        const settled = await applyActivation(id, activation('enabled'), meta);
        if (settled && operationId) releaseOperation(operationId);
        return settled;
      } catch (err) {
        const settled = await applyActivation(id, activation('failed', activationError(activationCode(err))), meta);
        // Only the change operation that this settle belongs to is touched; config revalidation passes no id.
        if (settled && operationId) failOperation(operationId);
        return settled;
      }
    } finally {
      if (operationId) holding.delete(operationId);
    }
  }

  /** Global config changed after a successful enable: stop claiming success until preparation passes again. */
  function revalidate(id) {
    if (closed) return;
    enqueue(async () => {
      const installation = store.getInstallation(id);
      if (!installation || !installation.enabled) return;
      if (installation.activation?.status !== 'enabling') store.putInstallationActivation(id, activation('enabling'));
      await settleActivation(id).catch(() => {});
    });
  }

  async function dispatch(installation, meta, op) {
    if (installation.target === 'center') {
      const action = installation.enabled ? op.action : op.action === 'uninstall' ? 'uninstall' : 'disable';
      const previous = store.listDeploymentPlans(null).find((item) => item.installationId === installation.installationId);
      const plan = savePlan(planFor(installation, meta, op, null, action), previous);
      if (plan === previous) {
        monitorOperation(op, [plan]);
        return;
      }
      const pending = waiting.get(installation.installationId);
      if (pending) {
        waiting.delete(installation.installationId);
        holding.delete(pending.operationId);
        store.updateOperation(pending.operationId, { phase: 'failed', error: { code: 'INTERRUPTED', message: 'Operation superseded' } });
      }
      const receipt = await installer.apply(plan);
      setOperationPhase(op.operationId, receipt.phase, receipt.error);
      if (receipt.phase === 'waiting-idle') waiting.set(installation.installationId, { plan, operationId: op.operationId });
      if (receipt.phase === 'applied' || receipt.phase === 'removed') onChange(installation.installationId);
      return;
    }
    for (const device of op.deviceIds) await reconcileDevice(device);
    const plans = op.deviceIds.map((device) => store.listDeploymentPlans(device).find((item) => item.installationId === installation.installationId));
    if (plans.some((plan) => !plan)) throw error('INVALID_STATE', 'Deployment plan is missing');
    monitorOperation(op, plans);
  }

  async function install(request) {
    if (request.target === 'center' && (request.kind === 'plugin' || request.kind === 'skill')) {
      throw error('UNSUPPORTED_TARGET', 'Native plugins and skills run on Hosts');
    }
    const id = randomUUID();
    return accept('install', id, request, request.target, [], async (op) => {
      store.updateOperation(op.operationId, { phase: 'downloading', error: null });
      const v = await resolveVersion(request.kind, request.source, null, request.target);
      store.putPackageVersion(v.packageVersion);
      const meta = { versions: { [v.packageVersion.version]: { ...v, source: request.source } }, history: [v.packageVersion.version], operationId: op.operationId, action: 'install' };
      await atomicJson(metaFile(id), meta);
      const installation = store.putInstallation({ installationId: id, packageId: v.packageVersion.packageId,
        displayName: request.displayName, kind: request.kind, source: request.source, target: request.target,
        targetVersion: v.packageVersion.version, enabled: false, activation: activation('disabled'), revision: 0 }, null);
      onChange(id);
      await dispatch(installation, meta, op);
    });
  }

  function existing(id) {
    const value = store.getInstallation(id);
    if (!value) throw error('NOT_FOUND', 'Installation not found');
    return value;
  }

  async function change(id, request, action) {
    const installation = existing(id);
    const devices = [...new Set(store.listBotBindings({ installationId: id }).map((b) => b.deviceId))];
    return accept(action, id, request, installation.target, devices, async (op) => {
      const current = existing(id);
      const oldMeta = await getMeta(id);
      const meta = structuredClone(oldMeta);
      let targetVersion = current.targetVersion;
      let source = current.source;
      if (action === 'update') {
        store.updateOperation(op.operationId, { phase: 'downloading', error: null });
        if (!semver.valid(request.targetVersion)) throw error('INVALID_ARGUMENT', 'Update requires exact version');
        if (current.source.type === 'artifact') {
          if (request.source?.type !== 'artifact' || !request.source.artifactRef) throw error('INVALID_ARGUMENT', 'Update requires an uploaded artifact');
          source = request.source;
        } else if (current.source.type !== 'npm' || request.source) {
          throw error('INVALID_ARGUMENT', 'Invalid update source');
        }
        const v = await resolveVersion(current.kind, source, request.targetVersion, current.target);
        if (v.packageVersion.packageId !== current.packageId || v.packageVersion.version !== request.targetVersion) {
          throw error('VALIDATION_FAILED', 'Update package identity mismatch');
        }
        store.putPackageVersion(v.packageVersion);
        targetVersion = v.packageVersion.version;
        meta.versions[targetVersion] = { ...v, source };
      } else if (action === 'rollback') {
        targetVersion = meta.history.at(-2);
        if (!targetVersion) throw error('INVALID_STATE', 'No previous version');
        source = meta.versions[targetVersion].source;
      }
      if (targetVersion !== current.targetVersion) meta.history.push(targetVersion);
      meta.operationId = op.operationId;
      meta.action = action;
      if (action === 'enable') meta.validationBot = request.validationBot ? { deviceId: request.validationBot.deviceId, botId: request.validationBot.botId } : null;
      const intent = action === 'enable' ? true : action === 'disable' || action === 'uninstall' ? false : current.enabled;
      changing.add(id);
      let next;
      try {
        await atomicJson(metaFile(id), meta);
        try {
          next = store.putInstallation({ ...current, source, targetVersion, enabled: intent,
            activation: intent ? activation('enabling') : activation('disabled') }, current.revision);
        } catch (err) {
          await atomicJson(metaFile(id), oldMeta);
          throw err;
        }
      } finally { changing.delete(id); }
      onChange(id);
      // The global validation runs after dispatch, so the operation must not publish a terminal phase meanwhile.
      if (intent) holding.add(op.operationId);
      try {
        await dispatch(next, meta, op);
      } catch (err) {
        holding.delete(op.operationId);
        if (intent) await applyActivation(id, activation('failed', activationError('INTERNAL_ERROR')), meta);
        throw err;
      }
      if (intent) await settleActivation(id, op.operationId);
      else holding.delete(op.operationId);
    });
  }

  async function reconcileDeviceNow(deviceId) {
    const bindings = store.listBotBindings({ deviceId });
    const previousPlans = store.listDeploymentPlans(deviceId);
    for (const id of new Set([...bindings.map((binding) => binding.installationId), ...previousPlans.map((plan) => plan.installationId)])) {
      const installation = store.getInstallation(id);
      if (!installation || installation.target !== 'host' || changing.has(id)) continue;
      const meta = await getMeta(id);
      if (changing.has(id) || store.getInstallation(id)?.revision !== installation.revision) continue;
      const op = store.getOperation(meta.operationId);
      if (!op) continue;
      const enabled = installation.enabled && bindings.some((binding) => binding.installationId === id && binding.enabled);
      const action = enabled ? (meta.action === 'disable' || meta.action === 'uninstall' ? 'install' : meta.action)
        : meta.action === 'uninstall' ? 'uninstall' : 'disable';
      const plan = planFor(installation, meta, op, deviceId, action);
      const previous = previousPlans.find((item) => item.installationId === id);
      savePlan(plan, previous);
    }
  }

  function reconcileDevice(deviceId) {
    const previous = reconciling.get(deviceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => reconcileDeviceNow(deviceId));
    reconciling.set(deviceId, result);
    return result.finally(() => { if (reconciling.get(deviceId) === result) reconciling.delete(deviceId); });
  }

  async function listDeploymentPlans(deviceId) {
    await reconcileDevice(deviceId);
    return store.listDeploymentPlans(deviceId);
  }

  /**
   * Read-only desired plan for turn admission: never mutates shared deployment_plans, never
   * reconciles inline, and never rewrites an administrative disable/uninstall intent into install.
   * Returns the persisted authoritative plan when it targets the installation's intended
   * immutable content (cosmetic planId/operation/receipt identity does not matter for a pin).
   * Throws TURN_SYNC_FAILED when no content-matching persisted plan exists — an honest sync
   * failure the caller retries while background reconcile converges; never a fabricated identity.
   */
  async function turnPlan(deviceId, installationId) {
    const installation = store.getInstallation(installationId);
    if (!installation) throw error('NOT_FOUND', 'Installation not found');
    if (installation.target !== 'host') throw error('INVALID_STATE', 'Capability does not run on Hosts');
    const persisted = store.listDeploymentPlans(deviceId).find((plan) => plan.installationId === installationId);
    const meta = await getMeta(installationId);
    const op = store.getOperation(meta.operationId);
    if (!op) throw error('TURN_SYNC_FAILED', 'Desired package metadata is incomplete');
    const version = meta.versions[installation.targetVersion];
    if (!version) throw error('TURN_SYNC_FAILED', 'Desired package version is not prepared');
    const desired = planFor(installation, meta, op, deviceId, 'install');
    // 管理面 disable/uninstall 计划代表明确的移除意图：绝不改写成 install，
    // 视为目标集合尚未就绪，交给既有 reconcile/deployment 收敛后重试。
    if (persisted && (persisted.action === 'disable' || persisted.action === 'uninstall')) {
      throw error('TURN_SYNC_FAILED', 'Desired capability has a pending removal plan');
    }
    const sameContent = (plan) => plan &&
      plan.targetVersion === desired.targetVersion && plan.artifactRef === desired.artifactRef &&
      plan.digest === desired.digest && isDeepStrictEqual(plan.lockfile ?? null, desired.lockfile ?? null) &&
      isDeepStrictEqual(plan.manifest ?? null, desired.manifest ?? null);
    if (sameContent(persisted)) return persisted;
    throw error('TURN_SYNC_FAILED', 'Desired capability has no persisted plan');
  }

  async function checkUpdates(id) {
    const installation = existing(id);
    if (installation.source.type !== 'npm') return [];
    const spec = installation.source.spec;
    const split = spec.lastIndexOf('@');
    const name = split > 0 ? spec.slice(0, split) : spec;
    const v = await resolveVersion(installation.kind, { type: 'npm', spec: name + '@latest' }, null, installation.target);
    return semver.gt(v.packageVersion.version, installation.targetVersion) ? [v.packageVersion] : [];
  }

  // Restore the hold before recovery: an interrupted validating operation must not publish 'applied'.
  const enabling = new Set(store.listInstallations()
    .filter((installation) => installation.enabled && installation.activation?.status === 'enabling')
    .map((installation) => installation.installationId));
  const resuming = new Map();
  for (const op of store.listOperations()) {
    if (!enabling.has(op.installationId) || !VALIDATING_ACTIONS.includes(op.action) || ['applied', 'removed', 'failed'].includes(op.phase)) continue;
    holding.add(op.operationId);
    resuming.set(op.installationId, op.operationId);
  }
  for (const op of store.listOperations()) {
    if (['applied', 'removed', 'failed'].includes(op.phase)) continue;
    const devices = op.target === 'center' ? [null] : op.deviceIds;
    const plans = devices.map((deviceId) => store.listDeploymentPlans(deviceId)
      .find((plan) => plan.installationId === op.installationId && plan.operationId === op.operationId));
    if (plans.length && plans.every(Boolean)) {
      monitorOperation(op, plans);
      if (op.target === 'host' || !monitoring.has(op.operationId)) continue;
      monitoring.delete(op.operationId);
    }
    store.updateOperation(op.operationId, { phase: 'failed', error: { code: 'INTERRUPTED', message: 'Operation interrupted; retry explicitly' } });
  }
  // Finish an interrupted enable/update/rollback together with its validation; other 'enabling' settles without one.
  for (const [installationId, operationId] of resuming) {
    enqueue(async () => { await settleActivation(installationId, operationId).catch(() => {}); });
  }
  for (const installationId of enabling) {
    if (!resuming.has(installationId)) revalidate(installationId);
  }

  return {
    uploadArtifact, readArtifact, listDeploymentPlans, turnPlan, reconcileDevice, install, revalidate, setOperationPhase,
    update: (id, request) => change(id, request, 'update'),
    enable: (id, request) => change(id, request, 'enable'),
    disable: (id, request) => change(id, request, 'disable'),
    uninstall: (id, request) => change(id, request, 'uninstall'),
    rollback: (id, request) => change(id, request, 'rollback'),
    checkUpdates, getInstalled: (id) => installer.getInstalled(id),
    async close() {
      closed = true;
      clearInterval(retryTimer);
      await queue;
      await Promise.allSettled([...reconciling.values()]);
      await installer.close();
    },
  };
}
