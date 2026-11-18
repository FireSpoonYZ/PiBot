// Per-(deviceId, sessionId) persisted ACP session store.
//
// Adapted from @estebanforge/pi-antigravity-bridge `src/sessions.ts`:
// keys are composite `(deviceId, sessionId)` strings so distinct devices and
// sessions stay strictly isolated while sharing atomic merge-on-write persistence.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AgySession {
	conversationId: string;
	lastStepIdx: number;
	lastMessageCount?: number;
}

type StoreMap = Record<string, AgySession>;

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
		clean[key] = {
			conversationId,
			lastStepIdx: typeof idx === "number" && Number.isFinite(idx) ? idx : -1,
			lastMessageCount: typeof mc === "number" && Number.isFinite(mc) ? mc : 0,
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
		return {
			conversationId: s.conversationId,
			lastStepIdx: s.lastStepIdx ?? -1,
			lastMessageCount: s.lastMessageCount ?? 0,
		};
	}

	set(key: string, session: AgySession): void {
		this.#cache[key] = session;
		this.#dirty.add(key);
		this.#removed.delete(key);
		this.#writeChain = this.#writeChain
			.then(() => this.#persist())
			.catch(() => {
				/* next set() retries */
			});
	}

	delete(key: string): void {
		delete this.#cache[key];
		this.#dirty.delete(key);
		this.#removed.add(key);
		this.#writeChain = this.#writeChain
			.then(() => this.#persist())
			.catch(() => {
				/* next write retries */
			});
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
		const merged: StoreMap = { ...disk };
		for (const key of this.#dirty) {
			const entry = this.#cache[key];
			if (entry) merged[key] = entry;
		}
		for (const key of this.#removed) {
			delete merged[key];
		}

		const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", {
				mode: 0o600,
			});
			await fs.promises.rename(tmp, this.#path);
			this.#dirty.clear();
			this.#removed.clear();
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
		this.#writeChain = this.#writeChain
			.then(async () => {
				await fs.promises.mkdir(path.dirname(this.#path), { recursive: true, mode: 0o700 });
				const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
				await fs.promises.writeFile(tmp, "{}\n", { mode: 0o600 });
				await fs.promises.rename(tmp, this.#path);
			})
			.catch(() => {
				/* best effort */
			});
	}

	flush(): Promise<void> {
		return this.#writeChain;
	}

	get size(): number {
		return Object.keys(this.#cache).length;
	}
}
