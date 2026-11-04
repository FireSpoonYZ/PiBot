import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Ajv from 'ajv';
import { defineExtension } from '@earendil-works/pi-durable';
import { loadNativePlugin } from './index.js';
import { createMcpDriver } from '../capabilities/mcp.js';
import { createSkillDriver } from '../capabilities/skill.js';

const error = (code, message) => Object.assign(new Error(message), { code });
const nameFor = (...parts) => 'cap-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const botKey = (botId, installationId) => botId + '\u0000' + installationId;
// 实例按安装 + 精确代码身份（版本）索引：不同 Bot 可同时绑定旧/新版本。
const instanceKey = (installationId, version) => installationId + '\u0000' + (version ?? '');
/** 授权意图：Center 提供 authorized 时以它为准（与瞬态部署状态分离），旧快照回退 enabled。 */
const isAuthorized = (capability) => capability?.authorized ?? capability?.enabled === true;
/** 授权且启用的能力才建立绑定；authorized:false 视为显式撤销，绝不由 pin 覆盖。 */
const canBind = (capability) => capability?.enabled === true && capability?.authorized !== false;
// 能力错误的线格式只允许短错误码与短消息，绝不回显配置或凭证。
const describe = (err) => ({
  code: typeof err?.code === 'string' && err.code ? err.code : 'CAPABILITY_APPLY_FAILED',
  message: typeof err?.message === 'string' && err.message ? err.message.slice(0, 200) : 'capability could not be applied',
});

export function createPluginManager({ host, registry, installer, services, isOnline }) {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, strict: false });
  ajv.addFormat('credential-ref', true);
  let instances = new Map(); // instanceKey(installationId, version) -> { key, installationId, plugin, manifest, version, bots, taskExtension }
  let active = false;
  let accepting = false;
  const activeOperations = new Map(); // 在飞操作 -> 所属 Bot（未知为 null）
  let policy = new Map(); // botId -> Map(installationId -> EffectiveCapability)
  const activeActions = new Set();
  const fingerprints = new Map(); // botId\0installationId -> 已应用的执行内容摘要
  const authorizations = new Map(); // botId\0installationId -> 已授权的授权摘要（kind/target + 凭据修订或值）
  const appliedSets = new Map(); // botId -> 最近一次完整原子应用成功的 setId
  // 本轮 applyBot 的准备上下文：仅用于放行能力自身在 prepare 期间的中心只读调用。
  let round = null;

  function assertCapabilityAllowed(botId, installationId) {
    if (!isOnline()) throw error('CENTER_OFFLINE', 'center is offline');
    if (!isAuthorized(policy.get(botId)?.get(installationId))) {
      throw error('EXTENSION_DISABLED', 'capability is disabled for this Bot');
    }
  }

  /** 按 Bot + 安装 ID 查找当前绑定的实例/贡献；同一安装的不同版本实例可并存。 */
  function boundEntry(botId, installationId) {
    for (const instance of instances.values()) {
      if (instance.installationId !== installationId) continue;
      const entry = instance.bots.get(botId);
      if (entry) return { instance, entry };
    }
    return null;
  }

  /** 同一安装 ID 当前加载的全部版本实例（用于关闭/通知覆盖正确版本）。 */
  function instancesFor(installationId) {
    return [...instances.values()].filter((instance) => instance.installationId === installationId);
  }

  async function runAccepted(operation, botId = null) {
    if (!accepting) throw error('RUNTIME_BUSY', 'capability execution is not accepting new work');
    const running = Promise.resolve().then(operation);
    activeOperations.set(running, botId);
    try { return await running; } finally { activeOperations.delete(running); }
  }

  async function checkOwner(botId, installationId, conversationId) {
    assertCapabilityAllowed(botId, installationId);
    if (await services.resolveConversationBot(conversationId) !== botId) {
      throw error('BOT_CONTEXT_REQUIRED', 'conversation is not owned by this Bot');
    }
    assertCapabilityAllowed(botId, installationId);
  }

  function guardContributions(bot, installationId, botId) {
    const source = bot.durableContributions ?? {};
    if (source.tasks?.length) throw error('INVALID_ARGUMENT', 'Bot contributions cannot register tasks');
    const tools = source.tools?.map((tool) => ({
      ...tool,
      async execute(args, api, context) {
        return runAccepted(async () => {
          await checkOwner(botId, installationId, api.conversationId);
          return tool.execute(args, api, context);
        }, botId);
      },
    }));
    const sections = source.sections?.map((item) => ({
      ...item,
      async render(input, context) {
        return runAccepted(async () => {
          await checkOwner(botId, installationId, input.conversationId);
          return item.render(input, context);
        }, botId);
      },
    }));
    const hooks = source.hooks?.map((item) => ({
      ...item,
      handlers: Object.fromEntries(Object.entries(item.handlers).map(([key, fn]) => [key, async (...args) => {
        return runAccepted(async () => {
          const api = args[args.length - 2];
          await checkOwner(botId, installationId, api.conversationId);
          return fn(...args);
        }, botId);
      }])),
    }));
    const wraps = source.wraps?.map((item) => ({
      ...item,
      wrap(original) {
        const wrapped = item.wrap(original);
        if (item.tool) return { ...wrapped, async execute(args, api, context) {
          return runAccepted(async () => {
            await checkOwner(botId, installationId, api.conversationId);
            return wrapped.execute(args, api, context);
          }, botId);
        } };
        return { ...wrapped, async render(input, context) {
          return runAccepted(async () => {
            await checkOwner(botId, installationId, input.conversationId);
            return wrapped.render(input, context);
          }, botId);
        } };
      },
    }));
    return { ...source, tasks: undefined, tools, sections, hooks, wraps };
  }

  /** 执行内容摘要：只包含会改变执行结果的字段（配置、凭证值、版本），不含展示名称。 */
  function capabilityFingerprint(capability, credentials) {
    const refs = capability.target === 'host' ? capability.credentialRefs ?? [] : [];
    return createHash('sha256').update(JSON.stringify([
      capability.kind, capability.target, capability.targetVersion,
      capability.effectiveConfig ?? null,
      refs.map((ref) => [ref, credentials?.[ref] ?? null]),
    ])).digest('hex');
  }

  /**
   * 授权摘要：只含“立即撤销”语义的字段——能力身份（kind/target）与凭据修订。
   * 凭据修订号优先；修订缺失的旧快照回退比较值。版本/普通配置变化不在这里，
   * 它们属于安全边界的绑定切换，不应即时中断在飞任务。
   */
  function authorizationFingerprint(capability, credentials) {
    const refs = capability?.target === 'host' ? capability.credentialRefs ?? [] : [];
    return createHash('sha256').update(JSON.stringify([
      capability?.kind ?? null, capability?.target ?? null,
      refs.map((ref) => [ref, capability?.credentialRevisions?.[ref] ?? credentials?.[ref] ?? null]),
    ])).digest('hex');
  }

  /**
   * 需要立即撤销授权的能力：当前已授权或已绑定，但已禁用/移除/显式 unauthorized，
   * 或引用凭据的修订（旧快照无修订时为值）发生变化。
   * 只返回硬撤销；版本/普通配置变化由 changedGrants 在安全边界处理。
   * 供调用方在“等空闲之前”先收紧授权。
   */
  function staleGrants(botId, capabilities, credentials) {
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    const ids = new Set([...(policy.get(botId)?.keys() ?? [])]);
    for (const instance of instances.values()) {
      if (instance.bots.has(botId)) ids.add(instance.installationId);
    }
    const stale = [];
    for (const id of ids) {
      const next = desired.get(id);
      if (!isAuthorized(next)) { stale.push(id); continue; }
      if (authorizations.get(botKey(botId, id)) !== authorizationFingerprint(next, credentials)) stale.push(id);
    }
    return stale;
  }

  /**
   * 需要在安全边界重建绑定的能力：仍获授权，但执行内容（版本/配置/凭据值）已变。
   * 不立即撤销授权、不结束任务；调用方在 Bot 空闲时通过 applyBot 切换，
   * 切换前旧绑定继续以原授权服务已在飞的固定工作。
   */
  function changedGrants(botId, capabilities, credentials) {
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    const changed = [];
    for (const [id, capability] of desired) {
      if (!canBind(capability) || !boundEntry(botId, id)) continue;
      if (fingerprints.get(botKey(botId, id)) !== capabilityFingerprint(capability, credentials)) changed.push(id);
    }
    return changed;
  }

  /**
   * 同步删除授权（策略维度，不做任何 await）：供调用方在拿到新快照后先于部署/空闲检查执行。
   * 返回确实被删除的安装 ID（用于后续幂等通知）。
   */
  function dropGrants(botId, installationIds) {
    const dropped = [];
    for (const id of installationIds ?? []) {
      const hadGrant = policy.get(botId)?.delete(id) === true;
      fingerprints.delete(botKey(botId, id));
      authorizations.delete(botKey(botId, id));
      if (hadGrant) dropped.push(id);
    }
    return dropped;
  }

  /** 异步通知插件策略（按 Bot 安全顺序由调用方安排）；覆盖该 Bot 绑定的全部已加载版本，失败不阻止撤销。 */
  async function notifyGrants(botId, installationIds, capabilities) {
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    for (const id of installationIds ?? []) {
      const next = desired.get(id);
      for (const instance of instancesFor(id)) {
        const entry = instance.bots.get(botId);
        if (!entry) continue;
        try {
          await entry.bot.onPolicyChanged?.({ enabled: isAuthorized(next),
            effectiveConfig: next?.effectiveConfig ?? {} });
        } catch { /* 策略通知失败不阻止撤销 */ }
      }
    }
  }

  /**
   * 立即撤销这些能力的授权并通知插件策略（策略维度，独立于实例生命周期）：
   * 旧贡献即使还没释放，后续工具/hook/动作调用也会在授权检查处被拒绝。
   */
  async function revoke(botId, installationIds, capabilities) {
    const dropped = dropGrants(botId, installationIds);
    if (dropped.length) await notifyGrants(botId, dropped, capabilities);
  }

  /** 这些安装实例注册的 Durable 任务名：用于撤销时只结束受影响任务（覆盖全部已加载版本）。 */
  function capabilityTaskNames(installationIds) {
    const names = new Set();
    for (const id of installationIds ?? []) {
      for (const instance of instancesFor(id)) {
        for (const task of instance.plugin.durableTasks ?? []) names.add(task.definition.name);
      }
    }
    return names;
  }

  async function releaseInstance(instance) {
    if (!instance || instance.bots.size > 0) return;
    instances.delete(instance.key);
    if (instance.taskExtension) registry.uninstall(instance.taskExtension);
    await instance.plugin.close();
  }

  /** 撤销一个 Bot/能力绑定：先收紧授权，再关闭贡献，错误只收集不抛出。
      extensionAlreadyReplaced：同名新扩展已原位替换旧扩展——按名 uninstall 会误删新扩展。
      retainInstance：同版本实例上有暂存未发布的新绑定——bots 暂空时不能 close 实例。 */
  async function releaseEntry(id, botId, notify, { extensionAlreadyReplaced = false, retainInstance = false } = {}) {
    policy.get(botId)?.delete(id);
    fingerprints.delete(botKey(botId, id));
    authorizations.delete(botKey(botId, id));
    const found = boundEntry(botId, id);
    if (!found) return [];
    const { instance, entry } = found;
    instance.bots.delete(botId);
    if (entry.extension && !extensionAlreadyReplaced) registry.uninstall(entry.extension);
    const errors = [];
    if (notify) {
      try { await entry.bot.onPolicyChanged?.(notify); } catch (err) { errors.push(err); }
    }
    try { await entry.bot.quiesce(); } catch (err) { errors.push(err); }
    try { await entry.bot.close(); } catch (err) { errors.push(err); }
    if (!retainInstance) {
      try { await releaseInstance(instance); } catch (err) { errors.push(err); }
    }
    return errors;
  }

  /** 打开（或复用）一个精确版本的安装实例；不同版本实例可并存，由各自的 Bot 绑定持有。 */
  async function openInstance(capability) {
    const id = capability.installationId;
    const key = instanceKey(id, capability.targetVersion);
    const existing = instances.get(key);
    if (existing) return { instance: existing, created: false };
    let installed = null;
    if (!(capability.kind === 'mcp' && capability.target === 'center')) {
      // 精确版本选择器：当前指针已移动时仍取回已准备的旧版本（pin 恢复）。
      installed = await installer.getInstalled(id, { version: capability.targetVersion });
      if (!installed || installed.version !== capability.targetVersion) {
        throw error('CAPABILITY_NOT_INSTALLED', 'capability version is not installed');
      }
    }
    const checkTarget = (requestedId, botId, allowPreparation) => {
      if (requestedId !== id) throw error('FORBIDDEN', 'capability does not match');
      if (allowPreparation && round?.preparing.has(botKey(botId, id)) && round.enabled.has(botKey(botId, id))) return;
      assertCapabilityAllowed(botId, id);
    };
    const scopedHost = { ...services,
      async tryRunBackgroundTask(botId, task) {
        if (!accepting || !isOnline() || !isAuthorized(policy.get(botId)?.get(id))) return false;
        await runAccepted(async () => { assertCapabilityAllowed(botId, id); await task(); }, botId);
        return true;
      },
      centerClient: {
        async listCapabilityTools(requestedId, botId, ...args) {
          checkTarget(requestedId, botId, true);
          const result = await services.centerClient.listCapabilityTools(requestedId, botId, ...args);
          checkTarget(requestedId, botId, true);
          return result;
        },
        async callCapabilityTool(requestedId, botId, ...args) {
          checkTarget(requestedId, botId, false);
          const result = await services.centerClient.callCapabilityTool(requestedId, botId, ...args);
          checkTarget(requestedId, botId, false);
          return result;
        },
      },
    };
    const args = {
      installationId: id, version: capability.targetVersion,
      target: capability.target, packageRoot: installed?.packageRoot ?? null,
      dataDir: installed?.dataDir ?? join(host.dataRoot, 'center-capabilities', id),
      host: scopedHost,
    };
    const manifest = installed?.manifest ?? {};
    const plugin = capability.kind === 'mcp' ? await createMcpDriver(args)
      : capability.kind === 'skill' ? await createSkillDriver(args)
      : await loadNativePlugin({ ...args, entry: manifest.components?.host?.entry });
    const instance = { key, installationId: id, plugin, manifest, version: capability.targetVersion,
      bots: new Map(), taskExtension: null };
    instances.set(key, instance);
    if (plugin.durableTasks?.length) {
      // 任务定义名在 registry 全局唯一：同一安装的其他版本仍在服务时无法共存，
      // 返回明确的阻塞准备错误并保留旧绑定，绝不卸载在飞任务强行推进。
      const names = new Set(plugin.durableTasks.map((task) => task.definition.name));
      const conflict = instancesFor(id).some((other) => other !== instance &&
        (other.plugin.durableTasks ?? []).some((task) => names.has(task.definition.name)));
      if (conflict) {
        instances.delete(key);
        try { await plugin.close(); } catch { /* 清理失败不掩盖原错误 */ }
        throw error('CAPABILITY_TASK_CONFLICT', 'capability task names conflict with a loaded version');
      }
      const tasks = plugin.durableTasks.map((task) => ({ ...task, definition: {
        ...task.definition,
        phases: Object.fromEntries(Object.entries(task.definition.phases).map(([name, phase]) => [name, async (taskState, runtime, context) => {
          return runAccepted(async () => {
            const botId = await services.resolveConversationBot(runtime.conversationId);
            assertCapabilityAllowed(botId, id);
            return phase(taskState, runtime, context);
          });
        }])),
      } }));
      // 扩展名含版本，任务定义名不变：旧任务 checkpoint 在活动版本卸载前仍可解析。
      instance.taskExtension = defineExtension({ name: nameFor(id, capability.targetVersion, 'tasks'), tasks });
      try {
        registry.install(instance.taskExtension);
      } catch (err) {
        instances.delete(key);
        try { await plugin.close(); } catch { /* 清理失败不掩盖原错误 */ }
        throw err;
      }
    }
    return { instance, created: true };
  }

  /** 准备单个 Bot/能力绑定；失败时只清理本次新建的实例，不影响其他 Bot 或能力。 */
  async function stageEntry(bot, capability, { deviceId, credentials }) {
    const id = capability.installationId;
    const botId = bot.botId;
    const scopedCredentials = Object.create(null);
    for (const ref of capability.target === 'host' ? capability.credentialRefs ?? [] : []) {
      if (typeof credentials?.[ref] !== 'string') throw error('CREDENTIAL_NOT_FOUND', 'capability credential is unavailable');
      scopedCredentials[ref] = credentials[ref];
    }
    let opened = null;
    try {
      opened = await openInstance(capability);
      const context = { deviceId, botId, installationId: id,
        effectiveConfig: capability.effectiveConfig, credentials: Object.freeze(scopedCredentials) };
      round?.preparing.add(botKey(botId, id));
      try {
        const contribution = await opened.instance.plugin.forBot(context);
        await contribution.prepare();
        const extension = defineExtension({ name: nameFor(id, capability.targetVersion, botId), ...guardContributions(contribution, id, botId) });
        return { id, instance: opened.instance, created: opened.created,
          entry: { bot: contribution, context, extension },
          fingerprint: capabilityFingerprint(capability, credentials),
          authorization: authorizationFingerprint(capability, credentials) };
      } finally { round?.preparing.delete(botKey(botId, id)); }
    } catch (err) {
      if (opened?.created && opened.instance.bots.size === 0) {
        try { await releaseInstance(opened.instance); } catch { /* 清理失败不掩盖原错误 */ }
      }
      throw err;
    }
  }

  async function dropStaged(staged) {
    try { await staged.entry.bot.quiesce(); } catch { /* 已失败绑定的销毁错误忽略 */ }
    try { await staged.entry.bot.close(); } catch { /* 已失败绑定的销毁错误忽略 */ }
    if (staged.created && staged.instance.bots.size === 0) {
      try { await releaseInstance(staged.instance); } catch { /* 已失败实例的释放错误忽略 */ }
    }
  }


  /** 禁用且从未绑定的 Host 插件也要撤销本地写策略，避免沿用上次运行的持久化授权。 */
  async function notifyDisabled(bot, capability, deviceId) {
    const id = capability.installationId;
    const loaded = instancesFor(id);
    if (loaded.length) {
      for (const instance of loaded) {
        await instance.plugin.onBotPolicyChanged?.({ deviceId, botId: bot.botId,
          enabled: false, effectiveConfig: capability.effectiveConfig });
      }
      return;
    }
    const installed = await installer.getInstalled(id);
    if (!installed) return;
    const offline = () => { throw error('CENTER_OFFLINE', 'capability is disabled'); };
    const temporary = await loadNativePlugin({ installationId: id, version: installed.version,
      entry: installed.manifest.components?.host?.entry, packageRoot: installed.packageRoot, dataDir: installed.dataDir,
      host: { ...services, tryRunBackgroundTask: async () => false,
        centerClient: { listCapabilityTools: offline, callCapabilityTool: offline } } });
    try {
      await temporary.onBotPolicyChanged?.({ deviceId, botId: bot.botId, enabled: false,
        effectiveConfig: capability.effectiveConfig });
    } finally { await temporary.close(); }
  }

  function desiredMap(capabilities) {
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    return desired;
  }

  function knownIds(botId, desired) {
    const known = new Set([...desired.keys(), ...(policy.get(botId)?.keys() ?? [])]);
    for (const instance of instances.values()) if (instance.bots.has(botId)) known.add(instance.installationId);
    return known;
  }

  function keepSet(botId, desired, credentials, active) {
    const keep = new Set();
    for (const [id, capability] of desired) {
      if (!canBind(capability)) continue;
      if (active && boundEntry(botId, id) &&
          fingerprints.get(botKey(botId, id)) === capabilityFingerprint(capability, credentials)) {
        keep.add(id);
      }
    }
    return keep;
  }

  /** 授权意图与瞬态部署状态分离：authorized 但未 enabled 的能力保留授权但不建立绑定。 */
  function grantAuthorizedExtras(botId, desired, granted, credentials) {
    for (const [id, capability] of desired) {
      if (capability.enabled === true || !isAuthorized(capability)) continue;
      granted.set(id, capability);
      authorizations.set(botKey(botId, id), authorizationFingerprint(capability, credentials));
    }
  }

  /** 校验一批暂存贡献的工具名唯一性与单一 context provider；返回可提交子集，失败记入 fail。 */
  function validateStaged(botId, staged, keep, releasing, fail) {
    const pluginExtensions = new Set();
    for (const instance of instances.values()) {
      for (const entry of instance.bots.values()) {
        if (entry.extension && !releasing.has(entry.extension)) pluginExtensions.add(entry.extension);
      }
    }
    const toolNames = new Set(registry.snapshot().installed()
      .filter((extension) => !pluginExtensions.has(extension))
      .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)));
    let contextProvider = false;
    for (const id of keep) {
      const entry = boundEntry(botId, id)?.entry;
      for (const tool of entry?.extension?.tools ?? []) toolNames.add(tool.name);
      if (entry?.bot.requestContributions?.prepareContext) contextProvider = true;
    }
    const committed = [];
    for (const stagedEntry of staged) {
      const tools = stagedEntry.entry.extension.tools ?? [];
      if (tools.some((tool) => toolNames.has(tool.name))) {
        fail(stagedEntry.id, error('INVALID_STATE', 'capability tool name is not unique for this Bot'));
        continue;
      }
      const provider = Boolean(stagedEntry.entry.bot.requestContributions?.prepareContext);
      if (provider && contextProvider) {
        fail(stagedEntry.id, error('INVALID_STATE', 'multiple context providers for this Bot'));
        continue;
      }
      for (const tool of tools) toolNames.add(tool.name);
      if (provider) contextProvider = true;
      committed.push(stagedEntry);
    }
    return committed;
  }

  /**
   * atomic:true：先暂存并校验全部启用贡献，再一次性切换；任何失败都保留旧绑定与授权，
   * 新 turn 绝不可能看到部分集合。调用方须保证该 Bot 已在安全边界（无在飞原生工作）。
   */
  async function applyBotAtomic(bot, capabilities, { deviceId, credentials, setId }) {
    const botId = bot.botId;
    const capabilityErrors = [];
    const fail = (installationId, err) => capabilityErrors.push({ botId, installationId, error: describe(err) });
    const desired = desiredMap(capabilities);
    const known = knownIds(botId, desired);
    const keep = keepSet(botId, desired, credentials, active);

    // 1. 暂存全部新绑定（旧绑定仍在线）；任一失败即整体放弃。
    round = { preparing: new Set(), enabled: new Set() };
    for (const [id, capability] of desired) if (capability.enabled === true) round.enabled.add(botKey(botId, id));
    const staged = [];
    let blocked = false;
    try {
      for (const id of known) {
        const capability = desired.get(id);
        if (!capability || !canBind(capability) || keep.has(id)) continue;
        try {
          staged.push(await stageEntry(bot, capability, { deviceId, credentials }));
        } catch (err) {
          fail(id, err);
          blocked = true;
        }
      }
    } finally { round = null; }

    // 2. 暂存完成后统一校验（不计将被替换的旧扩展）；失败同样整体放弃。
    const releasing = new Set();
    for (const instance of instances.values()) {
      const entry = instance.bots.get(botId);
      if (entry?.extension && !keep.has(instance.installationId)) releasing.add(entry.extension);
    }
    const committed = blocked ? [] : validateStaged(botId, staged, keep, releasing, fail);
    if (blocked || committed.length !== staged.length) {
      for (const stagedEntry of staged) await dropStaged(stagedEntry);
      return { capabilityErrors };
    }

    // 3. 校验通过后一次性切换：先注册并激活全部新绑定（旧绑定仍在线），
    // 任一步失败只拆除本次新绑定、恢复被同名替换的旧扩展、完全保留旧绑定/授权——绝不暴露部分集合。
    // granted 在发布成功后组装（keep + extras + 新绑定）；回滚只须恢复 registry/贡献，不动 policy。
    const granted = new Map();
    for (const id of keep) granted.set(id, desired.get(id));
    // 同版本仅配置变化会产生同名扩展：install 是原位替换，回滚时须装回旧对象。
    const replacedByName = new Map(); // extension.name -> 被替换的旧 extension 对象
    for (const extension of registry.snapshot().installed()) {
      replacedByName.set(extension.name, extension);
    }
    const installed = [];
    const rollback = async (unpublished) => {
      // installed 逆序拆除（含刚 activate 失败的条目）；unpublished 是尚未注册的暂存尾部。
      for (const done of installed.reverse()) {
        try { registry.uninstall(done.entry.extension); } catch { /* 卸载失败不掩盖原错误 */ }
        const prior = replacedByName.get(done.entry.extension.name);
        if (prior) {
          try { registry.install(prior); } catch { /* 恢复旧扩展失败不掩盖原错误 */ }
        }
        await dropStaged(done);
      }
      for (const rest of unpublished) await dropStaged(rest);
      return { capabilityErrors };
    };
    for (let index = 0; index < committed.length; index += 1) {
      const stagedEntry = committed[index];
      try {
        registry.install(stagedEntry.entry.extension);
      } catch (err) {
        fail(stagedEntry.id, err);
        return rollback(committed.slice(index));
      }
      installed.push(stagedEntry);
    }
    // activate 前预发布完整意图授权：插件 activate 内部经 assertCapabilityAllowed 读 policy，
    // 新启用/轮换的绑定此刻必须已在其授权下；回滚时恢复旧 policy 快照。
    const priorPolicy = policy.get(botId);
    const preGranted = new Map();
    for (const id of keep) preGranted.set(id, desired.get(id));
    for (const stagedEntry of installed) preGranted.set(stagedEntry.id, desired.get(stagedEntry.id));
    // extras 授权预写前先快照旧值：回滚须逐键恢复，不能用「无旧值就删」——
    // 否则会把本来就存在的旧授权一并抹掉。
    const priorExtrasAuth = new Map();
    for (const [id, capability] of desired) {
      if (capability.enabled === true || !isAuthorized(capability)) continue;
      priorExtrasAuth.set(id, authorizations.get(botKey(botId, id)));
    }
    grantAuthorizedExtras(botId, desired, preGranted, credentials);
    policy.set(botId, preGranted);
    if (active) {
      for (let index = 0; index < installed.length; index += 1) {
        const stagedEntry = installed[index];
        try { await stagedEntry.entry.bot.activate(); }
        catch (err) {
          fail(stagedEntry.id, err);
          policy.set(botId, priorPolicy ?? new Map());
          if (!priorPolicy) policy.delete(botId);
          // 预发布的 extras 授权一并回滚，保持内存状态与旧 set 完全一致。
          for (const [extraId, priorAuth] of priorExtrasAuth) {
            if (priorAuth === undefined) authorizations.delete(botKey(botId, extraId));
            else authorizations.set(botKey(botId, extraId), priorAuth);
          }
          // 全部条目都已注册：installed 逆序已覆盖每个新绑定，无未注册尾部——绝不重复清理。
          return rollback([]);
        }
      }
    }
    // 4. 全部新绑定已就绪：先让旧绑定感知新政策，再退休旧绑定并发布完整新 set。
    // 同名扩展已被新绑定原位替换的旧条目不得再按名卸载；同版本实例保留给暂存新绑定。
    const replacedNames = new Set(installed.map((stagedEntry) => stagedEntry.entry.extension.name));
    const retainedInstances = new Set(installed.map((stagedEntry) => stagedEntry.instance));
    const releasedIds = new Set();
    for (const id of known) {
      if (keep.has(id)) continue;
      const next = desired.get(id);
      const found = boundEntry(botId, id);
      const errors = await releaseEntry(id, botId,
        { enabled: isAuthorized(next), effectiveConfig: next?.effectiveConfig ?? {} },
        {
          extensionAlreadyReplaced: Boolean(found?.entry?.extension && replacedNames.has(found.entry.extension.name)),
          retainInstance: Boolean(found && retainedInstances.has(found.instance)),
        });
      releasedIds.add(id);
      if (!canBind(next)) for (const err of errors) fail(id, err);
    }
    for (const stagedEntry of installed) {
      const { id, instance, entry } = stagedEntry;
      instance.bots.set(botId, entry);
      fingerprints.set(botKey(botId, id), stagedEntry.fingerprint);
      authorizations.set(botKey(botId, id), stagedEntry.authorization);
      granted.set(id, desired.get(id));
    }
    grantAuthorizedExtras(botId, desired, granted, credentials);
    policy.set(botId, granted);
    // 发布后通知属于非致命尾部：set 已不可回滚，通知失败不当作原子失败上报（与普通 applyBot 一致）。
    for (const stagedEntry of installed) {
      const { id, entry } = stagedEntry;
      try { await entry.bot.onPolicyChanged?.({ enabled: true, effectiveConfig: entry.context.effectiveConfig }); }
      catch { /* 已发布集合的通知失败不阻断本轮准入 */ }
    }

    // 4. 禁用且本次未释放过的 Host 插件撤销本地策略（避免沿用上次运行的持久化授权）。
    for (const [id, capability] of desired) {
      if (canBind(capability) || capability.kind !== 'plugin' || capability.target !== 'host') continue;
      if (keep.has(id) || releasedIds.has(id)) continue;
      try { await notifyDisabled(bot, capability, deviceId); } catch (err) { fail(id, err); }
    }
    if (capabilityErrors.length === 0 && setId != null) appliedSets.set(botId, setId);
    return { capabilityErrors };
  }

  /**
   * 按 Bot 增量应用中心快照：保留未变化绑定，只重建变化/新增的能力；
   * 单个能力准备或注册失败只记录 RuntimeCapabilityError，其他 Bot 与基础聊天继续服务。
   * atomic:true 时先暂存并校验完整启用集合再发布，失败不暴露部分集合、保留旧绑定。
   * 调用方须保证该 Bot 已在安全边界（空闲）。
   */
  async function applyBot(bot, capabilities, { deviceId, credentials, atomic = false, setId = null }) {
    if (atomic) return applyBotAtomic(bot, capabilities, { deviceId, credentials, setId });
    const botId = bot.botId;
    appliedSets.delete(botId);
    const capabilityErrors = [];
    const fail = (installationId, err) => capabilityErrors.push({ botId, installationId, error: describe(err) });
    const desired = desiredMap(capabilities);
    const known = knownIds(botId, desired);
    const keep = keepSet(botId, desired, credentials, active);
    const granted = new Map();
    for (const id of keep) granted.set(id, desired.get(id));
    policy.set(botId, granted);

    // 2. 释放被替换或移除的旧绑定。
    const releasedIds = new Set();
    for (const id of known) {
      if (keep.has(id)) continue;
      const next = desired.get(id);
      const errors = await releaseEntry(id, botId,
        { enabled: isAuthorized(next), effectiveConfig: next?.effectiveConfig ?? {} });
      releasedIds.add(id);
      // 被替换能力的清理错误不掩盖新绑定结果；移除/禁用的才作为能力错误上报。
      if (!canBind(next)) for (const err of errors) fail(id, err);
    }
    // 授权未撤销但暂不启用的能力保留授权（不建立绑定）。
    grantAuthorizedExtras(botId, desired, granted, credentials);
    policy.set(botId, granted);

    // 3. 准备新绑定，单个能力失败隔离。
    round = { preparing: new Set(), enabled: new Set() };
    for (const [id, capability] of desired) if (capability.enabled === true) round.enabled.add(botKey(botId, id));
    const staged = [];
    try {
      for (const id of known) {
        const capability = desired.get(id);
        if (!capability || !canBind(capability) || keep.has(id)) continue;
        try {
          staged.push(await stageEntry(bot, capability, { deviceId, credentials }));
        } catch (err) {
          fail(id, err);
        }
      }
    } finally { round = null; }

    // 4. 该 Bot 的工具名唯一性与单一 context provider。
    const committed = validateStaged(botId, staged, keep, new Set(), fail);
    for (const stagedEntry of staged) {
      if (!committed.includes(stagedEntry)) await dropStaged(stagedEntry);
    }

    // 5. 提交新绑定（旧绑定已释放，同名扩展不会互相覆盖）。
    for (const stagedEntry of committed) {
      const { id, instance, entry } = stagedEntry;
      try {
        registry.install(entry.extension);
      } catch (err) {
        fail(id, err);
        await dropStaged(stagedEntry);
        continue;
      }
      instance.bots.set(botId, entry);
      fingerprints.set(botKey(botId, id), stagedEntry.fingerprint);
      authorizations.set(botKey(botId, id), stagedEntry.authorization);
      granted.set(id, desired.get(id));
      policy.set(botId, granted);
      if (active) {
        try { await entry.bot.activate(); }
        catch (err) {
          fail(id, err);
          await releaseEntry(id, botId, { enabled: false, effectiveConfig: entry.context.effectiveConfig });
          granted.delete(id);
          policy.set(botId, granted);
          continue;
        }
      }
      try { await entry.bot.onPolicyChanged?.({ enabled: true, effectiveConfig: entry.context.effectiveConfig }); }
      catch (err) { fail(id, err); }
    }

    // 6. 禁用且本次未释放过的 Host 插件撤销本地策略（避免沿用上次运行的持久化授权）。
    for (const [id, capability] of desired) {
      if (canBind(capability) || capability.kind !== 'plugin' || capability.target !== 'host') continue;
      if (keep.has(id) || releasedIds.has(id)) continue;
      try { await notifyDisabled(bot, capability, deviceId); } catch (err) { fail(id, err); }
    }
    if (capabilityErrors.length === 0 && setId != null) appliedSets.set(botId, setId);
    return { capabilityErrors };
  }

  async function activate() {
    if (active) return { capabilityErrors: [] };
    const capabilityErrors = [];
    for (const instance of [...instances.values()]) {
      for (const [botId, entry] of [...instance.bots]) {
        try {
          await entry.bot.activate();
        } catch (err) {
          capabilityErrors.push({ botId, installationId: instance.installationId, error: describe(err) });
          // 半激活的能力必须撤销授权，不能沿用旧权限继续执行。
          await releaseEntry(instance.installationId, botId, { enabled: false, effectiveConfig: entry.context.effectiveConfig });
        }
      }
    }
    active = true;
    return { capabilityErrors };
  }

  async function quiesce() {
    active = false;
    for (const action of activeActions) action.controller.abort(error('CENTER_OFFLINE', 'center is offline'));
    const errors = [];
    for (const instance of instances.values()) {
      for (const entry of instance.bots.values()) {
        try { await entry.bot.quiesce(); } catch (err) { errors.push(err); }
      }
    }
    await Promise.allSettled([...activeOperations.keys(), ...[...activeActions].map((action) => action.operation)]);
    if (errors.length) throw new AggregateError(errors, 'plugin quiesce failed');
  }

  function extensionsFor(botId) {
    return [...instances.values()].flatMap((instance) => {
      const entry = instance.bots.get(botId);
      return entry ? [entry.extension] : [];
    });
  }

  async function prepareContext(request, api, context) {
    const botId = await services.resolveConversationBot(api.conversationId);
    const providers = [...instances.values()].flatMap((instance) => {
      const hook = instance.bots.get(botId)?.bot.requestContributions?.prepareContext;
      return hook ? [{ id: instance.installationId, hook }] : [];
    });
    if (providers.length > 1) throw error('INVALID_STATE', 'multiple context providers for this Bot');
    if (!providers.length) return request;
    const { id, hook } = providers[0];
    return runAccepted(async () => {
      context.abortSignal?.throwIfAborted();
      await checkOwner(botId, id, api.conversationId);
      context.abortSignal?.throwIfAborted();
      const next = { ...request, ...(await hook(request, api, context)) };
      context.abortSignal?.throwIfAborted();
      await checkOwner(botId, id, api.conversationId);
      context.abortSignal?.throwIfAborted();
      return next;
    }, botId);
  }

  async function beforeRequest(request, api, context) {
    const botId = await services.resolveConversationBot(api.conversationId);
    let result = request;
    for (const instance of instances.values()) {
      const entry = instance.bots.get(botId);
      const hook = entry?.bot.requestContributions?.beforeRequest;
      if (!hook) continue;
      const id = instance.installationId;
      result = await runAccepted(async () => {
        context.abortSignal?.throwIfAborted();
        await checkOwner(botId, id, api.conversationId);
        context.abortSignal?.throwIfAborted();
        const next = { ...result, ...(await hook(result, api, context)) };
        context.abortSignal?.throwIfAborted();
        await checkOwner(botId, id, api.conversationId);
        context.abortSignal?.throwIfAborted();
        return next;
      }, botId);
    }
    return result;
  }

  async function action(installationId, actionId, request) {
    if (!accepting) throw error('RUNTIME_BUSY', 'capability execution is not accepting new work');
    if (!request || typeof request.requestId !== 'string' || !request.requestId || typeof request.botId !== 'string' || !request.botId || !Object.hasOwn(request, 'input')) {
      throw error('INVALID_ARGUMENT', 'invalid capability action request');
    }
    if (request.deviceId !== host.deviceId) throw error('FORBIDDEN', 'device does not match');
    assertCapabilityAllowed(request.botId, installationId);
    const found = boundEntry(request.botId, installationId);
    const entry = found?.entry;
    const descriptor = found?.instance.manifest.actions?.find((item) => item.id === actionId);
    const action = entry?.bot.actions?.[actionId];
    if (!descriptor || !action) throw error('NOT_FOUND', 'capability action not found');
    if (!ajv.validate(descriptor.inputSchema, request.input) || !ajv.validate(action.inputSchema, request.input)) throw error('VALIDATION_FAILED', 'invalid action input');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(error('TIMEOUT', 'capability action timed out')), 120000);
    timer.unref?.();
    const operation = Promise.resolve().then(() => {
      assertCapabilityAllowed(request.botId, installationId);
      controller.signal.throwIfAborted();
      return action.execute(request.input, { ...entry.context, requestId: request.requestId, abortSignal: controller.signal });
    });
    const running = { operation, controller, botId: request.botId };
    activeActions.add(running);
    operation.then(() => activeActions.delete(running), () => activeActions.delete(running));
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let result;
    try { result = await Promise.race([operation, aborted]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
    assertCapabilityAllowed(request.botId, installationId);
    if (descriptor.outputSchema !== undefined && !ajv.validate(descriptor.outputSchema, result)) {
      throw error('VALIDATION_FAILED', 'invalid action output');
    }
    return { result };
  }

  async function actionByName(botId, actionId, input) {
    const matches = [...instances.values()].filter((instance) => instance.bots.has(botId) &&
      instance.manifest.actions?.some((descriptor) => descriptor.id === actionId));
    if (matches.length === 0) throw error('EXTENSION_DISABLED', 'capability action is unavailable');
    if (matches.length > 1) throw error('INVALID_STATE', 'capability action is ambiguous');
    return (await action(matches[0].installationId, actionId, { deviceId: host.deviceId, botId, requestId: input?.requestId ?? randomUUID(), input: input ?? {} })).result;
  }

  async function close() {
    const errors = [];
    for (const instance of [...instances.values()]) {
      for (const botId of [...instance.bots.keys()]) {
        errors.push(...await releaseEntry(instance.installationId, botId, null));
      }
      try { await releaseInstance(instance); } catch (err) { errors.push(err); }
    }
    instances = new Map();
    policy = new Map();
    fingerprints.clear();
    authorizations.clear();
    appliedSets.clear();
    active = false;
    if (errors.length) throw new AggregateError(errors, 'plugin cleanup failed');
  }

  return {
    applyBot, activate, quiesce, close, staleGrants, changedGrants, revoke, dropGrants, notifyGrants, capabilityTaskNames,
    assertCapabilityAllowed, extensionsFor, prepareContext, beforeRequest, action, actionByName,
    isActive: () => active,
    appliedSetId: (botId) => appliedSets.get(botId) ?? null,
    hasActiveExecutions: (botId) => botId === undefined
      ? activeOperations.size > 0 || activeActions.size > 0
      : [...activeOperations.values()].some((id) => id === botId) || [...activeActions].some((item) => item.botId === botId),
    suspend() { accepting = false; },
    resumeAdmissions() { accepting = true; },
    abortActions() { for (const action of activeActions) action.controller.abort(error('CENTER_OFFLINE', 'center is offline')); },
  };
}
