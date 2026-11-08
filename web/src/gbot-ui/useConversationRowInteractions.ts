// gbot-ui lane：会话行指针/键盘交互 hook。
// 复制自 lenML/gbot-ui（MIT，仓库 licenses/gbot-ui-MIT.txt）：
// 上游 src/components/grok-bot/MobileChatList.tsx 的 useConversationRowInteractions，
// 长按 500ms、移动容差 10px、点击抑制 1000ms、主指针主键、scroll/cancel/leave 取消、
// 长按后 500ms 内去重原生 contextmenu、Shift+F10/ContextMenu 键定位菜单。
// 与上游的差异仅：菜单载荷简化为 {x, y} 坐标（本仓库无 GrokBotContextMenuState/store），
// 键盘菜单坐标算法沿用 ContextMenu.tsx 的 openAgentContextMenuFromKeyboard。
import { useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;
const CLICK_SUPPRESSION_MS = 1_000;

export interface ConversationMenuPosition {
  x: number;
  y: number;
}

export interface UseConversationRowInteractionsInput {
  onOpen: () => void;
  onOpenMenu?: (position: ConversationMenuPosition) => void;
}

/** 行内嵌套的独立操作控件（按钮/链接/输入等）：其事件不触发行级点击与长按菜单。 */
const NESTED_INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [data-no-row-menu]';

/** 事件是否源自行内嵌套操作控件（closest 命中行 button 本身不算嵌套）。 */
function isFromNestedControl(event: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target === event.currentTarget) return false;
  const control = target.closest(NESTED_INTERACTIVE);
  return control !== null && control !== event.currentTarget;
}

/**
 * 会话行长按/右键/键盘菜单 + 点击抑制。
 * 返回的 handlers 直接展开到 <button>；必须每次渲染顶层调用（map/条件内不得调用）。
 */
export function useConversationRowInteractions({
  onOpen,
  onOpenMenu,
}: UseConversationRowInteractionsInput) {
  const timerRef = useRef<number | null>(null);
  const suppressionTimerRef = useRef<number | null>(null);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  const lastLongPressAtRef = useRef(0);
  const onOpenRef = useRef(onOpen);
  const onOpenMenuRef = useRef(onOpenMenu);
  onOpenRef.current = onOpen;
  onOpenMenuRef.current = onOpenMenu;

  const clearClickSuppression = () => {
    suppressClickRef.current = false;
    if (suppressionTimerRef.current !== null) {
      window.clearTimeout(suppressionTimerRef.current);
      suppressionTimerRef.current = null;
    }
  };

  const armClickSuppression = () => {
    suppressClickRef.current = true;
    if (suppressionTimerRef.current !== null) {
      window.clearTimeout(suppressionTimerRef.current);
    }
    suppressionTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressionTimerRef.current = null;
    }, CLICK_SUPPRESSION_MS);
  };

  const clearScrollListener = () => {
    scrollCleanupRef.current?.();
    scrollCleanupRef.current = null;
  };

  const cancelPendingPress = (
    keepClickSuppression = suppressClickRef.current,
  ) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearScrollListener();
    pointerIdRef.current = null;
    if (!keepClickSuppression) clearClickSuppression();
  };

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (suppressionTimerRef.current !== null) {
        window.clearTimeout(suppressionTimerRef.current);
      }
      clearScrollListener();
    },
    [],
  );

  const openMenuAt = (x: number, y: number) => {
    onOpenMenuRef.current?.({ x, y });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (!onOpenMenuRef.current) return;
    if (isFromNestedControl(event)) return;

    cancelPendingPress();
    clearClickSuppression();
    pointerIdRef.current = event.pointerId;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };

    const row = event.currentTarget;
    const x = event.clientX;
    const y = event.clientY;
    const handleScroll = () => cancelPendingPress();
    window.addEventListener('scroll', handleScroll, {
      capture: true,
      passive: true,
    });
    scrollCleanupRef.current = () => {
      window.removeEventListener('scroll', handleScroll, true);
    };

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (row.closest('[data-dragging="true"]')) return;
      lastLongPressAtRef.current = performance.now();
      armClickSuppression();
      row.focus({ preventScroll: true });
      openMenuAt(x, y);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const dx = event.clientX - pointerStartRef.current.x;
    const dy = event.clientY - pointerStartRef.current.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) {
      cancelPendingPress();
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    cancelPendingPress(true);
    if (suppressClickRef.current) armClickSuppression();
  };

  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (isFromNestedControl(event)) return;
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      clearClickSuppression();
      return;
    }
    onOpenRef.current();
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onOpenMenuRef.current) return;
    event.preventDefault();
    cancelPendingPress();
    if (isFromNestedControl(event)) return;
    if (event.currentTarget.closest('[data-dragging="true"]')) return;
    if (performance.now() - lastLongPressAtRef.current < LONG_PRESS_MS) return;
    // 上游 openAgentContextMenu：preventDefault + focus + 以事件坐标开菜单。
    event.currentTarget.focus({ preventScroll: true });
    openMenuAt(event.clientX, event.clientY);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!onOpenMenuRef.current) return;
    if (isFromNestedControl(event)) return;
    // 上游 openAgentContextMenuFromKeyboard：Shift+F10 或 ContextMenu 键。
    if (!(event.shiftKey && event.key === 'F10') && event.key !== 'ContextMenu') {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(
      Math.min(rect.right - 8, window.innerWidth - 16),
      Math.min(rect.top + 28, window.innerHeight - 16),
    );
  };

  return {
    onClick: handleClick,
    onContextMenu: handleContextMenu,
    onKeyDown: handleKeyDown,
    onPointerCancel: () => cancelPendingPress(),
    onPointerDown: handlePointerDown,
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      if (pointerIdRef.current === event.pointerId) cancelPendingPress();
    },
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
  };
}
