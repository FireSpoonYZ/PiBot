import { useLayoutEffect, useRef, useState } from 'react';
import { buildBrowserRequest } from './protocol';

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

const NATIVE_GRANT_HEARTBEAT_MS = 1500;

function readGrant(value: unknown, rendererId: string | undefined) {
  if (!value || typeof value !== 'object') return null;
  const grant = value as Record<string, unknown>;
  if (grant.supported !== true || typeof grant.grantId !== 'string' || !grant.grantId ||
      typeof grant.expiresAt !== 'number' || !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= Date.now() || grant.rendererId !== rendererId) {
    return null;
  }
  return { grantId: grant.grantId, expiresAt: grant.expiresAt };
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
    let requestedGrant = false;
    let showing = false;
    let layoutGeneration = 0;
    let lastPlacement: NativeBrowserPlacement | null = null;
    let grant: ReturnType<typeof readGrant> = null;
    let renewGrant = true;
    let syncing = false;
    let needsSync = false;
    let animationFrame: number | undefined;
    let heartbeat: number | undefined;
    let expiry: number | undefined;

    function queueRequest(action: () => Promise<unknown>): Promise<unknown> {
      const operation = requestTail.current.then(action);
      requestTail.current = operation.then(() => {}, () => {});
      return operation;
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
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(heartbeat);
      window.clearTimeout(expiry);
      hideLocal();
      dismiss();
    }

    function fallback() {
      failed = true;
      stop();
      setReadyTarget(current => current === target ? null : current);
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
          grant = readGrant(result, rendererId);
          if (!grant) {
            fallback();
            return;
          }
          renewGrant = false;
          window.clearTimeout(heartbeat);
          window.clearTimeout(expiry);
          heartbeat = window.setTimeout(() => {
            renewGrant = true;
            refresh();
          }, NATIVE_GRANT_HEARTBEAT_MS);
          expiry = window.setTimeout(() => {
            if (!active || failed) return;
            if (currentRect()) {
              fallback();
            } else {
              grant = null;
              hideLocal();
            }
          }, Math.max(0, grant.expiresAt - Date.now()));
        }

        const rect = currentRect();
        if (!rect || !grant) {
          hideLocal();
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
          fallback();
          return;
        }
        lastPlacement = placement;
        setReadyTarget(target);
      } catch {
        if (active && !failed && layoutGeneration === generation && currentRect()) fallback();
      } finally {
        syncing = false;
        if (needsSync) {
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
      stop();
    };
  }, [presenter, target, stage, requestRef, attempt]);

  useLayoutEffect(() => {
    refreshRef.current?.();
  }, [suspended]);

  return target !== null && readyTarget === target;
}
