import { emitRetrieval, telemetryEvent, telemetryFailure, retrievalId, resultTelemetry, } from "../lifecycle/retrieval-telemetry.js";
import { textFromRecallResponse } from "../lifecycle/recall.js";
import { composeScopedTagFilter, scopeTagsForBank } from "./memory-scope.js";
import { resolveOperationBank } from "../banks/bank-selection.js";
import { readLastRecallSnapshot, resolveLastRecallPath } from "../lifecycle/recall-visibility.js";
import { pruneTranscriptRecallBlocks, scanTranscriptForRecallBlocks, } from "../lifecycle/recall-cleanup.js";
import { getEffectiveSessionMemoryMode, readSessionMemoryMeta, } from "../utils/session-memory-meta.js";
export function createRecallOperations(deps) {
    return {
        async recall(cwd, query, bank, sessionFile, filters = {}) {
            const started = Date.now();
            const id = deps.observer ? retrievalId() : undefined;
            let resolved = {};
            const emit = (fields) => emitRetrieval(deps.observer, () => telemetryEvent(started, {
                phase: "retrieval",
                mode: "explicit",
                cache: "none",
                status: "success",
                retrievalId: id,
                query,
                ...resolved,
                ...fields,
            }));
            let skipped = false;
            try {
                const meta = await readSessionMemoryMeta(cwd, sessionFile);
                if (!getEffectiveSessionMemoryMode(meta).recall) {
                    skipped = true;
                    throw new Error("Hindsight recall is disabled for this session");
                }
                const config = deps.getConfig();
                const bankId = resolveOperationBank({
                    requestedBank: bank,
                    config,
                    projectBankId: deps.getProjectBankId(),
                });
                const scopeTags = scopeTagsForBank(cwd, config, bankId);
                const includeShared = filters.includeSharedObservations ?? config.scope.includeSharedObservations;
                resolved = { bankId };
                const options = {
                    budget: filters.budget ?? config.recall.budget,
                    maxTokens: filters.maxTokens ?? config.recall.maxTokens,
                    ...(filters.queryTimestamp || config.recall.queryTimestamp
                        ? { queryTimestamp: filters.queryTimestamp ?? config.recall.queryTimestamp }
                        : {}),
                    ...(filters.types ? { types: filters.types } : {}),
                    preferObservations: config.recall.preferObservations,
                    ...(filters.preferObservations !== undefined
                        ? { preferObservations: filters.preferObservations }
                        : {}),
                    ...(filters.minScores !== undefined ? { minScores: filters.minScores } : {}),
                    ...(filters.trace !== undefined ? { trace: filters.trace } : {}),
                    ...(filters.includeEntities !== undefined
                        ? { includeEntities: filters.includeEntities }
                        : {}),
                    ...(filters.maxEntityTokens !== undefined
                        ? { maxEntityTokens: filters.maxEntityTokens }
                        : {}),
                    ...(filters.includeChunks !== undefined ? { includeChunks: filters.includeChunks } : {}),
                    ...(filters.maxChunkTokens !== undefined
                        ? { maxChunkTokens: filters.maxChunkTokens }
                        : {}),
                    ...(filters.includeSourceFacts !== undefined
                        ? { includeSourceFacts: filters.includeSourceFacts }
                        : {}),
                    ...(filters.maxSourceFactsTokens !== undefined
                        ? { maxSourceFactsTokens: filters.maxSourceFactsTokens }
                        : {}),
                    ...composeScopedTagFilter(scopeTags, {
                        ...filters,
                        includeSharedObservations: includeShared,
                    }),
                    ...(filters.signal ? { signal: filters.signal } : {}),
                };
                const { signal: _signal, ...telemetryFilters } = options;
                resolved = {
                    bankId,
                    filters: telemetryFilters,
                    ...("tagGroups" in options ? { tagGroups: options.tagGroups } : {}),
                };
                const result = await deps.getClient().recall(bankId, query, options);
                emitRetrieval(deps.observer, () => {
                    const items = textFromRecallResponse(result);
                    return telemetryEvent(started, {
                        phase: "retrieval",
                        mode: "explicit",
                        cache: "none",
                        retrievalId: id,
                        query,
                        ...resolved,
                        ...resultTelemetry(items),
                        status: items.length ? "success" : "empty",
                    });
                });
                return { bankId, result };
            }
            catch (error) {
                emit({ ...telemetryFailure(error), ...(skipped ? { status: "skipped" } : {}) });
                throw error;
            }
        },
        async reflect(cwd, query, context, bank, responseSchema, filters = {}) {
            const config = deps.getConfig();
            const bankId = resolveOperationBank({
                requestedBank: bank,
                config,
                projectBankId: deps.getProjectBankId(),
            });
            const scopeTags = scopeTagsForBank(cwd, config, bankId);
            const includeShared = filters.includeSharedObservations ?? config.scope.includeSharedObservations;
            const result = await deps.getClient().reflect(bankId, query, {
                ...(context ? { context } : {}),
                budget: filters.budget ?? config.recall.budget,
                ...(filters.maxTokens !== undefined ? { maxTokens: filters.maxTokens } : {}),
                ...(responseSchema ? { responseSchema } : {}),
                ...(filters.includeFacts !== undefined ? { includeFacts: filters.includeFacts } : {}),
                ...(filters.includeToolCalls !== undefined
                    ? { includeToolCalls: filters.includeToolCalls }
                    : {}),
                ...(filters.includeToolCallOutput !== undefined
                    ? { includeToolCallOutput: filters.includeToolCallOutput }
                    : {}),
                ...(filters.factTypes ? { factTypes: filters.factTypes } : {}),
                ...(filters.excludeMentalModels !== undefined
                    ? { excludeMentalModels: filters.excludeMentalModels }
                    : {}),
                ...(filters.excludeMentalModelIds
                    ? { excludeMentalModelIds: filters.excludeMentalModelIds }
                    : {}),
                ...composeScopedTagFilter(scopeTags, {
                    ...filters,
                    includeSharedObservations: includeShared,
                }),
                ...(filters.signal ? { signal: filters.signal } : {}),
            });
            return { bankId, result };
        },
        async lastRecall(cwd) {
            const config = deps.getConfig();
            const path = resolveLastRecallPath(cwd, config.recall.lastRecallPath);
            const snapshot = await readLastRecallSnapshot(cwd, config.recall.lastRecallPath);
            return { path, snapshot };
        },
        async recallCleanup(sessionFile, prune) {
            return prune
                ? pruneTranscriptRecallBlocks(sessionFile)
                : scanTranscriptForRecallBlocks(sessionFile);
        },
    };
}
