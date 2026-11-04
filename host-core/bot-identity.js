import { WorkContextState } from './work-context-docs.js';
import { PrimaryIndex } from './runtime-docs.js';
import { messageError } from './message-protocol.js';

function contextRequired() {
  return messageError('BOT_CONTEXT_REQUIRED', 'conversation is not owned by a local bot');
}

/** 只用持久会话归属解析身份；不创建会话，也不采信 cwd、角色或模型参数。 */
export async function resolveBotIdentity(host, harness, nativeId, context) {
  if (!Number.isSafeInteger(nativeId)) throw contextRequired();
  const meta = await harness.snapshot(WorkContextState, nativeId, context);
  // 只有缺失或尚未初始化的工作身份才回退到主会话索引，外机/残缺工作身份不得降级。
  if (meta && (
    meta.botId !== null || meta.deviceId !== null || meta.scopeId !== null ||
    meta.kind !== null || meta.conversationId !== null
  )) {
    if (
      meta.deviceId !== host.deviceId ||
      typeof meta.botId !== 'string' || meta.botId.trim() === '' ||
      typeof meta.scopeId !== 'string' || meta.scopeId.trim() === '' ||
      typeof meta.conversationId !== 'string' || meta.conversationId.trim() === '' ||
      (meta.kind !== 'room' && meta.kind !== 'dm')
    ) {
      throw contextRequired();
    }
    const bot = host.getBot(meta.botId);
    if (!bot || bot.deviceId !== host.deviceId) throw contextRequired();
    return {
      deviceId: host.deviceId,
      botId: bot.botId,
      conversationId: meta.conversationId,
      scopeId: meta.scopeId,
      kind: meta.kind,
    };
  }

  const index = await harness.snapshot(PrimaryIndex, context);
  const bot = index && host.listBots().find((candidate) =>
    candidate.deviceId === host.deviceId &&
    index.byPrimary[candidate.primaryConversationId] === nativeId
  );
  if (!bot) throw contextRequired();
  return {
    deviceId: host.deviceId,
    botId: bot.botId,
    conversationId: bot.primaryConversationId,
    scopeId: null,
    kind: 'primary',
  };
}
