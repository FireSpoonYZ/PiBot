/** Trusted Host metadata only; these types never carry prompts or credentials. */
export type HostExecutionSource = 'schedule' | 'webhook' | 'task_dispatch' | 'google-workspace-rule' | 'google-workspace-assistant';
export type ExecutionSource = 'user' | 'peer' | 'host' | HostExecutionSource;
export type ExecutionChannel = 'primary' | 'dm' | 'room' | 'host';
export type ExecutionState = 'accepted' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type NativeId = number | `${number}`;

export interface ExecutionSender {
  kind: 'user' | 'bot' | 'host';
  deviceId?: string;
  botId?: string;
  sourceType?: HostExecutionSource;
}

export type ExecutionReplyTarget =
  | { kind: 'primary' }
  | { kind: 'dm'; scopeId: string; botId?: string }
  | { kind: 'room'; scopeId: string };

export interface ExecutionTaskDispatch {
  /** Business GlobalTask ID, never an SDK task ID. */
  taskId: string;
  stepId: string | null;
  executionRevision: number;
}

export interface TaskDispatchContextInput {
  taskId: string;
  stepId?: string | null;
  /** Legacy dispatches use revision 1, matching the existing Host contract. */
  executionRevision?: number | null;
}

export interface TrustedExecutionTurn {
  requestId: string;
  /** Legacy SDK generation ID, intentionally not used as a business task ID. */
  taskId?: NativeId | null;
  kind?: ExecutionChannel;
  scopeId?: string | null;
  sender?: ExecutionSender | null;
  replyTarget?: ExecutionReplyTarget | null;
  triggerMessageId?: string | null;
  triggerMessageIds?: string[];
  originRequestId?: string | null;
  replyTo?: string | null;
  rootId?: string | null;
  responseMessageId?: string | null;
}

export interface ExecutionEvent {
  version: 1;
  /** Default request:<requestId> identity is scoped to RunContext's Bot. */
  eventId: string;
  requestId: string;
  source: ExecutionSource;
  channel: ExecutionChannel;
  scopeId: string | null;
  sender: ExecutionSender;
  replyTarget: ExecutionReplyTarget | null;
  submissionId: number | null;
  triggerMessageIds: string[];
  originRequestId: string | null;
  replyTo: string | null;
  rootId: string | null;
  responseMessageId: string | null;
  dispatchContext: ExecutionTaskDispatch | null;
}

export interface ExecutionIdentity {
  deviceId: string;
  botId: string;
  conversationId?: string | null;
  nativeConversationId?: NativeId | null;
}

export interface RunContext {
  version: 1;
  /** Supplied by the owner of a durable Run; null when not known. */
  runId: string | null;
  /** Device + native conversation + actual SDK task; may change on handoff. */
  sdkExecutionId: string | null;
  deviceId: string;
  botId: string;
  conversationId: string | null;
  nativeConversationId: number | null;
  nativeTaskId: number | null;
  /** Read-only projection, independent of delivery and GlobalTask completion. */
  status: ExecutionState | null;
  sourceEventIds: string[];
  requestIds: string[];
  submissionIds: number[];
  events: ExecutionEvent[];
}

export function normalizeTaskDispatchContext(value?: TaskDispatchContextInput | null): ExecutionTaskDispatch | null;

export function createExecutionEvent(input: {
  turn: TrustedExecutionTurn;
  source?: ExecutionSource;
  submissionId?: NativeId | null;
  dispatchContext?: TaskDispatchContextInput | null;
  eventId?: string;
}): ExecutionEvent;

export function createRunContext(input: {
  identity: ExecutionIdentity;
  nativeRun?: { taskId?: NativeId | null; inputs?: NativeId[] } | null;
  events?: ExecutionEvent[];
  activeTaskId?: NativeId | null;
  runId?: string | null;
  status?: ExecutionState | null;
}): RunContext;

export function projectExecutionState(input?: {
  submission?: { status?: string; requestId?: string | null; reason?: string | null } | null;
  admission?: { phase?: string; requestId?: string | null } | null;
  /** Explicit owner verification is required; ordinary pending work is not a wait. */
  wait?: { status?: string; live?: boolean; requestId?: string | null } | null;
  failure?: unknown;
  accepted?: boolean;
}): ExecutionState | null;

export function projectRunMetadata(context?: RunContext | null): RunContext | null;
