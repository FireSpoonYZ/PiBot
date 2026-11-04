import { addMemorySessionTag, readMemorySession, removeMemorySessionTag, setMemorySessionMode, setMemorySessionRetain, setNextMemoryRetainOff, } from "../utils/session-operations.js";
export function createSessionOperations() {
    return {
        async session(cwd, sessionFile) {
            return readMemorySession(cwd, sessionFile);
        },
        async setSessionMode(cwd, sessionFile, mode) {
            return setMemorySessionMode(cwd, sessionFile, mode);
        },
        async setSessionRetain(cwd, sessionFile, enabled) {
            return setMemorySessionRetain(cwd, sessionFile, enabled);
        },
        async setNextRetainOff(cwd, sessionFile) {
            return setNextMemoryRetainOff(cwd, sessionFile);
        },
        async addSessionTag(cwd, sessionFile, tag) {
            return addMemorySessionTag(cwd, sessionFile, tag);
        },
        async removeSessionTag(cwd, sessionFile, tag) {
            return removeMemorySessionTag(cwd, sessionFile, tag);
        },
    };
}
