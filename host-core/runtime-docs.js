import { defineDoc, configure, AgentDoc } from '@earendil-works/pi-durable';
import { parseModelRef } from './runtime-models.js';

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Bot.primaryConversationId（公开 UUID）到 Durable 数字会话 ID 的映射。
// 与会话创建在同一 commit 中原子持久化；每 Host（每 durable.sqlite）一份。
export const PrimaryIndex = defineDoc({
  kind: 'host.primary-index',
  version: 1,
  scope: 'session',
  initial: () => ({ byPrimary: {} }),
  checkpointWhen: () => false,
});

// 本模块请求正文去重索引：key 为 'r:'+requestId，保存正文 SHA-256 摘要。
export const RequestKeys = defineDoc({
  kind: 'host.request-keys',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ digests: {} }),
  checkpointWhen: () => false,
});

/**
 * 在调用方事务内创建 ownerless 主会话并写 PrimaryIndex 映射。只适合在 commit 回调内调用；
 * 返回 Durable 数字会话 ID；已映射或并发重入时幂等返回既有 ID。
 * 缺模型显式抛 MODEL_REQUIRED（parseModelRef 对空值抛 INVALID_ARGUMENT），提交回滚，不产生半成品会话。
 */
export async function createPrimaryInTransaction(tx, bot, options = {}) {
  const primaryId = bot.primaryConversationId;
  const draft = await tx.doc(PrimaryIndex);
  const existing = draft.byPrimary[primaryId];
  if (existing !== undefined) return existing;

  const modelRef = bot.modelRef ?? options.defaultModel;
  if (!modelRef) {
    throw errWithCode('model is required', 'MODEL_REQUIRED');
  }
  const model = parseModelRef(modelRef);
  const record = await tx.createConversation({ ownership: { kind: 'ownerless' } });
  await configure(tx, record.id, {
    model,
    // 未配置时显式 null 即 SDK 默认档位，与未写入等价，避免残留上次配置。
    thinkingLevel: options.thinkingLevel ?? null,
    // 主会话人格来自真实 SOUL.md；未提供时保留旧 role 以兼容遗留导入路径。
    instructions: options.instructions === undefined ? bot.role : options.instructions,
    cwd: bot.cwd,
    tools: initialToolsChange(options.removeTools),
    ...(options.codemodeOnly ? { modelTools: [{ name: 'codemode' }] } : {}),
  });
  draft.byPrimary[primaryId] = record.id;
  return record.id;
}

/**
 * 解析 Bot 在本 Host Durable 库中的主私聊会话。
 * - 已映射：返回现有会话句柄。
 * - 未映射且 create=false：返回 null，不创建、不调度。
 * - 未映射且 create=true：在同一 commit 内重新查重、创建 ownerless 会话、
 *   用 parseModelRef 解析模型并配置代理，再把 UUID->数字ID 映射一并提交。
 */
export async function getPrimaryConversation(harness, bot, options, context) {
  const create = options?.create === true;
  const primaryId = bot.primaryConversationId;

  // 先快照查映射：已映射无需任何提交。
  const index = await harness.snapshot(PrimaryIndex, context);
  const mapped = index?.byPrimary[primaryId];
  if (mapped !== undefined) {
    return harness.conversation(mapped, context);
  }
  if (!create) return null;

  // commit 回调里只允许通过 tx 读写；会话句柄在提交完成后解析。
  const conversationId = await harness.commit(async (tx) => createPrimaryInTransaction(tx, bot, options), context);
  return harness.conversation(conversationId, context);
}

/**
 * 首次创建会话时的 tools 过滤器：仅有本模块管理的工具时才写成 {remove}，否则继承全部工具。
 */
export function initialToolsChange(removeTools) {
  return removeTools && removeTools.length > 0 ? { remove: removeTools } : null;
}

/**
 * 由当前 AgentState 计算人格/工具变更（无变化返回 undefined，避免无谓 system 变更）：
 * - instructions：null/空串表示清空人格（空 SOUL 合法且有意为空）。
 * - thinkingLevel：profile 给出期望档位（null 表示 SDK 默认），与持久值不同才写入；
 *   因此 reload/重新应用人格时也能落盘，不只首次创建生效。
 * - tools：保留已有选择并启用当前 Bot 的插件工具；旧名字由已选 extensions 限定实际暴露范围。
 *   managedTools 是本模块完整工具定义（重算时清掉全部旧排除项），removeTools 是本次想要的排除项，
 *   二者分开才能让「关闭→启用」「只读→读写」恢复被移除的工具。
 *   未知名字按原样保留（SDK 的 configure 只读取注册项的 name）。
 */
export function agentProfileChange(state, profile) {
  const change = {};
  // Center-authoritative Bot cwd: rewritten on idle apply/binding re-entry so new
  // work runs in the new directory while history stays on the same conversation.
  const cwd = profile?.cwd;
  if (cwd !== undefined && (state?.cwd ?? null) !== cwd) {
    change.cwd = cwd;
  }
  const model = profile?.model;
  if (model && typeof model.provider === 'string' && typeof model.modelId === 'string') {
    const cur = state?.model;
    if (!cur || cur.provider !== model.provider || cur.modelId !== model.modelId) {
      change.model = { provider: model.provider, modelId: model.modelId };
    }
  }
  const instructions = profile?.instructions;
  if (instructions !== undefined) {
    const next = instructions === null || instructions === '' ? null : instructions;
    const current = state?.instructions;
    if (next === null) {
      if (current !== undefined) change.instructions = null;
    } else if (current !== next) {
      change.instructions = next;
    }
  }

  const thinkingLevel = profile?.thinkingLevel;
  if (thinkingLevel !== undefined && (state?.thinkingLevel ?? null) !== thinkingLevel) {
    change.thinkingLevel = thinkingLevel;
  }

  if (profile?.selectedExtensions) {
    const desired = profile.selectedExtensions;
    const current = state?.extensions;
    if (!Array.isArray(current) || current.length !== desired.length || current.some((name, index) => name !== desired[index].name)) {
      change.extensions = desired;
    }
  }

  if (profile?.codemodeOnly !== undefined) {
    const currentModelTools = state?.modelTools;
    if (profile.codemodeOnly === true) {
      if (!Array.isArray(currentModelTools) || currentModelTools.length !== 1 || currentModelTools[0] !== 'codemode') {
        change.modelTools = [{ name: 'codemode' }];
      }
    } else if (Array.isArray(currentModelTools)) {
      change.modelTools = null;
    }
  }

  const desired = profile?.removeTools ?? [];
  const managed = profile?.managedTools ?? desired;
  const pluginTools = profile?.pluginTools ?? [];
  const pluginNames = new Set(pluginTools.map((tool) => tool.name));
  const current = state?.tools;
  if (Array.isArray(current)) {
    const added = pluginTools.filter((tool) => !current.includes(tool.name));
    if (added.length) change.tools = [...current.map((name) => ({ name })), ...added];
  } else {
    const managedNames = new Set(managed.map((tool) => tool.name));
    const byName = new Map([...managed, ...desired].map((tool) => [tool.name, tool]));
    const previous = current?.remove ?? [];
    const next = [
      ...previous.filter((name) => !managedNames.has(name) && !pluginNames.has(name)),
      ...desired.filter((tool) => !pluginNames.has(tool.name)).map((tool) => tool.name),
    ];
    // 排除项顺序不影响可调用性：同集合不写 configure，避免无谓 system 变更。
    const unchanged = next.length === previous.length && next.every((name) => previous.includes(name));
    if (!unchanged) {
      change.tools = next.length === 0 ? null : { remove: next.map((name) => byName.get(name) ?? { name }) };
    }
  }
  return Object.keys(change).length === 0 ? undefined : change;
}

/** 在调用方事务内比较并应用人格/工具，返回是否写入。 */
export async function applyAgentProfileInTx(tx, conversationId, profile) {
  const state = await tx.doc(AgentDoc, conversationId);
  const change = agentProfileChange(state, profile);
  if (!change) return false;
  await configure(tx, conversationId, change);
  return true;
}

/** 只在实际变化时提交一次 configure，保持 provider prompt cache 稳定。 */
export async function applyAgentProfile(harness, conversationId, profile, context) {
  const state = await harness.snapshot(AgentDoc, conversationId, context);
  if (!state) return false;
  if (!agentProfileChange(state, profile)) return false;
  await harness.commit((tx) => applyAgentProfileInTx(tx, conversationId, profile), context);
  return true;
}
