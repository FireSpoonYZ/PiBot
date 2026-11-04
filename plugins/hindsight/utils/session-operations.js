import { addSessionMemoryTag, getEffectiveSessionMemoryMode, readSessionMemoryMeta, removeSessionMemoryTag, setNextSessionRetainMode, setSessionMemoryMode, setSessionRetainEnabled, } from "./session-memory-meta.js";
export async function readMemorySession(cwd, sessionFile) {
    const meta = await readSessionMemoryMeta(cwd, sessionFile);
    return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
export async function setMemorySessionMode(cwd, sessionFile, mode) {
    const meta = await setSessionMemoryMode(cwd, sessionFile, mode);
    return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
export async function setMemorySessionRetain(cwd, sessionFile, enabled) {
    const meta = await setSessionRetainEnabled(cwd, sessionFile, enabled);
    return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
export async function setNextMemoryRetainOff(cwd, sessionFile) {
    const meta = await setNextSessionRetainMode(cwd, sessionFile, "off");
    return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
export async function addMemorySessionTag(cwd, sessionFile, tag) {
    const meta = await addSessionMemoryTag(cwd, sessionFile, tag);
    return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
export async function removeMemorySessionTag(cwd, sessionFile, tag) {
    const meta = await removeSessionMemoryTag(cwd, sessionFile, tag);
    return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
