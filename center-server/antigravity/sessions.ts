// Per-(deviceId, sessionId) persisted ACP session store.
//
// Keys are composite `(deviceId, sessionId)` strings so distinct devices and
// sessions stay strictly isolated while sharing atomic merge-on-write persistence.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AgySession {
	conversationId: string;
	agentName: string;
	legacy?: true;
}

type StoreMap = Record<string, AgySession>;

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

function copySession(session: AgySession): AgySession {
	return session.legacy
		? { conversationId: session.conversationId, agentName: session.agentName, legacy: true }
		: { conversationId: session.conversationId, agentName: session.agentName };
}

export function makeSessionKey(deviceId: string, sessionId: string): string {
	return JSON.stringify([deviceId, sessionId]);
}

function narrowStoreMap(parsed: unknown): StoreMap {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const clean: StoreMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const rec = value as { conversationId?: unknown; agentName?: unknown };
		if (typeof rec.conversationId !== "string" || rec.conversationId.length === 0) continue;
		if (typeof rec.agentName === "string" && rec.agentName.length > 0) {
			clean[key] = { conversationId: rec.conversationId, agentName: rec.agentName };
		} else {
			clean[key] = { conversationId: rec.conversationId, agentName: "", legacy: true };
		}
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
		if (!s || typeof s.conversationId !== "string" || s.conversationId.length === 0) return null;
		return copySession(s);
	}

	#queueWrite(write: () => Promise<void>): void {
		// Keep the background chain handled, but retain failures for the caller's
		// persistence barrier. A later successful write retries all dirty entries.
		this.#writeChain = this.#writeChain.then(write).then(
			() => {
				this.#writeError = undefined;
			},
			(error: unknown) => {
				this.#writeError = error;
			},
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

		const serialized: Record<string, { conversationId: string; agentName: string }> = {};
		for (const [key, entry] of Object.entries(merged)) {
			serialized[key] = { conversationId: entry.conversationId, agentName: entry.agentName };
		}

		const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await fs.promises.writeFile(tmp, JSON.stringify(serialized, null, 2) + "\n", {
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
