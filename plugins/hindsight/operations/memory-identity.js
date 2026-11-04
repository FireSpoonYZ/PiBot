import { baseTags, deriveProjectBankId, recallScopeTags, resolveProjectIdentity, } from "../banks/banking.js";
import { importDocumentId, liveDocumentId, stableSessionId } from "../utils/session.js";
export function uniqueTags(tags) {
    return [...new Set(tags.filter(Boolean))];
}
export function mergeBaseAndExtraTags(base, extra) {
    return uniqueTags([...base, ...(extra ?? [])]);
}
export function createMemoryIdentity(cwd, config, sessionFile) {
    const sessionId = stableSessionId(sessionFile, cwd);
    const project = resolveProjectIdentity(cwd, config);
    return {
        cwd,
        ...(sessionFile ? { sessionFile } : {}),
        projectId: project.projectId,
        projectIdBasis: project.basis,
        projectIdSource: project.source,
        repoKey: project.legacyRepoKey,
        sessionId,
        projectBankId: deriveProjectBankId(cwd, config),
        liveDocumentId: liveDocumentId(sessionFile, cwd),
        baseTags: baseTags(cwd, sessionId, config),
        projectRecallTags: recallScopeTags(cwd, config),
        globalRecallTags: uniqueTags(config.scope.userScopeTags),
    };
}
export function explicitRetainTags(cwd, sessionFile, extraTags, config) {
    return mergeBaseAndExtraTags(baseTags(cwd, stableSessionId(sessionFile, cwd), config), extraTags);
}
export { importDocumentId, liveDocumentId, stableSessionId };
