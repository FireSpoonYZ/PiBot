import { getSessionFile } from "../utils/session.js";
import { formatHindsightStatus } from "../utils/status.js";
export function snapshotRuntime(ctx) {
    try {
        const cwd = ctx.cwd;
        const ui = ctx.ui;
        const sessionFile = getSessionFile(ctx);
        const signal = ctx.signal;
        return {
            cwd,
            ui,
            ...(sessionFile ? { sessionFile } : {}),
            ...(signal ? { signal } : {}),
        };
    }
    catch {
        return undefined;
    }
}
export function setMemoryStatus(args) {
    try {
        args.runtime.ui.setStatus("hindsight", formatHindsightStatus(args.config, {
            projectBankId: args.projectBankId,
            cwd: args.runtime.cwd,
            activity: args.activity,
            ...(args.memoryCount !== undefined ? { memoryCount: args.memoryCount } : {}),
            ...(args.queueRemaining !== undefined ? { queueRemaining: args.queueRemaining } : {}),
        }));
    }
    catch {
        // Session ctx can go stale during replacement/reload; status is best effort.
    }
}
export function notify(runtime, message, level) {
    try {
        runtime.ui.notify(message, level);
    }
    catch {
        // Session ctx can go stale during replacement/reload; notifications are best effort.
    }
}
