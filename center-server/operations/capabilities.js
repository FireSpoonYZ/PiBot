// Capabilities domain handlers: Bot skills, Bot learning, Bot capability
// availability/safe overrides, installation catalog/lifecycle, safe non-secret
// global configuration, sharing, and allowlisted read-only diagnostics.
//
// Security boundaries enforced for every actor (Bot or OAuth):
// - Never trust actor fields inside tool args; always validate the authenticated actor.
// - Only call hardcoded existing owner route patterns via deps.owner().
// - Never accept arbitrary executable packages, remote URLs, artifact refs,
//   credential references, environment variables, HTTP headers, or commands.
// - Never return raw configuration objects or credential references/secrets.
// - Never expose arbitrary plugin actions; allowlist only listTools/validate/probe.
// - Always distinguish desired/enabled intent from globally effective and Host-applied state.

export const SAFE_CAPABILITY_ACTIONS = Object.freeze(['listTools', 'validate', 'probe']);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESTRICTED_KEY_EXACT = new Set([
  'credentials', 'credential', 'credentialref', 'apikey', 'apikeyref',
  'secret', 'secrets', 'token', 'tokens', 'password', 'passwd', 'passphrase',
  'privatekey', 'clientsecret', 'accesstoken', 'refreshtoken',
  'authorization', 'auth', 'oauth', 'cookie', 'cookies', 'bearer',
  'cert', 'certificate', 'pem',
  'env', 'environment', 'envrefs', 'headers', 'httpheaders', 'headerrefs',
  'command', 'cmd', 'bin', 'binary', 'args', 'argv', 'cwd', 'workdir',
  'shell', 'executable', 'script', 'scripts', 'entry', 'entrypoint',
  'path', 'filepath', 'transport',
  'url', 'baseurl', 'endpoint', 'uri', 'host', 'hostname', 'port',
  'proxy', 'proxyurl', 'origin', 'server', 'serverurl',
  'webhook', 'webhookurl', 'callbackurl', 'redirecturi', 'providers',
]);
const RESTRICTED_KEY_SUFFIX_RE = /(?:ref|refs|url|uri|endpoint|host|proxy|secret|token|password|apikey|key|auth|env|header|headers|command|cmd|cwd|path)$/i;
const RESTRICTED_KEY_SUBSTRING_RE = /(?:secret|token|password|passwd|apikey|credential|privatekey|bearer|cookie|oauth)/i;
const RESTRICTED_FORMATS = new Set([
  'credential-ref', 'uri', 'uri-reference', 'iri', 'iri-reference',
  'hostname', 'idn-hostname', 'ipv4', 'ipv6',
]);
const SAFE_SCALAR_TYPES = new Set(['boolean', 'integer', 'number', 'string']);
const SKILL_LIFECYCLE_ACTIONS = new Set(['pin', 'lock', 'archive', 'restore']);
const VISIBILITY_SCOPES = new Set(['private', 'assigned', 'global']);
const CAPABILITY_KINDS = new Set(['plugin', 'mcp', 'skill']);
const CAPABILITY_TARGETS = new Set(['host', 'center']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertArgsObject(args) {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) fail('INVALID_ARGUMENT', 'Arguments must be an object');
  return args;
}

function requireId(value, name, maxLength = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value;
}

function optionalId(value, name, maxLength = 128) {
  if (value === undefined) return undefined;
  return requireId(value, name, maxLength);
}

function requireRevision(value, name = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_ARGUMENT', `${name} must be a non-negative integer`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') {
    fail('INVALID_ARGUMENT', `${name} must be a boolean`);
  }
  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  return requireBoolean(value, name);
}

function assertActor(actor) {
  if (!isPlainObject(actor)) fail('UNAUTHENTICATED', 'Valid actor is required');
  if (actor.kind === 'bot') {
    return {
      kind: 'bot',
      deviceId: requireId(actor.deviceId, 'actor.deviceId'),
      botId: requireId(actor.botId, 'actor.botId'),
    };
  }
  if (actor.kind === 'oauth') {
    return {
      kind: 'oauth',
      clientId: requireId(actor.clientId, 'actor.clientId'),
    };
  }
  fail('UNAUTHENTICATED', 'Unsupported actor kind');
}

function resolveBotTarget(args, actor) {
  const hasDevice = args.deviceId !== undefined;
  const hasBot = args.botId !== undefined;
  if (hasDevice !== hasBot) {
    fail('INVALID_ARGUMENT', 'deviceId and botId must be provided together');
  }
  if (hasDevice && hasBot) {
    return {
      deviceId: requireId(args.deviceId, 'deviceId'),
      botId: requireId(args.botId, 'botId'),
    };
  }
  if (actor.kind === 'bot') {
    return { deviceId: actor.deviceId, botId: actor.botId };
  }
  fail('INVALID_ARGUMENT', 'deviceId and botId are required');
}

function resolveOptionalBotTarget(args) {
  const hasDevice = args.deviceId !== undefined;
  const hasBot = args.botId !== undefined;
  if (hasDevice !== hasBot) {
    fail('INVALID_ARGUMENT', 'deviceId and botId must be provided together');
  }
  if (!hasDevice) return null;
  return {
    deviceId: requireId(args.deviceId, 'deviceId'),
    botId: requireId(args.botId, 'botId'),
  };
}

function fallbackVisibleToBot(installation, deviceId, botId) {
  if (!installation?.ownerBot) return true;
  const scope = installation.visibilityScope ?? 'private';
  if (scope === 'private') {
    return installation.ownerBot.deviceId === deviceId && installation.ownerBot.botId === botId;
  }
  return true;
}

function isVisibleToBot(store, installation, deviceId, botId) {
  if (typeof store?.isVisibleToBot === 'function') {
    return Boolean(store.isVisibleToBot(installation, deviceId, botId));
  }
  return fallbackVisibleToBot(installation, deviceId, botId);
}

function isInstallationVisibleToActor(store, installation, actor) {
  if (actor.kind === 'oauth') return true;
  return isVisibleToBot(store, installation, actor.deviceId, actor.botId);
}

function assertInstallationMutableByActor(store, installation, actor, { allowOwnerSkillShare = false } = {}) {
  if (actor.kind === 'oauth') return;
  if (!isVisibleToBot(store, installation, actor.deviceId, actor.botId)) {
    fail('NOT_FOUND', 'Installation not found');
  }
  const isOwnedByActor = Boolean(
    installation.ownerBot
    && installation.ownerBot.deviceId === actor.deviceId
    && installation.ownerBot.botId === actor.botId,
  );
  if (allowOwnerSkillShare && installation.ownerBot) {
    if (!isOwnedByActor) {
      fail('FORBIDDEN', 'Only the owning Bot or owner authority may change skill sharing');
    }
    return;
  }
  if (installation.ownerBot && !isOwnedByActor) {
    fail('FORBIDDEN', 'Installation is owned by another Bot');
  }
  if (typeof store?.listBotBindings === 'function') {
    const bindings = store.listBotBindings({ installationId: installation.installationId });
    const hasOutsideBinding = bindings.some(
      (binding) => binding.deviceId !== actor.deviceId || binding.botId !== actor.botId,
    );
    if (hasOutsideBinding) {
      fail('FORBIDDEN', 'Installation is bound to other Bots; global mutation requires owner authority');
    }
  }
}

// --- Safe Configuration Classification, Sanitization & Patching ---

function isRestrictedKeyName(key) {
  const lower = String(key).toLowerCase();
  return RESTRICTED_KEY_EXACT.has(lower)
    || RESTRICTED_KEY_SUFFIX_RE.test(key)
    || RESTRICTED_KEY_SUBSTRING_RE.test(lower);
}

function schemaTypesOf(node) {
  if (!isPlainObject(node)) return [];
  if (typeof node.type === 'string') return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((item) => typeof item === 'string');
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.flatMap((branch) => schemaTypesOf(branch));
  }
  return [];
}

function schemaAllowsNull(node) {
  return schemaTypesOf(node).includes('null');
}

function isSafePrimitiveNode(node, key) {
  if (!isPlainObject(node)) return false;
  if (key !== null && isRestrictedKeyName(key)) return false;
  if (typeof node.format === 'string' && RESTRICTED_FORMATS.has(node.format)) return false;
  const nonNullTypes = schemaTypesOf(node).filter((type) => type !== 'null');
  if (!nonNullTypes.length) return false;
  if (nonNullTypes.every((type) => SAFE_SCALAR_TYPES.has(type))) return true;
  if (nonNullTypes.length === 1 && nonNullTypes[0] === 'array') {
    return isSafePrimitiveNode(node.items, null);
  }
  return false;
}

function isClosedObjectSchema(node) {
  if (!isPlainObject(node)) return false;
  const nonNullTypes = schemaTypesOf(node).filter((type) => type !== 'null');
  if (nonNullTypes.length !== 1 || nonNullTypes[0] !== 'object') return false;
  if (node.additionalProperties === true || isPlainObject(node.additionalProperties)) return false;
  return isPlainObject(node.properties);
}

function isSafeObjectNode(node, key) {
  if (key !== null && isRestrictedKeyName(key)) return false;
  if (!isClosedObjectSchema(node)) return false;
  return Object.entries(node.properties).some(
    ([childKey, childSchema]) => !FORBIDDEN_KEYS.has(childKey)
      && (isSafePrimitiveNode(childSchema, childKey) || isSafeObjectNode(childSchema, childKey)),
  );
}

function isSafeSchemaNode(node, key) {
  return isSafePrimitiveNode(node, key) || isSafeObjectNode(node, key);
}

function pointerSegment(segment) {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectCredentialSlots(store, schema, value, pointer = '') {
  if (!isPlainObject(schema)) return [];
  if (schema.format === 'credential-ref') {
    const ref = typeof value === 'string' && value.length > 0 ? value : null;
    const record = ref && typeof store?.getCredential === 'function' ? store.getCredential(ref) : null;
    return [{
      path: pointer || '/',
      refSet: Boolean(ref),
      configured: record?.configured === true,
      revision: record?.revision ?? null,
    }];
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    return value.flatMap((item, index) =>
      collectCredentialSlots(store, schema.items, item, `${pointer}/${index}`),
    );
  }
  const properties = isPlainObject(schema.properties) ? { ...schema.properties } : {};
  if (isPlainObject(schema.additionalProperties) && isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (!FORBIDDEN_KEYS.has(key) && properties[key] === undefined) {
        properties[key] = schema.additionalProperties;
      }
    }
  }
  return Object.entries(properties).flatMap(([key, childSchema]) =>
    FORBIDDEN_KEYS.has(key)
      ? []
      : collectCredentialSlots(
          store,
          childSchema,
          isPlainObject(value) && Object.hasOwn(value, key) ? value[key] : undefined,
          `${pointer}/${pointerSegment(key)}`,
        ),
  );
}

function sanitizeCredentialRefsList(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map((entry) => ({
    path: typeof entry?.path === 'string' ? entry.path : '/',
    refSet: Boolean(entry?.credentialRef),
    configured: entry?.configured === true,
    revision: entry?.revision ?? null,
  }));
}

function isConfiguredRestrictedValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function inspectAndSanitizeConfig(schema, rawValue, store) {
  const editableFields = [];
  const restrictedFields = [];
  const configuredRestrictedFields = [];

  function walkObject(objectSchema, currentValue, prefix) {
    const safeObj = {};
    const safeProps = {};
    if (!isClosedObjectSchema(objectSchema)) {
      return {
        safeObj,
        safeSchema: { type: 'object', properties: {}, additionalProperties: false },
      };
    }
    const rawObj = isPlainObject(currentValue) ? currentValue : {};
    for (const [key, childSchema] of Object.entries(objectSchema.properties)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const dotted = prefix ? `${prefix}.${key}` : key;
      const hasRaw = Object.hasOwn(rawObj, key);
      const rawChild = hasRaw ? rawObj[key] : undefined;

      if (isSafePrimitiveNode(childSchema, key)) {
        editableFields.push(dotted);
        safeProps[key] = structuredClone(childSchema);
        if (hasRaw && rawChild !== undefined) {
          safeObj[key] = structuredClone(rawChild);
        }
        continue;
      }

      if (isSafeObjectNode(childSchema, key)) {
        const nested = walkObject(childSchema, rawChild, dotted);
        safeProps[key] = nested.safeSchema;
        if (hasRaw && isPlainObject(rawChild)) {
          safeObj[key] = nested.safeObj;
        }
        continue;
      }

      restrictedFields.push(dotted);
      if (hasRaw && isConfiguredRestrictedValue(rawChild)) {
        configuredRestrictedFields.push(dotted);
      }
    }
    const safeRequired = Array.isArray(objectSchema.required)
      ? objectSchema.required.filter((key) => Object.hasOwn(safeProps, key))
      : [];
    const safeSchema = {
      type: 'object',
      properties: safeProps,
      ...(safeRequired.length ? { required: safeRequired } : {}),
      additionalProperties: false,
    };
    return { safeObj, safeSchema };
  }

  const root = walkObject(schema, rawValue, '');
  return {
    safeConfig: root.safeObj,
    safeConfigSchema: root.safeSchema,
    editableFields: editableFields.sort(),
    restrictedFields: restrictedFields.sort(),
    configuredRestrictedFields: configuredRestrictedFields.sort(),
    credentialSlots: collectCredentialSlots(store, schema, rawValue),
  };
}

function validateSafeLeafValue(node, value, pathLabel) {
  if (value === null) {
    if (schemaAllowsNull(node)) return;
    fail('VALIDATION_FAILED', `Field '${pathLabel}' cannot be null`);
  }
  const nonNullTypes = schemaTypesOf(node).filter((type) => type !== 'null');
  const matchesType = nonNullTypes.some((type) => {
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'string') return typeof value === 'string';
    if (type === 'array') {
      if (!Array.isArray(value)) return false;
      return value.every((item, idx) => {
        validateSafeLeafValue(node.items, item, `${pathLabel}[${idx}]`);
        return true;
      });
    }
    return false;
  });
  if (!matchesType) {
    fail('VALIDATION_FAILED', `Invalid value type for field '${pathLabel}'`);
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    fail('VALIDATION_FAILED', `Invalid enum value for field '${pathLabel}'`);
  }
  if (typeof value === 'string') {
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      fail('VALIDATION_FAILED', `Field '${pathLabel}' is shorter than minimum length`);
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      fail('VALIDATION_FAILED', `Field '${pathLabel}' exceeds maximum length`);
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) {
      fail('VALIDATION_FAILED', `Field '${pathLabel}' is below minimum`);
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      fail('VALIDATION_FAILED', `Field '${pathLabel}' exceeds maximum`);
    }
  }
}

function applySafeConfigPatch(configSchema, currentRawConfig, patch, { requireNonEmpty = false } = {}) {
  if (!isPlainObject(patch)) {
    fail('INVALID_ARGUMENT', 'Configuration patch must be an object');
  }
  const patchKeys = Object.keys(patch);
  if (requireNonEmpty && patchKeys.length === 0) {
    fail('INVALID_ARGUMENT', 'Configuration patch must specify at least one safe field');
  }

  function mergeObject(objectSchema, existingObj, patchObj, prefix) {
    const next = isPlainObject(existingObj) ? structuredClone(existingObj) : {};
    if (!isClosedObjectSchema(objectSchema)) {
      if (Object.keys(patchObj).length > 0) {
        fail('FORBIDDEN', `Configuration section '${prefix || 'root'}' has no editable safe fields`);
      }
      return next;
    }
    for (const [key, patchVal] of Object.entries(patchObj)) {
      if (FORBIDDEN_KEYS.has(key)) {
        fail('INVALID_ARGUMENT', `Forbidden configuration key '${key}'`);
      }
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (!Object.hasOwn(objectSchema.properties, key)) {
        if (isRestrictedKeyName(key)) {
          fail('FORBIDDEN', `Field '${dotted}' is restricted and can only be configured in Center UI`);
        }
        fail('VALIDATION_FAILED', `Unknown configuration field '${dotted}'`);
      }
      const childSchema = objectSchema.properties[key];
      if (!isSafeSchemaNode(childSchema, key)) {
        fail('FORBIDDEN', `Field '${dotted}' is restricted and can only be configured in Center UI`);
      }
      if (isSafeObjectNode(childSchema, key)) {
        if (patchVal === null) {
          if (schemaAllowsNull(childSchema)) {
            next[key] = null;
          } else {
            delete next[key];
          }
          continue;
        }
        if (!isPlainObject(patchVal)) {
          fail('VALIDATION_FAILED', `Field '${dotted}' must be an object`);
        }
        next[key] = mergeObject(childSchema, next[key], patchVal, dotted);
        continue;
      }
      if (patchVal === null && !schemaAllowsNull(childSchema)) {
        delete next[key];
        continue;
      }
      validateSafeLeafValue(childSchema, patchVal, dotted);
      next[key] = structuredClone(patchVal);
    }
    return next;
  }

  return mergeObject(configSchema, currentRawConfig, patch, '');
}

// --- Sanitizers & Effective State ---

function sanitizeSource(source) {
  if (!isPlainObject(source)) return { type: 'unknown' };
  if (source.type === 'npm' && typeof source.spec === 'string') {
    return { type: 'npm', spec: source.spec };
  }
  if (source.type === 'artifact') {
    return { type: 'artifact' };
  }
  if (source.type === 'http') {
    return { type: 'http' };
  }
  return { type: typeof source.type === 'string' ? source.type : 'unknown' };
}

function sanitizeInstallation(installation) {
  if (!isPlainObject(installation)) return null;
  const globalEnabled = Boolean(installation.enabled);
  const activationStatus = installation.activation?.status ?? (globalEnabled ? 'enabled' : 'disabled');
  const globallyEffective = Boolean(globalEnabled && activationStatus === 'enabled');
  return {
    installationId: installation.installationId,
    packageId: installation.packageId,
    displayName: installation.displayName,
    kind: installation.kind,
    target: installation.target,
    targetVersion: installation.targetVersion,
    source: sanitizeSource(installation.source),
    revision: installation.revision,
    ...(installation.ownerBot
      ? {
          ownerBot: {
            deviceId: installation.ownerBot.deviceId,
            botId: installation.ownerBot.botId,
            ...(installation.ownerBot.skillId ? { skillId: installation.ownerBot.skillId } : {}),
            ...(installation.ownerBot.skillName ? { skillName: installation.ownerBot.skillName } : {}),
          },
        }
      : {}),
    visibilityScope: installation.visibilityScope ?? (installation.ownerBot ? 'private' : 'global'),
    globalEnabled,
    activationStatus,
    activationError: installation.activation?.error ?? null,
    activationUpdatedAt: installation.activation?.updatedAt ?? null,
    globallyEffective,
  };
}

function computeBotCapabilityState(store, installation, binding, deviceId, botId) {
  const sanitizedInst = sanitizeInstallation(installation);
  const visibleToBot = isVisibleToBot(store, installation, deviceId, botId);
  const botEnabled = Boolean(binding?.enabled);
  const effectivelyEnabled = Boolean(visibleToBot && sanitizedInst.globallyEffective && botEnabled);
  const bound = typeof store?.listBotBindings === 'function'
    ? store.listBotBindings({ deviceId, installationId: installation.installationId })
      .some((item) => item.botId === botId)
    : Boolean(binding && (binding.revision > 0 || binding.enabled));

  let deploymentStatus = !effectivelyEnabled ? (bound ? 'disabled' : 'not-bound') : 'unknown';
  let runtimeApplied = false;
  let deploymentReceipt = null;
  let runtimeReceipt = null;

  if (
    effectivelyEnabled
    && typeof store?.listDeploymentPlans === 'function'
    && typeof store?.listDeploymentReceipts === 'function'
    && typeof store?.getDeviceRuntimeStatus === 'function'
    && typeof store?.getRuntimeReceipt === 'function'
  ) {
    const deploymentDevice = installation.target === 'center' ? null : deviceId;
    const plan = store.listDeploymentPlans(deploymentDevice)
      .find((item) => item.installationId === installation.installationId) ?? null;
    deploymentReceipt = store.listDeploymentReceipts(installation.installationId)
      .filter((item) => item.deviceId === deploymentDevice)
      .find((item) => item.planId === plan?.planId) ?? null;
    const runtime = store.getDeviceRuntimeStatus(deviceId, false);
    const lastRuntime = store.getRuntimeReceipt(deviceId);
    const botReceipt = lastRuntime?.bots?.find((item) => item.botId === botId) ?? null;
    runtimeReceipt = botReceipt
      ? {
          botId,
          desiredRevision: botReceipt.desiredRevision,
          appliedRevision: botReceipt.appliedRevision,
          status: botReceipt.status,
        }
      : null;
    const currentBotReceipt = botReceipt?.desiredRevision === runtime.desiredRevision;
    const packageApplied = Boolean(
      plan
      && deploymentReceipt?.phase === 'applied'
      && deploymentReceipt.health === 'ready'
      && deploymentReceipt.appliedRevision === plan.desiredRevision
      && deploymentReceipt.actualVersion === installation.targetVersion
      && plan.targetVersion === installation.targetVersion
      && !['disable', 'uninstall'].includes(plan.action),
    );
    const configApplied = Boolean(
      currentBotReceipt
      && botReceipt.status === 'applied'
      && botReceipt.appliedRevision === runtime.desiredRevision,
    );
    deploymentStatus =
      deploymentReceipt?.phase === 'failed' || (currentBotReceipt && botReceipt.status === 'failed')
        ? 'failed'
        : packageApplied && configApplied
          ? 'deployed'
          : deploymentReceipt
            ? 'stale'
            : 'not-deployed';
    runtimeApplied = Boolean(packageApplied && configApplied);
  }

  return {
    bound,
    visibleToBot,
    globalEnabled: sanitizedInst.globalEnabled,
    activationStatus: sanitizedInst.activationStatus,
    globallyEffective: sanitizedInst.globallyEffective,
    botEnabled,
    effectivelyEnabled,
    deploymentStatus,
    runtimeApplied,
    deploymentReceipt,
    runtimeReceipt,
  };
}

function sanitizeBotCapabilityView(store, installation, binding, deviceId, botId) {
  const schema = binding?.configSchema ?? { type: 'object', properties: {}, additionalProperties: false };
  const globalSanitized = inspectAndSanitizeConfig(schema, binding?.globalConfig, store);
  const overridesSanitized = inspectAndSanitizeConfig(schema, binding?.overrides, store);
  const effectiveSanitized = inspectAndSanitizeConfig(schema, binding?.effectiveConfig, store);
  const state = computeBotCapabilityState(store, installation, binding, deviceId, botId);

  return {
    deviceId,
    botId,
    installation: sanitizeInstallation(installation),
    bindingRevision: binding?.revision ?? 0,
    ...state,
    safeGlobalConfig: globalSanitized.safeConfig,
    safeOverrides: overridesSanitized.safeConfig,
    safeEffectiveConfig: effectiveSanitized.safeConfig,
    safeConfigSchema: effectiveSanitized.safeConfigSchema,
    editableFields: effectiveSanitized.editableFields,
    restrictedFields: effectiveSanitized.restrictedFields,
    configuredRestrictedFields: effectiveSanitized.configuredRestrictedFields,
    credentialSlots: effectiveSanitized.credentialSlots,
  };
}

function sanitizeCheckOrProbeResult(store, rawResult, installation) {
  const sanitizedInst = sanitizeInstallation(installation ?? rawResult?.installation);
  const config = rawResult?.configuration ?? {};
  const deployment = rawResult?.deployment ?? {};
  const deploymentStatus = deployment.status ?? 'unknown';
  return {
    installation: sanitizedInst,
    configured: Boolean(rawResult?.configured),
    configuration: {
      schemaValid: Boolean(config.schemaValid),
      globalRevision: config.globalRevision ?? null,
      bindingRevision: config.bindingRevision ?? null,
      effectivelyEnabled: Boolean(config.enabled),
      credentialSlots: sanitizeCredentialRefsList(config.credentialRefs),
      desiredRevision: config.desiredRevision ?? null,
      appliedRevision: config.appliedRevision ?? null,
      receipt: config.receipt ?? null,
    },
    deployment: {
      status: deploymentStatus,
      runtimeApplied: deploymentStatus === 'deployed',
      desiredRevision: deployment.desiredRevision ?? null,
      planId: deployment.planId ?? null,
      receipt: deployment.receipt ?? null,
    },
    ...(rawResult?.probe ? { probe: rawResult.probe } : {}),
    ...(typeof rawResult?.guidance === 'string' ? { guidance: rawResult.guidance } : {}),
  };
}

function sanitizeSkillFilesWriteMap(rawFiles) {
  if (!isPlainObject(rawFiles)) {
    fail('INVALID_ARGUMENT', 'files must be an object mapping relative paths to UTF-8 strings');
  }
  const files = {};
  for (const [key, value] of Object.entries(rawFiles)) {
    if (FORBIDDEN_KEYS.has(key)) fail('INVALID_ARGUMENT', `Invalid file path '${key}'`);
    if (typeof value !== 'string') {
      fail('INVALID_ARGUMENT', `File '${key}' content must be a UTF-8 string`);
    }
    files[key] = value;
  }
  return files;
}

function sanitizeSkillFilesPatchMap(rawFiles) {
  if (!isPlainObject(rawFiles)) {
    fail('INVALID_ARGUMENT', 'files must be an object mapping relative paths to UTF-8 strings or null');
  }
  const files = {};
  for (const [key, value] of Object.entries(rawFiles)) {
    if (FORBIDDEN_KEYS.has(key)) fail('INVALID_ARGUMENT', `Invalid file path '${key}'`);
    if (value !== null && typeof value !== 'string') {
      fail('INVALID_ARGUMENT', `File '${key}' content must be a UTF-8 string or null`);
    }
    files[key] = value;
  }
  return files;
}

function sanitizeLearningConfigPatch(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    fail('VALIDATION_FAILED', 'config must be an object');
  }
  const allowedTop = new Set(['reviewModelRef', 'curatorModelRef', 'review', 'curator', 'budget']);
  const out = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (!allowedTop.has(key)) {
      fail('VALIDATION_FAILED', `Unknown learning config field '${key}'`);
    }
    if (key === 'reviewModelRef' || key === 'curatorModelRef') {
      if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 512)) {
        fail('VALIDATION_FAILED', `Invalid ${key}`);
      }
      out[key] = value;
    } else if (key === 'review') {
      if (!isPlainObject(value)) fail('VALIDATION_FAILED', 'review must be an object');
      const section = {};
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subKey !== 'memoryEvery' && subKey !== 'skillEvery') {
          fail('VALIDATION_FAILED', `Unknown review field '${subKey}'`);
        }
        section[subKey] = subVal;
      }
      out.review = section;
    } else if (key === 'curator') {
      if (!isPlainObject(value)) fail('VALIDATION_FAILED', 'curator must be an object');
      const allowed = new Set(['intervalHours', 'minIdleHours', 'staleAfterDays', 'archiveAfterDays', 'consolidate']);
      const section = {};
      for (const [subKey, subVal] of Object.entries(value)) {
        if (!allowed.has(subKey)) {
          fail('VALIDATION_FAILED', `Unknown curator field '${subKey}'`);
        }
        section[subKey] = subVal;
      }
      out.curator = section;
    } else if (key === 'budget') {
      if (!isPlainObject(value)) fail('VALIDATION_FAILED', 'budget must be an object');
      const allowed = new Set(['maxIterations', 'maxInputTokens', 'callTimeoutMs', 'jobTimeoutMs', 'pollTimeoutMs']);
      const section = {};
      for (const [subKey, subVal] of Object.entries(value)) {
        if (!allowed.has(subKey)) {
          fail('VALIDATION_FAILED', `Unknown budget field '${subKey}'`);
        }
        section[subKey] = subVal;
      }
      out.budget = section;
    }
  }
  return out;
}

function deploymentSummaryForSkill(store, target, installation, binding) {
  if (!installation) return { status: 'not-published' };
  const sanitized = sanitizeInstallation(installation);
  if (!sanitized?.globallyEffective || !binding?.enabled) return { status: 'disabled' };
  if (typeof store?.listDeploymentPlans !== 'function' || typeof store?.listDeploymentReceipts !== 'function') {
    return { status: 'unknown' };
  }
  const plan = store.listDeploymentPlans(target.deviceId)
    .find((item) => item.installationId === installation.installationId);
  if (!plan) return { status: 'pending' };
  if (plan.targetVersion !== installation.targetVersion || ['disable', 'uninstall'].includes(plan.action)) {
    return { status: 'superseded' };
  }
  const receipt = store.listDeploymentReceipts(installation.installationId)
    .find((item) => item.deviceId === target.deviceId);
  return receipt
    ? { status: receipt.phase, ...(receipt.error ? { error: receipt.error } : {}) }
    : { status: 'queued' };
}

function enrichSkillSummary(store, target, skillItem, reviewItem) {
  const merged = reviewItem ? { ...skillItem, ...reviewItem } : { ...skillItem };
  const installation = merged.installationId && typeof store?.getInstallation === 'function'
    ? store.getInstallation(merged.installationId)
    : null;
  const binding = installation && typeof store?.getBotCapability === 'function'
    ? store.getBotCapability(target.deviceId, target.botId, installation.installationId)
    : null;
  const sanitizedInst = installation ? sanitizeInstallation(installation) : null;
  const botEnabled = Boolean(binding?.enabled);
  const globallyEffective = Boolean(sanitizedInst?.globallyEffective);
  const effectivelyEnabled = Boolean(merged.state !== 'archived' && globallyEffective && botEnabled);
  const deployment = merged.deployment ?? deploymentSummaryForSkill(store, target, installation, binding);
  return {
    ...merged,
    visibilityScope: merged.visibilityScope ?? sanitizedInst?.visibilityScope ?? 'private',
    globalEnabled: sanitizedInst?.globalEnabled ?? false,
    globallyEffective,
    botEnabled,
    effectivelyEnabled,
    deployment,
    deploymentApplied: deployment?.status === 'applied',
  };
}

function formatAcceptedOperation(store, action, installationId, accepted) {
  const operationId = accepted?.operationId ?? null;
  const operation = operationId && typeof store?.getOperation === 'function'
    ? store.getOperation(operationId)
    : null;
  const installation = typeof store?.getInstallation === 'function'
    ? store.getInstallation(installationId)
    : null;
  return {
    accepted: true,
    action,
    installationId,
    operationId,
    operation,
    installation: sanitizeInstallation(installation),
  };
}

export function createHandlers(deps) {
  if (!deps || typeof deps.owner !== 'function') {
    throw new Error('deps.owner is required');
  }
  const { owner, store, execution } = deps;

  function assertTargetBotExists(target) {
    if (
      typeof store?.listDeviceBots === 'function'
      && !store.listDeviceBots(target.deviceId).some((bot) => bot.botId === target.botId)
    ) {
      fail('NOT_FOUND', 'Bot not found');
    }
  }

  async function fetchInstallationForActor(installationId, actor) {
    const installation = await owner('GET', '/api/installations/:id', {
      params: { id: installationId },
      query: {},
    });
    if (!isInstallationVisibleToActor(store, installation, actor)) {
      fail('NOT_FOUND', 'Installation not found');
    }
    return installation;
  }

  return {
    // --- Bot Skills ---
    async capability_skill_list(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const includeArchived = optionalBoolean(args.includeArchived, 'includeArchived') ?? true;

      const [listed, reviewed] = await Promise.all([
        owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
          params: target,
          body: { action: 'list' },
          query: {},
        }),
        owner('POST', '/api/devices/:deviceId/bots/:botId/skill-reviews', {
          params: target,
          body: { action: 'list', includeArchived },
          query: {},
        }),
      ]);

      const reviewById = new Map(
        (Array.isArray(reviewed?.items) ? reviewed.items : []).map((item) => [item.skillId, item]),
      );
      const managed = (Array.isArray(listed?.skills) ? listed.skills : [])
        .filter((item) => includeArchived || item.state !== 'archived')
        .map((item) => enrichSkillSummary(store, target, item, reviewById.get(item.skillId)));

      const installed = (Array.isArray(listed?.installed) ? listed.installed : []).map((item) => {
        const botEnabled = Boolean(item.enabled);
        const globallyEffective = Boolean(item.activated);
        return {
          ...item,
          botEnabled,
          globallyEffective,
          effectivelyEnabled: Boolean(botEnabled && globallyEffective),
        };
      });

      return {
        deviceId: target.deviceId,
        botId: target.botId,
        managed,
        installed,
      };
    },

    async capability_skill_read(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const skillId = optionalId(args.skillId, 'skillId');
      const name = optionalId(args.name, 'name');
      const installationId = optionalId(args.installationId, 'installationId');
      const skillName = optionalId(args.skillName, 'skillName');
      const path = optionalId(args.path, 'path', 240);

      if (!skillId && !name && !installationId) {
        fail('INVALID_ARGUMENT', 'Provide skillId, name, or installationId');
      }

      const body = {
        action: 'read',
        ...(skillId !== undefined ? { skillId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(installationId !== undefined ? { installationId } : {}),
        ...(skillName !== undefined ? { skillName } : {}),
        ...(path !== undefined ? { path } : {}),
      };
      const result = await owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
        params: target,
        body,
        query: {},
      });
      if (result?.source === 'installed') {
        const botEnabled = Boolean(result.enabled);
        const globallyEffective = Boolean(result.activated);
        return {
          ...result,
          botEnabled,
          globallyEffective,
          effectivelyEnabled: Boolean(botEnabled && globallyEffective),
        };
      }
      return enrichSkillSummary(store, target, result, null);
    },

    async capability_skill_create(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const name = requireId(args.name, 'name', 64);
      const hasContent = args.content !== undefined;
      const hasFiles = args.files !== undefined;
      if (!hasContent && !hasFiles) {
        fail('INVALID_ARGUMENT', 'Provide either content or files');
      }
      if (hasContent && hasFiles) {
        fail('INVALID_ARGUMENT', 'Provide either content or files, not both');
      }

      const body = { action: 'create', name };
      if (hasContent) {
        if (typeof args.content !== 'string' || !args.content.trim()) {
          fail('INVALID_ARGUMENT', 'content must be a non-empty string');
        }
        body.content = args.content;
      } else {
        body.files = sanitizeSkillFilesWriteMap(args.files);
      }
      if (args.category !== undefined) body.category = requireId(args.category, 'category', 64);
      if (args.description !== undefined) body.description = requireId(args.description, 'description', 1024);
      if (args.requestId !== undefined) body.requestId = requireId(args.requestId, 'requestId');

      const result = await owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
        params: target,
        body,
        query: {},
      });
      return enrichSkillSummary(store, target, result, null);
    },

    async capability_skill_edit(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const mode = args.mode;
      if (mode !== 'update' && mode !== 'patch') {
        fail('INVALID_ARGUMENT', 'mode must be "update" or "patch"');
      }
      const skillId = optionalId(args.skillId, 'skillId');
      const name = optionalId(args.name, 'name');
      if (!skillId && !name) {
        fail('INVALID_ARGUMENT', 'skillId or name is required');
      }

      const body = {
        action: mode,
        ...(skillId !== undefined ? { skillId } : {}),
        ...(name !== undefined ? { name } : {}),
      };
      if (args.requestId !== undefined) body.requestId = requireId(args.requestId, 'requestId');

      if (mode === 'update') {
        if (args.oldText !== undefined || args.newText !== undefined || args.replaceAll !== undefined) {
          fail('INVALID_ARGUMENT', 'oldText, newText, and replaceAll are only valid for mode="patch"');
        }
        const hasFiles = args.files !== undefined;
        const hasPath = args.path !== undefined;
        const hasDescription = args.description !== undefined;
        if (!hasFiles && !hasPath && !hasDescription) {
          fail('INVALID_ARGUMENT', 'mode="update" requires files, path+content, or description');
        }
        if (hasFiles) body.files = sanitizeSkillFilesPatchMap(args.files);
        if (hasPath) {
          body.path = requireId(args.path, 'path', 240);
          if (args.content === undefined) {
            fail('INVALID_ARGUMENT', 'mode="update" with path requires content (string or null)');
          }
          if (args.content !== null && typeof args.content !== 'string') {
            fail('INVALID_ARGUMENT', 'content must be a UTF-8 string or null');
          }
          body.content = args.content;
        } else if (args.content !== undefined) {
          fail('INVALID_ARGUMENT', 'content requires path in mode="update"');
        }
        if (hasDescription) body.description = requireId(args.description, 'description', 1024);
      } else {
        if (args.files !== undefined || args.content !== undefined || args.description !== undefined) {
          fail('INVALID_ARGUMENT', 'files, content, and description are only valid for mode="update"');
        }
        if (typeof args.oldText !== 'string' || !args.oldText) {
          fail('INVALID_ARGUMENT', 'oldText is required for mode="patch"');
        }
        if (typeof args.newText !== 'string') {
          fail('INVALID_ARGUMENT', 'newText must be a string for mode="patch"');
        }
        body.oldText = args.oldText;
        body.newText = args.newText;
        if (args.path !== undefined) body.path = requireId(args.path, 'path', 240);
        if (args.replaceAll !== undefined) body.replaceAll = requireBoolean(args.replaceAll, 'replaceAll');
      }

      const result = await owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
        params: target,
        body,
        query: {},
      });
      return enrichSkillSummary(store, target, result, null);
    },

    async capability_skill_adopt(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const installationId = optionalId(args.installationId, 'installationId');
      const name = optionalId(args.name, 'name');
      if (!installationId && !name) {
        fail('INVALID_ARGUMENT', 'installationId or name is required');
      }
      const body = {
        action: 'adopt',
        ...(installationId !== undefined ? { installationId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(args.newName !== undefined ? { newName: requireId(args.newName, 'newName', 64) } : {}),
        ...(args.requestId !== undefined ? { requestId: requireId(args.requestId, 'requestId') } : {}),
      };
      const result = await owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
        params: target,
        body,
        query: {},
      });
      return enrichSkillSummary(store, target, result, null);
    },

    async capability_skill_lifecycle(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const action = args.action;
      if (typeof action !== 'string' || !SKILL_LIFECYCLE_ACTIONS.has(action)) {
        fail('INVALID_ARGUMENT', 'action must be one of: pin, lock, archive, restore');
      }
      const skillId = optionalId(args.skillId, 'skillId');
      const name = optionalId(args.name, 'name');
      if (!skillId && !name) {
        fail('INVALID_ARGUMENT', 'skillId or name is required');
      }

      const body = {
        action,
        ...(skillId !== undefined ? { skillId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(args.requestId !== undefined ? { requestId: requireId(args.requestId, 'requestId') } : {}),
      };

      if (action === 'pin') {
        if (args.locked !== undefined || args.forceUnshare !== undefined) {
          fail('INVALID_ARGUMENT', 'locked and forceUnshare are not valid for action="pin"');
        }
        body.pinned = requireBoolean(args.pinned, 'pinned');
      } else if (action === 'lock') {
        if (args.pinned !== undefined || args.forceUnshare !== undefined) {
          fail('INVALID_ARGUMENT', 'pinned and forceUnshare are not valid for action="lock"');
        }
        body.locked = requireBoolean(args.locked, 'locked');
      } else if (action === 'archive') {
        if (args.pinned !== undefined || args.locked !== undefined) {
          fail('INVALID_ARGUMENT', 'pinned and locked are not valid for action="archive"');
        }
        if (args.forceUnshare !== undefined) {
          body.forceUnshare = requireBoolean(args.forceUnshare, 'forceUnshare');
        }
      } else if (action === 'restore') {
        if (args.pinned !== undefined || args.locked !== undefined || args.forceUnshare !== undefined) {
          fail('INVALID_ARGUMENT', 'pinned, locked, and forceUnshare are not valid for action="restore"');
        }
      }

      const result = await owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
        params: target,
        body,
        query: {},
      });
      return result?.skillId ? enrichSkillSummary(store, target, result, null) : result;
    },

    async capability_skill_delete(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const skillId = optionalId(args.skillId, 'skillId');
      const name = optionalId(args.name, 'name');
      if (!skillId && !name) {
        fail('INVALID_ARGUMENT', 'skillId or name is required');
      }
      const body = {
        action: 'delete',
        ...(skillId !== undefined ? { skillId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(args.requestId !== undefined ? { requestId: requireId(args.requestId, 'requestId') } : {}),
      };
      return owner('POST', '/api/devices/:deviceId/bots/:botId/skills', {
        params: target,
        body,
        query: {},
      });
    },

    async capability_installation_skill_files_read(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      await fetchInstallationForActor(installationId, actor);
      return owner('GET', '/api/installations/:id/skill-files', {
        params: { id: installationId },
        query: {},
      });
    },

    async capability_installation_skill_files_write(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const installation = await fetchInstallationForActor(installationId, actor);
      assertInstallationMutableByActor(store, installation, actor);
      const files = sanitizeSkillFilesWriteMap(args.files);
      const requestId = optionalId(args.requestId, 'requestId');
      return owner('PUT', '/api/installations/:id/skill-files', {
        params: { id: installationId },
        body: { files, ...(requestId !== undefined ? { requestId } : {}) },
        query: {},
      });
    },

    // --- Bot Learning ---
    async capability_learning_status(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      return owner('POST', '/api/devices/:deviceId/bots/:botId/learning', {
        params: target,
        body: { action: 'status' },
        query: {},
      });
    },

    async capability_learning_configure(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const expectedRevision = requireRevision(args.expectedRevision);
      const config = sanitizeLearningConfigPatch(args.config);
      return owner('POST', '/api/devices/:deviceId/bots/:botId/learning', {
        params: target,
        body: { action: 'configure', expectedRevision, config },
        query: {},
      });
    },

    async capability_learning_run(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      if (args.sources !== undefined) {
        fail('FORBIDDEN', 'Explicit local/remote learning sources are not accepted by Center operations');
      }
      const mode = args.mode;
      if (mode !== 'review' && mode !== 'curate') {
        fail('FORBIDDEN', 'Only Host-driven review and curate jobs can be started via Center operations');
      }
      let focus;
      if (args.focus !== undefined) {
        if (typeof args.focus !== 'string' || !args.focus.trim() || args.focus.length > 4000) {
          fail('INVALID_ARGUMENT', 'focus must be a non-empty string up to 4000 characters');
        }
        focus = args.focus.trim();
      }
      return owner('POST', '/api/devices/:deviceId/bots/:botId/learning', {
        params: target,
        body: { action: mode, ...(focus !== undefined ? { focus } : {}) },
        query: {},
      });
    },

    async capability_learning_cancel(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const jobId = requireId(args.jobId, 'jobId');
      return owner('POST', '/api/devices/:deviceId/bots/:botId/learning', {
        params: target,
        body: { action: 'cancel', jobId },
        query: {},
      });
    },

    // --- Bot Capability Availability & Safe Overrides ---
    async capability_bot_list(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const kind = args.kind;
      if (kind !== undefined && !CAPABILITY_KINDS.has(kind)) {
        fail('INVALID_ARGUMENT', 'kind must be one of: plugin, mcp, skill');
      }
      const rows = await owner('GET', '/api/devices/:deviceId/bots/:botId/capabilities', {
        params: target,
        query: {},
      });
      const capabilities = (Array.isArray(rows) ? rows : [])
        .filter((entry) => kind === undefined || entry?.installation?.kind === kind)
        .map((entry) => sanitizeBotCapabilityView(
          store,
          entry.installation,
          entry.config,
          target.deviceId,
          target.botId,
        ));
      return {
        deviceId: target.deviceId,
        botId: target.botId,
        capabilities,
      };
    },

    async capability_bot_get(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const installationId = requireId(args.installationId, 'installationId');

      assertTargetBotExists(target);
      const installation = await fetchInstallationForActor(installationId, actor);
      const binding = await owner('GET', '/api/devices/:deviceId/bots/:botId/capabilities/:id', {
        params: { ...target, id: installationId },
        query: {},
      });
      const view = sanitizeBotCapabilityView(store, installation, binding, target.deviceId, target.botId);

      if (view.bound) {
        const checkRaw = await owner('POST', '/api/devices/:deviceId/bots/:botId/installations', {
          params: target,
          body: { action: 'check', installationId },
          query: {},
        });
        const check = sanitizeCheckOrProbeResult(store, checkRaw, installation);
        return {
          ...view,
          configured: check.configured,
          deploymentStatus: check.deployment.status,
          runtimeApplied: check.deployment.runtimeApplied,
          check,
        };
      }

      return view;
    },

    async capability_bot_binding_set(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const target = resolveBotTarget(args, actor);
      const installationId = requireId(args.installationId, 'installationId');
      const expectedRevision = requireRevision(args.expectedRevision);
      const enabled = requireBoolean(args.enabled, 'enabled');

      if (execution?.hasBuiltin?.(installationId)) {
        fail('FORBIDDEN', 'Shared built-in capability cannot be toggled per Bot');
      }

      assertTargetBotExists(target);
      const installation = await fetchInstallationForActor(installationId, actor);
      const current = await owner('GET', '/api/devices/:deviceId/bots/:botId/capabilities/:id', {
        params: { ...target, id: installationId },
        query: {},
      });

      const nextOverrides = args.safeOverridesPatch !== undefined
        ? applySafeConfigPatch(current.configSchema, current.overrides, args.safeOverridesPatch)
        : (isPlainObject(current.overrides) ? current.overrides : {});

      const updated = await owner('PUT', '/api/devices/:deviceId/bots/:botId/capabilities/:id', {
        params: { ...target, id: installationId },
        body: { expectedRevision, enabled, overrides: nextOverrides },
        query: {},
      });
      const latestInstallation = typeof store?.getInstallation === 'function'
        ? (store.getInstallation(installationId) ?? installation)
        : installation;
      return sanitizeBotCapabilityView(store, latestInstallation, updated, target.deviceId, target.botId);
    },

    // --- Installation Catalog, Details, Global Safe Config, Sharing, Diagnostics & Lifecycle ---
    async capability_installation_list(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const kind = args.kind;
      const target = args.target;
      if (kind !== undefined && !CAPABILITY_KINDS.has(kind)) {
        fail('INVALID_ARGUMENT', 'kind must be one of: plugin, mcp, skill');
      }
      if (target !== undefined && !CAPABILITY_TARGETS.has(target)) {
        fail('INVALID_ARGUMENT', 'target must be one of: host, center');
      }
      const list = await owner('GET', '/api/capabilities', { params: {}, query: {} });
      const installations = (Array.isArray(list) ? list : [])
        .filter((item) => isInstallationVisibleToActor(store, item, actor))
        .filter((item) => kind === undefined || item.kind === kind)
        .filter((item) => target === undefined || item.target === target)
        .map(sanitizeInstallation);
      return { installations };
    },

    async capability_installation_get(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const includeBindings = optionalBoolean(args.includeBindings, 'includeBindings') ?? false;
      const includeDeployments = optionalBoolean(args.includeDeployments, 'includeDeployments') ?? false;

      const installation = await fetchInstallationForActor(installationId, actor);
      const [configRaw, declaredActions] = await Promise.all([
        owner('GET', '/api/installations/:id/config', { params: { id: installationId }, query: {} }),
        owner('GET', '/api/installations/:id/actions', { params: { id: installationId }, query: {} }).catch(() => []),
      ]);

      const sanitizedConfig = inspectAndSanitizeConfig(
        configRaw?.configSchema,
        configRaw?.globalConfig,
        store,
      );
      const declaredActionIds = (Array.isArray(declaredActions) ? declaredActions : [])
        .map((item) => item?.id)
        .filter((id) => typeof id === 'string');
      const safeActions = declaredActionIds.filter((id) => SAFE_CAPABILITY_ACTIONS.includes(id));

      const result = {
        installation: sanitizeInstallation(installation),
        configRevision: configRaw?.revision ?? 0,
        safeGlobalConfig: sanitizedConfig.safeConfig,
        safeConfigSchema: sanitizedConfig.safeConfigSchema,
        editableFields: sanitizedConfig.editableFields,
        restrictedFields: sanitizedConfig.restrictedFields,
        configuredRestrictedFields: sanitizedConfig.configuredRestrictedFields,
        credentialSlots: sanitizedConfig.credentialSlots,
        safeActions,
      };

      if (includeBindings) {
        if (actor.kind === 'oauth') {
          const rawBindings = await owner('GET', '/api/installations/:id/bot-bindings', {
            params: { id: installationId },
            query: {},
          });
          const bindings = {};
          for (const [key, binding] of Object.entries(rawBindings?.bindings ?? {})) {
            const sep = key.indexOf(':');
            const deviceId = typeof binding?.deviceId === 'string'
              ? binding.deviceId
              : (sep > 0 ? key.slice(0, sep) : '');
            const botId = typeof binding?.botId === 'string'
              ? binding.botId
              : (sep > 0 ? key.slice(sep + 1) : '');
            if (!deviceId || !botId) continue;
            bindings[key] = sanitizeBotCapabilityView(store, installation, binding, deviceId, botId);
          }
          result.bindings = bindings;
        } else {
          const ownBinding = await owner('GET', '/api/devices/:deviceId/bots/:botId/capabilities/:id', {
            params: { deviceId: actor.deviceId, botId: actor.botId, id: installationId },
            query: {},
          });
          result.bindings = {
            [`${actor.deviceId}:${actor.botId}`]: sanitizeBotCapabilityView(
              store,
              installation,
              ownBinding,
              actor.deviceId,
              actor.botId,
            ),
          };
        }
      }

      if (includeDeployments) {
        const receipts = await owner('GET', '/api/installations/:id/deployments', {
          params: { id: installationId },
          query: {},
        });
        result.deployments = actor.kind === 'bot'
          ? (Array.isArray(receipts) ? receipts : []).filter(
              (item) => item.deviceId === actor.deviceId || item.deviceId === null,
            )
          : (Array.isArray(receipts) ? receipts : []);
      }

      return result;
    },

    async capability_installation_deployments(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const target = resolveOptionalBotTarget(args);

      const installation = await fetchInstallationForActor(installationId, actor);
      if (target) {
        const scoped = await owner('POST', '/api/devices/:deviceId/bots/:botId/installations', {
          params: target,
          body: { action: 'deployments', installationId },
          query: {},
        });
        return {
          installationId,
          installation: sanitizeInstallation(installation),
          deviceId: target.deviceId,
          botId: target.botId,
          plans: Array.isArray(scoped?.plans) ? scoped.plans : [],
          receipts: Array.isArray(scoped?.receipts) ? scoped.receipts : [],
        };
      }

      const receipts = await owner('GET', '/api/installations/:id/deployments', {
        params: { id: installationId },
        query: {},
      });
      const filteredReceipts = actor.kind === 'bot'
        ? (Array.isArray(receipts) ? receipts : []).filter(
            (item) => item.deviceId === actor.deviceId || item.deviceId === null,
          )
        : (Array.isArray(receipts) ? receipts : []);

      return {
        installationId,
        installation: sanitizeInstallation(installation),
        receipts: filteredReceipts,
      };
    },

    async capability_operation_get(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const operationId = requireId(args.operationId, 'operationId');
      const operation = await owner('GET', '/api/operations/:id', {
        params: { id: operationId },
        query: {},
      });
      if (actor.kind === 'bot' && operation?.installationId) {
        const installation = typeof store?.getInstallation === 'function'
          ? store.getInstallation(operation.installationId)
          : null;
        if (installation && !isInstallationVisibleToActor(store, installation, actor)) {
          fail('NOT_FOUND', 'Operation not found');
        }
      }
      return { operation };
    },

    async capability_installation_diagnose(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const action = args.action;
      if (typeof action !== 'string' || !SAFE_CAPABILITY_ACTIONS.includes(action)) {
        fail('FORBIDDEN', `Action is not in the safe diagnostic allowlist: ${SAFE_CAPABILITY_ACTIONS.join(', ')}`);
      }
      const target = resolveBotTarget(args, actor);

      if (action === 'listTools') {
        if (!execution?.hasBuiltin?.(installationId)) {
          await fetchInstallationForActor(installationId, actor);
        }
        const result = await owner('POST', '/api/installations/:id/tools/list', {
          params: { id: installationId },
          body: target,
          query: {},
        });
        return { installationId, ...target, action: 'listTools', result };
      }

      const installation = await fetchInstallationForActor(installationId, actor);

      if (action === 'validate') {
        const result = await owner('POST', '/api/installations/:id/validate', {
          params: { id: installationId },
          body: target,
          query: {},
        });
        return { installationId, ...target, action: 'validate', result };
      }

      // action === 'probe'
      const rawProbe = await owner('POST', '/api/devices/:deviceId/bots/:botId/installations', {
        params: target,
        body: { action: 'probe', installationId },
        query: {},
      });
      return {
        installationId,
        ...target,
        action: 'probe',
        result: sanitizeCheckOrProbeResult(store, rawProbe, installation),
      };
    },

    async capability_installation_updates_check(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const installation = await fetchInstallationForActor(installationId, actor);
      const updates = await owner('POST', '/api/installations/:id/updates/check', {
        params: { id: installationId },
        body: {},
        query: {},
      });
      return {
        installationId,
        installation: sanitizeInstallation(installation),
        updates: Array.isArray(updates)
          ? updates.map((item) => ({
              packageId: item.packageId,
              version: item.version,
              kind: item.kind,
              digest: item.digest ?? null,
            }))
          : [],
      };
    },

    async capability_installation_config_set(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const expectedRevision = requireRevision(args.expectedRevision);

      const installation = await fetchInstallationForActor(installationId, actor);
      assertInstallationMutableByActor(store, installation, actor);

      const current = await owner('GET', '/api/installations/:id/config', {
        params: { id: installationId },
        query: {},
      });

      const nextGlobalConfig = applySafeConfigPatch(
        current.configSchema,
        current.globalConfig,
        args.safeConfigPatch,
        { requireNonEmpty: true },
      );

      if (current?.revision !== expectedRevision) {
        fail('REVISION_CONFLICT', 'Revision does not match');
      }

      const updated = await owner('PUT', '/api/installations/:id/config', {
        params: { id: installationId },
        body: { expectedRevision, globalConfig: nextGlobalConfig },
        query: {},
      });
      const sanitized = inspectAndSanitizeConfig(updated.configSchema, updated.globalConfig, store);
      const latestInstallation = typeof store?.getInstallation === 'function'
        ? (store.getInstallation(installationId) ?? installation)
        : installation;

      return {
        installationId,
        revision: updated.revision,
        safeGlobalConfig: sanitized.safeConfig,
        safeConfigSchema: sanitized.safeConfigSchema,
        editableFields: sanitized.editableFields,
        restrictedFields: sanitized.restrictedFields,
        configuredRestrictedFields: sanitized.configuredRestrictedFields,
        credentialSlots: sanitized.credentialSlots,
        installation: sanitizeInstallation(latestInstallation),
        revalidationTriggered: Boolean(latestInstallation?.enabled),
      };
    },

    async capability_installation_sharing_set(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const expectedRevision = requireRevision(args.expectedRevision);
      const hasDisplayName = args.displayName !== undefined;
      const hasVisibility = args.visibilityScope !== undefined;
      if (!hasDisplayName && !hasVisibility) {
        fail('INVALID_ARGUMENT', 'Provide displayName and/or visibilityScope');
      }

      const body = { expectedRevision };
      if (hasDisplayName) {
        const displayName = typeof args.displayName === 'string' ? args.displayName.trim() : '';
        if (!displayName || displayName.length > 120) {
          fail('INVALID_ARGUMENT', 'displayName must be 1 to 120 characters');
        }
        body.displayName = displayName;
      }
      if (hasVisibility) {
        if (typeof args.visibilityScope !== 'string' || !VISIBILITY_SCOPES.has(args.visibilityScope)) {
          fail('INVALID_ARGUMENT', 'visibilityScope must be one of: private, assigned, global');
        }
        body.visibilityScope = args.visibilityScope;
      }

      const installation = await fetchInstallationForActor(installationId, actor);
      assertInstallationMutableByActor(store, installation, actor, { allowOwnerSkillShare: true });

      const updated = await owner('PATCH', '/api/installations/:id', {
        params: { id: installationId },
        body,
        query: {},
      });
      return { installation: sanitizeInstallation(updated) };
    },

    async capability_installation_toggle(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const action = args.action;
      if (action !== 'enable' && action !== 'disable') {
        fail('INVALID_ARGUMENT', 'action must be "enable" or "disable"');
      }
      const requestId = requireId(args.requestId, 'requestId');

      const installation = await fetchInstallationForActor(installationId, actor);
      assertInstallationMutableByActor(store, installation, actor);

      if (action === 'enable') {
        const body = { requestId };
        if (args.validationBot !== undefined) {
          if (!isPlainObject(args.validationBot)) {
            fail('INVALID_ARGUMENT', 'validationBot must be an object with deviceId and botId');
          }
          body.validationBot = {
            deviceId: requireId(args.validationBot.deviceId, 'validationBot.deviceId'),
            botId: requireId(args.validationBot.botId, 'validationBot.botId'),
          };
        }
        const accepted = await owner('POST', '/api/installations/:id/enable', {
          params: { id: installationId },
          body,
          query: {},
        });
        return formatAcceptedOperation(store, 'enable', installationId, accepted);
      }

      if (args.validationBot !== undefined) {
        fail('INVALID_ARGUMENT', 'validationBot is only valid for action="enable"');
      }
      const accepted = await owner('POST', '/api/installations/:id/disable', {
        params: { id: installationId },
        body: { requestId },
        query: {},
      });
      return formatAcceptedOperation(store, 'disable', installationId, accepted);
    },

    async capability_installation_update(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      if (args.source !== undefined) {
        fail('FORBIDDEN', 'Arbitrary package sources are not allowed; only updates within an already-installed npm package are supported');
      }
      const installationId = requireId(args.installationId, 'installationId');
      const requestId = requireId(args.requestId, 'requestId');
      let targetVersion;
      if (args.targetVersion !== undefined) {
        targetVersion = requireId(args.targetVersion, 'targetVersion');
        if (/\s/.test(targetVersion)) {
          fail('INVALID_ARGUMENT', 'targetVersion must not contain whitespace');
        }
      }

      const installation = await fetchInstallationForActor(installationId, actor);
      assertInstallationMutableByActor(store, installation, actor);
      if (installation.source?.type !== 'npm') {
        fail('INVALID_STATE', 'Only already-installed npm capabilities can be updated by version');
      }

      const accepted = await owner('POST', '/api/installations/:id/update', {
        params: { id: installationId },
        body: { requestId, ...(targetVersion !== undefined ? { targetVersion } : {}) },
        query: {},
      });
      return formatAcceptedOperation(store, 'update', installationId, accepted);
    },

    async capability_installation_uninstall(rawArgs, rawActor) {
      const actor = assertActor(rawActor);
      const args = assertArgsObject(rawArgs);
      const installationId = requireId(args.installationId, 'installationId');
      const requestId = requireId(args.requestId, 'requestId');

      const installation = await fetchInstallationForActor(installationId, actor);
      assertInstallationMutableByActor(store, installation, actor);

      const accepted = await owner('DELETE', '/api/installations/:id', {
        params: { id: installationId },
        body: { requestId },
        query: {},
      });
      return formatAcceptedOperation(store, 'uninstall', installationId, accepted);
    },
  };
}
