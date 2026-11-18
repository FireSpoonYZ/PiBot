// Pi tool round-trips, escalation registry, prompt digest/assembly, and
// ACP activity -> AssistantMessageEventStream translation.
//
// Adapted from @estebanforge/pi-antigravity-bridge `src/provider.ts`:
//   - Exposes ALL tools from `getCurrentTools(messages)` (including builtins)
//     plus `bridge_poll_result` via the per-session MCP bridge.
//   - Rejects any non-bridge native operation tool appearing in `session/update`
//     explicitly with DisallowedNativeToolError instead of silent execution.
//   - Removes stream-json / WrapperReplay / native re-exec paths.

import {
	getCurrentSystemPrompt,
	getCurrentTools,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonValue,
	type Message,
	type Tool,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { ANTIGRAVITY_API, ANTIGRAVITY_BRIDGE_SERVER, ANTIGRAVITY_PROVIDER_ID } from "./constants.ts";
import type { McpCallToolResult, McpToolDefinition } from "./mcp-bridge.ts";
import type { DriverActivity, TurnDriver } from "./vendor/driver-types.ts";
import { toPiUsage } from "./vendor/stream-events.ts";

export const POLL_TOOL_NAME = "bridge_poll_result";
export const BRIDGE_TIMEOUT_MS = 480_000;
export const ESCALATED_TIMEOUT_MS = 1_800_000;
export const ESCALATE_AFTER_MS = 20_000;
export const DELEGATION_ESCALATE_MS = 120_000;

const MAX_PARK_TOMBSTONES = 64;
const COMPACTION_MARKER = "compacted into the following summary";
const DELEGATION_NAME_RE = /subagent|delegate|^agent(_|$)/i;
const BRIDGE_SERVER_RE = /^(?:pibot|pi)-bridge(?:-\d+)?$/;

export const RESUME_PROMPT =
	"[The previous attempt of this turn failed and was discarded. Check your conversation history for the last step you completed, then continue the task from there. Do not repeat completed actions.]";

export const DIGEST_PREAMBLE =
	"[The following is context from the broader session that this Antigravity turn was not directly spawned for: compaction summaries and turns handled by other providers or local tools. Your own prior turns are already in your conversation history. Use this for continuity only.]";

export const SYSTEM_PROMPT_PREAMBLE =
	"[The following is the system prompt of the session that spawned this conversation: operating instructions plus project context. Apply it for this whole conversation.]";

export const SYSTEM_PROMPT_END = "[END SYSTEM PROMPT]";

export const TOOL_PRIORITY_NOTE =
	"[Tool bridge: all file, shell, workspace, search, and user-interaction tools run on the host via the pibot-bridge MCP server. Always call the pibot-bridge tools directly; do not attempt local CLI tools. When a bridge call answers STILL RUNNING with a callId, call bridge_poll_result until the result lands instead of ending your turn.]";

export const BRIDGE_POLL_TOOL_DEF: McpToolDefinition = {
	name: POLL_TOOL_NAME,
	description:
		"Poll the result of an escalated host bridge tool call that returned STILL RUNNING with a callId.",
	inputSchema: {
		type: "object",
		properties: {
			callId: {
				type: "string",
				description: "The callId returned in the STILL RUNNING acknowledgement.",
			},
		},
		required: ["callId"],
		additionalProperties: false,
	},
};

export class DisallowedNativeToolError extends Error {
	readonly toolName: string;
	readonly mcpServer?: string;

	constructor(toolName: string, mcpServer?: string) {
		const scope = mcpServer ? `MCP server "${mcpServer}"` : "Antigravity native tool runtime";
		super(
			`Disallowed tool execution: Antigravity attempted "${toolName}" via ${scope} instead of "${ANTIGRAVITY_BRIDGE_SERVER}".`,
		);
		this.name = "DisallowedNativeToolError";
		this.toolName = toolName;
		this.mcpServer = mcpServer;
	}
}

export function isAllowedBridgeServer(mcpServer: string | undefined): boolean {
	return typeof mcpServer === "string" && BRIDGE_SERVER_RE.test(mcpServer);
}

export function toMcpToolDefinitions(tools: readonly Tool[]): McpToolDefinition[] {
	const out: McpToolDefinition[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		if (!tool || typeof tool.name !== "string" || tool.name.length === 0) continue;
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		out.push({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			inputSchema: normalizeSchema(tool.parameters),
		});
	}
	if (!seen.has(POLL_TOOL_NAME)) {
		out.push(BRIDGE_POLL_TOOL_DEF);
	}
	return out;
}

export function toolsFromMessages(messages: readonly Message[]): Tool[] {
	return getCurrentTools(messages as Message[]);
}

export function systemPromptFromMessages(messages: readonly Message[]): string | undefined {
	const prompt = getCurrentSystemPrompt(messages as Message[]);
	return prompt && prompt.length > 0 ? prompt : undefined;
}

function normalizeSchema(parameters: unknown): object {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
		return { type: "object", properties: {} };
	}
	const rec = parameters as Record<string, unknown>;
	if (typeof rec.type === "string" && rec.type.length > 0) {
		return rec;
	}
	return { type: "object", ...rec, properties: rec.properties ?? {} };
}

export function defaultEscalateAfterMs(name: string): number {
	return DELEGATION_NAME_RE.test(name) ? DELEGATION_ESCALATE_MS : ESCALATE_AFTER_MS;
}

export interface BridgeEscalation {
	escalated: true;
	callId: string;
	name: string;
}

export interface PollView {
	state: "running" | "done" | "failed";
	name: string;
	text?: string;
	isError?: boolean;
	reason?: string;
	images?: Array<{ data: string; mimeType: string }>;
	delivered?: boolean;
	conversationId?: string;
}

export class EscalationRegistry {
	#calls = new Map<string, PollView>();

	#trim(): void {
		while (this.#calls.size > MAX_PARK_TOMBSTONES) {
			const settled = [...this.#calls.entries()].filter(([, e]) => e.state !== "running");
			const victim = (settled.find(([, e]) => e.delivered) ?? settled[0])?.[0];
			if (victim === undefined) break;
			this.#calls.delete(victim);
		}
	}

	escalate(callId: string, name: string): void {
		this.#calls.set(callId, { name, state: "running" });
		this.#trim();
	}

	settleDone(
		callId: string,
		text: string,
		isError: boolean,
		images: Array<{ data: string; mimeType: string }> = [],
	): void {
		const e = this.#calls.get(callId);
		if (!e) return;
		e.state = "done";
		e.text = text;
		e.isError = isError;
		if (images.length > 0) e.images = images;
		this.#trim();
	}

	settleFailed(callId: string, reason: string): void {
		const e = this.#calls.get(callId);
		if (!e) return;
		e.state = "failed";
		e.reason = reason;
		this.#trim();
	}

	poll(callId: string): PollView | undefined {
		const e = this.#calls.get(callId);
		return e ? { ...e } : undefined;
	}

	markDelivered(callId: string): boolean {
		const e = this.#calls.get(callId);
		if (!e || e.state === "running") return false;
		e.delivered = true;
		return true;
	}

	claimAllUndelivered(): Array<PollView & { callId: string }> {
		const out: Array<PollView & { callId: string }> = [];
		for (const [callId, e] of this.#calls) {
			if (e.state === "done" && !e.delivered) {
				e.delivered = true;
				out.push({ ...e, callId });
			}
		}
		return out;
	}

	unclaim(callId: string): void {
		const e = this.#calls.get(callId);
		if (e && e.state === "done") e.delivered = false;
	}

	stampConversation(conversationId: string): void {
		for (const e of this.#calls.values()) {
			if (e.state === "running") e.conversationId ??= conversationId;
		}
	}

	clear(): void {
		this.#calls.clear();
	}
}

export function formatEscalatedAck(e: BridgeEscalation): McpCallToolResult {
	return {
		content: [
			{
				type: "text",
				text: [
					`STILL RUNNING: the host tool "${e.name}" has not finished yet.`,
					`Call ${POLL_TOOL_NAME} with callId "${e.callId}" to get the result. Poll again if it still reports running; you may do other work between polls.`,
					"Do NOT end your turn while this call is unresolved: keep polling until it reports done or failed. Ending the turn strands the result.",
				].join("\n"),
			},
		],
		isError: false,
	};
}

export function formatPollAnswer(callId: string, view: PollView | undefined): McpCallToolResult {
	if (!view) {
		return {
			content: [
				{
					type: "text",
					text: `Error: no escalated bridge call "${callId}". It either finished within the first seconds (its result is in your original tool result) or the callId is wrong.`,
				},
			],
			isError: true,
		};
	}
	if (view.state === "running") {
		return {
			content: [
				{
					type: "text",
					text: `STILL RUNNING: "${view.name}" (callId ${callId}) has not finished. Poll again later.`,
				},
			],
			isError: false,
		};
	}
	if (view.state === "failed") {
		return {
			content: [
				{
					type: "text",
					text: `Error: bridge call "${view.name}" (callId ${callId}) failed: ${view.reason}`,
				},
			],
			isError: true,
		};
	}
	return {
		content: [
			...(view.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
			{ type: "text", text: view.text || (view.images?.length ? "[image result]" : "(no output)") },
		],
		isError: view.isError ?? false,
	};
}

interface PendingRoundTrip {
	name: string;
	resolve: (r: McpCallToolResult) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	escalated?: boolean;
	escalateTimer?: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
	signal?: AbortSignal;
}

export class ToolRoundTrips {
	#pending = new Map<string, PendingRoundTrip>();
	#dead = new Map<string, { name: string; reason: string }>();
	#escalations = new EscalationRegistry();
	#escalateAfterMs: number | ((name: string) => number);
	#getDriver: () => TurnDriver;
	#log: (s: string, d?: unknown, level?: "debug" | "info" | "warn" | "error") => void;

	constructor(
		driver: TurnDriver | (() => TurnDriver),
		log?: (s: string, d?: unknown, level?: "debug" | "info" | "warn" | "error") => void,
		opts: { escalateAfterMs?: number | ((name: string) => number) } = {},
	) {
		this.#getDriver = typeof driver === "function" ? driver : () => driver;
		this.#log = log ?? (() => {});
		this.#escalateAfterMs = opts.escalateAfterMs ?? defaultEscalateAfterMs;
	}

	get pendingIds(): string[] {
		return [...this.#pending.keys()];
	}

	get deadIds(): string[] {
		return [...this.#dead.keys()];
	}

	consumeDead(toolCallId: string): { name: string; reason: string } | undefined {
		const dead = this.#dead.get(toolCallId);
		if (!dead) return undefined;
		this.#dead.delete(toolCallId);
		return dead;
	}

	poll(callId: string): PollView | undefined {
		return this.#escalations.poll(callId);
	}

	markDelivered(callId: string): boolean {
		return this.#escalations.markDelivered(callId);
	}

	claimAllUndelivered(): Array<PollView & { callId: string }> {
		return this.#escalations.claimAllUndelivered();
	}

	unclaim(callId: string): void {
		this.#escalations.unclaim(callId);
	}

	stampConversation(conversationId: string): void {
		this.#escalations.stampConversation(conversationId);
	}

	failAll(reason: string, opts: { includeEscalated?: boolean } = {}): void {
		for (const id of [...this.#pending.keys()]) {
			const entry = this.#pending.get(id);
			if (!entry) continue;
			if (!opts.includeEscalated && entry.escalated) continue;
			this.#fail(id, reason);
		}
		if (opts.includeEscalated) {
			this.#dead.clear();
			this.#escalations.clear();
		}
	}

	#fail(callId: string, reason: string): void {
		const entry = this.#pending.get(callId);
		if (!entry) return;
		this.#pending.delete(callId);
		clearTimeout(entry.timer);
		if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
		if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
		this.#dead.set(callId, { name: entry.name, reason });
		while (this.#dead.size > MAX_PARK_TOMBSTONES) {
			const oldest = this.#dead.keys().next().value;
			if (oldest === undefined) break;
			this.#dead.delete(oldest);
		}
		if (entry.escalated) {
			this.#escalations.settleFailed(callId, reason);
		} else {
			entry.reject(new Error(reason));
		}
		this.#getDriver().kickIdle();
		this.#log("round-trip-fail", { callId, name: entry.name, reason });
	}

	onToolCall = (
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<McpCallToolResult> => {
		if (name === POLL_TOOL_NAME) {
			const targetCallId = typeof args.callId === "string" ? args.callId.trim() : "";
			const view = targetCallId ? this.poll(targetCallId) : undefined;
			if (view && view.state !== "running") {
				this.markDelivered(targetCallId);
			}
			return Promise.resolve(formatPollAnswer(targetCallId, view));
		}

		const handle = this.#getDriver().activeHandle;
		if (!handle) {
			return Promise.reject(
				new Error(
					"no active antigravity turn; the host tool bridge only works while an antigravity turn is running",
				),
			);
		}
		if (signal.aborted) {
			return Promise.reject(new Error("agy disconnected before the tool call could be parked"));
		}

		return new Promise<McpCallToolResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#fail(callId, `host tool round-trip timed out after ${BRIDGE_TIMEOUT_MS / 1000}s`);
			}, BRIDGE_TIMEOUT_MS);
			const onAbort = () => this.#fail(callId, "agy disconnected before the tool result arrived");
			signal.addEventListener("abort", onAbort, { once: true });
			const entry: PendingRoundTrip = { name, resolve, reject, timer, onAbort, signal };
			const escalateAfterMs =
				typeof this.#escalateAfterMs === "function"
					? this.#escalateAfterMs(name)
					: this.#escalateAfterMs;
			if (escalateAfterMs > 0) {
				entry.escalateTimer = setTimeout(() => {
					const e = this.#pending.get(callId);
					if (!e) return;
					e.escalated = true;
					clearTimeout(e.timer);
					e.timer = setTimeout(() => {
						this.#fail(
							callId,
							`escalated bridge call timed out after ${ESCALATED_TIMEOUT_MS / 60_000} minutes`,
						);
					}, ESCALATED_TIMEOUT_MS);
					this.#escalations.escalate(callId, e.name);
					resolve(formatEscalatedAck({ escalated: true, callId, name: e.name }));
				}, escalateAfterMs);
			}
			this.#pending.set(callId, entry);
			handle.pushExternal({ type: "bridge_call", callId, name, args });
		});
	};

	resolve(
		toolCallId: string,
		text: string,
		isError: boolean,
		images: Array<{ data: string; mimeType: string }> = [],
	): boolean {
		const entry = this.#pending.get(toolCallId);
		if (!entry) return false;
		this.#pending.delete(toolCallId);
		clearTimeout(entry.timer);
		if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
		if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
		if (entry.escalated) {
			this.#escalations.settleDone(toolCallId, text, isError, images);
		} else {
			entry.resolve({
				content: [
					...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
					{ type: "text", text: text || (images.length > 0 ? "[image result]" : "(no output)") },
				],
				isError,
			});
		}
		this.#getDriver().kickIdle();
		this.#log("round-trip-resolved", { callId: toolCallId, name: entry.name, isError });
		return true;
	}
}

export interface CollectedToolResult {
	toolCallId: string;
	text: string;
	isError: boolean;
	images: Array<{ data: string; mimeType: string }>;
}

export function collectToolResults(
	messages: readonly Message[],
	targetIds: readonly string[],
): CollectedToolResult[] {
	if (targetIds.length === 0) return [];
	const targetSet = new Set(targetIds);
	const out: CollectedToolResult[] = [];
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const id = (m as { toolCallId?: string }).toolCallId;
		if (!id || !targetSet.has(id)) continue;
		out.push({
			toolCallId: id,
			text: blocksToText(m.content).trim(),
			isError: m.isError === true,
			images: extractResultImages(m.content),
		});
	}
	return out;
}

export interface LateToolResult {
	callId?: string;
	name: string;
	reason: string;
	text: string;
	isError: boolean;
	images?: Array<{ data: string; mimeType: string }>;
}

export function buildLateResultPrompt(late: LateToolResult[], userPrompt?: string): string {
	const blocks = late.map((r) =>
		[
			`host tool "${r.name}": ${r.reason}.`,
			r.isError ? "The tool reported an error:" : "Result:",
			r.text.trim() || (r.images?.length ? "[image result attached]" : "(no output)"),
		].join("\n"),
	);
	const header =
		"Late tool delivery: treat the following as the results of your earlier tool calls.";
	const body = [header, ...blocks].join("\n\n");
	return userPrompt ? `${body}\n\n${userPrompt}` : body;
}

export function extractUserPrompt(context: Pick<TranscriptContext, "messages">): string | null {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user") return null;
	const content = last.content;
	if (typeof content === "string") return content;
	return (
		content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim() || null
	);
}

export function extractImages(
	context: Pick<TranscriptContext, "messages">,
): Array<{ data: string; mimeType: string }> {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user" || typeof last.content === "string") return [];
	return last.content
		.filter((b): b is { type: "image"; data: string; mimeType: string } => b.type === "image")
		.map((b) => ({ data: b.data, mimeType: b.mimeType }));
}

export function buildFullPrompt(
	systemPrompt: string | undefined,
	digest: string,
	prompt: string,
): string {
	const parts: string[] = [];
	if (systemPrompt) {
		parts.push(
			`${SYSTEM_PROMPT_PREAMBLE}\n\n${systemPrompt}\n\n${TOOL_PRIORITY_NOTE}\n\n${SYSTEM_PROMPT_END}`,
		);
	}
	if (digest) {
		parts.push(`${DIGEST_PREAMBLE}\n\n${digest}`);
	}
	if (prompt) {
		parts.push(prompt);
	}
	return parts.join("\n\n---\n\n");
}

function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

function extractResultImages(content: unknown): Array<{ data: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(b): b is { type: "image"; data: string; mimeType: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "image",
		)
		.map((b) => ({ data: b.data, mimeType: b.mimeType }))
		.filter(
			(i) => typeof i.mimeType === "string" && typeof i.data === "string" && i.data.length > 0,
		);
}

function stripCompactionWrapping(t: string): string {
	const open = t.indexOf("<summary>");
	const close = t.lastIndexOf("</summary>");
	if (open >= 0 && close > open) return t.slice(open + "<summary>".length, close).trim();
	return t.trim();
}

export function buildContextDigest(
	messages: readonly Message[],
	watermark: number,
	opts: { ownProvider?: string; maxChars?: number } = {},
): string {
	const own = opts.ownProvider ?? ANTIGRAVITY_PROVIDER_ID;
	const maxChars = opts.maxChars ?? 8000;
	if (messages.length === 0) return "";

	let summaryPart: string | null = null;
	const deltaParts: string[] = [];

	let lastCompactionIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const t = blocksToText(m.content);
		if (t.includes(COMPACTION_MARKER)) {
			lastCompactionIdx = i;
			summaryPart = `[compaction summary]\n${stripCompactionWrapping(t)}`;
			break;
		}
	}

	let start = Math.max(0, Math.floor(watermark));
	if (lastCompactionIdx >= 0) start = Math.max(start, lastCompactionIdx + 1);
	const end = Math.max(0, messages.length - 1);
	for (let i = start; i < end; i++) {
		const m = messages[i];
		if (m.role === "assistant") {
			if (m.provider === own) continue;
			const t = blocksToText(m.content).trim();
			if (!t) continue;
			deltaParts.push(`[assistant turn from ${m.provider}]\n${t}`);
		} else if (m.role === "user") {
			const t = blocksToText(m.content);
			if (t.includes(COMPACTION_MARKER)) continue;
			if (!t.trim()) continue;
			deltaParts.push(`[earlier user message]\n${t}`);
		} else if (m.role === "toolResult") {
			const t = blocksToText(m.content).trim();
			deltaParts.push(
				`[tool result: ${m.toolName}${m.isError ? " (error)" : ""}]\n${t || "(no text output)"}`,
			);
		}
	}

	const SEP = "\n\n";
	const MARKER = "[truncated]";
	let delta = deltaParts.join(SEP);
	if (maxChars > 0) {
		const budget = Math.max(0, maxChars - (summaryPart ? summaryPart.length + SEP.length : 0));
		if (delta.length > budget) {
			const kept: string[] = [];
			let used = 0;
			for (let i = deltaParts.length - 1; i >= 0; i--) {
				const cost = deltaParts[i].length + (kept.length > 0 ? SEP.length : 0);
				if (used + cost > budget) break;
				kept.unshift(deltaParts[i]);
				used += cost;
			}
			if (kept.length > 0) {
				delta = `${MARKER}\n${kept.join(SEP)}`;
			} else {
				const room = Math.max(0, budget - MARKER.length - 1);
				delta = room > 0 ? `${MARKER}\n${deltaParts[deltaParts.length - 1].slice(-room)}` : "";
			}
		}
	}

	return [summaryPart, delta]
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.join(SEP);
}

// --- AssistantMessageEventStream assembly ----------------------------------

export interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function newAssistant(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		model: modelId,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
}

export function appendText(
	stream: AssistantMessageEventStream,
	b: BlockState,
	delta: string,
): void {
	ensureTextOpen(stream, b);
	(b.partial.content[b.textIdx!] as { type: "text"; text: string }).text += delta;
	stream.push({ type: "text_delta", contentIndex: b.textIdx!, delta, partial: b.partial });
}

function appendThinking(
	stream: AssistantMessageEventStream,
	b: BlockState,
	delta: string,
): void {
	ensureThinkingOpen(stream, b);
	(b.partial.content[b.thinkingIdx!] as { type: "thinking"; thinking: string }).thinking += delta;
	stream.push({
		type: "thinking_delta",
		contentIndex: b.thinkingIdx!,
		delta,
		partial: b.partial,
	});
}

export function ensureTextOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx !== null) return;
	closeThinking(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "text", text: "" });
	b.textIdx = b.partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex: b.textIdx, partial: b.partial });
}

function ensureThinkingOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx !== null) return;
	closeText(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "thinking", thinking: "" });
	b.thinkingIdx = b.partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: b.thinkingIdx, partial: b.partial });
}

function closeText(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx === null) return;
	const idx = b.textIdx;
	b.textIdx = null;
	const content = (b.partial.content[idx] as { type: "text"; text: string }).text;
	stream.push({ type: "text_end", contentIndex: idx, content, partial: b.partial });
}

function closeThinking(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx === null) return;
	const idx = b.thinkingIdx;
	b.thinkingIdx = null;
	const content = (b.partial.content[idx] as { type: "thinking"; thinking: string }).thinking;
	stream.push({ type: "thinking_end", contentIndex: idx, content, partial: b.partial });
}

function emitToolUse(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	id: string,
	name: string,
	args: Record<string, JsonValue>,
): void {
	const partial = blocks.partial;
	closeThinking(stream, blocks);
	closeText(stream, blocks);
	ensureStarted(stream, blocks);
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
	partial.content.push(toolCall);
	const contentIndex = partial.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	stream.end();
}

export function consumeActivity(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	activity: DriverActivity,
): "parked" | "continue" {
	switch (activity.type) {
		case "text":
			appendText(stream, blocks, activity.delta);
			return "continue";
		case "thought":
			if (typeof activity.delta === "string" && activity.delta.length > 0) {
				appendThinking(stream, blocks, activity.delta);
			}
			return "continue";
		case "usage":
			toPiUsage(activity.usage, blocks.partial.usage);
			return "continue";
		case "tool_start":
		case "tool_done":
		case "tool_error":
			// Only host MCP bridge calls are allowed; fail explicitly on native/foreign tools.
			if (!isAllowedBridgeServer(activity.mcpServer)) {
				throw new DisallowedNativeToolError(activity.name, activity.mcpServer);
			}
			return "continue";
		case "bridge_call":
			emitToolUse(
				stream,
				blocks,
				activity.callId,
				activity.name,
				activity.args as Record<string, JsonValue>,
			);
			return "parked";
	}
}

export function finalize(
	stream: AssistantMessageEventStream,
	b: BlockState,
	reason: "stop" | "error" | "aborted",
	message?: string,
): void {
	closeText(stream, b);
	closeThinking(stream, b);
	if (reason === "stop") {
		b.partial.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: b.partial });
	} else {
		b.partial.stopReason = reason;
		if (message) b.partial.errorMessage = message;
		stream.push({ type: "error", reason, error: b.partial });
	}
	stream.end();
}
