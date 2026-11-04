const PATCH_MARKER = Symbol("@luxusai/pi-hindsight.fetch-request-compat");
function isRequest(value) {
    return typeof Request !== "undefined" && value instanceof Request;
}
function requestToInit(request) {
    return {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: request.redirect,
        credentials: request.credentials,
        cache: request.cache,
        mode: request.mode,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        keepalive: request.keepalive,
        ...(request.body ? { duplex: "half" } : {}),
    };
}
export function installFetchRequestCompat() {
    const currentFetch = globalThis.fetch;
    if (!currentFetch || currentFetch[PATCH_MARKER])
        return;
    const originalFetch = currentFetch.bind(globalThis);
    const patchedFetch = ((input, init) => {
        if (!isRequest(input))
            return originalFetch(input, init);
        return originalFetch(input.url, { ...requestToInit(input), ...init });
    });
    patchedFetch[PATCH_MARKER] = true;
    globalThis.fetch = patchedFetch;
}
