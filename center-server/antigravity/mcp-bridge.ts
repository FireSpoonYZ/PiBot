// Multi-session Streamable HTTP MCP bridge for Antigravity ACP turns.
//
// Adapted from @estebanforge/pi-antigravity-bridge's `src/mcp-server.ts` using
// the official `@modelcontextprotocol/sdk` Server + StreamableHTTPServerTransport
// (with protocol-version header clamping for newer agy clients).
//
// Each active Center session registers its own handler and gets a per-session
// bearer token sent via the `x-bridge-token` header from ACP's `mcpServers[]`
// registration, so concurrent sessions share one loopback HTTP listener without
// touching `~/.gemini/config/mcp_config.json` or cross-routing tool calls.

import crypto from "node:crypto";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	LATEST_PROTOCOL_VERSION,
	ListToolsRequestSchema,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { ANTIGRAVITY_BRIDGE_SERVER } from "./constants.ts";

export const BRIDGE_MCP_NAME = ANTIGRAVITY_BRIDGE_SERVER;

/** Shared-secret header every bridge request must carry. */
export const TOKEN_HEADER = "x-bridge-token";

const MAX_BODY_BYTES = 1_000_000;
const DELIVERY_TIMEOUT_MS = 10_000;

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface McpCallToolResult {
	content: McpContentBlock[];
	isError?: boolean;
}

export interface SessionMcpHandler {
	listTools(): McpToolDefinition[];
	/** A response could not be written; the owning native turn must fail closed. */
	onDeliveryError?(error: Error): void;
	onToolCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<McpCallToolResult>;
}

export interface McpRegistration {
	token: string;
	unregister(): void;
	waitForDeliveries(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

interface DeliveryReceipt {
	promise: Promise<void>;
	armTimeout(): void;
	finish(error?: Error): void;
}

interface RegisteredSession {
	handler: SessionMcpHandler;
	active: boolean;
	error?: Error;
	deliveries: Set<DeliveryReceipt>;
}

function deliveryError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function failDelivery(session: RegisteredSession, error: unknown): void {
	if (session.error) return;
	session.error = deliveryError(error);
	// Notify before resolving waiters so a successful ACP end_turn cannot race
	// ahead of the owner's invalidation of its checkpoint.
	if (session.active) {
		try { session.handler.onDeliveryError?.(session.error); } catch { /* keep cleaning up receipts */ }
	}
	for (const receipt of [...session.deliveries]) receipt.finish(session.error);
}

function trackDelivery(
	session: RegisteredSession,
	res: http.ServerResponse,
	abort: AbortController,
): DeliveryReceipt {
	let settle!: () => void;
	let finished = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolve) => { settle = resolve; });
	const onFinish = () => receipt.finish(res.statusCode >= 400
		? new Error(`Antigravity MCP response failed with HTTP ${res.statusCode}`) : undefined);
	const onClose = () => {
		if (!res.writableFinished) receipt.finish(new Error("Antigravity MCP response closed before delivery"));
	};
	const onError = (error: Error) => receipt.finish(error);
	const receipt: DeliveryReceipt = {
		promise,
		armTimeout() {
			if (finished || timer) return;
			// Host execution can remain parked much longer. This timer starts only
			// when its response is ready to write, never while waiting for the Host.
			timer = setTimeout(() => receipt.finish(new Error("Antigravity MCP response delivery timed out")), DELIVERY_TIMEOUT_MS);
			timer.unref?.();
		},
		finish(error) {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			res.off("finish", onFinish);
			res.off("close", onClose);
			res.off("error", onError);
			session.deliveries.delete(receipt);
			if (error) {
				failDelivery(session, error);
				abort.abort();
				res.destroy();
			}
			settle();
		},
	};
	session.deliveries.add(receipt);
	res.once("finish", onFinish);
	res.once("close", onClose);
	res.once("error", onError);
	if (res.writableFinished) onFinish();
	else if (res.destroyed) onClose();
	return receipt;
}

async function waitForDeliveries(
	session: RegisteredSession,
	{ signal, timeoutMs = DELIVERY_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		if (signal?.aborted) throw new Error("Antigravity MCP delivery wait aborted");
		await Promise.race([
			(async () => {
				for (;;) {
					if (session.error) throw session.error;
					if (!session.active) throw new Error("Antigravity MCP registration is no longer active");
					if (session.deliveries.size === 0) return;
					await Promise.all([...session.deliveries].map((receipt) => receipt.promise));
				}
			})(),
			new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error("Antigravity MCP delivery wait aborted"));
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => reject(new Error("Antigravity MCP delivery wait timed out")), timeoutMs);
				timer.unref?.();
			}),
		]);
	} catch (error) {
		failDelivery(session, error);
		throw session.error ?? error;
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** Clamp an unsupported MCP-Protocol-Version header down to the SDK's LATEST.
 *
 *  agy negotiates a protocol version newer than this SDK ships (e.g. 2026-07-28
 *  vs LATEST 2025-11-25). initialize is exempt from the transport's header
 *  check, and the SDK's initialize handler already downgrades the body version
 *  itself, but EVERY follow-up (tools/list, tools/call,
 *  notifications/initialized) is validated against the header -> 400 +
 *  transport-error. This server is stateless (a fresh transport per request),
 *  so it cannot track the negotiated version across requests; rewriting any
 *  unsupported value to LATEST is the correct, spec-friendly downgrade. The
 *  Node->Web conversion (Hono getRequestListener) builds the Web Request from
 *  req.rawHeaders, NOT the parsed req.headers object, so the value must be
 *  rewritten in the raw array (kept in sync with req.headers for any other
 *  reader). */
function clampProtocolVersionHeader(req: http.IncomingMessage): void {
	const sent = req.headers["mcp-protocol-version"];
	if (typeof sent !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return;
	req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
	const raw = req.rawHeaders;
	for (let i = 0; i < raw.length - 1; i += 2) {
		if (raw[i]?.toLowerCase() === "mcp-protocol-version") raw[i + 1] = LATEST_PROTOCOL_VERSION;
	}
}

export class SharedMcpBridge {
	#server: http.Server | null = null;
	#port = 0;
	#startPromise: Promise<{ port: number }> | null = null;
	#sessions = new Map<string, RegisteredSession>();

	get port(): number {
		return this.#port;
	}

	registerSession(handler: SessionMcpHandler): McpRegistration {
		const token = crypto.randomUUID();
		const session: RegisteredSession = { handler, active: true, deliveries: new Set() };
		this.#sessions.set(token, session);
		return {
			token,
			unregister: () => {
				session.active = false;
				this.#sessions.delete(token);
				failDelivery(session, new Error("Antigravity MCP registration retired"));
			},
			waitForDeliveries: (options) => waitForDeliveries(session, options),
		};
	}

	serverConfig(token: string): {
		name: string;
		type: "http";
		url: string;
		headers: Array<{ name: string; value: string }>;
	} {
		if (!this.#port) {
			throw new Error("SharedMcpBridge must be started before generating serverConfig");
		}
		return {
			name: BRIDGE_MCP_NAME,
			type: "http",
			url: `http://127.0.0.1:${this.#port}/mcp`,
			headers: [{ name: TOKEN_HEADER, value: token }],
		};
	}

	async ensureStarted(): Promise<{ port: number }> {
		if (this.#port) return { port: this.#port };
		if (this.#startPromise) return this.#startPromise;

		this.#startPromise = new Promise<{ port: number }>((resolve, reject) => {
			const httpServer = http.createServer((req, res) => {
				void this.#handleRequest(req, res);
			});

			httpServer.once("error", (err) => {
				this.#startPromise = null;
				reject(err);
			});

			httpServer.listen(0, "127.0.0.1", () => {
				const addr = httpServer.address();
				const port = typeof addr === "object" && addr ? addr.port : 0;
				if (!port) {
					this.#startPromise = null;
					httpServer.close();
					reject(new Error("SharedMcpBridge failed to bind loopback port"));
					return;
				}
				this.#server = httpServer;
				this.#port = port;
				resolve({ port });
			});
		});

		return this.#startPromise;
	}

	async close(): Promise<void> {
		// listen() publishes #server asynchronously. Wait for an in-flight start
		// before reading it, otherwise its callback can resurrect a closed bridge.
		const starting = this.#startPromise;
		if (starting) await starting.catch(() => {});
		for (const session of this.#sessions.values()) {
			session.active = false;
			failDelivery(session, new Error("Antigravity MCP bridge closed"));
		}
		this.#sessions.clear();
		const srv = this.#server;
		this.#server = null;
		this.#port = 0;
		this.#startPromise = null;
		if (!srv) return;
		srv.closeAllConnections?.();
		await new Promise<void>((resolve) => srv.close(() => resolve()));
	}

	#resolveSession(req: http.IncomingMessage): RegisteredSession | undefined {
		const received = req.headers[TOKEN_HEADER];
		if (typeof received !== "string" || received.length === 0) return undefined;
		const receivedBuf = Buffer.from(received);
		for (const [token, session] of this.#sessions.entries()) {
			const tokenBuf = Buffer.from(token);
			if (receivedBuf.length === tokenBuf.length && crypto.timingSafeEqual(receivedBuf, tokenBuf)) {
				return session;
			}
		}
		return undefined;
	}

	async #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		let session: RegisteredSession | undefined;
		try {
			if (req.url?.includes("/.well-known/")) {
				res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			session = this.#resolveSession(req);
			if (!session || !session.active || session.error) {
				res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
				return;
			}

			const chunks: Buffer[] = [];
			let bytes = 0;
			let tooLarge = false;
			for await (const chunk of req) {
				const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
				bytes += buf.byteLength;
				if (bytes > MAX_BODY_BYTES) {
					tooLarge = true;
					break;
				}
				chunks.push(buf);
			}
			if (tooLarge) {
				res
					.writeHead(413, { "content-type": "application/json", connection: "close" })
					.end('{"error":"payload too large"}');
				return;
			}

			let parsed: unknown;
			try {
				// Decode once: a UTF-8 character can straddle arbitrary HTTP chunks.
				parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
			} catch {
				res.writeHead(400).end("invalid json");
				return;
			}
			// A token may have been retired while the request body was arriving.
			if (!session.active || session.error) {
				res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
				return;
			}

			clampProtocolVersionHeader(req);

			const currentSession = session;
			const handler = currentSession.handler;
			const ac = new AbortController();
			const requests = Array.isArray(parsed) ? parsed : [parsed];
			let pendingCalls = requests.filter((request) => request && typeof request === "object" &&
				(request as { method?: unknown }).method === "tools/call").length;
			const receipt = pendingCalls > 0 ? trackDelivery(currentSession, res, ac) : undefined;
			let mcpServer: Server | undefined;
			let cleaned = false;
			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				req.off("aborted", onAbort);
				res.off("close", onClose);
				res.off("finish", cleanup);
				res.off("error", onError);
				void mcpServer?.close().catch((error) => failDelivery(currentSession, error));
			};
			const onAbort = () => {
				ac.abort();
				receipt?.finish(new Error("Antigravity MCP request aborted before delivery"));
			};
			const onClose = () => {
				if (!res.writableFinished) onAbort();
				cleanup();
			};
			const onError = (error: Error) => {
				failDelivery(currentSession, error);
				ac.abort();
				cleanup();
			};
			req.once("aborted", onAbort);
			res.once("close", onClose);
			res.once("finish", cleanup);
			res.once("error", onError);

			try {
				mcpServer = new Server(
					{ name: BRIDGE_MCP_NAME, version: "1.1.0" },
					{ capabilities: { tools: {} } },
				);
				// Protocol catches transport.send failures internally. Without this
				// hook a locally resolved Host result can be silently lost on the wire.
				mcpServer.onerror = (error) => failDelivery(currentSession, error);
				mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
					if (!currentSession.active || currentSession.error) throw new Error("Antigravity MCP registration expired");
					const tools = handler.listTools();
					return { tools };
				});
				mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
					const { name, arguments: args } = request.params;
					const callId = crypto.randomUUID();
					try {
						if (!currentSession.active || currentSession.error) throw new Error("Antigravity MCP registration expired");
						const r = await handler.onToolCall(
							callId,
							name,
							(args && typeof args === "object" && !Array.isArray(args)
								? args
								: {}) as Record<string, unknown>,
							ac.signal,
						);
						const content =
							r.content && r.content.length > 0
								? r.content
								: [{ type: "text" as const, text: JSON.stringify(r) }];
						return { content, isError: r.isError ?? false };
					} catch (e) {
						failDelivery(currentSession, e);
						const msg = e instanceof Error ? e.message : String(e);
						return {
							content: [{ type: "text" as const, text: `Error: ${msg}` }],
							isError: true,
						};
					} finally {
						pendingCalls -= 1;
						if (pendingCalls === 0) receipt?.armTimeout();
					}
				});

				// Stateless: a fresh transport+server per request.
				const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
				await mcpServer.connect(transport);
				await transport.handleRequest(req, res, parsed as object);
			} catch (error) {
				failDelivery(currentSession, error);
				if (!res.headersSent) res.writeHead(500).end();
				else res.destroy();
				cleanup();
			}
		} catch (error) {
			if (session) failDelivery(session, error);
			try {
				if (!res.headersSent) res.writeHead(500).end();
			} catch {
				/* socket gone */
			}
		}
	}
}
