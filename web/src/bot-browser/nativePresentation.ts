import { useLayoutEffect, useRef, useState } from 'react';
import { buildBrowserRequest, classifyBrowserError } from './protocol';

export interface NativeBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserPlacement {
  pageId: string;
  grantId: string;
  expiresAt: number;
  /** Bounds relative to the app viewport, measured in CSS pixels. */
  rect: NativeBrowserRect;
  dpr: number;
}

export interface NativeBrowserPresenter {
  /** Attach or update the existing page. Resolve true once the page is visible and interactive. */
  present(placement: NativeBrowserPlacement): Promise<boolean>;
  /** Hide this page and invalidate any pending attachment for it. */
  hide(pageId: string): Promise<void>;
}

export interface NativePresentationTarget {
  botId: string;
  deviceId: string;
  sessionId?: string;
  pageId: string;
  lease: string;
  rendererId?: string;
}

interface NativePresentationOptions {
  presenter?: NativeBrowserPresenter;
  target: NativePresentationTarget | null;
  stage: HTMLDivElement | null;
  requestRef: { current: (input: Record<string, unknown>) => Promise<unknown> };
  suspended: boolean;
  attempt: number;
}

interface NativeGrant {
  grantId: string;
  expiresAt: number;
}

type ParsedNativeGrant =
  | { status: 'valid'; grant: NativeGrant }
  | { status: 'expired' }
  | { status: 'invalid' };

const NATIVE_GRANT_HEARTBEAT_MS = 1500;
const NATIVE_RETRY_DELAYS_MS = [500, 1500] as const;

const NON_RETRYABLE_NATIVE_ERROR_CODES = new Set([
  'FORBIDDEN',
  'BROWSER_FORBIDDEN',
  'PERMISSION_DENIED',
  'ACCESS_DENIED',
  'UNAUTHORIZED',
  'NOT_ALLOWED',
  'UNSUPPORTED',
  'NOT_SUPPORTED',
  'BROWSER_UNSUPPORTED',
  'NATIVE_UNSUPPORTED',
  'NATIVE_PRESENTATION_UNSUPPORTED',
  'CONTROL_UNAVAILABLE',
  'INVALID_ACTION',
  'UNKNOWN_ACTION',
  'METHOD_NOT_FOUND',
]);

function isRetryableNativeError(error: unknown): boolean {
  const detail = classifyBrowserError(error);
  if (detail.invalidatesLease || detail.sensitiveBlocked) return false;
  if (detail.code && NON_RETRYABLE_NATIVE_ERROR_CODES.has(detail.code)) return false;
  return true;
}

function readGrant(value: unknown, rendererId: string | undefined): ParsedNativeGrant {
  if (!value || typeof value !== 'object') return { status: 'invalid' };
  const grant = value as Record<string, unknown>;
  if (grant.supported !== true || typeof grant.grantId !== 'string' || !grant.grantId ||
      typeof grant.expiresAt !== 'number' || !Number.isSafeInteger(grant.expiresAt) ||
      grant.rendererId !== rendererId) {
    return { status: 'invalid' };
  }
  if (grant.expiresAt <= Date.now()) return { status: 'expired' };
  return { status: 'valid', grant: { grantId: grant.grantId, expiresAt: grant.expiresAt } };
}

function measureStage(stage: HTMLDivElement): NativeBrowserRect | null {
  const { documentElement } = stage.ownerDocument;
  const rect = stage.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const x = Math.ceil(Math.max(left, rect.left));
  const y = Math.ceil(Math.max(top, rect.top));
  const right = Math.floor(Math.min(documentElement.clientWidth, left + (viewport?.width ?? window.innerWidth), rect.right));
  const bottom = Math.floor(Math.min(documentElement.clientHeight, top + (viewport?.height ?? window.innerHeight), rect.bottom));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function samePlacement(previous: NativeBrowserPlacement | null, next: NativeBrowserPlacement): boolean {
  return previous !== null && previous.grantId === next.grantId && previous.expiresAt === next.expiresAt &&
    previous.dpr === next.dpr && previous.rect.x === next.rect.x && previous.rect.y === next.rect.y &&
    previous.rect.width === next.rect.width && previous.rect.height === next.rect.height;
}

export function useNativeBrowserPresentation({
  presenter,
  target,
  stage,
  requestRef,
  suspended,
  attempt,
}: NativePresentationOptions): boolean {
  const [readyTarget, setReadyTarget] = useState<NativePresentationTarget | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const refreshRef = useRef<(() => void) | null>(null);
  const requestTail = useRef<Promise<void>>(Promise.resolve());

  useLayoutEffect(() => {
    if (!presenter || !target || !stage) return;
    setReadyTarget(null);

    // Capture the original transport so cleanup cannot dismiss on a different Bot/device.
    const request = requestRef.current;
    const currentPresenter = presenter;
    const stageElement = stage;
    const { botId, pageId, lease, rendererId } = target;
    const skippedGrant = Symbol();
    let active = true;
    let failed = false;
    let retryCount = 0;
    let retryPending = false;
    let requestedGrant = false;
    let showing = false;
    let layoutGeneration = 0;
    let lastPlacement: NativeBrowserPlacement | null = null;
    let grant: NativeGrant | null = null;
    let renewGrant = true;
    let syncing = false;
    let needsSync = false;
    let animationFrame: number | undefined;
    let heartbeat: number | undefined;
    let expiry: number | undefined;
    let retryTimer: number | undefined;

    function queueRequest(action: () => Promise<unknown>): Promise<unknown> {
      const operation = requestTail.current.then(action);
      requestTail.current = operation.then(() => {}, () => {});
      return operation;
    }

    function clearRetry() {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryPending = false;
    }

    function hideLocal() {
      if (!showing) return;
      showing = false;
      layoutGeneration += 1;
      lastPlacement = null;
      void currentPresenter.hide(pageId).catch(() => {});
    }

    function dismiss() {
      if (!requestedGrant) return;
      requestedGrant = false;
      // Dismiss after any earlier grant RPC, before the next activation requests a grant.
      void queueRequest(() => request(buildBrowserRequest('nativeDismiss', { botId, pageId, lease }))).catch(() => {});
    }

    function stop() {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      window.clearTimeout(heartbeat);
      heartbeat = undefined;
      window.clearTimeout(expiry);
      expiry = undefined;
      hideLocal();
      dismiss();
    }

    function resumeRetry() {
      if (!active) return;
      needsSync = false;
      grant = null;
      renewGrant = true;
      lastPlacement = null;
      failed = false;
      refresh();
    }

    function fallback(retryable: boolean) {
      if (!active || failed) return;
      failed = true;
      needsSync = false;
      grant = null;
      renewGrant = true;
      lastPlacement = null;
      clearRetry();
      stop();
      setReadyTarget(current => current === target ? null : current);
      if (!retryable) return;
      const delay = NATIVE_RETRY_DELAYS_MS[retryCount];
      if (delay === undefined) return;
      retryCount += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (!active) return;
        if (syncing) {
          retryPending = true;
          return;
        }
        resumeRetry();
      }, delay);
    }

    function currentRect() {
      if (suspendedRef.current || !stageElement.isConnected || stageElement.ownerDocument.visibilityState === 'hidden') return null;
      return measureStage(stageElement);
    }

    function refresh() {
      if (!active || failed) return;
      if (!currentRect()) {
        hideLocal();
        return;
      }
      if (animationFrame !== undefined) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined;
        void sync();
      });
    }

    async function sync() {
      if (!active || failed) return;
      if (!currentRect()) {
        hideLocal();
        return;
      }
      if (syncing) {
        needsSync = true;
        return;
      }

      syncing = true;
      const generation = layoutGeneration;
      try {
        if (!grant || renewGrant) {
          const result = await queueRequest(async () => {
            if (!active || failed || !currentRect()) return skippedGrant;
            requestedGrant = true;
            return request(buildBrowserRequest('nativeGrant', { botId, pageId, lease }));
          });
          if (!active || failed || result === skippedGrant) return;
          const parsedGrant = readGrant(result, rendererId);
          if (parsedGrant.status !== 'valid') {
            grant = null;
            fallback(parsedGrant.status === 'expired');
            return;
          }
          grant = parsedGrant.grant;
          renewGrant = false;
          window.clearTimeout(heartbeat);
          window.clearTimeout(expiry);
          heartbeat = window.setTimeout(() => {
            heartbeat = undefined;
            if (!active || failed) return;
            renewGrant = true;
            refresh();
          }, NATIVE_GRANT_HEARTBEAT_MS);
          expiry = window.setTimeout(() => {
            expiry = undefined;
            if (!active || failed) return;
            if (currentRect()) {
              fallback(true);
            } else {
              grant = null;
              renewGrant = true;
              window.clearTimeout(heartbeat);
              heartbeat = undefined;
              hideLocal();
              setReadyTarget(current => current === target ? null : current);
            }
          }, Math.max(0, grant.expiresAt - Date.now()));
        }

        const rect = currentRect();
        if (!rect || !grant) {
          hideLocal();
          return;
        }
        if (grant.expiresAt <= Date.now()) {
          fallback(true);
          return;
        }
        const placement: NativeBrowserPlacement = { pageId, ...grant, rect, dpr: window.devicePixelRatio || 1 };
        if (samePlacement(lastPlacement, placement)) return;

        showing = true;
        const shown = await currentPresenter.present(placement);
        if (!active || failed || layoutGeneration !== generation) return;
        if (!currentRect()) {
          hideLocal();
          return;
        }
        if (!shown || placement.expiresAt <= Date.now()) {
          fallback(true);
          return;
        }
        retryCount = 0;
        lastPlacement = placement;
        setReadyTarget(target);
      } catch (error) {
        if (active && !failed && layoutGeneration === generation && currentRect()) {
          fallback(isRetryableNativeError(error));
        }
      } finally {
        syncing = false;
        if (retryPending && active) {
          retryPending = false;
          resumeRetry();
        } else if (needsSync) {
          needsSync = false;
          refresh();
        }
      }
    }

    refreshRef.current = refresh;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : undefined;
    observer?.observe(stage);
    const doc = stage.ownerDocument;
    const viewport = window.visualViewport;
    doc.addEventListener('visibilitychange', refresh);
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    viewport?.addEventListener('resize', refresh);
    viewport?.addEventListener('scroll', refresh);
    refresh();

    return () => {
      active = false;
      refreshRef.current = null;
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      viewport?.removeEventListener('resize', refresh);
      viewport?.removeEventListener('scroll', refresh);
      clearRetry();
      stop();
    };
  }, [presenter, target, stage, requestRef, attempt]);

  useLayoutEffect(() => {
    refreshRef.current?.();
  }, [suspended]);

  return target !== null && readyTarget === target;
}
