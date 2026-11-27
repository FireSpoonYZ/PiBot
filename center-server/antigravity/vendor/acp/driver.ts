// AcpDriver: native-turn ACP driver for agy 1.5.12+.
//
// Key mechanics:
//   - Hot turns on an already-bound live connection skip session/new and
//     session/resume, only applying model/thought_level when changed.
//   - Cold starts with an existing conversationId use session/resume and
//     unconditionally re-apply model, thought_level, and mode (section 9).
//   - Steer dispatches a concurrent session/prompt on the same session; the
//     turn stays open until the final in-flight prompt settles, merging usage.
//   - Cancel sends session/cancel without killing the process immediately,
//     keeping a 10s safety-net timer before forced teardown.

import { randomUUID } from "node:crypto";
import type {
	AgyUsage,
	DriverActivity,
	DriverSnapshot,
	DriverState,
	DriverTurnRequest,
	ToolResultImage,
	TurnDriver,
	TurnHandle,
	TurnOutcome,
	UsageEstimate,
} from "../driver-types.ts";
import { AcpAuthError, AcpConnection, type AcpMcpServer } from "./connection.ts";
import { type AcpEditDiff, mapStopReason, mapUpdate, TextAccumulator } from "./events.ts";
import { estimateTokens, synthesizeUsage } from "./usage-estimate.ts";

const LIFECYCLE_LIMIT = 24;
const CANCEL_SAFETY_NET_MS = 10_000;

export interface AcpDriverOptions {
	/** agy CLI binary. Tests may substitute node with a fake-server script. */
	bin: string | (() => string);
	/** Extra argv (production: ["acp", "--agent", ...]; tests: fake-server script). */
	binArgs?: string[] | ((request: DriverTurnRequest) => string[]);
	/** Isolated Gemini profile directory forwarded via `--gemini-dir`. */
	geminiDir?: string;
	extraEnv?: Record<string, string>;
	/** Enable private loopback PreInvocation hook listener for tool-result images. */
	enableToolImages?: boolean;
	/** Select a native effort using the just-selected model's session options. */
	resolveEffort?: (requested: string, configOptions: unknown) => string | undefined;
	/** Bridge registration for session/new and session/resume. */
	mcpServers?: () => AcpMcpServer[];
	/** Fallback usage synthesis when the server does not send PromptResponse.usage. */
	usageEstimate?: UsageEstimate | (() => UsageEstimate);
	log?: (msg: string, data?: unknown) => void;
}

interface AccumulatedUsage {
	hasExact: boolean;
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	hasThinking: boolean;
	hasCacheRead: boolean;
}

interface ActiveTurn {
	id: string;
	request: DriverTurnRequest;
	sessionId: string;
	buffer: DriverActivity[];
	wake: (() => void)[];
	closed: boolean;
	resolve: (o: TurnOutcome) => void;
	outcome: Promise<TurnOutcome>;
	response: TextAccumulator;
	textTokens: number;
	thoughtTokens: number;
	textDeltas: number;
	thoughtDeltas: number;
	estimatedInputTokens: number;
	toolBatches: number;
	toolBatchOpen: boolean;
	contextUsed: number | undefined;
	inFlightPrompts: number;
	accumulatedUsage: AccumulatedUsage;
	lastStopReason: string | undefined;
	sawResult: boolean;
	promptStarted: boolean;
	promptTerminal: boolean;
	aborted: boolean;
	abortedBy: "signal" | "timer" | null;
	timersPaused: boolean;
	overallDeadline: number | null;
	overallRemainingMs: number | null;
	overallTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	cancelTimer?: ReturnType<typeof setTimeout>;
	abortCleanup?: () => void;
	toolCalls: Map<string, { name: string; args: Record<string, unknown>; diff?: AcpEditDiff; mcpServer?: string }>;
}

/** Map mode onto ACP session modes. */
export function acpMode(mode?: string): string {
	return mode === "plan" ? "plan" : mode === "accept-edits" ? "accept-edits" : "default";
}

export class AcpDriver implements TurnDriver {
	#opts: AcpDriverOptions;
	#state: DriverState = "idle";
	#conn: AcpConnection | undefined;
	#pendingExits = new Set<Promise<void>>();
	#generation = 0;
	#active: ActiveTurn | undefined;
	#queueTail: Promise<void> = Promise.resolve();
	#lifecycle: string[] = [];
	#onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	#stats = {
		spawns: 0,
		turns: 0,
		prompts: 0,
		reused: 0,
		sessionsCreated: 0,
		sessionsLoaded: 0,
		kills: 0,
	};
	#serverVersion: string | undefined;
	#agentName: string | undefined;
	#appliedModel: string | null = null;
	#appliedEffort: string | null = null;
	#lastSessionId: string | undefined;
	#agentInfo: { name?: string; title?: string } | undefined;

	constructor(opts: AcpDriverOptions) {
		this.#opts = opts;
		this.#log("driver-created", { bin: typeof opts.bin === "function" ? "(resolved per turn)" : opts.bin });
	}

	get state(): DriverState {
		return this.#state;
	}

	get alive(): boolean {
		return Boolean(this.#conn?.alive);
	}

	get activeSessionId(): string | null {
		return this.#conn?.alive ? this.#conn.activeSessionId : null;
	}

	get activeHandle(): TurnHandle | null {
		const t = this.#active;
		return t && !t.closed ? this.#makeHandle(t) : null;
	}

	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined) {
		this.#onTurnEnd = fn;
	}

	pauseTimers(): void {
		const t = this.#active;
		if (!t || t.closed || t.timersPaused) return;
		t.timersPaused = true;
		this.#clearIdle(t);
		this.#pauseOverall(t);
		this.#log("timers-paused");
	}

	resumeTimers(): void {
		const t = this.#active;
		if (!t || t.closed || !t.timersPaused) return;
		t.timersPaused = false;
		this.#armIdle(t);
		this.#resumeOverall(t);
		this.#log("timers-resumed");
	}

	/** Send a steer prompt on the active native session while a turn is running.
	 *  Writes the JSON-RPC frame synchronously to stdin and returns without
	 *  waiting for the prompt to settle. */
	async steer(prompt: string, images?: ToolResultImage[]): Promise<void> {
		const turn = this.#active;
		const conn = this.#conn;
		if (!turn || turn.closed || turn.aborted || !turn.promptStarted || !conn?.alive) {
			throw Object.assign(new Error("Cannot steer: no active native Antigravity prompt"), {
				code: "INVALID_STATE",
			});
		}
		turn.estimatedInputTokens += estimateTokens(prompt);
		if (turn.idleTimer) turn.idleTimer.refresh();
		this.#log("steer", {
			sessionId: turn.sessionId,
			inFlight: turn.inFlightPrompts + 1,
			images: images?.length ?? 0,
		});
		this.#dispatchPrompt(turn, conn, prompt, images);
	}

	/** Queue tool-result images for delivery on the next PreInvocation hook of the active turn. */
	queueToolResultImages(toolCallId: string, images: readonly ToolResultImage[]): void {
		const turn = this.#active;
		if (!turn || turn.closed || turn.aborted || !turn.promptStarted || !this.#conn?.alive) {
			throw new Error("Tool image delivery requires an active native prompt");
		}
		this.#conn.queueToolResultImages(turn.sessionId, toolCallId, images);
	}

	cancel(): void {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		this.#abortTurn(turn);
	}

	/** Turns are serialized per driver instance. */
	run(request: DriverTurnRequest): Promise<TurnHandle> {
		let release!: () => void;
		const prev = this.#queueTail;
		this.#queueTail = new Promise<void>((r) => (release = r));
		return prev
			.then(() => this.#runExclusive(request))
			.then((handle) => {
				void handle.outcome.catch(() => {}).then(() => release());
				return handle;
			})
			.catch((err) => {
				release();
				throw err;
			});
	}

	#runExclusive(request: DriverTurnRequest): Promise<TurnHandle> {
		if (request.signal?.aborted) return Promise.reject(new Error("aborted before start"));

		const turn = this.#createTurn(request);
		this.#active = turn;
		this.#state = "running";
		this.#stats.turns += 1;
		this.#log("turn-start", {
			model: request.model,
			effort: request.effort,
			mode: request.mode ?? "default",
			agentName: request.agentName,
			conversation: request.conversationId ?? null,
			images: request.images?.length ?? 0,
		});

		if (request.signal) {
			const onAbort = () => this.#abortTurn(turn);
			if (request.signal.aborted) {
				onAbort();
			} else {
				request.signal.addEventListener("abort", onAbort, { once: true });
				turn.abortCleanup = () => request.signal!.removeEventListener("abort", onAbort);
			}
		}

		void this.#executeTurn(turn).catch((err: unknown) => {
			this.#failTurn(turn, `ACP turn failed: ${describe(err)}`);
		});
		return Promise.resolve(this.#makeHandle(turn));
	}

	async #executeTurn(turn: ActiveTurn): Promise<void> {
		const request = turn.request;
		const conn = await this.#ensureConnection(request);
		if (turn.closed) return;

		const hotReuse = Boolean(request.conversationId) && conn.alive && conn.activeSessionId === request.conversationId;
		if (hotReuse) {
			turn.sessionId = request.conversationId!;
			this.#stats.reused += 1;
			this.#log("session-reuse", { sessionId: turn.sessionId });
		} else {
			try {
				if (request.conversationId) {
					this.#log("session-resume", { sessionId: request.conversationId });
					this.#stats.sessionsLoaded += 1;
					await conn.resumeSession(request.conversationId, request.cwd);
					turn.sessionId = request.conversationId;
				} else {
					const created = await conn.newSession(request.cwd);
					turn.sessionId = created.sessionId;
					this.#stats.sessionsCreated += 1;
					this.#log("session-new", { sessionId: created.sessionId });
				}
			} catch (err) {
				if (turn.closed) return;
				if (turn.aborted) {
					this.#settle(turn, {
						conversationId: turn.sessionId,
						status: "OK",
						response: turn.response.text,
						finished: true,
						aborted: true,
					});
					return;
				}
				const sessionLoadFailed = Boolean(request.conversationId) && !(err instanceof AcpAuthError);
				this.#log(request.conversationId ? "session-resume-failed" : "session-new-failed", {
					sessionId: request.conversationId ?? null,
					message: err instanceof Error ? err.message : String(err),
				});
				this.#settle(turn, {
					conversationId: request.conversationId ?? turn.sessionId,
					status: "ERROR",
					response: turn.response.text,
					error: `ACP session failed: ${describe(err)}`,
					finished: true,
					aborted: false,
					...(sessionLoadFailed ? { sessionLoadFailed: true } : {}),
				});
				return;
			}
			// Cold new/resume always resets server-side model & thought_level to defaults
			// (section 9): clear local cache so they are re-applied below.
			this.#appliedModel = null;
			this.#appliedEffort = null;
		}
		if (turn.closed) return;

		// Apply model and thought_level when changed (or always after cold new/resume).
		try {
			if (request.model !== this.#appliedModel) {
				await conn.setConfigOption(turn.sessionId, "model", request.model);
				this.#appliedModel = request.model;
				this.#appliedEffort = null;
			}
			if (request.effort) {
				const effort = this.#opts.resolveEffort
					? this.#opts.resolveEffort(request.effort, conn.lastConfigOptions)
					: request.effort;
				if (effort && effort !== this.#appliedEffort) {
					await conn.setConfigOption(turn.sessionId, "thought_level", effort);
					this.#appliedEffort = effort;
				}
			}
		} catch (err) {
			if (turn.closed) return;
			if (turn.aborted) {
				this.#settle(turn, {
					conversationId: turn.sessionId,
					status: "OK",
					response: turn.response.text,
					finished: true,
					aborted: true,
				});
				return;
			}
			this.#failTurn(turn, `ACP model selection failed: ${describe(err)}`);
			return;
		}
		if (!hotReuse) {
			try {
				await conn.setConfigOption(turn.sessionId, "mode", acpMode(request.mode));
			} catch (err) {
				this.#log("mode-apply-failed", { message: describe(err) });
			}
		}
		if (turn.closed) return;

		this.#armOverall(turn);
		this.#armIdle(turn);
		this.#emitLiveEstimate(turn);

		try {
			if (turn.closed || turn.aborted || request.signal?.aborted) {
				if (!turn.closed) {
					this.#settle(turn, {
						conversationId: turn.sessionId,
						status: "OK",
						response: turn.response.text,
						finished: true,
						aborted: true,
					});
				}
				return;
			}
			await request.beforePrompt?.({ conversationId: turn.sessionId });
			if (turn.closed || turn.aborted || request.signal?.aborted) {
				if (!turn.closed) {
					this.#settle(turn, {
						conversationId: turn.sessionId,
						status: "OK",
						response: turn.response.text,
						finished: true,
						aborted: true,
					});
				}
				return;
			}
			conn.beginTurnHooks(turn.sessionId);
			turn.promptStarted = true;
			this.#dispatchPrompt(turn, conn, request.prompt, request.images);
		} catch (err) {
			if (turn.closed) return;
			const aborted = turn.aborted;
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: aborted ? "OK" : "ERROR",
				response: turn.response.text,
				error: aborted ? undefined : `ACP prompt failed: ${describe(err)}`,
				finished: true,
				aborted,
			});
		}
	}

	#dispatchPrompt(
		turn: ActiveTurn,
		conn: AcpConnection,
		prompt: string,
		images?: readonly ToolResultImage[],
	): void {
		turn.inFlightPrompts += 1;
		this.#stats.prompts += 1;
		void conn.prompt(turn.sessionId, prompt, images ?? []).then(
			(result) => {
				if (turn.closed) return;
				turn.inFlightPrompts = Math.max(0, turn.inFlightPrompts - 1);
				this.#accumulateUsage(turn, result.usage);
				turn.lastStopReason = result.stopReason;
				turn.promptTerminal = true;
				if (turn.inFlightPrompts > 0) {
					// Earlier prompt superseded by steer: keep turn & stream open
					// until the final in-flight prompt settles.
					return;
				}
				turn.sawResult = true;
				let settleUsage: AgyUsage | undefined;
				if (turn.accumulatedUsage.hasExact) {
					const merged: AgyUsage = {
						input_tokens: turn.accumulatedUsage.input_tokens,
						output_tokens: turn.accumulatedUsage.output_tokens,
						...(turn.accumulatedUsage.hasThinking
							? { thinking_tokens: turn.accumulatedUsage.thinking_tokens }
							: {}),
						...(turn.accumulatedUsage.hasCacheRead
							? { cache_read_tokens: turn.accumulatedUsage.cache_read_tokens }
							: {}),
					};
					settleUsage = this.#contextCorrectedUsage(turn, merged);
					this.#emit(turn, { type: "usage", usage: settleUsage });
				}
				const mapped = mapStopReason(turn.lastStopReason);
				if (mapped.status === "OK" && !mapped.aborted && !turn.aborted) {
					try {
						conn.assertTurnImagesDelivered();
					} catch (err) {
						this.#failTurn(turn, describe(err));
						return;
					}
				}
				this.#settle(turn, {
					conversationId: turn.sessionId,
					status: mapped.status,
					response: turn.response.text,
					usage: settleUsage,
					error: mapped.error,
					finished: true,
					aborted: mapped.aborted,
				});
			},
			(err: unknown) => {
				if (turn.closed) return;
				turn.inFlightPrompts = Math.max(0, turn.inFlightPrompts - 1);
				const aborted = turn.aborted;
				if (aborted && turn.inFlightPrompts > 0) {
					return;
				}
				this.#settle(turn, {
					conversationId: turn.sessionId,
					status: aborted ? "OK" : "ERROR",
					response: turn.response.text,
					error: aborted ? undefined : `ACP prompt failed: ${describe(err)}`,
					finished: true,
					aborted,
				});
			},
		);
	}

	#accumulateUsage(turn: ActiveTurn, usage: AgyUsage | undefined): void {
		if (!usage) return;
		turn.accumulatedUsage.hasExact = true;
		turn.accumulatedUsage.input_tokens += usage.input_tokens ?? 0;
		turn.accumulatedUsage.output_tokens += usage.output_tokens ?? 0;
		if (usage.thinking_tokens !== undefined) {
			turn.accumulatedUsage.hasThinking = true;
			turn.accumulatedUsage.thinking_tokens += usage.thinking_tokens;
		}
		if (usage.cache_read_tokens !== undefined) {
			turn.accumulatedUsage.hasCacheRead = true;
			turn.accumulatedUsage.cache_read_tokens += usage.cache_read_tokens;
		}
	}

	#makeHandle(turn: ActiveTurn): TurnHandle {
		return {
			id: turn.id,
			outcome: turn.outcome,
			next: () => this.#nextActivity(turn),
		};
	}

	async #nextActivity(turn: ActiveTurn): Promise<DriverActivity | null> {
		for (;;) {
			if (turn.buffer.length > 0) return turn.buffer.shift() ?? null;
			if (turn.closed) return null;
			await new Promise<void>((r) => turn.wake.push(r));
		}
	}

	#emit(turn: ActiveTurn, activity: DriverActivity): void {
		if (turn.closed) return;
		if (turn.wake.length > 0) turn.wake.shift()!();
		turn.buffer.push(activity);
	}

	#onConnectionUpdate(sessionId: string | null, update: unknown): void {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		if (sessionId !== null && sessionId !== turn.sessionId) return;
		if (turn.idleTimer) turn.idleTimer.refresh();
		const mapped = mapUpdate(update);
		if (!mapped) return;
		switch (mapped.kind) {
			case "text": {
				const emit = turn.response.append(mapped.delta);
				if (emit) {
					turn.textDeltas += 1;
					turn.textTokens += estimateTokens(emit);
					turn.toolBatchOpen = false;
					this.#emitLiveEstimate(turn);
					this.#emit(turn, { type: "text", delta: emit });
				}
				return;
			}
			case "thought": {
				if (!mapped.delta) return;
				turn.thoughtDeltas += 1;
				turn.thoughtTokens += estimateTokens(mapped.delta);
				turn.toolBatchOpen = false;
				this.#emitLiveEstimate(turn);
				this.#emit(turn, { type: "thought", delta: mapped.delta });
				return;
			}
			case "usage": {
				turn.contextUsed = mapped.used;
				this.#emit(turn, { type: "usage", usage: { total_tokens: mapped.used } });
				return;
			}
			case "tool_start": {
				if (!turn.toolBatchOpen) {
					turn.toolBatches += 1;
					turn.toolBatchOpen = true;
				}
				const entry = { name: mapped.name, args: mapped.args, diff: mapped.diff, mcpServer: mapped.mcpServer };
				turn.toolCalls.set(mapped.toolCallId, entry);
				this.#emit(turn, {
					type: "tool_start",
					name: mapped.name,
					args: mapped.args,
					mcpServer: mapped.mcpServer,
					toolCallId: mapped.toolCallId,
				});
				return;
			}
			case "tool_done": {
				let entry = turn.toolCalls.get(mapped.toolCallId);
				if (!entry && turn.toolCalls.size === 1) {
					entry = turn.toolCalls.values().next().value;
					turn.toolCalls.clear();
				}
				turn.toolCalls.delete(mapped.toolCallId);
				const name = entry?.name ?? "tool";
				const args = entry?.args ?? {};
				this.#emit(turn, {
					type: "tool_done",
					name,
					args,
					output: mapped.output,
					diff: mapped.diff ?? entry?.diff,
					mcpServer: mapped.mcpServer ?? entry?.mcpServer,
					toolCallId: mapped.toolCallId,
				});
				return;
			}
			case "tool_error": {
				const entry = turn.toolCalls.get(mapped.toolCallId);
				turn.toolCalls.delete(mapped.toolCallId);
				const name = entry?.name ?? "tool";
				this.#emit(turn, {
					type: "tool_error",
					name,
					message: mapped.message,
					mcpServer: mapped.mcpServer ?? entry?.mcpServer,
					toolCallId: mapped.toolCallId,
				});
				return;
			}
			case "replay_user":
				return;
		}
	}

	#onConnectionExit(conn: AcpConnection, info: { code: number | null; signal: string | null; stderrTail: string }): void {
		if (this.#conn !== conn) {
			this.#log("stale-connection-exited", { tail: info.stderrTail.slice(-200) });
			return;
		}
		const turn = this.#active;
		this.#conn = undefined;
		this.#agentName = undefined;
		this.#appliedModel = null;
		this.#appliedEffort = null;
		this.#state = "dead";
		const turnActive = Boolean(turn && !turn.closed && !turn.aborted && !turn.sawResult);
		this.#log("connection-exited", {
			expected: !turnActive,
			code: info.code,
			signal: info.signal,
			tail: info.stderrTail.slice(-200),
		});
		if (!turn || turn.closed) return;
		if (turn.aborted || turn.sawResult) {
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: turn.response.text.length > 0 || turn.sawResult ? "OK" : "UNKNOWN",
				response: turn.response.text,
				finished: true,
				aborted: turn.aborted,
			});
			return;
		}
		const where = info.signal ? ` (signal ${info.signal})` : info.code !== null ? ` (code ${info.code})` : "";
		this.#failTurn(turn, `Antigravity session exited unexpectedly${where}; it restarts on the next turn`);
	}

	#ensureConnection(request: DriverTurnRequest): Promise<AcpConnection> {
		const previous = this.#conn;
		if (previous?.alive) {
			if (request.agentName === this.#agentName && !previous.toolImagesUnavailable) {
				return Promise.resolve(previous);
			}
			const prevAgent = this.#agentName;
			this.#conn = undefined;
			this.#agentName = undefined;
			this.#appliedModel = null;
			this.#appliedEffort = null;
			this.#log(previous.toolImagesUnavailable ? "recycle-tool-image-hook" : "recycle-agent-changed", {
				from: prevAgent,
				to: request.agentName,
			});
			previous.abortAll(previous.toolImagesUnavailable ? "tool image hook unavailable" : "native agent changed");
			previous.kill();
		}
		this.#generation += 1;
		this.#state = "starting";
		this.#stats.spawns += 1;
		this.#appliedModel = null;
		this.#appliedEffort = null;
		const conn = new AcpConnection({
			bin: typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin,
			binArgs: typeof this.#opts.binArgs === "function" ? this.#opts.binArgs(request) : this.#opts.binArgs,
			geminiDir: this.#opts.geminiDir,
			extraEnv: this.#opts.extraEnv,
			enableToolImages: this.#opts.enableToolImages,
			cwd: request.cwd,
			mcpServers: this.#opts.mcpServers,
			log: (msg, data) => this.#log(msg, data),
			onUpdate: (sessionId, update) => this.#onConnectionUpdate(sessionId, update),
			onExit: (info) => this.#onConnectionExit(conn, info),
		});
		this.#conn = conn;
		this.#agentName = request.agentName;
		this.#log("spawn", { bin: typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin });
		const started = conn.start();
		const exitWait = conn.waitForExit().finally(() => {
			this.#pendingExits.delete(exitWait);
		});
		this.#pendingExits.add(exitWait);
		return started
			.then(() => {
				if (this.#conn !== conn || !conn.alive) throw new Error("ACP connection closed during startup");
				this.#serverVersion = conn.serverVersion();
				const info = conn.agentInfo as { name?: unknown; title?: unknown } | undefined;
				this.#agentInfo = {
					name: typeof info?.name === "string" ? info.name : undefined,
					title: typeof info?.title === "string" ? info.title : undefined,
				};
				this.#state = "ready";
				return conn;
			})
			.catch((err) => {
				if (this.#conn === conn) {
					this.#state = "dead";
					this.#conn = undefined;
					this.#agentName = undefined;
					this.#appliedModel = null;
					this.#appliedEffort = null;
				}
				conn.kill();
				this.#log("start-failed", { message: describe(err) });
				throw err;
			});
	}

	/** Send native session/cancel, waiting up to 10s before falling back to teardown. */
	#abortTurn(turn: ActiveTurn): void {
		if (turn.closed || turn.aborted) return;
		turn.aborted = true;
		turn.abortedBy = "signal";
		const conn = this.#conn;
		if (turn.sessionId) conn?.cancelTurnHooks(turn.sessionId);
		if (!conn?.alive || turn.sessionId === "" || !turn.promptStarted) {
			this.#teardownAbort(turn);
			return;
		}
		try {
			conn.cancel(turn.sessionId);
			turn.cancelTimer = setTimeout(() => {
				if (!turn.closed) this.#teardownAbort(turn);
			}, CANCEL_SAFETY_NET_MS);
			turn.cancelTimer.unref?.();
		} catch (err) {
			this.#log("cancel-failed", { message: describe(err) });
			this.#teardownAbort(turn);
		}
	}

	#teardownAbort(turn: ActiveTurn): void {
		this.#stats.kills += 1;
		this.#log("teardown-abort", { sessionId: turn.sessionId });
		turn.aborted = true;
		this.#conn?.abortAll("abort: connection torn down");
		this.#conn?.kill();
	}

	#createTurn(request: DriverTurnRequest): ActiveTurn {
		let resolve!: (o: TurnOutcome) => void;
		const outcome = new Promise<TurnOutcome>((r) => (resolve = r));
		return {
			id: randomUUID().slice(0, 8),
			request,
			sessionId: "",
			buffer: [],
			wake: [],
			closed: false,
			resolve,
			outcome,
			response: new TextAccumulator(),
			textTokens: 0,
			thoughtTokens: 0,
			textDeltas: 0,
			thoughtDeltas: 0,
			estimatedInputTokens: estimateTokens(request.prompt),
			toolBatches: 0,
			toolBatchOpen: false,
			contextUsed: undefined,
			inFlightPrompts: 0,
			accumulatedUsage: {
				hasExact: false,
				input_tokens: 0,
				output_tokens: 0,
				thinking_tokens: 0,
				cache_read_tokens: 0,
				hasThinking: false,
				hasCacheRead: false,
			},
			lastStopReason: undefined,
			sawResult: false,
			promptStarted: false,
			promptTerminal: false,
			aborted: false,
			abortedBy: null,
			timersPaused: false,
			overallDeadline: null,
			overallRemainingMs: null,
			toolCalls: new Map(),
		};
	}

	// --- timers ----------------------------------------------------------------

	#overallBudgetMs(turn: ActiveTurn): number {
		return (turn.request.timeoutMin ?? 10) * 60_000;
	}

	#idleBudgetMs(turn: ActiveTurn): number {
		return (turn.request.inactivityMin ?? 5) * 60_000;
	}

	#nowMs(): number {
		return Date.now();
	}

	#armOverall(turn: ActiveTurn): void {
		const budget = this.#overallBudgetMs(turn);
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		if (turn.timersPaused) {
			turn.overallDeadline = null;
			turn.overallRemainingMs = budget;
			return;
		}
		turn.overallRemainingMs = null;
		this.#startOverallTimer(turn, budget);
	}

	#startOverallTimer(turn: ActiveTurn, ms: number): void {
		if (ms <= 0) return;
		turn.overallDeadline = this.#nowMs() + ms;
		turn.overallTimer = setTimeout(() => {
			if (turn.closed) return;
			turn.abortedBy = "timer";
			this.#log("timeout", { sessionId: turn.sessionId });
			this.#conn?.abortAll("turn deadline");
			this.#conn?.kill();
			this.#failTurn(turn, `ACP turn exceeded the ${(this.#overallBudgetMs(turn) / 60_000) | 0}m deadline`);
		}, ms);
	}

	#pauseOverall(turn: ActiveTurn): void {
		if (turn.overallDeadline === null) return;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		turn.overallTimer = undefined;
		turn.overallRemainingMs = Math.max(0, turn.overallDeadline - this.#nowMs());
		turn.overallDeadline = null;
	}

	#resumeOverall(turn: ActiveTurn): void {
		if (turn.overallRemainingMs === null) return;
		const remaining = turn.overallRemainingMs;
		turn.overallRemainingMs = null;
		this.#startOverallTimer(turn, remaining);
	}

	#armIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		if (turn.timersPaused) return;
		const idleMs = this.#idleBudgetMs(turn);
		if (idleMs <= 0) return;
		turn.idleTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log("stall", { sessionId: turn.sessionId });
			this.#conn?.abortAll("idle stall");
			this.#conn?.kill();
			this.#failTurn(turn, `ACP stalled for ${(idleMs / 60_000) | 0}m with no output`);
		}, idleMs);
	}

	#clearIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		turn.idleTimer = undefined;
	}

	// --- settling ----------------------------------------------------------------

	#settle(turn: ActiveTurn, outcome: TurnOutcome): void {
		if (turn.closed) return;
		const flushed = turn.response.flush();
		if (flushed) {
			turn.textDeltas += 1;
			turn.textTokens += estimateTokens(flushed);
			this.#emit(turn, { type: "text", delta: flushed });
		}
		outcome.response = turn.response.text;
		outcome.promptAttempted = turn.promptStarted;
		outcome.promptTerminal = turn.promptTerminal;
		if (outcome.status === "OK" && !outcome.aborted && outcome.usage === undefined) {
			const usage = this.#syntheticUsage(turn);
			if (usage) {
				outcome.usage = usage;
				this.#emit(turn, { type: "usage", usage });
			}
		}
		turn.closed = true;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		if (turn.cancelTimer) {
			clearTimeout(turn.cancelTimer);
			turn.cancelTimer = undefined;
		}
		turn.abortCleanup?.();
		turn.abortCleanup = undefined;
		this.#conn?.releaseTurnHooks();
		this.#active = undefined;
		this.#state = this.#conn?.alive ? "ready" : "dead";
		if (outcome.conversationId) this.#lastSessionId = outcome.conversationId;
		for (const wake of turn.wake) wake();
		turn.wake = [];
		if (outcome.aborted && turn.abortedBy === null) turn.abortedBy = "signal";
		turn.resolve(outcome);
		try {
			this.#onTurnEnd?.(outcome);
		} catch {
			/* listener errors must not break settling */
		}
	}

	#failTurn(turn: ActiveTurn, message: string): void {
		this.#settle(turn, {
			conversationId: turn.sessionId,
			status: "ERROR",
			response: turn.response.text,
			error: message,
			finished: true,
			aborted: turn.aborted,
		});
	}

	#usageMode(): UsageEstimate {
		const opt = this.#opts.usageEstimate;
		return (typeof opt === "function" ? opt() : opt) ?? "estimate";
	}

	#emitLiveEstimate(turn: ActiveTurn): void {
		const usage = this.#syntheticUsage(turn);
		if (usage) this.#emit(turn, { type: "usage", usage });
	}

	#syntheticUsage(turn: ActiveTurn): AgyUsage | undefined {
		const mode = this.#usageMode();
		if (mode === "off") return undefined;
		if (this.#conn?.exactUsageSeen) return undefined;
		const usage = synthesizeUsage({
			mode,
			prompt: turn.request.prompt,
			inputTokens: turn.estimatedInputTokens,
			textTokens: turn.textTokens,
			thoughtTokens: turn.thoughtTokens,
			textDeltas: turn.textDeltas,
			thoughtDeltas: turn.thoughtDeltas,
		});
		if (usage && turn.contextUsed !== undefined) return { ...usage, total_tokens: turn.contextUsed };
		return usage;
	}

	#contextCorrectedUsage(turn: ActiveTurn, usage: AgyUsage): AgyUsage {
		return { ...usage, total_tokens: turn.contextUsed ?? this.#derivedContextTokens(turn, usage) };
	}

	#derivedContextTokens(turn: ActiveTurn, usage: AgyUsage): number {
		const input = usage.input_tokens ?? 0;
		const output = usage.output_tokens ?? 0;
		const cacheRead = usage.cache_read_tokens ?? 0;
		return input + output + Math.ceil(cacheRead / (turn.toolBatches + 1));
	}

	#log(msg: string, data?: unknown): void {
		const line = `${new Date().toISOString().slice(11, 19)} ${msg}${data !== undefined ? ` ${JSON.stringify(data)}` : ""}`;
		this.#lifecycle.push(line);
		if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
		this.#opts.log?.(msg, data);
	}

	// --- TurnDriver surface ----------------------------------------------------

	async close(reason: "recycle" | "shutdown", cause?: string): Promise<void> {
		this.#log(`close:${reason}${cause ? `:${cause}` : ""}`);
		const turn = this.#active;
		if (turn && !turn.closed) {
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: "ERROR",
				response: turn.response.text,
				error: `ACP driver ${reason === "recycle" ? "recycled" : "shut down"} mid-turn${cause ? ` (${cause})` : ""}`,
				finished: true,
				aborted: false,
			});
		}
		this.#conn?.abortAll(`driver ${reason}`);
		this.#conn?.kill();
		this.#conn = undefined;
		this.#agentName = undefined;
		this.#appliedModel = null;
		this.#appliedEffort = null;
		this.#state = "dead";
		if (this.#pendingExits.size > 0) {
			await Promise.allSettled([...this.#pendingExits]);
		}
	}

	snapshot(): DriverSnapshot {
		const sessionId = (this.#active?.sessionId || undefined) ?? this.#conn?.activeSessionId ?? this.#lastSessionId;
		return {
			state: this.#state,
			pid: this.#conn?.pid,
			conversationId: sessionId,
			stats: {
				spawns: this.#stats.spawns,
				turns: this.#stats.turns,
				reused: this.#stats.reused,
				recycles: this.#stats.kills,
				lastRecycleReason: undefined,
				recycleReasons: {},
			},
			lifecycle: [...this.#lifecycle],
			engine: "acp",
			acp: {
				sessionId,
				prompts: this.#stats.prompts,
				sessionsCreated: this.#stats.sessionsCreated,
				sessionsLoaded: this.#stats.sessionsLoaded,
				kills: this.#stats.kills,
				serverVersion: this.#serverVersion,
				reconnects: Math.max(0, this.#stats.spawns - 1),
				agentName: this.#agentInfo?.name,
				agentTitle: this.#agentInfo?.title,
				usageSeen: this.#conn?.usageSeen ?? false,
			},
		};
	}
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export type { AcpMcpServer } from "./connection.ts";
