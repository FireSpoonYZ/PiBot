import { importMemoryChatTranscript, importMemoryProjectSessions, importMemorySession, } from "../imports/import-sessions.js";
import { importMemoryMultiRootProjectSessions } from "../imports/import-multi-root.js";
import { createBankTemplateOperations } from "./memory-bank-template-operations.js";
import { createConfigOperations } from "./memory-config-operations.js";
import { createControlOperations } from "./memory-control-operations.js";
import { createDiagnosticsOperations } from "./memory-diagnostics-operations.js";
import { createQueueOperations } from "../queue/queue-operations.js";
import { createRecallOperations } from "./memory-recall-operations.js";
import { createRetainOperations } from "./memory-retain-operations.js";
import { createSessionOperations } from "./memory-session-operations.js";
function createImportOperations(deps) {
    return {
        async importSession(args) {
            return importMemorySession(args, deps);
        },
        async importChatTranscript(args) {
            return importMemoryChatTranscript(args, deps);
        },
        async importProjectSessions(args) {
            return importMemoryProjectSessions(args, deps);
        },
        async importMultiRootProjectSessions(args) {
            return importMemoryMultiRootProjectSessions(args, deps);
        },
    };
}
export function createMemoryOperations(deps) {
    return {
        ...createRecallOperations(deps),
        ...createRetainOperations(deps),
        ...createConfigOperations(deps),
        ...createImportOperations(deps),
        ...createQueueOperations(deps),
        ...createSessionOperations(),
        ...createDiagnosticsOperations(deps),
        ...createBankTemplateOperations(deps),
        ...createControlOperations(deps),
    };
}
