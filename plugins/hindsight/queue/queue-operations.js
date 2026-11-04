import { resolveQueuePath, summarizeRetainQueue, readRetainQueueTolerant, readDeadLetterQueueTolerant, } from "./queue.js";
import { redactError } from "../utils/sanitize.js";
import { listRetainReceipts } from "../lifecycle/retain-receipts.js";
const RECENT_OUTCOME_LIMIT = 5;
function redactJob(job) {
    return {
        id: job.id,
        bankId: job.bankId,
        documentId: job.documentId,
        updateMode: job.updateMode,
        retries: job.retries,
        lastError: job.lastError ? redactError(job.lastError) : undefined,
        deadLetteredAt: job.deadLetteredAt,
        tags: job.item.tags,
        metadataKeys: job.item.metadata ? Object.keys(job.item.metadata).sort() : undefined,
        contentBytes: Buffer.byteLength(job.item.content, "utf8"),
        contextBytes: Buffer.byteLength(job.item.context, "utf8"),
    };
}
export function createQueueOperations(deps) {
    return {
        async inspectRetainQueue(args) {
            const config = deps.getConfig();
            const queuePath = resolveQueuePath(args.cwd, config.retain.queuePath);
            const summary = await summarizeRetainQueue(queuePath);
            const activeJobs = args.includeJobs
                ? await readRetainQueueTolerant(queuePath)
                    .then((parsed) => parsed.jobs)
                    .catch(() => [])
                : [];
            const deadLetterJobs = args.includeJobs
                ? await readDeadLetterQueueTolerant(queuePath)
                    .then((parsed) => parsed.jobs)
                    .catch(() => [])
                : [];
            const recentOutcomes = (await listRetainReceipts(args.cwd, RECENT_OUTCOME_LIMIT)).map((receipt) => ({
                documentId: receipt.documentId,
                bankId: receipt.bankId,
                source: receipt.source,
                createdAt: receipt.createdAt,
                ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
            }));
            return {
                queuePath,
                deadLetterPath: `${queuePath}.dead.jsonl`,
                active: summary.active,
                deadLetter: summary.deadLetter,
                recentOutcomes,
                jobs: args.includeJobs
                    ? {
                        active: activeJobs.map(redactJob),
                        deadLetter: deadLetterJobs.map(redactJob),
                    }
                    : undefined,
            };
        },
    };
}
