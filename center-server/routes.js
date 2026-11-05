import { randomBytes, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { requireOwner, assertPublicCredentialId } from './auth.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const required = (value, name) => value ?? fail('NOT_FOUND', `${name} not found`);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('INVALID_ARGUMENT', 'Expected an object');
const text = (value, name) => typeof value === 'string' && value.length > 0 ? value : fail('INVALID_ARGUMENT', `Invalid ${name}`);
const ajv = new Ajv({ strict: false });
ajv.addFormat('credential-ref', { type: 'string', validate: value => value.length > 0 });

const string = { type: 'string', minLength: 1 };
/** Wire-bound identifiers: request/scope/set/admission IDs stay inside existing ID limits. */
const boundedId = { type: 'string', minLength: 1, maxLength: 128 };
const revision = { type: 'integer', minimum: 0 };
const providerSchema = {
  type: 'object', required: ['name', 'api', 'baseUrl', 'credentialRef', 'enabled'],
  properties: { id: string, name: string, api: string, baseUrl: string, credentialRef: { anyOf: [string, { type: 'null' }] }, enabled: { type: 'boolean' }, revision },
  additionalProperties: false,
};
const modelSchema = {
  type: 'object', required: ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'enabled'],
  properties: { id: string, name: string, contextWindow: { type: 'integer', minimum: 1 }, maxTokens: { type: 'integer', minimum: 1 }, input: { type: 'array', items: string }, reasoning: { type: 'boolean' }, enabled: { type: 'boolean' }, revision, thinkingLevelMap: { type: 'object' }, cost: { type: 'object' }, compat: { type: 'object' }, inputLimits: { type: 'object' } },
  additionalProperties: false,
};
const selectionSchema = { type: 'object', properties: { modelRef: { anyOf: [string, { type: 'null' }] }, thinkingLevel: { anyOf: [string, { type: 'null' }] }, codemode: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }, codemodeOnly: { anyOf: [{ type: 'boolean' }, { type: 'null' }] } }, additionalProperties: false };
const avatarWriteSchema = {
  type: 'object', required: ['expectedRevision', 'value'],
  properties: {
    expectedRevision: revision,
    value: { anyOf: [
      { type: 'null' },
      {
        type: 'object', required: ['id', 'shape', 'color', 'rotation', 'expressionIndex', 'labelZh', 'labelEn'],
        properties: {
          id: { type: 'string', maxLength: 128 },
          shape: { enum: ['blob', 'cloud', 'squircle', 'gem', 'bean', 'arch', 'crystal', 'teardrop', 'pebble', 'wedge', 'shield', 'dome', 'hex', 'leaf', 'egg', 'tablet', 'capsule', 'cylinder'] },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          rotation: { type: 'number', minimum: -360, maximum: 360 },
          expressionIndex: { type: 'integer', minimum: 0, maximum: 5 },
          labelZh: { type: 'string', maxLength: 128 },
          labelEn: { type: 'string', maxLength: 128 },
        },
        additionalProperties: false,
      },
    ] },
  },
  additionalProperties: false,
};
/** Owner-set Bot cwd: non-empty absolute-path shape (POSIX, drive letter, or \\\\server\\share UNC);
 * control characters and incomplete UNC roots are unrepresentable on the wire; the Host revalidates existence. */
const isAbsolutePath = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value &&
  !/[\x00-\x1f]/.test(value) &&
  (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/]+[^\\/]+/.test(value));
const cwdWriteSchema = {
  type: 'object', required: ['expectedRevision', 'value'],
  properties: { expectedRevision: revision, value: string },
  additionalProperties: false,
};
const prepareTurnSchema = {
  type: 'object', required: ['botId', 'requestId', 'scopeKey', 'inputDigest'],
  properties: { botId: boundedId, requestId: boundedId, scopeKey: boundedId, inputDigest: { type: 'string', minLength: 1, maxLength: 128 }, knownSetId: boundedId },
  additionalProperties: false,
};
const confirmTurnSchema = {
  type: 'object', required: ['botId', 'requestId', 'scopeKey', 'inputDigest', 'setId'],
  properties: { botId: boundedId, requestId: boundedId, scopeKey: boundedId, inputDigest: { type: 'string', minLength: 1, maxLength: 128 }, setId: boundedId },
  additionalProperties: false,
};
const restoreTurnSchema = {
  type: 'object', required: ['botId', 'admissionId'],
  properties: { botId: boundedId, admissionId: boundedId },
  additionalProperties: false,
};
function validate(schema, value) { if (!ajv.validate(schema, value)) fail('VALIDATION_FAILED', 'Invalid input'); return value; }
/** Hosts report these; 'pending' is derived by the center and never accepted. */
const runtimeStatuses = ['applying', 'waiting-idle', 'applied', 'failed'];
const runtimeError = value => value == null ? null : { code: typeof value.code === 'string' ? value.code : 'INTERNAL_ERROR', message: typeof value.message === 'string' ? value.message : '' };
function runtimeBotReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
  if (!Number.isSafeInteger(value.desiredRevision) || value.desiredRevision < 0 || !runtimeStatuses.includes(value.status)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
  if (value.appliedRevision != null && (!Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
  return { botId: text(value.botId, 'botId'), desiredRevision: value.desiredRevision, appliedRevision: value.appliedRevision ?? null, status: value.status, error: runtimeError(value.error) };
}
/** Owner-registered device platforms; the Host hello may refine the stored value later. */
const devicePlatforms = ['windows', 'linux', 'macos', 'android'];
function deviceRegistration(value) {
  const body = object(value);
  if (Object.keys(body).some(key => key !== 'displayName' && key !== 'platform')) fail('INVALID_ARGUMENT', 'Invalid device registration');
  const displayName = typeof body.displayName === 'string' && body.displayName.isWellFormed() ? body.displayName.trim() : '';
  if (displayName.length < 1 || displayName.length > 64 || /[\x00-\x1f\x7f]/.test(displayName)) fail('INVALID_ARGUMENT', 'displayName must contain 1-64 characters');
  if (!devicePlatforms.includes(body.platform)) fail('INVALID_ARGUMENT', 'Invalid platform');
  return { displayName, platform: body.platform };
}
function runtimeCapabilityError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.error == null) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
  return { botId: text(value.botId, 'botId'), installationId: text(value.installationId, 'installationId'), error: runtimeError(value.error) };
}

function assertConfigCredentials(schema, value) {
  if (!schema || typeof schema !== 'object' || value == null) return;
  if (schema.type === 'string' && schema.format === 'credential-ref') { assertPublicCredentialId(value); return; }
  if (Array.isArray(value)) {
    for (const item of value) assertConfigCredentials(schema.items, item);
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertConfigCredentials(schema.properties?.[key] ?? schema.additionalProperties, item);
  }
}


export function registerRoutes(app, { store, packages, bridge, execution, oauth, linkUrl, turns, skills, learning, botManagement }) {
  const streams = new Map();
  function notify(deviceId) {
    for (const stream of streams.get(deviceId) || []) {
      if (!bridge.registry.authenticate(deviceId, stream.token)) stream.reply.end();
      else stream.reply.write('event: config-changed\ndata: {}\n\n');
    }
  }
  function notifyAll() { for (const deviceId of streams.keys()) notify(deviceId); }
  function notifyInstallation(id) { for (const deviceId of new Set(store.listBotBindings({ installationId: id }).map(b => b.deviceId))) notify(deviceId); }
  const owner = [requireOwner];
  const mutation = [requireOwner, app.csrfProtection];
  const route = (method, path, handler, write = false) => app.route({ method, url: path, onRequest: write ? mutation : owner, handler });
  const changed = (result, deviceId) => { deviceId ? notify(deviceId) : notifyAll(); return result; };
  const providerInput = id => {
    const provider = required(store.getProvider(id), 'Provider');
    const models = store.listModels(id);
    const credential = provider.credentialRef ? store.resolveCredential(assertPublicCredentialId(provider.credentialRef)) : undefined;
    return { provider, models, ...(credential === undefined ? {} : { credential }) };
  };
  route('GET', '/api/providers', () => store.listProviders());
  route('POST', '/api/providers', (req, reply) => reply.code(201).send(changed(store.putProvider({ ...validate(providerSchema, req.body), credentialRef: assertPublicCredentialId(req.body.credentialRef), id: req.body.id || randomUUID(), revision: 0 }, null))), true);
  route('GET', '/api/providers/:id', req => required(store.getProvider(req.params.id), 'Provider'));
  route('PUT', '/api/providers/:id', req => { const body = object(req.body); validate(providerSchema, body.value); assertPublicCredentialId(body.value.credentialRef); return changed(store.putProvider({ ...body.value, id: req.params.id }, body.expectedRevision)); }, true);
  for (const [path, method] of [['validate', 'validateCenterProvider'], ['discover', 'discoverCenterProviderModels']]) {
    route('POST', `/api/providers/:id/${path}`, req => bridge.call(text(req.body?.deviceId, 'deviceId'), method, providerInput(req.params.id)), true);
  }
  route('GET', '/api/providers/:id/models', req => { required(store.getProvider(req.params.id), 'Provider'); return store.listModels(req.params.id); });
  route('POST', '/api/providers/:id/models', (req, reply) => { required(store.getProvider(req.params.id), 'Provider'); return reply.code(201).send(changed(store.putModel(req.params.id, { ...validate(modelSchema, req.body), revision: 0 }, null))); }, true);
  route('PUT', '/api/providers/:id/models/:modelId', req => { const body = object(req.body); return changed(store.putModel(req.params.id, { ...validate(modelSchema, body.value), id: req.params.modelId }, body.expectedRevision)); }, true);
  route('GET', '/api/model-config', () => store.getModelConfig());
  route('PUT', '/api/model-config', req => { const body = object(req.body); return changed(store.putModelConfig(body.expectedRevision, validate(selectionSchema, body.value))); }, true);
  route('GET', '/api/devices', () => bridge.listDevices());
  // 所有者登记新设备：令牌只在本响应中返回一次，中心只保存其哈希，不写日志。
  route('POST', '/api/devices', (req, reply) => {
    const { displayName, platform } = deviceRegistration(req.body);
    const deviceId = randomUUID();
    const deviceToken = randomBytes(32).toString('base64url');
    bridge.registry.register({ deviceId, token: deviceToken, displayName });
    bridge.registry.updateMetadata(deviceId, { platform });
    return reply.code(201).send({ deviceId, deviceToken, displayName, platform });
  }, true);
  route('PATCH', '/api/devices/:deviceId', req => {
    const { deviceId } = req.params;
    if (deviceId === bridge.deviceId || !bridge.listDevices().some(device => device.deviceId === deviceId)) fail('NOT_FOUND', 'Device not found');
    const device = bridge.registry.rename(deviceId, object(req.body).name);
    store.replaceDeviceBots(deviceId, store.listDeviceBots(deviceId).map(bot => ({ ...bot, deviceName: device.displayName })), { bumpRevision: false });
    return { deviceId, name: device.displayName, online: bridge.listDevices().find(item => item.deviceId === deviceId).online };
  }, true);
  route('DELETE', '/api/devices/:deviceId', (req, reply) => {
    const { deviceId } = req.params;
    if (deviceId === bridge.deviceId || !bridge.registry.get(deviceId)) fail('NOT_FOUND', 'Device not found');
    bridge.registry.revoke(deviceId);
    store.replaceDeviceBots(deviceId, []);
    notify(deviceId);
    return reply.code(204).send();
  }, true);
  route('GET', '/api/bot-sync', req => store.getBotSync({
    epoch: typeof req.query?.epoch === 'string' ? req.query.epoch : undefined,
    sinceSeq: req.query?.sinceSeq !== undefined ? Number(req.query.sinceSeq) : undefined,
    devices: bridge.listDevices(),
  }));
  route('GET', '/api/devices/:deviceId/bots', req => store.listDeviceBots(req.params.deviceId));
  route('GET', '/api/devices/:deviceId/runtime-status', req => {
    const device = bridge.listDevices().find(item => item.deviceId === req.params.deviceId);
    if (!device) fail('NOT_FOUND', 'Device not found');
    return store.getDeviceRuntimeStatus(device.deviceId, device.online);
  });
  route('POST', '/api/devices/:deviceId/bots', async (req, reply) => {
    const { deviceId } = req.params;
    const created = await bridge.call(deviceId, 'createBot', {
      requestId: req.body?.requestId || randomUUID(),
      role: text(req.body?.role, 'role'),
      ...(req.body?.description !== undefined ? { description: String(req.body.description) } : {}),
      ...(req.body?.cwd ? { cwd: text(req.body.cwd, 'cwd') } : {}),
      ...(typeof req.body?.makePrimary === 'boolean' ? { makePrimary: req.body.makePrimary } : {}),
    });
    let bot = store.upsertDeviceBot(deviceId, {
      ...created,
      deviceId,
      name: typeof created?.name === 'string' ? created.name : created?.role ?? text(req.body?.role, 'role'),
      ...(typeof req.body?.makePrimary === 'boolean' && created?.isPrimary === undefined ? { isPrimary: req.body.makePrimary } : {}),
    });
    // 创建回执是新 Bot cwd 的唯一隐式初始化来源：中心仍缺值时按其声明的实际目录
    // 做一次 expectedRevision:0 CAS（等价于创建初始化，不产生第二 revision）；
    // 中心已有值绝不覆盖。不夹网络 await，返回的始终是最新记录。
    if (bot.cwd === undefined && typeof created?.cwd === 'string' && isAbsolutePath(created.cwd)) {
      try {
        bot = store.upsertDeviceBot(deviceId, { botId: bot.botId, name: bot.name }, { kind: 'cwd', expectedRevision: 0, value: created.cwd });
      } catch (err) {
        if (err?.code !== 'REVISION_CONFLICT') throw err;
        // 并发写入已先行：中心值胜出，重读最新记录返回。
        bot = store.upsertDeviceBot(deviceId, { botId: bot.botId, name: bot.name });
      }
    }
    await packages.reconcileDevice(deviceId);
    notify(deviceId);
    return reply.code(201).send(bot);
  }, true);
  route('PATCH', '/api/devices/:deviceId/bots/:botId', async req => {
    const { deviceId, botId } = req.params;
    const updated = await bridge.call(deviceId, 'updateBotProfile', {
      botId,
      ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
      ...(req.body?.description !== undefined ? { description: req.body.description } : {}),
    });
    return store.upsertDeviceBot(deviceId, {
      ...updated,
      deviceId,
      botId,
      ...(typeof updated?.name === 'string' ? { name: updated.name } : typeof updated?.role === 'string' ? { name: updated.role } : {}),
    });
  }, true);
  route('POST', '/api/devices/:deviceId/bots/:botId/primary', async req => {
    const { deviceId, botId } = req.params;
    const updated = await bridge.call(deviceId, 'setPrimaryBot', { botId });
    return store.upsertDeviceBot(deviceId, {
      ...updated,
      deviceId,
      botId,
      ...(typeof updated?.name === 'string' ? { name: updated.name } : typeof updated?.role === 'string' ? { name: updated.role } : {}),
      isPrimary: true,
    });
  }, true);
  route('POST', '/api/devices/:deviceId/bots/:botId/archive', async req => {
    const { deviceId, botId } = req.params;
    const updated = await bridge.call(deviceId, 'archiveBot', { botId });
    return store.upsertDeviceBot(deviceId, {
      ...updated,
      deviceId,
      botId,
      ...(typeof updated?.name === 'string' ? { name: updated.name } : typeof updated?.role === 'string' ? { name: updated.role } : {}),
      ...(updated?.archivedAt !== undefined ? { archivedAt: updated.archivedAt } : { archivedAt: new Date().toISOString() }),
    });
  }, true);
  route('POST', '/api/devices/:deviceId/bots/:botId/unarchive', async req => {
    const { deviceId, botId } = req.params;
    const updated = await bridge.call(deviceId, 'unarchiveBot', { botId });
    return store.upsertDeviceBot(deviceId, {
      ...updated,
      deviceId,
      botId,
      ...(typeof updated?.name === 'string' ? { name: updated.name } : typeof updated?.role === 'string' ? { name: updated.role } : {}),
      archivedAt: updated?.archivedAt ?? null,
    });
  }, true);
  route('DELETE', '/api/devices/:deviceId/bots/:botId', async (req, reply) => {
    const { deviceId, botId } = req.params;
    await bridge.call(deviceId, 'deleteBot', { botId });
    store.removeDeviceBot(deviceId, botId);

    return reply.code(204).send();
  }, true);
  async function putAvatar(req) {
    const body = validate(avatarWriteSchema, req.body);
    const { deviceId, botId } = req.params;
    if (!store.listDeviceBots(deviceId).some(bot => bot.botId === botId)) {
      const bot = required((await bridge.call(deviceId, 'listBots', {})).find(bot => bot.botId === botId), 'Bot');
      store.upsertDeviceBot(deviceId, { ...bot, name: bot.name ?? bot.role });
    }
    return store.putBotAvatar(deviceId, botId, body.expectedRevision, body.value);
  }
  route('GET', '/api/devices/:deviceId/bots/:botId/avatar', req => store.getBotAvatar(req.params.deviceId, req.params.botId));
  route('PUT', '/api/devices/:deviceId/bots/:botId/avatar', putAvatar, true);
  route('GET', '/api/devices/:deviceId/bots/:botId/cwd', req => store.getBotCwd(req.params.deviceId, req.params.botId));
  route('PUT', '/api/devices/:deviceId/bots/:botId/cwd', req => {
    const body = validate(cwdWriteSchema, req.body);
    if (!isAbsolutePath(body.value)) fail('INVALID_ARGUMENT', 'cwd must be a non-empty absolute path on the target Host');
    return changed(store.putBotCwd(req.params.deviceId, req.params.botId, body.expectedRevision, body.value), req.params.deviceId);
  }, true);
  route('GET', '/api/devices/:deviceId/bots/:botId/model-config', req => store.getBotModelConfig(req.params.deviceId, req.params.botId));
  route('PUT', '/api/devices/:deviceId/bots/:botId/model-config', req => { const b = object(req.body); return changed(store.putBotModelConfig(req.params.deviceId, req.params.botId, b.expectedRevision, validate(selectionSchema, b.value)), req.params.deviceId); }, true);
  const credentialId = assertPublicCredentialId;
  route('GET', '/api/credentials/:id', req => required(store.getCredential(credentialId(req.params.id)), 'Credential'));
  route('PUT', '/api/credentials/:id', req => changed(store.putCredential(credentialId(req.params.id), object(req.body))), true);
  route('DELETE', '/api/credentials/:id', (req, reply) => { store.deleteCredential(credentialId(req.params.id), object(req.body).expectedRevision); notifyAll(); return reply.code(204).send(); }, true);
  route('POST', '/api/artifacts', async (req, reply) => {
    const file = await req.file();
    if (!file) fail('INVALID_ARGUMENT', 'File required');
    if (file.fieldname !== 'file') { file.file.resume(); fail('INVALID_ARGUMENT', 'File required'); }
    async function* content() {
      for await (const chunk of file.file) yield chunk;
      if (file.file.truncated) fail('PAYLOAD_TOO_LARGE', 'Artifact too large');
    }
    return reply.code(201).send(await packages.uploadArtifact(content()));
  }, true);
  route('GET', '/api/capabilities', () => store.listInstallations());
  route('POST', '/api/installations', async (req, reply) => { const body = object(req.body); if (body.target === 'center' && (body.kind === 'plugin' || body.kind === 'skill')) fail('UNSUPPORTED_TARGET', 'Native plugins and skills run on Hosts'); return reply.code(202).send(await packages.install(body)); }, true);
  route('GET', '/api/installations/:id', req => required(store.getInstallation(req.params.id), 'Installation'));
  route('PATCH', '/api/installations/:id', req => store.renameInstallation(req.params.id, object(req.body)), true);
  route('GET', '/api/installations/:id/config', req => store.getInstallationConfig(req.params.id));
  route('PUT', '/api/installations/:id/config', req => {
    const body = object(req.body);
    assertConfigCredentials(store.getInstallationConfig(req.params.id).configSchema, body.globalConfig);
    const result = store.putInstallationConfig(req.params.id, body);
    notifyInstallation(req.params.id);
    // A global config change can invalidate a previous successful enable.
    if (store.getInstallation(req.params.id).enabled) packages.revalidate(req.params.id);
    return result;
  }, true);
  route('GET', '/api/devices/:deviceId/bots/:botId/capabilities', req => {
    const { deviceId, botId } = req.params;
    if (!store.listDeviceBots(deviceId).some(bot => bot.botId === botId)) fail('NOT_FOUND', 'Bot not found');
    return store.listBotCapabilities(deviceId, botId);
  });
  route('GET', '/api/devices/:deviceId/bots/:botId/capabilities/:id', req => store.getBotCapability(req.params.deviceId, req.params.botId, req.params.id));
  route('PUT', '/api/devices/:deviceId/bots/:botId/capabilities/:id', async req => { const { deviceId, botId, id } = req.params; const body = object(req.body); assertConfigCredentials(store.getInstallationConfig(id).configSchema, body.overrides); const result = store.putBotCapability(deviceId, botId, id, body); try { await packages.reconcileDevice(deviceId); } finally { notify(deviceId); } return result; }, true);
  function actions(id) {
    const installation = required(store.getInstallation(id), 'Installation');
    const version = required(store.getPackageVersion(installation.packageId, installation.targetVersion), 'Package version');
    return version.manifest.actions || [];
  }
  route('GET', '/api/installations/:id/actions', req => actions(req.params.id));
  async function action(id, name, input) {
    const declared = actions(id).find(item => item.id === name);
    if (!declared) fail('NOT_FOUND', 'Action not declared');
    object(input); text(input.deviceId, 'deviceId'); text(input.botId, 'botId'); text(input.requestId, 'requestId');
    if (!store.isActive(store.getInstallation(id)) || !store.getBotCapability(input.deviceId, input.botId, id).enabled) fail('FORBIDDEN', 'Capability unavailable');
    if (!ajv.validate(declared.inputSchema, input.input)) fail('VALIDATION_FAILED', 'Invalid action input');
    const result = await bridge.call(input.deviceId, 'callCapabilityAction', { installationId: id, action: name, request: input });
    if (declared.outputSchema !== undefined && !ajv.validate(declared.outputSchema, result.result)) fail('INVALID_STATE', 'Invalid action output');
    return result;
  }
  route('POST', '/api/installations/:id/actions/:action', req => action(req.params.id, req.params.action, req.body), true);
  route('POST', '/api/installations/:id/tools/list', async req => {
    const body = object(req.body); const deviceId = text(body.deviceId, 'deviceId'); const botId = text(body.botId, 'botId');
    const installation = required(store.getInstallation(req.params.id), 'Installation');
    if (installation.kind !== 'mcp' || !store.isActive(installation) || !store.listDeviceBots(deviceId).some(bot => bot.botId === botId) || !store.getBotCapability(deviceId, botId, req.params.id).enabled) fail('FORBIDDEN', 'Capability unavailable');
    if (installation.target === 'center') return execution.listTools(deviceId, req.params.id, { botId });
    if (installation.target !== 'host') fail('UNSUPPORTED_TARGET', 'Unsupported MCP target');
    const result = await action(req.params.id, 'listTools', { requestId: randomUUID(), deviceId, botId, input: {} });
    return result.result;
  }, true);
  route('POST', '/api/installations/:id/validate', async req => {
    const body = object(req.body); text(body.deviceId, 'deviceId'); text(body.botId, 'botId');
    if (!actions(req.params.id).some(item => item.id === 'validate')) return { ok: false, message: 'Connection validation is not supported' };
    const result = await action(req.params.id, 'validate', { requestId: randomUUID(), deviceId: body.deviceId, botId: body.botId, input: {} });
    return result.result;
  }, true);
  route('POST', '/api/installations/:id/updates/check', req => packages.checkUpdates(req.params.id), true);
  route('POST', '/api/installations/:id/enable', async (req, reply) => {
    const body = object(req.body);
    const request = { requestId: text(body.requestId, 'requestId') };
    if (body.validationBot !== undefined) {
      const validationBot = object(body.validationBot);
      const deviceId = text(validationBot.deviceId, 'deviceId');
      const botId = text(validationBot.botId, 'botId');
      if (!store.listDeviceBots(deviceId).some(bot => bot.botId === botId)) fail('NOT_FOUND', 'Bot not found');
      request.validationBot = { deviceId, botId };
    }
    return reply.code(202).send(await packages.enable(req.params.id, request));
  }, true);
  for (const [method, path, fn] of [['POST','update','update'],['POST','rollback','rollback'],['POST','disable','disable'],['DELETE','','uninstall']]) {
    route(method, `/api/installations/:id${path ? `/${path}` : ''}`, async (req, reply) => reply.code(202).send(await packages[fn](req.params.id, object(req.body))), true);
  }
  route('GET', '/api/installations/:id/deployments', req => store.listDeploymentReceipts(req.params.id));
  route('GET', '/api/operations/:id', req => required(store.getOperation(req.params.id), 'Operation'));
  // Bot-scoped management: same services as the paired-device routes below,
  // owner authority. Skills/learning pass the Bot identity through unchanged.
  const botScope = (req) => {
    const { deviceId, botId } = req.params;
    if (!store.listDeviceBots(deviceId).some((bot) => bot.botId === botId)) fail('NOT_FOUND', 'Bot not found');
    return { deviceId, botId };
  };
  route('POST', '/api/devices/:deviceId/bots/:botId/skills', req => skills.execute({ ...botScope(req), origin: 'foreground' }, object(req.body)), true);
  route('POST', '/api/devices/:deviceId/bots/:botId/learning', req => {
    const body = object(req.body);
    // Only the target Host may drive learning jobs; the owner may inspect,
    // configure and cancel, but a start/next/respond here would strand the job.
    if (!['status', 'configure', 'cancel'].includes(body.action)) fail('FORBIDDEN', 'Learning jobs are driven by the target Host');
    return learning.execute(botScope(req), body);
  }, true);
  route('POST', '/api/devices/:deviceId/bots/:botId/installations', req => botManagement.execute(botScope(req), object(req.body), { allowShared: true }), true);
  const oauthInput = req => ({ installationId: req.params.id, deviceId: text(req.body?.deviceId, 'deviceId'), botId: text(req.body?.botId, 'botId') });
  route('POST', '/api/installations/:id/oauth/start', req => oauth.start(oauthInput(req)), true);
  route('GET', '/api/oauth/mcp/flows/:flowId', req => required(oauth.status(req.params.flowId), 'OAuth flow'));
  route('POST', '/api/installations/:id/oauth/logout', async (req, reply) => {
    const input = oauthInput(req);
    await oauth.logout(input);
    await execution.invalidate(input.deviceId, input.botId, input.installationId);
    notify(input.deviceId);
    return reply.code(204).send();
  }, true);
  app.get('/api/oauth/mcp/callback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const state = text(req.query?.state, 'state');
    await oauth.complete({ state, code: req.query?.code, error: req.query?.error, iss: req.query?.iss });
    return reply.type('text/plain; charset=utf-8').send(req.query?.error ? 'Authorization was not completed. You may close this window.' : 'Authorization complete. You may close this window.');
  });
  function snapshot(deviceId) {
    const value = store.getDeviceSnapshot(deviceId, linkUrl);
    for (const id of Object.keys(value.credentials)) assertPublicCredentialId(id);
    return value;
  }


  function authenticate(req, reply, done) {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    const deviceId = req.headers['x-device-id'];
    const identity = token && typeof deviceId === 'string' && bridge.registry.authenticate(deviceId, token);
    if (!identity || deviceId === bridge.deviceId) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Device authentication required' } });
    req.centerDevice = { deviceId, token };
    done();
  }
  const host = (method, url, handler, bodyLimit) => app.route({ method, url, onRequest: authenticate, handler, ...(bodyLimit !== undefined ? { bodyLimit } : {}) });
  // Learning start carries a transcript snapshot the service bounds at 8 MiB;
  // this route's body limit sits just above it — never a global raise.
  const LEARNING_BODY_LIMIT = 9 * 1024 * 1024;
  host('GET', '/api/host/events', (req, reply) => {
    const { deviceId, token } = req.centerDevice;
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('event: heartbeat\ndata: {}\n\n');
    const set = streams.get(deviceId) || new Set(); const stream = { reply: reply.raw, token }; set.add(stream); streams.set(deviceId, set);
    const timer = setInterval(() => { if (!bridge.registry.authenticate(deviceId, token)) return reply.raw.end(); reply.raw.write('event: heartbeat\ndata: {}\n\n'); }, 15000);
    reply.raw.on('error', () => reply.raw.destroy());
    reply.raw.on('close', () => { clearInterval(timer); set.delete(stream); if (!set.size) streams.delete(deviceId); });
  });
  host('POST', '/api/host/bootstrap', async req => {
    const body = object(req.body); const id = req.centerDevice.deviceId;
    if (body.deviceId !== id || body.capabilityProtocol !== 1 || !Array.isArray(body.bots) || body.bots.some(bot => !bot || bot.deviceId !== id || typeof bot.botId !== 'string' || !bot.botId || typeof bot.name !== 'string')) fail('INVALID_ARGUMENT', 'Invalid bootstrap');
    store.replaceDeviceBots(id, body.bots.filter(bot => typeof bot.isPrimary === 'boolean'), { bumpRevision: true });
    await packages.reconcileDevice(id);
    return { snapshot: snapshot(id) };
  });
  host('POST', '/api/host/bots-sync', async req => {
    const body = object(req.body); const id = req.centerDevice.deviceId;
    if (body.deviceId !== id || !Array.isArray(body.bots)) fail('INVALID_ARGUMENT', 'Invalid bots sync');
    const known = new Set(store.listDeviceBots(id).map(bot => bot.botId));
    const result = store.replaceDeviceBots(id, body.bots, { bumpRevision: false });
    if (body.bots.some(bot => !known.has(bot.botId))) {
      await packages.reconcileDevice(id);
      notify(id);
    }
    return result;
  });
  host('GET', '/api/host/bot-directory', req => {
    const epoch = typeof req.query?.epoch === 'string' ? req.query.epoch : undefined;
    const sinceSeq = req.query?.sinceSeq !== undefined ? Number(req.query.sinceSeq) : undefined;
    return store.getBotSync({ epoch, sinceSeq, devices: bridge.listDevices() });
  });
  host('GET', '/api/host/connection', req => ({ protocol: 1, deviceId: req.centerDevice.deviceId, linkUrl }));
  host('GET', '/api/host/devices/:deviceId/runtime-status', req => {
    const device = bridge.listDevices().find(item => item.deviceId === req.params.deviceId);
    if (!device) fail('NOT_FOUND', 'Device not found');
    return store.getDeviceRuntimeStatus(device.deviceId, device.online);
  });
  host('GET', '/api/host/devices/:deviceId/bots/:botId/avatar', req => store.getBotAvatar(req.params.deviceId, req.params.botId));
  host('PUT', '/api/host/devices/:deviceId/bots/:botId/avatar', putAvatar);
  host('GET', '/api/host/devices/:deviceId/bots/:botId/cwd', req => store.getBotCwd(req.params.deviceId, req.params.botId));
  host('PUT', '/api/host/devices/:deviceId/bots/:botId/cwd', req => {
    const body = validate(cwdWriteSchema, req.body);
    if (!isAbsolutePath(body.value)) fail('INVALID_ARGUMENT', 'cwd must be a non-empty absolute path on the target Host');
    return changed(store.putBotCwd(req.params.deviceId, req.params.botId, body.expectedRevision, body.value), req.params.deviceId);
  });
  host('GET', '/api/host/devices/:deviceId/bots/:botId/model-config', req => store.getBotModelConfig(req.params.deviceId, req.params.botId));
  host('PUT', '/api/host/devices/:deviceId/bots/:botId/model-config', req => { const b = object(req.body); return changed(store.putBotModelConfig(req.params.deviceId, req.params.botId, b.expectedRevision, validate(selectionSchema, b.value)), req.params.deviceId); });
  host('GET', '/api/host/devices/:deviceId/bots/:botId/capabilities', req => {
    const { deviceId, botId } = req.params;
    if (!store.listDeviceBots(deviceId).some(bot => bot.botId === botId)) fail('NOT_FOUND', 'Bot not found');
    return store.listBotCapabilities(deviceId, botId);
  });
  host('GET', '/api/host/devices/:deviceId/bots/:botId/capabilities/:id', req => store.getBotCapability(req.params.deviceId, req.params.botId, req.params.id));
  host('PUT', '/api/host/devices/:deviceId/bots/:botId/capabilities/:id', async req => {
    const { deviceId, botId, id } = req.params;
    const body = object(req.body);
    assertConfigCredentials(store.getInstallationConfig(id).configSchema, body.overrides);
    const result = store.putBotCapability(deviceId, botId, id, body);
    try { await packages.reconcileDevice(deviceId); } finally { notify(deviceId); }
    return result;
  });
  host('POST', '/api/host/devices/:deviceId/bots/:botId/skills', req => skills.execute({ ...botScope(req), origin: 'foreground' }, object(req.body)));
  host('POST', '/api/host/devices/:deviceId/bots/:botId/learning', req => {
    const scope = botScope(req);
    // The learning job's agent.run callbacks are handed to the initiating
    // Host; a forged cross-device source must never drive another Host's jobs.
    if (scope.deviceId !== req.centerDevice.deviceId) fail('FORBIDDEN', 'Device mismatch');
    return learning.execute(scope, object(req.body));
  }, LEARNING_BODY_LIMIT);
  host('POST', '/api/host/devices/:deviceId/bots/:botId/installations', req => botManagement.execute(botScope(req), object(req.body)));
  host('GET', '/api/host/snapshot', req => snapshot(req.centerDevice.deviceId));
  host('POST', '/api/host/receipt', (req, reply) => {
    const body = object(req.body);
    if (body.deviceId !== req.centerDevice.deviceId) fail('FORBIDDEN', 'Device mismatch');
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !runtimeStatuses.includes(body.status)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
    if (body.appliedRevision != null && (!Number.isSafeInteger(body.appliedRevision) || body.appliedRevision < 0 || body.appliedRevision > body.revision)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
    if (body.bots !== undefined && (!Array.isArray(body.bots) || body.bots.length > 500)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
    if (body.capabilityErrors !== undefined && (!Array.isArray(body.capabilityErrors) || body.capabilityErrors.length > 500)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
    store.putRuntimeReceipt({
      deviceId: body.deviceId, revision: body.revision, status: body.status, error: runtimeError(body.error),
      appliedRevision: body.appliedRevision ?? null,
      bots: (body.bots ?? []).map(runtimeBotReceipt),
      capabilityErrors: (body.capabilityErrors ?? []).map(runtimeCapabilityError),
    });
    return reply.code(204).send();
  });
  host('GET', '/api/host/deployments', req => packages.listDeploymentPlans(req.centerDevice.deviceId));
  host('POST', '/api/host/deployments/receipt', async (req, reply) => {
    const body = object(req.body), deviceId = req.centerDevice.deviceId;
    const plan = store.listDeploymentPlans(deviceId).find(p => p.installationId === body.installationId);
    if (body.deviceId !== deviceId || !plan || plan.operationId !== body.operationId || plan.planId !== body.planId || plan.desiredRevision !== body.desiredRevision) fail('FORBIDDEN', 'Deployment not assigned');
    if (!['queued', 'downloading', 'preparing', 'waiting-idle', 'activating', 'applied', 'failed', 'removed'].includes(body.phase) || !['ready', 'disconnected', 'needs-auth', 'unsupported', 'disabled'].includes(body.health) || (body.appliedRevision !== null && (!Number.isSafeInteger(body.appliedRevision) || body.appliedRevision < 0)) || (body.actualVersion !== null && typeof body.actualVersion !== 'string')) fail('INVALID_ARGUMENT', 'Invalid deployment receipt');
    if (['applied', 'removed'].includes(body.phase) && body.appliedRevision !== plan.desiredRevision) fail('INVALID_ARGUMENT', 'Deployment revision mismatch');
    if (body.phase === 'applied' && ['install', 'update', 'rollback', 'enable'].includes(plan.action) && body.actualVersion !== plan.targetVersion) fail('INVALID_ARGUMENT', 'Deployment version mismatch');
    store.putDeploymentReceipt({ ...body, error: body.error ? { code: 'INTERNAL_ERROR', message: 'Deployment failed' } : null });
    const operation = store.getOperation(plan.operationId);
    if (operation && operation.target === 'host' && operation.deviceIds.length && !['applied', 'removed', 'failed'].includes(operation.phase)) {
      const receipts = store.listDeploymentReceipts(plan.installationId);
      const matched = operation.deviceIds.map(id => {
        const current = store.listDeploymentPlans(id).find(p => p.installationId === plan.installationId && p.operationId === operation.operationId);
        return current && receipts.find(r => r.deviceId === id && r.operationId === operation.operationId && r.planId === current.planId && r.desiredRevision === current.desiredRevision);
      });
      if (matched.some(receipt => receipt?.phase === 'failed')) store.updateOperation(operation.operationId, { phase: 'failed', error: { code: 'INTERNAL_ERROR', message: 'Deployment failed' } });
      else if (matched.every(receipt => receipt && ['applied', 'removed'].includes(receipt.phase))) packages.setOperationPhase(operation.operationId, operation.action === 'uninstall' ? 'removed' : 'applied', null);
    }
    return reply.code(204).send();
  });
  host('POST', '/api/host/turns/prepare', async req => {
    const body = validate(prepareTurnSchema, object(req.body));
    return turns.prepareTurn(req.centerDevice.deviceId, body);
  });
  host('POST', '/api/host/turns/confirm', async req => {
    const body = validate(confirmTurnSchema, object(req.body));
    return turns.confirmTurn(req.centerDevice.deviceId, body);
  });
  host('POST', '/api/host/turns/restore', async req => {
    const body = validate(restoreTurnSchema, object(req.body));
    return turns.restoreTurn(req.centerDevice.deviceId, body);
  });
  host('GET', '/api/host/artifacts/:artifactRef', async (req, reply) => {
    const plans = store.listDeploymentPlans(req.centerDevice.deviceId);
    const admissionId = req.query?.admissionId;
    if (!plans.some(plan => plan.artifactRef === req.params.artifactRef)) {
      if (typeof admissionId !== 'string' || !(await turns.isArtifactAuthorized(req.centerDevice.deviceId, req.params.artifactRef, admissionId))) {
        fail('FORBIDDEN', 'Artifact not assigned');
      }
    }
    return reply.type('application/octet-stream').send(Buffer.from(await packages.readArtifact(req.params.artifactRef)));
  });
  host('POST', '/api/host/capabilities/:installationId/tools/list', req => execution.listTools(req.centerDevice.deviceId, req.params.installationId, object(req.body)));
  host('POST', '/api/host/capabilities/:installationId/tools/call', req => { const body = object(req.body); text(body.callId, 'callId'); text(body.name, 'name'); object(body.args); return execution.callTool(req.centerDevice.deviceId, req.params.installationId, body); });
  return { notifyInstallation, notifyDevice: notify, close() { for (const set of streams.values()) for (const stream of set) stream.reply.end(); streams.clear(); } };
}
