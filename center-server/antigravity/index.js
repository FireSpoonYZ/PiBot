// Center Antigravity ACP bridge service.
//
// Exports openAntigravity({ dataRoot, bin, geminiHome } = {}) returning:
//   - authStatus({ signal } = {}) => Promise<{ authenticated: boolean }>
//   - login({ notify, prompt, signal } = {}) => Promise<void>
//   - catalog({ signal } = {}) => Promise<Model[]>
//   - stream({ deviceId, sessionId, modelId, messages, reasoning }, { signal } = {}) => AssistantMessageEventStream
//   - cancel({ deviceId, sessionId }) => Promise<void>
//   - close() => Promise<void>

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { loginAcpProfile, probeAcpAuth } from "./auth.ts";
import { probeAcpCatalog, resolveThoughtLevel } from "./catalog.ts";
import { ANTIGRAVITY_BRIDGE_SERVER, ANTIGRAVITY_PROVIDER_ID } from "./constants.ts";
import { SharedMcpBridge } from "./mcp-bridge.ts";
import { AGENT_NAME, ensureIsolatedProfile, resolveProfile } from "./profile.ts";
import { redactText } from "./vendor/redact.ts";
import {
	buildContextDigest,
	buildFullPrompt,
	buildLateResultPrompt,
	collectToolResults,
	consumeActivity,
	DIGEST_PREAMBLE,
	ensureTextOpen,
	extractImages,
	extractUserPrompt,
	finalize,
	newAssistant,
	POLL_TOOL_NAME,
	RESUME_PROMPT,
	systemPromptFromMessages,
	toMcpToolDefinitions,
	ToolRoundTrips,
	toolsFromMessages,
	appendText,
} from "./round-trips.ts";
import { makeSessionKey, SessionStore } from "./sessions.ts";
import { AcpDriver } from "./vendor/acp/driver.ts";

const BRIDGE_SERVER_RE = /^(?:pibot|pi)-bridge(?:-\d+)?$/i;
const BRIDGE_PERMISSION_RE = /^(?:mcp_)?(?:pibot|pi)-bridge(?:-\d+)?(?:_|$)/i;

function isBridgePermissionRequest(req) {
	const tc = req?.toolCall;
	if (!tc || typeof tc !== "object") return false;
	const server = tc._meta?.mcp?.server;
	if (typeof server === "string" && BRIDGE_SERVER_RE.test(server)) return true;
	const candidates = [tc.name, tc.title].filter((v) => typeof v === "string");
	return candidates.some((v) => BRIDGE_PERMISSION_RE.test(v));
}

export function openAntigravity({ dataRoot, bin, geminiHome } = {}) {
	const profile = resolveProfile({ dataRoot, bin, geminiHome });
	const store = new SessionStore(profile.sessionsPath);
	const mcpBridge = new SharedMcpBridge();
	const sessions = new Map();
	const modelMap = new Map();
	const activeCatalogs = new Set();
	const activeAuthProbes = new Set();
	let activeLogin = null;
	let closed = false;

	function getOrCreateSession(deviceId, sessionId) {
		const key = makeSessionKey(deviceId, sessionId);
		let slot = sessions.get(key);
		if (slot) return slot;

		let roundTrips;
		const driver = new AcpDriver({
			bin: profile.bin,
			binArgs: ["acp", "--agent", AGENT_NAME, "--process-per-session"],
			geminiDir: profile.geminiHome,
			mcpServers: () => [mcpBridge.serverConfig(slot.mcpToken)],
			permissionPolicy: (req) => (isBridgePermissionRequest(req) ? "auto" : "deny"),
		});
		roundTrips = new ToolRoundTrips(driver);
		driver.onTurnEnd = (outcome) => {
			if (outcome.conversationId) {
				roundTrips.stampConversation(outcome.conversationId);
			}
		};

		slot = {
			key,
			deviceId,
			sessionId,
			driver,
			roundTrips,
			mcpToken: "",
			unregisterMcp: null,
			currentTools: [],
			allowedToolNames: new Set(),
			activeConsumer: false,
			cancelEpoch: 0,
			turnAbort: null,
			turnCleanup: null,
			serialChain: Promise.resolve(),
		};

		const reg = mcpBridge.registerSession({
			listTools: () => slot.currentTools,
			onToolCall: (callId, name, args, signal) => {
				if (!slot.allowedToolNames.has(name)) {
					return Promise.resolve({
						content: [{ type: "text", text: `Error: unknown or unavailable tool "${name}"` }],
						isError: true,
					});
				}
				return slot.roundTrips.onToolCall(callId, name, args, signal);
			},
		});
		slot.mcpToken = reg.token;
		slot.unregisterMcp = reg.unregister;
		sessions.set(key, slot);
		return slot;
	}

	async function abortSessionTurn(slot, reason) {
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
	}

	function attachCallerSignal(slot, signal) {
		if (!signal) {
			slot.turnCleanup = null;
			return;
		}
		const onAbort = () => {
			void abortSessionTurn(slot, "Operation aborted");
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
		const { deviceId, sessionId, modelId, messages, reasoning } = params;
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
		if (!Array.isArray(messages)) {
			finalize(stream, blocks, "error", "messages must be an array");
			return;
		}
		if (signal?.aborted) {
			finalize(stream, blocks, "aborted", "Operation aborted");
			return;
		}

		const slot = getOrCreateSession(deviceId, sessionId);
		if (slot.activeConsumer) {
			finalize(stream, blocks, "error", "Antigravity session already has an active stream");
			return;
		}
		slot.activeConsumer = true;
		const startEpoch = slot.cancelEpoch;

		let releaseSerial;
		const prevSerial = slot.serialChain;
		slot.serialChain = new Promise((resolve) => {
			releaseSerial = resolve;
		});

		let consumerReleased = false;
		const releaseConsumer = () => {
			if (consumerReleased) return;
			consumerReleased = true;
			detachCallerSignal(slot);
			slot.activeConsumer = false;
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
			if (signal?.aborted || slot.cancelEpoch !== startEpoch) {
				finishConsumer("aborted", "Operation aborted");
				return;
			}

			ensureIsolatedProfile(profile);
			await mcpBridge.ensureStarted();
			if (signal?.aborted || slot.cancelEpoch !== startEpoch) {
				finishConsumer("aborted", "Operation aborted");
				return;
			}

			const tools = toolsFromMessages(messages);
			const mcpTools = toMcpToolDefinitions(tools);
			slot.currentTools = mcpTools;
			slot.allowedToolNames = new Set(mcpTools.map((t) => t.name));

			const existing = store.get(slot.key);
			const messageCount = messages.length;

			const results = collectToolResults(messages, slot.roundTrips.pendingIds);
			const isContinuation = results.length > 0;
			const escalatedNames = results
				.map((r) => slot.roundTrips.poll(r.toolCallId)?.name)
				.filter((n) => Boolean(n));
			for (const r of results) {
				slot.roundTrips.resolve(r.toolCallId, r.text, r.isError, r.images);
			}

			const late = [];
			if (!isContinuation) {
				for (const r of collectToolResults(messages, slot.roundTrips.deadIds)) {
					const dead = slot.roundTrips.consumeDead(r.toolCallId);
					if (dead) {
						late.push({
							name: dead.name,
							reason: dead.reason,
							text: r.text,
							isError: r.isError,
							images: r.images.length > 0 ? r.images : undefined,
						});
					}
				}
			}

			let redeliveryConversation;
			const collectStranded = () =>
				slot.roundTrips.claimAllUndelivered().map((view) => {
					redeliveryConversation ??= view.conversationId;
					return {
						callId: view.callId,
						name: view.name,
						reason: "you never received this result: you ended your turn without calling bridge_poll_result",
						text: view.text ?? "(no output)",
						isError: view.isError ?? false,
						images: view.images,
					};
				});

			const knownModel = modelMap.get(modelId);
			const effort =
				knownModel?.reasoning === false
					? undefined
					: resolveThoughtLevel(reasoning, knownModel?.thinkingLevelMap);

			let handle;
			const active = isContinuation ? slot.driver.reentry() : null;
			if (active) {
				handle = active;
				if (!slot.turnAbort || slot.turnAbort.signal.aborted) {
					slot.turnAbort = new AbortController();
				}
				attachCallerSignal(slot, signal);
			} else {
				// If a fresh turn arrives while a stale parked turn is still open,
				// tear down the stale turn cleanly before starting the new prompt.
				if (!isContinuation && slot.driver.activeHandle) {
					await abortSessionTurn(slot, "Superseded by new turn");
				}
				late.push(...collectStranded());
				if (isContinuation && late.length === 0) {
					if (escalatedNames.length === 0) {
						finishConsumer("error", "tool result arrived but no antigravity turn is running");
						return;
					}
					appendText(
						stream,
						blocks,
						`[${ANTIGRAVITY_BRIDGE_SERVER}] ${escalatedNames.join(", ")} finished; the result is available via ${POLL_TOOL_NAME}.`,
					);
					finishConsumer("stop");
					return;
				}
				if (
					isContinuation &&
					late.length > 0 &&
					redeliveryConversation === undefined &&
					!existing?.conversationId
				) {
					for (const l of late) {
						if (l.callId) slot.roundTrips.unclaim(l.callId);
					}
					appendText(
						stream,
						blocks,
						`[${ANTIGRAVITY_BRIDGE_SERVER}] ${escalatedNames.join(", ")} finished, but no conversation is bound to re-deliver into; the result stays available via ${POLL_TOOL_NAME}.`,
					);
					finishConsumer("stop");
					return;
				}

				const userPrompt = extractUserPrompt({ messages });
				const images = extractImages({ messages });
				const lastRole = messages[messages.length - 1]?.role;
				const resume =
					!userPrompt &&
					images.length === 0 &&
					late.length === 0 &&
					Boolean(existing?.conversationId) &&
					(lastRole === "toolResult" || lastRole === "assistant");
				const prompt = resume ? RESUME_PROMPT : userPrompt;
				if (!prompt && images.length === 0 && late.length === 0) {
					finishConsumer("error", "No user message to send to Antigravity.");
					return;
				}

				const watermark = existing?.lastMessageCount ?? 0;
				const digest =
					late.length === 0 && !resume
						? buildContextDigest(messages, watermark, { ownProvider: ANTIGRAVITY_PROVIDER_ID })
						: "";
				const rawSysPrompt = !existing?.conversationId
					? systemPromptFromMessages(messages)
					: undefined;
				const fullPrompt =
					late.length > 0
						? buildLateResultPrompt(late, prompt || undefined)
						: buildFullPrompt(rawSysPrompt, "", prompt ?? "");
				const runImages = [...images, ...late.flatMap((l) => l.images ?? [])];

				slot.turnAbort = new AbortController();
				attachCallerSignal(slot, signal);

				try {
					handle = await slot.driver.run({
						cwd: profile.workspaceDir,
						model: modelId,
						effort,
						mode: "default",
						skipPermissions: false,
						conversationId: redeliveryConversation ?? existing?.conversationId ?? null,
						prompt: fullPrompt,
						images: runImages.length > 0 ? runImages : undefined,
						contextBlock: digest
							? {
									uri: `urn:pibot-bridge:context-digest/${messageCount}`,
									text: `${DIGEST_PREAMBLE}\n\n${digest}`,
								}
							: undefined,
						signal: slot.turnAbort.signal,
					});
				} catch (err) {
					for (const l of late) {
						if (l.callId) slot.roundTrips.unclaim(l.callId);
					}
					slot.turnAbort = null;
					const msg = redactText(err instanceof Error ? err.message : String(err));
					finishConsumer("error", `Antigravity failed to start: ${msg}`);
					return;
				}
			}

			const drainTurn = async (h) => {
				for (;;) {
					const activity = await h.next();
					if (!activity) return undefined;
					if (activity.type === "bridge_call") {
						// Detach caller's HTTP signal and release activeConsumer BEFORE emitting
						// toolUse/stream.end() so normal HTTP response completion keeps the
						// parked ACP turn alive and the continuation Call 2 has zero race.
						releaseConsumer();
						consumeActivity(stream, blocks, activity);
						return "parked";
					}
					consumeActivity(stream, blocks, activity);
				}
			};

			let drainState;
			try {
				drainState = await drainTurn(handle);
			} catch (err) {
				const msg = redactText(err instanceof Error ? err.message : String(err));
				await abortSessionTurn(slot, msg);
				finishConsumer("error", msg);
				return;
			}

			if (drainState === "parked") {
				if (!existing) {
					const parkedConv = slot.driver.snapshot().conversationId;
					if (parkedConv) {
						store.set(slot.key, {
							conversationId: parkedConv,
							lastStepIdx: -1,
							lastMessageCount: messageCount,
						});
					}
				}
				return;
			}

			let outcome = await handle.outcome;

			if (isContinuation && outcome.status === "OK" && !outcome.aborted) {
				const more = collectStranded();
				if (more.length > 0) {
					const conv =
						redeliveryConversation ?? outcome.conversationId ?? existing?.conversationId ?? null;
					const moreImages = more.flatMap((s) => s.images ?? []);
					try {
						const lateHandle = await slot.driver.run({
							cwd: profile.workspaceDir,
							model: modelId,
							effort,
							mode: "default",
							skipPermissions: false,
							conversationId: conv,
							prompt: buildLateResultPrompt(more),
							images: moreImages.length > 0 ? moreImages : undefined,
							signal: slot.turnAbort?.signal,
						});
						try {
							if ((await drainTurn(lateHandle)) === "parked") return;
						} catch (err) {
							const msg = redactText(err instanceof Error ? err.message : String(err));
							await abortSessionTurn(slot, msg);
							finishConsumer("error", msg);
							return;
						}
						outcome = await lateHandle.outcome;
					} catch {
						for (const l of more) {
							if (l.callId) slot.roundTrips.unclaim(l.callId);
						}
					}
				}
			}

			slot.turnAbort = null;
			if (outcome.conversationId) {
				if (existing?.conversationId && outcome.conversationId !== existing.conversationId) {
					store.delete(slot.key);
				} else if (outcome.status === "OK" && !outcome.aborted) {
					store.set(slot.key, {
						conversationId: outcome.conversationId,
						lastStepIdx: -1,
						lastMessageCount: messageCount,
					});
				}
			}

			if (outcome.aborted) {
				finishConsumer("aborted", "Operation aborted");
				return;
			}
			if (outcome.status === "ERROR") {
				finishConsumer("error", redactText(outcome.error ?? "Antigravity turn failed"));
				return;
			}
			if (blocks.textIdx === null && outcome.response) {
				appendText(stream, blocks, outcome.response);
			}
			if (blocks.textIdx === null && blocks.thinkingIdx === null) {
				ensureTextOpen(stream, blocks);
			}
			finishConsumer("stop");
		} catch (err) {
			slot.turnAbort = null;
			const msg = redactText(err instanceof Error ? err.message : String(err));
			finishConsumer("error", msg);
		} finally {
			releaseConsumer();
			releaseSerial();
		}
	}

	async function recycleIdleDrivers(reason) {
		const tasks = [];
		for (const slot of [...sessions.values()]) {
			if (slot.activeConsumer || slot.driver.activeHandle || slot.driver.state !== "ready") {
				continue;
			}
			let release;
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
							slot.driver.state === "ready"
						) {
							await slot.driver.close("recycle", reason);
						}
					})
					.catch(() => {})
					.finally(() => release()),
			);
		}
		if (tasks.length > 0) {
			await Promise.allSettled(tasks);
		}
	}

	return {
		async authStatus({ signal } = {}) {
			if (closed) {
				throw new Error("Antigravity service is closed");
			}
			const ac = new AbortController();
			const onCallerAbort = () => ac.abort();
			if (signal?.aborted) ac.abort();
			else signal?.addEventListener("abort", onCallerAbort, { once: true });

			const probePromise = probeAcpAuth(profile, { signal: ac.signal });
			const entry = { abortController: ac, promise: probePromise };
			activeAuthProbes.add(entry);
			try {
				const authenticated = await probePromise;
				return { authenticated };
			} finally {
				signal?.removeEventListener("abort", onCallerAbort);
				activeAuthProbes.delete(entry);
			}
		},

		async login({ notify, prompt, signal } = {}) {
			const makeAbortError = () => {
				const err = new Error("Antigravity 登录已取消");
				err.name = "AbortError";
				return err;
			};
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
					await recycleIdleDrivers("post-login");
				}
			} finally {
				signal?.removeEventListener("abort", onCallerAbort);
				if (activeLogin === entry) {
					activeLogin = null;
				}
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
				const models = await probePromise;
				modelMap.clear();
				for (const model of models) {
					modelMap.set(model.id, model);
				}
				return models;
			} finally {
				signal?.removeEventListener("abort", onCallerAbort);
				activeCatalogs.delete(entry);
			}
		},

		stream({ deviceId, sessionId, modelId, messages, reasoning } = {}, { signal } = {}) {
			const stream = createAssistantMessageEventStream();
			void runStreamTurn(
				stream,
				{ deviceId, sessionId, modelId, messages, reasoning },
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

		async cancel({ deviceId, sessionId } = {}) {
			if (typeof deviceId !== "string" || !deviceId || typeof sessionId !== "string" || !sessionId) {
				return;
			}
			const slot = sessions.get(makeSessionKey(deviceId, sessionId));
			if (!slot) return;
			slot.cancelEpoch += 1;
			await abortSessionTurn(slot, "Antigravity session cancelled");
		},

		async close() {
			if (closed) return;
			closed = true;
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
					slot.unregisterMcp?.();
					await slot.driver.close("shutdown", "service close");
				}),
			]);
			await mcpBridge.close();
			await store.flush();
		},
	};
}
