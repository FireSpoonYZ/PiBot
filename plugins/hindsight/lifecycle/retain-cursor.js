import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export const RETAIN_CURSOR_VERSION = 3;
export const RETAIN_CURSOR_TAIL_WINDOW = 200;
export function retainCursorPath(cwd) {
    return join(cwd, ".pi", "hindsight", "retain-cursors.json");
}
export function messageFingerprint(message) {
    const m = message;
    const stable = {
        id: m.id,
        role: m.role,
        timestamp: m.timestamp,
        content: m.content,
        toolName: m.toolName,
        isError: m.isError,
        model: m.model,
        stopReason: m.stopReason,
    };
    return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
function messageId(message) {
    const id = message.id;
    if (typeof id === "string")
        return id;
    if (typeof id === "number")
        return String(id);
    return "";
}
export function chainHash(fingerprints, throughIndex) {
    let hash = "";
    for (let i = 0; i <= throughIndex; i++) {
        const fingerprint = fingerprints[i];
        if (fingerprint === undefined)
            break;
        hash = createHash("sha256")
            .update(hash + fingerprint)
            .digest("hex");
    }
    return hash;
}
export function idChainHash(messages, throughIndex) {
    let hash = "";
    for (let i = 0; i <= throughIndex; i++) {
        const message = messages[i];
        if (!message)
            break;
        hash = createHash("sha256")
            .update(hash + messageId(message))
            .digest("hex");
    }
    return hash;
}
function buildCursor(messages, throughIndex) {
    const tailStart = Math.max(0, throughIndex - RETAIN_CURSOR_TAIL_WINDOW + 1);
    const tailMessages = messages.slice(tailStart, throughIndex + 1);
    const prefixFingerprints = messages.slice(0, throughIndex + 1).map(messageFingerprint);
    return {
        index: throughIndex,
        chainHash: chainHash(prefixFingerprints, throughIndex),
        idChainHash: idChainHash(messages, throughIndex),
        tailStart,
        messageIds: tailMessages.map(messageId),
        fingerprints: tailMessages.map(messageFingerprint),
    };
}
function migrateCursorToV3(cursor) {
    const tailStart = Math.max(0, cursor.index - RETAIN_CURSOR_TAIL_WINDOW + 1);
    return {
        index: cursor.index,
        chainHash: cursor.chainHash,
        idChainHash: cursor.idChainHash,
        tailStart,
        messageIds: cursor.messageIds.slice(tailStart),
        fingerprints: cursor.fingerprints.slice(tailStart),
    };
}
function isLegacySessionEntry(value) {
    return (!!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Array.isArray(value.legacyFingerprints));
}
function isSessionRetainCursorV2(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const cursor = value;
    return (typeof cursor.index === "number" &&
        typeof cursor.chainHash === "string" &&
        typeof cursor.idChainHash === "string" &&
        Array.isArray(cursor.messageIds) &&
        Array.isArray(cursor.fingerprints) &&
        !("tailStart" in cursor));
}
function isSessionRetainCursor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const cursor = value;
    return (typeof cursor.index === "number" &&
        typeof cursor.chainHash === "string" &&
        typeof cursor.idChainHash === "string" &&
        typeof cursor.tailStart === "number" &&
        Array.isArray(cursor.messageIds) &&
        Array.isArray(cursor.fingerprints));
}
function normalizeLegacyFingerprints(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
function readLegacyStore(parsed) {
    const sessions = {};
    for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
        const fingerprints = normalizeLegacyFingerprints(value);
        if (fingerprints.length > 0)
            sessions[key] = { legacyFingerprints: fingerprints };
    }
    return sessions;
}
async function readRetainCursorStore(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { version: RETAIN_CURSOR_VERSION, sessions: {} };
        }
        const version = parsed.version;
        const sessions = parsed.sessions;
        if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
            return { version: RETAIN_CURSOR_VERSION, sessions: {} };
        }
        if (version === RETAIN_CURSOR_VERSION) {
            const normalized = {};
            for (const [key, value] of Object.entries(sessions)) {
                if (isSessionRetainCursor(value))
                    normalized[key] = value;
                else if (isLegacySessionEntry(value))
                    normalized[key] = value;
            }
            return { version: RETAIN_CURSOR_VERSION, sessions: normalized };
        }
        if (version === 2) {
            const normalized = {};
            for (const [key, value] of Object.entries(sessions)) {
                if (isSessionRetainCursorV2(value))
                    normalized[key] = migrateCursorToV3(value);
                else if (isLegacySessionEntry(value))
                    normalized[key] = value;
            }
            return { version: RETAIN_CURSOR_VERSION, sessions: normalized };
        }
        return {
            version: RETAIN_CURSOR_VERSION,
            sessions: readLegacyStore(parsed),
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { version: RETAIN_CURSOR_VERSION, sessions: {} };
        }
        throw error;
    }
}
async function writeRetainCursorStore(path, store) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tmp, path);
}
export async function readSessionRetainState(cwd, sessionId) {
    const store = await readRetainCursorStore(retainCursorPath(cwd));
    const entry = store.sessions[sessionId];
    if (!entry)
        return undefined;
    if (isLegacySessionEntry(entry)) {
        return { legacyFingerprints: new Set(entry.legacyFingerprints) };
    }
    return { cursor: entry };
}
function legacyRetainStart(messages, legacy) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message)
            continue;
        if (legacy.has(messageFingerprint(message)))
            return i + 1;
    }
    return 0;
}
function prefixChainMatches(messages, cursor) {
    const fingerprints = [];
    for (let i = 0; i <= cursor.index; i++) {
        const message = messages[i];
        if (!message)
            return false;
        fingerprints.push(messageFingerprint(message));
    }
    return chainHash(fingerprints, cursor.index) === cursor.chainHash;
}
function filterWithCursor(messages, cursor) {
    if (messages.length === 0)
        return [];
    if (cursor.index < messages.length && prefixChainMatches(messages, cursor)) {
        return messages.slice(cursor.index + 1);
    }
    const retained = [];
    let branched = false;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (!message)
            continue;
        if (i > cursor.index) {
            retained.push(message);
            continue;
        }
        if (i < cursor.tailStart) {
            if (branched)
                retained.push(message);
            continue;
        }
        const offset = i - cursor.tailStart;
        const idMatches = messageId(message) === cursor.messageIds[offset];
        const fingerprintMatches = messageFingerprint(message) === cursor.fingerprints[offset];
        if (!idMatches) {
            branched = true;
            retained.push(message);
            continue;
        }
        if (branched) {
            retained.push(message);
            continue;
        }
        if (!fingerprintMatches) {
            retained.push(message);
        }
    }
    return retained;
}
export function filterNewRetainMessages(messages, state) {
    if (!state)
        return [...messages];
    if (state.cursor)
        return filterWithCursor(messages, state.cursor);
    if (state.legacyFingerprints?.size) {
        return messages.slice(legacyRetainStart(messages, state.legacyFingerprints));
    }
    return [...messages];
}
export async function advanceRetainCursor(cwd, sessionId, allMessages, retainedThroughIndex) {
    if (retainedThroughIndex < 0 || retainedThroughIndex >= allMessages.length)
        return;
    const path = retainCursorPath(cwd);
    const store = await readRetainCursorStore(path);
    const existing = store.sessions[sessionId];
    const lastIndex = allMessages.length - 1;
    let effectiveIndex = retainedThroughIndex;
    if (isSessionRetainCursor(existing)) {
        effectiveIndex = Math.max(existing.index, retainedThroughIndex);
    }
    effectiveIndex = Math.min(lastIndex, effectiveIndex);
    store.sessions[sessionId] = buildCursor(allMessages, effectiveIndex);
    await writeRetainCursorStore(path, store);
}
export function retainedThroughIndex(allMessages, retainedMessages) {
    if (retainedMessages.length === 0)
        return -1;
    const lastRetained = retainedMessages[retainedMessages.length - 1];
    if (!lastRetained)
        return -1;
    const lastId = messageId(lastRetained);
    const lastFingerprint = messageFingerprint(lastRetained);
    for (let i = 0; i < allMessages.length; i++) {
        const message = allMessages[i];
        if (!message)
            continue;
        if (messageId(message) === lastId && messageFingerprint(message) === lastFingerprint) {
            return i;
        }
    }
    return -1;
}
