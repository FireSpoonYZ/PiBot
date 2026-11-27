// Center Antigravity ACP bridge service.
//
// Exports openAntigravity({ dataRoot, bin, geminiHome, escalateAfterMs } = {}) returning:
//   - authStatus({ signal } = {}) => Promise<{ authenticated: boolean }>
//   - login({ notify, prompt, signal } = {}) => Promise<void>
//   - logout() => Promise<void>
//   - catalog({ signal } = {}) => Promise<Model[]>
//   - run(params, { signal } = {}) => AsyncIterable<AntigravityRunEvent>
//   - submitToolResult({ deviceId, sessionId, runId, callId, content, isError }) => Promise<{ ok: true }>
//   - steer({ deviceId, sessionId, runId, sections, routeNote, inputs }) => Promise<{ ok: true }>
//   - cancel({ deviceId, sessionId, runId? }) => Promise<void>
//   - close() => Promise<void>

import {
	AGY_HISTORY_CHANGED,
	ANTIGRAVITY_ESCALATE_AFTER_MS,
} from "../../center-contract/antigravity.js";
import { hasStoredAcpAuthToken, loginAcpProfile, logoutAcpProfile, probeAcpAuth } from "./auth.ts";
import { probeAcpCatalog, resolveSessionThoughtLevel } from "./catalog.ts";
import { SharedMcpBridge } from "./mcp-bridge.ts";
import {
	AGENT_NAME,
	ensureSessionAgent,
	resolveProfile,
	sessionAgentName,
} from "./profile.ts";
import { makeSessionKey, SessionStore } from "./sessions.ts";
import {
	assertPromptFits,
	formatTurnPrompt,
	isAllowedBridgeServer,
	POLL_TOOL_NAME,
	RunToolWaiters,
	toMcpToolDefinitions,
} from "./tool-waiters.ts";
import { AcpDriver } from "./vendor/acp/driver.ts";
import { redactText } from "./vendor/redact.ts";

const AUTH_CACHE_TTL_MS = 60_000;
const MAX_IDLE_SESSIONS = 64;

function isValidId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 256 &&
		value.isWellFormed() && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function createAbortError(message) {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

function createStateError(message) {
	return Object.assign(new Error(message), { code: "INVALID_STATE", statusCode: 409 });
}

function createArgumentError(message) {
	return Object.assign(new Error(message), { code: "INVALID_ARGUMENT", statusCode: 400 });
}

function awaitWithAbort(promise, signal, message = "Antigravity auth check aborted") {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(createAbortError(message));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(createAbortError(message));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

function toPiUsagePartial(usage) {
	if (!usage || typeof usage !== "object") return null;
	const out = {};
	if (typeof usage.input_tokens === "number") out.input = usage.input_tokens;
	if (typeof usage.output_tokens === "number" || typeof usage.thinking_tokens === "number") {
		out.output = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
	}
	if (typeof usage.cache_read_tokens === "number") out.cacheRead = usage.cache_read_tokens;
	if (typeof usage.total_tokens === "number") out.totalTokens = usage.total_tokens;
	return Object.keys(out).length > 0 ? out : null;
}

function toAntigravityUsage(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	const input = usage.input_tokens ?? 0;
	const output = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
	const cacheRead = usage.cache_read_tokens ?? 0;
	const cacheWrite = 0;
	const totalTokens = usage.total_tokens ?? (input + output + cacheRead);
	return { input, output, cacheRead, cacheWrite, totalTokens };
}

function createEventStream({ onClose } = {}) {
	const queue = [];
	const waiters = [];
	let ended = false;

	const push = (event) => {
		if (ended) return;
		if (waiters.length > 0) {
			waiters.shift()({ value: event, done: false });
		} else {
			queue.push(event);
		}
	};

	const end = () => {
		if (ended) return;
		ended = true;
		while (waiters.length > 0) {
			waiters.shift()({ value: undefined, done: true });
		}
	};

	const iterable = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (queue.length > 0) {
						return Promise.resolve({ value: queue.shift(), done: false });
					}
					if (ended) {
						return Promise.resolve({ value: undefined, done: true });
					}
					return new Promise((resolve) => {
						waiters.push(resolve);
					});
				},
				return() {
					end();
					onClose?.();
					return Promise.resolve({ value: undefined, done: true });
				},
			};
		},
	};

	return { iterable, push, end };
}

export function openAntigravity({ dataRoot, bin, geminiHome, escalateAfterMs } = {}) {
	const profile = resolveProfile({ dataRoot, bin, geminiHome });
	const usesDefaultAgyBin = bin === undefined && !process.env.PIBOT_AGY_BIN;
	const store = new SessionStore(profile.sessionsPath);
	const mcpBridge = new SharedMcpBridge();
	const sessions = new Map();
	const activeCatalogs = new Set();
	const activeAuthProbes = new Set();
	let activeLogin = null;
	let cachedAuth = null;
	let inflightAuthStatus = null;
	let authEpoch = 0;
	let closed = false;
	let idleTrim = Promise.resolve();

	function invalidateAuthCacheIfNeeded(err) {
		if (
			err?.code === "UNAUTHENTICATED" ||
			err?.name === "AcpAuthError" ||
			(typeof err === "string" && /authentication required|UNAUTHENTICATED/i.test(err))
		) {
			authEpoch += 1;
			cachedAuth = null;
		}
	}

	function invalidateMcpRegistration(slot) {
		const registration = slot.mcpRegistration;
		slot.mcpRegistration = null;
		slot.mcpToken = "";
		registration?.unregister();
	}

	function registerConnectionMcp(slot) {
		invalidateMcpRegistration(slot);
		const reg = mcpBridge.registerSession({
			listTools: () => slot.currentTools,
			captureContext: () => slot.activeRun,
			onToolCall: async (callId, name, args, mcpSignal, capturedRun) => {
				if (slot.mcpRegistration !== reg) {
					throw new Error("Antigravity MCP registration is no longer active");
				}
				if (!capturedRun || capturedRun !== slot.activeRun || capturedRun.aborted || capturedRun.deliveryError) {
					throw new Error("Antigravity MCP call belongs to an inactive run");
				}
				if (name !== POLL_TOOL_NAME && !capturedRun.allowedToolNames.has(name)) {
					return {
						content: [{ type: "text", text: `Error: unknown or unavailable tool "${name}"` }],
						isError: true,
					};
				}
				return await capturedRun.waiters.handleToolCall(callId, name, args, mcpSignal);
			},
			onDeliveryError: (error) => {
				if (slot.mcpRegistration !== reg) return;
				const run = slot.activeRun;
				invalidateMcpRegistration(slot);
				if (run) {
					if (!run.aborted) {
						run.deliveryError ??= error;
					}
					run.waiters.failAll("Antigravity MCP result delivery failed");
					if (!run.abortController.signal.aborted) {
						run.abortController.abort();
					}
					run.recyclePromise ??= slot.driver.close("recycle", "mcp delivery error").catch(() => {});
				}
			},
		});
		slot.mcpRegistration = reg;
		slot.mcpToken = reg.token;
		return reg;
	}

	function getOrCreateSession(deviceId, sessionId) {
		const key = makeSessionKey(deviceId, sessionId);
		let slot = sessions.get(key);
		if (slot) return slot;

		const driver = new AcpDriver({
			bin: profile.bin,
			binArgs: (request) => ["acp", "--agent", request.agentName || AGENT_NAME, "--process-per-session"],
			geminiDir: profile.geminiHome,
			enableToolImages: true,
			resolveEffort: resolveSessionThoughtLevel,
			mcpServers: () => (slot.mcpToken ? [mcpBridge.serverConfig(slot.mcpToken)] : []),
		});

		slot = {
			key,
			deviceId,
			sessionId,
			driver,
			mcpToken: "",
			mcpRegistration: null,
			currentTools: [],
			activeRun: null,
			queuedRuns: new Set(),
			serialChain: Promise.resolve(),
			serialUsers: 0,
			retiring: false,
			lastUsedAt: Date.now(),
		};

		driver.onTurnEnd = () => {
			if (!driver.alive && slot.mcpRegistration) {
				invalidateMcpRegistration(slot);
			}
			void trimIdleSessions();
		};

		sessions.set(key, slot);
		return slot;
	}

	function isIdleSlot(slot) {
		return !slot.activeRun && slot.queuedRuns.size === 0 && slot.serialUsers === 0 && !slot.driver.activeHandle;
	}

	async function retireSessionResources(slot, reason) {
		const run = slot.activeRun;
		if (run) {
			run.aborted = true;
			run.waiters.failAll(reason);
			if (!run.abortController.signal.aborted) {
				run.abortController.abort();
			}
		}
		invalidateMcpRegistration(slot);
		await slot.driver.close("recycle", reason);
	}

	function trimIdleSessions() {
		idleTrim = idleTrim.then(async () => {
			if (closed) return;
			const idle = [...sessions.values()]
				.filter((slot) => !slot.retiring && isIdleSlot(slot))
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
			for (const slot of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_SESSIONS))) {
				if (closed || slot.retiring || !isIdleSlot(slot) || sessions.get(slot.key) !== slot) continue;
				slot.retiring = true;
				let release;
				const prev = slot.serialChain;
				slot.serialChain = new Promise((resolve) => { release = resolve; });
				try {
					await prev;
					if (closed || !isIdleSlot(slot)) continue;
					await retireSessionResources(slot, "idle session limit");
					if (isIdleSlot(slot) && sessions.get(slot.key) === slot) {
						sessions.delete(slot.key);
					}
				} finally {
					slot.retiring = false;
					release();
				}
			}
		}).catch((error) => {
			console.warn(`[antigravity] idle cleanup failed: ${redactText(String(error))}`);
		});
		return idleTrim;
	}

	async function recycleIdleDrivers(reason) {
		const tasks = [];
		for (const slot of [...sessions.values()]) {
			if (!isIdleSlot(slot) || slot.retiring || slot.driver.state !== "ready") {
				continue;
			}
			let release;
			slot.serialUsers += 1;
			const prev = slot.serialChain;
			slot.serialChain = new Promise((resolve) => {
				release = resolve;
			});
			tasks.push(
				prev
					.then(async () => {
						if (
							!closed &&
							!slot.activeRun &&
							slot.queuedRuns.size === 0 &&
							!slot.driver.activeHandle &&
							slot.driver.state === "ready"
						) {
							await retireSessionResources(slot, reason);
						}
					})
					.catch(() => {})
					.finally(() => {
						slot.serialUsers -= 1;
						release();
					}),
			);
		}
		if (tasks.length > 0) {
			await Promise.allSettled(tasks);
		}
		await trimIdleSessions();
	}

	async function executeRun(stream, params, signal, onAbortRef) {
		const {
			deviceId,
			sessionId,
			runId,
			modelId,
			reasoning,
			initialSystemPrompt,
			tools,
			sections,
			routeNote,
			inputs,
		} = params;

		if (
			closed ||
			typeof deviceId !== "string" || !deviceId ||
			typeof sessionId !== "string" || !sessionId ||
			!isValidId(runId) ||
			typeof modelId !== "string" || !modelId ||
			!Array.isArray(inputs) || inputs.length === 0
		) {
			stream.push({ type: "error", message: "Invalid or closed Antigravity run" });
			stream.end();
			return;
		}

		const slot = getOrCreateSession(deviceId, sessionId);
		const queued = { runId, cancelled: false };
		slot.queuedRuns.add(queued);
		slot.serialUsers += 1;

		let releaseSerial;
		const previousSerial = slot.serialChain;
		slot.serialChain = new Promise((resolve) => { releaseSerial = resolve; });

		let run = null;
		let runFinished = false;
		let detachCallerSignal = null;

		const abortRun = (reason = "Operation aborted") => {
			if (runFinished) return;
			queued.cancelled = true;
			if (!run) return;
			run.aborted = true;
			run.waiters.failAll(reason);
			if (!run.abortController.signal.aborted) {
				run.abortController.abort();
			}
		};
		onAbortRef.current = () => abortRun("Antigravity stream closed");

		const isCancelled = () => closed || signal?.aborted || queued.cancelled || Boolean(run?.aborted);

		try {
			await previousSerial;
			slot.queuedRuns.delete(queued);
			if (isCancelled()) {
				stream.push({ type: "error", message: "Operation aborted", aborted: true });
				return;
			}

			const existing = store.get(slot.key);
			if (existing?.legacy === true) {
				stream.push({
					type: "error",
					code: AGY_HISTORY_CHANGED,
					message: "Legacy Antigravity session binding requires /clear",
				});
				return;
			}

			const formatted = formatTurnPrompt({ sections, routeNote, inputs });
			assertPromptFits(formatted.text, formatted.images);

			let agentName;
			if (!existing) {
				agentName = sessionAgentName(slot.key);
				ensureSessionAgent(profile, {
					agentName,
					initialSystemPrompt: typeof initialSystemPrompt === "string" ? initialSystemPrompt : "",
				});
			} else {
				agentName = ensureSessionAgent(profile, { agentName: existing.agentName });
			}

			await mcpBridge.ensureStarted();
			if (isCancelled()) {
				stream.push({ type: "error", message: "Operation aborted", aborted: true });
				return;
			}

			const mcpTools = toMcpToolDefinitions(Array.isArray(tools) ? tools : []);
			slot.currentTools = mcpTools;
			if (!slot.driver.alive && slot.mcpRegistration) {
				invalidateMcpRegistration(slot);
			}
			if (!slot.mcpRegistration) {
				if (slot.driver.alive) {
					await slot.driver.close("recycle", "mcp registration reset").catch(() => {});
				}
				registerConnectionMcp(slot);
			}

			const runAbort = new AbortController();
			let timersPaused = false;
			let resolveSettled;
			const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });

			const hasToolImageHook = !existing || existing.toolImageHook === true;
			const waiters = new RunToolWaiters({
				escalateAfterMs: escalateAfterMs ?? ANTIGRAVITY_ESCALATE_AFTER_MS,
				onToolRequest: ({ callId, name, args }) => {
					if (!run || run.aborted || run.deliveryError) return;
					stream.push({ type: "tool_request", callId, name, args });
				},
				onInFlightChange: (count) => {
					if (count > 0 && !timersPaused) {
						timersPaused = true;
						slot.driver.pauseTimers();
					} else if (count === 0 && timersPaused) {
						timersPaused = false;
						slot.driver.resumeTimers();
					}
				},
				deliverToolImages: (callId, images) => {
					if (!run || run.aborted || run.deliveryError) {
						throw new Error("Active Antigravity run is no longer available");
					}
					if (!run.hasToolImageHook) {
						const err = Object.assign(
							new Error("This Antigravity session was created without tool-image hook support; use /clear to start a new session."),
							{ code: AGY_HISTORY_CHANGED },
						);
						run.incompatibleImageError ??= err;
						run.aborted = true;
						run.waiters.failAll(err.message);
						if (!run.abortController.signal.aborted) {
							run.abortController.abort();
						}
						throw err;
					}
					if (typeof slot.driver.queueToolResultImages !== "function") {
						throw new Error("Tool image delivery hook is unavailable");
					}
					slot.driver.queueToolResultImages(callId, images);
				},
			});

			run = {
				runId,
				abortController: runAbort,
				waiters,
				allowedToolNames: new Set(mcpTools.map((tool) => tool.name)),
				hasToolImageHook,
				aborted: false,
				deliveryError: null,
				incompatibleImageError: null,
				recyclePromise: null,
				handle: null,
				settledPromise,
				resolveSettled,
			};
			slot.activeRun = run;

			if (signal) {
				const onCallerAbort = () => abortRun("Operation aborted");
				if (signal.aborted) {
					onCallerAbort();
				} else {
					signal.addEventListener("abort", onCallerAbort, { once: true });
					detachCallerSignal = () => signal.removeEventListener("abort", onCallerAbort);
				}
			}

			if (isCancelled()) {
				stream.push({ type: "error", message: "Operation aborted", aborted: true });
				return;
			}

			const handle = await slot.driver.run({
				cwd: profile.workspaceDir,
				model: modelId,
				...(reasoning !== undefined ? { effort: reasoning } : {}),
				mode: "default",
				...(existing?.conversationId ? { conversationId: existing.conversationId } : {}),
				agentName,
				prompt: formatted.text,
				...(formatted.images.length > 0 ? { images: formatted.images } : {}),
				beforePrompt: async ({ conversationId }) => {
					if (isCancelled()) throw createAbortError("Operation aborted");
					if (!existing) {
						store.set(slot.key, { conversationId, agentName, toolImageHook: true });
						try {
							await store.flush();
						} catch (err) {
							store.delete(slot.key);
							throw err;
						}
					}
				},
				signal: runAbort.signal,
			});
			run.handle = handle;

			for (;;) {
				const activity = await handle.next();
				if (!activity) break;
				if (run.aborted || run.deliveryError) continue;
				switch (activity.type) {
					case "thought":
						if (activity.delta) stream.push({ type: "thought_delta", delta: activity.delta });
						break;
					case "text":
						if (activity.delta) stream.push({ type: "text_delta", delta: activity.delta });
						break;
					case "usage": {
						const usage = toPiUsagePartial(activity.usage);
						if (usage) stream.push({ type: "usage", usage });
						break;
					}
					case "tool_start":
						if (!isAllowedBridgeServer(activity.mcpServer)) {
							stream.push({
								type: "native_tool_start",
								toolCallId: activity.toolCallId ?? "",
								name: activity.name,
								args: activity.args ?? {},
							});
						}
						break;
					case "tool_done":
						if (!isAllowedBridgeServer(activity.mcpServer)) {
							stream.push({
								type: "native_tool_end",
								toolCallId: activity.toolCallId ?? "",
								name: activity.name,
								...(activity.output !== undefined ? { output: activity.output } : {}),
								isError: false,
							});
						}
						break;
					case "tool_error":
						if (!isAllowedBridgeServer(activity.mcpServer)) {
							stream.push({
								type: "native_tool_end",
								toolCallId: activity.toolCallId ?? "",
								name: activity.name,
								...(activity.message !== undefined ? { output: activity.message } : {}),
								isError: true,
							});
						}
						break;
				}
			}

			const outcome = await handle.outcome;
			if (run.incompatibleImageError) {
				stream.push({
					type: "error",
					code: AGY_HISTORY_CHANGED,
					message: run.incompatibleImageError.message,
				});
				return;
			}
			if (run.deliveryError) {
				stream.push({ type: "error", message: redactText(run.deliveryError.message) });
				return;
			}
			if (outcome.sessionLoadFailed) {
				stream.push({
					type: "error",
					code: AGY_HISTORY_CHANGED,
					message: "The native Antigravity session could not be resumed; use /clear to start a new session.",
				});
				return;
			}
			if (outcome.aborted || run.aborted) {
				stream.push({ type: "error", message: "Operation aborted", aborted: true });
				return;
			}
			if (outcome.status === "ERROR" || outcome.status !== "OK") {
				invalidateAuthCacheIfNeeded(outcome.error);
				stream.push({
					type: "error",
					message: redactText(outcome.error ?? "Antigravity turn failed"),
				});
				return;
			}

			await slot.mcpRegistration?.waitForDeliveries({ signal: runAbort.signal });
			if (run.incompatibleImageError) {
				stream.push({
					type: "error",
					code: AGY_HISTORY_CHANGED,
					message: run.incompatibleImageError.message,
				});
				return;
			}
			if (run.deliveryError) {
				stream.push({ type: "error", message: redactText(run.deliveryError.message) });
				return;
			}
			if (run.aborted) {
				stream.push({ type: "error", message: "Operation aborted", aborted: true });
				return;
			}

			const usage = toAntigravityUsage(outcome.usage);
			stream.push({
				type: "turn_done",
				conversationId: outcome.conversationId || existing?.conversationId || "",
				...(usage ? { usage } : {}),
			});
		} catch (error) {
			invalidateAuthCacheIfNeeded(error);
			if (run?.incompatibleImageError) {
				stream.push({
					type: "error",
					code: AGY_HISTORY_CHANGED,
					message: run.incompatibleImageError.message,
				});
			} else if (run?.deliveryError) {
				stream.push({ type: "error", message: redactText(run.deliveryError.message) });
			} else if (isCancelled() || error?.name === "AbortError") {
				stream.push({ type: "error", message: "Operation aborted", aborted: true });
			} else {
				const code = typeof error?.code === "string" ? error.code : undefined;
				const message = redactText(error instanceof Error ? error.message : String(error));
				stream.push({ type: "error", ...(code ? { code } : {}), message });
			}
		} finally {
			runFinished = true;
			detachCallerSignal?.();
			slot.queuedRuns.delete(queued);
			if (run) {
				run.waiters.failAll("Antigravity run ended");
				if (slot.activeRun === run) {
					slot.activeRun = null;
				}
				if (run.recyclePromise) {
					await run.recyclePromise;
				}
				run.resolveSettled();
			}
			if (!slot.driver.alive && slot.mcpRegistration) {
				invalidateMcpRegistration(slot);
			}
			slot.lastUsedAt = Date.now();
			stream.end();
			slot.serialUsers -= 1;
			releaseSerial();
			void trimIdleSessions();
		}
	}

	return {
		async authStatus({ signal } = {}) {
			if (closed) {
				throw new Error("Antigravity service is closed");
			}
			if (signal?.aborted) {
				throw createAbortError("Antigravity auth check aborted");
			}
			if (usesDefaultAgyBin && !hasStoredAcpAuthToken(profile)) {
				cachedAuth = {
					authenticated: false,
					expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
				};
				return { authenticated: false };
			}
			if (cachedAuth && Date.now() < cachedAuth.expiresAt) {
				return { authenticated: cachedAuth.authenticated };
			}
			if (!inflightAuthStatus) {
				const ac = new AbortController();
				const startEpoch = authEpoch;
				const probePromise = probeAcpAuth(profile, { signal: ac.signal });
				const entry = { abortController: ac, promise: probePromise };
				activeAuthProbes.add(entry);
				let sharedPromise;
				sharedPromise = probePromise
					.then((authenticated) => {
						const result = Boolean(authenticated);
						if (!closed && authEpoch === startEpoch) {
							cachedAuth = {
								authenticated: result,
								expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
							};
						}
						return { authenticated: result };
					})
					.finally(() => {
						activeAuthProbes.delete(entry);
						if (inflightAuthStatus === sharedPromise) {
							inflightAuthStatus = null;
						}
					});
				sharedPromise.catch(() => {});
				inflightAuthStatus = sharedPromise;
			}
			return await awaitWithAbort(inflightAuthStatus, signal);
		},

		async login({ notify, prompt, signal } = {}) {
			const makeAbortError = () => createAbortError("Antigravity 登录已取消");
			if (closed) {
				throw new Error("Antigravity service is closed");
			}
			if (signal?.aborted) {
				throw makeAbortError();
			}
			if (activeLogin) {
				activeLogin.abortController.abort();
				await activeLogin.promise.catch(() => {});
			}
			if (closed) {
				throw new Error("Antigravity service is closed");
			}
			if (signal?.aborted) {
				throw makeAbortError();
			}

			const ac = new AbortController();
			const onCallerAbort = () => ac.abort();
			signal?.addEventListener("abort", onCallerAbort, { once: true });

			const loginPromise = loginAcpProfile(profile, {
				notify,
				prompt,
				signal: ac.signal,
			});
			const entry = { abortController: ac, promise: loginPromise };
			activeLogin = entry;
			try {
				await loginPromise;
				if (!closed && !ac.signal.aborted) {
					authEpoch += 1;
					cachedAuth = {
						authenticated: true,
						expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
					};
					await recycleIdleDrivers("post-login");
				}
			} finally {
				signal?.removeEventListener("abort", onCallerAbort);
				if (activeLogin === entry) {
					activeLogin = null;
				}
			}
		},

		async logout() {
			if (closed) {
				throw new Error("Antigravity service is closed");
			}
			authEpoch += 1;
			cachedAuth = null;
			inflightAuthStatus = null;
			if (activeLogin) {
				activeLogin.abortController.abort();
				await activeLogin.promise.catch(() => {});
			}
			const pendingAuthProbes = [...activeAuthProbes];
			for (const entry of pendingAuthProbes) {
				entry.abortController.abort();
			}
			const pendingCatalogs = [...activeCatalogs];
			for (const entry of pendingCatalogs) {
				entry.abortController.abort();
			}
			await Promise.allSettled([
				...pendingAuthProbes.map((entry) => entry.promise),
				...pendingCatalogs.map((entry) => entry.promise),
			]);
			const allSlots = [...sessions.values()];
			sessions.clear();
			await Promise.allSettled(
				allSlots.map(async (slot) => {
					for (const queued of slot.queuedRuns) {
						queued.cancelled = true;
					}
					const run = slot.activeRun;
					if (run) {
						run.aborted = true;
						run.waiters.failAll("Antigravity logged out");
						if (!run.abortController.signal.aborted) {
							run.abortController.abort();
						}
					}
					invalidateMcpRegistration(slot);
					await slot.driver.close("recycle", "oauth logout").catch(() => {});
				}),
			);
			logoutAcpProfile(profile);
			if (!closed) {
				cachedAuth = {
					authenticated: false,
					expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
				};
			}
		},

		async catalog({ signal } = {}) {
			if (closed) {
				throw new Error("Antigravity service is closed");
			}
			const ac = new AbortController();
			const onCallerAbort = () => ac.abort();
			if (signal?.aborted) ac.abort();
			else signal?.addEventListener("abort", onCallerAbort, { once: true });

			const probePromise = probeAcpCatalog(profile, { signal: ac.signal });
			const entry = { abortController: ac, promise: probePromise };
			activeCatalogs.add(entry);
			try {
				return await probePromise;
			} catch (err) {
				invalidateAuthCacheIfNeeded(err);
				throw err;
			} finally {
				signal?.removeEventListener("abort", onCallerAbort);
				activeCatalogs.delete(entry);
			}
		},

		run(params = {}, { signal } = {}) {
			const onAbortRef = { current: null };
			const stream = createEventStream({
				onClose: () => onAbortRef.current?.(),
			});
			void executeRun(stream, params, signal, onAbortRef).catch((err) => {
				stream.push({
					type: "error",
					message: redactText(err instanceof Error ? err.message : String(err)),
				});
				stream.end();
			});
			return stream.iterable;
		},

		async submitToolResult({ deviceId, sessionId, runId, callId, content, isError = false } = {}) {
			if (closed) {
				throw createStateError("Antigravity service is closed");
			}
			if (
				typeof deviceId !== "string" || !deviceId ||
				typeof sessionId !== "string" || !sessionId ||
				!isValidId(runId) ||
				!isValidId(callId)
			) {
				throw createArgumentError("Invalid tool result parameters");
			}
			const slot = sessions.get(makeSessionKey(deviceId, sessionId));
			const run = slot?.activeRun;
			if (!run || run.runId !== runId || run.aborted) {
				throw createStateError("No active Antigravity run matches this tool result");
			}
			if (!run.waiters.resolve(callId, content, Boolean(isError))) {
				throw createStateError("No pending Antigravity tool call matches this callId");
			}
			return { ok: true };
		},

		async steer({ deviceId, sessionId, runId, sections, routeNote, inputs } = {}) {
			if (closed) {
				throw createStateError("Antigravity service is closed");
			}
			if (
				typeof deviceId !== "string" || !deviceId ||
				typeof sessionId !== "string" || !sessionId ||
				!isValidId(runId) ||
				!Array.isArray(inputs) || inputs.length === 0
			) {
				throw createArgumentError("Invalid steer parameters");
			}
			const slot = sessions.get(makeSessionKey(deviceId, sessionId));
			const run = slot?.activeRun;
			if (!run || run.runId !== runId || run.aborted || run.deliveryError) {
				throw createStateError("Active Antigravity run has already ended");
			}
			const formatted = formatTurnPrompt({ sections, routeNote, inputs });
			assertPromptFits(formatted.text, formatted.images);
			try {
				await slot.driver.steer(
					formatted.text,
					formatted.images.length > 0 ? formatted.images : undefined,
				);
			} catch (err) {
				if (err && typeof err === "object" && err.code === "INVALID_STATE") {
					throw Object.assign(err, { statusCode: 409 });
				}
				if (err && typeof err === "object" && "code" in err) throw err;
				throw createStateError(err instanceof Error ? err.message : "Active Antigravity run has already ended");
			}
			return { ok: true };
		},

		async cancel(params = {}) {
			const { deviceId, sessionId, runId } = params;
			const scoped = Object.hasOwn(params, "runId") && runId !== undefined;
			if (scoped && !isValidId(runId)) {
				throw createArgumentError("Invalid runId");
			}
			if (typeof deviceId !== "string" || !deviceId || typeof sessionId !== "string" || !sessionId) {
				return;
			}
			const slot = sessions.get(makeSessionKey(deviceId, sessionId));
			if (!slot) return;
			for (const queued of slot.queuedRuns) {
				if (!scoped || queued.runId === runId) {
					queued.cancelled = true;
					if (scoped) return;
				}
			}
			const run = slot.activeRun;
			if (!run || (scoped && run.runId !== runId)) return;
			run.aborted = true;
			run.waiters.failAll("Antigravity run cancelled");
			if (!run.abortController.signal.aborted) {
				run.abortController.abort();
			}
			const handle = run.handle ?? slot.driver.activeHandle;
			if (handle) {
				await handle.outcome.catch(() => {});
			} else {
				await run.settledPromise;
			}
			if (run.recyclePromise) {
				await run.recyclePromise;
			}
			if (!slot.driver.alive && slot.mcpRegistration) {
				invalidateMcpRegistration(slot);
			}
		},

		async close() {
			if (closed) return;
			closed = true;
			await idleTrim;
			authEpoch += 1;
			cachedAuth = null;
			inflightAuthStatus = null;
			const pendingLogin = activeLogin;
			if (pendingLogin) {
				pendingLogin.abortController.abort();
			}
			const pendingAuthProbes = [...activeAuthProbes];
			for (const entry of pendingAuthProbes) {
				entry.abortController.abort();
			}
			const pendingCatalogs = [...activeCatalogs];
			for (const entry of pendingCatalogs) {
				entry.abortController.abort();
			}
			const allSlots = [...sessions.values()];
			sessions.clear();
			await Promise.allSettled([
				...(pendingLogin ? [pendingLogin.promise] : []),
				...pendingAuthProbes.map((entry) => entry.promise),
				...pendingCatalogs.map((entry) => entry.promise),
				...allSlots.map(async (slot) => {
					for (const queued of slot.queuedRuns) {
						queued.cancelled = true;
					}
					const run = slot.activeRun;
					if (run) {
						run.aborted = true;
						run.waiters.failAll("Antigravity service closed");
						if (!run.abortController.signal.aborted) {
							run.abortController.abort();
						}
					}
					invalidateMcpRegistration(slot);
					await slot.driver.close("shutdown", "service close");
				}),
			]);
			await mcpBridge.close();
			await store.flush();
		},
	};
}
