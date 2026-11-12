import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as durable from '@earendil-works/pi-durable';
import * as chord from '@earendil-works/chord';
import { Harness, createRegistry, defineExtension, section, hook, GenerationTask } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { InlineCodemodeSandbox } from '@earendil-works/pi-codemode/portable';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { createAndroidTools } from './android-tools.js';
import { createHostExecutionEnv } from './host-environment.js';
import { openHost } from './host.js';
import { acquireRuntimeOwner } from './runtime-owner.js';
import { migrateBotSessionCheckpoints } from './bot-session-checkpoint-migration.js';
import { parseExecutionOptions, parseModelRef, normalizeThinkingLevel, normalizeCodemodeFlag, describeModelCatalog, discoverProviderModels, applyCenterModels } from './runtime-models.js';
import { createGrepTool } from './grep-tool.js';
import { createFindTool } from './find-tool.js';
import { createLsTool } from './ls-tool.js';
import { getPrimaryConversation, RequestKeys, PrimaryIndex, applyAgentProfile } from './runtime-docs.js';
import { formatPrimarySubmission, latestResetEntryId, normalizeHistoryOptions, readPrimaryHistory } from './runtime-history.js';
import { RequestContext, countMessageTokens, estimateContextTokensHost, budgetRequestTokens } from './request-context.js';
import { GenerationFailureState } from './generation-failure.js';
import { resolveBotIdentity } from './bot-identity.js';
import { createPluginManager } from './plugins/manager.js';
import { createRuntimeLive } from './runtime-live.js';
import { botBoardResultHooks, clearBotBoardResult } from './runtime-bot-board.js';
import { readScopeHistory, readScopeMessage, readScopeMessageDelivery } from './runtime-scope-queries.js';
import { createWorkContextRuntime } from './runtime-work-contexts.js';
import { WorkIndex, WorkContextState, workInstructions } from './work-context-docs.js';
import { WorkDecisionState } from './work-decision-state.js';
import { createWorkDecisionRuntime } from './runtime-work-decisions.js';
import { createTurnAdmission } from './runtime-turns.js';
import { createBotSessionRuntime } from './runtime-bot-session.js';
import { BotSessionState, USER_MESSAGE_KIND, WORK_TRIGGER_KIND, deriveEntryAttribution } from './bot-session-context.js';
import { createBotLearning } from './bot-learning.js';
import { createBotManagementSkillSection } from './bot-management-skill.js';
import { SOUL_MAX_BYTES } from './bot-soul.js';
import { normalizeUserMessage } from './scope-protocol.js';
import { createCommunicationTools } from './communication-tools.js';
import { createSessionSearchTool } from './session-search-tool.js';
import { createCollaborationService } from './collaboration-service.js';
import { BASE_BEHAVIOR_PROMPT } from './bot-prompt.js';
import { renderCollaborationPrompt } from './collaboration-prompt.js';
import { createCuaTools } from './cua-tools.js';
import { createShowerManager } from './shower-manager.js';
import { createShowerTools } from './shower-tools.js';
import { createRuntimeShower } from './runtime-shower.js';
import { createVaultService } from './vault-service.js';
import { createScheduleManager } from './host-schedules.js';
import { createWebhookConsumer } from './host-webhooks.js';
import { createScheduleTools } from './schedule-tools.js';
import {
  attachmentPath,
  loadAttachment,
  normalizeAttachmentIds,
  removeBotAttachments,
  uploadAttachment,
} from './attachments.js';
import { putBotFileChunk } from './bot-files.js';
import { normalizeBotFileChunk } from './bot-file-protocol.js';
import { withCodemodePresentations } from './codemode-presentations.js';

const CTX = BACKGROUND_CONTEXT;
const BOTS_SYNC_THROTTLE_MS = 1000;
// 手动 /compact 的附加保留指令：统一主会话跨 scope 共享，摘要必须保留消息来源
//（发送者/设备/scope/messageId/replyTo）与未决外发请求的回复去向，
// 否则压缩后迟到回复会失去可续接的原始渠道。
const BOT_SESSION_COMPACT_INSTRUCTIONS = [
  'Preserve for every relevant message its real sender (user/bot/host, botId, deviceId), channel/scope, messageId and replyTo linkage; names are display only.',
  'Preserve every outstanding outgoing request and its originating reply target (primary user chat, bot DM or room scope) so late replies can resume the right destination.',
  'Do not drop notices or self-echo facts that explain why no acknowledgement was sent.',
].join(' ');
const ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ARCHIVE_PURGE_INTERVAL_MS = 6 * 3600 * 1000;

let quickJsWasmPromise = null;
function loadHostQuickJsWasm() {
  if (!quickJsWasmPromise) {
    quickJsWasmPromise = (async () => {
      const runtimeDir = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        join(runtimeDir, 'quickjs.wasm'),
        join(runtimeDir, 'node_modules', 'quickjs-wasi', 'quickjs.wasm'),
      ];
      let lastErr = null;
      for (const candidate of candidates) {
        try {
          const bytes = await readFile(candidate);
          return await globalThis.WebAssembly.compile(bytes);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new Error('quickjs.wasm not found');
    })().catch((err) => {
      quickJsWasmPromise = null;
      throw err;
    });
  }
  return quickJsWasmPromise;
}

function createHostCodemodeSandbox() {
  return new InlineCodemodeSandbox({
    wasm: {
      then(onFulfilled, onRejected) {
        return loadHostQuickJsWasm().then(onFulfilled, onRejected);
      },
    },
  });
}

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNonBlank(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errWithCode(`${name} must be a non-empty string`, 'INVALID_ARGUMENT');
  }
}

// 生命周期回执的线格式：错误码与短消息，绝不含配置或凭证。
function toRuntimeError(err) {
  const code = typeof err?.code === 'string' && err.code ? err.code : 'RUNTIME_APPLY_FAILED';
  const message = typeof err?.message === 'string' && err.message
    ? err.message.slice(0, 200) : 'runtime configuration could not be applied';
  return { code, message };
}

/**
 * 每 Bot FIFO 准入：同一 Bot 的发送、设置与工作操作串行，不同 Bot 互不阻塞。
 * 关闭时立即拒绝新准入，并排空已接纳操作（调用方仍各自收到自己的失败）。
 * 配置应用用 tryExclusive：同一条 lane 串行，但从不等待已有任务（忙即返回 false），
 * 因此不会与 send/设置或生命周期队列互相等死锁；准入暂停（启动/断线）时仍可应用配置。
 */
function createBotAdmission() {
  const lanes = new Map();
  const accepted = new Set();
  let closed = false;
  let suspended = false;

  function track(botId, start) {
    const task = Promise.resolve().then(start);
    lanes.set(botId, task);
    accepted.add(task);
    const release = () => {
      accepted.delete(task);
      if (lanes.get(botId) === task) lanes.delete(botId);
    };
    task.then(release, release);
    return task;
  }

  function admit(botId, operation) {
    if (typeof botId !== 'string' || botId === '') {
      return Promise.reject(errWithCode('botId must be a non-empty string', 'INVALID_ARGUMENT'));
    }
    if (closed || suspended) return Promise.reject(errWithCode('host is not connected', 'NOT_CONNECTED'));
    const start = () => {
      if (closed || suspended) throw errWithCode('host is not connected', 'NOT_CONNECTED');
      return operation();
    };
    const previous = lanes.get(botId);
    if (!previous) return track(botId, start);
    const task = previous.then(start, start);
    lanes.set(botId, task);
    accepted.add(task);
    const release = () => {
      accepted.delete(task);
      if (lanes.get(botId) === task) lanes.delete(botId);
    };
    task.then(release, release);
    return task;
  }

  /** 占用同一 lane 但不等已有任务：该 Bot 当前有排队/在操作时返回 false（调用方报 waiting-idle）。 */
  function tryExclusive(botId, operation) {
    if (typeof botId !== 'string' || botId === '') {
      return Promise.reject(errWithCode('botId must be a non-empty string', 'INVALID_ARGUMENT'));
    }
    if (closed || lanes.has(botId)) return Promise.resolve(false);
    return track(botId, () => {
      if (closed) throw errWithCode('host is not connected', 'NOT_CONNECTED');
      return operation();
    }).then(() => true);
  }

  async function close() {
    closed = true;
    while (accepted.size > 0) await Promise.allSettled([...accepted]);
  }

  return { admit, tryExclusive, close, suspend() { suspended = true; }, resume() { suspended = false; },
    async drain() { while (accepted.size) await Promise.allSettled([...accepted]); } };
}

/**
 * Open the Pi Durable primary private-chat runtime for one host.
 * Ownership of dataRoot is exclusive for the runtime's lifetime; close() releases it.
 */
export async function openRuntime(options) {
  // 执行选项先于任何写数据校验：bashPath/toolPaths 类型错误在打开 host 前拒绝。
  const execution = parseExecutionOptions(options);
  // 可信原生桥接仅进程注入时接受：非函数直接拒绝，且绝不来自配置/HTTP/relay。
  const nativeBridge = options?.nativeBridge;
  if (nativeBridge !== undefined && typeof nativeBridge !== 'function') {
    throw errWithCode('nativeBridge must be a function', 'INVALID_ARGUMENT');
  }
  const centerRuntime = options?.centerRuntime;
  if (!centerRuntime?.snapshot || !centerRuntime.installer || typeof centerRuntime.getClient !== 'function') {
    throw errWithCode('center runtime is required', 'CENTER_OFFLINE');
  }
  const host = openHost({ dataRoot: options?.dataRoot });
  const models = options?.models ?? createModels();
  const defaultModel = null;
  let releaseOwner = null;
  let storage = null;
  let harness = null;
  let workContexts = null;
  let coreExtensions = [];
  let online = false;
  let maintenance = false;
  let botModels = {};
  let getBotEntryWatermark;
  let runtime;
  const collaboration = createCollaborationService({
    host,
    ...options?.collaboration,
    createLocalBot: (input) => runtime.createBot(input),
    scheduleLocalTask: (botId, input) => runtime.scheduleTask(botId, input),
    getLocalRuntime: () => runtime,
    getCenterClient: () => centerRuntime.getClient(),
  });

  // 每 conversationId+cwd 一个执行环境；绝不 process.chdir 或默认 process.cwd，缺 cwd 明确报错。
  const envCache = new Map();
  const envFor = (target) => {
    const cwd = target.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw errWithCode(`conversation ${target.conversationId} has no cwd; configure the bot cwd before sending`, 'INVALID_ARGUMENT');
    }
    const key = target.conversationId + '\u0000' + cwd;
    let env = envCache.get(key);
    if (!env) {
      env = createHostExecutionEnv({ cwd, bashPath: execution.bashPath });
      envCache.set(key, env);
    }
    return env;
  };
  // 契约 A：Host 主动中止前的安全失败诊断，写入会话作用域家族文档
  // （键 = String(生成任务 id)）。只记已知 Host 错误码对应的固定安全文案，
  // 未知/插件/provider 错误一律固定通用消息——绝不透传 err.message
  //（可能含凭据/请求细节）。存储层失败（SessionFailed）不吞，原样传播。
  const HOST_FAILURE_MESSAGES = {
    CENTER_OFFLINE: 'center is offline',
    MODEL_REQUIRED: 'center model is required',
    INVALID_STATE: 'request state is invalid',
    CONTEXT_LIMIT: 'context limit reached',
    BOT_CONTEXT_REQUIRED: 'conversation ownership is ambiguous',
  };
  const recordGenerationFailure = async (api, err, context) => {
    try {
      const known = typeof err?.code === 'string' && Object.hasOwn(HOST_FAILURE_MESSAGES, err.code);
      const code = known ? err.code : 'GENERATION_FAILED';
      const message = known ? HOST_FAILURE_MESSAGES[err.code] : 'generation failed before the provider request';
      await harness.commit(async (tx) => {
        const doc = await tx.doc(GenerationFailureState, api.conversationId, String(api.taskId));
        doc.failure = { code, message };
      }, context);
    } catch (commitErr) {
      if (commitErr instanceof durable.SessionFailed) throw commitErr;
      /* 诊断尽力而为，绝不覆盖原错误 */
    }
  };
  // Drop cached environments for one bot's mapped conversations and its plugin lane;
  // called only inside the idle apply boundary so no in-flight tool run loses its env.
  const dropBotEnvs = async (nativeIds, botId) => {
    const dropped = [];
    const ids = new Set(nativeIds.map((id) => String(id)));
    const pluginKey = 'plugin:' + botId + '\u0000';
    for (const [key, env] of [...envCache]) {
      const conv = key.split('\u0000')[0];
      if (!ids.has(conv) && !key.startsWith(pluginKey)) continue;
      envCache.delete(key);
      dropped.push(env);
    }
    const results = await Promise.allSettled(dropped.map((env) => env.cleanup(CTX)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result) => result.reason), 'bot env cleanup failed');
    }
  };
  // Drop the cached env of exactly one conversation (used when a learning
  // review conversation finishes); unlike dropBotEnvs it never touches the plugin lane.
  const dropEnvFor = async (nativeId) => {
    const prefix = String(nativeId) + '\u0000';
    const dropped = [];
    for (const [key, env] of [...envCache]) {
      if (!key.startsWith(prefix)) continue;
      envCache.delete(key);
      dropped.push(env);
    }
    const results = await Promise.allSettled(dropped.map((env) => env.cleanup(CTX)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result) => result.reason), 'conversation env cleanup failed');
    }
  };
  const cleanupEnvs = async () => {
    const envs = [...envCache.values()];
    envCache.clear();
    const results = await Promise.allSettled(envs.map((env) => env.cleanup(CTX)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result) => result.reason), `env cleanup failed for ${failures.length} environment(s)`);
    }
  };
  // 每 Bot 准入队列归本 Runtime：send/设置/工作操作共用，关闭时先拒新准入再排空。
  const bots = createBotAdmission();
  bots.suspend();
  // 统一 Bot 主会话：用户私聊、Bot 私聊与普通群聊共用既有 primary Durable 会话；
  // scope 账本仍是消息事实源，sessions 负责增量导入、冻结轮来源/回复目标与请求/回复对账。
  // 全部下游依赖（decisions/通信工具/work contexts/turns 准入）经 sessions 注入；
  // getMessageLog/getPrimary 走惰性回调，被调用时 workContexts/模型选择必然已就绪。
  const sessions = createBotSessionRuntime({
    host,
    getHarness: () => harness,
    getMessageLog: () => workContexts.getMessageLog(),
    context: CTX,
    // 与准入泵同口径解析/配置主会话：已映射直接返回；未映射用当前 Center 模型选择
    // 与 profile 创建（导入需要可写目标），随后应用人格/工具，保证导入与执行同一会话。
    getPrimary: async (bot) => {
      const profile = botProfile(host, plugins, botModels, coreExtensions, codemodeExtension, finalBudgetExtension, bot.botId, null);
      let conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        const modelRef = botModels[bot.botId]?.modelRef;
        if (!modelRef) throw errWithCode('center model is required', 'MODEL_REQUIRED');
        conversation = await getPrimaryConversation(harness, { ...bot, modelRef }, {
          create: true,
          defaultModel: modelRef,
          thinkingLevel: profile.thinkingLevel,
          instructions: profile.instructions,
          removeTools: profile.removeTools,
          selectedExtensions: profile.selectedExtensions,
          codemodeOnly: profile.codemodeOnly,
        }, CTX);
      }
      await applyAgentProfile(harness, conversation.id, profile, CTX);
      return conversation;
    },
  });
  const decisions = createWorkDecisionRuntime({
    sessions,
    host,
    getHarness: () => harness,
    getWorkContexts: () => workContexts,
    models,
    defaultModel,
    context: CTX,
    collaboration,
    // 工作决策的 stop/resume/advance 在同一 Bot 队列内执行；scope lane 在前，Bot lane 在后。
    admitBot: bots.admit,
    getProfile: (botId, workMeta) => botProfile(host, plugins, botModels, coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta),
  });

  // 统一图形环境：管理器按注入的可信原生桥接（Android）或当前平台（Windows/Linux）选后端；
  // 构造不启动原生/进程资源；Windows 启动时准备管理员授权，图形会话仍由首次 ensure 按需创建，随 Runtime 关闭释放。
  const shower = createShowerManager({ dataRoot: host.dataRoot, nativeBridge });
  const vault = await createVaultService({ host, getHarness: () => harness, shower, isMaintenance: () => maintenance, centerVault: centerRuntime.centerVault ?? null });
  const schedules = createScheduleManager({
    host,
    getRuntime: () => runtime,
    isOnline: () => online && !maintenance,
    nativeBridge,
  });
  const registry = createRegistry();
  registry.install(defineExtension({
    name: 'host.base-behavior',
    sections: [section('host-base-behavior', () => BASE_BEHAVIOR_PROMPT)],
  }));
  registry.install(createCodingTools());
  registry.install(defineExtension({
    name: 'host.bot-board',
    hooks: [hook(GenerationTask, botBoardResultHooks(() => harness))],
  }));
  registry.install(createToolSearchExtension());
  registry.install(defineExtension({
    name: 'host.tools',
    tools: [
      createGrepTool({ dataRoot: host.dataRoot, toolPaths: execution.toolPaths }),
      createFindTool({ dataRoot: host.dataRoot, toolPaths: execution.toolPaths }),
      createLsTool(),
      createSessionSearchTool({ host, getHarness: () => harness, getWorkContexts: () => workContexts }),
    ],
    sections: [section('host-execution', (input) => {
      // Android 系统 sh 在描述中显式；Windows Git Bash 与 Linux bash 保持不变。
      const shell = process.platform === 'android'
        ? '/system/bin/sh'
        : process.platform === 'win32' ? 'Git Bash' : 'bash';
      const cwd = input.env?.cwd ?? input.agent.cwd;
      return `Tools execute on this host (device ${host.deviceId}) through ${shell}; they are not sandboxed. Default working directory: ${JSON.stringify(cwd ?? null)}.`;
    })],
  }));
  registry.install(defineExtension({
    name: 'host.communication',
    tools: createCommunicationTools({
      host,
      getHarness: () => harness,
      getMessageLog: () => workContexts.getMessageLog(),
      publishWork: decisions.publishWork,
      passWork: decisions.passWork,
      collaboration,
      sessions,
    }),
    sections: [section('host-collaboration', async (input, context) => renderCollaborationPrompt({
      device: await collaboration.getCurrentDevice(),
      botId: (await resolveBotIdentity(host, input.read, input.conversationId, context)).botId,
      cwd: input.env?.cwd ?? input.agent.cwd,
    }))],
  }));
  registry.install(defineExtension({
    name: 'host.schedule',
    tools: createScheduleTools({
      host,
      getHarness: () => harness,
      schedules,
      collaboration,
    }),
  }));
  // 内置 Bot 管理技能目录：只渲染名称/描述索引，
  // 完整 SKILL.md 由模型按目录经文件工具读取，不把整本手册塞进系统提示。
  const botManagementSection = createBotManagementSkillSection();
  registry.install(defineExtension({
    name: 'host.bot-management-skill',
    sections: Array.isArray(botManagementSection) ? botManagementSection : [botManagementSection],
  }));
  // 原生桥接工具仅显式注入时注册：主会话与 work 身份共享同一 registry，二者均可见。
  if (nativeBridge) {
    registry.install(defineExtension({
      name: 'host.android-tools',
      tools: createAndroidTools({ host, getHarness: () => harness, nativeBridge }),
    }));
  }
  // 统一图形环境工具只在确有后端选择的平台注册（Android 原生桥接 / Windows / Linux）：
  // 其他平台保留六个 Runtime 方法（调用显式返回 SHOWER_UNAVAILABLE），不注册不可用工具。
  if (nativeBridge || process.platform === 'win32' || process.platform === 'linux') {
    registry.install(defineExtension({
      name: 'host.shower',
      tools: createShowerTools({ host, getHarness: () => harness, manager: shower }),
    }));
  }
  // 内置 Cua 只在有桌面后端的 Windows/Linux 注册；Android 保留原生路径不注册。
  // 与上游 inventory 一对一，注册先于 coreExtensions 快照与 Harness 打开。
  const hasCuaDesktop = !nativeBridge && (process.platform === 'win32' || process.platform === 'linux');
  let plugins;
  const services = {
    host, models, getHarness: () => harness, context: CTX, getWorkContexts: () => workContexts,
    getWorkActivity: decisions.getWorkActivity,
    resolveConversationBot: async (id) => {
      const identity = await resolveBotIdentity(host, harness, id, CTX);
      const primary = await harness.snapshot(PrimaryIndex, CTX);
      const work = await harness.snapshot(WorkIndex, CTX);
      const owners = host.listBots().filter((bot) => bot.deviceId === host.deviceId && primary?.byPrimary?.[bot.primaryConversationId] === id)
        .map((bot) => ({ botId: bot.botId, scopeId: null }));
      for (const [key, binding] of Object.entries(work?.byKey ?? {})) {
        const pair = parseBindingKey(key);
        if (binding.nativeId === id && pair) owners.push({ botId: pair[0], scopeId: pair[1] });
      }
      if (owners.length !== 1 || owners[0].botId !== identity.botId || owners[0].scopeId !== identity.scopeId) {
        throw errWithCode('conversation has ambiguous ownership', 'BOT_CONTEXT_REQUIRED');
      }
      return identity.botId;
    },
    getSkillReadEnv: async (conversationId, context) => {
      const conversation = await harness.conversation(conversationId, context);
      const agent = await conversation.agent(context);
      return envFor({ conversationId, cwd: agent.cwd });
    },
    reportSkillUse: (botId, input, signal) => {
      const client = centerRuntime.getClient();
      if (!client) throw errWithCode('center is offline', 'CENTER_OFFLINE');
      return client.botSkillUse(host.deviceId, botId, input, signal);
    },
    assertCapabilityAllowed: (botId, id) => plugins.assertCapabilityAllowed(botId, id),
    getExecutionEnv: async (botId) => envFor({ conversationId: 'plugin:' + botId, cwd: host.getBot(botId).cwd }),
    getBotEntryWatermark: (botId) => getBotEntryWatermark(botId),
    documents: { PrimaryIndex, RequestKeys, WorkIndex, WorkContextState, WorkDecisionState, RequestContext, ContextState: RequestContext, GenerationFailureState },
    sdk: {
      ...durable,
      defineDoc: (definition) => durable.defineDoc({ checkpointWhen: () => false, ...definition }),
      defineDocFamily: (definition) => durable.defineDocFamily({ checkpointWhen: () => false, ...definition }),
      chord,
    }, countMessageTokens,
    centerClient: {
      listCapabilityTools: (...args) => {
        const client = centerRuntime.getClient();
        if (!client) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        return client.listCapabilityTools(...args);
      },
      callCapabilityTool: (...args) => {
        const client = centerRuntime.getClient();
        if (!client) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        return client.callCapabilityTool(...args);
      },
    },
  };
  plugins = createPluginManager({ host, registry, installer: centerRuntime.installer, services, isOnline: () => online, vaultFacade: vault.facade });
  registry.install(defineExtension({
    name: 'host.request-context',
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        try {
          if (!online) throw errWithCode('center is offline', 'CENTER_OFFLINE');
          const botId = await services.resolveConversationBot(api.conversationId);
          const modelRef = botModels[botId]?.modelRef;
          if (!modelRef) throw errWithCode('center model is required', 'MODEL_REQUIRED');
          const expected = parseModelRef(modelRef);
          const task = await harness.getTask(api.taskId, context);
          const actual = task?.state?.checkpoint?.model;
          if (!actual || actual.provider !== expected.provider || actual.modelId !== expected.modelId) throw errWithCode('center model changed', 'INVALID_STATE');
          // 统一会话冻结轮最先：sessions 判定/恢复本轮来源与回复目标（prepend-only，
          // 只把可信 Host 路由指引追加到 request 头部）。该指引是本 helper 的明确
          // prepend-only 产物，用长度差切出，不用对象 identity/正文分类。
          const routed = await sessions.beforeRequest(request, api, context);
          const routingMessages = routed.messages.slice(0, routed.messages.length - request.messages.length);
          await decisions.beforeRequest(routed, api, context);
          // prepareContext 收原始 request（不带 Host 注入）：BC 等上下文贡献返回的
          // 完整视图不能覆盖、也不重复计费本轮 Host 控制指引；持久 prepared 预算
          // 仍记真实投影，最终守卫按有序子序列增量把指引只计一次。
          const requestView = await plugins.prepareContext(request, api, context);
          const checkpoint = task.state.checkpoint;
          const model = models.getModel(actual.provider, actual.modelId);
          if (!model || checkpoint.cutoff === undefined) throw errWithCode('request checkpoint is unavailable', 'INVALID_STATE');
          // SDK 同口径预算基线：取 checkpoint.cutoff 的权威上下文视图，
          // 用 estimateContext（最新 assistant usage + 尾部估计）算原始历史，
          // 再按有序子序列 + 增量把 prepareContext（如 BC 投影、路由指引）的实际
          // 有效请求计入 tokenCount；JSON 克隆内容匹配，BC 整体替换只计投影。
          const preparedConversation = await harness.conversation(api.conversationId, context);
          if (!preparedConversation) throw errWithCode('request conversation is missing', 'INVALID_STATE');
          const cutoffView = await preparedConversation.context(context, { at: checkpoint.cutoff });
          if (!cutoffView) throw errWithCode('request context view is unavailable', 'INVALID_STATE');
          const preparedTokens = budgetRequestTokens(cutoffView.messages, estimateContextTokensHost(cutoffView), requestView.messages);
          await harness.commit(async (tx) => {
            const doc = await tx.doc(RequestContext, api.conversationId);
            doc.prepared = {
              taskId: String(api.taskId), cutoff: checkpoint.cutoff,
              contextWindow: model.contextWindow,
              tokenCount: preparedTokens,
              messages: requestView.messages,
            };
          }, context);
          if (!online) throw errWithCode('center is offline', 'CENTER_OFFLINE');
          const finalView = await plugins.beforeRequest(requestView, api, context);
          // 只把 Host 本轮控制指引放到投影/recall 之后追加一次：任何插件
          // （含会整体重建视图的 BC prepare）都不能丢掉冻结轮约束。
          return { ...finalView, messages: [...finalView.messages, ...routingMessages] };
        } catch (err) {
          if (!context.abortSignal?.aborted) {
            // Host 侧准备失败：先把安全诊断写入 GenerationFailureState（契约 A，
            // work 对账/LIVE 可凭 taskId 读到具体失败），再中止当前任务。
            await recordGenerationFailure(api, err, context);
            // SDK 会吞普通 hook 异常；用本次 invocation context 取消当前任务，避免 join 自身。
            try {
              await harness.abortTask(api.taskId, context);
            } catch (abortErr) {
              if (!context.abortSignal?.aborted) throw abortErr;
            }
          }
          throw err;
        }
      },
    })],
  }));
  // Selected after each Bot's plugin hooks, so this check sees their complete request.
  // SDK 已用 estimateContext（权威 usage + 尾部估计）做阈值压缩与溢出重试；这里的
  // 最终守卫只做越限硬止，且用同一口径：prepared.tokenCount 是 prepareContext 后
  // 有效请求的 SDK 估计基线，插件 beforeRequest 之后再用同一有序子序列 + 增量
  // 对齐当前 messages——新增的插件内容计入、被替换的投影只计有效值，
  // 绝不做整包 JSON 估算，也绝不误杀后台压缩期间的正常请求。
  const finalBudgetExtension = defineExtension({ name: 'cap-final-budget', hooks: [hook(GenerationTask, {
    async beforeRequest(request, api, context) {
      try {
        if (!online) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        const prepared = (await harness.snapshot(RequestContext, api.conversationId, context))?.prepared;
        if (!prepared || prepared.taskId !== String(api.taskId)) throw errWithCode('context is not prepared', 'INVALID_STATE');
        const total = budgetRequestTokens(prepared.messages, prepared.tokenCount, request.messages);
        if (total >= prepared.contextWindow) throw errWithCode('context limit reached', 'CONTEXT_LIMIT');
        await decisions.checkBudget(request, api, context);
      } catch (err) {
        if (!context.abortSignal?.aborted) {
          await recordGenerationFailure(api, err, context);
          await harness.abortTask(api.taskId, context);
        }
        throw err;
      }
    },
  })] });
  const codemodeExtension = withCodemodePresentations(createCodemodeExtension({ sandbox: createHostCodemodeSandbox() }));
  registry.install(codemodeExtension);
  registry.install(finalBudgetExtension);
  try {
    releaseOwner = acquireRuntimeOwner(host.dataRoot);
    // Cua inventory：对固定 Driver 二进制跑一次只读 CLI metadata（list-tools +
    // describe），不启动 mcp --direct、不 ensure 虚拟屏、不申请管理员。资源缺失或
    // metadata 不合法在此明确失败，本 catch 负责清理已开的 host/owner。
    if (hasCuaDesktop) {
      registry.install(defineExtension({
        name: 'host.cua',
        tools: await createCuaTools({ host, getHarness: () => harness, manager: shower }),
      }));
    }
    coreExtensions = registry.snapshot().installed().filter((extension) => extension !== finalBudgetExtension && extension !== codemodeExtension);
    const durableDbPath = join(host.dataRoot, 'durable.sqlite');
    storage = await openNodeSqliteStorage(durableDbPath);
    await migrateBotSessionCheckpoints(storage, durableDbPath);
    harness = await Harness.open(storage, {
      models,
      registry,
      // SDK 默认自动压缩：阈值触发（含后台压缩）与一次 provider 溢出压缩重试，
      // 对全部 Bot 生效，包括启用 BC 的 Bot；各模型仍可按 settings.compaction
      // modelOverrides 自行调整。不要恢复 enabled:false，也不要在 generation
      // 内调用 idle-only 的 conversation.compact()。
      settings: { extensions: coreExtensions },
      env: envFor,
    }, CTX);
  } catch (err) {
    if (harness) {
      try { await harness.close(CTX); } catch { /* close 失败不掩盖原错误 */ }
    } else if (storage) {
      try { await storage.close(CTX); } catch { /* close 失败不掩盖原错误 */ }
    }
    try { await plugins.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { await schedules.close(); } catch { /* close 失败不掩盖原错误 */ }
    await vault.close();
    try { await shower.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { await collaboration.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { await cleanupEnvs(); } catch { /* open 失败清理不掩盖原错误 */ }
    try { releaseOwner?.(); } catch { /* release 失败不掩盖原错误 */ }
    host.close();
    throw err;
  }
  const live = createRuntimeLive({
    host,
    getHarness: () => harness,
    // work watch 授权复用共享 MessageLog 的只读 resolveWorkContext（含 former-member 定向历史）。
    resolveWorkContext: (botId, scopeId) => workContexts.resolveWorkContext(botId, scopeId),
  });
  workContexts = createWorkContextRuntime({
    host,
    harness,
    context: CTX,
    sessions,
    getProfile: (botId, workMeta) => botProfile(host, plugins, botModels, coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta),
    // sync 提交成功后附着等待中的 work watch（事务外，观察失败不影响导入）。
    onBound: (botId, scopeId, binding) => live.bindWork(botId, scopeId, binding),
  });
  runtime = createRuntime({
    host,
    harness,
    models,
    defaultModel,
    dataRoot: host.dataRoot,
    releaseOwner,
    cleanupEnvs,
    dropBotEnvs,
    dropEnvFor,
    live,
    workContexts,
    decisions,
    sessions,
    plugins,
    registry,
    coreExtensions,
    codemodeExtension,
    finalBudgetExtension,
    centerRuntime,
    setOnline: (value) => { online = value; },
    isMaintenance: () => maintenance,
    setMaintenance: (value) => { maintenance = value; },
    setBotModels: (value) => { botModels = value; },
    getBotModels: () => botModels,
    setWatermarkReader: (fn) => { getBotEntryWatermark = fn; },
    botAdmissions: bots,
    onBotsChanged: options?.onBotsChanged,
    onBotsSync: options?.onBotsSync,
    learningIdleSettleMs: options?.learningIdleSettleMs,
    collaboration,
    shower,
    vault,
    schedules,
  });
  try {
    if (process.platform === 'win32') await shower.prepare();
    // 启动时初始化已有 Bot 的 SOUL 和会话人格；中心策略稍后应用。
    await runtime.initializeBots();
    schedules.start();
  } catch (err) {
    try { await runtime.close(); } catch { /* close 失败不掩盖启动错误 */ }
    throw err;
  }
  return runtime;
}

/** 构建该 Bot 的 SOUL、中心模型和明确的 core + 插件扩展视图。 */
function botProfile(host, plugins, botModels, coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta) {
  const selection = botModels[botId] ?? {};
  const modelRef = selection.modelRef ?? null;
  let model;
  if (typeof modelRef === 'string' && modelRef.trim() !== '') {
    try { model = parseModelRef(modelRef.trim()); } catch { /* ignore invalid ref during profile snapshot */ }
  }
  const soul = host.getBotSoul(botId).text;
  const instructions = workMeta ? workInstructions(soul, workMeta) : (soul === '' ? null : soul);
  const pluginExtensions = plugins.extensionsFor(botId);
  const codemodeOnly = Boolean(selection.codemodeOnly);
  const codemodeEnabled = Boolean(selection.codemode) || codemodeOnly;
  const selectedExtensions = [
    ...coreExtensions,
    ...(codemodeEnabled && codemodeExtension ? [codemodeExtension] : []),
    ...pluginExtensions,
    finalBudgetExtension,
  ];
  // thinkingLevel 总是给出：(null 表示 SDK 默认) 才能让 reload 后重应用人格时回写变更。
  return {
    // 中心权威 cwd：空闲边界/绑定重入时经 agentProfileChange 写回已映射会话。
    cwd: host.getBot(botId)?.cwd,
    instructions,
    selectedExtensions,
    pluginTools: pluginExtensions.flatMap((extension) => extension.tools ?? []),
    thinkingLevel: selection.thinkingLevel ?? null,
    codemode: codemodeEnabled,
    codemodeOnly,
    ...(model ? { model } : {}),
  };
}

function parseBindingKey(key) {
  try {
    const pair = JSON.parse(key);
    return Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string') ? pair : null;
  } catch {
    return null;
  }
}

function createRuntime({ host, harness, models, defaultModel, dataRoot, releaseOwner, cleanupEnvs, dropBotEnvs, dropEnvFor, live, workContexts, decisions, sessions, plugins, registry, coreExtensions, codemodeExtension, finalBudgetExtension, centerRuntime, setOnline, isMaintenance, setMaintenance, setBotModels, getBotModels, setWatermarkReader, botAdmissions, collaboration, onBotsChanged, onBotsSync, learningIdleSettleMs, shower, vault, schedules }) {
  let closePromise = null;
  let closing = false;
  let centerOnline = false;
  let resumed = false;
  let appliedRevision = null;
  let highestRevision = -1;
  let centerConfigured = false;
  let registryKey = null;
  // 每 Bot 已应用的执行内容摘要与版本：只用于判断“无需重建”，不参与授权。
  const botFingerprints = new Map();
  const botAppliedRevision = new Map();
  let lifecycle = Promise.resolve();
  let epoch = 0;
  const serial = (operation) => {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => {});
    return next;
  };
  // 同一 Bot 的发送/设置/显式同步串行；内侧复用 raw 实现，避免自持同一 lane。
  const admitBot = botAdmissions.admit;
  // Bot 学习驱动：自动完结上报、next→agent.run→respond
  // 驱动与受限 review 工具面；配置/计数/作业持久化全在 Center learning 服务，
  // 本实例不持久化任何学习状态，驱动失败如实回执，绝不伪造完成。
  let learningModelRefs = new Set();
  const learning = createBotLearning({
    host,
    getHarness: () => harness,
    models,
    getBotModels,
    getCenterClient: () => centerRuntime.getClient(),
    plugins,
    schedules,
    getUsableModelRefs: () => learningModelRefs,
    registry,
    context: CTX,
    openPrimaryConversation: (bot) => getPrimaryConversation(harness, bot, {}, CTX),
    dropEnvFor,
    isBotIdle: async (bot) => (await botIsIdle(bot)) && (await turns.queuedCount(bot)) === 0,
    onLearningStateChange: (botId, state) => live.setBotLearning?.(botId, state),
    idleSettleMs: learningIdleSettleMs,
  });
  // 自编辑 SOUL 排队：Bot 在自己的活动轮里调 set_bot_soul（协作/管理工具显式
  // self:true）不能轮中改写人格——先校验输入，再排队到空闲边界；apply 仍走
  // host.setBotSoul 的 CAS，queued 回执只表示已受理排队，绝不伪装已应用。
  // shortcut: 进程内存队列，重启即丢；丢失后下一次 get_bot_soul 读到真实文档，
  // 不会误以为已写入。若要跨重启保留需落盘，属后续增强。
  const selfSoulQueue = new Map();
  const SELF_SOUL_REVISION_RE = /^[0-9a-f]{64}$/;
  function assertQueuedSoulInput(input) {
    if (typeof input?.expectedRevision !== 'string' || !SELF_SOUL_REVISION_RE.test(input.expectedRevision)) {
      throw errWithCode('expectedRevision must be a SHA-256 hex digest', 'INVALID_ARGUMENT');
    }
    if (typeof input.text !== 'string' || !input.text.isWellFormed()) {
      throw errWithCode('text must be a well-formed UTF-16 string', 'INVALID_ARGUMENT');
    }
    if (Buffer.byteLength(input.text, 'utf8') > SOUL_MAX_BYTES) {
      throw errWithCode('text exceeds the 64 KiB SOUL limit', 'INVALID_ARGUMENT');
    }
  }
  // 空闲边界应用排队的自编辑：仍在 admitBot lane 内复查空闲——后到的自编辑覆盖
  // 先排队的（各自 CAS 仍独立校验）；CAS/参数/归属失败立即丢弃，其余错误保留待
  // 下一个空闲边界重试；lane 暂停/关闭时保留排队，恢复后再应用。
  function drainSelfSoul(botId) {
    if (!selfSoulQueue.has(botId) || closing) return;
    void admitBot(botId, async () => {
      const pending = selfSoulQueue.get(botId);
      if (!pending) return;
      const bot = host.getBot(botId);
      if (!bot) {
        selfSoulQueue.delete(botId);
        return;
      }
      if (!(await botIsIdle(bot))) return;
      if (selfSoulQueue.get(botId) !== pending) return;
      try {
        const soul = host.setBotSoul(botId, pending);
        if (selfSoulQueue.get(botId) === pending) selfSoulQueue.delete(botId);
        await refreshBotProfiles(bot);
        return soul;
      } catch (err) {
        if (err?.code === 'REQUEST_CONFLICT' || err?.code === 'INVALID_ARGUMENT' || err?.code === 'BOT_NOT_FOUND') {
          if (selfSoulQueue.get(botId) === pending) selfSoulQueue.delete(botId);
        }
      }
    }).catch(() => { /* lane 关闭/暂停：保留排队 */ });
  }
  // 本运行时已初始化过人格/工具的 Bot；新 Bot 经 initializeBot 增量加入。
  const initializedBots = new Set();

  // >= 1000ms 尾沿节流（trailing throttle）同步 Bot 元数据。
  const syncBotsCallback = onBotsSync ?? onBotsChanged ?? null;
  let botsSyncTimer = null;
  let botsSyncPending = false;
  let botsSyncRunning = false;
  let lastBotsSyncAt = 0;

  function runBotsSync() {
    if (closing || !syncBotsCallback) return;
    if (botsSyncRunning) {
      botsSyncPending = true;
      return;
    }
    botsSyncRunning = true;
    lastBotsSyncAt = Date.now();
    Promise.resolve()
      .then(() => syncBotsCallback())
      .catch(() => {})
      .finally(() => {
        botsSyncRunning = false;
        if (botsSyncPending && !closing) {
          botsSyncPending = false;
          scheduleBotsSync();
        }
      });
  }

  function scheduleBotsSync() {
    if (closing || !syncBotsCallback) return;
    if (botsSyncTimer !== null) return;
    const elapsed = Date.now() - lastBotsSyncAt;
    const delay = Math.max(BOTS_SYNC_THROTTLE_MS, BOTS_SYNC_THROTTLE_MS - elapsed);
    botsSyncTimer = setTimeout(() => {
      botsSyncTimer = null;
      runBotsSync();
    }, delay);
    botsSyncTimer.unref?.();
  }

  // 跟踪在飞的主会话提交：完成时记录 lastActivityAt 与 lastPreview。
  const trackedSubmissions = new Map(); // submissionId -> { botId, nativeId }
  const stopInFlight = new Map();     // botId -> 在飞「停止此 Bot」Promise：重复 abort 共用同一协调，绝不并发争用。
  const completedSubmissions = new Set(); // submissionId
  let submissionCheckPromise = null;
  let checkSubmissionsAgain = false;

  function recordCompletedSubmission(botId, formatted) {
    if (!formatted || formatted.status !== 'done') return;
    const submissionId = formatted.submissionId;
    if (submissionId !== undefined && submissionId !== null) {
      trackedSubmissions.delete(submissionId);
      if (completedSubmissions.has(submissionId)) return;
      completedSubmissions.add(submissionId);
    }
    try {
      host.recordBotActivity(botId, {
        lastActivityAt: new Date().toISOString(),
        lastPreview: formatted.answerText || '',
      });
      scheduleBotsSync();
    } catch {
      /* ignore activity update error if bot was deleted or store closed */
    }
    // Bot 完结是安全空闲边界：先结算排队的自编辑 SOUL，再上报学习增量——
    // 两者都是 fire-and-forget，绝不阻塞前台回复或占用 Bot 准入。
    drainSelfSoul(botId);
    learning.noteCompletedSubmission(botId, formatted);
  }

  function checkTrackedSubmissions() {
    if (closing || trackedSubmissions.size === 0) return;
    if (submissionCheckPromise) {
      checkSubmissionsAgain = true;
      return;
    }
    submissionCheckPromise = (async () => {
      try {
        do {
          checkSubmissionsAgain = false;
          if (closing || trackedSubmissions.size === 0) break;
          for (const [submissionId, info] of [...trackedSubmissions.entries()]) {
            if (closing) break;
            try {
              const sub = await harness.submission(submissionId, CTX);
              if (!sub) {
                trackedSubmissions.delete(submissionId);
                continue;
              }
              const statusRecord = await sub.status(CTX);
              if (statusRecord.status === 'done') {
                const bot = host.getBot(info.botId);
                if (bot) {
                  const formatted = await formatPrimarySubmission(harness, bot, statusRecord, CTX);
                  recordCompletedSubmission(info.botId, formatted);
                  // 原生工作完结是安全切换边界：泵下一条 Host 排队输入。
                  turns.pump(info.botId);
                } else {
                  trackedSubmissions.delete(submissionId);
                }
              } else if (statusRecord.status === 'unanswered') {
                trackedSubmissions.delete(submissionId);
                drainSelfSoul(info.botId);
                turns.pump(info.botId);
                learning.scheduleIdleCheck(info.botId);
              }
            } catch {
              /* ignore transient/closing errors */
            }
          }
        } while (checkSubmissionsAgain && !closing);
      } finally {
        submissionCheckPromise = null;
      }
    })();
  }

  // SDK main：observeCommits({advance,end}) 取代旧 subscribeCommits(fn)。
  // advance 必须同步快速返回、不得调用 Session：只记录需要检查，实际检查由 microtask 做。
  const commitObservation = harness.observeCommits({
    advance(publication) {
      if (closing || trackedSubmissions.size === 0) return;
      if (publication && Array.isArray(publication.changes) && publication.changes.some((c) => c?.type === 'submission')) {
        queueMicrotask(() => checkTrackedSubmissions());
      }
    },
    end() { /* Session 关闭时观察自然结束；无需动作 */ },
  });
  // 14 天归档自动删除定时器（每 6 小时检查一次）。
  let archivePurgeTimer = setInterval(() => {
    void purgeExpiredArchivedBots();
  }, ARCHIVE_PURGE_INTERVAL_MS);
  archivePurgeTimer.unref?.();

  const close = () => {
    closing = true;
    webhooks.pause();
    ++epoch;
    centerOnline = false;
    setOnline(false);
    if (botsSyncTimer !== null) {
      clearTimeout(botsSyncTimer);
      botsSyncTimer = null;
    }
    if (archivePurgeTimer !== null) {
      clearInterval(archivePurgeTimer);
      archivePurgeTimer = null;
    }
    try { commitObservation?.detach(); } catch { /* ignore */ }
    botAdmissions.suspend();
    plugins.suspend();
    plugins.abortActions();
    closePromise ??= (async () => {
      // Seal secret access before waiting for any runtime work to drain.
      const vaultClose = vault.close();
      await lifecycle;
      // 同步封闭 Bot 新准入并开始排空：必须在本次 async 体的首个 await 之前调用，
      // 否则等待 decisions.close() 期间新设置/发送操作仍能入队。
      const botClose = botAdmissions.close();
      // 依次执行并收集每步错误：任何一步失败仍继续清理，最后显式抛出。
      const errors = [];
      try { await webhooks.close(); } catch (err) { errors.push(err); }
      try { turns.close(); } catch (err) { errors.push(err); }
      try { await decisions.close(); } catch (err) { errors.push(err); }
      // 学习驱动在 harness/store 释放前停止：取消在驱动作业与受限会话执行。
      try { await learning.close(); } catch (err) { errors.push(err); }
      // 已接纳 Bot 操作在 harness/store 释放前排空。
      try { await botClose; } catch (err) { errors.push(err); }
      if (submissionCheckPromise) {
        try { await submissionCheckPromise; } catch { /* ignore */ }
      }
      // 再关闭定时任务与 Shower：丢弃排队操作并释放本 Host 拥有的资源，不把在飞结果留到关库之后。
      try { await schedules.close(); } catch (err) { errors.push(err); }
      try { await vaultClose; } catch (err) { errors.push(err); }
      try { await shower.close(); } catch (err) { errors.push(err); }
      // 排空已接纳导入，但共享消息账本须保留到原生工具退出。
      try { await workContexts.quiesce(); } catch (err) { errors.push(err); }
      try { await live.close(); } catch (err) { errors.push(err); }
      try { await collaboration.close(); } catch (err) { errors.push(err); }
      // Seal Durable before stopping plugin resources.
      const nativeClose = harness.close(CTX);
      const pluginQuiesce = plugins.quiesce();
      for (const result of await Promise.allSettled([nativeClose, pluginQuiesce])) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
      try { await plugins.close(); } catch (err) { errors.push(err); }
      try { await workContexts.close(); } catch (err) { errors.push(err); }
      try { await cleanupEnvs(); } catch (err) { errors.push(err); }
      try { host.close(); } catch (err) { errors.push(err); }
      try { releaseOwner(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'runtime close failed');
    })();
    return closePromise;
  };

  // 账本元数据/读取与用户发布仅经共享 MessageLog，不触碰模型、原生任务或 harness。
  const runMessageOperation = (operation) => {
    if (closing) return Promise.reject(new Error('work context runtime is closed'));
    return workContexts.runMessageOperation(operation);
  };

  const profileFor = (botId, workMeta) => botProfile(host, plugins, getBotModels(), coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta);

  // 图片附件落盘：dataRoot/attachments/<botId>/<sha256>，随 Bot 删除清理（deleteBot/purge）。
  // 附件在 Bot lane 外也可上传（本地已鉴权动作），但归属校验先于任何写盘。
  const attachmentStore = {
    path: (botId, id) => attachmentPath(dataRoot, botId, id),
    upload: (botId, input) => uploadAttachment(dataRoot, botId, input),
    load: (botId, attachmentId) => loadAttachment(dataRoot, botId, attachmentId),
    removeBot: (botId) => removeBotAttachments(dataRoot, botId),
  };

  // 每轮准入：持久队列先于原生提交；泵在 Bot 准入 lane 内做
  // prepare→原子切换→confirm→pin→submit(whenBusy:'reject')。
  const turns = createTurnAdmission({
    host,
    getHarness: () => harness,
    context: CTX,
    sessions,
    centerRuntime,
    plugins,
    models,
    getBotModels,
    setBotModels,
    profileFor,
    botExecutionFingerprint,
    applyBotCwd,
    setBotAppliedRevision: (botId, revision) => botAppliedRevision.set(botId, revision),
    setBotFingerprint: (botId, fingerprint) => botFingerprints.set(botId, fingerprint),
    live,
    admitBot,
    getEpoch: () => epoch,
    canAdmit: () => !isMaintenance(),
    trackSubmission: (submissionId, info) => {
      trackedSubmissions.set(submissionId, info);
      checkTrackedSubmissions();
    },
    recordCompletedSubmission,
    initializeBot,
    attachments: attachmentStore,
    // 用户轮 head 实际准入前抢占同 Bot 非用户来源 work（群/DM/迟到续轮）以及后台自动学习；
    // 不动主聊天用户轮、不清 Host 用户队列。work lane 未实现时静默跳过。
    preemptWork: async (botId) => {
      learning.preemptForForeground(botId);
      return decisions.interruptBotWork?.(botId, { reason: 'preempted' });
    },
  });
  const webhooks = createWebhookConsumer({
    deviceId: host.deviceId,
    getClient: () => centerRuntime.getClient(),
    getRuntime: () => runtime,
    isReady: () => resumed && centerOnline && !closing && !isMaintenance() && !turns.isRecoveryPending(),
    getStopStates: turns.getStopStates,
    acknowledgeStop: turns.acknowledgeStop,
    submitWebhook: async (botId, input, capturedStopEpoch) => {
      if (!resumed || !centerOnline || closing || isMaintenance() || turns.isRecoveryPending() ||
          turns.stopped(botId) || turns.webhookStopPending(botId)) return null;
      return submitPrimary(botId, {
        ...input,
        origin: {
          sender: { kind: 'host', name: input?.origin?.sender?.name, sourceType: 'webhook' },
          replyTo: null,
        },
      }, capturedStopEpoch);
    },
  });
  decisions.setTurnGate(turns.admitWorkDecision, turns.pump, turns.canRunWork);
  // 队列生命周期通知：pending 创建/结束/暂停/取消的纯元数据快照驱动统一 live 活动投影。
  decisions.setActivityListener?.((botId, summary) => live.setWorkActivity?.(botId, summary));
  decisions.setLearningHooks?.({
    onWorkStart: (botId) => learning.preemptForForeground(botId),
    onWorkCompleted: (info) => learning.noteCompletedWorkTurn(info.botId, info),
  });

  /**
   * 「停止此 Bot」统一协调：
   * 1) turns.beginStop 立停止 gate（同步推进进程代次并 arm；持久审计代次与
   *    stopPending 崩溃恢复标记随后落盘，取消确认前无新执行）；
   * 2) cancelQueued 仅作废 ≤ 停止代次的已受理未提交条目（cancelled 终态保留回执，
   *    同 requestId 绝不复活；停止开始后受理的新代次输入保留等结算后泵）；
   * 3) decisions.interruptBotWork(user_stop) 覆盖该 Bot 各 scope 积压与 pending（捕获停止水位）；
   * 4) 主会话取消 + 离线退化 abortSubmission/abortTask 标记；
   * 成功置 live stopped，失败保留可见 stopping 并抛错（绝不伪装成功）；gate 内另一轮不争用资源。
   */
  async function stopBotWork(bot, botId) {
    learning.preemptForForeground(botId);
    try { live.setBotControl?.(botId, 'stopping'); } catch { /* live lane 尚未实现时静默跳过 */ }
    try {
      // 先立停止 gate：beginStop 在首个 await 前同步推进进程代次并 arm gate，
      // 持久审计代次与 stopPending 崩溃恢复标记随后落盘；取消确认前无新执行。
      // beginStop 返回推进前代次（取消边界）：≤ 该值的受理属于停止前已受理的
      // 输入与工作积压；本地计数经 initializeBots 预载已对齐持久值，旧进程遗留
      // 队列条目（其持久 stopEpoch ≤ 预载基线）同样落在边界内，绝不漏取消。
      const epoch = await turns.beginStop(bot);
      // 再撤掉 Host 队列中已受理的未原生提交条目：仅作废旧代次受理（停止前的输入
      // 与工作积压）；停止开始后受理的新代次输入保留，等停止结算后由泵处理。
      // 即使后续 HTTP/确认在飞，泵在提交前的存活核对会发现条目已取消，
      // 绝不把已取消的轮送进模型。
      const { withdrawn: queueWithdrawn } = await turns.cancelQueued(bot, epoch);
      // 工作 lane 取消：user_stop 覆盖各 scope 待处理积压与已有 pending；
      // 离线/恢复未完成时 quiesce=false（不调用会隐式 resume 的 abort/wait 路径）。
      if (decisions.interruptBotWork) {
        await decisions.interruptBotWork(botId, {
          reason: 'user_stop',
          quiesce: centerOnline && !turns.isRecoveryPending(),
        });
      }
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      const inboxWithdrawn = conversation ? await turns.withdrawInboxUserItems(bot) : [];
      if (conversation) {
        // 离线或恢复未完成时不能用 Conversation.abort/Submission.wait：
        // 二者会隐式 resume 调度器、唤醒未知旧任务。退化为非调度入口——
        // inspect/abortSubmission/abortTask 只提交取消标记，调度恢复后才执行 abort invocation。
        if (!centerOnline || turns.isRecoveryPending()) {
          const inspection = await harness.inspect(CTX);
          for (const submission of inspection.submissions) {
            if (submission.conversationId === conversation.id) {
              await harness.abortSubmission(submission.id, CTX, conversation.id).catch(() => {});
            }
          }
          for (const task of inspection.tasks) {
            if (task.record.conversationId === conversation.id) {
              await harness.abortTask(task.record.id, CTX).catch(() => {});
            }
          }
        } else {
          await conversation.abort(CTX);
        }
      }
      // 取消确认成功才解除 gate 并置 stopped：失败保留 gate 与 stopping 可见状态，
      // 绝不伪装成功/偷偷放行旧工作（stopPending 留作崩溃恢复边界）。
      await turns.settleStop(botId);
      learning.scheduleIdleCheck(botId);
      webhooks.wake();
      drainSelfSoul(botId);
      const withdrawn = [];
      const seen = new Set();
      for (const item of [...inboxWithdrawn, ...queueWithdrawn]) {
        if (seen.has(item.requestId)) continue;
        seen.add(item.requestId);
        withdrawn.push(item);
      }
      return { botId, withdrawn };
    } catch (err) {
      throw err;
    }
  }

  // stopEpoch 由可信调用者在排队前捕获；内部 Webhook 保留 poll 前代次，绝不重捕获。
  function submitPrimary(botId, input, stopEpoch) {
    const kind = input?.origin?.sender?.kind === 'host' ? 'host' : 'user';
    const trustedInput = {
      ...input,
      stopEpoch,
      origin: {
        sender: {
          kind,
          name: typeof input?.origin?.sender?.name === 'string' ? input.origin.sender.name : null,
          ...(kind === 'host' && input?.origin?.sender?.sourceType === 'webhook' ? { sourceType: 'webhook' } : {}),
        },
        replyTo: typeof input?.origin?.replyTo === 'string' ? input.origin.replyTo : null,
      },
    };
    // 新前台输入到达立即抢占后台静默自学习，让位给主会话响应。
    learning.preemptForForeground(botId);
    // 离线只持久化，不通过会隐式 resume 的路径；本地停止不等待中心确认。
    if (!centerOnline || turns.isRecoveryPending()) return turns.enqueue(botId, trustedInput);
    return admitBot(botId, () => turns.enqueue(botId, trustedInput));
  }

  // 统一图形环境的 Runtime 门面：Actor 只来自可信主会话或工作绑定，绝不采信调用方会话。
  const showerRuntime = createRuntimeShower({
    host,
    getHarness: () => harness,
    resolveWorkContext: (botId, scopeId) => workContexts.resolveWorkContext(botId, scopeId),
    takeoverWork: decisions.takeoverShower,
    manager: shower,
    context: CTX,
  });

  /** Bot 已映射的原生会话（primary + work）：只读快照，不创建会话。 */
  async function botConversations(bot) {
    const nativeIds = [];
    const primaryIndex = await harness.snapshot(PrimaryIndex, CTX);
    const primary = primaryIndex?.byPrimary?.[bot.primaryConversationId];
    if (primary !== undefined) nativeIds.push(primary);
    const workIndex = await harness.snapshot(WorkIndex, CTX);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      const pair = parseBindingKey(key);
      if (pair !== null && pair[0] === bot.botId) nativeIds.push(binding.nativeId);
    }
    return nativeIds;
  }

  /**
   * 中心权威 cwd 切换（已确认空闲/准入边界内调用）：
   * 持久化新目录、写回主会话与全部 work 会话的 AgentDoc cwd、丢弃该 Bot 的
   * 缓存执行环境；不移动文件、不触碰其他 Bot。返回最新 BotRecord。
   */
  async function applyBotCwd(bot, cwd) {
    const nativeIds = await botConversations(bot);
    const updated = host.setBotCwd(bot.botId, { cwd });
    await refreshBotProfiles(updated);
    await dropBotEnvs(nativeIds, bot.botId);
    return updated;
  }

  /** 按已绑定会话重新应用人格/工具；无变化不提交。 */
  async function refreshBotProfiles(bot) {
    const primary = await getPrimaryConversation(harness, bot, {}, CTX);
    if (primary) await applyAgentProfile(harness, primary.id, profileFor(bot.botId, null), CTX);
    const workIndex = await harness.snapshot(WorkIndex, CTX);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      const pair = parseBindingKey(key);
      if (pair === null || pair[0] !== bot.botId) continue;
      const meta = await harness.snapshot(WorkContextState, binding.nativeId, CTX);
      if (!meta?.scopeId || !meta.kind) continue;
      const profile = profileFor(bot.botId, { botId: bot.botId, scopeId: meta.scopeId, kind: meta.kind });
      await applyAgentProfile(harness, binding.nativeId, profile, CTX);
    }
  }

  /** 幂等初始化：SOUL 一次 + 刷新已存在会话人格/工具。中心配置未应用前只用
   * ensureBotSoul，不用空模型/插件 profile 重写已持久化 AgentDoc（防恢复任务丢工具）。 */
  async function initializeBot(botId) {
    assertNonBlank(botId, 'botId');
    if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
    host.ensureBotSoul(botId);
    if (!initializedBots.has(botId)) {
      initializedBots.add(botId);
      if (centerConfigured) await refreshBotProfiles(bot);
    }
  }

  async function createRuntimeBot(input) {
    if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
    if (input?.modelRef != null) throw errWithCode('bot models are managed by the center', 'INVALID_ARGUMENT');
    const bot = host.createBot(input);
    await initializeBot(bot.botId);
    if (onBotsChanged) await onBotsChanged();
    else if (onBotsSync) await onBotsSync();
    else scheduleBotsSync();
    return bot;
  }

  /** 编辑准入：Bot 的任一已映射会话有 queued/placed 提交、活动任务（含手动压缩）或挂起工作决策则忙。 */
  async function assertBotIdle(bot) {
    const nativeIds = await botConversations(bot);
    if (nativeIds.length === 0) return;
    const inspection = await harness.inspect(CTX);
    const known = new Set(nativeIds);
    if (inspection.submissions.some((submission) => known.has(submission.conversationId)) ||
        inspection.tasks.some((task) => known.has(task.record.conversationId))) {
      throw errWithCode('bot has active or queued work', 'RUNTIME_BUSY');
    }
    for (const nativeId of nativeIds) {
      const state = await harness.snapshot(WorkDecisionState, nativeId, CTX);
      if (state?.pending) throw errWithCode('bot has an active work decision', 'RUNTIME_BUSY');
    }
  }

  /** 主会话的编辑前置：无会话返回 null；有活动任务/排队提交则忙（含手动压缩任务）。 */
  async function idlePrimaryConversation(bot) {
    const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
    if (!conversation) return null;
    const inspection = await harness.inspect(CTX);
    if (inspection.submissions.some((submission) => submission.conversationId === conversation.id) ||
        inspection.tasks.some((task) => task.record.conversationId === conversation.id)) {
      throw errWithCode('bot has active or queued work', 'RUNTIME_BUSY');
    }
    return conversation;
  }

  /**
   * 配置应用前的安全边界：该 Bot 不受其他 Bot 影响。
   * 任何未结束任务（含 blocked，不把未知状态当空闲）、排队提交、挂起决策、能力执行都算忙；
   * 检查失败也按忙处理，交给后续刷新重试。失效任务的显式清理在 reapStaleTasks。
   */
  async function botIsIdle(bot) {
    try {
      if (plugins.hasActiveExecutions(bot.botId)) return false;
      const nativeIds = await botConversations(bot);
      if (nativeIds.length === 0) return true;
      const known = new Set(nativeIds);
      const inspection = await harness.inspect(CTX);
      if (inspection.tasks.some((task) => known.has(task.record.conversationId))) return false;
      if (inspection.submissions.some((submission) => known.has(submission.conversationId))) return false;
      for (const nativeId of nativeIds) {
        const state = await harness.snapshot(WorkDecisionState, nativeId, CTX);
        if (state?.pending) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 只结束本 Bot 会话内明确属于本次被撤销能力的任务（按 durable 任务类型匹配）。
   * 不认识的 blocked 任务一律不动：保持忙、由状态对外可见，绝不静默清理别人的遗留任务。
   */
  async function reapStaleTasks(bot, staleKinds) {
    if (!staleKinds || staleKinds.size === 0) return;
    const nativeIds = await botConversations(bot);
    if (nativeIds.length === 0) return;
    const known = new Set(nativeIds);
    const inspection = await harness.inspect(CTX);
    const stale = inspection.tasks.filter((task) => known.has(task.record.conversationId) &&
      staleKinds.has(task.record.kind));
    for (const task of stale) {
      try { await harness.abortTask(task.record.id, CTX); }
      catch { /* 已被其他路径结束 */ }
    }
  }

  /** Bot 执行内容摘要：模型选择 + 启用的能力（含配置与凭证值），不含展示名称与 revision。 */
  function botExecutionFingerprint(selection, capabilities, credentials, cwd) {
    const entries = (capabilities ?? []).filter((capability) => capability.enabled).map((capability) => [
      capability.installationId, capability.kind, capability.target, capability.targetVersion,
      capability.effectiveConfig ?? null,
      (capability.target === 'host' ? capability.credentialRefs ?? [] : []).map((ref) => [ref, credentials?.[ref] ?? null]),
    ]);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return createHash('sha256').update(JSON.stringify([selection ?? null, cwd ?? null, entries])).digest('hex');
  }

  /**
   * 模型注册表指纹：只含影响注册/执行的字段（启用、api、baseUrl、引用的凭证值、模型参数）。
   * revision 与展示名称变化不重建 provider，所以单纯改名不会动运行中的模型对象。
   */
  function centerRegistryKey(snapshot) {
    const providers = (snapshot.providers ?? []).map((provider) => ({
      id: provider.id, enabled: provider.enabled, api: provider.api, baseUrl: provider.baseUrl,
      native: provider.native, authMode: provider.authMode, headers: provider.headers,
      credential: provider.credentialRef == null ? null
        : [provider.credentialRef, snapshot.credentials?.[provider.credentialRef] ?? null],
      models: (snapshot.models?.[provider.id] ?? []).filter((model) => model.enabled).map((model) => ({
        id: model.id, api: model.api, baseUrl: model.baseUrl, headers: model.headers,
        promptCache: model.promptCache, samplingParams: model.samplingParams,
        samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.input,
        reasoning: model.reasoning, cost: model.cost, compat: model.compat ?? null,
        thinkingLevelMap: model.thinkingLevelMap ?? null, inputLimits: model.inputLimits ?? null,
      })),
    }));
    providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return createHash('sha256').update(JSON.stringify(providers)).digest('hex');
  }

  async function purgeOneExpiredBot(botId) {
    const bot = host.getBot(botId);
    if (!bot || bot.isPrimary || !bot.archivedAt) return false;
    await assertBotIdle(bot);
    await learning.cancelBot(botId);
    selfSoulQueue.delete(botId);
    await schedules.deleteBot(bot);
    host.deleteBot({ botId });
    await attachmentStore.removeBot(botId);
    initializedBots.delete(botId);
    return true;
  }

  async function purgeExpiredArchivedBots() {
    if (closing) return;
    const cutoffIso = new Date(Date.now() - ARCHIVE_RETENTION_MS).toISOString();
    const expired = host.listExpiredArchivedBots(cutoffIso);
    if (expired.length === 0) return;
    let deletedAny = false;
    for (const bot of expired) {
      if (closing) break;
      try {
        const runPurge = () => purgeOneExpiredBot(bot.botId);
        const didDelete = centerOnline ? await admitBot(bot.botId, runPurge) : await runPurge();
        if (didDelete) deletedAny = true;
      } catch {
        /* 忙或出错忽略 */
      }
    }
    if (deletedAny) {
      if (onBotsSync) {
        try { await onBotsSync(); } catch { /* ignore */ }
      } else {
        scheduleBotsSync();
      }
    }
  }

  /** Bot 全部上下文当前最大 native entry id（无会话为 0）。 */
  async function botMaxEntryId(bot) {
    let max = 0;
    for (const nativeId of await botConversations(bot)) {
      const conversation = await harness.conversation(nativeId, CTX);
      if (!conversation) continue;
      const page = await conversation.entries({ order: 'descending' }, 1, undefined, CTX);
      const id = page?.items?.[0]?.id;
      if (Number.isSafeInteger(id) && id > max) max = id;
    }
    return max;
  }

  async function requireBot(botId) {
    assertNonBlank(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
    return bot;
  }

  setWatermarkReader(async (botId) => botMaxEntryId(await requireBot(botId)));

  async function abortConversations() {
    if ((await harness.inspect(CTX)).scheduling === 'paused') return;
    const ids = new Set();
    for (const bot of host.listBots()) for (const id of await botConversations(bot)) ids.add(id);
    for (const id of ids) {
      const conversation = await harness.conversation(id, CTX);
      if (conversation) await conversation.abort(CTX, { background: true });
    }
  }

  function setCenterOnline(value) {
    if (!value) {
      webhooks.pause();
      // 仅真实断线走这里：关闭准入、中止执行、卸载能力。
      ++epoch;
      centerOnline = false;
      appliedRevision = null;
      botFingerprints.clear();
      botAppliedRevision.clear();
      setOnline(false);
      botAdmissions.suspend();
      plugins.suspend();
      plugins.abortActions();
      learning.notifyOffline();
      return serial(async () => { await abortConversations(); await botAdmissions.drain(); await plugins.quiesce(); });
    }
    const generation = epoch;
    return serial(async () => {
      if (isMaintenance()) return { capabilityErrors: [] };
      if (closing || !centerConfigured || !centerRuntime.getClient() || generation !== epoch) throw errWithCode('center is offline', 'CENTER_OFFLINE');
      setOnline(true);
      try {
        // 单个能力激活失败只撤销该能力，其他 Bot 与基础聊天保持在线。
        const activation = await plugins.activate();
        // 激活失败的能力已被 manager 释放：同步清掉这些 Bot 的已应用指纹，
        // 否则下一轮核对会因指纹相等而跳过重试并伪报 applied。
        for (const item of activation?.capabilityErrors ?? []) {
          botFingerprints.delete(item.botId);
          botAppliedRevision.delete(item.botId);
        }
        if (generation !== epoch || !centerRuntime.getClient()) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        plugins.resumeAdmissions();
        centerOnline = true;
        botAdmissions.resume();
        learning.resume();
        schedules.notifyOnline();
        webhooks.wake();
        await turns.nudgeAll();
        return activation;
      } catch (err) {
        centerOnline = false;
        setOnline(false);
        botAdmissions.suspend();
        plugins.suspend();
        plugins.abortActions();
        await plugins.quiesce().catch(() => {});
        throw err;
      }
    });
  }

  /**
   * 新快照校验后的即时撤销入口（内部，只由 HostService 生命周期调用，不对外暴露）：
   * 先**同步**删授权（先于任何 await / 部署 / 忙闲检查），再在生命周期队列里按 Bot 安全顺序
   * 通知 onPolicyChanged 并只结束属于被撤销能力的任务。应用阶段再次撤销幂等。
   */
  function revokeCenterCapabilities(snapshot) {
    const pending = [];
    if (!closing) {
      try {
        const valid = snapshot?.protocol === 1 && snapshot.deviceId === host.deviceId &&
          Number.isSafeInteger(snapshot.revision) && snapshot.revision >= highestRevision;
        if (valid) {
          const credentials = snapshot.credentials ?? {};
          const desired = new Map((snapshot.bots ?? []).map((bot) => [bot.botId, bot]));
          for (const record of host.listBots()) {
            const capabilities = desired.get(record.botId)?.capabilities ?? [];
            const stale = plugins.staleGrants(record.botId, capabilities, credentials);
            if (!stale.length) continue;
            // 先把任务类型名取下来，再做删除；之后的实例释放不会让这里丢信息。
            const kinds = plugins.capabilityTaskNames(stale);
            const dropped = plugins.dropGrants(record.botId, stale);
            if (!dropped.length) continue;
            pending.push({ botId: record.botId, ids: dropped, capabilities, kinds });
          }
        }
      } catch { /* 关闭中读不到 Bot 列表时，应用阶段仍会重做撤销 */ }
    }
    return serial(async () => {
      for (const item of pending) {
        try {
          await plugins.notifyGrants(item.botId, item.ids, item.capabilities);
          const record = host.getBot(item.botId);
          if (record) await reapStaleTasks(record, item.kinds);
        } catch { /* 撤销已完成；后续通知/清理失败不阻止其他 Bot */ }
      }
    });
  }

  /**
   * 单个 Bot 的配置应用（已在它的 admission lane 内，与 send/设置严格串行）：
   * 先收紧发生变化能力的授权（幂等），再只结束该能力的失效任务，最后在空闲边界切换模型/能力/profile。
   */
  async function applyBotConfiguration(record, selection, capabilities, deployment, credentials, desiredCwd) {
    const botId = record.botId;
    try {
      // 1. 授权先收紧（幂等；新快照到达时 HostService 已先做过一次）。
      const stale = plugins.staleGrants(botId, capabilities, credentials);
      if (stale.length) await plugins.revoke(botId, stale, capabilities);
      // 2. 只结束受影响会话内明确属于被撤销能力的任务；其他未结束任务一律不碰。
      await reapStaleTasks(record, plugins.capabilityTaskNames(stale));
    } catch (err) {
      return { status: 'failed', error: toRuntimeError(err), capabilityErrors: [] };
    }
    // 3. 仍有未结束任务/提交/挂起决策 => 在当前版本继续服务，本次报 waiting-idle。
    // 例外：调度仍 paused（resume 前的冷恢复窗口）没有在飞执行，磁盘遗留 pending
    // 只是崩溃残留；此刻先恢复已授权模型/插件/profile，resume 后任务才有工具。
    // 但被钉住的轮（pin/排队准入）不能用最新快照覆盖其绑定：保持 waiting-idle，
    // 由准入泵/恢复流程负责该 Bot 的 set（撤权仍在上一步即时生效）。
    const cwdChange = desiredCwd !== undefined && desiredCwd !== record.cwd;
    // 目标目录合法性在任何模型/插件状态变化之前校验，非法即本次应用失败。
    if (cwdChange) {
      try {
        host.assertBotCwd({ cwd: desiredCwd });
      } catch (err) {
        return { status: 'failed', error: toRuntimeError(err), capabilityErrors: [] };
      }
    }
    try {
      const scheduling = (await harness.inspect(CTX)).scheduling;
      const idle = await botIsIdle(record);
      // 调度暂停的冷恢复窗口只允许沿用既有 cwd：目录切换必须等真实空闲，
      // 绝不在未完成轮上换目录。
      if ((scheduling !== 'paused' || cwdChange) && !idle) {
        return { status: 'waiting-idle', error: null, capabilityErrors: [] };
      }
      if (await turns.hasActivePin(botId)) {
        return { status: 'waiting-idle', error: null, capabilityErrors: [] };
      }
    } catch {
      return { status: 'waiting-idle', error: null, capabilityErrors: [] };
    }
    try {
      if (selection?.modelRef != null) {
        const ref = parseModelRef(selection.modelRef);
        if (!models.getModel(ref.provider, ref.modelId)) throw errWithCode('center selected model is unavailable', 'MODEL_NOT_FOUND');
      }
      normalizeThinkingLevel(selection?.thinkingLevel);
      normalizeCodemodeFlag(selection?.codemode, 'codemode');
      normalizeCodemodeFlag(selection?.codemodeOnly, 'codemodeOnly');
      const nextModels = { ...getBotModels() };
      if (selection && (selection.modelRef != null || selection.thinkingLevel != null || selection.codemode != null || selection.codemodeOnly != null)) nextModels[botId] = selection;
      else delete nextModels[botId];
      setBotModels(nextModels);
      let current = record;
      if (cwdChange) current = await applyBotCwd(record, desiredCwd);
      const applied = await plugins.applyBot(current, capabilities, { deviceId: host.deviceId, credentials });
      await refreshBotProfiles(current);
      if (applied.capabilityErrors.length === 0) return { status: 'applied', error: null, capabilityErrors: [] };
      // 只有“目标版本未装且部署仍在进行中”才算等待；无计划或部署已失败一律报 failed，不得永久 waiting-idle。
      const pendingDeployment = applied.capabilityErrors.every((item) => item.error.code === 'CAPABILITY_NOT_INSTALLED' &&
        deployment.planned.has(item.installationId) && !deployment.failed.has(item.installationId));
      if (pendingDeployment) return { status: 'waiting-idle', error: null, capabilityErrors: applied.capabilityErrors };
      const deploymentFailed = applied.capabilityErrors.some((item) => deployment.failed.has(item.installationId));
      return {
        status: 'failed',
        error: deploymentFailed
          ? { code: 'DEPLOYMENT_FAILED', message: 'capability deployment failed' }
          : { code: 'CAPABILITY_APPLY_FAILED', message: 'one or more capabilities could not be applied' },
        capabilityErrors: applied.capabilityErrors,
      };
    } catch (err) {
      return { status: 'failed', error: toRuntimeError(err), capabilityErrors: [] };
    }
  }

  /**
   * 应用中心快照：不再全局断线。执行内容未变的 Bot 只确认版本；变化的 Bot
   * 在各自 admission lane 的空闲边界应用（模型/思考档位按请求边界、能力按 Bot），
   * 失败隔离到 Bot/能力并回报；failed 优先于 waiting-idle，两者同时存在时每 Bot 状态准确。
   */
  function applyCenterSnapshot(snapshot, options = {}) {
    const deployment = {
      planned: new Set(options?.deployment?.planned ?? []),
      failed: new Set(options?.deployment?.failed ?? []),
    };
    return serial(async () => {
      if (isMaintenance()) return {
        deviceId: host.deviceId, revision: snapshot.revision, appliedRevision,
        status: 'waiting-idle', error: null, capabilityErrors: [],
        bots: host.listBots().map(bot => ({ botId: bot.botId, status: 'waiting-idle', appliedRevision: null, error: null })),
      };
      if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
      if (snapshot?.protocol !== 1 || snapshot.deviceId !== host.deviceId ||
          !Number.isSafeInteger(snapshot.revision) || snapshot.revision < highestRevision) {
        throw errWithCode('invalid or stale center snapshot', 'INVALID_ARGUMENT');
      }
      highestRevision = snapshot.revision;
      // 模型注册表只在执行字段变化时重建；Bot 选择不在此处发布。
      const nextRegistryKey = centerRegistryKey(snapshot);
      if (nextRegistryKey !== registryKey) {
        applyCenterModels(snapshot, models, (providerId, signal) => {
          const active = centerRuntime.getClient();
          if (!active) throw errWithCode('center is offline', 'CENTER_OFFLINE');
          return active.providerAuth(providerId, signal);
        });
        learningModelRefs = new Set(snapshot.providers
          .filter((provider) => provider.enabled && (provider.credentialRef == null || snapshot.credentials?.[provider.credentialRef]))
          .flatMap((provider) => (snapshot.models[provider.id] ?? []).filter((model) => model.enabled).map((model) => provider.id + '/' + model.id)));
        registryKey = nextRegistryKey;
      }
      centerConfigured = true;
      const credentials = snapshot.credentials ?? {};
      const desired = new Map((snapshot.bots ?? []).map((bot) => [bot.botId, bot]));
      const bots = [];
      const capabilityErrors = [];
      let waiting = false;
      for (const record of host.listBots()) {
        const botId = record.botId;
        const target = desired.get(botId) ?? null;
        const selection = target?.model ?? null;
        const capabilities = target?.capabilities ?? [];
        const desiredCwd = target?.cwd ?? undefined;
        const receipt = { botId, desiredRevision: snapshot.revision,
          appliedRevision: botAppliedRevision.get(botId) ?? null, status: 'pending', error: null };
        const fingerprint = botExecutionFingerprint(selection, capabilities, credentials, desiredCwd ?? record.cwd);
        if (plugins.isActive() && botFingerprints.get(botId) === fingerprint) {
          botAppliedRevision.set(botId, snapshot.revision);
          bots.push({ ...receipt, appliedRevision: snapshot.revision, status: 'applied' });
          continue;
        }
        let outcome = null;
        let ran = false;
        try {
          ran = await botAdmissions.tryExclusive(botId, async () => {
            outcome = await applyBotConfiguration(record, selection, capabilities, deployment, credentials, desiredCwd);
          });
        } catch (err) {
          if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
          outcome = { status: 'waiting-idle', error: null, capabilityErrors: [], cause: err };
          ran = true;
        }
        if (!ran) {
          waiting = true;
          bots.push({ ...receipt, status: 'waiting-idle' });
          continue;
        }
        capabilityErrors.push(...outcome.capabilityErrors);
        if (outcome.status === 'applied') {
          botFingerprints.set(botId, fingerprint);
          botAppliedRevision.set(botId, snapshot.revision);
          bots.push({ ...receipt, appliedRevision: snapshot.revision, status: 'applied' });
        } else if (outcome.status === 'waiting-idle') {
          waiting = true;
          bots.push({ ...receipt, status: 'waiting-idle' });
        } else {
          botAppliedRevision.delete(botId);
          bots.push({ ...receipt, appliedRevision: null, status: 'failed', error: outcome.error });
        }
      }
      // 本机已删除的 Bot：主循环不覆盖，这里只清记录并释放其能力绑定。
      for (const botId of [...botFingerprints.keys()]) {
        if (desired.has(botId) || host.getBot(botId)) continue;
        botFingerprints.delete(botId);
        botAppliedRevision.delete(botId);
        try {
          await plugins.revoke(botId, plugins.staleGrants(botId, [], credentials), []);
          await plugins.applyBot({ botId }, [], { deviceId: host.deviceId, credentials: {} });
        } catch { /* 已无能力可撤销时忽略 */ }
      }
      const failed = bots.some((bot) => bot.status === 'failed');
      const status = failed ? 'failed' : waiting ? 'waiting-idle' : 'applied';
      appliedRevision = status === 'applied' ? snapshot.revision : null;
      return {
        deviceId: host.deviceId, revision: snapshot.revision, appliedRevision, status,
        error: failed ? { code: 'RUNTIME_APPLY_FAILED', message: 'runtime configuration was only partially applied' } : null,
        bots, capabilityErrors,
      };
    });
  }

  function withCapabilityActivation(installationId, publish) {
    return serial(async () => {
      const generation = epoch;
      if (isMaintenance() || !centerRuntime.getClient()) return false;
      const initial = await harness.inspect(CTX);
      if (generation !== epoch || !centerRuntime.getClient() || initial.tasks.length || initial.submissions.length || plugins.hasActiveExecutions()) return false;
      const wasOnline = centerOnline;
      centerOnline = false;
      botAdmissions.suspend();
      plugins.suspend();
      await botAdmissions.drain();
      const inspection = await harness.inspect(CTX);
      if (generation !== epoch || !centerRuntime.getClient() || inspection.tasks.length || inspection.submissions.length || plugins.hasActiveExecutions()) {
        if (wasOnline && generation === epoch && centerRuntime.getClient()) { plugins.resumeAdmissions(); centerOnline = true; botAdmissions.resume(); }
        return false;
      }
      setOnline(false);
      await plugins.quiesce();
      appliedRevision = null;
      botFingerprints.clear();
      botAppliedRevision.clear();
      await publish();
      return true;
    });
  }

  const runtime = {
    async prepareUpdate({ stopActive = false } = {}) {
      setMaintenance(true);
      webhooks.pause();
      learning.suspend();
      botAdmissions.suspend();
      await botAdmissions.drain();
      await learning.drainAdmissions();
      if (stopActive) {
        for (const bot of host.listBots()) {
          await stopBotWork(bot, bot.botId);
          await learning.cancelBot(bot.botId);
        }
        plugins.abortActions();
        await plugins.quiesce();
        await learning.waitForJobs();
      }
      let activeCount = 0;
      for (const bot of host.listBots()) if (learning.isActive(bot.botId) || !(await botIsIdle(bot))) activeCount++;
      return { ready: activeCount === 0, activeCount, maintenance: true };
    },
    async cancelUpdate() {
      setMaintenance(false);
      if (centerOnline && !closing) {
        botAdmissions.resume();
        plugins.resumeAdmissions();
        learning.resume();
        schedules.notifyOnline();
        webhooks.wake();
        await turns.nudgeAll();
      }
      return { maintenance: false };
    },
    getUpdateState: () => ({ maintenance: isMaintenance() }),
    applyCenterSnapshot, setCenterOnline, withCapabilityActivation, revokeCenterCapabilities,
    callCapabilityAction: (id, action, request) => plugins.action(id, action, request),
    getCurrentDevice: collaboration.getCurrentDevice,
    createBot: createRuntimeBot,
    getBot: (botId) => requireBot(botId),
    updateBotProfile: (input) => admitBot(input?.botId, async () => {
      const updated = host.updateBotProfile(input);
      if (onBotsSync) await onBotsSync();
      else if (onBotsChanged) await onBotsChanged();
      else scheduleBotsSync();
      return updated;
    }),
    initializeBot,

    async initializeBots() {
      await purgeExpiredArchivedBots();
      // 控制入口开放前（包括离线启动）预载停止代次、恢复 gate 与中心待同步提示。
      await turns.pendingStops();
      for (const bot of host.listBots()) await initializeBot(bot.botId);
    },

    setPrimaryBot: (botId) => admitBot(botId, async () => {
      const updated = host.setPrimaryBot({ botId });
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return updated;
    }),

    archiveBot: (botId) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.isPrimary) throw errWithCode('primary bot cannot be archived', 'PRIMARY_BOT_PROTECTED');
      await assertBotIdle(bot);
      await learning.cancelBot(botId);
      await schedules.pauseBot(bot);
      const updated = host.archiveBot({ botId });
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return updated;
    }),

    unarchiveBot: (botId) => admitBot(botId, async () => {
      await requireBot(botId);
      const updated = host.unarchiveBot({ botId });
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return updated;
    }),

    deleteBot: (botId) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.isPrimary) throw errWithCode('primary bot cannot be deleted', 'PRIMARY_BOT_PROTECTED');
      await assertBotIdle(bot);
      await learning.cancelBot(botId);
      selfSoulQueue.delete(botId);
      await schedules.deleteBot(bot);
      const res = host.deleteBot({ botId });
      await attachmentStore.removeBot(botId);
      initializedBots.delete(botId);
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return res;
    }),

    async scheduleTask(botId, input) {
      const bot = await requireBot(botId);
      if (
        bot.archivedAt !== null &&
        bot.archivedAt !== undefined &&
        (input?.action === 'create' ||
          input?.action === 'update' ||
          (input?.action === 'setEnabled' && input?.enabled === true))
      ) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      return schedules.execute(bot, input, { taskId: 1 });
    },

    async getBotSoul(botId) {
      await requireBot(botId);
      return host.getBotSoul(botId);
    },

    setBotSoul: (botId, input) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      try {
        await assertBotIdle(bot);
      } catch (err) {
        // 自编辑（协作/管理工具显式 input.self=true）：Bot 自身忙时排队到空闲
        // 边界；用户写入保持原有 RUNTIME_BUSY 语义，绝不轮中改写人格。
        if (err?.code === 'RUNTIME_BUSY' && input?.self === true) {
          assertQueuedSoulInput(input);
          selfSoulQueue.set(botId, { expectedRevision: input.expectedRevision, text: input.text });
          return { ...host.getBotSoul(botId), status: 'queued' };
        }
        throw err;
      }
      // 非自编辑的直达写覆盖任何排队中的自编辑（用户写优先于排队项）。
      if (input?.self !== true) selfSoulQueue.delete(botId);
      const soul = host.setBotSoul(botId, input);
      await refreshBotProfiles(bot);
      return { ...soul, status: 'applied' };
    }),

    // 附件：先落盘再引用。上传幂等（内容定址），getAttachment 只回该 Bot 归属的图。
    // 与 deleteBot 同 lane：上传在校验期间 Bot 不会被删，绝不留下孤立附件目录。
    uploadAttachment: (botId, input) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      return attachmentStore.upload(botId, input);
    }),

    putBotFileChunk: (botId, input) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.archivedAt != null) throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      return putBotFileChunk(dataRoot, botId, normalizeBotFileChunk({ ...input, botId }));
    }),

    async getAttachment(botId, attachmentId) {
      await requireBot(botId);
      return attachmentStore.load(botId, attachmentId);
    },

    // 每轮准入：先把用户输入持久化进 Host 队列并立即返回 queued 回执；
    // 实际 prepare→原子切换→confirm→pin→原生提交由准入泵异步完成。
    // 同 requestId 重复调用返回同一条受理（绝不产生第二条消息），不同正文冲突。
    // 附件仅传 id 数组；图片-only 消息允许空文本。
    // 本机可信输入边界统一记 sender.kind=user（已鉴权 HTTP/control submit 是唯一的
    // 人类入口）；计划任务等内部调用显式传 origin.sender.kind=host 覆盖。
    // wire 上调用方自带的任意 origin/author 字段绝不采信，由本边界重写。
    submit: async (botId, input) => {
      assertNonBlank(botId, 'botId');
      // 停止代次必须在任何 await/排队前捕获：受理晚于停止的在飞 submit 以旧代次
      // 持久化并在同事务内作废为 cancelled 回执；停止后受理的新代次输入允许新运行。
      return submitPrimary(botId, input, turns.stopEpoch(botId));
    },

    async wait(botId, requestId) {
      assertNonBlank(botId, 'botId');
      assertNonBlank(requestId, 'requestId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      // 共享读取先对账残留队列的原生 done；否则返回 Host 受理/取消回执，不隐式恢复。
      const queued = await turns.queuedReceipt(bot, requestId);
      if (queued) return queued;
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), CTX);
      if (!record) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      // 已完结回执直接返回，不调用 Submission.wait（其上开头无条件 resume，会意外调度其他待处理任务）。
      if (record.status === 'done' || record.status === 'unanswered') {
        const formatted = await formatPrimarySubmission(harness, bot, record, CTX);
        if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
        return formatted;
      }
      // 离线或恢复未完成：Submission.wait 会隐式 resume 调度器、唤醒未知旧任务——
      // 只回被动状态（queued/placed 回执本身已是合法应答），不进入等待。
      if (!centerOnline || turns.isRecoveryPending()) {
        return formatPrimarySubmission(harness, bot, record, CTX);
      }
      const submission = await harness.submission(record.id, CTX);
      if (!submission) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      trackedSubmissions.set(record.id, { botId, nativeId: conversation.id });
      const finalRecord = await submission.wait(CTX);
      const formatted = await formatPrimarySubmission(harness, bot, finalRecord, CTX);
      if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
      return formatted;
    },

    async getSubmission(botId, requestId) {
      assertNonBlank(botId, 'botId');
      assertNonBlank(requestId, 'requestId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      // 共享读取先对账残留队列的原生 done；无队列条目时再查其他原生状态。
      const queued = await turns.queuedReceipt(bot, requestId);
      if (queued) return queued;
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) return null;
      const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), CTX);
      if (!record) return null;
      const formatted = await formatPrimarySubmission(harness, bot, record, CTX);
      if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
      return formatted;
    },

    async history(botId, options = {}) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const historyOptions = normalizeHistoryOptions(options);
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        return { botId, conversationId: bot.primaryConversationId, items: [], nextCursor: null };
      }
      // 传 harness 让 helper 读取 BotSessionState 并给原始 entry 补 data.attribution；
      // 不传会让 raw 历史覆盖 live 归属时丢来源。helper 第4参为 {afterReset,sessionState?,harness?}。
      const page = await readPrimaryHistory(conversation, historyOptions, CTX, { afterReset: true, harness });
      return { botId, conversationId: bot.primaryConversationId, ...page };
    },

    // /clear：SDK 用 pi.reset 开新上下文（不换 conversationId、保留原始回执条目以维持 requestId 幂等），
    // 返回 reset 条目 id 作为所有客户端的可见历史起点。
    clearHistory: (botId) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      const conversation = await idlePrimaryConversation(bot);
      const conversationId = bot.primaryConversationId;
      if (!conversation) return { botId, conversationId, clearedThroughEntryId: 0 };
      // reset 前先把未导入的账本消息推进水位：lastImportedLocalId 是 reset 保留的
      // 唯一导入边界，不先捕获会让旧账本条在 reset 后当作「新消息」重现。
      // 此处 Bot lane 已持、会话空闲，是安全边界；新追加的条目随即被 pi.reset 翻篇，
      // 只起水位捕获作用。
      await sessions.sync(botId);
      await conversation.reset(undefined, CTX);
      await harness.commit((tx) => clearBotBoardResult(tx, conversation.id), CTX);
      // 统一会话状态随 pi.reset 一起翻篇：保留账本导入水位与未决请求来源（迟到回复
      // 仍可续接、旧账本绝不重导入），只清理已过期的活动轮状态。reset 失败则状态原样保留。
      await sessions.reset(botId);
      // 空闲且无并发主会话操作时，reset 就是新的 head 标记；不猜其他条目 id。
      const head = (await conversation.context(CTX)).head;
      if (head?.kind !== durable.ResetEntry.kind) {
        throw errWithCode('reset entry is not the active context head', 'INVALID_STATE');
      }
      return { botId, conversationId, clearedThroughEntryId: head.id };
    }),

    // /compact：准入内只创建手动压缩任务（再来 clear/compact 会被活动任务检查拒绝），
    // 等待任务终态与摘要落地在准入外，不长期占用该 Bot 的 FIFO。
    async compact(botId) {
      assertNonBlank(botId, 'botId');
      const started = await admitBot(botId, async () => {
        const bot = await requireBot(botId);
        if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
          throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
        }
        const conversation = await idlePrimaryConversation(bot);
        const conversationId = bot.primaryConversationId;
        if (!conversation) return { conversationId, taskId: null };
        return { conversationId, taskId: await conversation.compact(BOT_SESSION_COMPACT_INSTRUCTIONS, CTX) };
      });
      if (started.taskId === null) return { botId, conversationId: started.conversationId, compacted: false };
      const settled = await harness.waitForTask(started.taskId, CTX);
      const outcome = settled.state.outcome;
      if (outcome.status !== 'completed') {
        const reason = outcome.status === 'failed' || outcome.status === 'faulted'
          ? outcome.error.message
          : outcome.reason ?? outcome.status;
        throw errWithCode(`compaction ${outcome.status}: ${reason}`, 'COMPACTION_FAILED');
      }
      if (outcome.result?.entryId !== undefined) {
        return { botId, conversationId: started.conversationId, compacted: true };
      }
      const submissionId = outcome.result?.submissionId;
      if (submissionId === undefined) return { botId, conversationId: started.conversationId, compacted: false };
      // 会话空闲时 SDK 在任务的同一个 terminal commit 内已把摘要 write 置为 done；未落地就不算成功。
      const submission = await harness.submission(submissionId, CTX);
      if (!submission) throw errWithCode('compaction summary submission is missing', 'COMPACTION_FAILED');
      let record = await submission.status(CTX);
      if (record.status === 'queued' || record.status === 'placed') record = await submission.wait(CTX);
      if (record.status !== 'done') {
        throw errWithCode(`compaction summary is ${record.status}${record.status === 'unanswered' ? `: ${record.reason}` : ''} rather than placed`, 'COMPACTION_FAILED');
      }
      return { botId, conversationId: started.conversationId, compacted: true };
    },

    async withdrawQueued(botId, input = {}) {
      assertNonBlank(botId, 'botId');
      if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
        throw errWithCode('withdrawQueued input must be an object', 'INVALID_ARGUMENT');
      }
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      return turns.withdrawQueued(bot, input?.requestId ?? null);
    },

    async steerQueued(botId, input) {
      assertNonBlank(botId, 'botId');
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw errWithCode('steerQueued input must be an object', 'INVALID_ARGUMENT');
      }
      assertNonBlank(input.requestId, 'requestId');
      const bot = await requireBot(botId);
      if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      return turns.steerQueued(bot, input.requestId);
    },

    async editMessage(botId, input) {
      assertNonBlank(botId, 'botId');
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw errWithCode('editMessage input must be an object', 'INVALID_ARGUMENT');
      }
      const { entryId, requestId, text } = input;
      if (!Number.isSafeInteger(entryId) || entryId < 1) {
        throw errWithCode('entryId must be a positive safe integer', 'INVALID_ARGUMENT');
      }
      assertNonBlank(requestId, 'requestId');
      const attachmentIds = normalizeAttachmentIds(input.attachments);
      if (typeof text !== 'string' || (text.trim() === '' && attachmentIds.length === 0)) {
        throw errWithCode('text must be a non-empty string', 'INVALID_ARGUMENT');
      }
      const capturedStopEpoch = turns.stopEpoch(botId);
      return admitBot(botId, async () => {
        const bot = await requireBot(botId);
        if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
          throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
        }
        // 前台历史编辑先抢占并等待后台静默自动反思退出，手动学习作业则保持忙碌门禁拒绝。
        await learning.preemptAndWaitForForeground(botId);
        try {
          // 严格忙碌门禁：任何活动轮、排队轮、停止协调、插件执行或手动学习作业期间均禁止编辑历史消息。
          if (
            turns.stopped(botId) ||
            (await turns.queuedCount(bot)) > 0 ||
            plugins.hasActiveExecutions(botId) ||
            learning.isActive(botId)
          ) {
            throw errWithCode('bot has active or queued work', 'RUNTIME_BUSY');
          }
          await assertBotIdle(bot);
          let attachmentBytes = 0;
          for (const id of attachmentIds) {
            const meta = await attachmentStore.load(botId, id);
            attachmentBytes += meta.size;
          }
          if (attachmentBytes > 64 * 1024 * 1024) {
            throw errWithCode('attachments exceed the 64 MiB per-message total image byte limit', 'INVALID_ARGUMENT');
          }
          const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
          if (!conversation) {
            throw errWithCode(`entry not found: ${entryId}`, 'INVALID_ARGUMENT');
          }
          const resetId = await latestResetEntryId(conversation, CTX);
          if (entryId <= resetId) {
            throw errWithCode(`entry ${entryId} is before the active conversation reset`, 'INVALID_ARGUMENT');
          }
          const [agentSnapshot, sessionSnapshot, requestKeysSnapshot] = await Promise.all([
            harness.snapshot(durable.AgentDoc, conversation.id, CTX),
            harness.snapshot(BotSessionState, conversation.id, CTX),
            harness.snapshot(RequestKeys, conversation.id, CTX),
          ]);
          const newNativeId = await harness.commit(async (tx) => {
            const scan = await tx.scanEntries(
              { conversationId: conversation.id, maxEntryId: entryId, order: 'descending' },
              2,
            );
            const targetEntry = scan.items[0];
            if (!targetEntry || targetEntry.id !== entryId) {
              throw errWithCode(`entry not found: ${entryId}`, 'INVALID_ARGUMENT');
            }
            const attribution = deriveEntryAttribution(targetEntry, sessionSnapshot ?? null);
            if (
              targetEntry.kind !== USER_MESSAGE_KIND ||
              attribution?.kind !== 'user' ||
              attribution?.channel !== 'primary'
            ) {
              throw errWithCode('only primary user messages can be edited', 'INVALID_ARGUMENT');
            }
            const beforeEntryId = scan.items[1]?.id ?? null;
            const truncatedRequestIds = new Set();
            const truncatedTaskIds = new Set();
            if (sessionSnapshot && beforeEntryId !== null) {
              let cursor;
              for (;;) {
                const page = await tx.scanEntries(
                  cursor
                    ? { conversationId: conversation.id, minEntryId: entryId }
                    : { conversationId: conversation.id, minEntryId: entryId, order: 'ascending' },
                  200,
                  cursor,
                );
                for (const item of page.items) {
                  if (item.byTaskId !== undefined && item.byTaskId !== null) {
                    truncatedTaskIds.add(String(item.byTaskId));
                  }
                  if (item.kind === USER_MESSAGE_KIND || item.kind === WORK_TRIGGER_KIND) {
                    const data = item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? item.data : null;
                    const turn = data?.turn && typeof data.turn === 'object' && !Array.isArray(data.turn) ? data.turn : null;
                    const reqId = data?.requestId ?? turn?.requestId ?? String(item.id);
                    if (typeof reqId === 'string' && reqId !== '') truncatedRequestIds.add(reqId);
                  } else if (item.kind === 'pi.user') {
                    truncatedRequestIds.add(String(item.id));
                  }
                }
                if (!page.next) break;
                cursor = page.next;
              }
            }
            const rec = beforeEntryId !== null
              ? await tx.forkConversation(conversation.id, beforeEntryId, { ownership: { kind: 'ownerless' } })
              : await tx.createConversation({ ownership: { kind: 'ownerless' } });
            if (agentSnapshot) {
              const agentDraft = await tx.doc(durable.AgentDoc, rec.id);
              const copiedAgent = chord.copyJson(agentSnapshot);
              for (const key of Object.keys(agentDraft)) {
                if (!(key in copiedAgent)) delete agentDraft[key];
              }
              Object.assign(agentDraft, copiedAgent);
            }
            if (sessionSnapshot) {
              const sessionDraft = await tx.doc(BotSessionState, rec.id);
              const copiedSession = chord.copyJson(sessionSnapshot);
              const copiedOutgoing = copiedSession.outgoing ?? {};
              sessionDraft.schema = copiedSession.schema ?? 1;
              sessionDraft.lastImportedLocalId = copiedSession.lastImportedLocalId ?? 0;
              sessionDraft.importedCount = copiedSession.importedCount ?? 0;
              sessionDraft.activeTurn = null;
              sessionDraft.outgoing = copiedOutgoing;
              if (beforeEntryId === null) {
                sessionDraft.turnByTask = {};
                sessionDraft.completedTurns = {};
              } else {
                const nextTurnByTask = {};
                for (const [taskKey, reqId] of Object.entries(copiedSession.turnByTask ?? {})) {
                  if (typeof reqId !== 'string' || truncatedRequestIds.has(reqId) || truncatedTaskIds.has(taskKey)) continue;
                  nextTurnByTask[taskKey] = reqId;
                }
                const keptRequestIds = new Set(Object.values(nextTurnByTask));
                const priorCompleted = copiedSession.completedTurns ?? {};
                for (const [reqId, turnRec] of Object.entries(priorCompleted)) {
                  if (truncatedRequestIds.has(reqId)) continue;
                  if (turnRec?.taskId !== undefined && truncatedTaskIds.has(String(turnRec.taskId))) continue;
                  keptRequestIds.add(reqId);
                }
                for (const recOut of Object.values(copiedOutgoing)) {
                  if (
                    recOut &&
                    recOut.responseMessageId === undefined &&
                    typeof recOut.requestId === 'string' &&
                    !truncatedRequestIds.has(recOut.requestId)
                  ) {
                    keptRequestIds.add(recOut.requestId);
                  }
                }
                const queue = [...keptRequestIds];
                while (queue.length > 0) {
                  const currentId = queue.pop();
                  const originId = priorCompleted[currentId]?.originRequestId;
                  if (
                    typeof originId === 'string' &&
                    originId !== '' &&
                    !keptRequestIds.has(originId) &&
                    !truncatedRequestIds.has(originId)
                  ) {
                    keptRequestIds.add(originId);
                    queue.push(originId);
                  }
                }
                const nextCompletedTurns = {};
                for (const reqId of keptRequestIds) {
                  if (Object.hasOwn(priorCompleted, reqId)) {
                    nextCompletedTurns[reqId] = priorCompleted[reqId];
                  }
                }
                sessionDraft.turnByTask = nextTurnByTask;
                sessionDraft.completedTurns = nextCompletedTurns;
              }
              sessionDraft.updatedAt = new Date().toISOString();
            }
            if (requestKeysSnapshot?.digests) {
              const reqDraft = await tx.doc(RequestKeys, rec.id);
              const copiedDigests = chord.copyJson(requestKeysSnapshot.digests);
              delete copiedDigests['r:' + requestId];
              reqDraft.digests = copiedDigests;
            }
            const primaryIndex = await tx.doc(PrimaryIndex);
            primaryIndex.byPrimary[bot.primaryConversationId] = rec.id;
            return rec.id;
          }, CTX);
          const newConversation = await harness.conversation(newNativeId, CTX);
          await live.rebind(botId, newConversation);
          if (conversation.id !== newNativeId) {
            await dropEnvFor(conversation.id);
          }
          return await turns.enqueue(botId, {
            requestId,
            text,
            ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
            delivery: 'followUp',
            stopEpoch: capturedStopEpoch,
            origin: {
              sender: { kind: 'user', name: null },
              replyTo: null,
            },
          });
        } catch (err) {
          learning.scheduleIdleCheck(botId);
          throw err;
        }
      });
    },

    async abort(botId) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      // 「停止此 Bot」在飞共用同一 Promise：重复 abort 等待同一次协调，绝不并发争用资源。
      const existing = stopInFlight.get(botId);
      if (existing) return existing;
      const task = stopBotWork(bot, botId);
      stopInFlight.set(botId, task);
      const release = () => { if (stopInFlight.get(botId) === task) stopInFlight.delete(botId); };
      task.then(release, release);
      return task;
    },

    reloadModels() { throw errWithCode('models are managed by the center', 'INVALID_STATE'); },

    async discoverProviderModels(input) {
      return discoverProviderModels(input);
    },

    async getModelCatalog() {
      return describeModelCatalog(models, defaultModel);
    },

    async contextStatus(botId) {
      await requireBot(botId);
      return plugins.actionByName(botId, 'contextStatus', {});
    },

    memoryStatus: (botId, input) => plugins.actionByName(botId, 'memoryStatus', input),
    recallMemory: (botId, input) => plugins.actionByName(botId, 'recallMemory', input),
    reflectMemory: (botId, input) => plugins.actionByName(botId, 'reflectMemory', input),
    retainMemory: (botId, input) => plugins.actionByName(botId, 'retainMemory', input),
    getMemory: (botId, input) => plugins.actionByName(botId, 'getMemory', input),
    getMemorySource: (botId, input) => plugins.actionByName(botId, 'getMemorySource', input),
    correctMemory: (botId, input) => plugins.actionByName(botId, 'correctMemory', input),
    retryMemory: (botId, input) => plugins.actionByName(botId, 'retryMemory', input),

    // Bot 学习管理：status/configure/cancel 直转 Center；learn/review/curate
    // start 后挂 next→agent.run→respond 驱动并回诚实作业回执。
    manageBotLearning: (botId, input) => admitBot(botId, () => learning.manageBotLearning(botId, input)),
    async reviewBotSkills(botId, input) {
      await requireBot(botId);
      const client = centerRuntime.getClient();
      if (!client) throw errWithCode('center is offline', 'CENTER_OFFLINE');
      return client.botSkillReview(botId, input);
    },

    getWorkContext: workContexts.getWorkContext,
    // 显式同步与发送/设置同队列：决策内部走 raw workContexts.syncWorkContext（已在 Bot 准入内），不会递归取 lane。
    syncWorkContext: (botId, scopeId, options) => admitBot(botId, () => workContexts.syncWorkContext(botId, scopeId, options)),
    workHistory: workContexts.workHistory,
    async workContextStatus(botId, scopeId) {
      await workContexts.resolveWorkContext(botId, scopeId);
      return plugins.actionByName(botId, 'contextStatus', { scopeId });
    },
    getWorkActivity: decisions.getWorkActivity,
    stopWork: decisions.stopWork,
    resumeWork: decisions.resumeWork,

    createScope: (input) => runMessageOperation((log) => log.createScope(input)),
    updateScope: (scopeId, input) => runMessageOperation((log) => log.updateScope(scopeId, input)),
    // 权威删除：先落墓碑（CAS/幂等，失败即抛不触碰工作），墓碑可见后再停止该
    // scope 下已绑定的工作 pending——只影响本 scope，不 abort 其它 scope/主聊天。
    // 停止失败不翻转为删除失败：墓碑已提交，reconcile 的 member 检查会兜底取消。
    deleteScope: async (scopeId, input) => {
      const info = await runMessageOperation((log) => log.deleteScope(scopeId, input));
      await decisions.stopScopeWork(scopeId).catch(() => {});
      return info;
    },
    getScopeState: (scopeId) => runMessageOperation((log) => log.getScopeState(scopeId)),
    listScopeStates: (options) => runMessageOperation((log) => log.listScopeStates(options)),
    publishUserMessage: (scopeId, input) => runMessageOperation((log) => log.publish(normalizeUserMessage(scopeId, input))),
    listScopeReplicas: (scopeId, options) => runMessageOperation((log) => log.listScopeReplicas(scopeId, options)),
    scopeHistory: (scopeId, options) => runMessageOperation((log) => readScopeHistory(log, scopeId, options)),
    getScopeMessage: (scopeId, messageId) => runMessageOperation((log) => readScopeMessage(log, scopeId, messageId)),
    getScopeMessageDelivery: (scopeId, messageId) => runMessageOperation((log) => readScopeMessageDelivery(log, scopeId, messageId)),

    // 统一图形环境（Android/Windows/Linux 同签名）：status/frame 只读，takeover 复用 conversation.abort。
    vaultControl: vault.control,
    getShowerStatus: showerRuntime.getShowerStatus,
    createShowerSession: showerRuntime.createShowerSession,
    getShowerFrame: showerRuntime.getShowerFrame,
    sendShowerInput: showerRuntime.sendShowerInput,
    takeoverShower: showerRuntime.takeoverShower,
    releaseShowerSession: showerRuntime.releaseShowerSession,

    // 冷启动：service 在全局 resume 前调用一次，恢复被钉住的旧 set。
    // 可恢复的准入无法恢复时保持调度暂停并抛错（绝不缺定义地 resume）。
    restoreTurns: async () => {
      // 崩溃时丢失内存停止 gate：持久 stopPending 标记的 Bot 先补完未完成停止
      // （user_stop 标记 + 主会话取消标记，quiesce=false 不隐式 resume 调度器），
      // 绝不自动恢复漏取消工作。任一 Bot 恢复失败即向外传播
      // TURN_RECOVERY_REQUIRED——gate 与 stopping 保留，绝不伪装成功后继续 resume。
      for (const bot of await turns.pendingStops()) {
        // 恢复期间 gate 已由 pendingStops arm：置 stopping 让该 Bot 可见在停，
        // 恢复失败即向外传播——绝不置 stopped 伪装成功后继续恢复调度。
        try { live.setBotControl?.(bot.botId, 'stopping'); } catch { /* live 缺席 */ }
        try {
          await turns.cancelQueued(bot, turns.stopEpoch(bot.botId) - 1);
          if (decisions.interruptBotWork) {
            // 已有 pending.interruption 的 scope 沿用其已捕获 through 边界（宕机后
            // 新到消息不被这次补停吞掉），由 work lane 的幂等标记保证。
            await decisions.interruptBotWork(bot.botId, { reason: 'user_stop', quiesce: false });
          }
          const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
          if (conversation) {
            const inspection = await harness.inspect(CTX);
            for (const submission of inspection.submissions) {
              if (submission.conversationId === conversation.id) {
                await harness.abortSubmission(submission.id, CTX, conversation.id).catch(() => {});
              }
            }
            for (const task of inspection.tasks) {
              if (task.record.conversationId === conversation.id) {
                await harness.abortTask(task.record.id, CTX).catch(() => {});
              }
            }
          }
          await turns.settleStop(bot.botId);
        } catch (err) {
          // 停止恢复失败必须可见且阻断调度恢复：gate 与 stopping 保留，
          // 错误码沿用恢复类（调用方按 TURN_RECOVERY_REQUIRED 处理恢复前状态）。
          const failure = errWithCode(
            `pending stop recovery failed for bot ${bot.botId}: ${err?.message ?? 'unknown'}`,
            'TURN_RECOVERY_REQUIRED');
          failure.cause = err;
          throw failure;
        }
      }
      return turns.restoreTurns();
    },

    resume() {
      harness.resume();
      decisions.resume();
      resumed = true;
      turns.nudgeAll().catch(() => {});
      webhooks.wake();
    },

    notifyWebhookReady: () => webhooks.wake(),

    getBotBoard(params) {
      return live.getBotBoard(params, async (botId) => {
        await turns.refreshActivity(botId);
        await decisions.refreshActivity(botId);
      });
    },

    watch(botId, options) {
      return live.watch(botId, options);
    },

    watchWork(botId, scopeId, options) {
      return live.watchWork(botId, scopeId, options);
    },

    close,
  };
  const lifecycleMethods = new Set(['initializeBots', 'applyCenterSnapshot', 'setCenterOnline', 'withCapabilityActivation', 'revokeCenterCapabilities', 'restoreTurns', 'prepareUpdate', 'cancelUpdate', 'getUpdateState', 'notifyWebhookReady', 'close']);
  // 离线/恢复暂停只放行本地已鉴权动作：持久 enqueue、被动回执/状态与取消。
  // 这些路径只用 Harness snapshot/commit/abortTask，不隐式 resume 调度器；
  // 模型、工具、问卷等执行路径仍受 Center 门禁（运行时本就对 SDK 抛离线错）。
  // scope 查询是纯本地账本读取（不调度、不触碰模型），离线也放行给被动浏览 UI；
  // createScope/updateScope/publishUserMessage 等写路径仍受 Center 门禁。
  const offlineMethods = new Set(['vaultControl', 'submit', 'getSubmission', 'wait', 'abort', 'withdrawQueued', 'turns', 'inspect', 'history', 'watch', 'getBotBoard',
    'uploadAttachment', 'getAttachment',
    'scopeHistory', 'getScopeMessage', 'getScopeMessageDelivery', 'getScopeState', 'listScopeStates', 'listScopeReplicas']);
  const maintenanceAllowed = new Set([...offlineMethods, 'getCurrentDevice', 'getBot', 'getModelCatalog', 'getBotSoul', 'listScopes']);
  maintenanceAllowed.delete('submit');
  maintenanceAllowed.delete('uploadAttachment');
  return new Proxy(runtime, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function' || lifecycleMethods.has(key)) return value;
      return (...args) => {
        if (isMaintenance() && !maintenanceAllowed.has(key)) {
          throw errWithCode('host is preparing an update', 'RUNTIME_BUSY');
        }
        if (!centerOnline && !offlineMethods.has(key)) {
          throw errWithCode('center is offline', 'CENTER_OFFLINE');
        }
        return value(...args);
      };
    },
  });
}
