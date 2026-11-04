function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return value;
    }
    return undefined;
}
function parentSessionInfo(value) {
    if (typeof value === "string" && value.trim())
        return { file: value };
    if (!isRecord(value))
        return {};
    const id = stringField(value, ["id", "sessionId"]);
    const file = stringField(value, ["file", "path", "sessionFile"]);
    return { ...(id ? { id } : {}), ...(file ? { file } : {}) };
}
export function parseImportSessionJsonl(text) {
    const messages = [];
    let cwd;
    let sessionId;
    let parentSessionId;
    let parentSessionFile;
    let sessionTimestamp;
    let malformedLineCount = 0;
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        let entry;
        try {
            const parsed = JSON.parse(line);
            if (!isRecord(parsed)) {
                malformedLineCount += 1;
                continue;
            }
            entry = parsed;
        }
        catch {
            malformedLineCount += 1;
            continue;
        }
        if (entry.type === "session") {
            if (typeof entry.cwd === "string")
                cwd = entry.cwd;
            if (typeof entry.id === "string")
                sessionId = entry.id;
            const parent = parentSessionInfo(entry.parentSession);
            if (parent.id)
                parentSessionId = parent.id;
            if (parent.file)
                parentSessionFile = parent.file;
            if (typeof entry.timestamp === "string")
                sessionTimestamp = entry.timestamp;
        }
        if (entry.type !== "message" || !isRecord(entry.message))
            continue;
        messages.push({
            ...(typeof entry.id === "string" ? { id: entry.id } : {}),
            parentId: entry.parentId ?? null,
            ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
            data: {
                ...entry.message,
                ...(typeof entry.id === "string" ? { id: entry.id } : {}),
                parentId: entry.parentId ?? null,
                ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
            },
        });
    }
    return {
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(parentSessionFile ? { parentSessionFile } : {}),
        ...(sessionTimestamp ? { sessionTimestamp } : {}),
        malformedLineCount,
        messages,
    };
}
export function parsePiSessionJsonl(text) {
    const parsed = parseImportSessionJsonl(text);
    return {
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        malformedLineCount: parsed.malformedLineCount,
        messages: parsed.messages.map((message) => message.data),
    };
}
function fallbackLeafId(messages) {
    const last = messages.at(-1);
    if (last?.id)
        return last.id;
    return "root";
}
export function leafIds(messages) {
    const ids = new Set(messages.map((message) => message.id).filter((id) => typeof id === "string"));
    const parents = new Set(messages
        .map((message) => message.parentId)
        .filter((id) => typeof id === "string"));
    const leaves = [...ids].filter((id) => !parents.has(id));
    return leaves.length ? leaves : [fallbackLeafId(messages)];
}
function messagesForLeaf(messages, leafId) {
    const byId = new Map(messages
        .map((message) => [message.id, message])
        .filter((entry) => typeof entry[0] === "string"));
    const path = [];
    const seen = new Set();
    let current = leafId;
    while (current) {
        if (seen.has(current))
            break;
        seen.add(current);
        const message = byId.get(current);
        if (!message)
            break;
        path.push(message);
        current = message.parentId;
    }
    if (!path.length && messages.length === 1)
        return messages;
    return path.reverse();
}
export function selectImportBranches(parsed, includeBranches) {
    const leaves = leafIds(parsed.messages);
    const selectedLeaves = includeBranches === "all-leaves" ? leaves : [fallbackLeafId(parsed.messages)];
    return selectedLeaves.map((leafId) => ({
        leafId,
        messages: messagesForLeaf(parsed.messages, leafId),
    }));
}
