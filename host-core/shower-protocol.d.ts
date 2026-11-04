// host-core/shower-protocol.d.ts
// Unified Shower public data shapes (Android/Windows/Linux share these) and the
// pure normalizer surface from shower-protocol.js. Re-exported by index.d.ts;
// import from either module instead of redeclaring the shapes.

export type ShowerPlatform = 'android' | 'windows' | 'linux';

export type ShowerPhase =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'authentication-required'
  | 'ready'
  | 'closed'
  | 'error';

export type ShowerErrorCode =
  | 'SHOWER_UNAVAILABLE'
  | 'SHOWER_UNSUPPORTED'
  | 'SHOWER_BUSY'
  | 'SHOWER_AUTH_REQUIRED'
  | 'SHOWER_PERMISSION_REQUIRED'
  | 'SHOWER_SESSION_NOT_FOUND'
  | 'SHOWER_SESSION_MISMATCH'
  | 'SHOWER_NOT_READY'
  | 'SHOWER_INPUT_FAILED'
  | 'SHOWER_FRAME_TOO_LARGE'
  | 'SHOWER_BACKEND_FAILED';

export type ShowerLaunchKind = 'app' | 'process';
export type ShowerInputKind = 'click' | 'drag' | 'scroll' | 'key' | 'text';
export type ShowerPointerButton = 'left' | 'right' | 'middle';
export type ShowerKeyModifier = 'CTRL' | 'ALT' | 'SHIFT' | 'META';
export type ShowerMimeType = 'image/jpeg' | 'image/png';

/** Public target; an absent scopeId means the Bot's primary conversation. */
export interface ShowerTarget {
  botId: string;
  scopeId?: string;
}

/** Trusted Host-side actor; the model never supplies it, nor a targetDeviceId. */
export interface ShowerActor {
  deviceId: string;
  botId: string;
  conversationId: string;
  scopeId: string | null;
  kind: 'primary' | 'room' | 'dm';
}

/** Declared environment abilities; unsupported input/launch kinds are refused, not approximated. */
export interface ShowerCapabilities {
  launchKinds: ShowerLaunchKind[];
  inputKinds: ShowerInputKind[];
  keys: string[];
  nativePreview: boolean;
}

export interface ShowerSessionError {
  code: string;
  message: string;
}

/**
 * Session snapshot. sessionId is null only while no environment exists; width
 * and height are source input pixels. frames, input and preview must carry the
 * same sessionId so a replacement desktop is never acted on.
 */
export interface ShowerSession {
  sessionId: string | null;
  platform: ShowerPlatform;
  phase: ShowerPhase;
  width: number;
  height: number;
  capabilities: ShowerCapabilities;
  updatedAt: string;
  error?: ShowerSessionError;
}

/**
 * One bounded preview/model frame. width/height are source input pixels,
 * imageWidth/imageHeight the encoded pixel size; UI maps image bounds to source
 * pixels. No implicit resize or recreate happens because of a screenshot.
 */
export interface ShowerFrame {
  sessionId: string;
  frameId: string;
  capturedAt: string;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  mimeType: ShowerMimeType;
  /** Base64 image bytes; at most SHOWER_MAX_FRAME_BASE64_BYTES. */
  data: string;
}

export interface ShowerClickInput {
  type: 'click';
  x: number;
  y: number;
  button?: ShowerPointerButton;
  count?: 1 | 2;
}

export interface ShowerDragInput {
  type: 'drag';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs?: number;
}

/**
 * Wheel input in integer notches -20..20, at least one nonzero; positive Y is
 * down and positive X is right. UI converts DOM wheel deltaMode to notches.
 */
export interface ShowerScrollInput {
  type: 'scroll';
  x: number;
  y: number;
  deltaX?: number;
  deltaY: number;
}

export interface ShowerKeyInput {
  type: 'key';
  key: string;
  modifiers?: ShowerKeyModifier[];
}

export interface ShowerTextInput {
  type: 'text';
  text: string;
}

export type ShowerInput =
  | ShowerClickInput
  | ShowerDragInput
  | ShowerScrollInput
  | ShowerKeyInput
  | ShowerTextInput;

export interface ShowerAppLaunch {
  kind: 'app';
  appId: string;
}

/** Direct program launch inside the environment; never shell-interpolated. */
export interface ShowerProcessLaunch {
  kind: 'process';
  program: string;
  args?: string[];
  cwd?: string;
}

export type ShowerLaunch = ShowerAppLaunch | ShowerProcessLaunch;

/** Frame budget; defaults 1280x800 and SHOWER_MAX_FRAME_BASE64_BYTES. */
export interface ShowerFrameLimits {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
}

/** Create dimensions in source pixels (160..4096); omitted values keep the backend default. */
export interface ShowerCreateOptions {
  width?: number;
  height?: number;
}

export const SHOWER_MAX_FRAME_BASE64_BYTES: number;
export const SHOWER_ERROR_CODES: readonly ShowerErrorCode[];

export function normalizeShowerTarget(value: unknown): ShowerTarget;
export function normalizeShowerCreate(value?: unknown): ShowerCreateOptions;
export function normalizeShowerInput(value: unknown): ShowerInput;
export function normalizeShowerLaunch(value: unknown): ShowerLaunch;
export function normalizeShowerFrameLimits(value?: unknown): Required<ShowerFrameLimits>;
export function normalizeShowerSessionId(value: unknown): string;
