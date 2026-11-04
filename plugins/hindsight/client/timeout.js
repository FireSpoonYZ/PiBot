export function abortError(operation) {
    const error = new Error(`${operation} aborted`);
    error.name = "AbortError";
    return error;
}
export function isAbortError(error) {
    if (!error || typeof error !== "object")
        return false;
    const name = "name" in error ? String(error.name) : "";
    if (name === "AbortError")
        return true;
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return /\baborted\b/i.test(message);
}
export function throwIfAborted(signal, operation) {
    if (signal?.aborted)
        throw abortError(operation);
}
export async function withTimeout(operation, timeoutMs, fn, parentSignal) {
    throwIfAborted(parentSignal, operation);
    const controller = new AbortController();
    let timer;
    let removeAbortListener;
    try {
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
        const abort = parentSignal
            ? new Promise((_resolve, reject) => {
                const onAbort = () => {
                    controller.abort(parentSignal.reason);
                    reject(abortError(operation));
                };
                parentSignal.addEventListener("abort", onAbort, { once: true });
                removeAbortListener = () => parentSignal.removeEventListener("abort", onAbort);
            })
            : undefined;
        return await Promise.race([fn(controller.signal), timeout, ...(abort ? [abort] : [])]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        removeAbortListener?.();
    }
}
