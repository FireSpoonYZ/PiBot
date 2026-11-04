const OPAQUE_TEXT = (message) => JSON.stringify(message);

function codecError(text) {
  const err = new Error(text);
  err.code = 'BC_CODEC_UNMAPPABLE';
  return err;
}

/**
 * 是否可折叠纯文本：user 的 string/全 text 数组、assistant 的全 text 数组。
 * system 与实际/合成 toolResult 始终 opaque；混入 thinking/toolCall/图像亦为 opaque。
 */
function isPureText(message) {
  const content = message.content;
  if (message.role === 'user') {
    return typeof content === 'string' || (Array.isArray(content) && content.every((block) => block?.type === 'text'));
  }
  if (message.role === 'assistant') {
    return Array.isArray(content) && content.every((block) => block?.type === 'text');
  }
  return false;
}

/** 纯文本正文：text 块按换行连接，string 原样。 */
function joinText(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** opaque core：text 仅用 JSON.stringify 原对象计量，结构化部分绝不作为可编辑正文。 */
function opaqueCore(message, id) {
  if (message.role === 'toolResult') {
    return {
      id,
      role: 'tool',
      contentType: 'tool-result',
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      text: OPAQUE_TEXT(message),
    };
  }
  if (message.role === 'assistant') {
    const hasToolCall = message.content.some((block) => block?.type === 'toolCall');
    return { id, role: 'assistant', contentType: hasToolCall ? 'tool-call' : 'reasoning', text: OPAQUE_TEXT(message) };
  }
  // system 与含图像的 user：无更贴切的枚举，沿用 text；因在 protectedIds 中不会被折叠。
  return { id, role: message.role, contentType: 'text', text: OPAQUE_TEXT(message) };
}

/**
 * 创建 codec：把 Durable ContextView 投影为 acp-kernel CoreMessage 列表。
 *
 * @param {object} view - Durable ContextView（head/entries/contributions/messages）。
 * @returns {{ messages: object[], protectedIds: Set<string>, restore: (projected: object[]) => object[] }}
 *   messages：每原生消息一个 core，按 view.messages 顺序；
 *   protectedIds：opaque 消息（system、thinking/toolCall/图像、实际或合成 toolResult）的稳定 id；
 *   restore(projected)：按 core.id 找回原消息，补回被投影遗漏的系统/opaque，保证原样与顺序。
 */
export function createContextCodec(view) {
  const idByMessage = new Map();
  const messageById = new Map();
  const opaqueIds = new Set();
  const ordinalById = new Map();

  for (let i = 0; i < view.entries.length; i++) {
    const entry = view.entries[i];
    const contributed = view.contributions[i] ?? [];
    for (let j = 0; j < contributed.length; j++) {
      const message = contributed[j];
      if (!idByMessage.has(message)) idByMessage.set(message, `e${entry.id}:m${j}`);
    }
  }

  const messages = view.messages.map((message, ordinal) => {
    let id = idByMessage.get(message);
    if (id === undefined) {
      if (message?.role !== 'toolResult' || message.details?.reason !== 'missing_result') {
        throw codecError('unmappable Durable message in context view (not a contribution, not a synthesized missing tool result)');
      }
      id = `missing:${message.toolCallId}`;
    }
    if (!messageById.has(id)) messageById.set(id, message);
    if (!ordinalById.has(id)) ordinalById.set(id, ordinal);
    const pure = isPureText(message);
    const core = pure
      ? { id, role: message.role, contentType: 'text', text: joinText(message) }
      : opaqueCore(message, id);
    if (!pure) opaqueIds.add(id);
    return core;
  });

  // 系统与 opaque 消息按原始顺序排列，restore 据此补回投影遗漏项。
  const mandatoryOrder = messages.map((core) => core.id).filter((id) => opaqueIds.has(id));

  function restoreNative(core, native) {
    if (opaqueIds.has(core.id)) return native; // opaque 原样返回，绝不把 core.text 写入任何字段
    const base = joinText(native);
    if (core.text === base) return native; // 文本未变，原样返回
    // 文本改变：保留消息级元数据；string 仍为 string，数组改为新的单 text 块（不沿用已失效 textSignature）。
    const content = typeof native.content === 'string' ? core.text : [{ type: 'text', text: core.text }];
    return { ...native, content };
  }

  /** kernel/宿主合成消息（summary/nudge）统一还原为 user 普通上下文：timestamp=0，不提升为 system，不冒充新输入。 */
  function syntheticUserContext(core) {
    const message = {
      role: 'user',
      content: core.text === undefined ? [] : [{ type: 'text', text: core.text }],
      timestamp: 0,
    };
    const isSummary = core.id?.startsWith('acp_summary_') || core.summaryOfBlockId !== undefined;
    if (isSummary) {
      if (core.summaryOfBlockId !== undefined) message.summaryOfBlockId = core.summaryOfBlockId;
      message.bcSummaryMaterial = true; // 历史摘要标记
    } else {
      message.bcContextMaterial = true; // 上下文管理提示（如 nudge）
    }
    return message;
  }

  /**
   * 还原投影：按 core.id 找回原消息；纯文本未保留则从投影消失（原文不受影响），
   * 系统/opaque 缺失时按原始顺序补回，避免重复并保持工具 pair 顺序。
   * synthetic 消息在其投影位置立即输出，不延迟到下一个 native 之后。
   */
  function restore(projected) {
    const projectedIds = new Set(projected.map((core) => core.id));
    const missingOpaque = mandatoryOrder.filter((id) => !projectedIds.has(id));
    const restored = [];
    const seen = new Set();
    let miss = 0;

    for (const core of projected) {
      if (seen.has(core.id)) continue; // 去重，避免同一身份重复输出
      seen.add(core.id);
      const native = messageById.get(core.id);
      if (native === undefined) {
        restored.push(syntheticUserContext(core));
        continue;
      }
      const ordinal = ordinalById.get(core.id) ?? Number.POSITIVE_INFINITY;
      while (miss < missingOpaque.length && ordinalById.get(missingOpaque[miss]) <= ordinal) {
        restored.push(messageById.get(missingOpaque[miss]));
        miss++;
      }
      restored.push(restoreNative(core, native));
    }
    while (miss < missingOpaque.length) {
      restored.push(messageById.get(missingOpaque[miss]));
      miss++;
    }
    return restored;
  }

  return { messages, protectedIds: opaqueIds, restore };
}
