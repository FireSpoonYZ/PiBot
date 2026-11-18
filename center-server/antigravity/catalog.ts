// ACP catalog probe: queries `agy acp` `configOptions` dynamically to discover
// available models and per-model supported thinking levels.
//
// Never falls back to a static catalog. Preserves exact `agy` base model ids
// without slugification and masks unsupported thinking levels (including `xhigh`
// and `max` when unsupported) in `thinkingLevelMap`.

import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID } from "./constants.ts";
import { AGENT_NAME, ensureIsolatedProfile, type ResolvedProfile } from "./profile.ts";
import { AcpConnection } from "./vendor/acp/connection.ts";

export const THINKING_LEVEL_ORDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevelName = (typeof THINKING_LEVEL_ORDER)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevelName, string | null>>;

export interface AntigravityCatalogModel {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ["text", "image"];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	enabled: boolean;
	source: "catalog";
}

interface RawOptionItem {
	value: string;
	name?: string;
}

interface RawConfigOption {
	id: string;
	category?: string;
	currentValue?: string;
	options?: unknown;
}

const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 65_536;
const NON_OFF_ASCENDING: ThinkingLevelName[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function flattenOptions(raw: unknown): RawOptionItem[] {
	if (!Array.isArray(raw)) return [];
	const out: RawOptionItem[] = [];
	const seen = new Set<string>();
	const pushEntry = (item: unknown): void => {
		if (!item || typeof item !== "object") return;
		const rec = item as Record<string, unknown>;
		if (Array.isArray(rec.options)) {
			for (const nested of rec.options) pushEntry(nested);
			return;
		}
		const value = typeof rec.value === "string" ? rec.value.trim() : "";
		if (!value || seen.has(value)) return;
		seen.add(value);
		const name = typeof rec.name === "string" && rec.name.trim().length > 0 ? rec.name.trim() : undefined;
		out.push({ value, ...(name ? { name } : {}) });
	};
	for (const entry of raw) pushEntry(entry);
	return out;
}

function asConfigOptions(raw: unknown): RawConfigOption[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is RawConfigOption =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { id?: unknown }).id === "string",
	);
}

function findConfigOption(
	configOptions: readonly RawConfigOption[],
	kind: "model" | "thought_level",
): RawConfigOption | undefined {
	if (kind === "model") {
		return (
			configOptions.find((o) => o.category === "model" || o.id === "model") ??
			configOptions.find((o) => /model/i.test(o.id))
		);
	}
	return configOptions.find(
		(o) =>
			o.id === "thought_level" ||
			o.category === "thought_level" ||
			o.category === "reasoning" ||
			o.id === "reasoning_effort",
	);
}

export function buildThinkingProfile(thoughtOption: RawConfigOption | undefined): {
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
} {
	if (!thoughtOption) return { reasoning: false };
	const items = flattenOptions(thoughtOption.options);
	if (items.length === 0) return { reasoning: false };

	const byLower = new Map<string, string>();
	for (const item of items) {
		byLower.set(item.value.toLowerCase(), item.value);
	}

	const map: ThinkingLevelMap = {};
	let hasNonOffTier = false;
	for (const level of THINKING_LEVEL_ORDER) {
		const matched =
			byLower.get(level) ?? (level === "off" ? byLower.get("none") : undefined) ?? null;
		map[level] = matched;
		if (matched !== null && level !== "off") {
			hasNonOffTier = true;
		}
	}

	if (!hasNonOffTier) {
		return { reasoning: false };
	}
	return { reasoning: true, thinkingLevelMap: map };
}

export function resolveThoughtLevel(
	requested: string | undefined,
	thinkingLevelMap: ThinkingLevelMap | undefined,
): string | undefined {
	if (!requested) return undefined;
	const normalized = requested.toLowerCase() as ThinkingLevelName;
	if (!thinkingLevelMap) {
		return normalized === "off" ? undefined : requested;
	}
	const direct = thinkingLevelMap[normalized];
	if (typeof direct === "string" && direct.length > 0) {
		return direct;
	}
	if (normalized === "off") {
		return undefined;
	}
	const idx = NON_OFF_ASCENDING.indexOf(normalized);
	if (idx >= 0) {
		for (let i = idx - 1; i >= 0; i--) {
			const lower = thinkingLevelMap[NON_OFF_ASCENDING[i]!];
			if (typeof lower === "string" && lower.length > 0) return lower;
		}
	}
	for (const level of NON_OFF_ASCENDING) {
		const fallback = thinkingLevelMap[level];
		if (typeof fallback === "string" && fallback.length > 0) return fallback;
	}
	return undefined;
}

export async function probeAcpCatalog(
	profile: ResolvedProfile,
	opts: { signal?: AbortSignal; log?: (msg: string, data?: unknown) => void } = {},
): Promise<AntigravityCatalogModel[]> {
	if (opts.signal?.aborted) {
		throw new Error("Antigravity catalog probe aborted");
	}
	ensureIsolatedProfile(profile);

	const log = opts.log ?? (() => {});
	let aborted = false;
	const conn = new AcpConnection({
		cwd: profile.workspaceDir,
		bin: profile.bin,
		binArgs: ["acp", "--agent", AGENT_NAME],
		geminiDir: profile.geminiHome,
		log,
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
			throw new Error("Antigravity catalog probe aborted");
		}
		const session = await conn.newSession(profile.workspaceDir);
		const initialConfig = asConfigOptions(conn.lastConfigOptions);
		const modelOpt = findConfigOption(initialConfig, "model");
		const modelItems = flattenOptions(modelOpt?.options);
		if (!modelOpt || modelItems.length === 0) {
			throw new Error("ACP catalog probe returned no models in configOptions");
		}

		const models: AntigravityCatalogModel[] = [];
		for (const item of modelItems) {
			if (aborted || opts.signal?.aborted) {
				throw new Error("Antigravity catalog probe aborted");
			}
			let perModelConfig: RawConfigOption[];
			if (modelOpt.currentValue === item.value && initialConfig.length > 0) {
				perModelConfig = initialConfig;
			} else {
				await conn.setConfigOption(session.sessionId, modelOpt.id, item.value);
				perModelConfig = asConfigOptions(conn.lastConfigOptions);
			}
			const thoughtOpt = findConfigOption(perModelConfig, "thought_level");
			const thinking = buildThinkingProfile(thoughtOpt);
			models.push({
				id: item.value,
				name: item.name ?? item.value,
				api: ANTIGRAVITY_API,
				provider: ANTIGRAVITY_PROVIDER_ID,
				reasoning: thinking.reasoning,
				...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
				enabled: true,
				source: "catalog",
			});
		}

		return models;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		conn.kill();
		await conn.waitForExit();
	}
}
