interface OverlayBackEntry {
  id: number;
  onBack: () => void;
}

const stack: OverlayBackEntry[] = [];
let nextEntryId = 1;
let attached = false;

function canUseWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.addEventListener === 'function';
}

function handleWindowAppBack(event: Event): void {
  if (event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  top.onBack();
}

function ensureAttached(): void {
  if (attached || !canUseWindow()) return;
  window.addEventListener('app-back', handleWindowAppBack, true);
  attached = true;
}

function detachIfEmpty(): void {
  if (!attached || stack.length > 0) return;
  if (canUseWindow() && typeof window.removeEventListener === 'function') {
    window.removeEventListener('app-back', handleWindowAppBack, true);
  }
  attached = false;
}

export function registerOverlayBackHandler(onBack: () => void): () => void {
  const entry: OverlayBackEntry = { id: nextEntryId++, onBack };
  stack.push(entry);
  ensureAttached();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = stack.findIndex(item => item.id === entry.id);
    if (index !== -1) {
      stack.splice(index, 1);
    }
    detachIfEmpty();
  };
}

export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

export function getOverlayStackDepth(): number {
  return stack.length;
}
