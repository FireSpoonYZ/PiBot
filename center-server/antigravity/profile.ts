// Isolated Center profile, workspace, and dedicated ACP agent setup.
//
// Center never shares `~/.gemini/antigravity-cli` or mutates global
// `~/.gemini/config/mcp_config.json`. Each openAntigravity instance points
// `agy acp --agent pibot-center --gemini-dir <geminiHome>` at its own isolated root.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ANTIGRAVITY_BRIDGE_SERVER } from "./constants.ts";
import { ACP_RECALL_HOOK_NAME, ACP_NATIVE_BUSINESS_TOOL_MATCHER, acpRecallHookCommand } from "./vendor/acp/recall-hook.ts";

export const AGENT_NAME = "pibot-center";
export const AGENT_SYSTEM_FILE = "agent.md";
export const BRIDGE_ALLOW_RULE = `mcp(${ANTIGRAVITY_BRIDGE_SERVER}/*)`;
const AGENT_RECALL_HOOKS_FILE = "recall-hooks.json";

export interface ResolvedProfile {
	rootDir: string;
	geminiHome: string;
	workspaceDir: string;
	sessionsPath: string;
	agentPath: string;
	settingsPath: string;
	oauthTokenPath: string;
	authCachePath: string;
	bin: string;
}

export function resolveProfile(opts: {
	dataRoot?: string;
	bin?: string;
	geminiHome?: string;
} = {}): ResolvedProfile {
	const dataRoot = path.resolve(opts.dataRoot ?? path.join(process.cwd(), "data"));
	const rootDir = path.join(dataRoot, "antigravity");
	const geminiHome = path.resolve(
		opts.geminiHome ?? process.env.PIBOT_AGY_HOME ?? path.join(rootDir, "gemini"),
	);
	const workspaceDir = path.join(rootDir, "workspace");
	const sessionsPath = path.join(rootDir, "sessions.json");
	const agentPath = path.join(geminiHome, "config", "agents", AGENT_NAME, AGENT_SYSTEM_FILE);
	const settingsPath = path.join(geminiHome, "antigravity-cli", "settings.json");
	const oauthTokenPath = path.join(geminiHome, "antigravity-cli", "antigravity-oauth-token");
	const authCachePath = path.join(geminiHome, "antigravity-cli", "cache", "acp-auth-state.json");
	const bin = opts.bin ?? process.env.PIBOT_AGY_BIN ?? "agy";
	return {
		rootDir,
		geminiHome,
		workspaceDir,
		sessionsPath,
		agentPath,
		settingsPath,
		oauthTokenPath,
		authCachePath,
		bin,
	};
}

export function dedicatedAgentMarkdown(agentName = AGENT_NAME, systemPrompt = ""): string {
	return [
		"---",
		`name: ${agentName}`,
		'description: "PiBot Center ACP agent (all workspace tools routed through host MCP bridge)"',
		"mainAgent: true",
		"subagent: false",
		"model: inherit",
		"excludeDefaultComponents: true",
		"inheritCustomizations: false",
		"inheritMcp: true",
		"tools: []",
		"skills: []",
		"rules: []",
		"agents: []",
		"hooks:",
		`  - "./${AGENT_RECALL_HOOKS_FILE}"`,
		"---",
		"",
		"You are running inside PiBot Center's isolated Antigravity ACP bridge.",
		"Built-in CLI file, shell, web, and subagent tools are disabled in this profile.",
		"All workspace, terminal, and user-facing tools are provided dynamically by the host via the `pibot-bridge` MCP server.",
		"Use pibot-bridge codemode for host tools and call directly offered model-only tools by name. When a bridge tool returns `STILL RUNNING` with a `callId`, call `bridge_poll_result` until the result lands.",
		"",
		...(systemPrompt ? [systemPrompt, ""] : []),
	].join("\n");
}

function fileMatches(filePath: string, content: string): boolean {
	try {
		return fs.readFileSync(filePath, "utf8") === content;
	} catch {
		return false;
	}
}

function writeFileAtomic(filePath: string, content: string): void {
	const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, content, { mode: 0o600 });
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		// Another process may have installed identical content after our read.
		if (!fileMatches(filePath, content)) throw err;
	}
}

function ensureBridgeAllowRule(settingsPath: string): void {
	let resolvedPath = settingsPath;
	try {
		if (fs.existsSync(settingsPath)) {
			resolvedPath = fs.realpathSync(settingsPath);
		}
	} catch {
		// Keep original path if realpath fails
	}

	fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });

	let settings: Record<string, unknown> = {};
	try {
		const raw = fs.readFileSync(resolvedPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return;
		}
		settings = parsed as Record<string, unknown>;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") {
			// Existing file unreadable or malformed JSON: do not clobber auth/profile data.
			return;
		}
	}

	const rawPermissions = settings.permissions;
	if (
		rawPermissions !== undefined &&
		(rawPermissions === null || typeof rawPermissions !== "object" || Array.isArray(rawPermissions))
	) {
		return;
	}

	const permissions: Record<string, unknown> = rawPermissions ? { ...rawPermissions } : {};
	const rawAllow = permissions.allow;
	if (rawAllow !== undefined && !Array.isArray(rawAllow)) {
		return;
	}

	const allowList = Array.isArray(rawAllow)
		? rawAllow.filter((item): item is string => typeof item === "string")
		: [];
	if (allowList.includes(BRIDGE_ALLOW_RULE)) {
		return;
	}

	permissions.allow = [...allowList, BRIDGE_ALLOW_RULE];
	const updated = { ...settings, permissions };
	writeFileAtomic(resolvedPath, JSON.stringify(updated, null, 2) + "\n");
}

function ensureAgentFiles(agentPath: string, agentName: string, systemPrompt = ""): void {
	const agentDir = path.dirname(agentPath);
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	// These hooks belong to this custom agent, independently of automatic recall.
	const hooksPath = path.join(agentDir, AGENT_RECALL_HOOKS_FILE);
	const hooks = JSON.stringify({
		[ACP_RECALL_HOOK_NAME]: {
			PreInvocation: [{ type: "command", command: acpRecallHookCommand(), timeout: 6 }],
			PreToolUse: [{
				matcher: ACP_NATIVE_BUSINESS_TOOL_MATCHER,
				hooks: [{ type: "command", command: acpRecallHookCommand(true), timeout: 3 }],
			}],
		},
	}, null, 2) + "\n";
	if (!fileMatches(hooksPath, hooks)) writeFileAtomic(hooksPath, hooks);
	const content = dedicatedAgentMarkdown(agentName, systemPrompt);
	if (!fileMatches(agentPath, content)) writeFileAtomic(agentPath, content);
}

export function ensureIsolatedProfile(profile: ResolvedProfile): void {
	fs.mkdirSync(profile.rootDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(profile.workspaceDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(profile.geminiHome, { recursive: true, mode: 0o700 });
	ensureAgentFiles(profile.agentPath, AGENT_NAME);
	ensureBridgeAllowRule(profile.settingsPath);
}

/** Stable custom-agent carrier for one immutable Pi configuration. Concurrent
 * Bots never replace each other's Soul, and session/load selects the same name. */
export function ensureSessionAgent(
	profile: ResolvedProfile,
	{ systemPrompt = "", systemHash }: { systemPrompt?: string; systemHash?: string } = {},
): string {
	if (typeof systemPrompt !== "string") throw new Error("Antigravity system prompt must be text");
	if (systemHash === undefined && !systemPrompt) {
		ensureIsolatedProfile(profile);
		return AGENT_NAME;
	}
	if (typeof systemHash !== "string" || !/^[a-f0-9]{64}$/.test(systemHash)) {
		throw new Error("Antigravity custom agent requires a stable configuration hash");
	}
	const agentName = AGENT_NAME + "-" + systemHash.slice(0, 32);
	const agentPath = path.join(profile.geminiHome, "config", "agents", agentName, AGENT_SYSTEM_FILE);
	ensureAgentFiles(agentPath, agentName, systemPrompt);
	return agentName;
}
