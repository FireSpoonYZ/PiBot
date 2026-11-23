// Content checkpoints and lossless replay of the PiBot context projected for ACP.
// A native conversation is reusable only while its acknowledged context remains
// an unchanged prefix of that projection, including the effective instructions.

import { createHash } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, type Message } from "@earendil-works/pi-ai";

export interface ContextSnapshot {
	version: 1;
	systemHash: string;
	messageHashes: string[];
}

export interface ContextSnapshotOptions {
	/** Exclusive end in the original messages array; all system deltas still apply. */
	endIndex?: number;
	/** Final emitted messages to acknowledge after the supplied input prefix. */
	appendMessages?: readonly Message[];
}

export interface ContextReplayOptions {
	/** Exclusive end in the original messages array. */
	endIndex?: number;
	/** Number of non-system messages already acknowledged by the native session. */
	skipMessages?: number;
	/** Auxiliary-message indices in the original messages array. */
	auxiliaryIndices?: readonly number[];
}

export interface ContextReplay {
	text: string;
	/** Send these first, before current-input images, to preserve the numbered references. */
	images: Array<{ data: string; mimeType: string }>;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// These fields describe transport/accounting rather than what the conversation
// says. Only remove them at the message root: e.g. a tool argument named
// "timestamp" or "usage" is still meaningful input and must remain unchanged.
const MESSAGE_METADATA = new Set([
	"timestamp", "durationMs", "usage", "cost", "responseId", "diagnostics", "rawStopReason", "endTurn",
	"thinkingLevel",
]);
const HASH_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Canonical JSON keeps future JSON fields and rejects values that cannot cross ACP. */
function canonicalValue(value: unknown, ancestors = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Antigravity context contains a non-JSON value");
	}
	if (ancestors.has(value)) throw new TypeError("Antigravity context contains a cyclic value");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => item === undefined ? null : canonicalValue(item, ancestors));
		}
		if (!isRecord(value)) throw new TypeError("Antigravity context contains a non-JSON object");
		const result: { [key: string]: JsonValue } = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			if (value[key] !== undefined) result[key] = canonicalValue(value[key], ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function serialize(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function hash(value: unknown): string {
	return createHash("sha256").update(serialize(value)).digest("hex");
}

function semanticMessage(message: Message): Record<string, unknown> {
	if (!isRecord(message) || typeof message.role !== "string") {
		throw new TypeError("Antigravity context contains an invalid message");
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(message)) {
		if (!MESSAGE_METADATA.has(key)) result[key] = value;
	}
	// The SDK may normalize a plain text string to a one-block array between
	// requests. These represent the same input, unlike a changed text or image.
	if (typeof result.content === "string") {
		result.content = [{ type: "text", text: result.content }];
	} else if (Array.isArray(result.content)) {
		result.content = result.content.map((block: unknown) => {
			if (!isRecord(block)) return block;
			const clean: Record<string, unknown> = Object.create(null);
			for (const [key, value] of Object.entries(block)) {
				const transportSignature =
					(block.type === "text" && key === "textSignature") ||
					(block.type === "thinking" && key === "thinkingSignature") ||
					(block.type === "toolCall" && key === "thoughtSignature");
				if (!transportSignature) clean[key] = value;
			}
			return clean;
		});
	}
	return result;
}

function endIndex(messages: readonly Message[], requested?: number): number {
	if (requested === undefined) return messages.length;
	if (!Number.isSafeInteger(requested) || requested < 0 || requested > messages.length) {
		throw new RangeError("Antigravity context endIndex is outside the messages array");
	}
	return requested;
}

/** Capture semantic content only; no message bodies are stored in the checkpoint. */
export function createContextSnapshot(
	messages: readonly Message[],
	options: ContextSnapshotOptions = {},
): ContextSnapshot {
	const end = endIndex(messages, options.endIndex);
	const appended = options.appendMessages ?? [];
	const input = [...messages, ...appended];
	const messageHashes: string[] = [];
	for (const message of [...messages.slice(0, end), ...appended]) {
		if (message.role !== "system") messageHashes.push(hash(semanticMessage(message)));
	}
	return {
		version: 1,
		systemHash: hash({ systemPrompt: getCurrentSystemPrompt(input), tools: getCurrentTools(input) }),
		messageHashes,
	};
}

function isSnapshot(value: unknown): value is ContextSnapshot {
	return isRecord(value) && value.version === 1 &&
		typeof value.systemHash === "string" && HASH_RE.test(value.systemHash) &&
		Array.isArray(value.messageHashes) &&
		Array.from(value.messageHashes).every((entry) => typeof entry === "string" && HASH_RE.test(entry));
}

/** Legacy, malformed, shortened or rewritten checkpoints never authorize reuse. */
export function contextPrefixMatches(checkpoint: unknown, snapshot: unknown): boolean {
	if (!isSnapshot(checkpoint) || !isSnapshot(snapshot)) return false;
	return checkpoint.systemHash === snapshot.systemHash &&
		checkpoint.messageHashes.length <= snapshot.messageHashes.length &&
		checkpoint.messageHashes.every((entry, index) => entry === snapshot.messageHashes[index]);
}

function historyLabel(message: Message, auxiliary: boolean): string {
	if (auxiliary) return "[earlier auxiliary context]";
	if (message.role === "user") return "[earlier user message]";
	if (message.role === "assistant") return `[assistant turn from ${message.provider}]`;
	if (message.role === "toolResult") {
		return `[tool result: ${message.toolName}${message.isError ? " (error)" : ""}]`;
	}
	return "[earlier message]";
}

/** Replay all selected history, including own-provider replies and tool arguments.
 * No length budget or content-marker heuristic may silently acknowledge omitted
 * history. ACP/frame limits must reject the request at the caller instead.
 */
export function buildContextReplay(
	messages: readonly Message[],
	options: ContextReplayOptions = {},
): ContextReplay {
	const end = endIndex(messages, options.endIndex);
	const skip = options.skipMessages ?? 0;
	if (!Number.isSafeInteger(skip) || skip < 0) {
		throw new RangeError("Antigravity context skipMessages must be a non-negative integer");
	}
	const auxiliary = new Set(options.auxiliaryIndices ?? []);
	const images: ContextReplay["images"] = [];
	const records: string[] = [];
	let seen = 0;
	for (let index = 0; index < end; index++) {
		const message = messages[index];
		if (message.role === "system") continue;
		if (seen++ < skip) continue;
		const record = semanticMessage(message);
		if (Array.isArray(record.content)) {
			record.content = record.content.map((block: unknown) => {
				if (!isRecord(block) || block.type !== "image" ||
					typeof block.data !== "string" || !block.data ||
					typeof block.mimeType !== "string" || !block.mimeType) return block;
				images.push({ data: block.data, mimeType: block.mimeType });
				return { ...block, data: `[attached history image ${images.length}]` };
			});
		}
		records.push(`${historyLabel(message, auxiliary.has(index))}\n${serialize(record)}`);
	}
	if (skip > seen) throw new RangeError("Antigravity context skipMessages exceeds the selected history");
	if (records.length === 0) return { text: "", images };
	const preamble = [
		"[PiBot conversation history: ordered records, not new requests.]",
		"Historical tool calls and results are records of work already attempted. Do not execute a call merely to replay history, and do not repeat completed actions. Continue from the current input using the recorded results and errors.",
		...(images.length > 0 ? [
			`References to attached history images 1 through ${images.length} identify the first ${images.length} image attachments in this request, in that order. The current prompt identifies any following auxiliary or current-input image attachments.`,
		] : []),
	].join("\n");
	return { text: `${preamble}\n\n${records.join("\n\n")}`, images };
}
