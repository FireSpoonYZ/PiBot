import { createHash } from "node:crypto";
import { emitRetrieval, telemetryEvent, telemetryFailure, retrievalId, } from "./retrieval-telemetry.js";
import { isAbortError } from "../client/timeout.js";
import { recallForContext } from "./recall.js";
import { redactError } from "../utils/sanitize.js";
import { writeLastRecallSnapshot } from "./recall-visibility.js";
import { selectMemoryScopes } from "../operations/memory-scope.js";
import { getEffectiveSessionMemoryMode, readSessionMemoryMeta, } from "../utils/session-memory-meta.js";
export function lastUserMessageContentIdentity(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "user")
            continue;
        const content = message.content;
        return typeof content === "string" ? content : JSON.stringify(content ?? "");
    }
    return "";
}
/** Bank IDs + last-user content; transcript length is not part of the key (auto-continue retries). */
export function recallTurnCacheKey(bankIds, messages) {
    return `${bankIds.join(",")}|${lastUserMessageContentIdentity(messages)}`;
}
export function createRecallCache(ttlMs = 60000) {
    const cache = new Map();
    const ttl = () => (typeof ttlMs === "function" ? ttlMs() : ttlMs);
    return {
        get(key) {
            const cached = cache.get(key);
            if (!cached)
                return undefined;
            if (Date.now() - cached.timestamp > ttl()) {
                cache.delete(key);
                return undefined;
            }
            return cached.entry;
        },
        set(key, entry) {
            cache.set(key, { entry, timestamp: Date.now() });
        },
    };
}
function canAppendRecallMessage(event) {
    const last = event.messages[event.messages.length - 1];
    const lastRole = last?.role;
    return Boolean(last && lastRole === "user");
}
function buildRecallNotification(memoryCount, bankIds, failed) {
    if (memoryCount > 0) {
        return `Hindsight recalled ${memoryCount} memory item${memoryCount === 1 ? "" : "s"} from ${bankIds.join(", ")}${failed > 0 ? `; ${failed} bank${failed === 1 ? "" : "s"} failed` : ""}`;
    }
    if (failed > 0)
        return `Hindsight recall failed for ${failed} bank${failed === 1 ? "" : "s"}`;
    return "Hindsight recalled no matching memory";
}
function patchWithRecallMessage(event, recallMessage) {
    const last = event.messages[event.messages.length - 1];
    const lastRole = last?.role;
    if (last && lastRole === "user") {
        return { messages: [...event.messages.slice(0, -1), recallMessage, last] };
    }
    return undefined;
}
export function createRecallTurnPolicy(deps) {
    const cache = createRecallCache(() => deps.getConfig().recall.cacheTtlMs);
    const origins = new WeakMap();
    return {
        async recall(event, runtime) {
            const started = Date.now();
            const contextId = deps.observer ? retrievalId() : undefined;
            const retrievals = [];
            let cacheStatus = "none";
            const observe = (item) => {
                retrievals.push(structuredClone(item));
                emitRetrieval(deps.observer, () => item);
            };
            const injection = (status, rendered = "", extra = {}) => {
                emitRetrieval(deps.observer, () => telemetryEvent(started, {
                    phase: "injection",
                    mode: "automatic",
                    cache: cacheStatus,
                    status,
                    contextId,
                    injected: Boolean(rendered),
                    retrievalIds: retrievals.flatMap((e) => (e.retrievalId ? [e.retrievalId] : [])),
                    injectedIds: rendered ? retrievals.flatMap((e) => e.injectedIds ?? []) : [],
                    injectedCount: rendered
                        ? retrievals.reduce((n, e) => n + (e.injectedCount ?? 0), 0)
                        : 0,
                    renderedHash: createHash("sha256").update(rendered).digest("hex"),
                    renderedLength: rendered.length,
                    ...extra,
                }));
            };
            const skip = (reason) => {
                injection("skipped", "", { reason });
                return undefined;
            };
            const config = deps.getConfig();
            if (!config.enabled || !config.recall.enabled)
                return skip("disabled");
            const sessionMemory = getEffectiveSessionMemoryMode(await readSessionMemoryMeta(runtime.cwd, runtime.sessionFile));
            if (!sessionMemory.recall)
                return skip("session-disabled");
            const scopes = selectMemoryScopes(runtime.cwd, config);
            if (scopes.length === 0)
                return skip("no-scopes");
            if (config.recall.injectionPosition === "append" && !canAppendRecallMessage(event)) {
                return skip("append-requires-user");
            }
            const cacheKey = recallTurnCacheKey(scopes.map((s) => s.bankId), event.messages);
            let recallResult = cache.get(cacheKey);
            cacheStatus = recallResult ? "hit" : "miss";
            try {
                if (runtime.signal?.aborted) {
                    deps.setMemoryStatus(runtime, "idle");
                    return skip("aborted");
                }
                if (recallResult && deps.observer) {
                    for (const origin of origins.get(recallResult) ?? []) {
                        emitRetrieval(observe, () => telemetryEvent(started, {
                            ...origin,
                            phase: "retrieval",
                            mode: "automatic",
                            status: origin.status,
                            cache: "hit",
                            contextId,
                            retrievalId: retrievalId(),
                            cacheOriginId: origin.retrievalId,
                            startedAt: new Date(started).toISOString(),
                            endedAt: new Date().toISOString(),
                            durationMs: Date.now() - started,
                        }));
                    }
                }
                if (!recallResult) {
                    deps.setMemoryStatus(runtime, "recalling");
                    const fetched = await recallForContext({
                        client: deps.getClient(),
                        config,
                        scopes,
                        messages: event.messages,
                        cwd: runtime.cwd,
                        ...(deps.observer ? { observer: observe, contextId } : {}),
                        ...(runtime.signal ? { signal: runtime.signal } : {}),
                    });
                    if (runtime.signal?.aborted) {
                        deps.setMemoryStatus(runtime, "idle");
                        return skip("aborted");
                    }
                    recallResult = { ...fetched, timestamp: Date.now() };
                    if (deps.observer)
                        origins.set(recallResult, retrievals.slice());
                    cache.set(cacheKey, recallResult);
                }
                if (runtime.signal?.aborted) {
                    deps.setMemoryStatus(runtime, "idle");
                    return skip("aborted");
                }
                const { rendered, blocks, failed, failures, timestamp } = recallResult;
                const memoryCount = blocks.reduce((count, block) => count + block.memoryCount, 0);
                deps.setMemoryStatus(runtime, memoryCount > 0 ? "recalled" : failed > 0 ? "recall-failed" : "recall-empty", memoryCount);
                if (config.notifications.recall) {
                    deps.notify(runtime, buildRecallNotification(memoryCount, blocks.map((block) => block.bankId), failed), failed > 0 && memoryCount === 0 ? "warning" : "info");
                }
                if (config.recall.storeLastRecall &&
                    (rendered || failed === 0 || config.recall.storeLastRecallFailures)) {
                    try {
                        await writeLastRecallSnapshot(runtime.cwd, config.recall.lastRecallPath, {
                            query: blocks[0]?.query ?? failures[0]?.query ?? "",
                            rendered,
                            blocks,
                            failed,
                            ...(failures.length ? { failures } : {}),
                        }, runtime.signal);
                    }
                    catch (error) {
                        if (isAbortError(error) || runtime.signal?.aborted)
                            throw error;
                        deps.notify(runtime, `Hindsight last recall snapshot write failed: ${redactError(error)}`, "warning");
                    }
                }
                if (runtime.signal?.aborted) {
                    deps.setMemoryStatus(runtime, "idle");
                    return skip("aborted");
                }
                if (!rendered) {
                    injection(failed
                        ? retrievals.some((e) => e.status === "timeout")
                            ? "timeout"
                            : "error"
                        : "empty");
                    return undefined;
                }
                const recallMessage = {
                    role: "user",
                    content: rendered,
                    timestamp,
                };
                const patch = config.recall.injectionPosition === "append"
                    ? patchWithRecallMessage(event, recallMessage)
                    : { messages: [recallMessage, ...event.messages] };
                injection(patch ? "success" : "skipped", patch ? rendered : "", { failedScopes: failed });
                return patch;
            }
            catch (error) {
                if (isAbortError(error) || runtime.signal?.aborted) {
                    deps.setMemoryStatus(runtime, "idle");
                    return skip("aborted");
                }
                injection("error", "", telemetryFailure(error));
                deps.setMemoryStatus(runtime, "recall-failed");
                // Recall runs every turn, so this stays debug-gated behind the same opt-in flags that
                // already gate the last-recall sidecar, instead of notifying (which would spam normal
                // usage). Users who enabled storeLastRecall + storeLastRecallFailures can inspect the
                // redacted cause via the opt-in last-recall sidecar under .pi/hindsight/.
                if (config.recall.storeLastRecall && config.recall.storeLastRecallFailures) {
                    try {
                        await writeLastRecallSnapshot(runtime.cwd, config.recall.lastRecallPath, {
                            query: "",
                            rendered: "",
                            blocks: [],
                            failed: 1,
                            failures: [
                                {
                                    bankId: "pre-scope-failure",
                                    query: "",
                                    error: `Unexpected recall failure: ${redactError(error)}`,
                                },
                            ],
                        });
                    }
                    catch {
                        // Best-effort debug snapshot; do not let a write failure mask the original recall failure.
                    }
                }
                return undefined;
            }
        },
    };
}
