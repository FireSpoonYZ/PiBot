import { createHash } from 'node:crypto';
import {
  createCore,
  defaultConfig,
  countMessageTokens,
  parseCompressArgs,
  collectBlockContent,
  prune,
  renderNudgeText,
  blockDocs,
  messageDocs,
  searchBlocks,
} from 'acp-kernel';
import {
  AUTO_FOLD_BACKOFF_MS,
  BC_KERNEL_VERSION,
  COMPRESS_FAILURE_PAUSE_THRESHOLD,
} from './context-state.js';
import { createContextCodec } from './context-codec.js';
import {
  buildProtectedRefSet,
  computeGrowthTarget,
  getAutoFoldFloor,
  isAutoFoldBackoffActive,
  isBcAuxiliaryMessage,
  isGrowthFoldingArmed,
  normalizePluginConfig,
  projectWithoutNudge,
  runPreflightCompaction,
  safeEstimateTokens,
} from './context-preflight.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stateDigest(state) {
  return sha256(JSON.stringify(state));
}

function textResult(text) {
  return { output: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { output: [{ type: 'text', text }], isError: true };
}

function invalidArgument(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function normalizeTurnKey(turnKey) {
  if (typeof turnKey === 'string' && turnKey.trim() !== '') return turnKey.trim();
  return null;
}

/** 优先采用 Host 传入的真实冻结用户轮 requestId；缺省时回退到视图末条真实 user 消息 ID，绝不使用 generation taskId。 */
function deriveTurnKey(explicitTurnKey, view, codec) {
  const direct = normalizeTurnKey(explicitTurnKey);
  if (direct !== null) return direct;
  const viewMessages = Array.isArray(view?.messages) ? view.messages : [];
  const coreMessages = Array.isArray(codec?.messages) ? codec.messages : [];
  for (let i = viewMessages.length - 1; i >= 0; i--) {
    const m = viewMessages[i];
    if (m && m.role === 'user' && !isBcAuxiliaryMessage(m) && coreMessages[i]?.id) {
      return 'user:' + coreMessages[i].id;
    }
  }
  return null;
}

function resolveAttemptId(options, api, task) {
  if (options?.attempt !== undefined && options.attempt !== null) return options.attempt;
  if (api?.attempt !== undefined && api.attempt !== null) return api.attempt;
  if (task?.attempt !== undefined && task.attempt !== null) return task.attempt;
  if (task?.state?.checkpoint?.attempt !== undefined) return task.state.checkpoint.attempt;
  return 0;
}

function recordCompressToolOutcome(doc, succeeded) {
  const currentTurnKey =
    normalizeTurnKey(doc.latestTurnKey) ?? normalizeTurnKey(doc.prepared?.turnKey) ?? null;
  if (succeeded) {
    doc.compressLoop = {
      turnKey: currentTurnKey,
      consecutiveFailures: 0,
      paused: false,
    };
    return;
  }
  const prev = doc.compressLoop ?? { turnKey: null, consecutiveFailures: 0, paused: false };
  const sameTurn = prev.turnKey === currentTurnKey;
  const nextCount = (sameTurn ? (prev.consecutiveFailures || 0) : 0) + 1;
  doc.compressLoop = {
    turnKey: currentTurnKey,
    consecutiveFailures: nextCount,
    paused: nextCount >= COMPRESS_FAILURE_PAUSE_THRESHOLD,
  };
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

/** 会话投影、预压缩/溢出压缩、压缩工具和只读状态查询。 */
export function createContextManager({ getHarness, models, ContextState, effectiveConfig }) {
  const core = createCore();
  const pluginConfig = normalizePluginConfig(effectiveConfig);

  async function prepare(_request, api, context, turnKey, preflightTarget) {
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
    const codec = createContextCodec(view, { foldClosedTools: true });

    const model = models.getModel(modelRef.provider, modelRef.modelId);
    if (!model) {
      throw new Error('model ' + modelRef.provider + '/' + modelRef.modelId + ' is not available');
    }
    const config = defaultConfig(preflightTarget ?? model.contextWindow);
    const effectiveTurnKey = deriveTurnKey(turnKey, view, codec);

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
        delete doc.latestTurnKey;
        delete doc.nudgeMeta;
        delete doc.compressLoop;
        delete doc.autoFold;
        delete doc.compactLedger;
      }
      // 在 commit callback 仍活跃时复制草稿内容，避免事务外访问 Draft Proxy。
      if (doc.prepared?.key === key) {
        if (effectiveTurnKey !== null && doc.latestTurnKey !== effectiveTurnKey) {
          doc.latestTurnKey = effectiveTurnKey;
          doc.prepared.turnKey = effectiveTurnKey;
        }
        return {
          messages: JSON.parse(JSON.stringify(doc.prepared.messages)),
          ...(doc.prepared.turnProvenance ? { turnProvenance: JSON.parse(JSON.stringify(doc.prepared.turnProvenance)) } : {}),
        };
      }

      if (effectiveTurnKey !== null && doc.compressLoop?.turnKey && doc.compressLoop.turnKey !== effectiveTurnKey) {
        doc.compressLoop = { turnKey: effectiveTurnKey, consecutiveFailures: 0, paused: false };
      }
      if (doc.compactLedger?.taskId !== String(api.taskId)) {
        doc.compactLedger = null;
      }

      const state = JSON.parse(JSON.stringify(doc.state));
      const prevNudgeState = JSON.parse(JSON.stringify(state.nudge));
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
      const restored = codec.restoreWithProvenance(result.messages);
      const messages = JSON.parse(JSON.stringify(restored.messages));
      const auxiliaryIndices = [...restored.auxiliaryIndices];
      let projectedTokenCount = result.messages.reduce((sum, message) => sum + countMessageTokens(message), 0);

      const wantsNudge = Boolean(result.nudge?.shouldInject);
      const isEmergencyNudge =
        (result.nudge?.breakdown?.emergencyOverride ?? 0) > 0 ||
        (result.nudge?.contextUsage ?? 0) >= config.nudge.emergencyThresholdPct;

      // 1) 失败/0-block compress 3 次：暂停本轮所有 nudge（包括 emergency nudge），成功 compress 解除。
      const pausedByCompressLoop =
        doc.compressLoop?.paused === true && doc.compressLoop.turnKey === effectiveTurnKey;

      // 2) autoFold 生效且未退避且存在低于硬预算的可达增长目标时，才抑制传统 nudge。
      const suppressedByAutoFold = isGrowthFoldingArmed(pluginConfig, doc, preflightTarget);

      // 同轮提醒用内核的增长门槛；压完明显回落时在较小的视图上重新累计。
      const { growthFloor, nudgeGrowthTokens } = result.nudge?.breakdown ?? {};
      let prevNudgeMeta = doc.nudgeMeta ?? { lastTurnKey: null, lastShownTokens: 0 };
      if (prevNudgeMeta.lastTurnKey === effectiveTurnKey && prevNudgeMeta.lastShownTokens - tokenCount > nudgeGrowthTokens) {
        prevNudgeMeta = { lastTurnKey: effectiveTurnKey, lastShownTokens: tokenCount };
        doc.nudgeMeta = prevNudgeMeta;
      }
      const regrowthThreshold = growthFloor ?? config.nudge.minGrowthFloor;
      const sameTurnNormalDedup =
        !isEmergencyNudge &&
        effectiveTurnKey !== null &&
        prevNudgeMeta.lastTurnKey === effectiveTurnKey &&
        tokenCount - (prevNudgeMeta.lastShownTokens ?? 0) < regrowthThreshold;

      const shouldInjectNudge =
        wantsNudge && !pausedByCompressLoop && !suppressedByAutoFold && !sameTurnNormalDedup;

      if (wantsNudge && !shouldInjectNudge) {
        // 被抑制的 nudge 不得推进 kernel 的 lastNudgeShownTokens，以免后续恢复提醒时被误判为刚提醒过。
        result.state.nudge = {
          ...result.state.nudge,
          lastNudgeShownTokens: prevNudgeState.lastNudgeShownTokens,
          lastShownByTier: { ...(prevNudgeState.lastShownByTier ?? {}) },
        };
      } else if (shouldInjectNudge) {
        // kernel 的 nudgeNode 只返回 effects.nudge，不插入消息；宿主在此显式追加一次临时 user 提醒（不入 Durable 历史）。
        const nudgeText = renderNudgeText(result.nudge).text;
        auxiliaryIndices.push(messages.length);
        messages.push({ role: 'user', content: nudgeText, timestamp: 0, bcContextMaterial: true });
        projectedTokenCount += countMessageTokens({ text: nudgeText });
        if (!isEmergencyNudge) doc.nudgeMeta = { lastTurnKey: effectiveTurnKey, lastShownTokens: tokenCount };
      }

      const turnProvenance = {
        cutoff,
        inputIndex: restored.inputIndex,
        lostInput: restored.lostInput,
        auxiliaryIndices,
      };
      doc.state = JSON.parse(JSON.stringify(result.state));
      doc.contentStore = JSON.parse(JSON.stringify(result.contentStore));
      if (effectiveTurnKey !== null) doc.latestTurnKey = effectiveTurnKey;
      doc.prepared = {
        key,
        taskId: String(api.taskId),
        cutoff,
        headEntryId,
        contextWindow: model.contextWindow,
        tokenCount: projectedTokenCount,
        messages,
        turnProvenance,
        turnKey: effectiveTurnKey,
        revision: 0,
      };
      return { messages, turnProvenance };
    }, context);
  }

  async function compact(options, api, context, hooks = {}) {
    if (!options || typeof options !== 'object') {
      throw invalidArgument('compactContext requires an options object');
    }
    const { reason, targetTokens, estimateTokens, turnKey } = options;
    if (reason !== 'preflight' && reason !== 'overflow') {
      throw invalidArgument('compactContext reason must be "preflight" or "overflow"');
    }
    if (typeof targetTokens !== 'number' || !Number.isFinite(targetTokens) || targetTokens <= 0) {
      throw invalidArgument('compactContext targetTokens must be a finite positive number');
    }
    if (typeof estimateTokens !== 'function') {
      throw invalidArgument('compactContext estimateTokens must be a function');
    }

    const abortSignal = context?.abortSignal;
    abortSignal?.throwIfAborted();

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

    const view = await conversation.context(context, { at: cutoff });
    const headEntryId = view.head?.id ?? null;
    const codec = createContextCodec(view, { foldClosedTools: true });
    const model = models.getModel(modelRef.provider, modelRef.modelId);
    if (!model) {
      throw new Error('model ' + modelRef.provider + '/' + modelRef.modelId + ' is not available');
    }
    const config = defaultConfig(model.contextWindow);

    // Phase 1：事务外只读快照与触发/去重判断（不持 Durable 锁）。
    const snapshot = await harness.snapshot(ContextState, api.conversationId, context);
    if (snapshot) assertKernelVersion(snapshot);
    const prepared = snapshot?.prepared;
    if (
      !prepared ||
      prepared.taskId !== String(api.taskId) ||
      prepared.cutoff !== cutoff ||
      (prepared.headEntryId ?? null) !== headEntryId
    ) {
      return { status: 'unchanged' };
    }

    const expectedHeadEntryId = headEntryId;
    const expectedPreparedKey = prepared.key;
    const expectedTaskId = String(api.taskId);
    const expectedCutoff = cutoff;
    const expectedPreparedRevision = prepared.revision ?? 0;
    const expectedStateDigest = stateDigest(snapshot.state);
    const hardTarget = targetTokens;

    const effectiveTurnKey =
      normalizeTurnKey(turnKey) ??
      normalizeTurnKey(prepared.turnKey) ??
      normalizeTurnKey(snapshot.latestTurnKey) ??
      deriveTurnKey(null, view, codec);

    const attemptId = resolveAttemptId(options, api, task);
    const attemptKey = `${expectedTaskId}:${String(attemptId)}`;

    const initialEstimate = await safeEstimateTokens(estimateTokens, prepared.messages, abortSignal);
    if (!Number.isFinite(initialEstimate)) return { status: 'no_range' };
    // overflow 始终使用 Host 拒绝后给出的更紧目标，不走 growthTarget。
    const growthTarget =
      reason === 'preflight' && !isAutoFoldBackoffActive(snapshot)
        ? computeGrowthTarget(pluginConfig, hardTarget, getAutoFoldFloor(snapshot))
        : null;

    // 同一 API attempt 重复恢复限定，避免重复昂贵摘要与重复提交。
    const existingAttempt =
      snapshot.compactLedger?.taskId === expectedTaskId
        ? snapshot.compactLedger.byAttempt?.[attemptKey]
        : undefined;
    if (reason === 'preflight' && existingAttempt?.preflight && hardTarget >= existingAttempt.preflight.targetTokens) {
      if (Number.isFinite(initialEstimate) && initialEstimate < hardTarget) {
        return { status: 'unchanged' };
      }
      const prevStatus = existingAttempt.preflight.status;
      return { status: prevStatus === 'compacted' ? 'still_over_limit' : prevStatus };
    }
    if (reason === 'overflow' && existingAttempt?.overflow) {
      if (Number.isFinite(initialEstimate) && initialEstimate < hardTarget) {
        return { status: 'unchanged' };
      }
      const prevStatus = existingAttempt.overflow.status;
      return { status: prevStatus === 'compacted' ? 'still_over_limit' : prevStatus };
    }

    if (reason === 'overflow') {
      if (Number.isFinite(initialEstimate) && initialEstimate < hardTarget) {
        return { status: 'unchanged' };
      }
    } else {
      // preflight：低于硬预算且未触发增长目标时无需压缩；若 autoFold 开启则同步有效硬预算给下轮 prepareContext。
      if (Number.isFinite(initialEstimate) && initialEstimate < hardTarget) {
        if (growthTarget === null || initialEstimate < growthTarget) {
          if (
            pluginConfig.autoFold &&
            (snapshot.autoFold?.hardTarget !== hardTarget || snapshot.autoFold?.contextWindow !== model.contextWindow)
          ) {
            hooks.assertActive?.();
            await harness.commit(async (tx) => {
              const doc = await tx.doc(ContextState, api.conversationId);
              assertKernelVersion(doc);
              if (
                (doc.prepared?.headEntryId ?? null) !== expectedHeadEntryId ||
                doc.prepared?.key !== expectedPreparedKey ||
                doc.prepared?.taskId !== expectedTaskId ||
                doc.prepared?.cutoff !== expectedCutoff
              ) {
                return;
              }
              doc.autoFold = {
                ...(doc.autoFold ?? { backoffUntil: null, floorTokens: null }),
                hardTarget,
                contextWindow: model.contextWindow,
              };
            }, context);
          }
          return { status: 'unchanged' };
        }
      }
    }

    // Phase 2：摘要 I/O 全部在 Durable 事务外执行；绝不吞 cancellation。
    const baseProjection = projectWithoutNudge(core, codec, snapshot.state, snapshot.contentStore, config);
    const sameAsBase = JSON.stringify(baseProjection.messages) === JSON.stringify(prepared.messages);
    const initialBaseEstimate = sameAsBase
      ? initialEstimate
      : await safeEstimateTokens(estimateTokens, baseProjection.messages, abortSignal);

    const outcome = await runPreflightCompaction({
      core,
      models,
      model,
      view,
      codec,
      state: snapshot.state,
      contentStore: snapshot.contentStore,
      config,
      reason,
      hardTarget,
      growthTarget,
      estimateTokens,
      initialEstimate,
      initialBaseEstimate,
      abortSignal,
    });

    abortSignal?.throwIfAborted();
    hooks.assertActive?.();

    let status;
    if (outcome.mode === 'preflight-growth') {
      // 低于硬上限绝不因增长目标失败而阻塞请求。
      status = outcome.compacted ? 'compacted' : 'unchanged';
    } else if (outcome.compacted) {
      status = Number.isFinite(outcome.finalEstimate) && outcome.finalEstimate < hardTarget
        ? 'compacted'
        : 'still_over_limit';
    } else if (outcome.hadSummaryFailure) {
      status = 'summary_failed';
    } else if (!outcome.hadCandidates) {
      status = 'no_range';
    } else {
      status = 'still_over_limit';
    }

    // Phase 3：短事务写回，写前核对 view.head / prepared key / taskId / cutoff / revision 与旧 state 防覆盖。
    return harness.commit(async (tx) => {
      hooks.assertActive?.();
      abortSignal?.throwIfAborted();
      const doc = await tx.doc(ContextState, api.conversationId);
      assertKernelVersion(doc);

      const stateMatches =
        (doc.prepared?.headEntryId ?? null) === expectedHeadEntryId &&
        doc.prepared?.key === expectedPreparedKey &&
        doc.prepared?.taskId === expectedTaskId &&
        doc.prepared?.cutoff === expectedCutoff &&
        (doc.prepared?.revision ?? 0) === expectedPreparedRevision &&
        stateDigest(doc.state) === expectedStateDigest;

      if (!stateMatches) {
        if (outcome.mode === 'preflight-growth' || (Number.isFinite(initialEstimate) && initialEstimate < hardTarget)) {
          return { status: 'unchanged' };
        }
        return { status: 'still_over_limit' };
      }

      const ledger =
        doc.compactLedger?.taskId === expectedTaskId
          ? doc.compactLedger
          : { taskId: expectedTaskId, byAttempt: {} };
      const attemptEntry = ledger.byAttempt[attemptKey] ?? {};
      if (reason === 'overflow' && attemptEntry.overflow) {
        return { status: Number.isFinite(initialEstimate) && initialEstimate < hardTarget ? 'unchanged' : 'still_over_limit' };
      }
      if (reason === 'preflight' && attemptEntry.preflight && hardTarget >= attemptEntry.preflight.targetTokens) {
        return { status: Number.isFinite(initialEstimate) && initialEstimate < hardTarget ? 'unchanged' : 'still_over_limit' };
      }

      attemptEntry[reason] = { targetTokens: hardTarget, status };
      ledger.byAttempt[attemptKey] = attemptEntry;
      doc.compactLedger = ledger;

      const prevAutoFold = doc.autoFold ?? { backoffUntil: null, floorTokens: null, hardTarget: null, contextWindow: null };
      const nextAutoFold = { ...prevAutoFold };
      if (reason === 'preflight') {
        nextAutoFold.hardTarget = hardTarget;
        nextAutoFold.contextWindow = model.contextWindow;
      }
      if (outcome.mode === 'preflight-growth') {
        if (outcome.compacted && Number.isFinite(outcome.finalEstimate) && outcome.finalEstimate < growthTarget) {
          nextAutoFold.backoffUntil = null;
          nextAutoFold.floorTokens = null;
        } else if (outcome.compacted) {
          if (outcome.hadSummaryFailure) {
            nextAutoFold.backoffUntil = Date.now() + AUTO_FOLD_BACKOFF_MS;
          } else if (outcome.exhausted && Number.isFinite(outcome.finalEstimate)) {
            nextAutoFold.floorTokens = outcome.finalEstimate;
          }
        } else if (outcome.hadSummaryFailure) {
          // 摘要暂时不可用：退避期间恢复普通提醒。
          nextAutoFold.backoffUntil = Date.now() + AUTO_FOLD_BACKOFF_MS;
        } else {
          // 初期没有可折叠历史属于正常稳态，等历史继续增长，不暂停整个会话的自动折叠。
          nextAutoFold.floorTokens = initialEstimate;
        }
      } else if (outcome.compacted && Number.isFinite(outcome.finalEstimate)) {
        if (growthTarget === null || outcome.finalEstimate < growthTarget) {
          nextAutoFold.backoffUntil = null;
          nextAutoFold.floorTokens = null;
        }
      }
      doc.autoFold = nextAutoFold;

      if (!outcome.compacted || !outcome.finalProjection || !outcome.finalState) {
        return { status };
      }

      const finalMessages = JSON.parse(JSON.stringify(outcome.finalProjection.messages));
      const finalProvenance = {
        cutoff: expectedCutoff,
        inputIndex: outcome.finalProjection.turnProvenance.inputIndex,
        lostInput: outcome.finalProjection.turnProvenance.lostInput,
        auxiliaryIndices: [...outcome.finalProjection.turnProvenance.auxiliaryIndices],
      };

      doc.state = JSON.parse(JSON.stringify(outcome.finalState));
      doc.contentStore = JSON.parse(JSON.stringify(outcome.finalContentStore));
      doc.nudgeMeta = { lastTurnKey: null, lastShownTokens: 0 };
      if (effectiveTurnKey !== null) doc.latestTurnKey = effectiveTurnKey;
      doc.prepared = {
        ...doc.prepared,
        key: expectedPreparedKey,
        taskId: expectedTaskId,
        cutoff: expectedCutoff,
        headEntryId: expectedHeadEntryId,
        contextWindow: model.contextWindow,
        tokenCount: outcome.finalProjection.projectedTokenCount,
        messages: finalMessages,
        turnProvenance: finalProvenance,
        turnKey: effectiveTurnKey,
        revision: expectedPreparedRevision + 1,
      };

      return {
        status,
        messages: JSON.parse(JSON.stringify(finalMessages)),
        turnProvenance: JSON.parse(JSON.stringify(finalProvenance)),
      };
    }, context);
  }

  async function compress(args, api, context) {
    const harness = getHarness();
    const snapshot = await harness.snapshot(ContextState, api.conversationId, context);
    if (snapshot) assertKernelVersion(snapshot);
    const prepared = snapshot?.prepared;
    if (!prepared) return errorResult('上下文尚未 prepare，无可压缩内容');

    const parsed = parseCompressArgs(args, { callId: api.callId });
    // 重启重放去重：用工具 taskId 做键，不用模型 callId（可能跨轮重复）。
    const key = 'tool:' + api.taskId;
    if (parsed.ranges.length === 0) {
      return api.commit(async (tx) => {
        const doc = await tx.doc(ContextState, api.conversationId);
        assertKernelVersion(doc);
        doc.operations ??= {};
        const cached = doc.operations[key];
        if (cached !== undefined) return JSON.parse(JSON.stringify(cached));
        const toolResult = errorResult('compress 参数未解析出有效 range（kind=' + parsed.diagnostics.kind + '）');
        recordCompressToolOutcome(doc, false);
        doc.operations[key] = toolResult;
        return toolResult;
      }, context);
    }

    const conversation = await harness.conversation(api.conversationId, context);
    if (!conversation) return errorResult('conversation ' + api.conversationId + ' not found');
    const view = await conversation.context(context, { at: prepared.cutoff });
    const codec = createContextCodec(view, { foldClosedTools: true });
    const config = defaultConfig(prepared.contextWindow);

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
        protectedMessageIds: buildProtectedRefSet(codec.protectedIds, state),
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
      const succeeded = result.errors.length === 0 && result.blocksCreated > 0;
      doc.state = JSON.parse(JSON.stringify(compressed.state));
      recordCompressToolOutcome(doc, succeeded);
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

  return { prepare, compact, compress, decompress, search, status, inspect };
}
