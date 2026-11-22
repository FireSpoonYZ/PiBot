import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { useText } from '../../ui';
import { IconButton } from './IconButton';

export const FLOATING_UI_EXEMPT_SELECTOR =
  '.ui-popover-menu, .ui-select-listbox, .conn-status-popover, .composer-popover, .notice-layer-root, [data-floating-ui="true"]';

const FLOATING_POPOVER_OPEN_SELECTOR =
  '.ui-popover-menu[data-ui-dialog="open"], .ui-select-listbox[data-ui-dialog="open"], .conn-status-popover[data-ui-dialog="open"], .composer-popover[data-ui-dialog="open"], .gbot-context-menu[data-ui-dialog="open"], [data-floating-ui="true"][data-ui-dialog="open"]';

const EXTERNAL_OVERLAY_SELECTOR =
  '.notice-layer-card:not(.is-exiting), [data-ui-dialog="open"], [role="dialog"][aria-modal="true"]';

function matchesFloatingUiNode(target: EventTarget | null | undefined): boolean {
  if (!target) return false;
  if (target instanceof Element) {
    return Boolean(target.closest(FLOATING_UI_EXEMPT_SELECTOR));
  }
  if (target instanceof Node && target.parentElement) {
    return Boolean(target.parentElement.closest(FLOATING_UI_EXEMPT_SELECTOR));
  }
  return false;
}

export function isEventInsideFloatingUi(
  event: { target: EventTarget | null } | Event | null | undefined,
): boolean {
  if (!event) return false;
  if (matchesFloatingUiNode(event.target)) return true;
  const detail = (event as { detail?: { originalEvent?: { target?: EventTarget | null } } }).detail;
  return matchesFloatingUiNode(detail?.originalEvent?.target);
}

export function hasOpenFloatingPopover(aboveElement?: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false;
  const popovers = document.querySelectorAll<HTMLElement>(FLOATING_POPOVER_OPEN_SELECTOR);
  if (popovers.length === 0) return false;
  if (!aboveElement) return true;
  for (let i = popovers.length - 1; i >= 0; i -= 1) {
    const el = popovers[i];
    if (el === aboveElement) continue;
    const rel = aboveElement.compareDocumentPosition(el);
    if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 || (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0) {
      return true;
    }
  }
  return false;
}

export interface ViewportSafeBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

function readCssPxVar(style: CSSStyleDeclaration, ...names: string[]): number {
  for (const name of names) {
    const raw = style.getPropertyValue(name).trim();
    if (!raw) continue;
    if (/^-?\d+(?:\.\d+)?(?:px)?$/.test(raw)) {
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return 0;
}

export function getViewportSafeBounds(margin = 8): ViewportSafeBounds {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { top: margin, bottom: margin, left: margin, right: margin, width: 0, height: 0 };
  }
  const style = window.getComputedStyle(document.documentElement);
  const safeTop = readCssPxVar(style, '--top', '--safe-area-inset-top');
  const safeBottom = readCssPxVar(style, '--safe-area-inset-bottom', '--bottom');
  const imeBottom = readCssPxVar(style, '--ime-bottom');
  const safeLeft = readCssPxVar(style, '--safe-left', '--safe-area-inset-left');
  const safeRight = readCssPxVar(style, '--safe-right', '--safe-area-inset-right');

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const vv = window.visualViewport;
  const vvBottomInset = vv ? Math.max(0, vh - (vv.offsetTop + vv.height)) : 0;
  const effectiveBottomInset = Math.max(safeBottom, imeBottom, vvBottomInset);

  const top = Math.max(margin, safeTop + margin);
  const bottom = Math.max(margin, effectiveBottomInset + margin);
  const left = Math.max(margin, safeLeft + margin);
  const right = Math.max(margin, safeRight + margin);

  return {
    top,
    bottom,
    left,
    right,
    width: Math.max(0, vw - left - right),
    height: Math.max(0, vh - top - bottom),
  };
}

export function useViewportInsetEffect(onChange: () => void, active: boolean): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const handle = () => onChangeRef.current();
    const vv = window.visualViewport;
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    vv?.addEventListener('resize', handle);
    vv?.addEventListener('scroll', handle);

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      observer = new MutationObserver(handle);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style'],
      });
    }

    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
      vv?.removeEventListener('resize', handle);
      vv?.removeEventListener('scroll', handle);
      observer?.disconnect();
    };
  }, [active]);
}

export interface TopLayerCloseOptions {
  kind: 'toast' | 'floating' | 'modal';
  getElement: () => HTMLElement | null;
  onClose: (reason: 'escape' | 'back') => void;
  canHandleEscape?: (event: KeyboardEvent) => boolean;
  canHandleBack?: (event: Event) => boolean;
  blockBackWhenDisabled?: boolean;
}

interface TopLayerRecord {
  id: number;
  optionsRef: { current: TopLayerCloseOptions };
}

let topLayerSeq = 0;
const topLayerStack: TopLayerRecord[] = [];
let topLayerListenersInstalled = false;

function handleFloatingFocusBubble(event: FocusEvent): void {
  if (event.type === 'focusin') {
    if (matchesFloatingUiNode(event.target)) {
      event.stopPropagation();
    }
  } else if (event.type === 'focusout') {
    if (matchesFloatingUiNode(event.relatedTarget)) {
      event.stopPropagation();
    }
  }
}

function dispatchTopLayerEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;

  // 1. Focused toast always wins Escape without touching any underlying modal.
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
  if (activeEl) {
    for (let i = topLayerStack.length - 1; i >= 0; i -= 1) {
      const opts = topLayerStack[i].optionsRef.current;
      if (opts.kind !== 'toast') continue;
      const el = opts.getElement();
      if (!el || !el.contains(activeEl)) continue;
      if (opts.canHandleEscape && !opts.canHandleEscape(event)) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      opts.onClose('escape');
      return;
    }
  }

  // 2. LIFO over non-toast layers: if topmost layer is floating (popover/select/menu/inline-confirm),
  //    consume Escape BEFORE Radix document-capture useEscapeKeydown or frozen SettingsSheet.
  //    If topmost layer is a modal (Radix Dialog/Overlay/Lightbox/Theater), defer to Radix DismissableLayer.
  for (let i = topLayerStack.length - 1; i >= 0; i -= 1) {
    const opts = topLayerStack[i].optionsRef.current;
    if (opts.kind === 'toast') continue;
    if (opts.kind === 'modal') {
      return;
    }
    if (opts.canHandleEscape && !opts.canHandleEscape(event)) continue;
    event.preventDefault();
    event.stopImmediatePropagation();
    opts.onClose('escape');
    return;
  }
}

function dispatchTopLayerBack(event: Event): void {
  if (event.defaultPrevented) return;
  for (let i = topLayerStack.length - 1; i >= 0; i -= 1) {
    const opts = topLayerStack[i].optionsRef.current;
    if (opts.kind === 'toast') continue;
    if (opts.canHandleBack && !opts.canHandleBack(event)) {
      if (opts.blockBackWhenDisabled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      continue;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    opts.onClose('back');
    return;
  }
}

function ensureTopLayerListeners(): void {
  if (topLayerListenersInstalled || typeof window === 'undefined') return;
  topLayerListenersInstalled = true;
  window.addEventListener('keydown', dispatchTopLayerEscape, true);
  window.addEventListener('app-back', dispatchTopLayerBack, true);
  if (typeof document !== 'undefined' && document.documentElement) {
    // Bubble on <html> runs strictly AFTER React portal listeners on <body>
    // and strictly BEFORE Radix FocusScope's bubble listeners on `document`.
    document.documentElement.addEventListener('focusin', handleFloatingFocusBubble);
    document.documentElement.addEventListener('focusout', handleFloatingFocusBubble);
  }
}

// Install once at module load so capture order precedes dynamically mounted SettingsSheet / Host listeners.
ensureTopLayerListeners();

export function registerTopLayer(optionsRef: { current: TopLayerCloseOptions }): () => void {
  ensureTopLayerListeners();
  const record: TopLayerRecord = { id: ++topLayerSeq, optionsRef };
  topLayerStack.push(record);
  return () => {
    const idx = topLayerStack.indexOf(record);
    if (idx !== -1) topLayerStack.splice(idx, 1);
  };
}

export function useTopLayerClose(active: boolean, options: TopLayerCloseOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    return registerTopLayer(optionsRef);
  }, [active]);
}

function hasExternalOverlayInDom(ignoreContainer: HTMLElement | null): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const nodes = document.body.querySelectorAll<HTMLElement>(EXTERNAL_OVERLAY_SELECTOR);
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    if (ignoreContainer && (el === ignoreContainer || el.contains(ignoreContainer))) {
      continue;
    }
    return true;
  }
  return false;
}

export function useExternalOverlayPresent(
  enabled: boolean,
  ignoreContainerRef?: RefObject<HTMLElement | null>,
): boolean {
  const [present, setPresent] = useState<boolean>(() =>
    enabled ? hasExternalOverlayInDom(ignoreContainerRef?.current ?? null) : false,
  );

  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || !document.body) {
      setPresent(false);
      return;
    }
    const check = () => {
      const next = hasExternalOverlayInDom(ignoreContainerRef?.current ?? null);
      setPresent(prev => (prev === next ? prev : next));
    };
    check();
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ui-dialog', 'aria-modal', 'class'],
    });
    return () => observer.disconnect();
  }, [enabled, ignoreContainerRef]);

  return present;
}

export type OverlayVariant = 'center' | 'sheet' | 'drawer' | 'fullscreen';

export interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hideTitle?: boolean;
  description?: string;
  variant?: OverlayVariant;
  showClose?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  onCloseAutoFocus?: (event: Event) => void;
  ref?: Ref<HTMLDivElement>;
}

const SHEET_DISMISS_DISTANCE_PX = 88;
const SHEET_DISMISS_VELOCITY_PX_MS = 0.11;
const SHEET_MIN_FLICK_DISTANCE_PX = 18;
const SHEET_SETTLE_MS = 220;

interface SheetDragState {
  pointerId: number;
  startY: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  moved: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    ref.current = value;
  }
}

export function Overlay({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  variant = 'center',
  showClose,
  children,
  footer,
  className = '',
  onCloseAutoFocus,
  ref,
}: OverlayProps) {
  const t = useText();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<SheetDragState | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const resetSheetInlineStyles = useCallback(() => {
    clearSettleTimer();
    dragStateRef.current = null;
    const contentEl = contentRef.current;
    if (contentEl) {
      contentEl.style.transform = '';
      contentEl.style.transition = '';
    }
    const scrimEl = scrimRef.current;
    if (scrimEl) {
      scrimEl.style.opacity = '';
      scrimEl.style.transition = '';
    }
  }, [clearSettleTimer]);

  // Reset any in-flight drag styles on open state changes or unmount.
  useEffect(() => {
    resetSheetInlineStyles();
    return () => {
      clearSettleTimer();
    };
  }, [open, resetSheetInlineStyles, clearSettleTimer]);

  // Android hardware / gesture back button interception via unified module-level LIFO stack.
  useTopLayerClose(open, {
    kind: 'modal',
    getElement: () => contentRef.current,
    onClose: () => onOpenChange(false),
  });

  const handleSheetPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (variant !== 'sheet') return;
      // Single-pointer multi-touch guard.
      if (dragStateRef.current !== null) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]')) {
        return;
      }

      clearSettleTimer();
      dragStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTime: event.timeStamp || performance.now(),
        velocity: 0,
        moved: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable on synthetic events.
      }
    },
    [variant, clearSettleTimer],
  );

  const handleSheetPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const contentEl = contentRef.current;
      if (!contentEl) return;

      const now = event.timeStamp || performance.now();
      const rawDeltaY = event.clientY - state.startY;
      if (!state.moved && Math.abs(rawDeltaY) < 4) return;
      state.moved = true;

      const dt = now - state.lastTime;
      if (dt > 0) {
        const instantVelocity = (event.clientY - state.lastY) / dt;
        state.velocity = state.velocity * 0.4 + instantVelocity * 0.6;
      }
      state.lastY = event.clientY;
      state.lastTime = now;

      // Upward boundary friction damping (smooth rubber-band resistance above origin).
      const offsetY =
        rawDeltaY < 0
          ? -(28 * (1 - Math.exp(rawDeltaY / 120)))
          : rawDeltaY;

      contentEl.style.transition = 'none';
      contentEl.style.transform = `translateX(-50%) translate3d(0, ${offsetY}px, 0)`;

      const scrimEl = scrimRef.current;
      if (scrimEl && rawDeltaY > 0) {
        const sheetHeight = Math.max(contentEl.offsetHeight, 240);
        const progress = Math.min(1, rawDeltaY / sheetHeight);
        scrimEl.style.transition = 'none';
        scrimEl.style.opacity = String(Math.max(0.15, 1 - progress * 0.85));
      } else if (scrimEl) {
        scrimEl.style.opacity = '';
      }
    },
    [],
  );

  const finishSheetDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      dragStateRef.current = null;

      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Ignore release errors when capture was already dropped.
      }

      if (!state.moved) return;

      const contentEl = contentRef.current;
      const scrimEl = scrimRef.current;
      if (!contentEl) return;

      const rawDeltaY = event.clientY - state.startY;
      const shouldDismiss =
        !cancelled &&
        (rawDeltaY >= SHEET_DISMISS_DISTANCE_PX ||
          (rawDeltaY > SHEET_MIN_FLICK_DISTANCE_PX && state.velocity > SHEET_DISMISS_VELOCITY_PX_MS));

      if (prefersReducedMotion()) {
        resetSheetInlineStyles();
        if (shouldDismiss) {
          onOpenChange(false);
        }
        return;
      }

      if (shouldDismiss) {
        contentEl.style.transition =
          'transform var(--dur-base, 220ms) var(--ease-drawer, cubic-bezier(0.32, 0.72, 0, 1))';
        contentEl.style.transform = 'translateX(-50%) translate3d(0, 100%, 0)';
        if (scrimEl) {
          scrimEl.style.transition = 'opacity var(--dur-fast, 150ms) var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))';
          scrimEl.style.opacity = '0';
        }
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          onOpenChange(false);
        }, SHEET_SETTLE_MS);
        return;
      }

      // Snap back smoothly to rest.
      contentEl.style.transition =
        'transform var(--dur-base, 220ms) var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))';
      contentEl.style.transform = 'translateX(-50%) translate3d(0, 0, 0)';
      if (scrimEl) {
        scrimEl.style.transition = 'opacity var(--dur-fast, 150ms) var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))';
        scrimEl.style.opacity = '1';
      }
      clearSettleTimer();
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        resetSheetInlineStyles();
      }, SHEET_SETTLE_MS);
    },
    [onOpenChange, resetSheetInlineStyles, clearSettleTimer],
  );

  const sheetDragProps =
    variant === 'sheet'
      ? {
          onPointerDown: handleSheetPointerDown,
          onPointerMove: handleSheetPointerMove,
          onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finishSheetDrag(event, false),
          onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finishSheetDrag(event, true),
        }
      : undefined;

  const closeVisible = showClose ?? !hideTitle;
  const scrimCls = `ui-overlay-scrim is-${variant}`;
  const contentCls = ['ui-overlay-content', `is-${variant}`, className].filter(Boolean).join(' ');
  const describedByProps = description ? {} : { 'aria-describedby': undefined };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay ref={scrimRef} className={scrimCls} />
        <DialogPrimitive.Content
          ref={setContentNode}
          data-ui-dialog={open ? 'open' : undefined}
          className={contentCls}
          {...describedByProps}
          onPointerDownOutside={event => {
            if (isEventInsideFloatingUi(event)) event.preventDefault();
          }}
          onFocusOutside={event => {
            if (isEventInsideFloatingUi(event)) event.preventDefault();
          }}
          onInteractOutside={event => {
            if (isEventInsideFloatingUi(event)) event.preventDefault();
          }}
          onEscapeKeyDown={event => {
            if (hasOpenFloatingPopover(contentRef.current)) {
              event.preventDefault();
              return;
            }
            event.stopPropagation();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {variant === 'sheet' ? (
            <div className="ui-overlay-handle-zone" aria-hidden="true" {...sheetDragProps}>
              <div className="ui-overlay-handle" />
            </div>
          ) : null}
          {hideTitle ? (
            <>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              {closeVisible ? (
                <header className="ui-overlay-header" {...sheetDragProps}>
                  <span className="ui-overlay-title" aria-hidden="true" />
                  <DialogPrimitive.Close asChild>
                    <IconButton label={t('关闭', 'Close')} size="sm">
                      <X aria-hidden="true" />
                    </IconButton>
                  </DialogPrimitive.Close>
                </header>
              ) : null}
            </>
          ) : (
            <header className="ui-overlay-header" {...sheetDragProps}>
              <DialogPrimitive.Title className="ui-overlay-title">{title}</DialogPrimitive.Title>
              {closeVisible ? (
                <DialogPrimitive.Close asChild>
                  <IconButton label={t('关闭', 'Close')} size="sm">
                    <X aria-hidden="true" />
                  </IconButton>
                </DialogPrimitive.Close>
              ) : null}
            </header>
          )}
          {description ? (
            <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          ) : null}
          <div className="ui-overlay-body">{children}</div>
          {footer ? <footer className="ui-overlay-footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
