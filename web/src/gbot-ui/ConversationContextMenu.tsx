// gbot-ui lane：会话右键/长按菜单。
// 桌面端沿用指针定位 popover（右键/Shift+F10/外点/Escape/方向键/焦点恢复）；
// coarse 触屏端改用 components/ui 的 ActionSheet 底部操作表，打开时触发轻触感反馈。
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { ActionSheet } from '../components/ui';
import { getViewportSafeBounds, useTopLayerClose } from '../components/ui/Overlay';
import { mobileHaptic } from '../native/tauri-host';
import { useText } from '../ui';
import type { ConversationMenuPosition } from './useConversationRowInteractions';

const MENU_MARGIN = 8;

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    setCoarse(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

export interface ConversationMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ConversationContextMenuProps {
  position: ConversationMenuPosition | null;
  onClose: () => void;
  items?: ConversationMenuItem[];
  onViewPrivateChats?: () => void;
}

/** 会话上下文菜单：优先渲染 items，缺省回退 onViewPrivateChats 兼容旧调用方。 */
export function ConversationContextMenu({
  position,
  onClose,
  items,
  onViewPrivateChats,
}: ConversationContextMenuProps) {
  const t = useText();
  const coarsePointer = useIsCoarsePointer();
  const hostRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, ready: false });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const host = hostRef.current;
    setPortalTarget(host?.closest<HTMLElement>('.baby-grok-bot') ?? null);
  }, []);

  const resolvedItems: ConversationMenuItem[] =
    items ??
    (onViewPrivateChats
      ? [
          {
            key: 'view-private-chats',
            label: t('查看私聊', 'View private chats'),
            onSelect: onViewPrivateChats,
          },
        ]
      : []);

  const shouldRenderMenu = Boolean(position && resolvedItems.length > 0);
  const useSheet = coarsePointer;

  useEffect(() => {
    if (shouldRenderMenu && useSheet) {
      mobileHaptic('longPress');
    }
  }, [shouldRenderMenu, useSheet]);

  useLayoutEffect(() => {
    if (useSheet || !position || resolvedItems.length === 0) {
      setMenuPosition({ left: 0, top: 0, ready: false });
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const bounds = getViewportSafeBounds(MENU_MARGIN);
    const maxLeft = Math.max(bounds.left, window.innerWidth - bounds.right - rect.width);
    const maxTop = Math.max(bounds.top, window.innerHeight - bounds.bottom - rect.height);
    const left = Math.max(bounds.left, Math.min(position.x, maxLeft));
    const top = Math.max(bounds.top, Math.min(position.y, maxTop));
    setMenuPosition({ left, top, ready: true });
  }, [useSheet, position, resolvedItems.length]);

  const close = (restoreFocus = true) => {
    const returnTarget = focusReturnRef.current;
    const menuEl = menuRef.current;
    onCloseRef.current();
    if (restoreFocus) {
      queueMicrotask(() => {
        const active = document.activeElement;
        const focusLost =
          !active ||
          active === document.body ||
          !active.isConnected ||
          Boolean(menuEl && menuEl.contains(active));
        if (focusLost && returnTarget?.isConnected) {
          returnTarget.focus({ preventScroll: true });
        }
      });
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useTopLayerClose(shouldRenderMenu && !useSheet, {
    kind: 'floating',
    getElement: () => menuRef.current,
    onClose: () => closeRef.current(true),
  });

  useEffect(() => {
    if (!position || useSheet) return;

    const active = document.activeElement;
    focusReturnRef.current = active instanceof HTMLElement ? active : null;
    const frame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [position, useSheet]);

  useEffect(() => {
    if (!position) return;

    const handleForceClose = () => closeRef.current(false);
    window.addEventListener('gbot-close-context-menu', handleForceClose);

    if (useSheet) {
      return () => {
        window.removeEventListener('gbot-close-context-menu', handleForceClose);
      };
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.baby-grok-bot-context-menu')) return;
      closeRef.current(true);
    };
    const handleViewportChange = () => closeRef.current(true);

    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('gbot-close-context-menu', handleForceClose);
    };
  }, [position, useSheet]);

  // 锚点 span 常驻：position 首次非空即开菜单时 hostRef 已挂载，portal 目标解析不丢。
  const anchor = <span aria-hidden="true" className="gbot-menu-anchor" ref={hostRef} />;

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (menuItems.length === 0) return;

    const currentIndex = Math.max(
      0,
      menuItems.indexOf(document.activeElement as HTMLButtonElement),
    );
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % menuItems.length;
        break;
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = menuItems.length - 1;
        break;
      case 'Tab':
        closeRef.current(false);
        return;
      default:
        return;
    }

    event.preventDefault();
    menuItems[nextIndex]?.focus();
  };

  if (useSheet) {
    return (
      <>
        {anchor}
        <ActionSheet
          open={shouldRenderMenu}
          onOpenChange={open => { if (!open) close(false); }}
          title={t('会话操作', 'Conversation actions')}
          items={resolvedItems}
        />
      </>
    );
  }

  const menuTitle = t('会话操作', 'Conversation actions');
  const menu = (
    <div
      aria-label={menuTitle}
      className="baby-grok-bot-context-menu gbot-context-menu"
      data-ui-dialog="open"
      data-floating-ui="true"
      data-ready={menuPosition.ready || undefined}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleMenuKeyDown}
      ref={menuRef}
      role="menu"
      style={{ left: menuPosition.left, top: menuPosition.top, zIndex: 425, pointerEvents: 'auto' }}
    >
      <div className="baby-grok-bot-context-menu__label">{menuTitle}</div>
      {resolvedItems.map((item) => (
        <button
          className={
            item.danger
              ? 'baby-grok-bot-context-menu__item baby-grok-bot-context-menu__item--danger danger'
              : 'baby-grok-bot-context-menu__item'
          }
          data-danger={item.danger || undefined}
          disabled={item.disabled}
          key={item.key}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            close(true);
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {item.icon ? (
            <span aria-hidden="true" className="gbot-context-menu__item-icon">
              {item.icon}
            </span>
          ) : null}
          <span className="gbot-context-menu__item-label">{item.label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      {anchor}
      {shouldRenderMenu ? (portalTarget ? createPortal(menu, portalTarget) : menu) : null}
    </>
  );
}
