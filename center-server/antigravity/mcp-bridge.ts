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
	onToolCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<McpCallToolResult>;
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
	#sessions = new Map<string, SessionMcpHandler>();

	get port(): number {
		return this.#port;
	}

	registerSession(handler: SessionMcpHandler): { token: string; unregister: () => void } {
		const token = crypto.randomUUID();
		this.#sessions.set(token, handler);
		return {
			token,
			unregister: () => {
				this.#sessions.delete(token);
			},
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
		this.#sessions.clear();
		const srv = this.#server;
		this.#server = null;
		this.#port = 0;
		this.#startPromise = null;
		if (!srv) return;
		srv.closeAllConnections?.();
		await new Promise<void>((resolve) => srv.close(() => resolve()));
	}

	#resolveSession(req: http.IncomingMessage): SessionMcpHandler | undefined {
		const received = req.headers[TOKEN_HEADER];
		if (typeof received !== "string" || received.length === 0) return undefined;
		const receivedBuf = Buffer.from(received);
		for (const [token, handler] of this.#sessions.entries()) {
			const tokenBuf = Buffer.from(token);
			if (receivedBuf.length === tokenBuf.length && crypto.timingSafeEqual(receivedBuf, tokenBuf)) {
				return handler;
			}
		}
		return undefined;
	}

	async #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			if (req.url?.includes("/.well-known/")) {
				res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			const handler = this.#resolveSession(req);
			if (!handler) {
				res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
				return;
			}

			let body = "";
			let bytes = 0;
			let tooLarge = false;
			for await (const chunk of req) {
				const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
				bytes += buf.byteLength;
				if (bytes > MAX_BODY_BYTES) {
					tooLarge = true;
					break;
				}
				body += buf.toString("utf8");
			}
			if (tooLarge) {
				res
					.writeHead(413, { "content-type": "application/json", connection: "close" })
					.end('{"error":"payload too large"}');
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				res.writeHead(400).end("invalid json");
				return;
			}

			clampProtocolVersionHeader(req);

			const ac = new AbortController();
			req.on("aborted", () => ac.abort());
			res.on("close", () => {
				if (!res.writableEnded) ac.abort();
			});

			try {
				const mcpServer = new Server(
					{ name: BRIDGE_MCP_NAME, version: "1.1.0" },
					{ capabilities: { tools: {} } },
				);
				mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
					const tools = handler.listTools();
					return { tools };
				});
				mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
					const { name, arguments: args } = request.params;
					const callId = crypto.randomUUID();
					try {
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
						const msg = e instanceof Error ? e.message : String(e);
						return {
							content: [{ type: "text" as const, text: `Error: ${msg}` }],
							isError: true,
						};
					}
				});

				// Stateless: a fresh transport+server per request.
				const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
				await mcpServer.connect(transport);
				await transport.handleRequest(req, res, parsed as object);
			} catch {
				if (!res.headersSent) res.writeHead(500).end();
			}
		} catch {
			try {
				if (!res.headersSent) res.writeHead(500).end();
			} catch {
				/* socket gone */
			}
		}
	}
}
