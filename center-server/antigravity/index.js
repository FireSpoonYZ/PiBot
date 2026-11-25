// Center Antigravity ACP bridge service.
//
// Exports openAntigravity({ dataRoot, bin, geminiHome } = {}) returning:
//   - authStatus({ signal } = {}) => Promise<{ authenticated: boolean }>
//   - login({ notify, prompt, signal } = {}) => Promise<void>
//   - logout() => Promise<void>
//   - catalog({ signal } = {}) => Promise<Model[]>
//   - stream({ deviceId, sessionId, requestId?, modelId, delta, reasoning, turnContext }, { signal } = {}) => AssistantMessageEventStream
//   - cancel({ deviceId, sessionId, requestId? }) => Promise<void>
//   - close() => Promise<void>

import { isDeepStrictEqual } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { hasStoredAcpAuthToken, loginAcpProfile, logoutAcpProfile, probeAcpAuth } from "./auth.ts";
import { probeAcpCatalog, resolveSessionThoughtLevel } from "./catalog.ts";
import { acceptHistoryDelta, historyChanged } from "../../center-contract/antigravity-delta.js";
import { SharedMcpBridge } from "./mcp-bridge.ts";
import { ensureIsolatedProfile, ensureSessionAgent, resolveProfile } from "./profile.ts";
import { redactText } from "./vendor/redact.ts";
import {
	buildFullPrompt,
	collectToolResults,
	consumeActivity,
	ensureTextOpen,
	extractImages,
	extractUserPrompt,
	finalize,
	isAllowedBridgeServer,
	newAssistant,
	toMcpToolDefinitions,
	ToolRoundTrips,
} from "./round-trips.ts";
import { makeSessionKey, SessionStore } from "./sessions.ts";
import { AcpDriver } from "./vendor/acp/driver.ts";
import { MAX_FRAME_BYTES } from "./vendor/frame-guard.ts";

const BRIDGE_SERVER_RE = /^(?:pibot|pi)-bridge(?:-\d+)?$/i;
const BRIDGE_PERMISSION_RE = /^(?:mcp_)?(?:pibot|pi)-bridge(?:-\d+)?(?:_|$)/i;
const AUTH_CACHE_TTL_MS = 60_000;
const MAX_IDLE_SESSIONS = 64;

function normalizeReasoning(reasoning) {
	return reasoning ?? null;
}

function isValidRequestId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 256 &&
		value.isWellFormed() && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Only a result paired with an earlier declared call can resume a tool turn. */
function pairedToolResultIds(messages) {
	const calls = new Map();
	const paired = new Set();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type === "toolCall" && typeof block.id === "string") {
					calls.set(block.id, block.name);
					paired.delete(block.id);
				}
			}
		} else if (message.role === "toolResult") {
			paired.delete(message.toolCallId);
			if (calls.has(message.toolCallId) && calls.get(message.toolCallId) === message.toolName) {
				paired.add(message.toolCallId);
			}
		}
	}
	return paired;
}

function assertPromptFits(text, images) {
	const prompt = [...images.map((image) => ({ type: "image", ...image })), { type: "text", text }];
	if (Buffer.byteLength(JSON.stringify({ prompt }), "utf8") + 4096 > MAX_FRAME_BYTES) {
		throw new RangeError("The new input exceeds the ACP frame budget; send a smaller message.");
	}
}

function buildUserBatch(messages) {
	const images = [];
	const parts = messages.map((message, index) => {
		const text = extractUserPrompt({ messages: [message] }, 0) ?? "";
		const attached = extractImages({ messages: [message] }, 0);
		const first = images.length + 1;
		images.push(...attached);
		if (messages.length === 1) return text;
		const imageNote = attached.length ? `\nAttached images ${first}-${images.length} belong to this message.` : "";
		return `[New user message ${index + 1}]${imageNote}\n${text}`;
	});
	return { prompt: parts.join("\n\n"), images };
}

function createAbortError(message) {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
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

function isBridgePermissionRequest(req) {
	const tc = req?.toolCall;
	if (!tc || typeof tc !== "object") return false;
	const server = tc._meta?.mcp?.server;
	if (typeof server === "string" && BRIDGE_SERVER_RE.test(server)) return true;
	const candidates = [tc.name, tc.title].filter((v) => typeof v === "string");
	return candidates.some((v) => BRIDGE_PERMISSION_RE.test(v));
}

function sameBridgeCall(native, mcp) {
	if (native.name !== mcp.name) return false;
	if (isDeepStrictEqual(native.args, mcp.args)) return true;
	// AGY adds a display-only summary to ACP rawInput, not to MCP arguments.
	const { toolSummary, ...args } = native.args;
	return typeof toolSummary === "string" && !Object.hasOwn(mcp.args, "toolSummary") &&
		isDeepStrictEqual(args, mcp.args);
}

// ACP toolCallId and our MCP/Host callId live in different protocols. Pair only
// unambiguous in-flight calls, never by tool name or by completion order.
function pairBridgeToolCalls(state) {
	const nativeCalls = [...state.native.values()];
	const mcpCalls = [...state.mcp];
	for (const attempt of mcpCalls) {
		const matches = nativeCalls.filter((native) => sameBridgeCall(native, attempt));
		if (matches.length > 1) {
			attempt.ambiguous = true;
			continue;
		}
		const native = matches[0];
		if (!native || native.mcp || attempt.paired) continue;
		if (mcpCalls.some((other) => other !== attempt && !other.paired && sameBridgeCall(native, other))) {
			attempt.ambiguous = true;
			continue;
		}
		native.mcp = attempt;
		attempt.paired = true;
	}
}

function observeBridgeToolActivity(state, activity) {
	if (!state || !activity.toolCallId || !isAllowedBridgeServer(activity.mcpServer)) return false;
	const { toolCallId } = activity;
	if (activity.type === "tool_start" && !state.native.has(toolCallId)) {
		const tool = { name: activity.name, args: activity.args, mcp: null };
		state.native.set(toolCallId, tool);
		pairBridgeToolCalls(state);
	} else if (activity.type === "tool_done" || activity.type === "tool_error") {
		const call = state.native.get(toolCallId)?.mcp;
		state.native.delete(toolCallId);
		if (call) {
			state.mcp.delete(call);
			return call.isError === true && !call.ambiguous;
		}
	}
	return false;
}

export function openAntigravity({ dataRoot, bin, geminiHome } = {}) {
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
		if (err?.code === "UNAUTHENTICATED" || err?.name === "AcpAuthError") {
			authEpoch += 1;
			cachedAuth = null;
		}
	}

	function getOrCreateSession(deviceId, sessionId) {
		const key = makeSessionKey(deviceId, sessionId);
		let slot = sessions.get(key);
		if (slot) return slot;

		const driver = new AcpDriver({
			bin: profile.bin,
			binArgs: (request) => ["acp", "--agent", ensureSessionAgent(profile, {
				systemPrompt: request.systemPrompt, systemHash: request.systemHash,
			}), "--process-per-session"],
			geminiDir: profile.geminiHome,
			enableTurnRecall: false,
			enableToolImages: true,
			resolveEffort: resolveSessionThoughtLevel,
			mcpServers: () => [mcpBridge.serverConfig(slot.mcpToken)],
			permissionPolicy: (req) => (isBridgePermissionRequest(req) ? "auto" : "deny"),
		});
		const roundTrips = new ToolRoundTrips(driver, undefined, {
			onPendingEmpty: () => void trimIdleSessions(),
		});
		driver.onTurnEnd = (outcome) => {
			if (outcome.conversationId) {
				roundTrips.stampConversation(outcome.conversationId);
			}
			void trimIdleSessions();
		};

		slot = {
			key,
			deviceId,
			sessionId,
			driver,
			roundTrips,
			mcpToken: "",
			mcpRegistration: null,
			nativeEpoch: 0,
			nativeConfig: null,
			bridgeToolActivity: null,
			deliveryFailure: null,
			currentTools: [],
			listTools: () => slot.currentTools,
			allowedToolNames: new Set(),
			activeConsumer: false,
			preflightRequest: null,
			queuedRequests: new Set(),
			nativeOwner: null,
			turnAbort: null,
			turnCleanup: null,
			serialChain: Promise.resolve(),
			serialUsers: 0,
			retiring: false,
			lastUsedAt: Date.now(),
		};

		// Keep an initial registration for the slot; it cannot execute tools until
		// a native turn exists, and is rotated before the first driver.run too.
		registerTurnMcp(slot);
		sessions.set(key, slot);
		return slot;
	}

	function invalidateMcpRegistration(slot) {
		slot.nativeEpoch += 1;
		const registration = slot.mcpRegistration;
		slot.mcpRegistration = null;
		slot.mcpToken = "";
		slot.nativeConfig = null;
		slot.bridgeToolActivity = null;
		registration?.unregister();
	}

	function registerTurnMcp(slot) {
		invalidateMcpRegistration(slot);
		const epoch = slot.nativeEpoch;
		slot.deliveryFailure = null;
		const toolActivity = { native: new Map(), mcp: new Set() };
		slot.bridgeToolActivity = toolActivity;
		const reg = mcpBridge.registerSession({
			listTools: slot.listTools,
			onToolCall: async (callId, name, args, signal) => {
				if (slot.nativeEpoch !== epoch || slot.mcpRegistration !== reg ||
					!slot.turnAbort || slot.turnAbort.signal.aborted || slot.deliveryFailure?.epoch === epoch) {
					return Promise.reject(new Error("Antigravity MCP call belongs to an inactive native turn"));
				}
				if (!slot.allowedToolNames.has(name)) {
					return Promise.resolve({
						content: [{ type: "text", text: `Error: unknown or unavailable tool "${name}"` }],
						isError: true,
					});
				}
				const call = { name, args, paired: false, ambiguous: false, isError: false };
				toolActivity.mcp.add(call);
				pairBridgeToolCalls(toolActivity);
				try {
					const result = await slot.roundTrips.onToolCall(callId, name, args, signal);
					call.isError = result.isError === true;
					return result;
				} finally {
					if (!call.paired) toolActivity.mcp.delete(call);
				}
			},
			onDeliveryError: (error) => {
				if (slot.nativeEpoch !== epoch || slot.mcpRegistration !== reg) return;
				slot.deliveryFailure = { epoch, error };
				void abortSessionTurn(slot, "Antigravity MCP result delivery failed").catch(() => {});
			},
		});
		slot.mcpToken = reg.token;
		slot.mcpRegistration = reg;
		return epoch;
	}

	async function abortSessionTurn(slot, reason) {
		invalidateMcpRegistration(slot);
		const binding = store.get(slot.key);
		if (binding && (slot.driver.activeHandle || binding.phase === "parked")) {
			store.set(slot.key, { ...binding, phase: "uncertain" });
		}
		const turnAbort = slot.turnAbort;
		slot.turnAbort = null;
		slot.roundTrips.failAll(reason, { includeEscalated: true });
		if (turnAbort && !turnAbort.signal.aborted) {
			turnAbort.abort();
		}
		const handle = slot.driver.activeHandle;
		if (handle) {
			await handle.outcome.catch(() => {});
		}
		if (binding) await store.flush();
	}

	function attachCallerSignal(slot, signal) {
		if (!signal) {
			slot.turnCleanup = null;
			return;
		}
		const onAbort = () => {
			// The stream observes its signal and persistence barrier separately.
			void abortSessionTurn(slot, "Operation aborted").catch(() => {});
		};
		if (signal.aborted) {
			onAbort();
			slot.turnCleanup = null;
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		slot.turnCleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
	}

	function detachCallerSignal(slot) {
		const cleanup = slot.turnCleanup;
		slot.turnCleanup = null;
		if (cleanup) cleanup();
	}

	async function runStreamTurn(stream, params, signal) {
		const { deviceId, sessionId, requestId, modelId, delta, reasoning, turnContext } = params;
		const normalizedReasoning = normalizeReasoning(reasoning);
		const blocks = { partial: newAssistant(modelId), textIdx: null, thinkingIdx: null, started: false };
		if (closed || typeof deviceId !== "string" || !deviceId || typeof sessionId !== "string" || !sessionId ||
			typeof modelId !== "string" || !modelId || (requestId !== undefined && !isValidRequestId(requestId))) {
			finalize(stream, blocks, "error", "Invalid or closed Antigravity stream");
			return;
		}
		if (!delta) {
			finalize(stream, blocks, "error", historyChanged("Upgrade this Host version before retrying").message);
			return;
		}

		const slot = getOrCreateSession(deviceId, sessionId);
		const request = { requestId, cancelled: false };
		slot.queuedRequests.add(request);
		slot.serialUsers += 1;
		let releaseSerial;
		const previousSerial = slot.serialChain;
		slot.serialChain = new Promise((resolve) => { releaseSerial = resolve; });
		const isCancelled = () => closed || signal?.aborted || request.cancelled;
		let consumerReleased = false;
		let nativeEpochForRequest = null;
		let dispatchClaimed = false;
		let accepted;
		let existing;
		let cleanMessages;
		let requestEnd;
		let nativeAttempted = false;
		let createdNativeId;
		let nativeHandle;
		let priorNative;
		let intentWrite;
		let toolContinuation = false;

		const releaseConsumer = () => {
			if (consumerReleased) return;
			consumerReleased = true;
			slot.queuedRequests.delete(request);
			if (slot.preflightRequest === request) slot.preflightRequest = null;
			if (slot.nativeOwner === request) detachCallerSignal(slot);
			slot.activeConsumer = false;
			slot.lastUsedAt = Date.now();
		};
		const finish = (reason, message) => {
			releaseConsumer();
			finalize(stream, blocks, reason, message);
		};
		const throwIfCancelled = () => {
			if (nativeEpochForRequest !== null && slot.deliveryFailure?.epoch === nativeEpochForRequest) {
				throw slot.deliveryFailure.error;
			}
			if (isCancelled()) throw createAbortError("Operation aborted");
		};
		const rememberReply = async (reason, message, phase) => {
			const current = store.get(slot.key);
			if (!current?.history || requestEnd === undefined) return;
			store.set(slot.key, {
				...current, phase,
				pendingToolCallIds: phase === "ready" ? [] : [...new Set([...(current.pendingToolCallIds ?? []), ...slot.roundTrips.pendingIds])],
				reply: { end: requestEnd, prefixHash: current.history.prefixes[requestEnd],
					reason, message: structuredClone(message) },
			});
			await store.flush();
		};
		const rollbackUnsent = async (outcome) => {
			// Cancellation may settle the driver while beforePrompt is still flushing.
			if (intentWrite) await intentWrite.catch(() => {});
			if (toolContinuation || outcome?.promptAttempted !== false || !dispatchClaimed) return;
			const latest = store.get(slot.key);
			store.set(slot.key, {
				...latest, conversationId: createdNativeId ?? priorNative.conversationId,
				phase: priorNative.phase, attemptedThrough: priorNative.attemptedThrough ?? 0,
				consumedUserIndices: priorNative.consumedUserIndices ?? [],
				pendingToolCallIds: priorNative.pendingToolCallIds ?? [],
			});
			await store.flush();
			dispatchClaimed = false;
			nativeAttempted = false;
		};
		const emitStoredReply = (reply) => {
			if (reply.reason === "error" || reply.reason === "aborted") {
				stream.push({ type: "error", reason: reply.reason, error: structuredClone(reply.message) });
			} else {
				stream.push({ type: "done", reason: reply.reason, message: structuredClone(reply.message) });
			}
			stream.end();
		};

		try {
			await previousSerial;
			slot.queuedRequests.delete(request);
			slot.preflightRequest = request;
			slot.activeConsumer = true;
			existing = store.get(slot.key);
			if (existing && !existing.history) throw historyChanged("The native session uses an older history mapping");
			accepted = acceptHistoryDelta(existing?.history, delta);
			requestEnd = accepted.end;
			cleanMessages = accepted.history.messages.slice(0, requestEnd);
			if (!turnContext || turnContext.inputIndex !== requestEnd - 1 || requestEnd === 0) {
				throw new TypeError("Invalid canonical Antigravity input index");
			}
			if (!existing && cleanMessages.some((message) => message.role !== "user")) {
				throw historyChanged("An existing conversation cannot switch into Antigravity");
			}
			store.set(slot.key, {
				...(existing ?? { conversationId: "", lastStepIdx: -1, phase: "new",
					attemptedThrough: 0, consumedUserIndices: [] }),
				history: accepted.history,
			});
			// Receipt survives cancellation and restart; it does not claim native consumption.
			await store.flush();
			stream.push(accepted.ack);
			throwIfCancelled();
			const current = store.get(slot.key);
			priorNative = current;
			const cachedReply = current?.reply;
			if (cachedReply?.end === requestEnd && cachedReply.prefixHash === accepted.ack.prefixHash) {
				if (cachedReply.reason === "toolUse") {
					const calls = cachedReply.message.content.filter((part) => part.type === "toolCall");
					const pending = new Set(slot.roundTrips.pendingIds);
					// A receipt can replay an answer, but cannot recreate a lost MCP waiter.
					if (current.phase !== "parked" || !slot.driver.reentry() ||
						!slot.turnAbort || slot.turnAbort.signal.aborted || !slot.mcpRegistration ||
						slot.driver.snapshot().conversationId !== current.conversationId ||
						slot.nativeConfig?.modelId !== modelId || slot.nativeConfig.reasoning !== normalizedReasoning ||
						calls.length === 0 || calls.some((call) => !pending.has(call.id))) {
						throw historyChanged("The cached tool call has lost its live native continuation");
					}
				}
				emitStoredReply(cachedReply);
				return;
			}
			const input = cleanMessages[turnContext.inputIndex];
			if (input?.role !== "user" && input?.role !== "toolResult") {
				throw historyChanged("Only a new user input or a paired tool result can advance this session");
			}
			if (current.phase !== "new" && !current.conversationId) {
				throw historyChanged("The native conversation mapping is missing");
			}
			const config = accepted.history.config;
			const mcpTools = toMcpToolDefinitions(config.tools);
			const claimNativeTurn = () => {
				slot.preflightRequest = null;
				slot.nativeOwner = request;
				slot.currentTools = mcpTools;
				slot.allowedToolNames = new Set(mcpTools.map((tool) => tool.name));
			};
			const awaitToolDeliveries = async () => {
				throwIfCancelled();
				const registration = slot.mcpRegistration;
				if (!registration || slot.nativeEpoch !== nativeEpochForRequest) {
					throw new Error("Antigravity MCP turn changed before result delivery was confirmed");
				}
				await registration.waitForDeliveries({ signal: slot.turnAbort?.signal });
				throwIfCancelled();
			};
			const drainTurn = async (handle) => {
				for (;;) {
					const activity = await handle.next();
					if (!activity) return false;
					throwIfCancelled();
					if (activity.type === "bridge_call") {
						const conversationId = slot.driver.snapshot().conversationId;
						if (!conversationId) throw new Error("Antigravity tool call has no native conversation");
						const exposed = {
							...blocks.partial,
							content: [...blocks.partial.content, {
								type: "toolCall", id: activity.callId, name: activity.name, arguments: activity.args,
							}],
							stopReason: "toolUse",
						};
						await rememberReply("toolUse", exposed, "parked");
						throwIfCancelled();
						releaseConsumer();
						consumeActivity(stream, blocks, activity);
						return true;
					}
					const matchedMcpToolError = observeBridgeToolActivity(slot.bridgeToolActivity, activity);
					consumeActivity(stream, blocks, activity, matchedMcpToolError);
				}
			};

			ensureIsolatedProfile(profile);
			await mcpBridge.ensureStarted();
			throwIfCancelled();
			let outcome;
			const pendingIds = new Set(slot.roundTrips.pendingIds);
			const persistedPending = current.pendingToolCallIds ?? [];
			if (input.role === "toolResult") {
				toolContinuation = true;
				const pairedIds = pairedToolResultIds(cleanMessages);
				const results = collectToolResults(cleanMessages, [...pendingIds])
					.filter((result) => pairedIds.has(result.toolCallId));
				const handle = slot.driver.reentry();
				if (!handle || !slot.turnAbort || slot.turnAbort.signal.aborted || !slot.mcpRegistration ||
					results.length === 0 || !pendingIds.has(input.toolCallId) || !pairedIds.has(input.toolCallId)) {
					throw historyChanged("The live native tool continuation is unavailable");
				}
				if (slot.nativeConfig?.modelId !== modelId || slot.nativeConfig.reasoning !== normalizedReasoning) {
					throw historyChanged("A pending tool continuation must use its original model");
				}
				claimNativeTurn();
				nativeEpochForRequest = slot.nativeEpoch;
				store.set(slot.key, { ...store.get(slot.key), phase: "uncertain", attemptedThrough: requestEnd });
				await store.flush();
				dispatchClaimed = true;
				nativeAttempted = true;
				attachCallerSignal(slot, signal);
				for (const item of results) {
					throwIfCancelled();
					if (!slot.roundTrips.resolve(item.toolCallId, item.text, item.isError, item.images)) {
						throw new Error("Antigravity tool result lost its pending call before delivery");
					}
				}
				if (await drainTurn(handle)) return;
				outcome = await handle.outcome;
			} else {
				if (pendingIds.size > 0 || persistedPending.length > 0 || slot.driver.activeHandle) {
					throw Object.assign(new Error("AGY_TURN_PENDING: input received; finish the pending native tools before the next user turn."),
						{ code: "AGY_TURN_PENDING" });
				}
				const consumed = new Set(current.consumedUserIndices ?? []);
				const inputs = cleanMessages.flatMap((message, index) =>
					message.role === "user" && !consumed.has(index) ? [{ message, index }] : []);
				if (inputs.length === 0) {
					throw Object.assign(new Error("AGY_INPUT_UNCERTAIN: this input was already dispatched; it will not be sent twice. Send a new message or use /clear."),
						{ code: "AGY_INPUT_UNCERTAIN" });
				}
				const batch = buildUserBatch(inputs.map(({ message }) => message));
				const prompt = buildFullPrompt(undefined, "", batch.prompt, {
					routeNote: turnContext.routeNote,
					currentImageCount: batch.images.length,
				});
				assertPromptFits(prompt, batch.images);
				claimNativeTurn();
				detachCallerSignal(slot);
				slot.turnAbort = new AbortController();
				nativeEpochForRequest = registerTurnMcp(slot);
				slot.nativeConfig = { modelId, reasoning: normalizedReasoning };
				attachCallerSignal(slot, signal);
				throwIfCancelled();
				const handle = await slot.driver.run({
					cwd: profile.workspaceDir, model: modelId, effort: reasoning,
					mode: "default", skipPermissions: false,
					conversationId: current.conversationId || undefined,
					systemPrompt: config.systemPrompt, systemHash: accepted.history.configHash,
					prompt, images: batch.images.length ? batch.images : undefined,
					beforePrompt: ({ conversationId }) => {
						intentWrite = (async () => {
							throwIfCancelled();
							if (current.conversationId && current.conversationId !== conversationId) {
								throw historyChanged("The native conversation identity changed");
							}
							createdNativeId = conversationId;
							const latest = store.get(slot.key);
							store.set(slot.key, {
								...latest, conversationId, phase: "uncertain",
								modelId, reasoning: normalizedReasoning, attemptedThrough: requestEnd,
								consumedUserIndices: [...new Set([...(latest.consumedUserIndices ?? []),
									...inputs.map(({ index }) => index)])],
								pendingToolCallIds: [],
							});
							await store.flush();
							dispatchClaimed = true;
							throwIfCancelled();
						})();
						return intentWrite;
					},
					signal: slot.turnAbort.signal,
				});
				nativeHandle = handle;
				if (await drainTurn(handle)) return;
				outcome = await handle.outcome;
				nativeAttempted = outcome.promptAttempted !== false && dispatchClaimed;
				await rollbackUnsent(outcome);
			}
			if (outcome.sessionLoadFailed) throw historyChanged("The native conversation can no longer be loaded");
			throwIfCancelled();
			if (outcome.aborted || outcome.status === "ERROR" || outcome.promptTerminal !== true) {
				throw Object.assign(new Error(outcome.error ?? (outcome.aborted ? "Operation aborted" : "Native prompt has no confirmed terminal result")),
					{ name: outcome.aborted ? "AbortError" : "Error" });
			}
			if (!outcome.conversationId || (current.conversationId && outcome.conversationId !== current.conversationId)) {
				throw historyChanged("The native conversation identity changed");
			}
			await awaitToolDeliveries();
			if (slot.roundTrips.pendingIds.length > 0 || slot.roundTrips.claimAllUndelivered().length > 0) {
				throw new Error("AGY_INPUT_UNCERTAIN: native turn ended before all tool results were delivered; use /clear.");
			}
			if (blocks.partial.content.length === 0) ensureTextOpen(stream, blocks);
			blocks.partial.stopReason = "stop";
			await rememberReply("stop", blocks.partial, "ready");
			slot.turnAbort = null;
			slot.bridgeToolActivity = null;
			finish("stop");
		} catch (error) {
			invalidateAuthCacheIfNeeded(error);
			if (slot.nativeOwner === request) {
				await abortSessionTurn(slot, "Antigravity stream interrupted").catch(() => {});
			}
			if (nativeHandle) {
				await rollbackUnsent(await nativeHandle.outcome.catch(() => undefined)).catch(() => {});
			}
			const aborted = isCancelled() || error?.name === "AbortError";
			const reason = aborted ? "aborted" : "error";
			const message = redactText(error instanceof Error ? error.message : String(error));
			blocks.partial.stopReason = reason;
			blocks.partial.errorMessage = message;
			if (dispatchClaimed || nativeAttempted) {
				await rememberReply(reason, blocks.partial, "uncertain").catch(() => {});
			}
			finish(reason, message);
		} finally {
			releaseConsumer();
			slot.serialUsers -= 1;
			releaseSerial();
			void trimIdleSessions();
		}
	}

	async function retireSessionResources(slot, reason, removeBinding = false) {
		invalidateMcpRegistration(slot);
		detachCallerSignal(slot);
		slot.turnAbort = null;
		slot.roundTrips.failAll(reason, { includeEscalated: true });
		try {
			await slot.driver.close("recycle", reason);
		} finally {
			if (removeBinding && (!sessions.has(slot.key) || sessions.get(slot.key) === slot)) {
				store.delete(slot.key);
				await store.flush();
			}
		}
	}

	function isIdleSlot(slot) {
		return !slot.activeConsumer && slot.serialUsers === 0 && !slot.driver.activeHandle &&
			slot.roundTrips.pendingIds.length === 0;
	}

	function trimIdleSessions() {
		idleTrim = idleTrim.then(async () => {
			if (closed) return;
			const idle = [...sessions.values()].filter((slot) => !slot.retiring && isIdleSlot(slot))
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
					// A new request can queue during close(). It retains this slot and
					// its serial chain, then loads the persisted ready checkpoint.
					if (isIdleSlot(slot) && sessions.get(slot.key) === slot) sessions.delete(slot.key);
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
							!slot.activeConsumer &&
							!slot.driver.activeHandle &&
							slot.roundTrips.pendingIds.length === 0 &&
							store.get(slot.key)?.phase !== "parked" &&
							slot.driver.state === "ready"
						) {
							await retireSessionResources(slot, reason);
						}
					})
					.catch(() => {})
					.finally(() => { slot.serialUsers -= 1; release(); }),
			);
		}
		if (tasks.length > 0) {
			await Promise.allSettled(tasks);
		}
		await trimIdleSessions();
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
					if (slot.preflightRequest) slot.preflightRequest.cancelled = true;
					if (slot.nativeOwner) slot.nativeOwner.cancelled = true;
					detachCallerSignal(slot);
					slot.roundTrips.failAll("Antigravity logged out", { includeEscalated: true });
					if (slot.turnAbort && !slot.turnAbort.signal.aborted) {
						slot.turnAbort.abort();
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

		stream(params = {}, { signal } = {}) {
			const stream = createAssistantMessageEventStream();
			const { modelId } = params;
			void runStreamTurn(
				stream,
				params,
				signal,
			).catch((err) => {
				const blocks = {
					partial: newAssistant(typeof modelId === "string" ? modelId : ""),
					textIdx: null,
					thinkingIdx: null,
					started: false,
				};
				const msg = redactText(err instanceof Error ? err.message : String(err));
				finalize(stream, blocks, "error", msg);
			});
			return stream;
		},

		async cancel(params = {}) {
			const { deviceId, sessionId, requestId } = params;
			const scoped = Object.hasOwn(params, "requestId");
			if (scoped && !isValidRequestId(requestId)) {
				throw Object.assign(new Error("Invalid requestId"), { code: "INVALID_ARGUMENT" });
			}
			if (typeof deviceId !== "string" || !deviceId || typeof sessionId !== "string" || !sessionId) {
				return;
			}
			const slot = sessions.get(makeSessionKey(deviceId, sessionId));
			if (!slot) return;
			for (const queued of slot.queuedRequests) {
				if (!scoped || queued.requestId === requestId) {
					queued.cancelled = true;
					if (scoped) return;
				}
			}
			const pending = slot.preflightRequest;
			if (pending && (!scoped || pending.requestId === requestId)) {
				pending.cancelled = true;
				if (scoped) return;
			}
			const owner = slot.nativeOwner;
			if (!owner || (scoped && owner.requestId !== requestId)) return;
			owner.cancelled = true;
			await abortSessionTurn(slot, "Antigravity session cancelled");
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
					detachCallerSignal(slot);
					slot.roundTrips.failAll("Antigravity service closed", { includeEscalated: true });
					if (slot.turnAbort && !slot.turnAbort.signal.aborted) {
						slot.turnAbort.abort();
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
