// gbot-ui lane：置顶会话单项可拖拽/可键盘重排包裹组件。
// 结构约定：wrapper 内部将会话行（children）与拖拽手柄 button 并列作为兄弟节点，
// 绝不将 button 嵌套进 ConversationRow button 内；未置顶项不套本组件。
// 支持触摸与鼠标 pointer 拖拽、Escape/pointercancel 取消（不误触打开会话）、
// 以及手柄聚焦时 ArrowUp/ArrowDown 调整置顶顺序（保留过滤隐藏的置顶项原位）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { GripVertical } from 'lucide-react';
import { useText } from '../ui';
import { reorderExistingPins } from './chatPins';
import './sortable-pinned-chat.css';

const DRAG_THRESHOLD_PX = 3;
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
  startY: number;
  currentTranslateY: number;
  moved: boolean;
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
  const t = useText();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
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
      session.cleanup();
      clearPeerDropPositions(session.peers);

      const handle = handleRef.current;
      if (handle) {
        try {
          if (handle.hasPointerCapture?.(session.pointerId)) {
            handle.releasePointerCapture(session.pointerId);
          }
        } catch {
          // 忽略非活动指针释放异常
        }
      }

      setDragging(false);
      setTranslateY(0);

      if (session.moved || !commit) {
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
    (pointerId: number, clientY: number) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== pointerId) return;

      const dy = clientY - session.startY;
      if (!session.moved) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        session.moved = true;
        setDragging(true);
        armClickGuard();
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
              session.startY -
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
    [armClickGuard],
  );

  useEffect(
    () => () => {
      if (dragRef.current) {
        const session = dragRef.current;
        dragRef.current = null;
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

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    event.stopPropagation();
    stopActiveDrag(false);

    const normalizedKey = chatKey.trim();
    const allowedSet = new Set(keysRef.current.map((k) => k.trim()).filter(Boolean));
    allowedSet.add(normalizedKey);
    const peers = getPeerPinnedWrappers(wrapper, allowedSet);
    const peerKeys = peers.map((el) => el.dataset.pinnedChatKey?.trim() ?? '').filter(Boolean);
    const startIndex = peerKeys.indexOf(normalizedKey);
    if (startIndex === -1) return;

    const pointerId = event.pointerId;
    try {
      event.currentTarget.setPointerCapture?.(pointerId);
    } catch {
      // 忽略不支持 pointer capture 的环境
    }

    const onWindowPointerMove = (moveEvent: PointerEvent) => {
      updateDragByPointer(moveEvent.pointerId, moveEvent.clientY);
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

    const onWindowBlur = () => {
      if (!dragRef.current) return;
      stopActiveDrag(false);
    };

    const onWindowKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || !dragRef.current) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      stopActiveDrag(false);
    };

    window.addEventListener('pointermove', onWindowPointerMove, true);
    window.addEventListener('pointerup', onWindowPointerUp, true);
    window.addEventListener('pointercancel', onWindowPointerCancel, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onWindowKeyDown, true);

    dragRef.current = {
      pointerId,
      startY: event.clientY,
      currentTranslateY: 0,
      moved: false,
      startIndex,
      targetIndex: startIndex,
      peers,
      peerKeys,
      cleanup: () => {
        window.removeEventListener('pointermove', onWindowPointerMove, true);
        window.removeEventListener('pointerup', onWindowPointerUp, true);
        window.removeEventListener('pointercancel', onWindowPointerCancel, true);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('keydown', onWindowKeyDown, true);
      },
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    updateDragByPointer(event.pointerId, event.clientY);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    stopActiveDrag(true);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    stopActiveDrag(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && dragRef.current) {
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
      if (handleRef.current?.isConnected && document.activeElement !== handleRef.current) {
        handleRef.current.focus({ preventScroll: true });
      }
    });
  };

  const handleButtonClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleButtonContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
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
      ref={wrapperRef}
      style={wrapperStyle}
    >
      {children}
      <button
        aria-label={t(
          '拖动或按上下方向键调整置顶顺序',
          'Drag or use Up and Down arrow keys to reorder pinned chat',
        )}
        aria-roledescription={t('置顶排序手柄', 'Pinned chat reorder handle')}
        className="gbot-sortable-pinned-chat__handle"
        data-no-row-menu=""
        data-pinned-drag-handle={chatKey}
        onClick={handleButtonClick}
        onContextMenu={handleButtonContextMenu}
        onKeyDown={handleKeyDown}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        ref={handleRef}
        title={t('调整置顶顺序', 'Reorder pinned chat')}
        type="button"
      >
        <GripVertical aria-hidden="true" size={15} />
      </button>
    </div>
  );
}
