// ACP connection: owns the agy acp process, the JSON-RPC session over its
// stdio, and the protocol methods the driver needs.
//
// Verified live against agy 1.5.12:
//   - initialize: {protocolVersion:1, clientCapabilities{fs:false,terminal:false}}
//   - model and thought_level are separate session config options
//   - session/resume restores a session without replaying history frames
//   - session/prompt is stateless on the connection and supports concurrent
//     in-flight prompts on the same session (steer)
//   - session/cancel is a notification; the prompt settles with stopReason cancelled
//   - session/request_permission auto-allows the first allow* option (Center server)
//   - mcpServers entries: {name, type:"http", url, headers:[]}
//   - child process env strips ANTIGRAVITY_* variables to isolate nested runs

import { spawn, type ChildProcess } from "node:child_process";
import type { AgyUsage, ToolResultImage } from "../driver-types.ts";
import { redactText } from "../redact.ts";
import { frameCarriesUsage } from "./events.ts";
import { JsonRpcResponseError, JsonRpcSession } from "./jsonrpc.ts";

export interface AcpMcpServer {
	name: string;
	type: "http" | "sse";
	url: string;
	headers: Array<{ name: string; value: string }>;
}

export interface AcpSessionInfo {
	sessionId: string;
}

/** Auth failed (-32000 family). Message carries the remediation the server
 *  provided plus the sign-in pointer. */
export class AcpAuthError extends Error {
	readonly code = "UNAUTHENTICATED";

	constructor(message: string) {
		super(message);
		this.name = "AcpAuthError";
	}
}

export interface AcpConnectionOptions {
	/** Process working directory for the spawned server. */
	cwd: string;
	/** Resolved server binary (or node executable when binArgs carries the
	 *  fake-server script for tests). */
	bin: string;
	binArgs?: string[];
	/** Isolated Gemini profile directory forwarded via `--gemini-dir`. */
	geminiDir?: string;
	extraEnv?: Record<string, string>;
	log: (msg: string, data?: unknown) => void;
	/** Incoming `session/update` payloads. */
	onUpdate: (sessionId: string | null, update: unknown) => void;
	/** Process exit. Fires exactly once. */
	onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
	/** mcpServers entries for session/new and session/resume. Evaluated lazily per call. */
	mcpServers?: () => AcpMcpServer[];
}

const INIT_TIMEOUT_MS = 30_000;
const SESSION_OP_TIMEOUT_MS = 20_000;

/** One session/request_permission option block. */
export interface AcpPermissionOption {
	optionId?: string;
	kind?: string;
	name?: string;
}

/** Payload received for `session/request_permission`. */
export interface AcpPermissionRequest {
	sessionId?: string;
	options: AcpPermissionOption[];
	toolCall?: {
		toolCallId?: string;
		kind?: string;
		title?: string;
		name?: string;
		_meta?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** Copy `process.env` with all `ANTIGRAVITY_*` keys stripped, then merge `extraEnv`. */
export function buildAcpChildEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^ANTIGRAVITY_/i.test(key)) continue;
		env[key] = value;
	}
	if (extraEnv) {
		Object.assign(env, extraEnv);
	}
	return env;
}

export class AcpConnection {
	#opts: AcpConnectionOptions;
	#child: ChildProcess | undefined;
	#rpc: JsonRpcSession | undefined;
	#stderrTail = "";
	#startPromise: Promise<void> | undefined;
	#exitPromise: Promise<void> | undefined;
	#resolveExit: (() => void) | undefined;
	#usageSeen = false;
	/** Set ONLY by a parsed PromptResponse.usage; this gates estimate
	 *  suppression. #usageSeen stays diagnostic: any usage-shaped frame trips
	 *  it, and the connection outlives turns. */
	#exactUsageSeen = false;
	#exited = false;
	#killed = false;
	#updateSessionId: string | null = null;
	#activeSessionId: string | null = null;
	agentInfo: Record<string, unknown> | undefined;
	/** Last known mode/model config echo from session/new, session/resume, or set_config_option. */
	lastConfigOptions: unknown = undefined;

	constructor(opts: AcpConnectionOptions) {
		this.#opts = opts;
	}

	get alive(): boolean {
		return this.#child !== undefined && !this.#exited && !this.#killed;
	}

	get activeSessionId(): string | null {
		return this.#activeSessionId;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get stderrTail(): string {
		return redactText(this.#stderrTail);
	}

	get usageSeen(): boolean {
		return this.#usageSeen;
	}

	/** True once the server sent real per-turn usage (PromptResponse.usage). */
	get exactUsageSeen(): boolean {
		return this.#exactUsageSeen;
	}

	/** Spawn the server and perform the initialize handshake. Idempotent per
	 *  instance: call once. */
	start(): Promise<void> {
		this.#startPromise ??= this.#start().catch((err) => {
			if (!this.#child) {
				this.#resolveExit?.();
				this.#resolveExit = undefined;
			}
			throw err;
		});
		return this.#startPromise;
	}

	async #start(): Promise<void> {
		if (this.#killed) throw new Error("ACP connection closed before startup");
		const args = [...(this.#opts.binArgs ?? [])];
		if (this.#opts.geminiDir) {
			args.push("--gemini-dir", this.#opts.geminiDir);
		}
		this.#exitPromise = new Promise<void>((resolve) => {
			this.#resolveExit = resolve;
		});
		const child = spawn(this.#opts.bin, args, {
			cwd: this.#opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
			env: buildAcpChildEnv(this.#opts.extraEnv),
		});
		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdin?.on("error", (err) => {
			this.#opts.log("stdin-error", { message: redactText(err.message) });
			if (!this.#exited && !this.#killed) this.#finish(redactText(err.message));
		});

		const rpc = new JsonRpcSession({
			send: (frame) => this.#write(frame),
			onRequest: (method, params) => this.#onServerRequest(method, params),
			onNotification: (method, params) => this.#onNotification(method, params),
			onParseError: (line) => this.#opts.log("parse-error", { line }),
			onOverflow: (detail) => {
				this.#opts.log("frame-overflow", { detail });
				this.#finish(`stdout frame overflow: ${detail}`);
				const c = this.#child;
				try {
					if (c?.pid && process.platform !== "win32") {
						process.kill(-c.pid, "SIGKILL");
					} else {
						c?.kill("SIGKILL");
					}
				} catch {
					/* already gone */
				}
			},
		});
		this.#rpc = rpc;

		child.stdout?.on("data", (chunk: string) => rpc.feed(chunk));
		child.stderr?.on("data", (chunk: string) => {
			this.#stderrTail = (this.#stderrTail + chunk).slice(-8192);
		});
		child.on("error", (err) => {
			this.#opts.log("spawn-error", { message: redactText(err.message) });
			this.#resolveExit?.();
			this.#resolveExit = undefined;
			this.#finish(redactText(err.message));
		});
		child.on("exit", (code, signal) => {
			this.#opts.log("exit", { code: code ?? signal ?? "?" });
			this.#resolveExit?.();
			this.#resolveExit = undefined;
			const where = signal ? `signal ${signal}` : code !== null ? `code ${code}` : "";
			const tail = redactText(this.#stderrTail.trim());
			const detail = [where, tail || "process gone"].filter(Boolean).join(": ");
			this.#finish(detail, code, signal);
		});

		const result = (await this.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			},
			INIT_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		const info = result?.agentInfo;
		if (typeof info === "object" && info !== null) this.agentInfo = info as Record<string, unknown>;
		this.#opts.log("initialized", { version: this.serverVersion() });
	}

	serverVersion(): string | undefined {
		const v = this.agentInfo?.version;
		return typeof v === "string" ? v : undefined;
	}

	async newSession(cwd: string): Promise<AcpSessionInfo> {
		const result = (await this.request(
			"session/new",
			{ cwd, mcpServers: this.#mcpServers() },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown>;
		const sessionId = result.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error("ACP session/new returned no sessionId");
		}
		this.#updateSessionId = sessionId;
		this.#activeSessionId = sessionId;
		this.lastConfigOptions = result.configOptions;
		return { sessionId };
	}

	async resumeSession(sessionId: string, cwd: string): Promise<void> {
		const result = (await this.request(
			"session/resume",
			{ sessionId, cwd, mcpServers: this.#mcpServers() },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		this.#updateSessionId = sessionId;
		this.#activeSessionId = sessionId;
		this.lastConfigOptions = result?.configOptions;
	}

	async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
		const result = (await this.request(
			"session/set_config_option",
			{ sessionId, configId, value },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		this.lastConfigOptions = result?.configOptions;
	}

	/** Stateless prompt RPC; supports multiple concurrent in-flight prompts on
	 *  the same session (steer). No request timeout: driver timers govern turns. */
	async prompt(
		sessionId: string,
		text: string,
		images: readonly ToolResultImage[] = [],
	): Promise<{ stopReason: string; usage?: AgyUsage }> {
		const blocks: Array<Record<string, unknown>> = [
			...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
			{ type: "text", text },
		];
		const result = (await this.request("session/prompt", { sessionId, prompt: blocks })) as
			| Record<string, unknown>
			| undefined;
		const stopReason = result?.stopReason;
		if (typeof stopReason !== "string") {
			throw new Error("ACP session/prompt returned no stopReason");
		}
		const usage = parseAcpTurnUsage(result?.usage);
		if (usage) {
			this.#usageSeen = true;
			this.#exactUsageSeen = true;
		}
		return { stopReason, ...(usage ? { usage } : {}) };
	}

	cancel(sessionId: string): void {
		if (!this.#rpc || !this.alive) throw new Error("ACP connection is not running");
		this.#rpc.notify("session/cancel", { sessionId });
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.request("session/close", { sessionId }, SESSION_OP_TIMEOUT_MS);
		if (this.#activeSessionId === sessionId) {
			this.#activeSessionId = null;
		}
	}

	#onServerRequest(method: string, params: unknown): Promise<unknown> {
		if (method === "session/request_permission") {
			return this.#answerPermission(params as AcpPermissionRequest);
		}
		this.#opts.log("unsupported-server-request", { method });
		return Promise.reject(new Error(`client capability not enabled: ${method}`));
	}

	/** Center server runs agy inside an isolated profile; ACP permission requests
	 *  are unconditionally auto-approved by selecting the first allow option. */
	#answerPermission(params: AcpPermissionRequest): Promise<unknown> {
		const options = Array.isArray(params?.options) ? params.options : [];
		const allow = options.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));
		const chosen = (allow ?? options[0])?.optionId;
		this.#opts.log("permission", { optionId: chosen, policy: "auto" });
		return Promise.resolve(
			chosen !== undefined
				? { outcome: { outcome: "selected", optionId: chosen } }
				: { outcome: { outcome: "cancelled" } },
		);
	}

	#onNotification(method: string, params: unknown): void {
		if (method === "session/update") {
			if (!this.#usageSeen && frameCarriesUsage(params)) this.#usageSeen = true;
			if (this.#killed || this.#exited) return;
			const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
			const sessionId = typeof p.sessionId === "string" ? p.sessionId : this.#updateSessionId;
			this.#opts.onUpdate(sessionId, p.update);
			return;
		}
		if (method === "auth_required") {
			this.#opts.log("auth-required", params);
			return;
		}
		this.#opts.log("notification", { method });
	}

	async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (!this.#rpc || !this.alive) throw new Error("ACP connection is not running");
		try {
			return await this.#rpc.request(method, params, timeoutMs);
		} catch (err) {
			throw translateError(method, err);
		}
	}

	#mcpServers(): AcpMcpServer[] {
		try {
			return this.#opts.mcpServers?.() ?? [];
		} catch {
			return [];
		}
	}

	#write(frame: string): void {
		const stdin = this.#child?.stdin;
		if (!stdin || !stdin.writable || this.#exited) {
			this.abortAll("connection closed");
			return;
		}
		try {
			stdin.write(frame + "\n");
		} catch (err) {
			this.#opts.log("write-failed", { message: err instanceof Error ? err.message : String(err) });
			this.abortAll("connection closed");
		}
	}

	/** Reject every pending request. */
	abortAll(reason: string): void {
		this.#rpc?.abortAll(reason);
	}

	kill(): void {
		if (this.#killed) return;
		this.#killed = true;
		this.#activeSessionId = null;
		this.abortAll("connection killed");
		const child = this.#child;
		if (!child || this.#exited) return;
		this.#opts.log("kill", { pid: child.pid ?? "?" });
		try {
			if (child.pid && process.platform !== "win32") {
				process.kill(-child.pid, "SIGTERM");
				setTimeout(() => {
					try {
						if (!this.#exited && child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}, 750);
			} else {
				child.kill("SIGTERM");
			}
		} catch {
			/* already gone */
		}
	}

	waitForExit(): Promise<void> {
		return this.#exitPromise ?? Promise.resolve();
	}

	#finish(reason: string, code: number | null = null, signal: NodeJS.Signals | null = null): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#activeSessionId = null;
		this.abortAll(`connection exited: ${reason || "process gone"}`);
		this.#opts.onExit({ code, signal, stderrTail: redactText(this.#stderrTail) });
	}
}

/** ACP's optional per-turn PromptResponse.usage, distinct from
 *  session/usage_update context-window occupancy notifications. */
export function parseAcpTurnUsage(value: unknown): AgyUsage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const u = value as Record<string, unknown>;
	const count = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
	const input = count(u.inputTokens);
	const output = count(u.outputTokens);
	const total = count(u.totalTokens);
	const thought = count(u.thoughtTokens);
	const cacheRead = count(u.cachedReadTokens);
	if (input === undefined || output === undefined || total === undefined) return undefined;
	return {
		input_tokens: input,
		output_tokens: output,
		total_tokens: total,
		...(thought === undefined ? {} : { thinking_tokens: thought }),
		...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
	};
}

export function translateError(method: string, err: unknown): Error {
	if (err instanceof AcpAuthError) return err;
	if (err instanceof JsonRpcResponseError) {
		if (err.code === -32000) {
			const detail =
				typeof err.data === "object" && err.data !== null
					? (err.data as { message?: unknown }).message
					: undefined;
			const detailText = typeof detail === "string" ? `: ${detail}` : `: ${err.message}`;
			return new AcpAuthError(
				`ACP authentication required for ${method}${detailText}. Run agy in your terminal and complete Google sign-in, then restart pi.`,
			);
		}
		return err;
	}
	if (err instanceof Error) return err;
	return new Error(`ACP ${method} failed: ${String(err)}`);
}
