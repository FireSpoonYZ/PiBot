import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export const DEFAULT_STICK_THRESHOLD_PX = 80;

const INSTANT_PROGRAMMATIC_GUARD_MS = 140;
const SMOOTH_PROGRAMMATIC_GUARD_MS = 600;
const SCROLL_UP_TOLERANCE_PX = 4;

export interface UseStickToBottomOptions {
  thresholdPx?: number;
  enabled?: boolean;
  initialStuck?: boolean;
  onStickChange?: (stuck: boolean) => void;
}

export interface ScrollToBottomOptions {
  behavior?: ScrollBehavior;
  forceStick?: boolean;
}

export interface UseStickToBottomResult {
  isStuckRef: RefObject<boolean>;
  isStuck: boolean;
  scrollToBottom: (options?: ScrollToBottomOptions | ScrollBehavior) => void;
  setStuck: (stuck: boolean) => void;
  handleScroll: () => void;
}

interface ProgrammaticScrollGuard {
  token: number;
  active: boolean;
  behavior: ScrollBehavior;
  targetScrollTop: number;
  lastScrollTop: number;
  expiresAt: number;
  raf1: number | null;
  raf2: number | null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function isScrollNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx = DEFAULT_STICK_THRESHOLD_PX,
): boolean {
  if (clientHeight <= 0) return true;
  const distance = Math.max(0, scrollHeight - scrollTop - clientHeight);
  return distance <= thresholdPx;
}

/**
 * Container- and content-size-driven stick-to-bottom hook for chat lists (F6).
 *
 * Observes BOTH `scrollRef` and `contentRef` via ResizeObserver so any layout
 * height change (keyboard, composer growth, images, tool cards, status slot)
 * synchronously re-pins `scrollTop = scrollHeight` before paint whenever stuck.
 * Only genuine user scroll gestures update the stuck state.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef?: RefObject<HTMLElement | null>,
  options: UseStickToBottomOptions = {},
): UseStickToBottomResult {
  const {
    thresholdPx = DEFAULT_STICK_THRESHOLD_PX,
    enabled = true,
    initialStuck = true,
    onStickChange,
  } = options;

  const isStuckRef = useRef<boolean>(initialStuck);
  const [isStuck, setIsStuckState] = useState<boolean>(initialStuck);

  const enabledRef = useRef<boolean>(enabled);
  enabledRef.current = enabled;

  const thresholdRef = useRef<number>(thresholdPx);
  thresholdRef.current = thresholdPx;

  const onStickChangeRef = useRef<((stuck: boolean) => void) | undefined>(onStickChange);
  onStickChangeRef.current = onStickChange;

  const guardRef = useRef<ProgrammaticScrollGuard>({
    token: 0,
    active: false,
    behavior: 'auto',
    targetScrollTop: 0,
    lastScrollTop: 0,
    expiresAt: 0,
    raf1: null,
    raf2: null,
  });

  const cancelGuardFrames = useCallback(() => {
    const guard = guardRef.current;
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      if (guard.raf1 !== null) window.cancelAnimationFrame(guard.raf1);
      if (guard.raf2 !== null) window.cancelAnimationFrame(guard.raf2);
    }
    guard.raf1 = null;
    guard.raf2 = null;
  }, []);

  const setStuck = useCallback((next: boolean) => {
    if (isStuckRef.current === next) return;
    isStuckRef.current = next;
    setIsStuckState(next);
    onStickChangeRef.current?.(next);
  }, []);

  const pinToBottom = useCallback((scrollEl: HTMLElement, behavior: ScrollBehavior) => {
    const guard = guardRef.current;
    cancelGuardFrames();

    const targetTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const token = guard.token + 1;
    guard.token = token;
    guard.active = true;
    guard.behavior = behavior;
    guard.targetScrollTop = targetTop;
    guard.lastScrollTop = scrollEl.scrollTop;
    guard.expiresAt =
      nowMs() + (behavior === 'smooth' ? SMOOTH_PROGRAMMATIC_GUARD_MS : INSTANT_PROGRAMMATIC_GUARD_MS);

    if (behavior === 'smooth' && typeof scrollEl.scrollTo === 'function') {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
    } else {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      guard.lastScrollTop = scrollEl.scrollTop;
      // Programmatic scrollTop writes dispatch async `scroll` events in the next task/frame;
      // clear the token after two frames so we never drop the guard prematurely.
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        guard.raf1 = window.requestAnimationFrame(() => {
          if (guardRef.current.token !== token) return;
          guardRef.current.raf1 = null;
          guardRef.current.raf2 = window.requestAnimationFrame(() => {
            if (guardRef.current.token !== token) return;
            guardRef.current.raf2 = null;
            guardRef.current.active = false;
          });
        });
      }
    }
  }, [cancelGuardFrames]);

  const scrollToBottom = useCallback(
    (arg?: ScrollToBottomOptions | ScrollBehavior) => {
      const opts: ScrollToBottomOptions =
        typeof arg === 'string' ? { behavior: arg } : (arg ?? {});
      const behavior: ScrollBehavior = opts.behavior ?? 'auto';
      const forceStick = opts.forceStick ?? true;

      if (forceStick) {
        setStuck(true);
      }

      const scrollEl = scrollRef.current;
      if (!scrollEl || scrollEl.clientHeight <= 0) return;
      pinToBottom(scrollEl, behavior);
    },
    [pinToBottom, scrollRef, setStuck],
  );

  const handleScroll = useCallback(() => {
    if (!enabledRef.current) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl || scrollEl.clientHeight <= 0) return;

    const nearBottom = isScrollNearBottom(
      scrollEl.scrollHeight,
      scrollEl.scrollTop,
      scrollEl.clientHeight,
      thresholdRef.current,
    );

    const guard = guardRef.current;
    if (guard.active) {
      const now = nowMs();
      if (now > guard.expiresAt) {
        guard.active = false;
      } else if (guard.behavior === 'smooth') {
        if (nearBottom) {
          guard.active = false;
          setStuck(true);
          return;
        }
        // Ignore intermediate downward smooth-scroll frames; allow user upward scroll to break out.
        if (scrollEl.scrollTop >= guard.lastScrollTop - SCROLL_UP_TOLERANCE_PX) {
          guard.lastScrollTop = scrollEl.scrollTop;
          return;
        }
        guard.active = false;
      } else {
        // Instant/auto programmatic scroll: ignore async scroll unless the user clearly scrolled UP.
        if (nearBottom || scrollEl.scrollTop >= guard.targetScrollTop - SCROLL_UP_TOLERANCE_PX) {
          guard.lastScrollTop = scrollEl.scrollTop;
          return;
        }
        guard.active = false;
      }
    }

    setStuck(nearBottom);
  }, [scrollRef, setStuck]);

  const scrollRefRef = useRef<RefObject<HTMLElement | null>>(scrollRef);
  scrollRefRef.current = scrollRef;

  const observerStateRef = useRef<{
    observer: ResizeObserver | null;
    scrollEl: HTMLElement | null;
    contentEl: HTMLElement | null;
  }>({
    observer: null,
    scrollEl: null,
    contentEl: null,
  });

  const teardownObserver = useCallback(() => {
    const state = observerStateRef.current;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.scrollEl = null;
    state.contentEl = null;
  }, []);

  // Reconcile ResizeObserver after every commit so late-mounting or swapped refs
  // (e.g. scrollRef/contentRef attaching on a render after `enabled` is already true)
  // always register before paint without churning the observer when nodes are unchanged.
  useIsomorphicLayoutEffect(() => {
    const scrollEl = enabled ? scrollRef.current : null;
    const contentEl = enabled ? (contentRef?.current ?? null) : null;
    const state = observerStateRef.current;

    if (!scrollEl || typeof ResizeObserver === 'undefined') {
      if (state.observer) {
        teardownObserver();
      }
      return;
    }

    if (
      state.observer &&
      state.scrollEl === scrollEl &&
      state.contentEl === contentEl
    ) {
      return;
    }

    teardownObserver();

    const observer = new ResizeObserver(() => {
      if (!enabledRef.current || !isStuckRef.current) return;
      const el = scrollRefRef.current.current;
      if (!el || el.clientHeight <= 0) return;
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - maxTop) <= 1) return;
      pinToBottom(el, 'auto');
    });

    observer.observe(scrollEl);
    if (contentEl && contentEl !== scrollEl) {
      observer.observe(contentEl);
    }

    state.observer = observer;
    state.scrollEl = scrollEl;
    state.contentEl = contentEl;
  });

  useIsomorphicLayoutEffect(() => teardownObserver, [teardownObserver]);

  useEffect(() => cancelGuardFrames, [cancelGuardFrames]);

  return {
    isStuckRef,
    isStuck,
    scrollToBottom,
    setStuck,
    handleScroll,
  };
}
