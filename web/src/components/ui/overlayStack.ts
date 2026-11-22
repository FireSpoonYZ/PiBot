export const FLOATING_UI_EXEMPT_SELECTOR =
  '.ui-popover-menu, .ui-select-listbox, .conn-status-popover, .composer-popover, .notice-layer-root, [data-floating-ui="true"]';

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
let installedWindow: Window | null = null;
let installedDocEl: HTMLElement | null = null;

export function matchesFloatingUiNode(target: EventTarget | null | undefined): boolean {
  if (!target) return false;
  if (typeof Element !== 'undefined' && target instanceof Element) {
    return Boolean(target.closest(FLOATING_UI_EXEMPT_SELECTOR));
  }
  if (typeof Node !== 'undefined' && target instanceof Node && target.parentElement) {
    return Boolean(target.parentElement.closest(FLOATING_UI_EXEMPT_SELECTOR));
  }
  return false;
}

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
      event.stopImmediatePropagation?.();
      opts.onClose('escape');
      return;
    }
  }

  // 2. LIFO over non-toast layers: if topmost layer is floating (popover/select/menu/inline-confirm),
  //    consume Escape BEFORE Radix document-capture useEscapeKeydown or SettingsSheet.
  //    If topmost layer is a modal (Radix Dialog/Overlay/Lightbox/Theater/SettingsSheet/CaModal), defer to its own Escape handler.
  for (let i = topLayerStack.length - 1; i >= 0; i -= 1) {
    const opts = topLayerStack[i].optionsRef.current;
    if (opts.kind === 'toast') continue;
    if (opts.kind === 'modal') {
      return;
    }
    if (opts.canHandleEscape && !opts.canHandleEscape(event)) continue;
    event.preventDefault();
    event.stopImmediatePropagation?.();
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
        event.stopImmediatePropagation?.();
        return;
      }
      continue;
    }
    event.preventDefault();
    event.stopImmediatePropagation?.();
    opts.onClose('back');
    return;
  }
}

function ensureTopLayerListeners(): void {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    if (installedWindow !== window) {
      if (installedWindow && typeof installedWindow.removeEventListener === 'function') {
        installedWindow.removeEventListener('keydown', dispatchTopLayerEscape, true);
        installedWindow.removeEventListener('app-back', dispatchTopLayerBack, true);
      }
      window.addEventListener('keydown', dispatchTopLayerEscape, true);
      window.addEventListener('app-back', dispatchTopLayerBack, true);
      installedWindow = window;
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    const docEl = document.documentElement;
    if (installedDocEl !== docEl) {
      if (installedDocEl && typeof installedDocEl.removeEventListener === 'function') {
        installedDocEl.removeEventListener('focusin', handleFloatingFocusBubble);
        installedDocEl.removeEventListener('focusout', handleFloatingFocusBubble);
      }
      // Bubble on <html> runs strictly AFTER React portal listeners on <body>
      // and strictly BEFORE Radix FocusScope's bubble listeners on `document`.
      docEl.addEventListener('focusin', handleFloatingFocusBubble);
      docEl.addEventListener('focusout', handleFloatingFocusBubble);
      installedDocEl = docEl;
    }
  }
}

// Install once at module load so capture order precedes dynamically mounted SettingsSheet / Host listeners.
ensureTopLayerListeners();

export function registerTopLayer(optionsRef: { current: TopLayerCloseOptions }): () => void {
  ensureTopLayerListeners();
  const record: TopLayerRecord = { id: ++topLayerSeq, optionsRef };
  topLayerStack.push(record);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const idx = topLayerStack.indexOf(record);
    if (idx !== -1) topLayerStack.splice(idx, 1);
  };
}

export function registerOverlayBackHandler(onBack: () => void): () => void {
  const optionsRef: { current: TopLayerCloseOptions } = {
    current: {
      kind: 'modal',
      getElement: () => null,
      onClose: () => onBack(),
    },
  };
  return registerTopLayer(optionsRef);
}

export function getOverlayStackDepth(): number {
  let depth = 0;
  for (let i = 0; i < topLayerStack.length; i += 1) {
    if (topLayerStack[i].optionsRef.current.kind !== 'toast') {
      depth += 1;
    }
  }
  return depth;
}

export function hasOpenOverlay(): boolean {
  return getOverlayStackDepth() > 0;
}
