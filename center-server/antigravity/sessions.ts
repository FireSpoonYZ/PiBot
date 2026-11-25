// Per-(deviceId, sessionId) persisted ACP session store.
//
// Adapted from @estebanforge/pi-antigravity-bridge `src/sessions.ts`:
// keys are composite `(deviceId, sessionId)` strings so distinct devices and
// sessions stay strictly isolated while sharing atomic merge-on-write persistence.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ContextSnapshot } from "./context-sync.ts";
import type { Message } from "@earendil-works/pi-ai";
import { AGY_EMPTY_PREFIX, hashValue, isHash } from "../../center-contract/antigravity-delta.js";

export interface ReceivedHistory {
	version: 1;
	config: { systemPrompt: string; tools: unknown[]; routingPolicy: string };
	configHash: string;
	messages: Message[];
	prefixes: string[];
}

export interface StoredReply {
	end: number;
	prefixHash: string;
	reason: "stop" | "toolUse" | "error" | "aborted";
	message: Message;
}

export interface AgySession {
	conversationId: string;
	lastStepIdx: number;
	lastMessageCount?: number;
	turnRecallHook?: true;
	/** Native configuration bound to this session; legacy mappings require /clear. */
	modelId?: string;
	reasoning?: string | null;
	/** Native lifecycle is independent of the durable transport receipt below. */
	phase?: "new" | "ready" | "parked" | "uncertain";
	/** Durable Host receipt, independent of native prompt consumption. */
	history?: ReceivedHistory;
	/** Prefix covered by a native dispatch intent, even if its outcome is unknown. */
	attemptedThrough?: number;
	/** User-entry indices covered by a native dispatch intent; queued gaps remain unsent. */
	consumedUserIndices?: number[];
	/** Re-deliver an observed result for a transport retry without invoking the model. */
	reply?: StoredReply;
	checkpoint?: ContextSnapshot;
	/** Trailing, non-recall context sent outside the authoritative input prefix. */
	auxiliaryHashes?: string[];
	/** Calls exposed to Host whose results may arrive after a Center restart. */
	pendingToolCallIds?: string[];
}

type StoreMap = Record<string, AgySession>;
const HASH_RE = /^[a-f0-9]{64}$/;

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.promises.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function durableRename(tmp: string, destination: string): Promise<void> {
	await fs.promises.rename(tmp, destination);
	// Sync the directory entry after the flushed write and atomic rename.
	// Windows does not support opening directories through this API.
	if (process.platform !== "win32") await syncDirectory(path.dirname(destination));
}

function readCheckpoint(value: unknown): ContextSnapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ContextSnapshot>;
	if (candidate.version !== 1 || typeof candidate.systemHash !== "string" ||
		!HASH_RE.test(candidate.systemHash) || !Array.isArray(candidate.messageHashes) ||
		!Array.from(candidate.messageHashes).every((item) => typeof item === "string" && HASH_RE.test(item))) {
		return undefined;
	}
	return { version: 1, systemHash: candidate.systemHash, messageHashes: [...candidate.messageHashes] };
}

function readHistory(value: unknown): ReceivedHistory | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const h = value as ReceivedHistory;
	if (h.version !== 1 || !h.config || typeof h.config.systemPrompt !== "string" ||
		!Array.isArray(h.config.tools) || typeof h.config.routingPolicy !== "string" ||
		!isHash(h.configHash) || hashValue(h.config) !== h.configHash || !Array.isArray(h.messages) ||
		!Array.isArray(h.prefixes) || h.prefixes.length !== h.messages.length + 1 ||
		h.prefixes[0] !== AGY_EMPTY_PREFIX || !h.prefixes.every(isHash)) return undefined;
	return structuredClone(h);
}

function readReply(value: unknown): StoredReply | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as StoredReply;
	if (!Number.isSafeInteger(r.end) || r.end < 0 || !isHash(r.prefixHash) ||
		!["stop", "toolUse", "error", "aborted"].includes(r.reason) || r.message?.role !== "assistant") return undefined;
	return structuredClone(r);
}

function copySession(session: AgySession): AgySession {
	return {
		...session,
		...(session.history ? { history: structuredClone(session.history) } : {}),
		...(session.consumedUserIndices ? { consumedUserIndices: [...session.consumedUserIndices] } : {}),
		...(session.reply ? { reply: structuredClone(session.reply) } : {}),
		...(session.checkpoint ? { checkpoint: {
			...session.checkpoint, messageHashes: [...session.checkpoint.messageHashes],
		} } : {}),
		...(session.pendingToolCallIds ? { pendingToolCallIds: [...session.pendingToolCallIds] } : {}),
		...(session.auxiliaryHashes ? { auxiliaryHashes: [...session.auxiliaryHashes] } : {}),
	};
}

export function makeSessionKey(deviceId: string, sessionId: string): string {
	return JSON.stringify([deviceId, sessionId]);
}

function narrowStoreMap(parsed: unknown): StoreMap {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const clean: StoreMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const conversationId = (value as { conversationId?: unknown }).conversationId;
		if (typeof conversationId !== "string") continue;
		const idx = (value as { lastStepIdx?: unknown }).lastStepIdx;
		const mc = (value as { lastMessageCount?: unknown }).lastMessageCount;
		const turnRecallHook = (value as { turnRecallHook?: unknown }).turnRecallHook;
		const modelId = (value as { modelId?: unknown }).modelId;
		const reasoning = (value as { reasoning?: unknown }).reasoning;
		const phase = (value as { phase?: unknown }).phase;
		const checkpoint = readCheckpoint((value as { checkpoint?: unknown }).checkpoint);
		const history = readHistory((value as { history?: unknown }).history);
		const reply = readReply((value as { reply?: unknown }).reply);
		const attemptedThrough = (value as { attemptedThrough?: unknown }).attemptedThrough;
		const consumed = (value as { consumedUserIndices?: unknown }).consumedUserIndices;
		const consumedUserIndices = Array.isArray(consumed) && consumed.every((index) => Number.isSafeInteger(index) && index >= 0)
			? [...new Set(consumed as number[])] : undefined;
		const auxiliary = (value as { auxiliaryHashes?: unknown }).auxiliaryHashes;
		const auxiliaryHashes = Array.isArray(auxiliary) && Array.from(auxiliary)
			.every((hash) => typeof hash === "string" && HASH_RE.test(hash)) ? [...auxiliary] : undefined;
		const pending = (value as { pendingToolCallIds?: unknown }).pendingToolCallIds;
		const pendingToolCallIds = Array.isArray(pending) &&
			pending.every((id) => typeof id === "string" && id.length > 0)
			? [...new Set(pending as string[])] : undefined;
		clean[key] = {
			conversationId,
			lastStepIdx: typeof idx === "number" && Number.isFinite(idx) ? idx : -1,
			lastMessageCount: typeof mc === "number" && Number.isFinite(mc) ? mc : 0,
			...(turnRecallHook === true ? { turnRecallHook } : {}),
			...(typeof modelId === "string" && modelId.length > 0 ? { modelId } : {}),
			...(reasoning === null || typeof reasoning === "string" ? { reasoning } : {}),
			...(phase === "new" || phase === "ready" || phase === "parked" || phase === "uncertain" ? { phase } : {}),
			...(history ? { history } : {}),
			...(consumedUserIndices ? { consumedUserIndices } : {}),
			...(reply ? { reply } : {}),
			...(typeof attemptedThrough === "number" && Number.isSafeInteger(attemptedThrough) && attemptedThrough >= 0
				? { attemptedThrough } : {}),
			...(checkpoint ? { checkpoint } : {}),
			...(auxiliaryHashes ? { auxiliaryHashes } : {}),
			...(pendingToolCallIds ? { pendingToolCallIds } : {}),
		};
	}
	return clean;
}

export class SessionStore {
	#path: string;
	#cache: StoreMap = {};
	#dirty = new Set<string>();
	#removed = new Set<string>();
	#writeChain: Promise<void> = Promise.resolve();
	#writeError: unknown;

	constructor(storePath: string) {
		this.#path = storePath;
		this.#load();
	}

	#load(): void {
		try {
			const raw = fs.readFileSync(this.#path, "utf8");
			this.#cache = narrowStoreMap(JSON.parse(raw));
		} catch {
			this.#cache = {};
		}
	}

	get(key: string): AgySession | null {
		const s = this.#cache[key];
		if (!s || typeof s.conversationId !== "string") return null;
		return copySession(s);
	}

	#queueWrite(write: () => Promise<void>): void {
		// Keep the background chain handled, but retain failures for the caller's
		// persistence barrier. A later successful write retries all dirty entries.
		this.#writeChain = this.#writeChain.then(write).then(
			() => { this.#writeError = undefined; },
			(error: unknown) => { this.#writeError = error; },
		);
	}

	set(key: string, session: AgySession): void {
		this.#cache[key] = copySession(session);
		this.#dirty.add(key);
		this.#removed.delete(key);
		this.#queueWrite(() => this.#persist());
	}

	delete(key: string): void {
		delete this.#cache[key];
		this.#dirty.delete(key);
		this.#removed.add(key);
		this.#queueWrite(() => this.#persist());
	}

	async #persist(): Promise<void> {
		const dir = path.dirname(this.#path);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

		let disk: StoreMap = {};
		try {
			const raw = await fs.promises.readFile(this.#path, "utf8");
			disk = narrowStoreMap(JSON.parse(raw));
		} catch {
			/* missing or corrupt */
		}
		const writtenKeys = [...this.#dirty];
		const removedKeys = [...this.#removed];
		if (writtenKeys.length === 0 && removedKeys.length === 0) return;
		const merged: StoreMap = { ...disk };
		for (const key of writtenKeys) {
			const entry = this.#cache[key];
			if (entry) merged[key] = entry;
		}
		for (const key of removedKeys) {
			delete merged[key];
		}

		const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", {
				mode: 0o600,
				flush: true,
			});
			await durableRename(tmp, this.#path);
			// Another session can finish while the write is in flight.
			for (const key of writtenKeys) {
				if (this.#cache[key] === merged[key]) this.#dirty.delete(key);
			}
			for (const key of removedKeys) {
				if (this.#cache[key] === undefined) this.#removed.delete(key);
			}
		} catch (err) {
			try {
				await fs.promises.unlink(tmp);
			} catch {
				/* best effort */
			}
			throw err;
		}
	}

	clear(): void {
		this.#cache = {};
		this.#dirty.clear();
		this.#removed.clear();
		this.#queueWrite(async () => {
			await fs.promises.mkdir(path.dirname(this.#path), { recursive: true, mode: 0o700 });
			const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			await fs.promises.writeFile(tmp, "{}\n", { mode: 0o600, flush: true });
			await durableRename(tmp, this.#path);
		});
	}

	async flush(): Promise<void> {
		await this.#writeChain;
		if (this.#writeError !== undefined) throw this.#writeError;
	}

	get size(): number {
		return Object.keys(this.#cache).length;
	}
}
