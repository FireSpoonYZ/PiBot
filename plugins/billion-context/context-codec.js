import { Buffer } from 'node:buffer';

export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50_000;

const OPAQUE_TEXT = (message) => JSON.stringify(message);
const KERNEL_TRUNCATION_MARKER = '[truncated for context space]';
const ALWAYS_PROTECTED_TOOL_NAMES = new Set(['compress', 'acp_rule']);

function codecError(text) {
  const err = new Error(text);
  err.code = 'BC_CODEC_UNMAPPABLE';
  return err;
}

function normalizeToolOutputMaxBytes(raw) {
  if (raw === undefined) return DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new RangeError('toolOutputMaxBytes must be a finite non-negative number');
  }
  return raw === 0 ? 0 : Math.max(1, Math.floor(raw));
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 取不超过 maxBytes UTF-8 字节的最长前缀，绝不拆断代理对或多字节字符。 */
function sliceUtf8Prefix(str, maxBytes) {
  if (maxBytes <= 0 || str.length === 0) return '';
  let bytes = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);
    let step = 1;
    let charBytes = 3;
    if (code <= 0x7f) {
      charBytes = 1;
    } else if (code <= 0x7ff) {
      charBytes = 2;
    } else if (isHighSurrogate(code) && i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) {
      step = 2;
      charBytes = 4;
    }
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += step;
  }
  return str.slice(0, i);
}

/** 取不超过 maxBytes UTF-8 字节的最长后缀，绝不拆断代理对或多字节字符。 */
function sliceUtf8Suffix(str, maxBytes) {
  if (maxBytes <= 0 || str.length === 0) return '';
  let bytes = 0;
  let i = str.length;
  while (i > 0) {
    const code = str.charCodeAt(i - 1);
    let step = 1;
    let charBytes = 3;
    if (code <= 0x7f) {
      charBytes = 1;
    } else if (code <= 0x7ff) {
      charBytes = 2;
    } else if (isLowSurrogate(code) && i - 2 >= 0 && isHighSurrogate(str.charCodeAt(i - 2))) {
      step = 2;
      charBytes = 4;
    }
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i -= step;
  }
  return str.slice(i);
}

/** 将可见工具输出正文限制在 maxBytes UTF-8 字节内（0 表示禁用）；保留首尾并附字节说明。 */
function capToolOutputText(text, maxBytes) {
  if (maxBytes <= 0) return text;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return text;

  const notice = `\n\n...[truncated tool output to ${maxBytes} UTF-8 bytes; original ${totalBytes} bytes]...\n\n`;
  const noticeBytes = Buffer.byteLength(notice, 'utf8');
  if (noticeBytes >= maxBytes) {
    const compactNotice = '...[truncated]';
    const compactBytes = Buffer.byteLength(compactNotice, 'utf8');
    if (compactBytes >= maxBytes) {
      return sliceUtf8Prefix(text, maxBytes);
    }
    return sliceUtf8Prefix(text, maxBytes - compactBytes) + compactNotice;
  }

  const bodyBudget = maxBytes - noticeBytes;
  const headBudget = Math.floor(bodyBudget * 0.7);
  const tailBudget = bodyBudget - headBudget;
  const head = sliceUtf8Prefix(text, headBudget);
  const tail = sliceUtf8Suffix(text, tailBudget);
  return `${head}${notice}${tail}`;
}

function isPureTextContent(content) {
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.every((block) => block?.type === 'text');
}

/**
 * 是否可折叠纯文本：user 的 string/全 text 数组、assistant 的全 text 数组。
 * system、toolResult 及混入 thinking/toolCall/图像的消息不是纯文本。
 */
function isPureText(message) {
  const content = message.content;
  if (message.role === 'user') {
    return isPureTextContent(content);
  }
  if (message.role === 'assistant') {
    return Array.isArray(content) && content.every((block) => block?.type === 'text');
  }
  return false;
}

/** 纯文本/工具正文：text 块按换行连接，string 原样，无文本块为空串。 */
function joinText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function isSyntheticMissingResult(message) {
  return message?.role === 'toolResult' && message.details?.reason === 'missing_result';
}

function isAlwaysProtectedToolName(name) {
  return typeof name === 'string' && ALWAYS_PROTECTED_TOOL_NAMES.has(name.toLowerCase());
}

function getAssistantToolCalls(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block?.type === 'toolCall');
}

function isAssistantFoldableContent(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.every(
    (block) => block && (block.type === 'text' || block.type === 'thinking' || block.type === 'toolCall'),
  );
}

/** toolResult core：给内核可编辑的真实文本与稳定身份，原始全量文本保留给 search/decompress/摘要材料。 */
function toolResultCore(message, id) {
  return {
    id,
    role: 'tool',
    contentType: 'tool-result',
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    text: joinText(message),
  };
}

/** opaque core：text 仅用 JSON.stringify 原对象计量，结构化部分绝不作为可编辑正文。 */
function opaqueCore(message, id) {
  if (message.role === 'assistant') {
    const calls = getAssistantToolCalls(message);
    if (calls.length > 0) {
      // acp-kernel@0.0.101 的 CoreMessage 仅支持标量 toolCallId；单工具调用精确透传配对身份，
      // 避免 prune 在存在历史 block 时误把对应 toolResult 当 orphan 裁掉。
      const singleCall = calls.length === 1 ? calls[0] : null;
      const singleCallId = singleCall && typeof singleCall.id === 'string' && singleCall.id.length > 0
        ? singleCall.id
        : undefined;
      const singleToolName = singleCallId && typeof singleCall.name === 'string'
        ? singleCall.name
        : undefined;
      return {
        id,
        role: 'assistant',
        contentType: 'tool-call',
        ...(singleToolName !== undefined ? { toolName: singleToolName } : {}),
        ...(singleCallId !== undefined ? { toolCallId: singleCallId } : {}),
        text: OPAQUE_TEXT(message),
      };
    }
    return { id, role: 'assistant', contentType: 'reasoning', text: OPAQUE_TEXT(message) };
  }
  // system 与含图像的 user：无更贴切的枚举，沿用 text；因在 protectedIds 中不会被折叠。
  return { id, role: message.role, contentType: 'text', text: OPAQUE_TEXT(message) };
}

/**
 * 创建 codec：把 Durable ContextView 投影为 acp-kernel CoreMessage 列表。
 *
 * @param {object} view - Durable ContextView（head/entries/contributions/messages）。
 * @param {{ toolOutputMaxBytes?: number, foldClosedTools?: boolean }} [options]
 *   toolOutputMaxBytes：恢复对模型可见视图时单个 toolResult 正文的 UTF-8 字节上限（默认 50000，0 禁用）；
 *   不影响 codec.messages 中的原始 archive 文本，绝不修改 Durable 原对象；
 *   foldClosedTools：opt-in，仅允许完整历史单调用 toolCall/result 组整组折叠，部分被裁剪时还原双方防 orphan。
 * @returns {{
 *   messages: object[],
 *   protectedIds: Set<string>,
 *   restore: (projected: object[]) => object[],
 *   restoreWithProvenance: (projected: object[]) => {
 *     messages: object[],
 *     inputIndex: number | null,
 *     lostInput: boolean,
 *     auxiliaryIndices: number[],
 *   },
 * }}
 */
export function createContextCodec(view, options = {}) {
  const toolOutputMaxBytes = normalizeToolOutputMaxBytes(options?.toolOutputMaxBytes);
  const foldClosedTools = options?.foldClosedTools === true;

  const idByMessage = new Map();
  const messageById = new Map();
  const ordinalById = new Map();
  const opaqueStructuredIds = new Set();

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
      if (!isSyntheticMissingResult(message)) {
        throw codecError('unmappable Durable message in context view (not a contribution, not a synthesized missing tool result)');
      }
      id = `missing:${message.toolCallId}`;
    }
    if (!messageById.has(id)) messageById.set(id, message);
    if (!ordinalById.has(id)) ordinalById.set(id, ordinal);

    if (isPureText(message)) {
      return { id, role: message.role, contentType: 'text', text: joinText(message) };
    }
    if (message.role === 'toolResult') {
      if (isSyntheticMissingResult(message)) opaqueStructuredIds.add(id);
      return toolResultCore(message, id);
    }
    opaqueStructuredIds.add(id);
    return opaqueCore(message, id);
  });

  const isBcAuxiliary = (message) => Boolean(
    message && message.role === 'user' && (message.bcContextMaterial === true || message.bcSummaryMaterial === true),
  );
  // 真实 Durable 视图中的最后一个非 system、非显式辅助消息 ordinal（无则为 -1）。
  let rawInputOrdinal = -1;
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i];
    if (m && m.role !== 'system' && !isBcAuxiliary(m)) {
      rawInputOrdinal = i;
      break;
    }
  }
  const lastUserOrdinal = view.messages.findLastIndex((message) => message?.role === 'user' && !isBcAuxiliary(message));
  const lastUserId = lastUserOrdinal === -1 ? null : messages[lastUserOrdinal].id;

  // 建立 toolCall / toolResult 精确配对索引（用于防 orphan 与可选整组折叠）。
  const callCountByToolCallId = new Map();
  const callOwnerByToolCallId = new Map();
  const resultCountByToolCallId = new Map();
  const resultInfoByToolCallId = new Map();

  for (let ordinal = 0; ordinal < view.messages.length; ordinal++) {
    const message = view.messages[ordinal];
    const id = messages[ordinal].id;
    if (message?.role === 'assistant') {
      for (const call of getAssistantToolCalls(message)) {
        if (typeof call.id !== 'string' || call.id.length === 0) continue;
        callCountByToolCallId.set(call.id, (callCountByToolCallId.get(call.id) ?? 0) + 1);
        if (!callOwnerByToolCallId.has(call.id)) {
          callOwnerByToolCallId.set(call.id, { id, ordinal, message, call });
        }
      }
    } else if (message?.role === 'toolResult') {
      if (typeof message.toolCallId !== 'string' || message.toolCallId.length === 0) continue;
      resultCountByToolCallId.set(message.toolCallId, (resultCountByToolCallId.get(message.toolCallId) ?? 0) + 1);
      if (!resultInfoByToolCallId.has(message.toolCallId)) {
        resultInfoByToolCallId.set(message.toolCallId, { id, ordinal, message });
      }
    }
  }

  // 唯一配对的 resultId -> assistantId（用于还原缺失 toolResult 时紧贴其 assistant toolCall）。
  const pairedCallIdByResultId = new Map();
  for (const [toolCallId, resultInfo] of resultInfoByToolCallId) {
    if (resultCountByToolCallId.get(toolCallId) !== 1) continue;
    if (callCountByToolCallId.get(toolCallId) !== 1) continue;
    const owner = callOwnerByToolCallId.get(toolCallId);
    if (owner && resultInfo.ordinal > owner.ordinal) {
      pairedCallIdByResultId.set(resultInfo.id, owner.id);
    }
  }

  // opt-in foldClosedTools：仅允许完整、历史（早于最后真实输入）、无图像/非文本、非元工具、
  // 单调用配对的 toolCall/toolResult 整组折叠（多调用组在 acp-kernel@0.0.101 标量 toolCallId ABI 下保持保护）。
  const foldableToolGroups = [];
  const foldableToolIds = new Set();
  if (foldClosedTools && rawInputOrdinal >= 0) {
    for (let ordinal = 0; ordinal < view.messages.length; ordinal++) {
      const message = view.messages[ordinal];
      if (message?.role !== 'assistant') continue;
      const calls = getAssistantToolCalls(message);
      if (calls.length !== 1) continue;
      if (!isAssistantFoldableContent(message)) continue;
      const call = calls[0];
      if (typeof call.id !== 'string' || call.id.length === 0) continue;
      if (isAlwaysProtectedToolName(call.name)) continue;
      if (callCountByToolCallId.get(call.id) !== 1) continue;
      if (resultCountByToolCallId.get(call.id) !== 1) continue;
      const resultInfo = resultInfoByToolCallId.get(call.id);
      if (!resultInfo || resultInfo.ordinal <= ordinal) continue;
      if (ordinal >= rawInputOrdinal || resultInfo.ordinal >= rawInputOrdinal) continue;
      const resultMessage = resultInfo.message;
      if (isSyntheticMissingResult(resultMessage)) continue;
      if (isAlwaysProtectedToolName(resultMessage.toolName)) continue;
      if (!isPureTextContent(resultMessage.content)) continue;

      const assistantId = messages[ordinal].id;
      const resultId = resultInfo.id;
      foldableToolGroups.push([assistantId, resultId]);
      foldableToolIds.add(assistantId);
      foldableToolIds.add(resultId);
    }
  }

  const protectedIds = new Set();
  for (let ordinal = 0; ordinal < view.messages.length; ordinal++) {
    const message = view.messages[ordinal];
    const id = messages[ordinal].id;
    const isProtectedBase = !isPureText(message) && !foldableToolIds.has(id);
    if (isProtectedBase || ordinal === rawInputOrdinal || ordinal === lastUserOrdinal) {
      protectedIds.add(id);
    }
  }

  // 全部原生消息 id 的原始顺序与无条件必保序（系统、opaque、受保护工具消息、最后真实输入）。
  const allOrder = [...ordinalById.keys()];
  const mandatoryOrder = allOrder.filter((id) => protectedIds.has(id));

  /**
   * 构造可见模型副本的 toolResult：仅改写/cap 正文文本块，
   * 保留 role/toolCallId/toolName/isError/details/timestamp 与全部非文本块，绝不改 Durable 原对象。
   */
  function restoreToolResult(native, targetText) {
    if (isSyntheticMissingResult(native)) return native;
    const base = joinText(native);
    const cappedText = capToolOutputText(targetText, toolOutputMaxBytes);
    if (cappedText === base) return native;
    if (typeof native.content === 'string') {
      return { ...native, content: cappedText };
    }
    if (!Array.isArray(native.content)) {
      return { ...native, content: [{ type: 'text', text: cappedText }] };
    }
    const firstTextIdx = native.content.findIndex((block) => block?.type === 'text');
    if (firstTextIdx === -1) {
      if (cappedText.length === 0) return native;
      return { ...native, content: [...native.content, { type: 'text', text: cappedText }] };
    }
    const nextContent = [];
    for (let i = 0; i < native.content.length; i++) {
      const block = native.content[i];
      if (block?.type === 'text') {
        if (i === firstTextIdx) nextContent.push({ type: 'text', text: cappedText });
      } else {
        nextContent.push(block);
      }
    }
    return { ...native, content: nextContent };
  }

  function restoreMissingNative(native) {
    if (native?.role === 'toolResult') {
      return restoreToolResult(native, joinText(native));
    }
    return native;
  }

  function restoreNative(core, native) {
    if (opaqueStructuredIds.has(core.id)) return native; // opaque 原样返回，绝不把 core.text 写入任何字段
    if (native.role === 'toolResult') {
      const targetText = typeof core.text === 'string' ? core.text : joinText(native);
      return restoreToolResult(native, targetText);
    }
    const base = joinText(native);
    const targetText = typeof core.text === 'string' ? core.text : base;
    if (targetText === base) return native; // 文本未变，原样返回
    // 真实最后用户输入不因内核紧急截断而受损（合法标签改写如 <acp ...> 照常保留）。
    if (
      core.id === lastUserId &&
      native.role === 'user' &&
      targetText.includes(KERNEL_TRUNCATION_MARKER) &&
      !base.includes(KERNEL_TRUNCATION_MARKER)
    ) {
      return native;
    }
    // 文本改变：保留消息级元数据；string 仍为 string，数组改为新的单 text 块（不沿用已失效 textSignature）。
    const content = typeof native.content === 'string' ? targetText : [{ type: 'text', text: targetText }];
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
   * 还原投影并输出最小侧带来源映射：基于 Durable 真实 ordinalById 精确追踪原末条输入是否保留及
   * 全部合成辅助 user 索引（涵盖压缩、renderTags 文本改写、toolResult 文本改写/cap 与缺失受保护项补回）。
   */
  function restoreWithProvenance(projected) {
    const projectedIds = new Set(projected.map((core) => core.id));
    const missingSet = new Set();
    for (const id of mandatoryOrder) {
      if (!projectedIds.has(id)) missingSet.add(id);
    }
    // 可折叠工具组原子性：仅当整组均不在 projected 中时保持折叠；部分被裁剪时补回缺口防 orphan。
    for (const groupIds of foldableToolGroups) {
      const anyPresent = groupIds.some((id) => projectedIds.has(id));
      if (!anyPresent) continue;
      for (const id of groupIds) {
        if (!projectedIds.has(id)) missingSet.add(id);
      }
    }
    const missingMandatory = allOrder.filter((id) => missingSet.has(id));

    // 预计算每个 projected 位置之后的下一个原生消息 ordinal，供合成消息前安全 flush 配对 toolResult。
    const nextNativeOrdinalAfter = new Array(projected.length);
    let nextOrd = Number.POSITIVE_INFINITY;
    for (let i = projected.length - 1; i >= 0; i--) {
      nextNativeOrdinalAfter[i] = nextOrd;
      const ord = ordinalById.get(projected[i].id);
      if (ord !== undefined) nextOrd = ord;
    }

    const restored = [];
    const auxiliaryIndices = [];
    let inputIndex = null;
    const seen = new Set();
    let miss = 0;

    const pushNative = (ordinal, message) => {
      const idx = restored.length;
      restored.push(message);
      if (ordinal === rawInputOrdinal) inputIndex = idx;
      else if (isBcAuxiliary(message)) auxiliaryIndices.push(idx);
    };

    const emitMissing = () => {
      const missId = missingMandatory[miss];
      seen.add(missId);
      pushNative(ordinalById.get(missId), restoreMissingNative(messageById.get(missId)));
      miss++;
    };

    for (let i = 0; i < projected.length; i++) {
      const core = projected[i];
      if (seen.has(core.id)) continue; // 去重，避免同一身份重复输出
      seen.add(core.id);
      const native = messageById.get(core.id);
      if (native === undefined) {
        const nextNativeOrd = nextNativeOrdinalAfter[i];
        while (miss < missingMandatory.length) {
          const missId = missingMandatory[miss];
          if (ordinalById.get(missId) >= nextNativeOrd) break;
          const ownerId = pairedCallIdByResultId.get(missId);
          if (ownerId === undefined || !seen.has(ownerId)) break;
          emitMissing();
        }
        auxiliaryIndices.push(restored.length);
        restored.push(syntheticUserContext(core));
        continue;
      }
      const ordinal = ordinalById.get(core.id) ?? Number.POSITIVE_INFINITY;
      while (miss < missingMandatory.length && ordinalById.get(missingMandatory[miss]) <= ordinal) {
        emitMissing();
      }
      pushNative(ordinal, restoreNative(core, native));
    }
    while (miss < missingMandatory.length) {
      emitMissing();
    }
    return {
      messages: restored,
      inputIndex,
      lostInput: rawInputOrdinal !== -1 && inputIndex === null,
      auxiliaryIndices,
    };
  }

  function restore(projected) {
    return restoreWithProvenance(projected).messages;
  }

  return { messages, protectedIds, restore, restoreWithProvenance };
}
