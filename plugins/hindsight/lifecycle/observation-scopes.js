import { createHash } from "node:crypto";
const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;
function cwdHash(cwd) {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}
export function observationScopePlaceholders(identity) {
    return {
        cwdHash: cwdHash(identity.cwd),
        bankId: identity.projectBankId,
        projectBankId: identity.projectBankId,
        projectId: identity.projectId,
        repoKey: identity.repoKey,
        sessionId: identity.sessionId,
    };
}
export function expandObservationScopeValue(value, identity) {
    const placeholders = observationScopePlaceholders(identity);
    return value.replace(PLACEHOLDER_PATTERN, (_match, key) => {
        const replacement = placeholders[key];
        if (!replacement)
            throw new Error(`Unknown observation scope placeholder: {${key}}`);
        return replacement;
    });
}
export function expandObservationScopes(scopes, identity) {
    const expanded = scopes.map((scope) => {
        if (scope.length === 0)
            throw new Error("Observation scope entries must not be empty");
        return scope.map((value) => {
            const expandedValue = expandObservationScopeValue(value, identity).trim();
            if (!expandedValue)
                throw new Error("Observation scope values must not be empty");
            return expandedValue;
        });
    });
    const seen = new Set();
    return expanded.filter((scope) => {
        const key = JSON.stringify(scope);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
