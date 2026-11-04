import { KNOWLEDGE_PAGE_MAX_TOKENS, KNOWLEDGE_PAGE_SEEDS, KNOWLEDGE_PAGE_TRIGGER, } from "./retain-strategies.js";
export const KNOWLEDGE_PAGES_UNAVAILABLE = "knowledge_pages_unavailable";
export class KnowledgePagesUnavailableError extends Error {
    code = KNOWLEDGE_PAGES_UNAVAILABLE;
    constructor(message = "Hindsight server does not support knowledge pages") {
        super(message);
        this.name = "KnowledgePagesUnavailableError";
    }
}
function isNotFoundOrUnavailable(error) {
    if (error instanceof KnowledgePagesUnavailableError)
        return true;
    if (typeof error !== "object" || !error)
        return false;
    const fields = error;
    const status = fields.status ?? fields.statusCode;
    if (status === 404 || status === 405 || status === 501)
        return true;
    if (fields.code === KNOWLEDGE_PAGES_UNAVAILABLE)
        return true;
    const msg = typeof fields.message === "string" ? fields.message : "";
    return /\b404\b|\b405\b|\b501\b|not found|knowledge.?pages?.*(unavail|not support)/i.test(msg);
}
function collectPageNames(tree, out = new Set()) {
    if (!tree)
        return out;
    const nodes = Array.isArray(tree)
        ? tree
        : typeof tree === "object" && tree !== null
            ? (tree.roots ??
                tree.children ??
                [])
            : [];
    for (const node of nodes) {
        if (!node || typeof node !== "object")
            continue;
        const rec = node;
        if (rec.kind === "page" && typeof rec.name === "string")
            out.add(rec.name);
        if (Array.isArray(rec.children))
            collectPageNames(rec.children, out);
    }
    return out;
}
/**
 * Seed the fixed five-page knowledge taxonomy. Idempotent by page name (skips existing).
 * Never throws for capability gaps — returns available:false instead.
 */
export async function seedKnowledgePages(args) {
    const dryRun = args.dryRun ?? false;
    const seeds = args.seeds ?? KNOWLEDGE_PAGE_SEEDS;
    const baseTags = args.baseTags ?? ["source:pi"];
    const empty = {
        bankId: args.bankId,
        dryRun,
        available: false,
        created: [],
        skippedExisting: [],
        errors: [],
    };
    if (!args.client.createKnowledgePage) {
        return { ...empty, reason: "no_create_method" };
    }
    let existing = new Set();
    if (args.client.getKnowledgeBaseTree) {
        try {
            const tree = await args.client.getKnowledgeBaseTree(args.bankId);
            existing = collectPageNames(tree);
        }
        catch (error) {
            if (isNotFoundOrUnavailable(error)) {
                return { ...empty, reason: KNOWLEDGE_PAGES_UNAVAILABLE };
            }
            // Tree probe failed for another reason — still try create (best effort).
        }
    }
    const wouldCreate = [];
    const created = [];
    const skippedExisting = [];
    const errors = [];
    for (const seed of seeds) {
        if (existing.has(seed.name)) {
            skippedExisting.push(seed.name);
            continue;
        }
        const tags = [...new Set([...seed.tags, ...baseTags])];
        wouldCreate.push({ name: seed.name, tags });
        if (dryRun)
            continue;
        try {
            const result = await args.client.createKnowledgePage(args.bankId, seed.name, seed.source_query, {
                tags,
                maxTokens: KNOWLEDGE_PAGE_MAX_TOKENS,
                trigger: {
                    mode: "delta",
                    refreshAfterConsolidation: KNOWLEDGE_PAGE_TRIGGER.refresh_after_consolidation,
                    factTypes: [...KNOWLEDGE_PAGE_TRIGGER.fact_types],
                    excludeMentalModels: true,
                },
            });
            created.push({ name: seed.name, result });
            existing.add(seed.name);
        }
        catch (error) {
            if (isNotFoundOrUnavailable(error)) {
                return {
                    bankId: args.bankId,
                    dryRun,
                    available: false,
                    reason: KNOWLEDGE_PAGES_UNAVAILABLE,
                    wouldCreate,
                    created,
                    skippedExisting,
                    errors,
                };
            }
            errors.push({
                name: seed.name,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return {
        bankId: args.bankId,
        dryRun,
        available: true,
        ...(dryRun ? { wouldCreate } : {}),
        created,
        skippedExisting,
        errors,
    };
}
