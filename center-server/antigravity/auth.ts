// Center Antigravity ACP auth status probe and interactive CLI login adapter.
//
// - `probeAcpAuth()` checks whether the isolated `--gemini-dir` profile has
//   usable credentials by running a lightweight ACP `initialize` + `session/new`
//   probe (returns `false` on UNAUTHENTICATED / -32000; rethrows other failures).
// - `loginAcpProfile()` drives `agy acp --gemini-dir <geminiHome> --login`
//   over pipes (`shell: false`), emits the official Google OAuth URL via
//   `notify({ type: "auth_url", ... })`, collects a single-line manual code or
//   callback URL via `prompt({ type: "manual_code", ... })`, waits for CLI exit
//   `0`, and re-verifies auth with `probeAcpAuth()`.

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { AGENT_NAME, ensureIsolatedProfile, type ResolvedProfile } from "./profile.ts";
import { AcpAuthError, AcpConnection } from "./vendor/acp/connection.ts";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_CHARS = 32 * 1024;
const PROMPT_FALLBACK_MS = 500;

const GOOGLE_AUTH_URL_RE = /\b(https:\/\/accounts\.google\.com\/[^\s"'<>]+)(?=\s)/;
const OAUTH_URL_FALLBACK_RE = /\b(https:\/\/[^\s"'<>]+\/o\/oauth2\/[^\s"'<>]+)(?=\s)/;
const CODE_PROMPT_RE = /paste the authorization code|full url of the page|press enter\s*:/i;

export interface AntigravityAuthNotifyEvent {
	type: "auth_url";
	url: string;
	instructions: string;
}

export interface AntigravityAuthPromptRequest {
	type: "manual_code";
	message: string;
	placeholder: string;
	signal?: AbortSignal;
}

export interface AntigravityLoginOptions {
	notify?: (event: AntigravityAuthNotifyEvent) => void;
	prompt: (request: AntigravityAuthPromptRequest) => Promise<string>;
	signal?: AbortSignal;
}

function createAbortError(message: string): Error {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

function isUnauthenticatedError(err: unknown): boolean {
	if (err instanceof AcpAuthError) return true;
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "UNAUTHENTICATED"
	);
}

function appendBounded(existing: string, chunk: string): string {
	const combined = existing + chunk;
	return combined.length > MAX_OUTPUT_CHARS
		? combined.slice(-MAX_OUTPUT_CHARS)
		: combined;
}

function extractAuthUrl(text: string): string | undefined {
	const match = GOOGLE_AUTH_URL_RE.exec(text) ?? OAUTH_URL_FALLBACK_RE.exec(text);
	if (!match?.[1]) return undefined;
	const candidate = match[1].replace(/[),.;'"]+$/g, "");
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "https:") return undefined;
		return parsed.href;
	} catch {
		return undefined;
	}
}

function classifyLoginFailure(info: {
	stdoutClean: string;
	stderrClean: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnErrorCode?: string;
	urlNotified: boolean;
}): string {
	if (info.spawnErrorCode === "ENOENT") {
		return "未找到 agy CLI 可执行文件，请先确认已安装并配置 PIBOT_AGY_BIN。";
	}
	const combined = `${info.stderrClean}\n${info.stdoutClean}`.toLowerCase();
	if (
		combined.includes("invalid_grant") ||
		combined.includes("malformed auth code") ||
		combined.includes("invalid verification code") ||
		combined.includes("code expired") ||
		combined.includes("invalid_code")
	) {
		return "授权码或回调地址无效或已过期，请重新打开授权链接并粘贴最新回调内容。";
	}
	if (
		combined.includes("access_denied") ||
		combined.includes("denied access") ||
		combined.includes("cancelled by user")
	) {
		return "Google 授权已被拒绝或取消，请重新登录并允许访问。";
	}
	if (
		combined.includes("invalid_client") ||
		combined.includes("unauthorized_client")
	) {
		return "Antigravity CLI OAuth 客户端配置无效，请检查本机 agy CLI 安装。";
	}
	if (
		combined.includes("enotfound") ||
		combined.includes("eai_again") ||
		combined.includes("econnrefused") ||
		combined.includes("etimedout") ||
		combined.includes("econnreset") ||
		combined.includes("network") ||
		combined.includes("fetch failed") ||
		combined.includes("socket hang up") ||
		combined.includes("unable to connect")
	) {
		return "连接 Google 登录服务失败，请检查网络或代理设置后重试。";
	}
	if (!info.urlNotified) {
		return "Antigravity CLI 未返回有效的 Google 登录链接，请检查本机 agy 状态后重试。";
	}
	return "Antigravity 登录未完成，请重试。";
}

function terminateChild(child: ChildProcess, exitedRef: { exited: boolean }): void {
	if (exitedRef.exited) return;
	try {
		if (child.pid && process.platform !== "win32") {
			process.kill(-child.pid, "SIGTERM");
			const killTimer = setTimeout(() => {
				try {
					if (!exitedRef.exited && child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}, 750);
			killTimer.unref?.();
		} else {
			child.kill("SIGTERM");
		}
	} catch {
		/* already gone */
	}
}

export async function probeAcpAuth(
	profile: ResolvedProfile,
	opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
	if (opts.signal?.aborted) {
		throw createAbortError("Antigravity auth check aborted");
	}
	ensureIsolatedProfile(profile);

	let aborted = false;
	const conn = new AcpConnection({
		cwd: profile.workspaceDir,
		bin: profile.bin,
		binArgs: ["acp", "--agent", AGENT_NAME],
		geminiDir: profile.geminiHome,
		log: () => {},
		onUpdate: () => {},
		onExit: () => {},
		mcpServers: () => [],
		permissions: () => "deny",
	});

	const onAbort = (): void => {
		aborted = true;
		conn.kill();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await conn.start();
		if (aborted || opts.signal?.aborted) {
			throw createAbortError("Antigravity auth check aborted");
		}
		await conn.newSession(profile.workspaceDir);
		return true;
	} catch (err) {
		if (aborted || opts.signal?.aborted) {
			throw err instanceof Error ? err : createAbortError("Antigravity auth check aborted");
		}
		if (isUnauthenticatedError(err)) {
			return false;
		}
		throw err;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		conn.kill();
		await conn.waitForExit();
	}
}

export async function loginAcpProfile(
	profile: ResolvedProfile,
	opts: AntigravityLoginOptions,
): Promise<void> {
	if (opts.signal?.aborted) {
		throw createAbortError("Antigravity 登录已取消");
	}
	if (typeof opts.prompt !== "function") {
		throw new Error("Antigravity 登录缺少输入回调");
	}

	ensureIsolatedProfile(profile);

	const loginAc = new AbortController();
	const promptAc = new AbortController();
	let timedOut = false;

	const timeoutTimer = setTimeout(() => {
		timedOut = true;
		loginAc.abort();
	}, LOGIN_TIMEOUT_MS);

	const onCallerAbort = (): void => {
		loginAc.abort();
	};
	opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

	const onLoginAbort = (): void => {
		promptAc.abort();
	};
	loginAc.signal.addEventListener("abort", onLoginAbort, { once: true });

	let child: ChildProcess;
	try {
		child = spawn(profile.bin, ["acp", "--gemini-dir", profile.geminiHome, "--login"], {
			cwd: profile.workspaceDir,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: process.platform !== "win32",
			windowsHide: true,
		});
	} catch (err) {
		clearTimeout(timeoutTimer);
		opts.signal?.removeEventListener("abort", onCallerAbort);
		loginAc.signal.removeEventListener("abort", onLoginAbort);
		const spawnCode = (err as NodeJS.ErrnoException)?.code;
		throw new Error(
			classifyLoginFailure({
				stdoutClean: "",
				stderrClean: "",
				code: null,
				signal: null,
				spawnErrorCode: spawnCode,
				urlNotified: false,
			}),
		);
	}

	// Never crash on EPIPE / closed stdin when user input races process exit.
	child.stdin?.on("error", () => {});

	const state = { exited: false };
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	let spawnErrorCode: string | undefined;

	let stdoutClean = "";
	let stderrClean = "";
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");

	let urlNotified = false;
	let promptStarted = false;
	let promptFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let promptPromise: Promise<void> | undefined;
	let promptError: Error | undefined;

	const startPrompt = (): void => {
		if (promptStarted || state.exited || loginAc.signal.aborted) return;
		promptStarted = true;
		if (promptFallbackTimer) {
			clearTimeout(promptFallbackTimer);
			promptFallbackTimer = undefined;
		}
		promptPromise = Promise.resolve()
			.then(() =>
				opts.prompt({
					type: "manual_code",
					message: "粘贴授权码或完整回调地址",
					placeholder: "授权码或完整回调地址",
					signal: promptAc.signal,
				}),
			)
			.then((answer) => {
				if (state.exited || loginAc.signal.aborted) return;
				const singleLine = String(answer ?? "").replace(/[\r\n]+/g, " ").trim();
				if (!singleLine) {
					promptError = new Error("请提供有效的授权码或回调地址");
					terminateChild(child, state);
					return;
				}
				const stdin = child.stdin;
				if (stdin && !stdin.destroyed && stdin.writable) {
					try {
						stdin.write(`${singleLine}\n`, "utf8", () => {});
						stdin.end();
					} catch {
						/* exit handler reports result */
					}
				}
			})
			.catch((err: unknown) => {
				if (loginAc.signal.aborted || state.exited) return;
				promptError = err instanceof Error ? err : new Error(String(err));
				terminateChild(child, state);
			});
	};

	const processText = (): void => {
		if (!urlNotified) {
			const url = extractAuthUrl(stdoutClean) ?? extractAuthUrl(stderrClean);
			if (url) {
				urlNotified = true;
				try {
					opts.notify?.({
						type: "auth_url",
						url,
						instructions: "请在浏览器中打开链接完成 Google 登录，然后将授权码或跳转后的完整回调地址粘贴到下方。",
					});
				} catch {
					/* ignore notification listener failure */
				}
				if (!promptStarted) {
					promptFallbackTimer = setTimeout(startPrompt, PROMPT_FALLBACK_MS);
				}
			}
		}
		if (
			urlNotified &&
			!promptStarted &&
			(CODE_PROMPT_RE.test(stdoutClean) || CODE_PROMPT_RE.test(stderrClean))
		) {
			startPrompt();
		}
	};

	child.stdout?.on("data", (chunk: Buffer | string) => {
		const decoded = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
		stdoutClean = appendBounded(stdoutClean, stripVTControlCharacters(decoded));
		processText();
	});
	child.stdout?.on("end", () => {
		const rest = stdoutDecoder.end();
		if (rest) {
			stdoutClean = appendBounded(stdoutClean, stripVTControlCharacters(rest));
			processText();
		}
	});

	child.stderr?.on("data", (chunk: Buffer | string) => {
		const decoded = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
		stderrClean = appendBounded(stderrClean, stripVTControlCharacters(decoded));
		processText();
	});
	child.stderr?.on("end", () => {
		const rest = stderrDecoder.end();
		if (rest) {
			stderrClean = appendBounded(stderrClean, stripVTControlCharacters(rest));
			processText();
		}
	});

	const exitPromise = new Promise<void>((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			state.exited = true;
			if (promptFallbackTimer) {
				clearTimeout(promptFallbackTimer);
				promptFallbackTimer = undefined;
			}
			promptAc.abort();
			resolve();
		};
		child.once("error", (err) => {
			spawnErrorCode = (err as NodeJS.ErrnoException)?.code;
			finish();
		});
		child.once("exit", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			finish();
		});
	});

	const onAbortTerminate = (): void => {
		terminateChild(child, state);
	};
	loginAc.signal.addEventListener("abort", onAbortTerminate, { once: true });

	try {
		await exitPromise;
		if (promptPromise) {
			await promptPromise.catch(() => {});
		}
	} finally {
		clearTimeout(timeoutTimer);
		if (promptFallbackTimer) clearTimeout(promptFallbackTimer);
		opts.signal?.removeEventListener("abort", onCallerAbort);
		loginAc.signal.removeEventListener("abort", onLoginAbort);
		loginAc.signal.removeEventListener("abort", onAbortTerminate);
		terminateChild(child, state);
		await exitPromise;
	}

	if (timedOut) {
		throw new Error("Antigravity 登录超时（超过 15 分钟），请重试。");
	}
	if (opts.signal?.aborted || loginAc.signal.aborted) {
		throw createAbortError("Antigravity 登录已取消");
	}
	if (promptError) {
		throw promptError;
	}
	if (spawnErrorCode || exitSignal || exitCode !== 0) {
		throw new Error(
			classifyLoginFailure({
				stdoutClean,
				stderrClean,
				code: exitCode,
				signal: exitSignal,
				spawnErrorCode,
				urlNotified,
			}),
		);
	}

	let verified = false;
	try {
		verified = await probeAcpAuth(profile, { signal: opts.signal });
	} catch (err) {
		if (opts.signal?.aborted) {
			throw createAbortError("Antigravity 登录已取消");
		}
		throw new Error("Antigravity 登录验证失败，请稍后重试。");
	}
	if (!verified) {
		throw new Error("Antigravity CLI 已完成，但当前未检测到有效登录状态，请重试。");
	}
}
