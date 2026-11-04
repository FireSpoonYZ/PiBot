import { projectMessages } from "../utils/messages.js";
import { enqueueRetainFromAgentEnd } from "./retain.js";
import { advanceRetainCursor, filterNewRetainMessages, readSessionRetainState, retainedThroughIndex, } from "./retain-cursor.js";
import { stableSessionId } from "../utils/session.js";
import { clearNextSessionRetainMode, getEffectiveSessionMemoryMode, readSessionMemoryMeta, } from "../utils/session-memory-meta.js";
import { redactError } from "../utils/sanitize.js";
export function createRetainTurnPolicy(deps) {
    const retainedBySession = new Map();
    const sessionRetainState = async (runtime) => {
        const sessionId = stableSessionId(runtime.sessionFile, runtime.cwd);
        const state = retainedBySession.get(sessionId) ?? (await readSessionRetainState(runtime.cwd, sessionId));
        retainedBySession.set(sessionId, state);
        return { sessionId, state };
    };
    const newRetainMessages = async (runtime, messages) => {
        const { state } = await sessionRetainState(runtime);
        return filterNewRetainMessages(messages, state);
    };
    const markRetainedMessages = async (runtime, allMessages, retainedMessages) => {
        const { sessionId } = await sessionRetainState(runtime);
        const batch = retainedMessages ?? allMessages;
        const throughIndex = retainedThroughIndex(allMessages, batch);
        await advanceRetainCursor(runtime.cwd, sessionId, allMessages, throughIndex);
        retainedBySession.set(sessionId, await readSessionRetainState(runtime.cwd, sessionId));
    };
    const retainableMessages = (messages) => projectMessages(messages, deps.getConfig());
    const retainableMessageCount = (messages) => retainableMessages(messages).length;
    const retainTargets = () => {
        const config = deps.getConfig();
        return config.banks.project.enabled ? [deps.getProjectBankId()] : [];
    };
    return {
        async retain(event, runtime) {
            const config = deps.getConfig();
            const canRetainProject = config.banks.project.enabled;
            const canRetainGlobal = config.banks.user.enabled && Boolean(config.banks.user.bankId);
            if (!config.enabled || !config.retain.enabled || (!canRetainProject && !canRetainGlobal))
                return { queued: false, sent: 0, remaining: 0 };
            const sessionMeta = await readSessionMemoryMeta(runtime.cwd, runtime.sessionFile);
            const nextRetainMode = sessionMeta.nextRetainMode;
            const sessionMemory = getEffectiveSessionMemoryMode(sessionMeta);
            if (!sessionMemory.retain || nextRetainMode === "off") {
                try {
                    await markRetainedMessages(runtime, event.messages);
                }
                catch (error) {
                    deps.setMemoryStatus(runtime, "retain-failed");
                    deps.notify(runtime, `Hindsight retain cursor update failed: ${error.message}`, "warning");
                    return { queued: false, sent: 0, remaining: 0 };
                }
                if (nextRetainMode === "off") {
                    await clearNextSessionRetainMode(runtime.cwd, runtime.sessionFile);
                    deps.notify(runtime, "Hindsight skipped retain for this run due to next-opt-out.", "info");
                }
                return { queued: false, sent: 0, remaining: 0 };
            }
            const messages = await newRetainMessages(runtime, event.messages);
            const messageCount = retainableMessageCount(messages);
            if (!messageCount)
                return { queued: false, sent: 0, remaining: 0 };
            try {
                deps.setMemoryStatus(runtime, "retaining");
                const targets = retainTargets();
                if (targets.length === 0) {
                    await markRetainedMessages(runtime, event.messages, messages);
                    deps.setMemoryStatus(runtime, "retained", 0);
                    if (config.notifications.retain) {
                        deps.notify(runtime, `Hindsight skipped ${messageCount} new message${messageCount === 1 ? "" : "s"}; no automatic-retain bank enabled`, "info");
                    }
                    return { queued: false, sent: 0, remaining: 0 };
                }
                let sent = 0;
                let remaining = 0;
                let queued = false;
                let reflectError;
                for (const bankId of targets) {
                    const result = await enqueueRetainFromAgentEnd({
                        event: { ...event, messages },
                        cwd: runtime.cwd,
                        ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
                        config,
                        client: deps.getClient(),
                        bankId,
                        extraTags: sessionMemory.tags,
                    });
                    queued ||= result.queued;
                    sent += result.sent;
                    remaining = result.remaining;
                    reflectError ??= result.reflectError;
                }
                if (queued)
                    await markRetainedMessages(runtime, event.messages, messages);
                deps.setMemoryStatus(runtime, remaining > 0 ? "retain-queued" : "retained", remaining);
                if (config.notifications.retain) {
                    deps.notify(runtime, `Hindsight retained ${messageCount} new message${messageCount === 1 ? "" : "s"} to ${targets.join(", ")}${remaining > 0 ? `; ${remaining} queued` : ""}`, "info");
                }
                // Post-retain reflect is opt-in (retain.postRetainReflect, off by default); users who
                // enable it have opted into this extra visibility, so surface failures like other
                // opt-in feature failures in this file do, without requiring notifications.retain.
                if (reflectError) {
                    deps.notify(runtime, `Hindsight post-retain reflect failed: ${reflectError}`, "warning");
                }
                return { queued, sent, remaining };
            }
            catch (error) {
                deps.setMemoryStatus(runtime, "retain-failed");
                deps.notify(runtime, `Hindsight retain queue failed: ${redactError(error)}`, "warning");
                return { queued: false, sent: 0, remaining: 0 };
            }
        },
    };
}
