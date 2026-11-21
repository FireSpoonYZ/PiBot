import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export const DEFAULT_FLIP_DURATION_MS = 200;
export const DEFAULT_FLIP_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
export const DEFAULT_FLIP_ITEM_SELECTOR = '[data-flip-key]';
export const DEFAULT_FLIP_KEY_ATTRIBUTE = 'data-flip-key';

export interface UseFlipListOptions {
  durationMs?: number;
  easing?: string;
  itemSelector?: string;
  keyAttribute?: string;
  enabled?: boolean;
}

export interface UseFlipListResult {
  registerItem: (key: string) => (node: HTMLElement | null) => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * FLIP vertical reorder animation hook for dynamic lists (H5).
 *
 * Captures each item's position relative to its container across renders in
 * `useLayoutEffect`. When the key order changes, existing items smoothly
 * translate from their previous Y offset to their new position over 200ms
 * (`cubic-bezier(0.2, 0, 0, 1)`). Newly inserted items do not animate from 0,0.
 *
 * Supports both container querying (`[data-flip-key]` / custom `itemSelector`)
 * and per-item ref callbacks via the returned `registerItem(key)`.
 */
export function useFlipList(
  keys: readonly string[],
  containerRef?: RefObject<HTMLElement | null>,
  options: UseFlipListOptions = {},
): UseFlipListResult {
  const {
    durationMs = DEFAULT_FLIP_DURATION_MS,
    easing = DEFAULT_FLIP_EASING,
    itemSelector = DEFAULT_FLIP_ITEM_SELECTOR,
    keyAttribute = DEFAULT_FLIP_KEY_ATTRIBUTE,
    enabled = true,
  } = options;

  const registeredNodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const refCallbacksRef = useRef<Map<string, (node: HTMLElement | null) => void>>(new Map());
  const prevTopsRef = useRef<Map<string, number>>(new Map());
  const prevKeysSigRef = useRef<string | null>(null);
  const activeCleanupsRef = useRef<Set<() => void>>(new Set());

  const flushActiveAnimations = useCallback(() => {
    const cleanups = activeCleanupsRef.current;
    if (cleanups.size === 0) return;
    for (const cleanup of Array.from(cleanups)) {
      cleanup();
    }
    cleanups.clear();
  }, []);

  const registerItem = useCallback((key: string) => {
    let cb = refCallbacksRef.current.get(key);
    if (!cb) {
      cb = (node: HTMLElement | null) => {
        if (node) {
          registeredNodesRef.current.set(key, node);
        } else {
          registeredNodesRef.current.delete(key);
        }
      };
      refCallbacksRef.current.set(key, cb);
    }
    return cb;
  }, []);

  const keysSig = keys.join('\u0000');

  useIsomorphicLayoutEffect(() => {
    const elements = new Map<string, HTMLElement>();

    // Prefer explicitly registered ref nodes, then query container items.
    for (const [key, el] of registeredNodesRef.current.entries()) {
      if (el.isConnected) {
        elements.set(key, el);
      }
    }

    const containerEl = containerRef?.current ?? null;
    if (containerEl) {
      const queried = containerEl.querySelectorAll<HTMLElement>(itemSelector);
      for (const el of queried) {
        const key = el.getAttribute(keyAttribute);
        if (key && !elements.has(key)) {
          elements.set(key, el);
        }
      }
    }

    if (elements.size === 0) {
      prevTopsRef.current = new Map();
      prevKeysSigRef.current = keysSig;
      return;
    }

    // Clear any in-flight FLIP transforms before measuring final untransformed positions.
    flushActiveAnimations();

    // Measure positions relative to the container (immune to outer scroll offset).
    let anchorTop = 0;
    let anchorScrollTop = 0;
    const anchorEl = containerEl ?? elements.values().next().value?.parentElement ?? null;
    if (anchorEl) {
      const anchorRect = anchorEl.getBoundingClientRect();
      // Skip hidden keep-alive containers (display: none) without wiping cached rects.
      if (anchorRect.width === 0 && anchorRect.height === 0) {
        return;
      }
      anchorTop = anchorRect.top;
      anchorScrollTop = anchorEl.scrollTop;
    }

    const nextTops = new Map<string, number>();
    for (const [key, el] of elements.entries()) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      nextTops.set(key, rect.top - anchorTop + anchorScrollTop);
    }

    const orderChanged = prevKeysSigRef.current !== null && prevKeysSigRef.current !== keysSig;
    const prevTops = prevTopsRef.current;

    if (enabled && orderChanged && !prefersReducedMotion()) {
      const moved: Array<{ el: HTMLElement; dy: number }> = [];
      for (const [key, nextTop] of nextTops.entries()) {
        const prevTop = prevTops.get(key);
        if (prevTop === undefined) continue; // Do not animate newly inserted items from 0,0.
        const dy = prevTop - nextTop;
        if (Math.abs(dy) >= 0.5) {
          const el = elements.get(key);
          if (el) moved.push({ el, dy });
        }
      }

      if (moved.length > 0 && typeof window !== 'undefined') {
        // Invert phase: place moved items at their previous visual offset without transition.
        for (const { el, dy } of moved) {
          el.style.transition = 'none';
          el.style.transform = `translate3d(0, ${dy}px, 0)`;
        }
        // Single forced reflow to commit inverted transforms before starting transitions.
        void moved[0].el.offsetHeight;

        let rafId: number | null = null;
        const itemCleanups: Array<() => void> = [];

        const finishAll = () => {
          if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
            window.cancelAnimationFrame(rafId);
            rafId = null;
          }
          for (const fn of itemCleanups) fn();
          itemCleanups.length = 0;
          activeCleanupsRef.current.delete(finishAll);
        };

        activeCleanupsRef.current.add(finishAll);

        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          for (const { el } of moved) {
            let cleaned = false;
            let timerId: number | null = null;

            const cleanupEl = () => {
              if (cleaned) return;
              cleaned = true;
              el.removeEventListener('transitionend', onTransitionEnd);
              if (timerId !== null) {
                window.clearTimeout(timerId);
                timerId = null;
              }
              el.style.transition = '';
              el.style.transform = '';
            };

            const onTransitionEnd = (event: TransitionEvent) => {
              if (event.target === el && event.propertyName === 'transform') {
                cleanupEl();
              }
            };

            el.addEventListener('transitionend', onTransitionEnd);
            timerId = window.setTimeout(cleanupEl, durationMs + 60);
            itemCleanups.push(cleanupEl);

            el.style.transition = `transform ${durationMs}ms ${easing}`;
            el.style.transform = '';
          }
        });
      }
    }

    prevTopsRef.current = nextTops;
    prevKeysSigRef.current = keysSig;
  }, [keysSig, enabled, durationMs, easing, itemSelector, keyAttribute, containerRef, flushActiveAnimations]);

  useEffect(() => flushActiveAnimations, [flushActiveAnimations]);

  return { registerItem };
}
