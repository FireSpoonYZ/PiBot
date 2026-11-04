// host-core/runtime-shower.js
// 统一 Shower 运行时门面：只用可信主会话或工作绑定解析 Actor，再转发给 Shower 管理器。
// status/frame 不创建会话也不启动模型；takeover 复用工作决策边界和 conversation.abort，
// 不写工作停止标记，因此接管后下一轮不需要 resumeWork，也不重放任何输入。
import { randomUUID } from 'node:crypto';
import { PrimaryIndex } from './runtime-docs.js';
import { WorkIndex } from './work-context-docs.js';
import { messageError } from './message-protocol.js';
import { normalizeShowerSessionId, normalizeShowerTarget } from './shower-protocol.js';

/** 人工操作没有模型调用：taskId 用非空合成值，原生帧不接受调用方或模型提供的身份。 */
function humanOptions() {
  return { taskId: 'human:' + randomUUID(), source: 'human' };
}

export function createRuntimeShower({ host, getHarness, resolveWorkContext, takeoverWork, manager, context }) {
  /** 目标 → 可信 Actor：主会话用 Bot 公开 UUID，工作会话用绑定后的公开 UUID。 */
  async function resolve(target) {
    const { botId, scopeId } = normalizeShowerTarget(target);
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) {
      throw messageError('BOT_NOT_FOUND', 'bot not found on this host: ' + botId);
    }
    if (scopeId === undefined) {
      return {
        bot,
        binding: null,
        actor: {
          deviceId: host.deviceId,
          botId,
          conversationId: bot.primaryConversationId,
          scopeId: null,
          kind: 'primary',
        },
      };
    }
    const { scope, binding } = await resolveWorkContext(botId, scopeId);
    // 无工作会话既没有生成可中止也没有环境可读；不自动 sync（那会建会话并可能跑模型）。
    if (!binding) {
      throw messageError('SHOWER_SESSION_NOT_FOUND', '该工作范围的会话尚未开始，还没有图形环境: ' + scopeId);
    }
    return {
      bot,
      binding,
      actor: {
        deviceId: host.deviceId,
        botId,
        // 对外身份用工作会话公开 UUID；原生 id 只用于中止本地生成。
        conversationId: binding.conversationId,
        scopeId,
        kind: scope.kind,
      },
    };
  }

  /** 同 Bot 的既有主会话和工作会话都能使用共享屏幕；只读索引，不创建会话。 */
  async function botConversations(bot) {
    const harness = getHarness();
    const [primaryIndex, workIndex] = await Promise.all([
      harness.snapshot(PrimaryIndex, context),
      harness.snapshot(WorkIndex, context),
    ]);
    const ids = new Set();
    const primary = primaryIndex?.byPrimary?.[bot.primaryConversationId];
    if (primary !== undefined) ids.add(primary);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      let pair;
      try { pair = JSON.parse(key); } catch { continue; }
      if (Array.isArray(pair) && pair.length === 2 && pair[0] === bot.botId && typeof pair[1] === 'string') {
        ids.add(binding.nativeId);
      }
    }
    return (await Promise.all([...ids].map((id) => harness.conversation(id, context)))).filter(Boolean);
  }

  return {
    async getShowerStatus(target) {
      const { actor } = await resolve(target);
      return manager.status(actor, humanOptions());
    },

    async createShowerSession(target, input = {}) {
      const { actor } = await resolve(target);
      return manager.ensure(actor, input, humanOptions());
    },

    async getShowerFrame(target, sessionId, limits = {}) {
      const { actor } = await resolve(target);
      return manager.frame(actor, sessionId, limits, humanOptions());
    },

    async sendShowerInput(target, sessionId, input) {
      const { actor } = await resolve(target);
      return manager.input(actor, sessionId, input, humanOptions());
    },

    /**
     * 人工接管：先把 sessionId 对到本目标的当前会话（不误停其他生成），
     * 再丢弃共享屏幕排队未发送的工具操作、请求在途停止，并中止同 Bot 的现有生成。
     */
    async takeoverShower(target, sessionId) {
      const resolved = await resolve(target);
      const { actor } = resolved;
      const current = await manager.status(actor, humanOptions());
      if (current.sessionId === null) {
        throw messageError('SHOWER_SESSION_NOT_FOUND', '当前没有可接管的图形环境会话');
      }
      if (current.sessionId !== normalizeShowerSessionId(sessionId)) {
        throw messageError('SHOWER_SESSION_MISMATCH', '预览画面不属于当前会话，请刷新后再接管');
      }
      await takeoverWork(actor.botId,
        // 在 Bot 准入内同步重新校验，避免等待期间旧屏幕被替换后误停。
        () => manager.cancel(actor, sessionId),
        async () => {
          const conversations = await botConversations(resolved.bot);
          await Promise.all(conversations.map((conversation) => conversation.abort(context)));
        });
      // 停止后重新读状态，不把中止前的阶段当成当前结果。
      return manager.status(actor, humanOptions());
    },

    async releaseShowerSession(target, sessionId) {
      const { actor } = await resolve(target);
      return manager.release(actor, sessionId, humanOptions());
    },
  };
}
