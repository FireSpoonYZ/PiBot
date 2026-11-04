export function formatRetainOutcome(outcome) {
    if (!outcome)
        return "";
    const parts = [];
    if (outcome.itemsCount !== undefined)
        parts.push(`${outcome.itemsCount} items`);
    if (outcome.operations !== undefined)
        parts.push(`${outcome.operations} operations`);
    if (outcome.tokens !== undefined)
        parts.push(`${outcome.tokens} tokens`);
    return parts.join(", ");
}
export function formatFlushRetainQueueResult(result) {
    const base = `Hindsight flushed ${result.sent}; dead-lettered ${result.deadLettered}; remaining ${result.remaining}`;
    const outcome = formatRetainOutcome(result.outcome);
    return outcome ? `${base}; retained ${outcome}` : base;
}
export function flushRetainQueueNotifyLevel(result) {
    return result.remaining || result.deadLettered || result.malformed ? "warning" : "info";
}
