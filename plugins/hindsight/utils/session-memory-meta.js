import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { stableSessionId } from "./session.js";
export function sessionMetaPath(cwd, sessionFile) {
    return join(cwd, ".pi", "hindsight", "session-meta", `${stableSessionId(sessionFile, cwd)}.json`);
}
function nowIso() {
    return new Date().toISOString();
}
export function defaultSessionMemoryMeta() {
    const now = nowIso();
    return {
        retained: true,
        recallMode: "normal",
        retainMode: "normal",
        nextRetainMode: "normal",
        mode: "normal",
        tags: [],
        createdAt: now,
        updatedAt: now,
    };
}
export function failClosedSessionMemoryMeta() {
    const now = nowIso();
    return {
        retained: false,
        recallMode: "off",
        retainMode: "off",
        nextRetainMode: "normal",
        mode: "ignored",
        tags: [],
        createdAt: now,
        updatedAt: now,
    };
}
function isMode(value) {
    return value === "normal" || value === "read-only" || value === "ignored";
}
function isSwitch(value) {
    return value === "normal" || value === "off";
}
function cleanTag(tag) {
    return tag.trim();
}
function hasControlCharacter(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127)
            return true;
    }
    return false;
}
export function normalizeSessionTags(tags) {
    if (!Array.isArray(tags))
        return [];
    return [
        ...new Set(tags
            .filter((tag) => typeof tag === "string")
            .filter((tag) => !hasControlCharacter(tag))
            .map(cleanTag)
            .filter((tag) => tag.length > 0 && tag.length <= 80)),
    ];
}
function isSessionMemoryMetaRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    return (typeof record.retained === "boolean" &&
        isSwitch(record.recallMode) &&
        isSwitch(record.retainMode) &&
        (record.nextRetainMode === undefined || isSwitch(record.nextRetainMode)) &&
        isMode(record.mode) &&
        Array.isArray(record.tags) &&
        typeof record.createdAt === "string" &&
        typeof record.updatedAt === "string");
}
export function normalizeSessionMemoryMeta(value) {
    if (!isSessionMemoryMetaRecord(value))
        return failClosedSessionMemoryMeta();
    return {
        retained: value.retained,
        recallMode: value.recallMode,
        retainMode: value.retainMode,
        nextRetainMode: value.nextRetainMode ?? "normal",
        mode: value.mode,
        tags: normalizeSessionTags(value.tags),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}
export async function readSessionMemoryMeta(cwd, sessionFile) {
    try {
        return normalizeSessionMemoryMeta(JSON.parse(await readFile(sessionMetaPath(cwd, sessionFile), "utf8")));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return defaultSessionMemoryMeta();
        return failClosedSessionMemoryMeta();
    }
}
export async function writeSessionMemoryMeta(cwd, sessionFile, meta) {
    const next = { ...meta, tags: normalizeSessionTags(meta.tags), updatedAt: nowIso() };
    const path = sessionMetaPath(cwd, sessionFile);
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
    return next;
}
export function getEffectiveSessionMemoryMode(meta) {
    if (meta.mode === "ignored")
        return { recall: false, retain: false, mode: meta.mode, tags: meta.tags };
    if (meta.mode === "read-only")
        return { recall: meta.recallMode !== "off", retain: false, mode: meta.mode, tags: meta.tags };
    return {
        recall: meta.recallMode !== "off",
        retain: meta.retainMode !== "off" && meta.retained,
        mode: meta.mode,
        tags: meta.tags,
    };
}
export async function setSessionMemoryMode(cwd, sessionFile, mode) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    const updates = { mode };
    if (mode === "normal" || mode === "read-only")
        updates.recallMode = "normal";
    const looksFailClosed = meta.mode === "ignored" &&
        meta.recallMode === "off" &&
        meta.retainMode === "off" &&
        !meta.retained;
    if (mode === "normal" && looksFailClosed) {
        updates.retained = true;
        updates.retainMode = "normal";
    }
    return writeSessionMemoryMeta(cwd, sessionFile, { ...meta, ...updates });
}
export async function setSessionRetainEnabled(cwd, sessionFile, enabled) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    return writeSessionMemoryMeta(cwd, sessionFile, {
        ...meta,
        retained: enabled,
        retainMode: enabled ? "normal" : "off",
    });
}
export async function setNextSessionRetainMode(cwd, sessionFile, nextRetainMode) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    return writeSessionMemoryMeta(cwd, sessionFile, { ...meta, nextRetainMode });
}
export async function clearNextSessionRetainMode(cwd, sessionFile) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    if (meta.nextRetainMode === "normal")
        return meta;
    return writeSessionMemoryMeta(cwd, sessionFile, {
        ...meta,
        nextRetainMode: "normal",
    });
}
export async function addSessionMemoryTag(cwd, sessionFile, tag) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    return writeSessionMemoryMeta(cwd, sessionFile, { ...meta, tags: [...meta.tags, tag] });
}
export async function removeSessionMemoryTag(cwd, sessionFile, tag) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    return writeSessionMemoryMeta(cwd, sessionFile, {
        ...meta,
        tags: meta.tags.filter((existing) => existing !== cleanTag(tag)),
    });
}
