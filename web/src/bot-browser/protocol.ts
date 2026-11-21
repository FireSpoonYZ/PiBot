export type BrowserPhase = 'bot' | 'taking' | 'human' | 'held';

export type BrowserControlAction =
  | 'status'
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'select'
  | 'closeTab'
  | 'frame'
  | 'takeover'
  | 'input'
  | 'handback'
  | 'release';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface BrowserView {
  available: boolean;
  reason?: string;
  canStreamInteract: boolean;
  phase: BrowserPhase;
  sessionId?: string;
  pageId?: string;
  revision: number;
  tabs: BrowserTab[];
  holderLabel?: string;
  lease?: string;
  sensitive?: boolean;
  sensitiveReason?: string;
  fallbackToSystemBrowser?: boolean;
  attentionRequested?: boolean;
  attentionMessage?: string;
  stepText?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isHolder?: boolean;
  externalUrl?: string;
}

export interface BrowserFrame {
  seq: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
  width: number;
  height: number;
  revision: number;
  pageId: string;
}

export type BrowserInputEvent =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number };

export interface OwnedLease {
  lease: string;
  sessionId: string | null;
  pageId: string | null;
  revision: number;
}

export type PendingControlAction =
  | null
  | 'taking'
  | 'handing-back'
  | 'releasing'
  | 'navigating'
  | 'tab';

export interface FrameCursor {
  pageId: string;
  revision: number;
  seq: number;
}

export interface BoundingRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const POLL_INTERVAL_ACTIVE_MS = 380;
export const POLL_INTERVAL_WATCH_MS = 650;
export const POLL_INTERVAL_IDLE_MS = 1800;
export const STREAM_DEGRADE_TIMEOUT_MS = 5000;
export const MAX_FRAME_BASE64_LENGTH = 4 * 1024 * 1024;
export const MAX_TEXT_INPUT_LENGTH = 1000;
export const ZOOM_STEPS: readonly number[] = [1, 1.5, 2, 2.5];

const ALLOWED_PHASES = new Set<BrowserPhase>(['bot', 'taking', 'human', 'held']);
const ALLOWED_FRAME_MIMES = new Set<BrowserFrame['mimeType']>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const LEASE_INVALIDATING_CODES = new Set([
  'LEASE_EXPIRED',
  'LEASE_MISMATCH',
  'LEASE_LOST',
  'LEASE_REQUIRED',
  'INVALID_LEASE',
  'PREEMPTED',
  'NOT_HOLDER',
  'NOT_HUMAN',
  'BROWSER_LEASE_EXPIRED',
  'BROWSER_LEASE_MISMATCH',
  'BROWSER_LEASE_CONFLICT',
  'BROWSER_LEASE_REQUIRED',
  'BROWSER_TAKEOVER_REQUIRED',
  'BROWSER_NOT_HOLDER',
  'BROWSER_HELD',
  'HELD',
  'HUMAN_HOLD_DISCONNECTED',
]);

const STALE_STATE_CODES = new Set([
  'REVISION_MISMATCH',
  'STALE_REVISION',
  'STALE_FRAME',
  'PAGE_MISMATCH',
  'PAGE_NOT_FOUND',
  'TAB_NOT_FOUND',
  'SESSION_MISMATCH',
  'SESSION_EXPIRED',
  'BROWSER_REVISION_MISMATCH',
  'BROWSER_STALE_REVISION',
  'BROWSER_STALE_PAGE',
  'BROWSER_STALE_FRAME',
  'BROWSER_PAGE_MISMATCH',
  'BROWSER_PAGE_NOT_FOUND',
]);

const SENSITIVE_CODES = new Set([
  'SENSITIVE_PAGE',
  'PRIVACY_SHIELD',
  'SENSITIVE_BLOCKED',
  'HANDBACK_BLOCKED_SENSITIVE',
  'OAUTH_BLOCKED',
  'BROWSER_SENSITIVE_PAGE',
  'BROWSER_SENSITIVE_BLOCKED',
  'BROWSER_HANDBACK_BLOCKED_SENSITIVE',
  'BROWSER_SECRET_STEP_BLOCKED',
]);

const UNAVAILABLE_CODES = new Set([
  'UNAVAILABLE',
  'BROWSER_UNAVAILABLE',
  'BROWSER_STREAM_UNAVAILABLE',
  'BROWSER_CLOSED',
  'STREAM_UNAVAILABLE',
  'NOT_AVAILABLE',
  'NO_BROWSER_PROVIDER',
  'HEADLESS_UNAVAILABLE',
]);

const SPECIAL_KEY_MAP: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
  Spacebar: 'Space',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unwrapEnvelope(raw: unknown, preferredKeys: readonly string[]): Record<string, unknown> | null {
  let obj = asRecord(raw);
  if (!obj) return null;
  for (let depth = 0; depth < 3; depth += 1) {
    let unwrapped = false;
    for (const key of preferredKeys) {
      const nested = asRecord(obj[key]);
      if (nested) {
        obj = nested;
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }
  return obj;
}

export function parseBrowserTab(raw: unknown): BrowserTab | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const id = asNonEmptyString(obj.id ?? obj.pageId);
  if (!id) return null;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const url = typeof obj.url === 'string' ? obj.url : '';
  return { id, title, url };
}

export function parseBrowserView(raw: unknown): BrowserView | null {
  const obj = unwrapEnvelope(raw, ['result', 'view', 'status']);
  if (!obj) return null;

  const hasAvailable = typeof obj.available === 'boolean';
  const hasPhase = typeof obj.phase === 'string' && ALLOWED_PHASES.has(obj.phase as BrowserPhase);
  if (!hasAvailable && !hasPhase) return null;

  const available = typeof obj.available === 'boolean' ? obj.available : true;
  const canStreamInteract =
    available &&
    (typeof obj.canStreamInteract === 'boolean' ? obj.canStreamInteract : false);
  const phase: BrowserPhase = hasPhase ? (obj.phase as BrowserPhase) : 'bot';
  const revision = asFiniteNumber(obj.revision) ?? 0;

  const rawTabs = Array.isArray(obj.tabs) ? obj.tabs : [];
  const tabs: BrowserTab[] = [];
  for (const item of rawTabs) {
    const parsed = parseBrowserTab(item);
    if (parsed) tabs.push(parsed);
  }

  const pageId = asNonEmptyString(obj.pageId);
  const sessionId = asNonEmptyString(obj.sessionId);
  const reason = asNonEmptyString(obj.reason);
  const holderLabel = asNonEmptyString(obj.holderLabel);
  const lease = asNonEmptyString(obj.lease);
  const sensitive = obj.sensitive === true || obj.privacyShield === true;
  const sensitiveReason = asNonEmptyString(obj.sensitiveReason);
  const attentionRequested =
    obj.attentionRequested === true ||
    obj.takeoverRequested === true ||
    obj.needsHuman === true;
  const attentionMessage = asNonEmptyString(obj.attentionMessage ?? obj.prompt ?? obj.blockerMessage);
  const stepText = asNonEmptyString(obj.stepText ?? obj.step);
  const externalUrl = asNonEmptyString(obj.externalUrl);

  return {
    available,
    ...(reason ? { reason } : {}),
    canStreamInteract,
    phase,
    ...(sessionId ? { sessionId } : {}),
    ...(pageId ? { pageId } : {}),
    revision,
    tabs,
    ...(holderLabel ? { holderLabel } : {}),
    ...(lease ? { lease } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...(sensitiveReason ? { sensitiveReason } : {}),
    ...(obj.fallbackToSystemBrowser === true || obj.requiresSystemBrowser === true
      ? { fallbackToSystemBrowser: true }
      : {}),
    ...(attentionRequested ? { attentionRequested: true } : {}),
    ...(attentionMessage ? { attentionMessage } : {}),
    ...(stepText ? { stepText } : {}),
    ...(typeof obj.canGoBack === 'boolean' ? { canGoBack: obj.canGoBack } : {}),
    ...(typeof obj.canGoForward === 'boolean' ? { canGoForward: obj.canGoForward } : {}),
    ...(typeof obj.isHolder === 'boolean'
      ? { isHolder: obj.isHolder }
      : typeof obj.isLeaseHolder === 'boolean'
        ? { isHolder: obj.isLeaseHolder }
        : {}),
    ...(externalUrl ? { externalUrl } : {}),
  };
}

export function inspectFrameRedaction(raw: unknown): {
  redacted: boolean;
  sensitive: boolean;
  reason?: string;
} {
  const obj = unwrapEnvelope(raw, ['result', 'frame']);
  if (!obj) return { redacted: false, sensitive: false };
  const sensitive = obj.sensitive === true || obj.privacyShield === true;
  const redacted = obj.redacted === true || obj.blocked === true || (sensitive && !asNonEmptyString(obj.data));
  const reason = asNonEmptyString(obj.sensitiveReason ?? obj.reason);
  return { redacted, sensitive, ...(reason ? { reason } : {}) };
}

export function parseBrowserFrame(raw: unknown): BrowserFrame | null {
  const obj = unwrapEnvelope(raw, ['result', 'frame']);
  if (!obj) return null;
  if (obj.redacted === true || obj.blocked === true) return null;

  const mimeType = obj.mimeType;
  if (typeof mimeType !== 'string' || !ALLOWED_FRAME_MIMES.has(mimeType as BrowserFrame['mimeType'])) {
    return null;
  }

  const data = typeof obj.data === 'string' ? obj.data.trim() : '';
  if (!data || data.length > MAX_FRAME_BASE64_LENGTH) {
    return null;
  }

  const width = asFiniteNumber(obj.width);
  const height = asFiniteNumber(obj.height);
  const seq = asFiniteNumber(obj.seq);
  const revision = asFiniteNumber(obj.revision);
  const pageId = asNonEmptyString(obj.pageId);

  if (
    width === undefined ||
    width <= 0 ||
    height === undefined ||
    height <= 0 ||
    seq === undefined ||
    seq < 0 ||
    revision === undefined ||
    revision < 0 ||
    !pageId
  ) {
    return null;
  }

  return {
    seq,
    mimeType: mimeType as BrowserFrame['mimeType'],
    data,
    width,
    height,
    revision,
    pageId,
  };
}

export function isFrameUsableForView(
  frame: BrowserFrame | null,
  view: BrowserView | null,
  lastAccepted: FrameCursor | null = null,
): boolean {
  if (!frame || !view) return false;
  if (!view.available || !view.canStreamInteract) return false;
  if (!view.pageId || frame.pageId !== view.pageId) return false;
  if (frame.revision !== view.revision) return false;
  if (
    lastAccepted &&
    lastAccepted.pageId === frame.pageId &&
    lastAccepted.revision === frame.revision &&
    frame.seq < lastAccepted.seq
  ) {
    return false;
  }
  return true;
}

export function confirmTakeoverLease(
  view: BrowserView | null,
  fallbackLease?: string | null,
): OwnedLease | null {
  if (!view || !view.available || !view.canStreamInteract) return null;
  if (view.phase !== 'human') return null;
  if (view.isHolder === false) return null;
  const lease = view.lease ?? asNonEmptyString(fallbackLease);
  if (!lease) return null;
  return {
    lease,
    sessionId: view.sessionId ?? null,
    pageId: view.pageId ?? null,
    revision: view.revision,
  };
}

export function reconcileLeaseWithView(
  owned: OwnedLease | null,
  view: BrowserView,
): { nextLease: OwnedLease | null; isHolder: boolean; preemptedBy: string | null } {
  if (!view.available || !view.canStreamInteract) {
    return { nextLease: null, isHolder: false, preemptedBy: null };
  }

  if (view.phase !== 'human') {
    return { nextLease: null, isHolder: false, preemptedBy: null };
  }

  if (!owned) {
    return { nextLease: null, isHolder: false, preemptedBy: null };
  }

  if (view.isHolder === false) {
    return {
      nextLease: null,
      isHolder: false,
      preemptedBy: view.holderLabel ?? 'another device',
    };
  }

  if (view.sessionId && owned.sessionId && view.sessionId !== owned.sessionId) {
    return {
      nextLease: null,
      isHolder: false,
      preemptedBy: view.holderLabel ?? null,
    };
  }

  if (view.lease && view.lease !== owned.lease) {
    return {
      nextLease: null,
      isHolder: false,
      preemptedBy: view.holderLabel ?? 'another device',
    };
  }

  return {
    nextLease: {
      lease: view.lease ?? owned.lease,
      sessionId: view.sessionId ?? owned.sessionId,
      pageId: view.pageId ?? owned.pageId,
      revision: view.revision,
    },
    isHolder: true,
    preemptedBy: null,
  };
}

export function canAcceptManualInput(params: {
  connected: boolean;
  visible: boolean;
  view: BrowserView | null;
  ownedLease: OwnedLease | null;
  isHolder: boolean;
  pendingAction: PendingControlAction;
  liveFrame: BrowserFrame | null;
  streamDegraded: boolean;
}): boolean {
  const { connected, visible, view, ownedLease, isHolder, pendingAction, liveFrame, streamDegraded } =
    params;
  if (!connected || !visible || streamDegraded) return false;
  if (pendingAction !== null) return false;
  if (!view || !view.available || !view.canStreamInteract) return false;
  if (view.phase !== 'human' || !isHolder || !ownedLease) return false;
  if (!view.pageId) return false;
  if (!liveFrame || liveFrame.pageId !== view.pageId || liveFrame.revision !== view.revision) {
    return false;
  }
  return true;
}

export function classifyBrowserError(error: unknown): {
  code: string;
  message: string;
  invalidatesLease: boolean;
  staleState: boolean;
  sensitiveBlocked: boolean;
  unavailable: boolean;
} {
  let code = '';
  let message = '';

  if (typeof error === 'string') {
    message = error.trim();
  } else if (error instanceof Error) {
    message = error.message.trim();
    const withCode = error as Error & { code?: unknown };
    if (typeof withCode.code === 'string') code = withCode.code.trim().toUpperCase();
  } else {
    const obj = asRecord(error);
    if (obj) {
      if (typeof obj.code === 'string') code = obj.code.trim().toUpperCase();
      if (typeof obj.message === 'string') message = obj.message.trim();
      else if (typeof obj.error === 'string') message = obj.error.trim();
    } else if (error != null) {
      message = String(error).trim();
    }
  }

  if (!code && message) {
    const match = /^([A-Z][A-Z0-9_]{2,40})(?:\s*[:：]\s*(.*))?$/s.exec(message);
    if (match) {
      code = match[1].toUpperCase();
      if (match[2]) message = match[2].trim();
    }
  } else if (code && message.toUpperCase().startsWith(`${code}:`)) {
    message = message.slice(code.length + 1).trim();
  }

  const upperCode = code.toUpperCase();
  const invalidatesLease = LEASE_INVALIDATING_CODES.has(upperCode);
  const staleState = STALE_STATE_CODES.has(upperCode);
  const sensitiveBlocked = SENSITIVE_CODES.has(upperCode);
  const unavailable = UNAVAILABLE_CODES.has(upperCode);

  return {
    code: upperCode,
    message,
    invalidatesLease,
    staleState,
    sensitiveBlocked,
    unavailable,
  };
}

export function classifyPageUrl(rawUrl: string | undefined): {
  isGoogleAuth: boolean;
  isCloudSecretArea: boolean;
  isKnownSensitiveUrl: boolean;
  isHttpUrl: boolean;
  isSecure: boolean;
  displayHost: string;
} {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) {
    return {
      isGoogleAuth: false,
      isCloudSecretArea: false,
      isKnownSensitiveUrl: false,
      isHttpUrl: false,
      isSecure: false,
      displayHost: '',
    };
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const isHttpUrl = protocol === 'https:' || protocol === 'http:';
    const isSecure = protocol === 'https:';
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    const isGoogleAuth =
      host === 'accounts.google.com' ||
      host.endsWith('.accounts.google.com') ||
      (host === 'myaccount.google.com' && pathname.startsWith('/security')) ||
      (host.endsWith('.google.com') &&
        (pathname.includes('/o/oauth2') || pathname.includes('/signin/oauth')));

    const isCloudSecretArea =
      host === 'console.cloud.google.com' &&
      (pathname.includes('/apis/credentials') || pathname.includes('/auth/clients'));

    return {
      isGoogleAuth,
      isCloudSecretArea,
      isKnownSensitiveUrl: isGoogleAuth,
      isHttpUrl,
      isSecure,
      displayHost: parsed.host,
    };
  } catch {
    return {
      isGoogleAuth: false,
      isCloudSecretArea: false,
      isKnownSensitiveUrl: false,
      isHttpUrl: false,
      isSecure: false,
      displayHost: trimmed,
    };
  }
}

export function normalizeNavigateUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: 'empty' | 'disallowed_scheme' | 'invalid' } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const explicitScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (explicitScheme) {
    const scheme = explicitScheme[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'http') {
      return { ok: false, reason: 'disallowed_scheme' };
    }
    try {
      const parsed = new URL(trimmed);
      return { ok: true, url: parsed.toString() };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  if (/\s/.test(trimmed)) return { ok: false, reason: 'invalid' };

  try {
    const parsed = new URL(`https://${trimmed}`);
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      if (parsed.hostname !== 'localhost') return { ok: false, reason: 'invalid' };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 10000) / 10000;
}

/**
 * Projects a pointer client position into relative 0..1 coordinates inside the
 * painted `object-fit: contain` image box. Returns null if the pointer lands
 * inside letterbox padding outside the actual webpage content.
 */
export function mapClientPointToNormalized(
  clientX: number,
  clientY: number,
  rect: BoundingRectLike,
  contentWidth: number,
  contentHeight: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return null;
  }

  const containerRatio = rect.width / rect.height;
  const contentRatio = contentWidth / contentHeight;

  let renderedWidth = rect.width;
  let renderedHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (contentRatio > containerRatio) {
    renderedWidth = rect.width;
    renderedHeight = rect.width / contentRatio;
    offsetY = (rect.height - renderedHeight) / 2;
  } else if (contentRatio < containerRatio) {
    renderedHeight = rect.height;
    renderedWidth = rect.height * contentRatio;
    offsetX = (rect.width - renderedWidth) / 2;
  }

  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;

  if (localX < 0 || localX > renderedWidth || localY < 0 || localY > renderedHeight) {
    return null;
  }

  return {
    x: clamp01(localX / renderedWidth),
    y: clamp01(localY / renderedHeight),
  };
}

export function normalizeWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): { deltaX: number; deltaY: number } {
  const scale = deltaMode === 1 ? 32 : deltaMode === 2 ? 360 : 1;
  const clamp = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    return Math.round(Math.min(600, Math.max(-600, v * scale)));
  };
  return {
    deltaX: clamp(deltaX),
    deltaY: clamp(deltaY),
  };
}

export function mapKeyboardEventKey(key: string): string | null {
  return SPECIAL_KEY_MAP[key] ?? null;
}

export function buildBrowserRequest(
  action: BrowserControlAction,
  params: {
    botId: string;
    pageId?: string | null;
    lease?: string | null;
    revision?: number | null;
    url?: string;
    event?: BrowserInputEvent;
    force?: boolean;
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action,
    botId: params.botId,
  };
  if (params.pageId) payload.pageId = params.pageId;
  if (params.lease) payload.lease = params.lease;
  if (typeof params.revision === 'number' && Number.isFinite(params.revision)) {
    payload.revision = params.revision;
  }
  if (typeof params.url === 'string' && params.url.length > 0) {
    payload.url = params.url;
  }
  if (params.event) payload.event = params.event;
  if (params.force === true) payload.force = true;
  return payload;
}

export function activeTabOf(view: BrowserView | null): BrowserTab | null {
  if (!view || view.tabs.length === 0) return null;
  if (view.pageId) {
    const found = view.tabs.find((tab) => tab.id === view.pageId);
    if (found) return found;
  }
  return view.tabs[0] ?? null;
}
