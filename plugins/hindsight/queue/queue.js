import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { deliverRetainJob, parseRetainOutcome, redactQueueError } from "./queue-delivery.js";
import { JsonlQueueStore } from "./jsonl-queue-store.js";
import { runRetainBeforeEnqueueCheck } from "./retain-before-enqueue.js";
import { withQueueLock } from "./queue-lock.js";
export { RETAIN_QUEUE_LOCK, isQueueLockOwnerStale } from "./queue-lock.js";
export function resolveQueuePath(cwd, queuePath) {
    return isAbsolute(queuePath) ? queuePath : join(cwd, queuePath);
}
export function retainQueuePath(cwd, config) {
    return resolveQueuePath(cwd, config.retain.queuePath);
}
export function resolveDeadLetterQueuePath(path) {
    return `${path}.dead.jsonl`;
}
export function resolveMalformedQueuePath(path) {
    return `${path}.malformed.jsonl`;
}
export async function enqueueRetainJobWithStats(path, job) {
    return withQueueLock(path, async () => {
        const store = retainQueueStore(path);
        const previousLength = await store.count();
        await store.append([job]);
        return { previousLength, currentLength: previousLength + 1 };
    });
}
export async function enqueueRetainJob(path, job) {
    await enqueueRetainJobWithStats(path, job);
}
// Two automatic-retain jobs can be merged into one remote operation when they target the
// same bank + document with append semantics and carry no delivery failures yet. Merging
// concatenates their (cursor-filtered) deltas so a single delivery covers both, which is
// what cuts server extraction/consolidation and Postgres write amplification.
export function canCoalesceRetainJobs(existing, incoming) {
    return (existing.bankId === incoming.bankId &&
        existing.documentId === incoming.documentId &&
        existing.updateMode === "append" &&
        incoming.updateMode === "append" &&
        existing.retries === 0 &&
        existing.deadLetteredAt === undefined);
}
function mergeRetainContent(existing, incoming) {
    // Automatic-retain content is a JSON array of projected messages. When both sides parse
    // as arrays, concatenate the elements so the merged job is indistinguishable from having
    // enqueued the deltas sequentially. Fall back to newline concatenation otherwise.
    try {
        const a = JSON.parse(existing);
        const b = JSON.parse(incoming);
        if (Array.isArray(a) && Array.isArray(b))
            return JSON.stringify([...a, ...b], null, 2);
    }
    catch {
        // fall through to string concatenation
    }
    return `${existing}\n${incoming}`;
}
export function coalesceRetainJob(existing, incoming) {
    const tags = [...new Set([...(existing.item.tags ?? []), ...(incoming.item.tags ?? [])])];
    return {
        ...existing,
        item: {
            ...existing.item,
            ...incoming.item,
            content: mergeRetainContent(existing.item.content, incoming.item.content),
            ...(tags.length ? { tags } : {}),
        },
    };
}
// Append the job, or merge into the last queue entry only when compatible.
// Only the tail is considered so append order never jumps past a failed/non-mergeable job.
export async function enqueueRetainJobCoalesced(path, job, beforeAdmit) {
    if (!beforeAdmit) {
        return withQueueLock(path, async () => {
            const store = retainQueueStore(path);
            const parsed = await store.readTolerant();
            const jobs = parsed.jobs;
            const last = jobs[jobs.length - 1];
            if (last && canCoalesceRetainJobs(last, job)) {
                const candidate = coalesceRetainJob(last, job);
                jobs[jobs.length - 1] = candidate;
                await appendMalformedQueueLines(path, parsed.malformedLines);
                await store.replace(jobs);
                return { coalesced: true, currentLength: jobs.length };
            }
            await store.append([job]);
            return { coalesced: false, currentLength: jobs.length + 1 };
        });
    }
    let checkedCandidateJson;
    while (true) {
        const decision = await withQueueLock(path, async () => {
            const store = retainQueueStore(path);
            const parsed = await store.readTolerant();
            const jobs = parsed.jobs;
            const last = jobs[jobs.length - 1];
            const coalesced = Boolean(last && canCoalesceRetainJobs(last, job));
            const candidate = coalesced ? coalesceRetainJob(last, job) : job;
            const candidateJson = JSON.stringify(candidate);
            if (candidateJson !== checkedCandidateJson) {
                return { candidate, candidateJson };
            }
            if (coalesced) {
                jobs[jobs.length - 1] = candidate;
                await appendMalformedQueueLines(path, parsed.malformedLines);
                await store.replace(jobs);
                return { result: { coalesced: true, currentLength: jobs.length } };
            }
            await store.append([candidate]);
            return { result: { coalesced: false, currentLength: jobs.length + 1 } };
        });
        if ("result" in decision)
            return decision.result;
        await beforeAdmit(decision.candidate);
        checkedCandidateJson = decision.candidateJson;
    }
}
export async function readRetainQueue(path) {
    return retainQueueStore(path).readStrict();
}
export async function readDeadLetterQueue(path) {
    return readRetainQueue(resolveDeadLetterQueuePath(path));
}
export async function readRetainQueueTolerant(path) {
    return retainQueueStore(path).readTolerant();
}
export async function readDeadLetterQueueTolerant(path) {
    return readRetainQueueTolerant(resolveDeadLetterQueuePath(path));
}
export async function summarizeRetainQueue(path) {
    const [active, deadLetter] = await Promise.all([
        retainQueueStore(path).summarize(),
        retainQueueStore(resolveDeadLetterQueuePath(path)).summarize(),
    ]);
    return { active, deadLetter };
}
export async function writeRetainQueue(path, jobs) {
    await retainQueueStore(path).replace(jobs);
}
export async function removeRetainQueueJobs(path, predicate) {
    return withQueueLock(path, async () => {
        const parsed = await readRetainQueueTolerant(path);
        const remaining = parsed.jobs.filter((job) => !predicate(job));
        const removed = parsed.jobs.length - remaining.length;
        if (removed > 0) {
            await appendMalformedQueueLines(path, parsed.malformedLines);
            await writeRetainQueue(path, remaining);
        }
        return removed;
    });
}
async function appendDeadLetterJobs(path, jobs) {
    if (jobs.length === 0)
        return 0;
    const deadLetterPath = resolveDeadLetterQueuePath(path);
    const existing = await readRetainQueueTolerant(deadLetterPath);
    const existingIds = new Set(existing.jobs.map((job) => job.id));
    const seen = new Set();
    const newJobs = jobs.filter((job) => {
        if (existingIds.has(job.id) || seen.has(job.id))
            return false;
        seen.add(job.id);
        return true;
    });
    if (newJobs.length === 0)
        return 0;
    await retainQueueStore(deadLetterPath).append(newJobs);
    return newJobs.length;
}
function isRetainJob(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    const item = record.item;
    return (typeof record.id === "string" &&
        typeof record.bankId === "string" &&
        typeof record.documentId === "string" &&
        (record.updateMode === "append" || record.updateMode === "replace") &&
        typeof record.retries === "number" &&
        !!item &&
        typeof item === "object" &&
        typeof item.content === "string" &&
        typeof item.context === "string");
}
function retainQueueStore(path) {
    return new JsonlQueueStore(path, isRetainJob);
}
async function appendMalformedQueueLines(path, lines) {
    if (lines.length === 0)
        return;
    const malformedPath = resolveMalformedQueuePath(path);
    await mkdir(dirname(malformedPath), { recursive: true });
    const quarantinedAt = new Date().toISOString();
    await appendFile(malformedPath, lines
        .map((line) => JSON.stringify({
        quarantinedAt,
        sourceQueue: path,
        line,
    }))
        .join("\n") + "\n", "utf8");
}
export async function flushRetainQueue(path, client, options = {}) {
    return withQueueLock(path, async () => {
        const resolvedOptions = options;
        const maxRetries = resolvedOptions.maxRetries ?? 5;
        const maxJobs = resolvedOptions.maxJobs ?? Number.POSITIVE_INFINITY;
        const maxElapsedMs = resolvedOptions.maxElapsedMs ?? Number.POSITIVE_INFINITY;
        const started = Date.now();
        const parsed = await readRetainQueueTolerant(path);
        const jobs = parsed.jobs;
        const remaining = [];
        const deadLetteredJobs = [];
        const operationIds = [];
        const delivered = [];
        let itemsCount = 0;
        let hasItemsCount = false;
        let tokens = 0;
        let hasTokens = false;
        let sent = 0;
        for (const [index, job] of jobs.entries()) {
            if (index >= maxJobs || Date.now() - started >= maxElapsedMs) {
                remaining.push(...jobs.slice(index));
                break;
            }
            try {
                const response = await deliverRetainJob(client, job);
                const outcome = parseRetainOutcome(response);
                operationIds.push(...outcome.operationIds);
                if (outcome.itemsCount !== undefined) {
                    itemsCount += outcome.itemsCount;
                    hasItemsCount = true;
                }
                if (outcome.tokens !== undefined) {
                    tokens += outcome.tokens;
                    hasTokens = true;
                }
                const jobOutcome = {
                    ...(outcome.itemsCount !== undefined ? { itemsCount: outcome.itemsCount } : {}),
                    ...(outcome.operationIds.length ? { operations: outcome.operationIds.length } : {}),
                    ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
                };
                delivered.push({
                    queueJobId: job.id,
                    bankId: job.bankId,
                    documentId: job.documentId,
                    updateMode: job.updateMode,
                    context: job.item.context,
                    tags: job.item.tags ?? [],
                    outcome: jobOutcome,
                });
                sent += 1;
            }
            catch (error) {
                const errorMessage = redactQueueError(error);
                const retries = job.retries + 1;
                const deadLetter = retries >= maxRetries;
                const failedJob = {
                    ...job,
                    retries,
                    lastError: errorMessage,
                    ...(deadLetter
                        ? {
                            deadLetteredAt: new Date().toISOString(),
                            lastError: `${errorMessage}; retry limit reached, moved to dead-letter queue`,
                        }
                        : {}),
                };
                if (deadLetter)
                    deadLetteredJobs.push(failedJob);
                else
                    remaining.push(failedJob);
                if (resolvedOptions.stopOnFirstFailure) {
                    remaining.push(...jobs.slice(index + 1));
                    break;
                }
            }
        }
        await appendMalformedQueueLines(path, parsed.malformedLines);
        const appendedDeadLetterJobs = await appendDeadLetterJobs(path, deadLetteredJobs);
        await writeRetainQueue(path, remaining);
        const uniqueOperationIds = [...new Set(operationIds)];
        const aggregate = {
            ...(hasItemsCount ? { itemsCount } : {}),
            ...(uniqueOperationIds.length ? { operations: uniqueOperationIds.length } : {}),
            ...(hasTokens ? { tokens } : {}),
        };
        return {
            sent,
            remaining: remaining.length,
            deadLettered: appendedDeadLetterJobs,
            malformed: parsed.malformedLines.length,
            ...(uniqueOperationIds.length ? { operationIds: uniqueOperationIds } : {}),
            ...(hasItemsCount || uniqueOperationIds.length || hasTokens ? { outcome: aggregate } : {}),
            ...(delivered.length ? { delivered } : {}),
        };
    });
}
export async function enqueueRetain(cwd, config, job) {
    await runRetainBeforeEnqueueCheck(config, job);
    return enqueueRetainJobWithStats(retainQueuePath(cwd, config), job);
}
export async function enqueueRetainCoalesced(cwd, config, job) {
    return enqueueRetainJobCoalesced(retainQueuePath(cwd, config), job, (candidate) => runRetainBeforeEnqueueCheck(config, candidate));
}
export async function flushRetain(cwd, config, client, options) {
    return flushRetainQueue(retainQueuePath(cwd, config), client, options);
}
export async function readQueuedRetains(cwd, config) {
    return readRetainQueue(retainQueuePath(cwd, config));
}
export async function removeQueuedRetains(cwd, config, predicate) {
    return removeRetainQueueJobs(retainQueuePath(cwd, config), predicate);
}
export async function summarizeRetain(cwd, config) {
    return summarizeRetainQueue(retainQueuePath(cwd, config));
}
