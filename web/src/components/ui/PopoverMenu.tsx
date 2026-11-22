import { Check } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getViewportSafeBounds,
  useTopLayerClose,
  useViewportInsetEffect,
} from './Overlay';

export interface PopoverMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface PopoverMenuTriggerRenderProps {
  open: boolean;
  toggle: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  triggerProps: {
    ref: (node: HTMLButtonElement | null) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string | undefined;
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  };
}

export interface PopoverMenuProps {
  trigger: ReactElement | ((props: PopoverMenuTriggerRenderProps) => ReactNode);
  items: readonly PopoverMenuItem[];
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  ariaLabel: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  menuClassName?: string;
}

const VIEWPORT_MARGIN = 8;
const MENU_OFFSET = 6;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    ref.current = value;
  }
}

export function PopoverMenu({
  trigger,
  items,
  align = 'end',
  side = 'bottom',
  ariaLabel,
  open: controlledOpen,
  onOpenChange,
  className = '',
  menuClassName = '',
}: PopoverMenuProps) {
  const menuId = useId();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusRef = useRef<'first' | 'last' | null>(null);

  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const [activeIndex, setActiveIndex] = useState(0);

  const setOpen = useCallback(
    (next: boolean, restoreFocus = false) => {
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
      if (!next && restoreFocus) {
        requestAnimationFrame(() => {
          triggerRef.current?.focus();
        });
      }
    },
    [isControlled, onOpenChange],
  );

  const toggle = useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  const computePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!triggerEl || !menuEl || typeof window === 'undefined') return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bounds = getViewportSafeBounds(VIEWPORT_MARGIN);

    const spaceBelow = vh - bounds.bottom - triggerRect.bottom;
    const spaceAbove = triggerRect.top - bounds.top;

    let resolvedSide: 'top' | 'bottom' = side;
    if (side === 'bottom' && menuRect.height + MENU_OFFSET > spaceBelow && spaceAbove > spaceBelow) {
      resolvedSide = 'top';
    } else if (side === 'top' && menuRect.height + MENU_OFFSET > spaceAbove && spaceBelow > spaceAbove) {
      resolvedSide = 'bottom';
    }

    const maxHeight = Math.max(
      120,
      Math.min(
        360,
        bounds.height - MENU_OFFSET,
        Math.max(120, (resolvedSide === 'bottom' ? spaceBelow : spaceAbove) - MENU_OFFSET),
      ),
    );
    const renderedHeight = Math.min(menuRect.height, maxHeight);

    const rawTop =
      resolvedSide === 'bottom'
        ? triggerRect.bottom + MENU_OFFSET
        : triggerRect.top - MENU_OFFSET - renderedHeight;
    const maxTop = Math.max(bounds.top, vh - bounds.bottom - renderedHeight);
    const clampedTop = Math.min(Math.max(bounds.top, rawTop), maxTop);

    const rawLeft =
      align === 'end'
        ? triggerRect.right - menuRect.width
        : triggerRect.left;
    const maxLeft = Math.max(bounds.left, vw - bounds.right - menuRect.width);
    const clampedLeft = Math.min(Math.max(bounds.left, rawLeft), maxLeft);

    const originY = resolvedSide === 'bottom' ? 'top' : 'bottom';
    const originX = align === 'end' ? 'right' : 'left';

    setMenuStyle({
      position: 'fixed',
      top: `${Math.round(clampedTop)}px`,
      left: `${Math.round(clampedLeft)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
      transformOrigin: `${originY} ${originX}`,
      visibility: 'visible',
    });
  }, [align, side]);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
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
      computePosition();
      if (firstEnabled >= 0) {
        itemRefs.current[initialIndex]?.focus();
      } else {
        menuRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [open, items, computePosition]);

  useTopLayerClose(open, {
    kind: 'floating',
    getElement: () => menuRef.current,
    onClose: () => setOpen(false, true),
  });

  useViewportInsetEffect(computePosition, open);

  // Outside click interception.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, setOpen]);

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
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        pendingFocusRef.current = 'first';
        setOpen(true);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        pendingFocusRef.current = 'last';
        setOpen(true);
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false, true);
      }
    },
    [open, setOpen],
  );

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false, true);
      } else if (event.key === 'Tab') {
        setOpen(false);
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
    [activeIndex, focusBoundary, focusStep, setOpen],
  );

  const setTriggerNode = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
  }, []);

  const triggerProps: PopoverMenuTriggerRenderProps['triggerProps'] = {
    ref: setTriggerNode,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      toggle();
    },
    onKeyDown: handleTriggerKeyDown,
  };

  let triggerNode: ReactNode = null;
  if (typeof trigger === 'function') {
    triggerNode = trigger({ open, toggle, triggerRef, triggerProps });
  } else if (isValidElement(trigger)) {
    const existingProps = trigger.props as {
      ref?: Ref<HTMLButtonElement>;
      onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
      onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
    };
    const existingRef = existingProps.ref;
    triggerNode = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
      ref: (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        assignRef(existingRef, node);
      },
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
        existingProps.onClick?.(event);
        if (!event.defaultPrevented) {
          toggle();
        }
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        existingProps.onKeyDown?.(event);
        if (!event.defaultPrevented) {
          handleTriggerKeyDown(event);
        }
      },
    });
  }

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  const menuCls = ['ui-popover-menu', menuClassName].filter(Boolean).join(' ');

  return (
    <span className={['ui-popover-anchor', className].filter(Boolean).join(' ')}>
      {triggerNode}
      {open && portalTarget
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={ariaLabel}
              tabIndex={-1}
              data-ui-dialog="open"
              data-floating-ui="true"
              className={menuCls}
              style={menuStyle}
              onKeyDown={handleMenuKeyDown}
            >
              {items.map((item, index) => (
                <div key={item.key} role="none" className="ui-popover-menu-entry">
                  {item.separatorBefore && index > 0 ? (
                    <div role="separator" className="ui-popover-menu-sep" />
                  ) : null}
                  <button
                    ref={el => { itemRefs.current[index] = el; }}
                    type="button"
                    role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                    aria-checked={item.checked !== undefined ? item.checked : undefined}
                    tabIndex={!item.disabled && index === activeIndex ? 0 : -1}
                    disabled={item.disabled}
                    className={[
                      'ui-popover-menu-item',
                      item.danger ? 'is-danger' : '',
                      item.checked ? 'is-checked' : '',
                    ].filter(Boolean).join(' ')}
                    onFocus={() => {
                      if (!item.disabled) setActiveIndex(index);
                    }}
                    onClick={() => {
                      if (item.disabled) return;
                      const triggerEl = triggerRef.current;
                      // Restore focus to trigger synchronously before closing/running action so:
                      // - in-place actions return focus to the trigger instead of document.body,
                      // - actions opening a dialog/overlay capture the trigger for Radix FocusScope return,
                      // - actions that explicitly focus another element override this naturally.
                      if (triggerEl && triggerEl.isConnected && !triggerEl.disabled) {
                        triggerEl.focus({ preventScroll: true });
                      }
                      setOpen(false);
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
                    {item.icon ? (
                      <span className="ui-popover-menu-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                    ) : null}
                    <span className="ui-popover-menu-label">{item.label}</span>
                    {item.shortcut ? (
                      <span className="ui-popover-menu-shortcut tabular-nums" aria-hidden="true">
                        {item.shortcut}
                      </span>
                    ) : null}
                    {item.checked ? (
                      <span className="ui-popover-menu-check" aria-hidden="true">
                        <Check aria-hidden="true" />
                      </span>
                    ) : null}
                  </button>
                </div>
              ))}
            </div>,
            portalTarget,
          )
        : null}
    </span>
  );
}
