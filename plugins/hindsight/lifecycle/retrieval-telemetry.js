import { randomUUID } from "node:crypto";
import { redactError, redactSecrets } from "../utils/sanitize.js";
function sanitizeTelemetry(event) {
    const next = { ...event };
    if (typeof next.query === "string")
        next.query = redactSecrets(next.query);
    if (Array.isArray(next.results)) {
        next.results = next.results.map((item) => {
            const { text: _text, ...rest } = item;
            return rest;
        });
    }
    return next;
}
// Never await exporters, expose mutable recall data, or allow observer failures
// (including rejected promises and payload projection failures) into memory policy.
export function emitRetrieval(observer, build) {
    if (!observer)
        return;
    try {
        const pending = observer(sanitizeTelemetry(structuredClone(build())));
        if (pending)
            void Promise.resolve(pending).catch(() => { });
    }
    catch {
        /* telemetry is best effort */
    }
}
export function telemetryEvent(start, fields) {
    const end = Date.now();
    return {
        version: 1,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(end).toISOString(),
        durationMs: end - start,
        ...fields,
    };
}
export const retrievalId = () => randomUUID();
export function telemetryFailure(error) {
    const message = redactError(error);
    return {
        error: message,
        status: /hindsight recall timed out after \d+ms/.test(message) ? "timeout" : "error",
    };
}
export function resultTelemetry(items) {
    return {
        rawCount: items.length,
        rawIds: resultIds(items),
        results: items.flatMap((item) => {
            const row = {
                ...(typeof item.id === "string" ? { id: item.id } : {}),
                ...(Array.isArray(item.tags) ? { tags: item.tags } : {}),
            };
            return Object.keys(row).length ? [row] : [];
        }),
    };
}
export function resultIds(items) {
    return items.flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
}
