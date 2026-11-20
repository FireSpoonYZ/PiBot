// host-core/runtime-mcp-dispatch.js
// Isolated request-scoped Durable execution for external MCP Bot dispatches.
//
// Security & privacy invariants:
// - Every external MCP dispatch (botId, requestId) runs in its own brand-new ownerless Durable
//   conversation tracked exclusively in `McpDispatchIndex` + `McpDispatchMeta`.
// - Isolated dispatch conversations are NEVER added to `PrimaryIndex` or `WorkIndex`, so they
//   cannot read private chat history, SOUL.md, Hindsight memory, enabled plugins, learning jobs,
//   or collaboration scopes — and their inputs/answers never enter private chat, TurnQueue,
//   `lastPreview`, live UI, Hindsight retention, or Bot learning.
// - Only the target Bot's Center model selection (`modelRef`, `thinkingLevel`) and safe public
//   persona fields (`role`, `description`) are reused.
// - `host.mcp-dispatch` is the sole enabled extension (0 tools, explicit `tools: []`), and
//   `beforeRequest` enforces `assertMcpSafeAgentState` + `assertMcpSafeProviderRequest` fail-closed.

import { createHash } from 'node:crypto';
import {
  defineDoc,
  defineExtension,
  configure,
  hook,
  GenerationTask,
  AgentDoc,
} from '@earendil-works/pi-durable';
import { parseModelRef } from './runtime-models.js';
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID } from './antigravity-provider.js';
import {
  assertValidAntigravityTurnContext,
  countRequestTokens,
  setRequestBudget,
} from './request-context.js';
import {
  MCP_DISPATCH_EXTENSION_NAME,
  MCP_SAFE_TOOL_POLICY,
  assertMcpSafeAgentState,
  assertMcpSafeProviderRequest,
  boundDispatchAnswerText,
  buildSafeMcpPersonaInstructions,
  isTrustedToolPolicy,
} from './mcp-dispatch-policy.js';

export const MCP_DISPATCH_INPUT_KIND = 'host.mcp-dispatch-input';

// Session-scoped durable index mapping `(botId, requestId)` -> isolated request conversation.
// Never merged into PrimaryIndex or WorkIndex.
export const McpDispatchIndex = defineDoc({
  kind: 'host.mcp-dispatch-index',
  version: 1,
  scope: 'session',
  initial: () => ({ byKey: {} }),
  checkpointWhen: () => false,
});

// Conversation-scoped durable ownership & policy marker for each isolated MCP dispatch session.
export const McpDispatchMeta = defineDoc({
  kind: 'host.mcp-dispatch-meta',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    botId: null,
    requestId: null,
    toolPolicy: null,
    stopEpoch: 0,
    createdAt: null,
  }),
  checkpointWhen: () => false,
});

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNonBlank(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || !value.isWellFormed()) {
    throw errWithCode(`${name} must be a non-empty well-formed string`, 'INVALID_ARGUMENT');
  }
  return value;
}

function dispatchKey(botId, requestId) {
  return JSON.stringify([botId, requestId]);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assistantText(entry) {
  const texts = [];
  for (const message of entry?.model ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block?.type === 'text') texts.push(block.text);
    }
  }
  return texts.join('\n');
}

function computeIsolatedAntigravityTurnContext(messages) {
  let inputIndex = null;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role !== 'system') {
        inputIndex = i;
        break;
      }
    }
  }
  return { inputIndex, auxiliaryIndices: [] };
}

function cancelledReceipt(botId, requestId, reason = 'cancelled') {
  return {
    botId,
    conversationId: null,
    requestId,
    submissionId: null,
    status: 'unanswered',
    answerText: null,
    reason,
  };
}

/**
 * Dedicated zero-tool extension installed in the Host registry exclusively for isolated
 * MCP dispatch conversations (never included in `coreExtensions`).
 * Enforces online status, Bot/model validity, strict 0-tool AgentDoc invariants, and
 * Antigravity turnContext compatibility before any provider request is dispatched.
 */
export function createMcpDispatchExtension({
  host,
  getHarness,
  models,
  isOnline,
  getBotModels,
}) {
  return defineExtension({
    name: MCP_DISPATCH_EXTENSION_NAME,
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        const harness = getHarness();
        try {
          if (!isOnline()) {
            throw errWithCode('center is offline', 'CENTER_OFFLINE');
          }
          const meta = await harness.snapshot(McpDispatchMeta, api.conversationId, context);
          if (
            !meta ||
            typeof meta.botId !== 'string' || meta.botId.trim() === '' ||
            typeof meta.requestId !== 'string' || meta.requestId.trim() === '' ||
            !isTrustedToolPolicy(meta.toolPolicy)
          ) {
            throw errWithCode('conversation is not a valid isolated MCP dispatch session', 'FORBIDDEN');
          }
          const bot = host.getBot(meta.botId);
          if (!bot || bot.deviceId !== host.deviceId) {
            throw errWithCode(`target bot not found: ${meta.botId}`, 'BOT_NOT_FOUND');
          }
          if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
            throw errWithCode('target bot is archived and read-only', 'BOT_ARCHIVED');
          }
          const selection = getBotModels?.()?.[meta.botId];
          const modelRef = selection?.modelRef;
          if (!modelRef) {
            throw errWithCode('center model is required', 'MODEL_REQUIRED');
          }
          const expected = parseModelRef(modelRef);
          const task = await harness.getTask(api.taskId, context);
          const actual = task?.state?.checkpoint?.model;
          if (!actual || actual.provider !== expected.provider || actual.modelId !== expected.modelId) {
            throw errWithCode('center model changed', 'INVALID_STATE');
          }
          const model = models.getModel(actual.provider, actual.modelId);
          if (!model) {
            throw errWithCode('configured model is unavailable', 'INVALID_STATE');
          }
          // Fail-closed structural policy check: AgentDoc must have ONLY host.mcp-dispatch
          // and an explicit empty tool allowlist `[]`, and outgoing request must carry 0 tools.
          const agentState = await harness.snapshot(AgentDoc, api.conversationId, context);
          assertMcpSafeAgentState(agentState);
          assertMcpSafeProviderRequest(request);
          if (Array.isArray(request?.messages)) {
            const total = countRequestTokens(request);
            setRequestBudget(request.messages, total, model.contextWindow);
          }
          return undefined;
        } catch (err) {
          if (!context?.abortSignal?.aborted) {
            // SDK swallows plain hook exceptions; explicitly abort this task before rethrowing.
            try {
              await harness.abortTask(api.taskId, context);
            } catch (abortErr) {
              if (!context?.abortSignal?.aborted) throw abortErr;
            }
          }
          throw err;
        }
      },
      async beforeProviderRequest({ model, payload }, api, context) {
        if (!model || (model.provider !== ANTIGRAVITY_PROVIDER_ID && model.api !== ANTIGRAVITY_API)) {
          return undefined;
        }
        try {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw errWithCode('Antigravity provider payload must be an object', 'INVALID_STATE');
          }
          const turnContext = computeIsolatedAntigravityTurnContext(payload.messages);
          assertValidAntigravityTurnContext(payload.messages, turnContext);
          return { payload: { ...payload, turnContext } };
        } catch (err) {
          if (!context?.abortSignal?.aborted) {
            try {
              await getHarness().abortTask(api.taskId, context);
            } catch (abortErr) {
              if (!context?.abortSignal?.aborted) throw abortErr;
            }
          }
          throw err;
        }
      },
    })],
  });
}

/**
 * Runtime controller for isolated request-scoped MCP Bot dispatches.
 * Owns durable requestId -> conversationId binding, receipt formatting (single answerText only),
 * settlement observation, disconnect abort, and user-stop cancellation.
 */
export function createMcpDispatchRuntime({
  host,
  getHarness,
  models,
  getBotModels,
  mcpDispatchExtension,
  getStopEpoch,
  canRun,
  dropEnvFor,
  onSubmissionUpdated,
  onSubmissionSettled,
  context,
}) {
  let closed = false;
  const tracked = new Map(); // submissionId -> { botId, conversationId, requestId, lastStatus }
  let checkPromise = null;
  let checkAgain = false;

  async function formatSubmission(harness, botId, conversationId, record) {
    let answerText = null;
    let reason = null;
    if (record.status === 'unanswered') {
      reason = record.reason ?? null;
    } else if (record.status === 'done' && record.type === 'input') {
      const entry = await harness.commit((tx) => tx.entry(record.answer), context);
      answerText = boundDispatchAnswerText(assistantText(entry));
    }
    return {
      botId,
      conversationId,
      requestId: record.requestId ?? null,
      submissionId: record.id,
      status: record.status,
      answerText,
      reason,
    };
  }

  function trackSubmission(submissionId, botId, conversationId, requestId, status) {
    if (closed || submissionId === undefined || submissionId === null) return;
    tracked.set(submissionId, { botId, conversationId, requestId, lastStatus: status });
    scheduleCheck();
  }

  function scheduleCheck() {
    if (closed || tracked.size === 0) return;
    if (checkPromise) {
      checkAgain = true;
      return;
    }
    checkPromise = (async () => {
      const harness = getHarness();
      try {
        do {
          checkAgain = false;
          if (closed || !harness) break;
          for (const [submissionId, info] of [...tracked.entries()]) {
            if (closed) break;
            try {
              const sub = await harness.submission(submissionId, context);
              if (!sub) {
                tracked.delete(submissionId);
                continue;
              }
              const statusRecord = await sub.status(context);
              if (statusRecord.status === 'done' || statusRecord.status === 'unanswered') {
                tracked.delete(submissionId);
                dropEnvFor?.(info.conversationId)?.catch?.(() => {});
                onSubmissionSettled?.(statusRecord.requestId ?? info.requestId);
              } else if (statusRecord.status !== info.lastStatus) {
                info.lastStatus = statusRecord.status;
                onSubmissionUpdated?.(statusRecord.requestId ?? info.requestId);
              }
            } catch {
              /* ignore transient/closing observation errors */
            }
          }
        } while (checkAgain && !closed);
      } finally {
        checkPromise = null;
      }
    })();
  }

  let commitObservation = null;
  function ensureObservation() {
    if (closed || commitObservation) return;
    const harness = getHarness();
    if (!harness || typeof harness.observeCommits !== 'function') return;
    commitObservation = harness.observeCommits({
      advance(publication) {
        if (closed || tracked.size === 0) return;
        if (publication && Array.isArray(publication.changes) && publication.changes.some((c) => c?.type === 'submission')) {
          queueMicrotask(() => scheduleCheck());
        }
      },
      end() {
        commitObservation = null;
      },
    });
  }
  ensureObservation();

  async function markCancelledIfUnstarted(harness, botId, requestId, reason = 'cancelled') {
    const key = dispatchKey(botId, requestId);
    return harness.commit(async (tx) => {
      const index = await tx.doc(McpDispatchIndex);
      const entry = index.byKey[key];
      if (!entry) return false;
      if (entry.status === 'cancelled') return true;
      if (entry.status !== 'active') return false;
      if (entry.conversationId !== null && entry.conversationId !== undefined) {
        const sub = await tx.submissionByRequest(entry.conversationId, requestId);
        if (sub) {
          entry.submitted = true;
          return false;
        }
      }
      entry.status = 'cancelled';
      entry.reason = reason;
      return true;
    }, context);
  }

  async function getSubmission(botId, requestId) {
    assertNonBlank(botId, 'botId');
    assertNonBlank(requestId, 'requestId');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
    const harness = getHarness();
    const index = await harness.snapshot(McpDispatchIndex, context);
    const entry = index?.byKey?.[dispatchKey(botId, requestId)];
    if (!entry) return null;
    if (entry.status === 'cancelled' || entry.conversationId === null || entry.conversationId === undefined) {
      return cancelledReceipt(botId, requestId, entry.reason ?? 'cancelled');
    }
    const record = await harness.commit(
      (tx) => tx.submissionByRequest(entry.conversationId, requestId),
      context,
    );
    if (!record) return null;
    if (record.status === 'queued' || record.status === 'placed') {
      ensureObservation();
      trackSubmission(record.id, botId, entry.conversationId, requestId, record.status);
    }
    return formatSubmission(harness, botId, entry.conversationId, record);
  }

  async function submit(botId, input, capturedStopEpoch = 0) {
    assertNonBlank(botId, 'botId');
    const requestId = assertNonBlank(input?.requestId, 'requestId');
    const text = assertNonBlank(input?.text, 'text');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
    if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
      throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
    }
    if (closed || (typeof canRun === 'function' && !canRun(botId))) return null;

    const harness = getHarness();
    const key = dispatchKey(botId, requestId);
    const digest = sha256Hex(text);
    const captured = Number.isSafeInteger(capturedStopEpoch) ? capturedStopEpoch : 0;

    // Fast-path idempotency / conflict / already-submitted check before model resolution.
    const preIndex = await harness.snapshot(McpDispatchIndex, context);
    const preEntry = preIndex?.byKey?.[key];
    if (preEntry) {
      if (preEntry.digest !== digest) {
        throw errWithCode(`requestId ${requestId} conflicts with an existing MCP dispatch`, 'REQUEST_CONFLICT');
      }
      if (preEntry.status === 'cancelled' || preEntry.conversationId === null || preEntry.conversationId === undefined) {
        return cancelledReceipt(botId, requestId, preEntry.reason ?? 'cancelled');
      }
      const existingSub = await harness.commit(
        (tx) => tx.submissionByRequest(preEntry.conversationId, requestId),
        context,
      );
      if (existingSub) {
        if (existingSub.status === 'queued' || existingSub.status === 'placed') {
          ensureObservation();
          trackSubmission(existingSub.id, botId, preEntry.conversationId, requestId, existingSub.status);
        }
        return formatSubmission(harness, botId, preEntry.conversationId, existingSub);
      }
    }

    // Stale stopEpoch: record durable cancelled tombstone without touching any conversation.
    if (captured < (getStopEpoch?.(botId) ?? 0)) {
      const outcome = await harness.commit(async (tx) => {
        const index = await tx.doc(McpDispatchIndex);
        const existing = index.byKey[key];
        if (existing) {
          if (existing.digest !== digest) {
            throw errWithCode(`requestId ${requestId} conflicts with an existing MCP dispatch`, 'REQUEST_CONFLICT');
          }
          if (existing.conversationId !== null && existing.conversationId !== undefined) {
            const sub = await tx.submissionByRequest(existing.conversationId, requestId);
            if (sub) return { entry: existing, existingSubmission: sub };
          }
          existing.status = 'cancelled';
          existing.reason = 'cancelled';
          return { entry: existing, existingSubmission: null };
        }
        const tombstone = {
          botId,
          requestId,
          digest,
          conversationId: null,
          stopEpoch: captured,
          status: 'cancelled',
          reason: 'cancelled',
          submitted: false,
          createdAt: new Date().toISOString(),
        };
        index.byKey[key] = tombstone;
        return { entry: tombstone, existingSubmission: null };
      }, context);
      if (outcome.existingSubmission) {
        return formatSubmission(harness, botId, outcome.entry.conversationId, outcome.existingSubmission);
      }
      return cancelledReceipt(botId, requestId, outcome.entry.reason ?? 'cancelled');
    }

    // Resolve target Bot's Center model selection (reuses model config only; no SOUL/plugins/history).
    const selection = getBotModels?.()?.[botId] ?? {};
    const modelRef = selection.modelRef ?? null;
    if (!modelRef) {
      throw errWithCode('center model is required', 'MODEL_REQUIRED');
    }
    const model = parseModelRef(modelRef);
    if (!models.getModel(model.provider, model.modelId)) {
      throw errWithCode(`model is unavailable: ${modelRef}`, 'MODEL_NOT_FOUND');
    }
    const agentConfig = {
      model,
      thinkingLevel: selection.thinkingLevel ?? null,
      instructions: buildSafeMcpPersonaInstructions(bot),
      cwd: bot.cwd,
      extensions: [mcpDispatchExtension],
      tools: [],
    };

    const committed = await harness.commit(async (tx) => {
      const index = await tx.doc(McpDispatchIndex);
      const existing = index.byKey[key];
      if (existing) {
        if (existing.digest !== digest) {
          throw errWithCode(`requestId ${requestId} conflicts with an existing MCP dispatch`, 'REQUEST_CONFLICT');
        }
        if (existing.status === 'cancelled' || existing.conversationId === null || existing.conversationId === undefined) {
          return { entry: { ...existing }, existingSubmission: null };
        }
        const sub = await tx.submissionByRequest(existing.conversationId, requestId);
        if (sub) {
          existing.submitted = true;
          return { entry: { ...existing }, existingSubmission: sub };
        }
        if (captured < (getStopEpoch?.(botId) ?? 0)) {
          existing.status = 'cancelled';
          existing.reason = 'cancelled';
          return { entry: { ...existing }, existingSubmission: null };
        }
        // Conversation created before a prior crash/disconnect prior to submit: refresh safe config.
        await configure(tx, existing.conversationId, agentConfig);
        return { entry: { ...existing }, existingSubmission: null };
      }
      if (captured < (getStopEpoch?.(botId) ?? 0)) {
        const tombstone = {
          botId,
          requestId,
          digest,
          conversationId: null,
          stopEpoch: captured,
          status: 'cancelled',
          reason: 'cancelled',
          submitted: false,
          createdAt: new Date().toISOString(),
        };
        index.byKey[key] = tombstone;
        return { entry: { ...tombstone }, existingSubmission: null };
      }
      const nowIso = new Date().toISOString();
      const convRecord = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await configure(tx, convRecord.id, agentConfig);
      const meta = await tx.doc(McpDispatchMeta, convRecord.id);
      meta.botId = bot.botId;
      meta.requestId = requestId;
      meta.toolPolicy = MCP_SAFE_TOOL_POLICY;
      meta.stopEpoch = captured;
      meta.createdAt = nowIso;
      const created = {
        botId: bot.botId,
        requestId,
        digest,
        conversationId: convRecord.id,
        stopEpoch: captured,
        status: 'active',
        reason: null,
        submitted: false,
        createdAt: nowIso,
      };
      index.byKey[key] = created;
      return { entry: { ...created }, existingSubmission: null };
    }, context);

    const { entry, existingSubmission } = committed;
    if (existingSubmission) {
      if (existingSubmission.status === 'queued' || existingSubmission.status === 'placed') {
        ensureObservation();
        trackSubmission(existingSubmission.id, botId, entry.conversationId, requestId, existingSubmission.status);
      }
      return formatSubmission(harness, botId, entry.conversationId, existingSubmission);
    }
    if (entry.status === 'cancelled' || entry.conversationId === null || entry.conversationId === undefined) {
      return cancelledReceipt(botId, requestId, entry.reason ?? 'cancelled');
    }

    // Re-check stop/online gate right before native submit.
    if (captured < (getStopEpoch?.(botId) ?? 0)) {
      const didCancel = await markCancelledIfUnstarted(harness, botId, requestId, 'cancelled');
      if (didCancel) return cancelledReceipt(botId, requestId, 'cancelled');
      const existingSub = await harness.commit(
        (tx) => tx.submissionByRequest(entry.conversationId, requestId),
        context,
      );
      if (existingSub) {
        return formatSubmission(harness, botId, entry.conversationId, existingSub);
      }
      return cancelledReceipt(botId, requestId, 'cancelled');
    }
    if (closed || (typeof canRun === 'function' && !canRun(botId))) return null;

    const conversation = await harness.conversation(entry.conversationId, context);
    if (!conversation) {
      throw errWithCode('isolated MCP dispatch conversation is missing', 'INVALID_STATE');
    }

    let subHandle;
    try {
      subHandle = await conversation.submit({
        type: 'input',
        content: text,
        requestId,
        whenBusy: 'reject',
        entry: { kind: MCP_DISPATCH_INPUT_KIND },
      }, context);
    } catch (err) {
      const recovered = await harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, requestId),
        context,
      );
      if (recovered) {
        if (recovered.status === 'queued' || recovered.status === 'placed') {
          ensureObservation();
          trackSubmission(recovered.id, botId, conversation.id, requestId, recovered.status);
        }
        return formatSubmission(harness, botId, conversation.id, recovered);
      }
      throw err;
    }

    // Record submitted flag so future stopBot scans skip settled entries cleanly.
    await harness.commit(async (tx) => {
      const index = await tx.doc(McpDispatchIndex);
      if (index.byKey[key]) index.byKey[key].submitted = true;
    }, context).catch(() => {});

    // Stop race guard: if a user stop happened while submit was in flight, abort immediately.
    if (captured < (getStopEpoch?.(botId) ?? 0)) {
      await harness.abortSubmission(subHandle.id, context, conversation.id).catch(() => {});
    }

    const statusRecord = await subHandle.status(context);
    if (statusRecord.status === 'queued' || statusRecord.status === 'placed') {
      ensureObservation();
      trackSubmission(statusRecord.id, botId, conversation.id, requestId, statusRecord.status);
    } else {
      dropEnvFor?.(conversation.id)?.catch?.(() => {});
    }
    return formatSubmission(harness, botId, conversation.id, statusRecord);
  }

  async function cancelIfUnstarted(botId, requestId, reason = 'cancelled') {
    if (closed) return false;
    assertNonBlank(botId, 'botId');
    assertNonBlank(requestId, 'requestId');
    return markCancelledIfUnstarted(getHarness(), botId, requestId, reason);
  }

  async function stopBot(botId, throughStopEpoch, { offline = false } = {}) {
    const harness = getHarness();
    if (!harness) return;
    const index = await harness.snapshot(McpDispatchIndex, context);
    const byConv = new Map();
    const unstartedKeys = [];
    for (const [key, entry] of Object.entries(index?.byKey ?? {})) {
      if (entry?.botId !== botId || entry.status !== 'active') continue;
      if (throughStopEpoch !== null && throughStopEpoch !== undefined && (entry.stopEpoch ?? 0) > throughStopEpoch) {
        continue;
      }
      if (entry.conversationId !== null && entry.conversationId !== undefined) {
        byConv.set(entry.conversationId, entry);
      }
      if (!entry.submitted) {
        unstartedKeys.push(key);
      }
    }
    if (unstartedKeys.length > 0) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(McpDispatchIndex);
        for (const key of unstartedKeys) {
          const entry = doc.byKey[key];
          if (!entry || entry.status !== 'active') continue;
          if (entry.conversationId !== null && entry.conversationId !== undefined) {
            const sub = await tx.submissionByRequest(entry.conversationId, entry.requestId);
            if (sub) {
              entry.submitted = true;
              continue;
            }
          }
          entry.status = 'cancelled';
          entry.reason = 'cancelled';
        }
      }, context);
    }
    if (byConv.size === 0) return;

    const inspection = await harness.inspect(context);
    const activeConvIds = new Set();
    for (const submission of inspection.submissions) {
      if (byConv.has(submission.conversationId)) activeConvIds.add(submission.conversationId);
    }
    for (const task of inspection.tasks) {
      if (byConv.has(task.record.conversationId)) activeConvIds.add(task.record.conversationId);
    }
    if (activeConvIds.size === 0) return;

    if (offline) {
      for (const submission of inspection.submissions) {
        if (activeConvIds.has(submission.conversationId)) {
          await harness.abortSubmission(submission.id, context, submission.conversationId).catch(() => {});
        }
      }
      for (const task of inspection.tasks) {
        if (activeConvIds.has(task.record.conversationId)) {
          await harness.abortTask(task.record.id, context).catch(() => {});
        }
      }
      return;
    }

    for (const convId of activeConvIds) {
      const conversation = await harness.conversation(convId, context);
      if (conversation) {
        await conversation.abort(context);
      }
    }
  }

  async function abortAll() {
    const harness = getHarness();
    if (!harness) return;
    const inspection = await harness.inspect(context);
    if (inspection.scheduling === 'paused') return;
    const index = await harness.snapshot(McpDispatchIndex, context);
    const known = new Set();
    for (const entry of Object.values(index?.byKey ?? {})) {
      if (entry?.conversationId !== null && entry?.conversationId !== undefined) {
        known.add(entry.conversationId);
      }
    }
    if (known.size === 0) return;
    const activeConvIds = new Set();
    for (const submission of inspection.submissions) {
      if (known.has(submission.conversationId)) activeConvIds.add(submission.conversationId);
    }
    for (const task of inspection.tasks) {
      if (known.has(task.record.conversationId)) activeConvIds.add(task.record.conversationId);
    }
    for (const convId of activeConvIds) {
      const conversation = await harness.conversation(convId, context);
      if (conversation) {
        await conversation.abort(context, { background: true });
      }
    }
  }

  async function hasActiveForBot(botId) {
    const harness = getHarness();
    if (!harness) return false;
    const index = await harness.snapshot(McpDispatchIndex, context);
    const known = new Set();
    for (const entry of Object.values(index?.byKey ?? {})) {
      if (entry?.botId === botId && entry.conversationId !== null && entry.conversationId !== undefined) {
        known.add(entry.conversationId);
      }
    }
    if (known.size === 0) return false;
    const inspection = await harness.inspect(context);
    return (
      inspection.submissions.some((submission) => known.has(submission.conversationId)) ||
      inspection.tasks.some((task) => known.has(task.record.conversationId))
    );
  }

  async function resumeTracking() {
    if (closed) return;
    const harness = getHarness();
    if (!harness) return;
    ensureObservation();
    const index = await harness.snapshot(McpDispatchIndex, context);
    const byConv = new Map();
    for (const entry of Object.values(index?.byKey ?? {})) {
      if (entry?.status === 'active' && entry.conversationId !== null && entry.conversationId !== undefined) {
        byConv.set(entry.conversationId, entry);
      }
    }
    if (byConv.size === 0) return;
    const inspection = await harness.inspect(context);
    for (const submission of inspection.submissions) {
      const entry = byConv.get(submission.conversationId);
      if (!entry) continue;
      if (!tracked.has(submission.id)) {
        tracked.set(submission.id, {
          botId: entry.botId,
          conversationId: entry.conversationId,
          requestId: entry.requestId,
          lastStatus: submission.status ?? 'queued',
        });
      }
    }
    if (tracked.size > 0) scheduleCheck();
  }

  async function cleanupBot(botId) {
    const harness = getHarness();
    if (!harness) return;
    const index = await harness.snapshot(McpDispatchIndex, context);
    const convIds = [];
    const keys = [];
    for (const [key, entry] of Object.entries(index?.byKey ?? {})) {
      if (entry?.botId !== botId) continue;
      keys.push(key);
      if (entry.conversationId !== null && entry.conversationId !== undefined) {
        convIds.push(entry.conversationId);
      }
    }
    for (const [submissionId, info] of [...tracked.entries()]) {
      if (info.botId === botId) tracked.delete(submissionId);
    }
    if (keys.length > 0) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(McpDispatchIndex);
        for (const key of keys) delete doc.byKey[key];
      }, context).catch(() => {});
    }
    for (const convId of convIds) {
      await dropEnvFor?.(convId)?.catch?.(() => {});
    }
  }

  async function close() {
    closed = true;
    try { commitObservation?.detach(); } catch { /* ignore */ }
    commitObservation = null;
    tracked.clear();
    if (checkPromise) {
      try { await checkPromise; } catch { /* ignore */ }
    }
  }

  return {
    getSubmission,
    submit,
    cancelIfUnstarted,
    stopBot,
    abortAll,
    hasActiveForBot,
    resumeTracking,
    cleanupBot,
    close,
  };
}
