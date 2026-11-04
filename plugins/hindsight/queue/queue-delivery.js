export function redactQueueError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = message
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
        .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
        .replace(/\b(ghp_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_GITHUB_TOKEN]")
        .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)[^\s\n"',}]+/gi, "$1[REDACTED]")
        .replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*:\s*)["']?[^\s\n"',}]+["']?/gi, "$1[REDACTED]")
        .replace(/(["'](?:api[_-]?key|token|secret|password|authorization)["']\s*:\s*)["'][^"']+["']/gi, '$1"[REDACTED]"')
        .replace(/\b((?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
        .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[REDACTED]@");
    return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/([?&])([^=&#\s]+)=([^&#\s]+)/g, (match, separator, key) => {
        if (!/(?:token|key|secret|password|api[_-]?key|apikey)/i.test(String(key))) {
            return String(match);
        }
        return `${String(separator)}${String(key)}=[REDACTED]`;
    }));
}
export function retainOptionsForJob(job) {
    const async = job.item.async;
    return {
        context: job.item.context,
        ...(job.item.timestamp ? { timestamp: job.item.timestamp } : {}),
        ...(job.item.metadata ? { metadata: job.item.metadata } : {}),
        ...(async !== undefined ? { async } : {}),
        // Stable per queue job so async retain retries are idempotent (Hindsight operation_id).
        ...(async === true ? { operationId: job.id } : {}),
        ...(job.item.entities?.length ? { entities: job.item.entities } : {}),
        ...(job.item.tags ? { tags: job.item.tags } : {}),
        ...(job.item.observationScopes ? { observationScopes: job.item.observationScopes } : {}),
        ...(job.item.documentTags ? { documentTags: job.item.documentTags } : {}),
        ...(job.item.strategy ? { strategy: job.item.strategy } : {}),
        documentId: job.documentId,
        updateMode: job.updateMode,
    };
}
export function operationIdsFromResponse(response) {
    if (!response || typeof response !== "object")
        return [];
    const record = response;
    const candidates = [record.operation_id, record.operationId, record.id];
    const operationIds = candidates.filter((candidate) => typeof candidate === "string" && candidate.length > 0);
    const nested = record.operations;
    if (Array.isArray(nested)) {
        for (const item of nested) {
            if (typeof item === "string")
                operationIds.push(item);
            else if (item && typeof item === "object") {
                const id = item.id ?? item.operation_id;
                if (typeof id === "string")
                    operationIds.push(id);
            }
        }
    }
    const operationIdsArray = record.operation_ids ?? record.operationIds;
    if (Array.isArray(operationIdsArray)) {
        for (const item of operationIdsArray) {
            if (typeof item === "string" && item.length > 0)
                operationIds.push(item);
        }
    }
    return [...new Set(operationIds)];
}
function positiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function parseRetainOutcome(response) {
    const operationIds = operationIdsFromResponse(response);
    if (!response || typeof response !== "object")
        return { operationIds };
    const record = response;
    const usage = record.usage && typeof record.usage === "object"
        ? record.usage
        : undefined;
    const itemsCount = positiveNumber(record.items_count ?? record.itemsCount);
    const tokens = usage ? positiveNumber(usage.total_tokens) : undefined;
    return {
        operationIds,
        ...(itemsCount !== undefined ? { itemsCount } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
    };
}
export async function deliverRetainJob(client, job) {
    return client.retain(job.bankId, job.item.content, retainOptionsForJob(job));
}
