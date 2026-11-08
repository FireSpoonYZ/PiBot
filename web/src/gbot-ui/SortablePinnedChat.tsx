// gbot-ui lane：置顶会话整行可拖拽/可键盘重排包裹组件。
// 结构约定：wrapper 直接包裹会话行（children），不渲染右侧独立拖拽手柄，使置顶灰底完整覆盖整行；
// 未置顶项不套本组件。
// 手势防冲突约定：
// - 轻点（<500ms 未拖动）：正常打开会话；
// - 触摸快速滑动（<260ms 内移动 >10px 或触发列表滚动）：放弃拖拽，交给原生列表滚动；
// - 长按不拖动（满 500ms 未拖动）：弹出上下文菜单；
// - 长按拖动（触摸按住 ≥260ms 后拖动，或满 500ms 弹出菜单后继续按住拖动，以及桌面鼠标左键拖动）：
//   自动抑制/收起菜单并进入置顶顺序拖拽，松手提交新顺序且不误触打开会话；
// - Escape / pointercancel / blur：取消拖拽还原位置；
// - 会话行聚焦时 ArrowUp/ArrowDown：调整置顶顺序（保留过滤隐藏的置顶项原位）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { reorderExistingPins } from './chatPins';
import './sortable-pinned-chat.css';

const DRAG_THRESHOLD_PX = 5;
const SCROLL_CANCEL_TOLERANCE_PX = 10;
const TOUCH_DRAG_HOLD_MS = 260;
const FALLBACK_ROW_HEIGHT_PX = 48;
const CLICK_GUARD_MS = 400;

export interface SortablePinnedChatProps {
  chatKey: string;
  keys: string[];
  onReorder: (keys: string[]) => void;
  children: ReactNode;
  className?: string;
}

const cn = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

/**
 * 解析当前置顶项所属的直接列表容器（兼容直接挂在列表 div 下，或包在 ul > li 下），
 * 确保拖拽与键盘重排只在同一父列表容器内进行，绝不跨到主 Bot 区或普通未置顶区。
 */
function getPinnedListContainer(wrapper: HTMLElement): HTMLElement | null {
  const parent = wrapper.parentElement;
  if (!parent) return null;
  if (parent.tagName === 'LI' && parent.parentElement) {
    return parent.parentElement;
  }
  return parent;
}

function getPeerPinnedWrappers(
  wrapper: HTMLElement,
  allowedKeys: ReadonlySet<string>,
): HTMLElement[] {
  const container = getPinnedListContainer(wrapper);
  if (!container) return [wrapper];
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>('[data-pinned-chat-key]'),
  );
  return candidates.filter((el) => {
    const key = el.dataset.pinnedChatKey?.trim() ?? '';
    return key.length > 0 && allowedKeys.has(key) && getPinnedListContainer(el) === container;
  });
}

function clearPeerDropPositions(peers: readonly HTMLElement[]): void {
  for (const peer of peers) {
    peer.removeAttribute('data-drop-position');
  }
}

interface ActiveDragSession {
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  dragBaseY: number;
  currentTranslateY: number;
  dragArmed: boolean;
  moved: boolean;
  holdTimer: number | null;
  startIndex: number;
  targetIndex: number;
  peers: HTMLElement[];
  peerKeys: string[];
  cleanup: () => void;
}

export function SortablePinnedChat({
  chatKey,
  keys,
  onReorder,
  children,
  className,
}: SortablePinnedChatProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDragSession | null>(null);
  const suppressClickUntilRef = useRef(0);
  const clickGuardTimerRef = useRef<number | null>(null);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const [dragging, setDragging] = useState(false);
  const [translateY, setTranslateY] = useState(0);

  const armClickGuard = useCallback(() => {
    suppressClickUntilRef.current = performance.now() + CLICK_GUARD_MS;
    if (clickGuardTimerRef.current !== null) {
      window.clearTimeout(clickGuardTimerRef.current);
    }
    const swallowClick = (event: MouseEvent) => {
      if (performance.now() <= suppressClickUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('click', swallowClick, true);
    clickGuardTimerRef.current = window.setTimeout(() => {
      window.removeEventListener('click', swallowClick, true);
      clickGuardTimerRef.current = null;
    }, CLICK_GUARD_MS + 20);
  }, []);

  const stopActiveDrag = useCallback(
    (commit: boolean) => {
      const session = dragRef.current;
      if (!session) return;
      dragRef.current = null;
      if (session.holdTimer !== null) {
        window.clearTimeout(session.holdTimer);
        session.holdTimer = null;
      }
      session.cleanup();
      clearPeerDropPositions(session.peers);

      const wrapper = wrapperRef.current;
      if (wrapper) {
        try {
          if (wrapper.hasPointerCapture?.(session.pointerId)) {
            wrapper.releasePointerCapture(session.pointerId);
          }
        } catch {
          // 忽略非活动指针释放异常
        }
      }

      setDragging(false);
      setTranslateY(0);

      if (session.moved) {
        armClickGuard();
      }

      if (
        commit &&
        session.moved &&
        session.startIndex !== session.targetIndex &&
        session.startIndex >= 0 &&
        session.targetIndex >= 0 &&
        session.targetIndex < session.peerKeys.length
      ) {
        const nextVisible = [...session.peerKeys];
        const [movedKey] = nextVisible.splice(session.startIndex, 1);
        if (movedKey) {
          nextVisible.splice(session.targetIndex, 0, movedKey);
          const nextAllKeys = reorderExistingPins(keysRef.current, nextVisible);
          onReorderRef.current(nextAllKeys);
        }
      }
    },
    [armClickGuard],
  );

  const updateDragByPointer = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== pointerId) return;

      session.lastY = clientY;

      // 触摸端长按就绪前：若手指移动超出容差，视为用户在上下滚动列表，放弃拖拽
      if (!session.dragArmed) {
        const moveDist = Math.hypot(clientX - session.startX, clientY - session.startY);
        if (moveDist > SCROLL_CANCEL_TOLERANCE_PX) {
          stopActiveDrag(false);
        }
        return;
      }

      const dy = clientY - session.dragBaseY;
      if (!session.moved) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        session.moved = true;
        setDragging(true);
        armClickGuard();
        // 若用户按住已超过 500ms 导致上下文菜单刚弹出，继续拖动时立即收起菜单转为排序
        window.dispatchEvent(new CustomEvent('gbot-close-context-menu'));
        try {
          wrapperRef.current?.setPointerCapture?.(pointerId);
        } catch {
          // 忽略不支持 pointer capture 的环境
        }
      }

      if (session.peers.length <= 1) {
        session.currentTranslateY = 0;
        setTranslateY(0);
        return;
      }

      const selfEl = session.peers[session.startIndex];
      if (!selfEl) return;
      const selfLiveRect = selfEl.getBoundingClientRect();
      const rawSelfTop = selfLiveRect.top - session.currentTranslateY;

      const rawRects = session.peers.map((peer, idx) => {
        if (idx === session.startIndex) {
          return {
            top: rawSelfTop,
            bottom: rawSelfTop + selfLiveRect.height,
            height: selfLiveRect.height,
          };
        }
        const rect = peer.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });

      const hasLayout = rawRects.some((r) => r.height > 0 || r.top !== 0);
      const peerRects = hasLayout
        ? rawRects
        : session.peers.map((_, idx) => {
            const top =
              session.dragBaseY -
              FALLBACK_ROW_HEIGHT_PX / 2 +
              (idx - session.startIndex) * FALLBACK_ROW_HEIGHT_PX;
            return {
              top,
              bottom: top + FALLBACK_ROW_HEIGHT_PX,
              height: FALLBACK_ROW_HEIGHT_PX,
            };
          });

      const selfRect = peerRects[session.startIndex]!;
      const selfTop = selfRect.top;
      const selfBottom = selfRect.bottom;
      const selfMid = selfTop + selfRect.height / 2;

      const firstRect = peerRects[0]!;
      const lastRect = peerRects[peerRects.length - 1]!;
      const minDy = firstRect.top - selfTop;
      const maxDy = lastRect.bottom - selfBottom;
      const clampedDy = Math.max(minDy, Math.min(maxDy, dy));
      session.currentTranslateY = clampedDy;
      setTranslateY(clampedDy);

      let nextIndex = session.startIndex;
      if (clientY < selfMid) {
        for (let i = 0; i < session.startIndex; i += 1) {
          const r = peerRects[i]!;
          if (clientY < r.top + r.height / 2) {
            nextIndex = i;
            break;
          }
        }
      } else if (clientY > selfMid) {
        for (let i = session.startIndex + 1; i < peerRects.length; i += 1) {
          const r = peerRects[i]!;
          if (clientY > r.top + r.height / 2) {
            nextIndex = i;
          }
        }
      }

      session.targetIndex = nextIndex;
      clearPeerDropPositions(session.peers);
      if (nextIndex < session.startIndex) {
        session.peers[nextIndex]?.setAttribute('data-drop-position', 'before');
      } else if (nextIndex > session.startIndex) {
        session.peers[nextIndex]?.setAttribute('data-drop-position', 'after');
      }
    },
    [armClickGuard, stopActiveDrag],
  );

  useEffect(
    () => () => {
      if (dragRef.current) {
        const session = dragRef.current;
        dragRef.current = null;
        if (session.holdTimer !== null) {
          window.clearTimeout(session.holdTimer);
        }
        session.cleanup();
        clearPeerDropPositions(session.peers);
      }
      if (clickGuardTimerRef.current !== null) {
        window.clearTimeout(clickGuardTimerRef.current);
        clickGuardTimerRef.current = null;
      }
    },
    [],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    stopActiveDrag(false);

    const normalizedKey = chatKey.trim();
    const allowedSet = new Set(keysRef.current.map((k) => k.trim()).filter(Boolean));
    allowedSet.add(normalizedKey);
    const peers = getPeerPinnedWrappers(wrapper, allowedSet);
    const peerKeys = peers.map((el) => el.dataset.pinnedChatKey?.trim() ?? '').filter(Boolean);
    const startIndex = peerKeys.indexOf(normalizedKey);
    if (startIndex === -1) return;

    const pointerId = event.pointerId;
    const isMouse = event.pointerType === 'mouse';

    const onWindowPointerMove = (moveEvent: PointerEvent) => {
      updateDragByPointer(moveEvent.pointerId, moveEvent.clientX, moveEvent.clientY);
    };

    const onWindowPointerUp = (upEvent: PointerEvent) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== upEvent.pointerId) return;
      stopActiveDrag(true);
    };

    const onWindowPointerCancel = (cancelEvent: PointerEvent) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== cancelEvent.pointerId) return;
      stopActiveDrag(false);
    };

    const onWindowTouchMove = (touchEvent: TouchEvent) => {
      const session = dragRef.current;
      if (!session) return;
      if (session.dragArmed && touchEvent.cancelable) {
        touchEvent.preventDefault();
      }
    };

    const onWindowScroll = () => {
      const session = dragRef.current;
      if (!session || session.moved) return;
      stopActiveDrag(false);
    };

    const onWindowBlur = () => {
      if (!dragRef.current) return;
      stopActiveDrag(false);
    };

    const onWindowKeyDown = (keyEvent: KeyboardEvent) => {
      const session = dragRef.current;
      if (keyEvent.key !== 'Escape' || !session || !session.moved) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      stopActiveDrag(false);
    };

    window.addEventListener('pointermove', onWindowPointerMove, true);
    window.addEventListener('pointerup', onWindowPointerUp, true);
    window.addEventListener('pointercancel', onWindowPointerCancel, true);
    window.addEventListener('touchmove', onWindowTouchMove, { capture: true, passive: false });
    window.addEventListener('scroll', onWindowScroll, { capture: true, passive: true });
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onWindowKeyDown, true);

    const session: ActiveDragSession = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      dragBaseY: event.clientY,
      currentTranslateY: 0,
      dragArmed: isMouse,
      moved: false,
      holdTimer: null,
      startIndex,
      targetIndex: startIndex,
      peers,
      peerKeys,
      cleanup: () => {
        window.removeEventListener('pointermove', onWindowPointerMove, true);
        window.removeEventListener('pointerup', onWindowPointerUp, true);
        window.removeEventListener('pointercancel', onWindowPointerCancel, true);
        window.removeEventListener('touchmove', onWindowTouchMove, true);
        window.removeEventListener('scroll', onWindowScroll, true);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('keydown', onWindowKeyDown, true);
      },
    };

    if (!isMouse) {
      session.holdTimer = window.setTimeout(() => {
        if (dragRef.current === session) {
          session.holdTimer = null;
          session.dragArmed = true;
          session.dragBaseY = session.lastY;
        }
      }, TOUCH_DRAG_HOLD_MS);
    }

    dragRef.current = session;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && dragRef.current?.moved) {
      event.preventDefault();
      event.stopPropagation();
      stopActiveDrag(false);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stopActiveDrag(false);

    const normalizedKey = chatKey.trim();
    const currentKeys = keysRef.current.map((k) => k.trim()).filter(Boolean);
    const allowedSet = new Set(currentKeys);
    const wrapper = wrapperRef.current;
    const peers = wrapper ? getPeerPinnedWrappers(wrapper, allowedSet) : [];
    const visibleKeys =
      peers.length > 1
        ? peers.map((el) => el.dataset.pinnedChatKey?.trim() ?? '').filter(Boolean)
        : currentKeys;

    const currentIndex = visibleKeys.indexOf(normalizedKey);
    if (currentIndex === -1) return;
    const targetIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= visibleKeys.length) return;

    const nextVisible = [...visibleKeys];
    const [movedKey] = nextVisible.splice(currentIndex, 1);
    if (!movedKey) return;
    nextVisible.splice(targetIndex, 0, movedKey);

    const nextAllKeys = reorderExistingPins(currentKeys, nextVisible);
    onReorderRef.current(nextAllKeys);

    requestAnimationFrame(() => {
      const rowButton = wrapperRef.current?.querySelector<HTMLElement>('button');
      if (rowButton?.isConnected && document.activeElement !== rowButton) {
        rowButton.focus({ preventScroll: true });
      }
    });
  };

  const wrapperStyle =
    dragging && translateY !== 0
      ? { transform: `translate3d(0, ${translateY}px, 0)` }
      : undefined;

  return (
    <div
      className={cn('gbot-sortable-pinned-chat', className)}
      data-dragging={dragging ? 'true' : undefined}
      data-pinned-chat-key={chatKey}
      data-sortable-pinned-chat=""
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      ref={wrapperRef}
      style={wrapperStyle}
    >
      {children}
    </div>
  );
}
