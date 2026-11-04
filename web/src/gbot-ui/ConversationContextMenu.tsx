// gbot-ui lane：会话右键/长按菜单。
// 复制自 lenML/gbot-ui（MIT，仓库 licenses/gbot-ui-MIT.txt）：
// 上游 src/components/grok-bot/ContextMenu.tsx 的定位/焦点/关闭/键盘逻辑（MENU_MARGIN=8、
// 视口边界、portal 到最近 .baby-grok-bot、首项聚焦、关闭恢复焦点、外点/Escape/滚动/resize
// 关闭、方向键/Home/End/Tab 导航）。
// 差异：本仓库无 GrokBotStore；菜单动作收缩为合同要求的单一“查看私聊”。
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { ConversationMenuPosition } from './useConversationRowInteractions';

const MENU_MARGIN = 8;

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
            label: '查看私聊',
            onSelect: onViewPrivateChats,
          },
        ]
      : []);

  useLayoutEffect(() => {
    if (!position || resolvedItems.length === 0) {
      setMenuPosition({ left: 0, top: 0, ready: false });
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const left = Math.max(
      MENU_MARGIN,
      Math.min(position.x, window.innerWidth - rect.width - MENU_MARGIN),
    );
    const top = Math.max(
      MENU_MARGIN,
      Math.min(position.y, window.innerHeight - rect.height - MENU_MARGIN),
    );
    setMenuPosition({ left, top, ready: true });
  }, [position, resolvedItems.length]);

  const close = (restoreFocus = true) => {
    const returnTarget = focusReturnRef.current;
    onCloseRef.current();
    if (restoreFocus) {
      queueMicrotask(() => {
        if (returnTarget?.isConnected)
          returnTarget.focus({ preventScroll: true });
      });
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!position) return;

    const active = document.activeElement;
    focusReturnRef.current = active instanceof HTMLElement ? active : null;
    const frame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [position]);

  useEffect(() => {
    if (!position) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.baby-grok-bot-context-menu')) return;
      closeRef.current(true);
    };
    const handleViewportChange = () => closeRef.current(true);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [position]);

  // 锚点 span 常驻：position 首次非空即开菜单时 hostRef 已挂载，portal 目标解析不丢。
  const anchor = <span aria-hidden="true" className="gbot-menu-anchor" ref={hostRef} />;

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;

    const currentIndex = Math.max(
      0,
      items.indexOf(document.activeElement as HTMLButtonElement),
    );
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      case 'Tab':
        closeRef.current(false);
        return;
      default:
        return;
    }

    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const menu = (
    <div
      aria-label="会话操作"
      className="baby-grok-bot-context-menu gbot-context-menu"
      data-ready={menuPosition.ready || undefined}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleMenuKeyDown}
      ref={menuRef}
      role="menu"
      style={{ left: menuPosition.left, top: menuPosition.top }}
    >
      <div className="baby-grok-bot-context-menu__label">会话操作</div>
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

  const shouldRenderMenu = Boolean(position && resolvedItems.length > 0);

  return (
    <>
      {anchor}
      {shouldRenderMenu ? (portalTarget ? createPortal(menu, portalTarget) : menu) : null}
    </>
  );
}
