// Per-run MCP tool call waiters, slow-tool escalation/poll handling, and prompt formatting.

import {
	ANTIGRAVITY_ESCALATE_AFTER_MS,
	ANTIGRAVITY_MAX_FRAME_BYTES,
	ANTIGRAVITY_POLL_TOOL,
} from "../../center-contract/antigravity.js";
import type {
	AntigravityContentPart,
	AntigravityImageBlock,
	AntigravityInputItem,
	AntigravitySectionUpdate,
	AntigravityToolDecl,
} from "../../center-contract/antigravity.js";
import type { McpCallToolResult, McpContentBlock, McpToolDefinition } from "./mcp-bridge.ts";

const BRIDGE_SERVER_RE = /^(?:pibot|pi)-bridge(?:-\d+)?$/i;

export const POLL_TOOL_NAME = ANTIGRAVITY_POLL_TOOL.name;

export function isAllowedBridgeServer(mcpServer: string | undefined): boolean {
	return typeof mcpServer === "string" && BRIDGE_SERVER_RE.test(mcpServer);
}

function normalizeSchema(parameters: unknown): Record<string, unknown> {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
		return { type: "object", properties: {} };
	}
	const schema = parameters as Record<string, unknown>;
	return typeof schema.type === "string"
		? { ...schema }
		: { type: "object", properties: {}, ...schema };
}

export const BRIDGE_POLL_TOOL_DEF: McpToolDefinition = {
	name: ANTIGRAVITY_POLL_TOOL.name,
	description: ANTIGRAVITY_POLL_TOOL.description,
	inputSchema: normalizeSchema(ANTIGRAVITY_POLL_TOOL.parameters),
};

export function toMcpToolDefinitions(tools: readonly AntigravityToolDecl[] = []): McpToolDefinition[] {
	const out: McpToolDefinition[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		if (!tool || typeof tool.name !== "string" || !tool.name || seen.has(tool.name)) continue;
		seen.add(tool.name);
		out.push({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			inputSchema: normalizeSchema(tool.parameters),
		});
	}
	if (!seen.has(POLL_TOOL_NAME)) out.push(BRIDGE_POLL_TOOL_DEF);
	return out;
}

function escapeAttr(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function formatTurnPrompt({
	sections,
	routeNote,
	inputs,
}: {
	sections?: readonly AntigravitySectionUpdate[];
	routeNote?: string;
	inputs: readonly AntigravityInputItem[];
}): { text: string; images: AntigravityImageBlock[] } {
	const blocks: string[] = [];
	if (Array.isArray(sections)) {
		for (const section of sections) {
			if (!section || typeof section.key !== "string" || !section.key) continue;
			const keyAttr = escapeAttr(section.key);
			if (section.value === null) {
				blocks.push(`<context key="${keyAttr}" removed="true" />`);
			} else if (typeof section.value === "string") {
				blocks.push(`<context key="${keyAttr}">\n${section.value}\n</context>`);
			}
		}
	}
	if (typeof routeNote === "string" && routeNote.trim().length > 0) {
		blocks.push(`<turn-routing>\n${routeNote}\n</turn-routing>`);
	}

	const images: AntigravityImageBlock[] = [];
	const validInputs = Array.isArray(inputs) ? inputs : [];
	const inputParts = validInputs.map((item, index) => {
		const text = typeof item?.text === "string" ? item.text : "";
		const attached: AntigravityImageBlock[] = [];
		if (Array.isArray(item?.images)) {
			for (const img of item.images) {
				if (img && typeof img.data === "string" && img.data.length > 0 &&
					typeof img.mimeType === "string" && img.mimeType.trim().length > 0) {
					attached.push({ data: img.data, mimeType: img.mimeType });
				}
			}
		}
		const first = images.length + 1;
		images.push(...attached);
		const source = typeof item?.source === "string" && item.source.trim().length > 0
			? item.source.trim()
			: undefined;
		if (validInputs.length === 1) {
			return source ? `[Source: ${source}]\n${text}` : text;
		}
		const header = source ? `[New input ${index + 1} (${source})]` : `[New input ${index + 1}]`;
		const imageNote = attached.length > 0
			? `\nAttached images ${first}-${images.length} belong to this input.`
			: "";
		return `${header}${imageNote}\n${text}`;
	});

	const body = inputParts.join("\n\n");
	if (body.length > 0 || blocks.length === 0) blocks.push(body);
	return { text: blocks.join("\n\n"), images };
}

export function assertPromptFits(text: string, images: readonly AntigravityImageBlock[] = []): void {
	const prompt = [
		...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
		{ type: "text", text },
	];
	if (Buffer.byteLength(JSON.stringify({ prompt }), "utf8") + 4096 > ANTIGRAVITY_MAX_FRAME_BYTES) {
		throw Object.assign(
			new RangeError("The new input exceeds the ACP frame budget; send a smaller message."),
			{ code: "PAYLOAD_TOO_LARGE", statusCode: 413 },
		);
	}
}

function normalizeMcpContent(content: unknown, isError: boolean): McpContentBlock[] {
	const blocks: McpContentBlock[] = [];
	if (typeof content === "string") {
		blocks.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const rec = part as AntigravityContentPart;
			if (rec.type === "text" && typeof rec.text === "string") {
				blocks.push({ type: "text", text: rec.text });
			} else if (rec.type === "image" && typeof rec.data === "string" && rec.data.length > 0 &&
				typeof rec.mimeType === "string" && rec.mimeType.trim().length > 0) {
				blocks.push({ type: "image", data: rec.data, mimeType: rec.mimeType });
			}
		}
	}
	if (blocks.length === 0) {
		blocks.push({ type: "text", text: isError ? "Tool execution failed" : "" });
	}
	return blocks;
}

function splitToolResultBlocks(content: unknown, isError: boolean): {
	text: string;
	images: AntigravityImageBlock[];
} {
	const textParts: string[] = [];
	const images: AntigravityImageBlock[] = [];
	if (typeof content === "string") {
		if (content.length > 0) textParts.push(content);
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const rec = part as AntigravityContentPart;
			if (rec.type === "text" && typeof rec.text === "string") {
				textParts.push(rec.text);
			} else if (rec.type === "image" && typeof rec.data === "string" && rec.data.length > 0 &&
				typeof rec.mimeType === "string" && rec.mimeType.trim().length > 0) {
				images.push({ data: rec.data, mimeType: rec.mimeType });
			}
		}
	}
	const text = textParts.join("\n");
	if (text.length === 0 && images.length === 0 && isError) {
		return { text: "Tool execution failed", images };
	}
	return { text, images };
}

function toolResultTextWithImageNote(callId: string, text: string, imageCount: number): string {
	if (imageCount <= 0) return text;
	const note =
		`Visual attachments for Pi host tool result ${JSON.stringify(callId)}: ` +
		`${imageCount} image(s), in result order.`;
	return text ? `${text}\n\n${note}` : note;
}

function errorResult(message: string): McpCallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function stillRunningResult(name: string, callId: string): McpCallToolResult {
	return {
		content: [{
			type: "text",
			text: `STILL RUNNING: Tool "${name}" (callId="${callId}") is still executing on the host. Do not re-run it. Call ${POLL_TOOL_NAME} with { "callId": "${callId}" } instead of re-running it.`,
		}],
		isError: false,
	};
}

function cloneResult(result: McpCallToolResult): McpCallToolResult {
	return { content: result.content.map((block) => ({ ...block })), isError: Boolean(result.isError) };
}

export interface ToolRequestEvent {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface RunToolWaitersOptions {
	escalateAfterMs?: number;
	onToolRequest: (event: ToolRequestEvent) => void;
	onInFlightChange?: (count: number) => void;
	/** When supplied, delivers tool-result images through the native PreInvocation
	 *  hook channel and returns a text-only MCP block (single image channel). */
	deliverToolImages?: (callId: string, images: readonly AntigravityImageBlock[]) => void;
}

interface WaiterHandle {
	settle: (result: McpCallToolResult) => void;
	cleanup: () => void;
}

interface ToolEntry {
	callId: string;
	name: string;
	escalated: boolean;
	running: boolean;
	completed: boolean;
	directWaiter: WaiterHandle | null;
	pollWaiters: Set<WaiterHandle>;
	result: McpCallToolResult | null;
	rawText: string;
	rawIsError: boolean;
	pendingImages: AntigravityImageBlock[];
}

export class RunToolWaiters {
	#escalateAfterMs: number;
	#onToolRequest: (event: ToolRequestEvent) => void;
	#onInFlightChange?: (count: number) => void;
	#deliverToolImages?: (callId: string, images: readonly AntigravityImageBlock[]) => void;
	#entries = new Map<string, ToolEntry>();
	#inFlight = 0;
	#failed = false;
	#failReason = "";

	constructor(options: RunToolWaitersOptions) {
		this.#escalateAfterMs = options.escalateAfterMs ?? ANTIGRAVITY_ESCALATE_AFTER_MS;
		this.#onToolRequest = options.onToolRequest;
		this.#onInFlightChange = options.onInFlightChange;
		this.#deliverToolImages = options.deliverToolImages;
	}

	get inFlightCount(): number {
		return this.#inFlight;
	}

	#setInFlight(next: number): void {
		if (next === this.#inFlight) return;
		this.#inFlight = next;
		this.#onInFlightChange?.(next);
	}

	#materializeResult(entry: ToolEntry): McpCallToolResult {
		if (entry.result) return cloneResult(entry.result);
		const images = entry.pendingImages;
		entry.pendingImages = [];
		if (this.#deliverToolImages && images.length > 0) {
			try {
				this.#deliverToolImages(entry.callId, images);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				entry.result = {
					content: [{
						type: "text",
						text: [
							entry.rawText,
							`Tool image delivery failed: ${reason}.`,
							"The tool already ran. Its images were not delivered; do not repeat side effects to retry an image.",
						].filter(Boolean).join("\n\n"),
					}],
					isError: true,
				};
				return cloneResult(entry.result);
			}
			// Single image channel: do not also emit MCP image blocks (which agy offloads above ~19 KB).
			entry.result = {
				content: [{
					type: "text",
					text: toolResultTextWithImageNote(entry.callId, entry.rawText, images.length),
				}],
				isError: entry.rawIsError,
			};
			return cloneResult(entry.result);
		}
		entry.result = {
			content: [{ type: "text", text: entry.rawText }],
			isError: entry.rawIsError,
		};
		return cloneResult(entry.result);
	}

	#createWaiter(
		signal: AbortSignal,
		resolve: (result: McpCallToolResult) => void,
		onTimeout: (waiter: WaiterHandle) => void,
		onAbort: (waiter: WaiterHandle) => void,
	): WaiterHandle {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abortHandler = () => {
			if (!settled) onAbort(waiter);
		};
		const waiter: WaiterHandle = {
			settle: (result) => {
				if (settled) return;
				settled = true;
				resolve(result);
			},
			cleanup: () => {
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				signal.removeEventListener("abort", abortHandler);
			},
		};
		signal.addEventListener("abort", abortHandler, { once: true });
		if (this.#escalateAfterMs > 0 && Number.isFinite(this.#escalateAfterMs)) {
			timer = setTimeout(() => {
				if (!settled) onTimeout(waiter);
			}, this.#escalateAfterMs);
			timer.unref?.();
		}
		return waiter;
	}

	handleToolCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<McpCallToolResult> {
		if (this.#failed) {
			return Promise.resolve(errorResult(this.#failReason || "Antigravity run ended"));
		}
		return name === POLL_TOOL_NAME
			? this.#handlePoll(args, signal)
			: this.#handleDirect(callId, name, args, signal);
	}

	#handlePoll(args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallToolResult> {
		const targetCallId = typeof args?.callId === "string" ? args.callId.trim() : "";
		if (!targetCallId) {
			return Promise.resolve(errorResult(`${POLL_TOOL_NAME} requires a non-empty string "callId".`));
		}
		const entry = this.#entries.get(targetCallId);
		if (!entry || !entry.escalated) {
			return Promise.resolve(
				errorResult(
					`Unknown or non-escalated callId "${targetCallId}" in the current run. Do not re-run side-effectful tools.`,
				),
			);
		}
		if (entry.completed) return Promise.resolve(this.#materializeResult(entry));
		if (signal.aborted) return Promise.resolve(errorResult("MCP poll request aborted"));

		return new Promise<McpCallToolResult>((resolve) => {
			const waiter = this.#createWaiter(
				signal,
				resolve,
				(w) => {
					entry.pollWaiters.delete(w);
					w.cleanup();
					w.settle(stillRunningResult(entry.name, entry.callId));
				},
				(w) => {
					entry.pollWaiters.delete(w);
					w.cleanup();
					w.settle(errorResult("MCP poll request aborted"));
				},
			);
			entry.pollWaiters.add(waiter);
		});
	}

	#handleDirect(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<McpCallToolResult> {
		if (signal.aborted) return Promise.resolve(errorResult("MCP tool request aborted"));

		return new Promise<McpCallToolResult>((resolve) => {
			const entry: ToolEntry = {
				callId,
				name,
				escalated: false,
				running: true,
				completed: false,
				directWaiter: null,
				pollWaiters: new Set(),
				result: null,
				rawText: "",
				rawIsError: false,
				pendingImages: [],
			};
			const waiter = this.#createWaiter(
				signal,
				resolve,
				(w) => {
					entry.escalated = true;
					if (entry.directWaiter === w) entry.directWaiter = null;
					w.cleanup();
					w.settle(stillRunningResult(entry.name, entry.callId));
				},
				(w) => {
					if (entry.directWaiter === w) entry.directWaiter = null;
					w.cleanup();
					w.settle(errorResult("MCP tool request aborted"));
				},
			);
			entry.directWaiter = waiter;
			this.#entries.set(callId, entry);
			this.#setInFlight(this.#inFlight + 1);

			try {
				this.#onToolRequest({ callId, name, args });
			} catch (err) {
				if (entry.running) {
					entry.running = false;
					this.#setInFlight(Math.max(0, this.#inFlight - 1));
				}
				if (entry.directWaiter === waiter) entry.directWaiter = null;
				this.#entries.delete(callId);
				waiter.cleanup();
				waiter.settle(errorResult(err instanceof Error ? err.message : String(err)));
			}
		});
	}

	resolve(callId: string, content: readonly AntigravityContentPart[] | string, isError = false): boolean {
		if (this.#failed) return false;
		const entry = this.#entries.get(callId);
		if (!entry || !entry.running) return false;

		entry.running = false;
		entry.completed = true;
		entry.rawIsError = Boolean(isError);
		if (this.#deliverToolImages) {
			const split = splitToolResultBlocks(content, Boolean(isError));
			entry.rawText = split.text;
			entry.pendingImages = split.images;
		} else {
			entry.result = {
				content: normalizeMcpContent(content, Boolean(isError)),
				isError: Boolean(isError),
			};
		}
		this.#setInFlight(Math.max(0, this.#inFlight - 1));

		if (entry.directWaiter) {
			const waiter = entry.directWaiter;
			entry.directWaiter = null;
			const delivered = this.#materializeResult(entry);
			if (!entry.escalated) this.#entries.delete(callId);
			waiter.cleanup();
			waiter.settle(delivered);
			return true;
		}
		if (entry.pollWaiters.size > 0) {
			const waiters = [...entry.pollWaiters];
			entry.pollWaiters.clear();
			const delivered = this.#materializeResult(entry);
			for (const waiter of waiters) {
				waiter.cleanup();
				waiter.settle(cloneResult(delivered));
			}
			return true;
		}
		if (!entry.escalated) this.#entries.delete(callId);
		return true;
	}

	failAll(reason: string): void {
		if (this.#failed) return;
		this.#failed = true;
		this.#failReason = reason;
		const err = errorResult(reason);
		for (const entry of this.#entries.values()) {
			entry.running = false;
			entry.pendingImages = [];
			if (entry.directWaiter) {
				const waiter = entry.directWaiter;
				entry.directWaiter = null;
				waiter.cleanup();
				waiter.settle(cloneResult(err));
			}
			for (const waiter of [...entry.pollWaiters]) {
				waiter.cleanup();
				waiter.settle(cloneResult(err));
			}
			entry.pollWaiters.clear();
		}
		this.#entries.clear();
		this.#setInFlight(0);
	}
}
