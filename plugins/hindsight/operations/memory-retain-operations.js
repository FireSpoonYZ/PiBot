import { flushRetain } from "../queue/queue.js";
import { resolveOperationBank } from "../banks/bank-selection.js";
import { explicitMemoryDocumentId } from "../utils/session.js";
import { createMemoryIdentity, explicitRetainTags } from "./memory-identity.js";
import { expandObservationScopes } from "../lifecycle/observation-scopes.js";
import { retainDurably } from "../lifecycle/retain.js";
import { appendRetainReceipt, listRetainReceipts } from "../lifecycle/retain-receipts.js";
import { getEffectiveSessionMemoryMode, readSessionMemoryMeta, } from "../utils/session-memory-meta.js";
const RESERVED_EXPLICIT_RETAIN_METADATA_KEYS = new Set([
    "cwd",
    "pi_session_file",
    "source",
    "retainSource",
]);
function callerMetadata(metadata) {
    if (!metadata)
        return undefined;
    const entries = Object.entries(metadata).filter(([key]) => !RESERVED_EXPLICIT_RETAIN_METADATA_KEYS.has(key));
    return entries.length ? Object.fromEntries(entries) : undefined;
}
export function createRetainOperations(deps) {
    return {
        async retainExplicit(args) {
            const meta = await readSessionMemoryMeta(args.cwd, args.sessionFile);
            if (!getEffectiveSessionMemoryMode(meta).retain)
                throw new Error("Hindsight retain is disabled for this session");
            const config = deps.getConfig();
            const bankId = resolveOperationBank({
                requestedBank: args.bank,
                config,
                projectBankId: deps.getProjectBankId(),
            });
            const tags = explicitRetainTags(args.cwd, args.sessionFile, [
                ...(args.tags ?? []),
                ...meta.tags,
            ]);
            const identity = createMemoryIdentity(args.cwd, config, args.sessionFile);
            const defaultObservationScopes = config.observations.enabled
                ? expandObservationScopes(config.observations.scopes, {
                    ...identity,
                    projectBankId: bankId,
                })
                : [];
            const observationScopes = args.observationScopes ?? defaultObservationScopes;
            const result = await retainDurably({
                cwd: args.cwd,
                config,
                client: deps.getClient(),
                bankId,
                content: args.content,
                context: args.context,
                tags,
                updateMode: args.updateMode ?? "replace",
                documentId: args.documentId ??
                    explicitMemoryDocumentId({
                        cwd: args.cwd,
                        ...(args.sessionFile ? { sessionFile: args.sessionFile } : {}),
                        bankId,
                        content: args.content,
                        context: args.context,
                    }),
                metadata: {
                    ...callerMetadata(args.metadata),
                    cwd: args.cwd,
                    ...(args.sessionFile ? { pi_session_file: args.sessionFile } : {}),
                },
                ...(args.timestamp ? { timestamp: args.timestamp } : {}),
                source: "tool",
                ...(hasObservationScopes(observationScopes) ? { observationScopes } : {}),
                ...(args.documentTags?.length ? { documentTags: args.documentTags } : {}),
                ...(args.entities?.length ? { entities: args.entities } : {}),
                ...(args.async !== undefined ? { async: args.async } : {}),
            });
            const response = { ...result, tags, queued: result.enqueued };
            await appendRetainReceipt(args.cwd, {
                bankId: result.bankId,
                documentId: result.documentId,
                queueJobId: result.queueJobId,
                updateMode: result.updateMode,
                source: "tool",
                context: args.context,
                tags,
                ...(result.outcome ? { outcome: result.outcome } : {}),
            }, { redactSecrets: config.retain.redactSecrets });
            return response;
        },
        async listRetainReceipts(cwd, limit) {
            return listRetainReceipts(cwd, limit);
        },
        async flush(cwd) {
            return flushRetain(cwd, deps.getConfig(), deps.getClient());
        },
    };
}
function hasObservationScopes(scopes) {
    return typeof scopes === "string" ? scopes.length > 0 : scopes.length > 0;
}
