// Engine-agnostic turn-driver contract for the Antigravity ACP driver.

export type UsageEstimate = "estimate" | "direct" | "off";

export type DriverState = "idle" | "starting" | "ready" | "running" | "dead";

export interface ToolResultImage {
	data: string;
	mimeType: string;
}

export interface DriverProfile {
	cwd: string;
	model: string;
	effort?: string;
	mode?: string;
}

export interface DriverTurnRequest extends DriverProfile {
	/** Existing native session to reuse (hot) or resume (cold via session/resume).
	 *  Failed resumes settle with `sessionLoadFailed: true` so the caller can ask
	 *  the user to /clear instead of silently replaying history. */
	conversationId?: string | null;
	/** Custom agy agent name for this session (passed via `--agent`). */
	agentName?: string;
	prompt: string;
	/** Persist session binding after session setup and before the first prompt is sent. */
	beforePrompt?: (info: { conversationId: string }) => void | Promise<void>;
	/** Image blocks riding with the prompt, forwarded as ACP `image` content blocks. */
	images?: ToolResultImage[];
	signal?: AbortSignal;
	/** Overall turn cap in minutes (default 10). 0 disables the cap. */
	timeoutMin?: number;
	/** Stdout-inactivity cap in minutes (default 5). 0 disables the cap. */
	inactivityMin?: number;
}

export type AgyUsage = {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
};

export type DriverActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; tokens?: number; delta?: string }
	| {
			type: "tool_start";
			stepId?: number;
			name: string;
			args: Record<string, unknown>;
			mcpServer?: string;
			toolCallId?: string;
	  }
	| {
			type: "tool_done";
			stepId?: number;
			name: string;
			args: Record<string, unknown>;
			mcpServer?: string;
			toolCallId?: string;
			output?: string;
			durationSeconds?: number;
			diff?: { path: string; oldText?: string; newText: string };
	  }
	| {
			type: "tool_error";
			stepId?: number;
			name: string;
			message: string;
			mcpServer?: string;
			toolCallId?: string;
	  }
	| { type: "usage"; usage: AgyUsage };

export interface TurnOutcome {
	conversationId?: string;
	status: "OK" | "ERROR" | "UNKNOWN";
	response: string;
	error?: string;
	usage?: AgyUsage;
	finished: boolean;
	aborted: boolean;
	/** ACP could not resume the requested session before dispatching a prompt.
	 *  Authentication errors do not set this flag. */
	sessionLoadFailed?: true;
	/** True once the driver dispatches session/prompt; false means no native input was sent. */
	promptAttempted?: boolean;
	/** A valid session/prompt terminal response was received, including cancellation. */
	promptTerminal?: boolean;
}

export interface TurnHandle {
	id: string;
	/** Resolves when the turn settles (final prompt result, exit, abort, close). */
	outcome: Promise<TurnOutcome>;
	/** Pull the next activity. Resolves null once the activity stream closes. */
	next(): Promise<DriverActivity | null>;
}

export interface DriverSnapshot {
	state: DriverState;
	pid?: number;
	conversationId?: string;
	stats: {
		spawns: number;
		turns: number;
		reused: number;
		recycles: number;
		lastRecycleReason?: string;
		recycleReasons: Record<string, number>;
	};
	lifecycle: string[];
	engine?: "acp";
	acp?: {
		sessionId?: string;
		prompts: number;
		sessionsCreated: number;
		sessionsLoaded: number;
		kills: number;
		serverVersion?: string;
		reconnects: number;
		agentName?: string;
		agentTitle?: string;
		usageSeen: boolean;
	};
}

export interface TurnDriver {
	readonly state: DriverState;
	readonly alive: boolean;
	readonly activeSessionId: string | null;
	readonly activeHandle: TurnHandle | null;
	run(request: DriverTurnRequest): Promise<TurnHandle>;
	/** Send an in-flight steer prompt on the active native session. */
	steer(prompt: string, images?: ToolResultImage[]): Promise<void>;
	/** Queue tool-result images for delivery on the next PreInvocation hook of the active turn. */
	queueToolResultImages?(toolCallId: string, images: readonly ToolResultImage[]): void;
	/** Pause idle/overall timers while host MCP tools are executing. */
	pauseTimers(): void;
	/** Resume idle/overall timers once host MCP tools finish. */
	resumeTimers(): void;
	/** Send native session/cancel to the active turn (with teardown safety net). */
	cancel(): void;
	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined);
	snapshot(): DriverSnapshot;
	close(reason: "recycle" | "shutdown", cause?: string): Promise<void>;
}
