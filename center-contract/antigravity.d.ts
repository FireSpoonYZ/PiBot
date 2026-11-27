export const ANTIGRAVITY_PROVIDER_ID: 'antigravity-acp';
export const ANTIGRAVITY_API: 'pibot-antigravity-acp';
export const ANTIGRAVITY_RUN_PATH: '/api/host/antigravity/run';
export const ANTIGRAVITY_TOOL_RESULT_PATH: '/api/host/antigravity/tool-result';
export const ANTIGRAVITY_STEER_PATH: '/api/host/antigravity/steer';
export const ANTIGRAVITY_CANCEL_PATH: '/api/host/antigravity/cancel';
export const ANTIGRAVITY_MAX_FRAME_BYTES: 33554432;
export const ANTIGRAVITY_ESCALATE_AFTER_MS: 150000;
export const AGY_HISTORY_CHANGED: 'AGY_HISTORY_CHANGED';
export const ANTIGRAVITY_POLL_TOOL: {
  name: 'bridge_poll_result';
  description: string;
  parameters: {
    type: 'object';
    properties: { callId: { type: 'string'; description: string } };
    required: string[];
    additionalProperties: false;
  };
};

export interface AntigravityImageBlock {
  data: string;
  mimeType: string;
}

export interface AntigravityContentPart {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface AntigravitySectionUpdate {
  key: string;
  value: string | null;
}

export interface AntigravityInputItem {
  text: string;
  images?: AntigravityImageBlock[];
  source?: string;
}

export interface AntigravityToolDecl {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface AntigravityRunRequest {
  sessionId: string;
  runId: string;
  modelId: string;
  reasoning?: string;
  initialSystemPrompt?: string;
  tools: AntigravityToolDecl[];
  sections?: AntigravitySectionUpdate[];
  routeNote?: string;
  inputs: AntigravityInputItem[];
}

export interface AntigravityToolResultRequest {
  sessionId: string;
  runId: string;
  callId: string;
  content: AntigravityContentPart[];
  isError?: boolean;
}

export interface AntigravitySteerRequest {
  sessionId: string;
  runId: string;
  sections?: AntigravitySectionUpdate[];
  routeNote?: string;
  inputs: AntigravityInputItem[];
}

export interface AntigravityCancelRequest {
  sessionId: string;
  runId?: string;
}

export interface AntigravityUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export type AntigravityRunEvent =
  | { type: 'thought_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'usage'; usage: Partial<AntigravityUsage> }
  | { type: 'native_tool_start'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'native_tool_end'; toolCallId: string; name: string; output?: string; isError?: boolean }
  | { type: 'tool_request'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'turn_done'; conversationId: string; usage?: AntigravityUsage }
  | { type: 'error'; code?: string; message: string; aborted?: boolean };
