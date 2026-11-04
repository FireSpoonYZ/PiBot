import { createHash } from 'node:crypto';
import { createCore, defaultConfig, countMessageTokens, parseCompressArgs, collectBlockContent, prune, renderNudgeText, blockDocs, messageDocs, searchBlocks } from 'acp-kernel';
import { BC_KERNEL_VERSION } from './context-state.js';
import { createContextCodec } from './context-codec.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function textResult(text) {
  return { output: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { output: [{ type: 'text', text }], isError: true };
}

/** 固定 kernel 版本校验：版本不匹配即拒绝继续，防新版状态被旧 kernel 修改/重置。 */
function assertKernelVersion(doc) {
  if (doc.kernelVersion !== BC_KERNEL_VERSION) {
    const err = new Error('kernel version mismatch: expected ' + BC_KERNEL_VERSION + ', found ' + doc.kernelVersion);
    err.code = 'UNSUPPORTED_SCHEMA';
    throw err;
  }
}

export function emptyContextStatus() {
  return { kernelVersion: BC_KERNEL_VERSION, status: null, blocks: [], messageRefs: { byRaw: {}, byRef: {} }, prepared: null };
}

/** 会话投影、压缩工具和只读状态查询。 */
export function createContextManager({ getHarness, models, ContextState }) {
  const core = createCore();

  async function prepare(_request, api, context) {
    const harness = getHarness();
    const task = await harness.getTask(api.taskId, context);
    const checkpoint = task?.state?.checkpoint;
    const cutoff = checkpoint?.cutoff;
    const modelRef = checkpoint?.model;
    if (cutoff === undefined || !modelRef) {
      throw new Error('generation task ' + api.taskId + ' has no request checkpoint (cutoff/model)');
    }
    const conversation = await harness.conversation(api.conversationId, context);
    if (!conversation) throw new Error('conversation ' + api.conversationId + ' not found');

    // 冻结请求时刻的上下文视图，避免把忙时新消息混入旧轮。
    const view = await conversation.context(context, { at: cutoff });
    const codec = createContextCodec(view);

    const model = models.getModel(modelRef.provider, modelRef.modelId);
    if (!model) {
      throw new Error('model ' + modelRef.provider + '/' + modelRef.modelId + ' is not available');
    }
    const config = defaultConfig(model.contextWindow);

    // 请求投影去重键：taskId + 消息投影的 SHA-256；不含 attempt，重试不重复推进 state。
    const key = String(api.taskId) + sha256(JSON.stringify(codec.messages));
    // 当前上下文边界：reset 或（之后）新 compaction 都会改变它；旧 BC 投影不属于新上下文。
    const headEntryId = view.head?.id ?? null;

    // beforeRequest 在 Session 行之外：用宿主 harness.commit 保存文档，HookApi 无 commit。
    return harness.commit(async (tx) => {
      const doc = await tx.doc(ContextState, api.conversationId);
      assertKernelVersion(doc);
      // head 一变（/clear 的 pi.reset，或随后 SDK compaction），旧 state/contentStore/prepared/operations
      // 可能把清空前的摘要重新注入请求；直接按本插件的 initial factory 重建会话内投影。SDK 原历史不动。
      if ((doc.prepared?.headEntryId ?? null) !== headEntryId) {
        Object.assign(doc, ContextState.definition.initial());
        doc.operations = {};
      }
      // 在 commit callback 仍活跃时复制草稿内容，避免事务外访问 Draft Proxy。
      if (doc.prepared?.key === key) return { messages: JSON.parse(JSON.stringify(doc.prepared.messages)) };

      const state = JSON.parse(JSON.stringify(doc.state));
      // 计量已折叠后的可见视图（prune 输出），不统计原始全部历史；processTurn 仍接原始消息保持稳定 refs。
      const tokenCount = prune(codec.messages, state)
        .reduce((sum, message) => sum + countMessageTokens(message), 0);
      const result = core.processTurn({
        messages: codec.messages,
        state,
        config,
        contentStore: JSON.parse(JSON.stringify(doc.contentStore)),
        tokenCount,
        renderTags: 'text-only',
      });
      const messages = JSON.parse(JSON.stringify(codec.restore(result.messages)));
      let projectedTokenCount = result.messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
      // kernel 的 nudgeNode 只返回 effects.nudge，不插入消息；宿主在此显式追加一次 user 提醒。
      if (result.nudge?.shouldInject) {
        const nudgeText = renderNudgeText(result.nudge).text;
        messages.push({ role: 'user', content: nudgeText, timestamp: 0 });
        projectedTokenCount += countMessageTokens({ text: nudgeText });
      }
      doc.state = JSON.parse(JSON.stringify(result.state));
      doc.contentStore = JSON.parse(JSON.stringify(result.contentStore));
      doc.prepared = { key, taskId: String(api.taskId), cutoff, headEntryId, contextWindow: model.contextWindow, tokenCount: projectedTokenCount, messages };
      return { messages };
    }, context);
  }

  async function compress(args, api, context) {
    const harness = getHarness();
    const snapshot = await harness.snapshot(ContextState, api.conversationId, context);
    const prepared = snapshot?.prepared;
    if (!prepared) return errorResult('上下文尚未 prepare，无可压缩内容');

    const parsed = parseCompressArgs(args, { callId: api.callId });
    if (parsed.ranges.length === 0) {
      return errorResult('compress 参数未解析出有效 range（kind=' + parsed.diagnostics.kind + '）');
    }

    const conversation = await harness.conversation(api.conversationId, context);
    if (!conversation) return errorResult('conversation ' + api.conversationId + ' not found');
    const view = await conversation.context(context, { at: prepared.cutoff });
    const codec = createContextCodec(view);
    const config = defaultConfig(prepared.contextWindow);

    // 重启重放去重：用工具 taskId 做键，不用模型 callId（可能跨轮重复）。
    const key = 'tool:' + api.taskId;
    return api.commit(async (tx) => {
      const doc = await tx.doc(ContextState, api.conversationId);
      assertKernelVersion(doc);
      doc.operations ??= {};
      const cached = doc.operations[key];
      if (cached !== undefined) return JSON.parse(JSON.stringify(cached));

      // 事务内重新读最新 state，串行合并，不能拿旧快照覆盖并行工具的更新。
      const state = JSON.parse(JSON.stringify(doc.state));
      const compressed = core.applyCompression({
        ranges: parsed.ranges,
        messages: codec.messages,
        state,
        config,
        protectedMessageIds: codec.protectedIds,
      });
      const result = compressed.result;
      const resultText = JSON.stringify({
        blocksCreated: result.blocksCreated,
        tokensCompressed: result.tokensCompressed,
        warnings: result.warnings,
        errors: result.errors,
        ...(result.notes !== undefined ? { notes: result.notes } : {}),
      });
      const toolResult = result.errors.length > 0 ? errorResult(resultText) : textResult(resultText);
      doc.state = JSON.parse(JSON.stringify(compressed.state));
      doc.operations[key] = toolResult;
      return toolResult;
    }, context);
  }

  async function decompress(args, api, context) {
    if (typeof args?.toFile === 'string' && args.toFile.trim() !== '') {
      return errorResult('toFile 不受支持：本模块不写用户文件，内容直接内联返回');
    }
    const blockId = typeof args?.blockId === 'string' ? args.blockId.trim() : '';
    if (!blockId) return errorResult('decompress 需要 blockId 参数（如 "b5"）');

    const harness = getHarness();
    const snapshot = await harness.snapshot(ContextState, api.conversationId, context);
    if (snapshot) assertKernelVersion(snapshot);
    const prepared = snapshot?.prepared;
    if (!prepared) return errorResult('上下文尚未 prepare');
    const block = core.decompress(blockId, snapshot.state);
    if (!block) return errorResult('block ' + blockId + ' 不存在');

    const conversation = await harness.conversation(api.conversationId, context);
    if (!conversation) return errorResult('conversation ' + api.conversationId + ' not found');
    const view = await conversation.context(context, { at: prepared.cutoff });
    const codec = createContextCodec(view);
    const collected = collectBlockContent(snapshot.state, block, codec.messages, { full: args?.full === true });
    return textResult(collected.text);
  }

  async function search(args, api, context) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return errorResult('search 需要 query 字符串');
    let limit = args?.limit === undefined ? 10 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return errorResult('limit 必须是 1..100 的整数');
    }

    const harness = getHarness();
    const snapshot = await harness.snapshot(ContextState, api.conversationId, context);
    if (snapshot) assertKernelVersion(snapshot);
    if (!snapshot?.prepared) return errorResult('上下文尚未 prepare');

    const conversation = await harness.conversation(api.conversationId, context);
    if (!conversation) return errorResult('conversation ' + api.conversationId + ' not found');
    const view = await conversation.context(context, { at: snapshot.prepared.cutoff });
    const rawMessages = createContextCodec(view).messages;

    // 来源映射（非搜索算法）：原文消息 → messageDocs 入参；system 或没有 ref 的跳过。
    const inputs = [];
    for (const message of rawMessages) {
      if (message.role === 'system') continue;
      const ref = snapshot.state.messageRefs.byRaw[message.id];
      if (!ref) continue;
      const owned = snapshot.state.blocks.filter((block) => block.effectiveMessageIds.includes(message.id));
      let owner;
      if (owned.length > 0) {
        const activeOwned = owned.filter((block) => block.active);
        // 优先 active block，其次最近的 inactive block（数组按创建顺序，最后一个最新）。
        owner = activeOwned.length > 0 ? activeOwned[activeOwned.length - 1] : owned[owned.length - 1];
      }
      inputs.push({
        ref,
        role: message.role,
        text: message.text ?? '',
        ...(owner ? { blockId: owner.blockId, tier: owner.tier } : {}),
      });
    }

    const results = searchBlocks([...blockDocs(snapshot.state), ...messageDocs(inputs)], query, { limit });
    return textResult(JSON.stringify({ query, count: results.length, results }));
  }

  async function inspect(conversationId, context) {
    const harness = getHarness();
    const doc = await harness.snapshot(ContextState, conversationId, context);
    if (!doc) {
      return emptyContextStatus();
    }
    assertKernelVersion(doc);
    const prepared = doc.prepared;
    const status = prepared
      ? core.status(doc.state, prepared.tokenCount, defaultConfig(prepared.contextWindow))
      : null;
    return {
      kernelVersion: doc.kernelVersion,
      status,
      blocks: doc.state.blocks,
      messageRefs: doc.state.messageRefs,
      prepared: prepared
        ? {
            key: prepared.key,
            taskId: prepared.taskId,
            cutoff: prepared.cutoff,
            contextWindow: prepared.contextWindow,
            tokenCount: prepared.tokenCount,
          }
        : null,
    };
  }

  async function status(_args, api, context) {
    return textResult(JSON.stringify(await inspect(api.conversationId, context)));
  }

  return { prepare, compress, decompress, search, status, inspect };
}
