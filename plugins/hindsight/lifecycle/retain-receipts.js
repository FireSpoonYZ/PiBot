import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { redactSecrets } from "../utils/sanitize.js";
const MAX_RECEIPTS = 50;
const MAX_RECEIPT_CONTEXT_CHARS = 1000;
export function retainReceiptsPath(cwd) {
    return resolve(cwd, ".pi/hindsight/retain-receipts.json");
}
function emptyHistory() {
    return { version: 1, receipts: [] };
}
export async function readRetainReceipts(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (parsed.version !== 1 || !Array.isArray(parsed.receipts))
            return emptyHistory();
        return { version: 1, receipts: parsed.receipts.filter(isRetainReceipt).slice(0, MAX_RECEIPTS) };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return emptyHistory();
        return emptyHistory();
    }
}
function isRetainReceipt(value) {
    if (!value || typeof value !== "object")
        return false;
    const receipt = value;
    return (typeof receipt.createdAt === "string" &&
        typeof receipt.bankId === "string" &&
        typeof receipt.documentId === "string" &&
        typeof receipt.queueJobId === "string" &&
        (receipt.updateMode === "append" || receipt.updateMode === "replace") &&
        (receipt.source === "tool" || receipt.source === "import" || receipt.source === "queue") &&
        typeof receipt.context === "string" &&
        Array.isArray(receipt.tags) &&
        receipt.tags.every((tag) => typeof tag === "string"));
}
function receiptContext(context, options) {
    const redacted = options.redactSecrets === false ? context : redactSecrets(context);
    const maxChars = options.maxContextChars ?? MAX_RECEIPT_CONTEXT_CHARS;
    if (redacted.length <= maxChars)
        return redacted;
    return `${redacted.slice(0, maxChars)}…[truncated]`;
}
function buildReceipt(receipt, options) {
    return {
        createdAt: receipt.createdAt ?? new Date().toISOString(),
        bankId: receipt.bankId,
        documentId: receipt.documentId,
        queueJobId: receipt.queueJobId,
        updateMode: receipt.updateMode,
        source: receipt.source,
        context: receiptContext(receipt.context, options),
        tags: receipt.tags,
        ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
    };
}
function mergeReceipt(receipts, next) {
    return [
        next,
        ...receipts.filter((existing) => existing.documentId !== next.documentId || existing.bankId !== next.bankId),
    ];
}
async function writeReceiptHistory(cwd, receipts) {
    const path = retainReceiptsPath(cwd);
    const history = { version: 1, receipts: receipts.slice(0, MAX_RECEIPTS) };
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
    return history;
}
export async function appendRetainReceipt(cwd, receipt, options = {}) {
    const current = await readRetainReceipts(retainReceiptsPath(cwd));
    return writeReceiptHistory(cwd, mergeReceipt(current.receipts, buildReceipt(receipt, options)));
}
export async function appendRetainReceipts(cwd, receiptInputs, options = {}) {
    if (receiptInputs.length === 0)
        return readRetainReceipts(retainReceiptsPath(cwd));
    const current = await readRetainReceipts(retainReceiptsPath(cwd));
    let receipts = current.receipts;
    for (const input of receiptInputs)
        receipts = mergeReceipt(receipts, buildReceipt(input, options));
    return writeReceiptHistory(cwd, receipts);
}
export async function listRetainReceipts(cwd, limit = 10) {
    const history = await readRetainReceipts(retainReceiptsPath(cwd));
    return history.receipts.slice(0, Math.max(0, limit));
}
