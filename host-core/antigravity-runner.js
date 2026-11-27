import { randomUUID } from 'node:crypto';
import { defineDoc, SystemEntry } from '@earendil-works/pi-durable';
import { calculateCost } from '@earendil-works/pi-ai/models';
import { AGY_HISTORY_CHANGED } from '../center-contract/antigravity.js';

const TURN_ROUTING_SECTION = 'host-turn-routing';
const WORK_TRIGGER_KIND = 'host.work-trigger';
const TERMINATE_TOOL_HINT =
  "End this turn now without further tool calls; the user's answer will arrive in the next turn.";

export const AntigravityCursorDoc = defineDoc({
  kind: 'host.antigravity-cursor',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ sessionId: null, dispatchedThrough: null }),
  checkpointWhen: () => true,
});

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toAssistantUsage(model, raw) {
  const usage = zeroUsage();
  if (!isPlainRecord(raw)) return usage;
  if (typeof raw.input === 'number' && Number.isFinite(raw.input) && raw.input >= 0) usage.input = raw.input;
  if (typeof raw.output === 'number' && Number.isFinite(raw.output) && raw.output >= 0) usage.output = raw.output;
  if (typeof raw.cacheRead === 'number' && Number.isFinite(raw.cacheRead) && raw.cacheRead >= 0) usage.cacheRead = raw.cacheRead;
  if (typeof raw.cacheWrite === 'number' && Number.isFinite(raw.cacheWrite) && raw.cacheWrite >= 0) usage.cacheWrite = raw.cacheWrite;
  usage.totalTokens =
    typeof raw.totalTokens === 'number' && Number.isFinite(raw.totalTokens) && raw.totalTokens >= 0
      ? raw.totalTokens
      : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (model?.cost) {
    calculateCost(model, usage);
  }
  return usage;
}

function makeAssistantMessage({
  model,
  thinkingLevel,
  timestamp,
  content = [],
  usage = zeroUsage(),
  stopReason = 'stop',
  errorMessage,
}) {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function formatCodedError(code, message) {
  const cleanMsg = typeof message === 'string' && message.trim() !== '' ? message : 'Antigravity run failed';
  if (typeof code === 'string' && code.trim() !== '') {
    const cleanCode = code.trim();
    return cleanMsg.startsWith(`${cleanCode}:`) ? cleanMsg : `${cleanCode}: ${cleanMsg}`;
  }
  return cleanMsg;
}

function replaySectionsUpTo(entries, maxId) {
  const shown = new Map();
  if (maxId === null || maxId === undefined || !Array.isArray(entries)) return shown;
  for (const entry of entries) {
    if (!entry || entry.kind !== SystemEntry.kind || entry.id > maxId) continue;
    const sections = entry.model?.[0]?.sections;
    if (!isPlainRecord(sections)) continue;
    for (const [key, value] of Object.entries(sections)) {
      if (key === TURN_ROUTING_SECTION) continue;
      if (value === null) shown.delete(key);
      else if (typeof value === 'string') shown.set(key, value);
    }
  }
  return shown;
}

export function collectSectionDiff(entries, prevCutoff, cutoff) {
  const after = replaySectionsUpTo(entries, cutoff);
  if (prevCutoff === null || prevCutoff === undefined) {
    const initialSystemPrompt = after.get('instructions') ?? '';
    const sections = [];
    for (const [key, value] of after.entries()) {
      if (key === 'instructions') continue;
      sections.push({ key, value });
    }
    return { initialSystemPrompt, sections };
  }
  const before = replaySectionsUpTo(entries, prevCutoff);
  const sections = [];
  for (const [key, value] of after.entries()) {
    if (before.get(key) !== value) {
      sections.push({ key, value });
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) {
      sections.push({ key, value: null });
    }
  }
  return { initialSystemPrompt: undefined, sections };
}

function deriveInputSource(entry) {
  const data = entry?.data;
  if (!isPlainRecord(data)) return undefined;
  const attr = data.attribution;
  if (isPlainRecord(attr)) {
    if (attr.kind === 'host' && typeof attr.sourceType === 'string' && attr.sourceType.trim() !== '') {
      return attr.sourceType.trim();
    }
    if (attr.channel === 'dm' || attr.channel === 'room') {
      return attr.channel;
    }
  }
  if (data.scopeKind === 'dm' || data.scopeKind === 'room') {
    return data.scopeKind;
  }
  return undefined;
}

function extractUserMessageInput(message, source) {
  const raw = message?.content;
  let text = '';
  const images = [];
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    const textParts = [];
    for (const part of raw) {
      if (!isPlainRecord(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (
        part.type === 'image' &&
        typeof part.data === 'string' &&
        part.data.length > 0 &&
        typeof part.mimeType === 'string' &&
        part.mimeType.trim() !== ''
      ) {
        images.push({ data: part.data, mimeType: part.mimeType });
      }
    }
    text = textParts.join('\n');
  }
  return {
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

function extractInputsFromEntries(entries, contributions, minExclusive, maxInclusive) {
  const inputs = [];
  if (!Array.isArray(entries)) return inputs;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.id <= minExclusive || entry.id > maxInclusive) continue;
    const msgs = Array.isArray(contributions?.[i]) ? contributions[i] : (entry.model ?? []);
    const source = deriveInputSource(entry);
    for (const msg of msgs) {
      if (msg?.role !== 'user') continue;
      inputs.push(extractUserMessageInput(msg, source));
    }
  }
  return inputs;
}

function extractRouteNote(messages) {
  if (!Array.isArray(messages)) return undefined;
  let routeNote;
  for (const msg of messages) {
    if (msg?.role !== 'system') continue;
    const value = msg.sections?.[TURN_ROUTING_SECTION];
    if (typeof value === 'string' && value.trim() !== '') {
      routeNote = value;
    }
  }
  return routeNote;
}

function extractToolResultContent(rawContent) {
  if (typeof rawContent === 'string') {
    return rawContent.length > 0 ? [{ type: 'text', text: rawContent }] : [];
  }
  if (!Array.isArray(rawContent)) return [];
  const parts = [];
  for (const part of rawContent) {
    if (!isPlainRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (
      part.type === 'image' &&
      typeof part.data === 'string' &&
      part.data.length > 0 &&
      typeof part.mimeType === 'string' &&
      part.mimeType.trim() !== ''
    ) {
      parts.push({ type: 'image', data: part.data, mimeType: part.mimeType });
    }
  }
  return parts;
}

function isSteerRejectedState(err) {
  return err?.statusCode === 409 || err?.code === 'INVALID_STATE';
}

export function createAntigravityRunner({ antigravityClient }) {
  return async function runExternalTurn({
    runtime,
    context,
    model,
    thinkingLevel,
    cutoff,
    attempt,
    view,
    messages,
    options,
    helpers,
  }) {
    const conversationId = runtime.conversationId;
    const failWithError = async (errorMessage, stopReason = 'error', content = []) => {
      await helpers.classify(makeAssistantMessage({
        model,
        thinkingLevel,
        timestamp: runtime.now(),
        content,
        usage: zeroUsage(),
        stopReason,
        errorMessage,
      }));
    };

    // 1. Validate client and providerSessionId.
    if (typeof antigravityClient?.run !== 'function') {
      await failWithError('Antigravity center client is unavailable');
      return;
    }
    const providerSessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
    if (!providerSessionId) {
      await failWithError('Antigravity session requires a non-empty options.sessionId');
      return;
    }

    // 2. Check cursor and guard legacy AGY bindings that lack the new cursor.
    const cursor = await runtime.snapshot(AntigravityCursorDoc, conversationId, context);
    const sameSession = cursor?.sessionId === providerSessionId;
    if (!sameSession) {
      const hasLegacyHistory = (view?.entries ?? []).some(
        (entry) =>
          Array.isArray(entry?.model) &&
          entry.model.some((msg) => msg?.role === 'assistant' || msg?.role === 'toolResult'),
      );
      if (hasLegacyHistory) {
        await failWithError(`${AGY_HISTORY_CHANGED}: Legacy Antigravity session requires /clear before continuing.`);
        return;
      }
    }
    const prevCutoff = sameSession ? cursor.dispatchedThrough : null;

    // 3. Extract new user inputs in (prevCutoff, cutoff].
    const inputs = extractInputsFromEntries(
      view?.entries,
      view?.contributions,
      prevCutoff ?? -1,
      cutoff,
    );
    if (inputs.length === 0) {
      await failWithError('No new user input to send to Antigravity.');
      return;
    }

    // 4. Extract transient host-turn-routing note injected by beforeRequest.
    const routeNote = extractRouteNote(messages);

    // 5. Collect section diff (or initial system prompt + sections on first turn).
    const { initialSystemPrompt, sections } = collectSectionDiff(view?.entries, prevCutoff, cutoff);

    // 6. Build tool declarations and offered tool set.
    const tools = helpers.getCurrentTools(view?.messages ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters,
    }));
    const offeredToolNames = new Set(tools.map((t) => t.name));

    // 7. Durably advance cursor BEFORE dispatching /run.
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(AntigravityCursorDoc, conversationId);
      doc.sessionId = providerSessionId;
      doc.dispatchedThrough = cutoff;
      return undefined;
    }, context);

    // 8. Create runId, abort controller, and bind runtime.signal cancellation.
    const runId = randomUUID();
    const runAbort = new AbortController();
    let streamDone = false;
    let terminatedState = null;
    let latestUsage = null;
    const nativeToolArgs = new Map();
    const inFlightTools = new Set();
    const activeToolTaskIds = new Set();
    const unacceptedSteers = [];

    const onRuntimeAbort = () => {
      if (runAbort.signal.aborted) return;
      runAbort.abort();
      if (!streamDone && typeof antigravityClient.cancel === 'function') {
        void Promise.resolve(antigravityClient.cancel({ sessionId: providerSessionId, runId })).catch(() => {});
      }
    };
    if (runtime.signal.aborted) {
      onRuntimeAbort();
      runtime.signal.throwIfAborted();
    }
    runtime.signal.addEventListener('abort', onRuntimeAbort, { once: true });

    // 9. Streaming partial projection (PartialChanges + PROGRESS_COMMIT).
    const partialIntervalMs = runtime.settings.progress.partialIntervalMs;
    const newSegmentPartial = () => makeAssistantMessage({
      model,
      thinkingLevel,
      timestamp: runtime.now(),
      content: [],
      usage: zeroUsage(),
      stopReason: 'stop',
    });
    let partial = newSegmentPartial();
    let changes = new helpers.PartialChanges();
    let pendingPartial;
    let partialTimer;
    let partialInFlight;
    let partialStopped = false;

    const flushPartial = () => {
      partialTimer = undefined;
      const snapshot = pendingPartial;
      const activeChanges = changes;
      pendingPartial = undefined;
      if (snapshot === undefined || partialStopped || runAbort.signal.aborted) return;
      const message = helpers.copyJson(snapshot, { omitUndefinedProperties: true });
      const taken = activeChanges.take(message);
      partialInFlight = (async () => {
        try {
          await runtime.commit(async (tx) => {
            const live = await tx.doc(helpers.LiveDoc, conversationId);
            live.generation ??= { attempt };
            activeChanges.commit(live.generation, message, taken);
            return undefined;
          }, context, helpers.PROGRESS_COMMIT);
        } catch (error) {
          activeChanges.restore(taken);
          throw error;
        }
      })()
        .catch((error) => {
          if (!runtime.signal.aborted && !runAbort.signal.aborted) {
            runtime.report(error);
          }
        })
        .finally(() => {
          partialInFlight = undefined;
          if (pendingPartial !== undefined && !partialStopped && !runAbort.signal.aborted) {
            partialTimer = runtime.setTimer(flushPartial, partialIntervalMs);
          }
        });
    };

    const schedulePartialFlush = () => {
      if (partialStopped || runAbort.signal.aborted) return;
      pendingPartial = partial;
      if (partialTimer === undefined && partialInFlight === undefined) {
        partialTimer = runtime.setTimer(flushPartial, partialIntervalMs);
      }
    };

    const flushAndStopPartial = async () => {
      partialStopped = true;
      if (partialTimer !== undefined) {
        partialTimer();
        partialTimer = undefined;
      }
      pendingPartial = undefined;
      if (partialInFlight !== undefined) {
        await partialInFlight;
      }
    };

    const resetSegment = () => {
      partial = newSegmentPartial();
      changes = new helpers.PartialChanges();
      pendingPartial = undefined;
      partialStopped = false;
    };

    // Serializes all conversation commits across stream events, steer admission, and slot cleanup.
    let commitQueue = Promise.resolve();
    const enqueueCommit = (fn) => {
      const next = commitQueue.then(fn, fn);
      commitQueue = next.then(() => undefined, () => undefined);
      return next;
    };

    // 10. Real-time steer watcher on InboxDoc.
    let inboxWatch;
    let steerQueue = Promise.resolve();

    const recordUnacceptedSteer = async (placed) => {
      unacceptedSteers.push(placed);
      if (runtime.signal.aborted) return;
      await enqueueCommit(async () => {
        if (runtime.signal.aborted) return;
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(AntigravityCursorDoc, conversationId);
          if (doc.sessionId === providerSessionId && doc.dispatchedThrough === placed.newCutoff) {
            doc.dispatchedThrough = placed.prevCursor;
          }
          return undefined;
        }, context);
      }).catch((err) => {
        if (!runtime.signal.aborted) runtime.report(err);
      });
    };

    const hasEligibleSteer = (inbox) => {
      const items = inbox?.items;
      return (
        Array.isArray(items) &&
        items.length > 0 &&
        !helpers.hasQueuedReset(items) &&
        items.some((item) => item?.mode === 'steer')
      );
    };

    const pumpSteer = (inbox) => {
      if (
        typeof antigravityClient.steer !== 'function' ||
        terminatedState ||
        streamDone ||
        runAbort.signal.aborted ||
        !hasEligibleSteer(inbox)
      ) {
        return;
      }
      steerQueue = steerQueue
        .then(async () => {
          if (terminatedState || streamDone || runAbort.signal.aborted) return;
          const placed = await enqueueCommit(async () => {
            if (terminatedState || streamDone || runAbort.signal.aborted) return null;
            let result = null;
            await runtime.commit(async (tx) => {
              const boundary = await helpers.prepareBoundary(tx, conversationId, runtime.settings);
              if (!hasEligibleSteer(boundary.inbox)) return undefined;
              const live = await tx.doc(helpers.LiveDoc, conversationId);
              if (live.run?.taskId !== runtime.taskId) return undefined;
              const doc = await tx.doc(AntigravityCursorDoc, conversationId);
              const prevCursor = doc.sessionId === providerSessionId ? doc.dispatchedThrough : null;

              let lastPlacedEntryId = null;
              const placedEntries = [];
              const trackingTx = new Proxy(tx, {
                get(target, prop) {
                  if (prop === 'appendEntry') {
                    return async (...args) => {
                      const entry = await target.appendEntry(...args);
                      if (entry?.id !== undefined) {
                        lastPlacedEntryId = entry.id;
                        placedEntries.push(entry);
                      }
                      return entry;
                    };
                  }
                  const value = target[prop];
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });

              const { users, first } = await helpers.applyBoundary(trackingTx, boundary, 'postTools', runtime.now());
              if (users.length === 0) return undefined;

              live.run.inputs.push(...users);
              const newCutoff =
                lastPlacedEntryId !== null
                  ? Math.max(prevCursor ?? 0, lastPlacedEntryId)
                  : prevCursor;
              doc.sessionId = providerSessionId;
              doc.dispatchedThrough = newCutoff;
              result = { users, first, prevCursor, newCutoff, placedEntries };
              return undefined;
            }, context);
            return result;
          });

          if (!placed) return;
          const steerInputs = extractInputsFromEntries(
            placed.placedEntries,
            null,
            -1,
            placed.newCutoff ?? Number.MAX_SAFE_INTEGER,
          );
          if (steerInputs.length === 0) return;

          if (streamDone || terminatedState) {
            await recordUnacceptedSteer(placed);
            return;
          }

          try {
            await antigravityClient.steer(
              { sessionId: providerSessionId, runId, inputs: steerInputs },
              { signal: runAbort.signal },
            );
          } catch (err) {
            if (isSteerRejectedState(err)) {
              await recordUnacceptedSteer(placed);
            } else if (!runAbort.signal.aborted && !runtime.signal.aborted) {
              runtime.report(err);
            }
          }
        })
        .catch((err) => {
          if (!runAbort.signal.aborted && !runtime.signal.aborted) {
            runtime.report(err);
          }
        });
    };

    const stopSteerWatch = async () => {
      const watch = inboxWatch;
      inboxWatch = undefined;
      if (watch) {
        try {
          await watch.stop();
        } catch { /* ignore watch shutdown errors */ }
      }
      await steerQueue;
    };

    const requeueUnacceptedSteerEntries = async (tx) => {
      for (const steer of unacceptedSteers) {
        for (const orig of steer.placedEntries) {
          const userMessages = (orig.model ?? []).filter((msg) => msg?.role === 'user');
          if (userMessages.length === 0) continue;
          await tx.appendEntry(conversationId, {
            kind: WORK_TRIGGER_KIND,
            model: userMessages,
            edits: [{ target: orig.id, action: 'omit' }],
            data: isPlainRecord(orig.data)
              ? { ...orig.data, requeuedSteer: true }
              : { requeuedSteer: true },
          });
        }
      }
    };

    const finishWithUnacceptedSteers = async ({ finalMessage, terminate }) => {
      runtime.signal.throwIfAborted();
      const unacceptedUsers = unacceptedSteers.flatMap((s) => s.users);
      const unacceptedUserSet = new Set(unacceptedUsers);
      const unacceptedFirst = unacceptedSteers.find((s) => s.first !== undefined)?.first;

      if (terminate) {
        await runtime.hooks.each('afterTools', (hook) =>
          hook(terminate.assistantId, terminate.resultEntryIds, runtime, context),
        );
        const added = terminate.controls.flatMap((control) => control?.addTools ?? []);
        const handoff = terminate.controls.findLast((control) => control?.handoff !== undefined)?.handoff;
        await runtime.commit(async (tx) => {
          const boundary = await helpers.prepareBoundary(tx, conversationId, runtime.settings);
          if (added.length > 0) await helpers.addTools(tx, conversationId, added);
          const live = await tx.doc(helpers.LiveDoc, conversationId);
          if (live.run?.taskId === runtime.taskId) {
            live.run.inputs = live.run.inputs.filter((id) => !unacceptedUserSet.has(id));
          }
          if (handoff !== undefined) {
            const resetMsg = { role: 'user', content: handoff, timestamp: runtime.now() };
            const resetEntry = await tx.appendEntry(helpers.ResetEntry, conversationId, {
              head: 'self',
              model: [resetMsg],
            });
            boundary.head = resetEntry.id;
          }
          await requeueUnacceptedSteerEntries(tx);
          const { users: queuedUsers, first: queuedFirst } = await helpers.applyBoundary(
            tx,
            boundary,
            'final',
            runtime.now(),
          );
          helpers.endRun(tx, live, runtime.taskId, { status: 'done', answer: terminate.assistantId });
          const nextUsers = [...unacceptedUsers, ...queuedUsers];
          const nextFirst = unacceptedFirst ?? queuedFirst;
          if (nextUsers.length > 0) {
            await helpers.startRun(tx, conversationId, live, { inputs: nextUsers, first: nextFirst });
          }
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: { entryId: terminate.assistantId } },
          };
        }, context);
        return;
      }

      if (thinkingLevel !== undefined) finalMessage.thinkingLevel = thinkingLevel;
      await runtime.hooks.each('afterResponse', (hook) => hook(finalMessage, runtime, context));
      await runtime.commit(async (tx) => {
        const boundary = await helpers.prepareBoundary(tx, conversationId, runtime.settings);
        const live = await tx.doc(helpers.LiveDoc, conversationId);
        if (live.run?.taskId === runtime.taskId) {
          live.run.inputs = live.run.inputs.filter((id) => !unacceptedUserSet.has(id));
        }
        const entry = await helpers.appendAssistant(tx, conversationId, finalMessage);
        await requeueUnacceptedSteerEntries(tx);
        const { users: queuedUsers, first: queuedFirst } = await helpers.applyBoundary(
          tx,
          boundary,
          'final',
          runtime.now(),
        );
        helpers.endRun(tx, live, runtime.taskId, { status: 'done', answer: entry.id });
        const nextUsers = [...unacceptedUsers, ...queuedUsers];
        const nextFirst = unacceptedFirst ?? queuedFirst;
        if (nextUsers.length > 0) {
          await helpers.startRun(tx, conversationId, live, { inputs: nextUsers, first: nextFirst });
        }
        return { status: 'terminal', outcome: { status: 'completed', result: { entryId: entry.id } } };
      }, context);
    };

    const waitForInFlightTools = async () => {
      while (inFlightTools.size > 0) {
        await Promise.allSettled([...inFlightTools]);
      }
    };

    const abortInFlightTools = async () => {
      if (!runAbort.signal.aborted) runAbort.abort();
      if (typeof runtime.abortOwned === 'function' && !runtime.signal.aborted) {
        await Promise.allSettled(
          [...activeToolTaskIds].map((id) => runtime.abortOwned(id, context)),
        );
      }
      await waitForInFlightTools();
    };

    const trackToolTask = (assistantEntryId, taskId, callId, name) => {
      activeToolTaskIds.add(taskId);
      const tracked = (async () => {
        try {
          const settled = await runtime.waitForTask(taskId, context);
          activeToolTaskIds.delete(taskId);
          const outcome = settled?.state?.outcome;
          let content = [];
          let isError = false;
          let resultEntryId;
          let control;

          if (outcome?.status === 'completed' && outcome.result?.entryId !== undefined) {
            resultEntryId = outcome.result.entryId;
            control = outcome.result.kind !== 'nested' ? outcome.result.control : undefined;
            const entry = await runtime.entry(helpers.ToolResultEntry, resultEntryId, context);
            const message = entry?.model?.[0];
            if (message?.role === 'toolResult') {
              content = extractToolResultContent(message.content);
              isError = message.isError === true;
            }
          } else {
            if (outcome?.result?.entryId !== undefined) {
              resultEntryId = outcome.result.entryId;
              const entry = await runtime.entry(helpers.ToolResultEntry, resultEntryId, context);
              const message = entry?.model?.[0];
              if (message?.role === 'toolResult') {
                content = extractToolResultContent(message.content);
              }
            }
            if (content.length === 0) {
              const errText =
                outcome?.status === 'failed' || outcome?.status === 'faulted'
                  ? (outcome.error?.message || `Tool ${name} failed`)
                  : outcome?.status === 'orphaned'
                    ? `Tool ${name} orphaned: ${outcome.reason}`
                    : outcome?.status === 'aborted'
                      ? `Tool ${name} was aborted`
                      : `Tool ${name} ended without a result`;
              content = [{ type: 'text', text: errText }];
            }
            isError = true;
          }

          const resultEntryIds = resultEntryId !== undefined ? [resultEntryId] : [];
          if (control?.terminate === true) {
            if (control.addTools?.length > 0) {
              for (const toolName of control.addTools) offeredToolNames.add(toolName);
            }
            if (!terminatedState) {
              terminatedState = {
                assistantId: assistantEntryId,
                resultEntryIds: [...resultEntryIds],
                controls: [control],
              };
            } else {
              terminatedState.assistantId = assistantEntryId;
              terminatedState.resultEntryIds.push(...resultEntryIds);
              terminatedState.controls.push(control);
            }
            const hasHint = content.some((part) => part.type === 'text' && part.text.includes(TERMINATE_TOOL_HINT));
            if (!hasHint) {
              content = [...content, { type: 'text', text: TERMINATE_TOOL_HINT }];
            }
          } else if (outcome?.status === 'completed' && !runAbort.signal.aborted && !runtime.signal.aborted) {
            await runtime.hooks.each('afterTools', (hook) =>
              hook(assistantEntryId, resultEntryIds, runtime, context),
            );
            if (control?.addTools?.length > 0) {
              for (const toolName of control.addTools) offeredToolNames.add(toolName);
              await enqueueCommit(async () => {
                if (runtime.signal.aborted) return;
                await runtime.commit(async (tx) => {
                  await helpers.addTools(tx, conversationId, control.addTools);
                  return undefined;
                }, context);
              });
            }
          }

          // Remove completed slot from live.tools to prevent exceeding MAX_TOOLS = 32 on long turns.
          if (!runAbort.signal.aborted && !runtime.signal.aborted) {
            await enqueueCommit(async () => {
              if (runtime.signal.aborted) return;
              await runtime.commit(async (tx) => {
                const live = await tx.doc(helpers.LiveDoc, conversationId);
                if (!Array.isArray(live.tools)) return undefined;
                const idx = live.tools.findIndex((slot) => slot.taskId === taskId || slot.callId === callId);
                if (idx >= 0) live.tools.splice(idx, 1);
                if (live.tools.length === 0) delete live.tools;
                return undefined;
              }, context, helpers.PROGRESS_COMMIT);
            }).catch(() => {});
          }

          if (
            !runAbort.signal.aborted &&
            !runtime.signal.aborted &&
            typeof antigravityClient.toolResult === 'function'
          ) {
            await antigravityClient.toolResult(
              { sessionId: providerSessionId, runId, callId, content, isError },
              { signal: runAbort.signal },
            );
          }
        } catch (err) {
          if (!runAbort.signal.aborted && !runtime.signal.aborted && !streamDone) {
            runtime.report(err);
          }
        } finally {
          activeToolTaskIds.delete(taskId);
          inFlightTools.delete(tracked);
        }
      })();
      inFlightTools.add(tracked);
    };

    // 11. Consume the Center NDJSON run stream.
    try {
      if (typeof antigravityClient.steer === 'function' && typeof runtime.watchDoc === 'function') {
        inboxWatch = await runtime.watchDoc(helpers.InboxDoc, conversationId, context);
        if (inboxWatch) {
          inboxWatch.start(async (call) => {
            if (call.kind === 'value') pumpSteer(call.value);
          });
          pumpSteer(inboxWatch.value);
        }
      }

      const runPayload = {
        sessionId: providerSessionId,
        runId,
        modelId: model.id,
        ...(model.reasoning && typeof (options?.reasoning ?? thinkingLevel) === 'string'
          ? { reasoning: options?.reasoning ?? thinkingLevel }
          : {}),
        ...(initialSystemPrompt !== undefined ? { initialSystemPrompt } : {}),
        tools,
        ...(sections.length > 0 ? { sections } : {}),
        ...(routeNote !== undefined ? { routeNote } : {}),
        inputs,
      };

      const stream = antigravityClient.run(runPayload, { signal: runAbort.signal });
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new Error('Antigravity center run stream is unavailable');
      }

      let sawTerminal = false;
      for await (const event of stream) {
        if (!event || typeof event !== 'object') continue;
        switch (event.type) {
          case 'thought_delta': {
            if (terminatedState || typeof event.delta !== 'string' || event.delta.length === 0) break;
            const last = partial.content.at(-1);
            let contentIndex;
            if (last?.type === 'thinking') {
              last.thinking += event.delta;
              contentIndex = partial.content.length - 1;
            } else {
              partial.content.push({ type: 'thinking', thinking: event.delta });
              contentIndex = partial.content.length - 1;
            }
            changes.observe({ type: 'thinking_delta', contentIndex, delta: event.delta });
            schedulePartialFlush();
            break;
          }
          case 'text_delta': {
            if (terminatedState || typeof event.delta !== 'string' || event.delta.length === 0) break;
            const last = partial.content.at(-1);
            let contentIndex;
            if (last?.type === 'text') {
              last.text += event.delta;
              contentIndex = partial.content.length - 1;
            } else {
              partial.content.push({ type: 'text', text: event.delta });
              contentIndex = partial.content.length - 1;
            }
            changes.observe({ type: 'text_delta', contentIndex, delta: event.delta });
            schedulePartialFlush();
            break;
          }
          case 'usage': {
            if (isPlainRecord(event.usage)) {
              latestUsage = { ...(latestUsage ?? {}), ...event.usage };
            }
            break;
          }
          case 'native_tool_start': {
            const rawId = String(event.toolCallId ?? '');
            const slotCallId = `agy-native:${rawId}`;
            const toolName = typeof event.name === 'string' && event.name ? event.name : 'tool';
            const args = isPlainRecord(event.args) ? event.args : {};
            nativeToolArgs.set(rawId, args);
            if (terminatedState || runAbort.signal.aborted) break;
            await enqueueCommit(async () => {
              if (terminatedState || runtime.signal.aborted) return;
              await runtime.commit(async (tx) => {
                const live = await tx.doc(helpers.LiveDoc, conversationId);
                live.tools ??= [];
                if (!live.tools.some((slot) => slot.callId === slotCallId)) {
                  live.tools.push({ callId: slotCallId, name: toolName, status: 'running' });
                }
                return undefined;
              }, context, helpers.PROGRESS_COMMIT);
            });
            break;
          }
          case 'native_tool_end': {
            const rawId = String(event.toolCallId ?? '');
            const slotCallId = `agy-native:${rawId}`;
            const toolName = typeof event.name === 'string' && event.name ? event.name : 'tool';
            const args = isPlainRecord(event.args) ? event.args : (nativeToolArgs.get(rawId) ?? {});
            nativeToolArgs.delete(rawId);
            await enqueueCommit(async () => {
              if (runtime.signal.aborted) return;
              if (terminatedState) {
                await runtime.commit(async (tx) => {
                  const live = await tx.doc(helpers.LiveDoc, conversationId);
                  if (!Array.isArray(live.tools)) return undefined;
                  const idx = live.tools.findIndex((slot) => slot.callId === slotCallId);
                  if (idx >= 0) live.tools.splice(idx, 1);
                  if (live.tools.length === 0) delete live.tools;
                  return undefined;
                }, context, helpers.PROGRESS_COMMIT);
                return;
              }
              await flushAndStopPartial();
              const call = {
                type: 'toolCall',
                id: slotCallId,
                name: toolName,
                arguments: helpers.copyJson(args, { omitUndefinedProperties: true }),
              };
              const assistantMsg = makeAssistantMessage({
                model,
                thinkingLevel,
                timestamp: runtime.now(),
                content: [...helpers.copyJson(partial.content, { omitUndefinedProperties: true }), call],
                usage: zeroUsage(),
                stopReason: 'toolUse',
              });
              resetSegment();
              const output =
                typeof event.output === 'string' && event.output.length > 0
                  ? [{ type: 'text', text: event.output }]
                  : [];
              await runtime.commit(async (tx) => {
                const live = await tx.doc(helpers.LiveDoc, conversationId);
                const entry = await helpers.appendAssistant(tx, conversationId, assistantMsg);
                await helpers.appendToolResult(
                  tx,
                  conversationId,
                  call,
                  { output, isError: event.isError === true },
                  { timestamp: runtime.now() },
                );
                delete live.generation;
                if (Array.isArray(live.tools)) {
                  const idx = live.tools.findIndex((slot) => slot.callId === slotCallId);
                  if (idx >= 0) live.tools.splice(idx, 1);
                  if (live.tools.length === 0) delete live.tools;
                }
                if (live.run?.taskId === runtime.taskId) {
                  live.run.first ??= entry.id;
                }
                return undefined;
              }, context);
            });
            break;
          }
          case 'tool_request': {
            const callId = event.callId;
            const name = event.name;
            const args = isPlainRecord(event.args) ? event.args : {};
            if (terminatedState || runAbort.signal.aborted) {
              if (typeof antigravityClient.toolResult === 'function') {
                void Promise.resolve(antigravityClient.toolResult({
                  sessionId: providerSessionId,
                  runId,
                  callId,
                  content: [{ type: 'text', text: 'Turn is ending.' }],
                  isError: true,
                })).catch(() => {});
              }
              break;
            }
            const created = await enqueueCommit(async () => {
              if (terminatedState || runAbort.signal.aborted || runtime.signal.aborted) return null;
              await flushAndStopPartial();
              const call = {
                type: 'toolCall',
                id: callId,
                name,
                arguments: helpers.copyJson(args, { omitUndefinedProperties: true }),
              };
              const assistantMsg = makeAssistantMessage({
                model,
                thinkingLevel,
                timestamp: runtime.now(),
                content: [...helpers.copyJson(partial.content, { omitUndefinedProperties: true }), call],
                usage: zeroUsage(),
                stopReason: 'toolUse',
              });
              resetSegment();
              const unoffered = !offeredToolNames.has(name);
              let assistantEntryId;
              let taskId;
              await runtime.commit(async (tx) => {
                const live = await tx.doc(helpers.LiveDoc, conversationId);
                const entry = await helpers.appendAssistant(tx, conversationId, assistantMsg);
                assistantEntryId = entry.id;
                taskId = await helpers.createExternalToolTask(
                  tx,
                  entry.id,
                  callId,
                  unoffered ? true : undefined,
                );
                delete live.generation;
                live.tools ??= [];
                live.tools.push({
                  callId,
                  name,
                  taskId,
                  status: 'pending',
                  ...(unoffered ? { unoffered: true } : {}),
                });
                if (live.run?.taskId === runtime.taskId) {
                  live.run.turns += 1;
                  live.run.first ??= entry.id;
                }
                return undefined;
              }, context);
              return { assistantEntryId, taskId };
            });
            if (!created) {
              if (typeof antigravityClient.toolResult === 'function') {
                void Promise.resolve(antigravityClient.toolResult({
                  sessionId: providerSessionId,
                  runId,
                  callId,
                  content: [{ type: 'text', text: 'Turn is ending.' }],
                  isError: true,
                })).catch(() => {});
              }
              break;
            }
            trackToolTask(created.assistantEntryId, created.taskId, callId, name);
            break;
          }
          case 'turn_done': {
            sawTerminal = true;
            streamDone = true;
            await stopSteerWatch();
            await waitForInFlightTools();
            await commitQueue;
            await flushAndStopPartial();
            runtime.signal.throwIfAborted();

            if (terminatedState) {
              if (unacceptedSteers.length > 0) {
                await finishWithUnacceptedSteers({ terminate: terminatedState });
              } else {
                await helpers.finishExternalTerminate(
                  terminatedState.assistantId,
                  terminatedState.resultEntryIds,
                  terminatedState.controls,
                );
              }
              return;
            }

            const finalUsage = toAssistantUsage(model, event.usage ?? latestUsage);
            const finalMessage = makeAssistantMessage({
              model,
              thinkingLevel,
              timestamp: runtime.now(),
              content: helpers.copyJson(partial.content, { omitUndefinedProperties: true }),
              usage: finalUsage,
              stopReason: 'stop',
            });
            if (unacceptedSteers.length > 0) {
              await finishWithUnacceptedSteers({ finalMessage });
            } else {
              await helpers.classify(finalMessage);
            }
            return;
          }
          case 'error': {
            sawTerminal = true;
            streamDone = true;
            if (!runAbort.signal.aborted) runAbort.abort();
            await stopSteerWatch();
            await abortInFlightTools();
            await commitQueue;
            await flushAndStopPartial();
            if (runtime.signal.aborted) {
              runtime.signal.throwIfAborted();
            }
            const errMsg = makeAssistantMessage({
              model,
              thinkingLevel,
              timestamp: runtime.now(),
              content: helpers.copyJson(partial.content, { omitUndefinedProperties: true }),
              usage: zeroUsage(),
              stopReason: event.aborted === true ? 'aborted' : 'error',
              errorMessage: formatCodedError(event.code, event.message),
            });
            await helpers.classify(errMsg);
            return;
          }
        }
      }

      if (!sawTerminal) {
        throw new Error('Antigravity run stream ended without a terminal event');
      }
    } catch (err) {
      streamDone = true;
      if (!runAbort.signal.aborted) runAbort.abort();
      await stopSteerWatch().catch(() => {});
      await flushAndStopPartial().catch(() => {});
      if (runtime.signal.aborted) {
        runtime.signal.throwIfAborted();
      }
      await abortInFlightTools().catch(() => {});
      await commitQueue.catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      await failWithError(
        formatCodedError(err?.code, message),
        'error',
        helpers.copyJson(partial.content, { omitUndefinedProperties: true }),
      );
    } finally {
      // 12. Final cleanup.
      streamDone = true;
      await stopSteerWatch().catch(() => {});
      await flushAndStopPartial().catch(() => {});
      runtime.signal.removeEventListener('abort', onRuntimeAbort);
    }
  };
}
