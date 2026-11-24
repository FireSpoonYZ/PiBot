// Center Antigravity ACP bridge service.
//
// Exports openAntigravity({ dataRoot, bin, geminiHome } = {}) returning:
//   - authStatus({ signal } = {}) => Promise<{ authenticated: boolean }>
//   - login({ notify, prompt, signal } = {}) => Promise<void>
//   - logout() => Promise<void>
//   - catalog({ signal } = {}) => Promise<Model[]>
//   - stream({ deviceId, sessionId, requestId?, modelId, messages, reasoning, turnContext }, { signal } = {}) => AssistantMessageEventStream
//   - cancel({ deviceId, sessionId, requestId? }) => Promise<void>
//   - close() => Promise<void>

import { isDeepStrictEqual } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { hasStoredAcpAuthToken, loginAcpProfile, logoutAcpProfile, probeAcpAuth } from "./auth.ts";
import { probeAcpCatalog, resolveSessionThoughtLevel } from "./catalog.ts";
import { buildContextReplay, contextPrefixMatches, createContextSnapshot } from "./context-sync.ts";
import { SharedMcpBridge } from "./mcp-bridge.ts";
import { AGENT_NAME, ensureIsolatedProfile, resolveProfile } from "./profile.ts";
import { redactText } from "./vendor/redact.ts";
import {
	buildFullPrompt,
	buildLateResultPrompt,
	collectToolResults,
	consumeActivity,
	ensureTextOpen,
	extractImages,
	extractUserPrompt,
	finalize,
	isAllowedBridgeServer,
	newAssistant,
	RESUME_PROMPT,
	splitAntigravityTurnContext,
	systemPromptFromMessages,
	toMcpToolDefinitions,
	ToolRoundTrips,
	toolsFromMessages,
} from "./round-trips.ts";
import { makeSessionKey, SessionStore } from "./sessions.ts";
import { AcpDriver } from "./vendor/acp/driver.ts";
import { MAX_FRAME_BYTES } from "./vendor/frame-guard.ts";

const BRIDGE_SERVER_RE = /^(?:pibot|pi)-bridge(?:-\d+)?$/i;
const BRIDGE_PERMISSION_RE = /^(?:mcp_)?(?:pibot|pi)-bridge(?:-\d+)?(?:_|$)/i;
const AUTH_CACHE_TTL_MS = 60_000;
const MAX_IDLE_SESSIONS = 64;
const KNOWN_MESSAGE_ROLES = new Set(["user", "system", "assistant", "toolResult"]);

function equalHashes(left, right) {
	return Array.isArray(left) && left.length === right.length &&
		left.every((hash, index) => hash === right[index]);
}

function normalizeReasoning(reasoning) {
	return reasoning ?? null;
}

function isValidRequestId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 256 &&
		value.isWellFormed() && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function isCompactionSession(sessionId) {
	try {
		const identity = JSON.parse(sessionId);
		return Array.isArray(identity) && identity.length === 3 && identity[0] === "antigravity-compaction" &&
			typeof identity[1] === "string" && identity[1].length > 0 && Number.isSafeInteger(identity[2]);
	} catch {
		return false;
	}
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

function assertPromptFits(text, images, contextBlock) {
	const prompt = images.map((image) => ({ type: "image", ...image }));
	if (contextBlock) {
		prompt.push({ type: "resource", resource: { ...contextBlock, mimeType: "text/markdown" } });
	}
	prompt.push({ type: "text", text });
	// Reserve room for the RPC envelope and a newly assigned native session ID.
	// The transport also checks the final encoded frame. Never acknowledge a
	// shortened transcript merely to make it fit.
	if (Buffer.byteLength(JSON.stringify({ prompt }), "utf8") + 4096 > MAX_FRAME_BYTES) {
		throw new RangeError("Antigravity context exceeds the ACP frame budget; compact the PiBot context before retrying.");
	}
}

function safeMessageRole(msg) {
	if (!msg) return "none";
	return typeof msg.role === "string" && KNOWN_MESSAGE_ROLES.has(msg.role) ? msg.role : "unknown";
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
			binArgs: ["acp", "--agent", AGENT_NAME, "--process-per-session"],
			geminiDir: profile.geminiHome,
			enableTurnRecall: true,
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
			nativeOwner: null,
			turnAbort: null,
			turnCleanup: null,
			serialChain: Promise.resolve(),
			serialUsers: 0,
			retiring: false,
			lastUsedAt: Date.now(),
			compaction: isCompactionSession(sessionId),
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
		if (binding) store.set(slot.key, { ...binding, phase: "uncertain" });
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
		const { deviceId, sessionId, requestId, modelId, messages, reasoning, turnContext: rawTurnContext } = params;
		const normalizedReasoning = normalizeReasoning(reasoning);
		const blocks = { partial: newAssistant(modelId), textIdx: null, thinkingIdx: null, started: false };

		if (closed) {
			finalize(stream, blocks, "error", "Antigravity service is closed");
			return;
		}
		if (typeof deviceId !== "string" || !deviceId || typeof sessionId !== "string" || !sessionId) {
			finalize(stream, blocks, "error", "deviceId and sessionId are required");
			return;
		}
		if (typeof modelId !== "string" || !modelId) {
			finalize(stream, blocks, "error", "modelId is required");
			return;
		}
		if (Object.hasOwn(params, "requestId") && !isValidRequestId(requestId)) {
			finalize(stream, blocks, "error", "Invalid requestId");
			return;
		}
		if (!Array.isArray(messages)) {
			finalize(stream, blocks, "error", "messages must be an array");
			return;
		}
		if (signal?.aborted) {
			finalize(stream, blocks, "aborted", "Operation aborted");
			return;
		}

		let resolvedTurn;
		try {
			resolvedTurn = splitAntigravityTurnContext(messages, rawTurnContext);
		} catch (err) {
			const msg = redactText(err instanceof Error ? err.message : String(err));
			finalize(stream, blocks, "error", msg);
			return;
		}

		const inspectInput = (existing, pendingIds) => {
			const cleanMessages = resolvedTurn.messages;
			const inputIndex = resolvedTurn.inputIndex;
			const input = inputIndex === null ? undefined : cleanMessages[inputIndex];
			const inputRole = input?.role;
			const pairedIds = pairedToolResultIds(cleanMessages);
			const userPrompt = extractUserPrompt({ messages: cleanMessages }, inputIndex);
			const images = extractImages({ messages: cleanMessages }, inputIndex);
			const resume = inputRole === "assistant" || inputRole === "toolResult";
			const hasPendingAssistantCall = inputRole === "assistant" && Array.isArray(input.content) &&
				input.content.some((part) => part?.type === "toolCall" && !pairedIds.has(part.id));
			let error;
			if (inputIndex === null || (!resume && !userPrompt && images.length === 0) ||
				(resume && !existing && !pendingIds.has(input?.toolCallId)) || hasPendingAssistantCall ||
				(inputRole === "toolResult" && !pairedIds.has(input.toolCallId))) {
				const turnSource = rawTurnContext !== undefined ? "explicit" : "legacy";
				console.warn(
					`[antigravity] no-user-message source=${turnSource} tailRole=${safeMessageRole(messages.at(-1))} inputRole=${safeMessageRole(input)} rawCount=${messages.length} effectiveCount=${cleanMessages.length} contextNotes=${resolvedTurn.contextNotes.length} bound=${Boolean(existing?.conversationId)}`,
				);
				error = inputRole === "toolResult" || hasPendingAssistantCall
					? "Antigravity cannot resume without a paired tool call and its result."
					: "No user message to send to Antigravity.";
			}
			return { cleanMessages, inputIndex, inputRole, pairedIds, userPrompt, images, resume, error };
		};

		const slot = getOrCreateSession(deviceId, sessionId);
		// Reject semantically invalid newcomers before they can claim the cancel
		// scope of a parked turn. This preflight state is never used for dispatch.
		const admissionError = inspectInput(store.get(slot.key), new Set(slot.roundTrips.pendingIds)).error;
		if (admissionError) {
			void trimIdleSessions();
			finalize(stream, blocks, "error", admissionError);
			return;
		}
		if (slot.activeConsumer) {
			finalize(stream, blocks, "error", "Antigravity session already has an active stream");
			return;
		}
		slot.activeConsumer = true;
		// Preflight can be cancelled without changing who owns a parked native turn.
		const request = { requestId, cancelled: false };
		slot.preflightRequest = request;
		slot.serialUsers += 1;
		slot.lastUsedAt = Date.now();
		const isCancelled = () => closed || signal?.aborted || request.cancelled;
		let parked = false;
		let compactionReclaimed = false;

		let releaseSerial;
		const prevSerial = slot.serialChain;
		slot.serialChain = new Promise((resolve) => {
			releaseSerial = resolve;
		});

		let consumerReleased = false;
		const releaseConsumer = () => {
			if (consumerReleased) return;
			consumerReleased = true;
			if (slot.preflightRequest === request) slot.preflightRequest = null;
			if (slot.nativeOwner === request) detachCallerSignal(slot);
			slot.activeConsumer = false;
			slot.lastUsedAt = Date.now();
		};

		const finishConsumer = (reason, message) => {
			releaseConsumer();
			finalize(stream, blocks, reason, message);
		};

		try {
			await prevSerial;
			if (closed) {
				finishConsumer("error", "Antigravity service is closed");
				return;
			}
			if (!isCancelled()) {
				ensureIsolatedProfile(profile);
				await mcpBridge.ensureStarted();
			}

			let nativeEpochForRequest = null;
			const throwIfCancelled = () => {
				if (nativeEpochForRequest !== null && slot.deliveryFailure?.epoch === nativeEpochForRequest) {
					throw slot.deliveryFailure.error;
				}
				if (isCancelled()) throw createAbortError("Operation aborted");
			};

			const existing = store.get(slot.key);
			const pendingIds = new Set(slot.roundTrips.pendingIds);
			// Retirement or cancellation can change binding state while queued.
			const { cleanMessages, inputIndex, inputRole, pairedIds, userPrompt, images, resume, error: inputError } =
				inspectInput(existing, pendingIds);
			// Early cancellation must still abort a compatible tool continuation's
			// inherited turn. Check that compatibility before claiming the turn.
			if (inputRole !== "toolResult" || inputError || closed) throwIfCancelled();
			if (inputError) {
				finishConsumer("error", inputError);
				return;
			}

			const messageCount = cleanMessages.length;
			const requestEnd = inputIndex + 1;
			// A user is the actual prompt. A tool/assistant continuation is history
			// too: never replace its content with a generic resume instruction.
			const historyEnd = inputRole === "user" ? inputIndex : requestEnd;
			const historySnapshot = createContextSnapshot(cleanMessages, { endIndex: historyEnd });
			const requestSnapshot = createContextSnapshot(cleanMessages, { endIndex: requestEnd });
			const auxiliaryHashes = createContextSnapshot(resolvedTurn.auxiliaryMessages).messageHashes;
			const sameAuxiliary = equalHashes(existing?.auxiliaryHashes, auxiliaryHashes);
			const livePrefix = existing?.phase === "parked" && existing.turnRecallHook === true &&
				sameAuxiliary && contextPrefixMatches(existing.checkpoint, requestSnapshot);
			const continuationTail = livePrefix
				? cleanMessages.slice(0, requestEnd).filter((message) => message.role !== "system")
					.slice(existing.checkpoint.messageHashes.length)
				: [];
			const liveResults = inputRole === "toolResult"
				? collectToolResults(continuationTail, [...pendingIds]).filter((result) => pairedIds.has(result.toolCallId))
				: [];
			const active = liveResults.length > 0 && livePrefix && continuationTail.length > 0 &&
				continuationTail.every((message) => message.role === "toolResult" && pendingIds.has(message.toolCallId)) &&
				new Set(continuationTail.map((message) => message.toolCallId)).size === continuationTail.length &&
				slot.turnAbort && !slot.turnAbort.signal.aborted && slot.mcpRegistration &&
				slot.nativeConfig?.modelId === modelId && slot.nativeConfig.reasoning === normalizedReasoning
				? slot.driver.reentry() : null;
			const superseded = !active && (Boolean(slot.driver.activeHandle) || pendingIds.size > 0);
			const mcpTools = toMcpToolDefinitions(toolsFromMessages(cleanMessages));
			const claimNativeTurn = () => {
				slot.preflightRequest = null;
				slot.nativeOwner = request;
				slot.currentTools = mcpTools;
				slot.allowedToolNames = new Set(mcpTools.map((tool) => tool.name));
			};
			const reusable = !superseded && existing?.phase === "ready" && existing.turnRecallHook === true &&
				existing.modelId === modelId && existing.reasoning === normalizedReasoning &&
				sameAuxiliary && contextPrefixMatches(existing.checkpoint, historySnapshot);
			const prompt = resume ? RESUME_PROMPT : userPrompt;
			let loadRetried = false;
			const claimedResults = new Set();
			const awaitToolDeliveries = async () => {
				throwIfCancelled();
				const registration = slot.mcpRegistration;
				if (!registration || slot.nativeEpoch !== nativeEpochForRequest) {
					throw new Error("Antigravity MCP turn changed before result delivery was confirmed");
				}
				await registration.waitForDeliveries({ signal: slot.turnAbort?.signal });
				throwIfCancelled();
			};

			const markUncertain = async (conversationId) => {
				const prior = store.get(slot.key);
				const nativeId = conversationId ?? prior?.conversationId;
				if (nativeId) {
					store.set(slot.key, {
						...prior,
						conversationId: nativeId,
						lastStepIdx: -1,
						phase: "uncertain",
					});
				}
				// Retain the uncertain identity as a recovery hint for tool results,
				// but it can never authorize native history reuse after a restart.
				await store.flush();
			};
			const rememberConversation = async (conversationId, phase, assistant, exposedIds = []) => {
				const pendingToolCallIds = [...new Set([...slot.roundTrips.pendingIds, ...exposedIds])];
				store.set(slot.key, {
					conversationId,
					lastStepIdx: -1,
					lastMessageCount: messageCount,
					turnRecallHook: true,
					modelId,
					reasoning: normalizedReasoning,
					phase: phase === "ready" && pendingToolCallIds.length > 0 ? "parked" : phase,
					checkpoint: createContextSnapshot(cleanMessages, {
						endIndex: requestEnd, appendMessages: assistant ? [assistant] : [],
					}),
					pendingToolCallIds,
					auxiliaryHashes,
				});
				await store.flush();
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
						// Persist before the Host can act on this toolUse. A process loss
						// leaves enough intent to rebuild with the later real result.
						await rememberConversation(conversationId, "parked", exposed, [activity.callId]);
						throwIfCancelled();
						// Normal HTTP completion must not abort the still-running ACP turn.
						releaseConsumer();
						parked = true;
						consumeActivity(stream, blocks, activity);
						return true;
					}
					const matchedMcpToolError = observeBridgeToolActivity(slot.bridgeToolActivity, activity);
					consumeActivity(stream, blocks, activity, matchedMcpToolError);
				}
			};

			const executePrompt = async (spec) => {
				let conversationId = spec.conversationId;
				let skipMessages = spec.skipMessages;
				for (;;) {
					throwIfCancelled();
					const replay = buildContextReplay(spec.messages, {
						endIndex: spec.endIndex,
						skipMessages,
						auxiliaryIndices: resolvedTurn.historicalAuxiliaryIndices,
					});
					const currentImages = spec.imagesInReplay && !conversationId ? [] : spec.images;
					const fullPrompt = buildFullPrompt(
						conversationId ? undefined : systemPromptFromMessages(cleanMessages),
						"", spec.prompt,
						{
							routeNote: resolvedTurn.routeNote,
							auxiliaryMessages: resolvedTurn.auxiliaryMessages,
							historyImageCount: replay.images.length,
							currentImageCount: currentImages.length,
						},
					);
					const runImages = [
						...replay.images,
						...resolvedTurn.contextImages,
						...currentImages,
					];
					const contextBlock = replay.text ? {
						uri: `urn:pibot-bridge:context/${requestSnapshot.systemHash}`,
						text: replay.text,
					} : undefined;
					assertPromptFits(fullPrompt, runImages, contextBlock);
					// A rejected replay must leave the prior native turn and checkpoint untouched.
					if (slot.nativeOwner !== request) {
						claimNativeTurn();
						if (superseded) await abortSessionTurn(slot, "Context changed before tool continuation");
						throwIfCancelled();
					}
					await markUncertain(conversationId);
					throwIfCancelled();
					detachCallerSignal(slot);
					const turnAbort = new AbortController();
					slot.turnAbort = turnAbort;
					nativeEpochForRequest = registerTurnMcp(slot);
					slot.nativeConfig = { modelId, reasoning: normalizedReasoning };
					attachCallerSignal(slot, signal);
					throwIfCancelled();
					const contentBefore = JSON.stringify(blocks.partial.content);
					const handle = await slot.driver.run({
						cwd: profile.workspaceDir,
						model: modelId,
						effort: reasoning,
						mode: "default",
						skipPermissions: false,
						conversationId,
						prompt: fullPrompt,
						images: runImages.length > 0 ? runImages : undefined,
						turnRecall: spec.recall,
						contextBlock,
						signal: turnAbort.signal,
					});
					if (await drainTurn(handle)) return { parked: true };
					const outcome = await handle.outcome;
					throwIfCancelled();
					if (outcome.status === "OK" && !outcome.aborted) await awaitToolDeliveries();
					if (outcome.sessionLoadFailed === true && conversationId && !loadRetried &&
						!outcome.aborted && contentBefore === JSON.stringify(blocks.partial.content)) {
						// The driver guarantees no prompt has been sent in this case.
						// Rebuild once from the complete authoritative context, never from
						// the incremental request prepared for the missing conversation.
						await markUncertain(outcome.conversationId);
						loadRetried = true;
						conversationId = null;
						skipMessages = 0;
						continue;
					}
					if (conversationId && outcome.status === "OK" && !outcome.aborted &&
						outcome.conversationId !== conversationId) {
						return { outcome: { ...outcome, status: "ERROR",
							error: "Antigravity changed its conversation without rebuilding the context." } };
					}
					return { outcome };
				}
			};

			let result;
			if (active) {
				claimNativeTurn();
				nativeEpochForRequest = slot.nativeEpoch;
				throwIfCancelled();
				await markUncertain(existing.conversationId);
				throwIfCancelled();
				attachCallerSignal(slot, signal);
				for (const item of liveResults) {
					if (!slot.roundTrips.resolve(item.toolCallId, item.text, item.isError, item.images)) {
						throw new Error(`Antigravity tool result lost its pending call before delivery: ${item.toolCallId}`);
					}
				}
				if (await drainTurn(active)) return;
				result = { outcome: await active.outcome };
				if (result.outcome.status === "OK" && !result.outcome.aborted) await awaitToolDeliveries();
			} else {
				result = await executePrompt({
					conversationId: reusable ? existing.conversationId : null,
					skipMessages: reusable ? existing.checkpoint.messageHashes.length : 0,
					messages: cleanMessages,
					endIndex: historyEnd,
					prompt,
					images,
					recall: inputRole === "user" ? resolvedTurn.turnRecall : undefined,
				});
				if (result.parked) return;
			}

			// An escalated tool can finish while the native turn ends without
			// polling. Deliver only results present in this authoritative request,
			// and never resurrect a stale result from an edited/compacted history.
			if (active && result.outcome.status === "OK" && !result.outcome.aborted) {
				const more = [];
				for (const view of slot.roundTrips.claimAllUndelivered()) {
					const received = collectToolResults(cleanMessages, [view.callId]).at(-1);
					if (!received || !pairedIds.has(view.callId)) {
						slot.roundTrips.unclaim(view.callId);
						continue;
					}
					claimedResults.add(view.callId);
					more.push({ callId: view.callId, name: view.name,
						reason: "this result completed after your earlier tool acknowledgement; the action has already run",
						text: received.text, isError: received.isError, images: received.images });
				}
				if (more.length > 0) {
					const resumedMessages = [...cleanMessages, structuredClone(blocks.partial)];
					result = await executePrompt({
						conversationId: result.outcome.conversationId ?? null,
						skipMessages: result.outcome.conversationId
							? createContextSnapshot(resumedMessages).messageHashes.length : 0,
						messages: resumedMessages,
						endIndex: resumedMessages.length,
						prompt: buildLateResultPrompt(more),
						images: more.flatMap((item) => item.images),
						imagesInReplay: true,
					});
					if (result.parked) return;
				}
			}

			const outcome = result.outcome;
			throwIfCancelled();
			if (outcome.aborted || outcome.status === "ERROR") {
				for (const callId of claimedResults) slot.roundTrips.unclaim(callId);
				await markUncertain(outcome.conversationId);
				await abortSessionTurn(slot, "Antigravity turn did not finish reliably");
				finishConsumer(outcome.aborted ? "aborted" : "error",
					outcome.aborted ? "Operation aborted" : redactText(outcome.error ?? "Antigravity turn failed"));
				return;
			}
			if (!outcome.conversationId) throw new Error("Antigravity completed without a conversation identity");
			await awaitToolDeliveries();
			// The driver already emitted text deltas; its outcome spans all tool continuations.
			if (blocks.partial.content.length === 0) ensureTextOpen(stream, blocks);
			blocks.partial.stopReason = "stop";
			await rememberConversation(outcome.conversationId, "ready", blocks.partial);
			throwIfCancelled();
			slot.turnAbort = null;
			slot.bridgeToolActivity = null;
			finishConsumer("stop");
		} catch (err) {
			invalidateAuthCacheIfNeeded(err);
			if (slot.nativeOwner === request) {
				await abortSessionTurn(slot, "Antigravity stream interrupted").catch(() => {});
			}
			const aborted = isCancelled() || err?.name === "AbortError";
			const msg = redactText(err instanceof Error ? err.message : String(err));
			finishConsumer(aborted ? "aborted" : "error", msg);
		} finally {
			releaseConsumer();
			try {
				const ownsNative = slot.nativeOwner === request;
				if (slot.compaction && (!slot.nativeOwner || ownsNative) && !parked &&
					!slot.driver.activeHandle && slot.roundTrips.pendingIds.length === 0) {
					try {
						await retireSessionResources(slot, "compaction finished", ownsNative);
						compactionReclaimed = true;
					} catch (error) {
						console.warn(`[antigravity] compaction cleanup failed: ${redactText(String(error))}`);
					}
				}
			} finally {
				slot.serialUsers -= 1;
				if (compactionReclaimed && slot.serialUsers === 0 && !slot.activeConsumer &&
					!slot.driver.activeHandle && slot.roundTrips.pendingIds.length === 0 && sessions.get(slot.key) === slot) {
					sessions.delete(slot.key);
				}
				releaseSerial();
				void trimIdleSessions();
			}
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
