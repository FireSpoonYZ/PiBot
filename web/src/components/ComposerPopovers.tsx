import { Camera, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useText } from '../ui';
import {
  getViewportSafeBounds,
  useTopLayerClose,
  useViewportInsetEffect,
} from './ui/Overlay';

const VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 6;

function computeAnchoredStyle(
  anchorEl: HTMLElement,
  popoverEl: HTMLElement,
  options: { matchWidth?: boolean; preferredSide?: 'top' | 'bottom' } = {},
): { style: CSSProperties; side: 'top' | 'bottom' } {
  const { matchWidth = false, preferredSide = 'top' } = options;
  const anchorRect = anchorEl.getBoundingClientRect();
  const popoverRect = popoverEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bounds = getViewportSafeBounds(VIEWPORT_MARGIN);

  const targetWidth = matchWidth
    ? Math.min(anchorRect.width, Math.max(160, bounds.width))
    : popoverRect.width;

  const spaceAbove = anchorRect.top - bounds.top;
  const spaceBelow = vh - bounds.bottom - anchorRect.bottom;

  let side: 'top' | 'bottom' = preferredSide;
  if (preferredSide === 'top' && popoverRect.height + POPOVER_GAP > spaceAbove && spaceBelow > spaceAbove) {
    side = 'bottom';
  } else if (preferredSide === 'bottom' && popoverRect.height + POPOVER_GAP > spaceBelow && spaceAbove > spaceBelow) {
    side = 'top';
  }

  const maxHeight = Math.max(
    120,
    Math.min(
      320,
      bounds.height - POPOVER_GAP,
      Math.max(120, (side === 'top' ? spaceAbove : spaceBelow) - POPOVER_GAP),
    ),
  );
  const renderedHeight = Math.min(popoverRect.height, maxHeight);

  const rawTop =
    side === 'top'
      ? anchorRect.top - POPOVER_GAP - renderedHeight
      : anchorRect.bottom + POPOVER_GAP;
  const maxTop = Math.max(bounds.top, vh - bounds.bottom - renderedHeight);
  const clampedTop = Math.min(Math.max(bounds.top, rawTop), maxTop);

  const rawLeft = anchorRect.left;
  const maxLeft = Math.max(bounds.left, vw - bounds.right - targetWidth);
  const clampedLeft = Math.min(Math.max(bounds.left, rawLeft), maxLeft);

  const originY = side === 'top' ? 'bottom' : 'top';

  return {
    side,
    style: {
      position: 'fixed',
      top: `${Math.round(clampedTop)}px`,
      left: `${Math.round(clampedLeft)}px`,
      ...(matchWidth ? { width: `${Math.round(targetWidth)}px` } : {}),
      maxHeight: `${Math.round(maxHeight)}px`,
      transformOrigin: `${originY} left`,
      zIndex: 425,
      pointerEvents: 'auto',
      visibility: 'visible',
    },
  };
}

export interface ComposerSlashCommandItem {
  readonly name: string;
  readonly zh: string;
  readonly en: string;
}

export interface ComposerSlashPopoverProps {
  open: boolean;
  query: string;
  listboxId: string;
  matches: readonly ComposerSlashCommandItem[];
  activeIndex: number;
  optionProps: (index: number) => HTMLAttributes<HTMLDivElement>;
  anchorRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  ariaLabel?: string;
}

export function ComposerSlashPopover({
  open,
  query,
  listboxId,
  matches,
  activeIndex,
  optionProps,
  anchorRef,
  returnFocusRef,
  ariaLabel,
}: ComposerSlashPopoverProps) {
  const t = useText();
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [localIndex, setLocalIndex] = useState<number | null>(null);
  const [positioned, setPositioned] = useState<{ style: CSSProperties; side: 'top' | 'bottom' }>({
    style: { visibility: 'hidden' },
    side: 'top',
  });

  useEffect(() => {
    setDismissedQuery(null);
    setLocalIndex(null);
  }, [query]);

  useEffect(() => {
    setLocalIndex(null);
  }, [activeIndex]);

  const effectiveOpen = open && matches.length > 0 && dismissedQuery !== query;
  const resolvedActiveIndex = Math.min(
    localIndex ?? activeIndex,
    Math.max(0, matches.length - 1),
  );

  const dismiss = useCallback(
    (restoreFocus: boolean) => {
      setDismissedQuery(query);
      if (restoreFocus) {
        requestAnimationFrame(() => {
          returnFocusRef?.current?.focus();
        });
      }
    },
    [query, returnFocusRef],
  );

  const updatePosition = useCallback(() => {
    const anchorEl = anchorRef?.current;
    const popoverEl = listboxRef.current;
    if (!anchorEl || !popoverEl || typeof window === 'undefined') return;
    setPositioned(computeAnchoredStyle(anchorEl, popoverEl, { matchWidth: true, preferredSide: 'top' }));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!effectiveOpen) return;
    if (anchorRef?.current) {
      updatePosition();
      const rafId = requestAnimationFrame(updatePosition);
      return () => cancelAnimationFrame(rafId);
    }
  }, [effectiveOpen, matches.length, anchorRef, updatePosition]);

  useEffect(() => {
    if (!effectiveOpen) return;
    optionRefs.current[resolvedActiveIndex]?.scrollIntoView({ block: 'nearest' });
  }, [effectiveOpen, resolvedActiveIndex]);

  useTopLayerClose(effectiveOpen, {
    kind: 'floating',
    getElement: () => listboxRef.current,
    onClose: () => dismiss(true),
  });

  useViewportInsetEffect(updatePosition, effectiveOpen);

  useEffect(() => {
    if (!effectiveOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        listboxRef.current?.contains(target) ||
        anchorRef?.current?.contains(target) ||
        returnFocusRef?.current?.contains(target)
      ) {
        return;
      }
      dismiss(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [effectiveOpen, anchorRef, returnFocusRef, dismiss]);

  const handleListboxKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setLocalIndex((resolvedActiveIndex + 1) % matches.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setLocalIndex((resolvedActiveIndex - 1 + matches.length) % matches.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setLocalIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setLocalIndex(matches.length - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        optionRefs.current[resolvedActiveIndex]?.click();
        requestAnimationFrame(() => returnFocusRef?.current?.focus());
      }
    },
    [dismiss, matches.length, resolvedActiveIndex, returnFocusRef],
  );

  if (!effectiveOpen) return null;

  const isPortaled = Boolean(anchorRef?.current && typeof document !== 'undefined');
  const content = (
    <div
      ref={listboxRef}
      id={listboxId}
      className={`bot-slash-popover composer-popover${isPortaled ? ' is-portaled' : ''}`}
      role="listbox"
      tabIndex={-1}
      data-ui-dialog="open"
      data-floating-ui="true"
      data-side={positioned.side}
      aria-label={ariaLabel ?? t('斜杠命令', 'Slash commands')}
      style={isPortaled ? positioned.style : undefined}
      onKeyDown={handleListboxKeyDown}
    >
      {matches.map((command, index) => {
        const props = optionProps(index);
        const isActive = index === resolvedActiveIndex;
        return (
          <div
            key={command.name}
            ref={el => { optionRefs.current[index] = el; }}
            {...props}
            aria-selected={isActive}
            className={`bot-slash-item${isActive ? ' active' : ''}`}
            onMouseEnter={event => {
              setLocalIndex(null);
              props.onMouseEnter?.(event);
            }}
          >
            <code>{command.name}</code>
            <span>{t(command.zh, command.en)}</span>
          </div>
        );
      })}
    </div>
  );

  return isPortaled ? createPortal(content, document.body) : content;
}

interface PlusMenuEntry {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  unsupported?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface ComposerPlusMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inTauriUi: boolean;
  imageDisabled?: boolean;
  imageUnsupported?: boolean;
  onPickPhotos: () => void;
  onPickCamera?: () => void;
  onUnsupportedImage?: () => void;
  clearDisabled?: boolean;
  onRequestClear: () => void;
  ariaLabel?: string;
}

export function ComposerPlusMenu({
  open,
  onOpenChange,
  inTauriUi,
  imageDisabled = false,
  imageUnsupported = false,
  onPickPhotos,
  onPickCamera,
  onUnsupportedImage,
  clearDisabled = false,
  onRequestClear,
  ariaLabel,
}: ComposerPlusMenuProps) {
  const t = useText();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusRef = useRef<'first' | 'last' | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [positioned, setPositioned] = useState<{ style: CSSProperties; side: 'top' | 'bottom' }>({
    style: { visibility: 'hidden' },
    side: 'top',
  });

  const items = useMemo<PlusMenuEntry[]>(() => {
    const list: PlusMenuEntry[] = [
      {
        key: 'photos',
        label: t('选择图片', 'Choose image'),
        icon: <ImageIcon size={18} aria-hidden="true" />,
        disabled: !imageUnsupported && imageDisabled,
        unsupported: imageUnsupported,
        onSelect: () => {
          if (imageUnsupported) {
            onUnsupportedImage?.();
            return;
          }
          onPickPhotos();
        },
      },
    ];
    if (inTauriUi && onPickCamera) {
      list.push({
        key: 'camera',
        label: t('拍照', 'Camera'),
        icon: <Camera size={18} aria-hidden="true" />,
        disabled: !imageUnsupported && imageDisabled,
        unsupported: imageUnsupported,
        onSelect: () => {
          if (imageUnsupported) {
            onUnsupportedImage?.();
            return;
          }
          onPickCamera();
        },
      });
    }
    list.push({
      key: 'clear',
      label: t('清空当前对话历史 (/clear)', 'Clear conversation history (/clear)'),
      icon: <Trash2 size={18} aria-hidden="true" />,
      danger: true,
      disabled: clearDisabled,
      separatorBefore: true,
      onSelect: onRequestClear,
    });
    return list;
  }, [
    t,
    inTauriUi,
    imageDisabled,
    imageUnsupported,
    onPickPhotos,
    onPickCamera,
    onUnsupportedImage,
    clearDisabled,
    onRequestClear,
  ]);

  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false);
      if (restoreFocus) {
        requestAnimationFrame(() => {
          triggerRef.current?.focus();
        });
      }
    },
    [onOpenChange],
  );

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!triggerEl || !menuEl || typeof window === 'undefined') return;
    setPositioned(computeAnchoredStyle(triggerEl, menuEl, { matchWidth: false, preferredSide: 'top' }));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const firstEnabled = items.findIndex(item => !item.disabled);
    let initialIndex = firstEnabled >= 0 ? firstEnabled : 0;
    if (pendingFocusRef.current === 'last') {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (!items[i].disabled) {
          initialIndex = i;
          break;
        }
      }
    }
    pendingFocusRef.current = null;
    setActiveIndex(initialIndex);

    const rafId = requestAnimationFrame(() => {
      updatePosition();
      if (firstEnabled >= 0) {
        itemRefs.current[initialIndex]?.focus();
      } else {
        menuRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [open, items, updatePosition]);

  useTopLayerClose(open, {
    kind: 'floating',
    getElement: () => menuRef.current,
    onClose: () => closeMenu(true),
  });

  useViewportInsetEffect(updatePosition, open);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      closeMenu(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, closeMenu]);

  const focusStep = useCallback(
    (startIndex: number, step: 1 | -1) => {
      const count = items.length;
      if (count === 0) return;
      for (let offset = 1; offset <= count; offset += 1) {
        const next = (startIndex + step * offset + count) % count;
        if (!items[next].disabled) {
          setActiveIndex(next);
          itemRefs.current[next]?.focus();
          return;
        }
      }
    },
    [items],
  );

  const focusBoundary = useCallback(
    (fromEnd: boolean) => {
      if (fromEnd) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (!items[i].disabled) {
            setActiveIndex(i);
            itemRefs.current[i]?.focus();
            return;
          }
        }
      } else {
        const first = items.findIndex(item => !item.disabled);
        if (first >= 0) {
          setActiveIndex(first);
          itemRefs.current[first]?.focus();
        }
      }
    },
    [items],
  );

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        pendingFocusRef.current = 'last';
        onOpenChange(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        pendingFocusRef.current = 'first';
        onOpenChange(true);
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      }
    },
    [open, onOpenChange, closeMenu],
  );

  const handleTriggerClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onOpenChange(!open);
    },
    [open, onOpenChange],
  );

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      } else if (event.key === 'Tab') {
        closeMenu(false);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusStep(activeIndex, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusStep(activeIndex, -1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusBoundary(false);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusBoundary(true);
      }
    },
    [activeIndex, closeMenu, focusBoundary, focusStep],
  );

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  const triggerLabel = ariaLabel ?? t('更多操作', 'More actions');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`grok-composer-plus-circle${open ? ' active' : ''}`}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <Plus size={22} aria-hidden="true" />
      </button>

      {open && portalTarget
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="bot-plus-popover composer-popover is-portaled"
              role="menu"
              aria-label={triggerLabel}
              tabIndex={-1}
              data-ui-dialog="open"
              data-floating-ui="true"
              data-side={positioned.side}
              style={positioned.style}
              onKeyDown={handleMenuKeyDown}
            >
              {items.map((item, index) => (
                <div key={item.key} role="none" className="composer-menu-entry">
                  {item.separatorBefore && index > 0 ? (
                    <div className="composer-menu-separator" role="separator" aria-hidden="true" />
                  ) : null}
                  <button
                    ref={el => { itemRefs.current[index] = el; }}
                    type="button"
                    role="menuitem"
                    tabIndex={!item.disabled && index === activeIndex ? 0 : -1}
                    disabled={item.disabled}
                    aria-disabled={item.unsupported ? 'true' : undefined}
                    className={[
                      item.danger ? 'danger' : '',
                      item.unsupported ? 'is-unsupported' : '',
                    ].filter(Boolean).join(' ') || undefined}
                    onFocus={() => {
                      if (!item.disabled) setActiveIndex(index);
                    }}
                    onClick={() => {
                      if (item.disabled) return;
                      const triggerEl = triggerRef.current;
                      if (triggerEl && triggerEl.isConnected && !triggerEl.disabled) {
                        triggerEl.focus({ preventScroll: true });
                      }
                      closeMenu(false);
                      item.onSelect();
                      requestAnimationFrame(() => {
                        const active = document.activeElement;
                        const lost = !active || active === document.body || !active.isConnected;
                        if (lost && triggerRef.current?.isConnected && !triggerRef.current.disabled) {
                          triggerRef.current.focus({ preventScroll: true });
                        }
                      });
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                </div>
              ))}
            </div>,
            portalTarget,
          )
        : null}
    </>
  );
}
