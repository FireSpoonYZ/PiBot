// Isolated Center profile, workspace, and dedicated ACP agent setup.
//
// Center never shares `~/.gemini/antigravity-cli` or mutates global
// `~/.gemini/config/mcp_config.json`. Each openAntigravity instance points
// `agy acp --agent pibot-center --gemini-dir <geminiHome>` at its own isolated root.

import fs from "node:fs";
import path from "node:path";
import { ANTIGRAVITY_BRIDGE_SERVER } from "./constants.ts";

export const AGENT_NAME = "pibot-center";
export const AGENT_SYSTEM_FILE = "agent.md";
export const BRIDGE_ALLOW_RULE = `mcp(${ANTIGRAVITY_BRIDGE_SERVER}/*)`;

export interface ResolvedProfile {
	rootDir: string;
	geminiHome: string;
	workspaceDir: string;
	sessionsPath: string;
	agentPath: string;
	settingsPath: string;
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
	const bin = opts.bin ?? process.env.PIBOT_AGY_BIN ?? "agy";
	return {
		rootDir,
		geminiHome,
		workspaceDir,
		sessionsPath,
		agentPath,
		settingsPath,
		bin,
	};
}

export function dedicatedAgentMarkdown(): string {
	return [
		"---",
		`name: ${AGENT_NAME}`,
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
		"---",
		"",
		"You are running inside PiBot Center's isolated Antigravity ACP bridge.",
		"Built-in CLI file, shell, web, and subagent tools are disabled in this profile.",
		"All workspace, terminal, and user-facing tools are provided dynamically by the host via the `pibot-bridge` MCP server.",
		"Always use those MCP bridge tools directly. When a bridge tool returns `STILL RUNNING` with a `callId`, call `bridge_poll_result` until the result lands.",
		"",
	].join("\n");
}

function writeFileAtomic(filePath: string, content: string): void {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, content, { mode: 0o600 });
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
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

export function ensureIsolatedProfile(profile: ResolvedProfile): void {
	fs.mkdirSync(profile.rootDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(profile.workspaceDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(profile.geminiHome, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.dirname(profile.agentPath), { recursive: true, mode: 0o700 });

	const content = dedicatedAgentMarkdown();
	let existing: string | null = null;
	try {
		existing = fs.readFileSync(profile.agentPath, "utf8");
	} catch {
		existing = null;
	}
	if (existing !== content) {
		writeFileAtomic(profile.agentPath, content);
	}

	ensureBridgeAllowRule(profile.settingsPath);
}
