import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useText } from '../ui';
import {
  ZOOM_STEPS,
  mapClientPointToNormalized,
  mapKeyboardEventKey,
  normalizeWheelDelta,
  type BrowserFrame,
  type BrowserInputEvent,
} from './protocol';

export interface BotBrowserViewportProps {
  liveFrame: BrowserFrame;
  pageTitle?: string;
  canSendInput: boolean;
  zoom: number;
  onZoomChange: (nextZoom: number) => void;
  onInput: (event: BrowserInputEvent) => void;
  onExitStageFocus?: () => void;
}

const TAP_MOVE_THRESHOLD_PX = 10;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_ZOOM;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 100) / 100;
}

export function BotBrowserViewport({
  liveFrame,
  pageTitle,
  canSendInput,
  zoom,
  onZoomChange,
  onInput,
  onExitStageFocus,
}: BotBrowserViewportProps) {
  const t = useText();
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const viewCenterRef = useRef({ x: 0.5, y: 0.5 });
  const centeredPageRef = useRef<string | undefined>(undefined);
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);

  const pointerStartRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    lastX: number;
    lastY: number;
    dragging: boolean;
    pageId: string;
    revision: number;
  } | null>(null);
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startZoom: number } | null>(null);
  const suppressNextClickRef = useRef(false);

  const canSendInputRef = useRef(canSendInput);
  canSendInputRef.current = canSendInput;
  const liveFrameRef = useRef(liveFrame);
  liveFrameRef.current = liveFrame;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  const framePageId = liveFrame.pageId;
  const frameRatio = liveFrame.width / liveFrame.height;
  const renderedWidth = Math.floor(Math.min(stageSize.width, stageSize.height * frameRatio) * zoom);
  const renderedHeight = renderedWidth / frameRatio;
  const zoomed = zoom > MIN_ZOOM + 0.01;

  useLayoutEffect(() => {
    if (!stage) return;
    const measure = () => {
      const { width, height } = stage.getBoundingClientRect();
      setStageSize((prev) => prev.width === width && prev.height === height ? prev : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);

  // Keep the same point in the page centered as the frame scales.
  useLayoutEffect(() => {
    const wrap = frameWrapRef.current;
    if (!stage || !wrap || !framePageId || renderedWidth <= 0) return;
    if (centeredPageRef.current !== framePageId) {
      centeredPageRef.current = framePageId;
      viewCenterRef.current = { x: 0.5, y: 0.5 };
    }
    const center = viewCenterRef.current;
    const stageRect = stage.getBoundingClientRect();
    const frameRect = wrap.getBoundingClientRect();
    stage.scrollLeft += frameRect.left - stageRect.left + center.x * renderedWidth - stage.clientWidth / 2;
    stage.scrollTop += frameRect.top - stageRect.top + center.y * renderedHeight - stage.clientHeight / 2;
  }, [stage, framePageId, renderedWidth, renderedHeight]);

  const sendWheel = useCallback((point: { x: number; y: number }, deltaX: number, deltaY: number) => {
    if (deltaX === 0 && deltaY === 0) return;
    onInputRef.current({ kind: 'wheel', ...point, deltaX, deltaY });
  }, []);

  // Non-passive wheel forwarding for desktop mice and trackpads.
  useEffect(() => {
    const el = imgEl;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (!canSendInputRef.current) return;
      const frame = liveFrameRef.current;
      const rect = el.getBoundingClientRect();
      const point = mapClientPointToNormalized(
        ev.clientX,
        ev.clientY,
        rect,
        frame.width,
        frame.height,
      );
      if (!point) return;

      ev.preventDefault();
      const { deltaX, deltaY } = normalizeWheelDelta(ev.deltaX, ev.deltaY, ev.deltaMode);
      sendWheel(point, deltaX, deltaY);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [imgEl, sendWheel]);

  const handlePointerDown = (ev: PointerEvent<HTMLImageElement>) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.pointerType === 'touch' || canSendInput || zoomed) {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    }
    if (ev.pointerType === 'touch') {
      activeTouchesRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (activeTouchesRef.current.size === 2) {
        const pts = Array.from(activeTouchesRef.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchRef.current = { startDist: Math.max(dist, 1), startZoom: zoom };
        pointerStartRef.current = null;
        suppressNextClickRef.current = true;
        return;
      }
    }

    if (!canSendInput && !zoomed) return;

    pointerStartRef.current = {
      pointerId: ev.pointerId,
      clientX: ev.clientX,
      clientY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      dragging: false,
      pageId: liveFrame.pageId,
      revision: liveFrame.revision,
    };
    suppressNextClickRef.current = false;
  };

  const handlePointerMove = (ev: PointerEvent<HTMLImageElement>) => {
    if (ev.pointerType === 'touch' && activeTouchesRef.current.has(ev.pointerId)) {
      activeTouchesRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinchRef.current && activeTouchesRef.current.size === 2) {
        const pts = Array.from(activeTouchesRef.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const next = clampZoom((pinchRef.current.startZoom * dist) / pinchRef.current.startDist);
        onZoomChange(next);
        return;
      }
    }

    const start = pointerStartRef.current;
    if (start?.pointerId !== ev.pointerId) return;
    if (!start.dragging && Math.hypot(ev.clientX - start.clientX, ev.clientY - start.clientY) <= TAP_MOVE_THRESHOLD_PX) return;
    start.dragging = true;
    const dx = start.lastX - ev.clientX;
    const dy = start.lastY - ev.clientY;
    start.lastX = ev.clientX;
    start.lastY = ev.clientY;
    if (zoomed && stage) {
      stage.scrollLeft += dx;
      stage.scrollTop += dy;
    } else if (ev.pointerType === 'touch' && canSendInput && liveFrame.pageId === start.pageId && liveFrame.revision === start.revision) {
      const rect = ev.currentTarget.getBoundingClientRect();
      const point = mapClientPointToNormalized(start.clientX, start.clientY, rect, liveFrame.width, liveFrame.height);
      if (!point) return;
      const scale = liveFrame.width / rect.width;
      const { deltaX, deltaY } = normalizeWheelDelta(dx * scale, dy * scale, 0);
      sendWheel(point, deltaX, deltaY);
    }
  };

  const handlePointerUp = (ev: PointerEvent<HTMLImageElement>) => {
    if (ev.pointerType === 'touch') {
      activeTouchesRef.current.delete(ev.pointerId);
      if (activeTouchesRef.current.size < 2) {
        pinchRef.current = null;
      }
    }

    const start = pointerStartRef.current;
    pointerStartRef.current = null;

    if (suppressNextClickRef.current) {
      if (activeTouchesRef.current.size === 0) suppressNextClickRef.current = false;
      return;
    }

    if (!start || start.pointerId !== ev.pointerId || start.dragging || !canSendInput || !imgEl ||
        liveFrame.pageId !== start.pageId || liveFrame.revision !== start.revision) {
      return;
    }

    const moved = Math.hypot(ev.clientX - start.clientX, ev.clientY - start.clientY);
    if (moved > TAP_MOVE_THRESHOLD_PX) return;

    const rect = imgEl.getBoundingClientRect();
    const point = mapClientPointToNormalized(
      ev.clientX,
      ev.clientY,
      rect,
      liveFrame.width,
      liveFrame.height,
    );
    if (!point) return;

    stage?.focus({ preventScroll: true });
    onInput({ kind: 'click', x: point.x, y: point.y });
  };

  const handlePointerCancel = (ev: PointerEvent<HTMLImageElement>) => {
    if (ev.pointerType === 'touch') {
      activeTouchesRef.current.delete(ev.pointerId);
      if (activeTouchesRef.current.size < 2) pinchRef.current = null;
    }
    pointerStartRef.current = null;
  };

  const handleStageKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!canSendInput) return;
    if (ev.nativeEvent.isComposing) return;

    // Shift+Escape exits remote keyboard focus without trapping keyboard-only users.
    if (ev.key === 'Escape' && ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      stage?.blur();
      onExitStageFocus?.();
      if (typeof document !== 'undefined' && (!stage || document.activeElement === stage || document.activeElement === document.body)) {
        const fallback = stage?.closest('section, main, [role="dialog"], [role="region"]');
        if (fallback instanceof HTMLElement) {
          fallback.focus({ preventScroll: true });
        }
      }
      return;
    }

    const special = mapKeyboardEventKey(ev.key);
    if (special) {
      ev.preventDefault();
      if (special === 'Escape') ev.stopPropagation();
      onInput({ kind: 'key', key: special });
      return;
    }

    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
      ev.preventDefault();
      onInput({ kind: 'text', text: ev.key });
    }
  };

  const stageClass = [
    'bb-stage',
    canSendInput ? 'bb-stage--interactive' : '',
    zoomed ? 'bb-stage--zoomed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setStage}
      className={stageClass}
      tabIndex={canSendInput ? 0 : -1}
      role={canSendInput ? 'application' : 'region'}
      aria-label={
        canSendInput
          ? t('Bot 浏览器实时接管画布，点击或输入将发送到当前页面，按 Shift+Esc 退出画布焦点', 'Interactive Bot browser canvas. Clicks and keys go to the live page. Press Shift+Escape to leave canvas focus.')
          : t('Bot 浏览器只读实时画面', 'Read-only live view of Bot browser')
      }
      onKeyDown={handleStageKeyDown}
      onScroll={(event) => {
        const scroller = event.currentTarget;
        const frameRect = frameWrapRef.current?.getBoundingClientRect();
        if (!frameRect?.width || !frameRect.height) return;
        const stageRect = scroller.getBoundingClientRect();
        viewCenterRef.current = {
          x: Math.max(0, Math.min(1, (stageRect.left + scroller.clientWidth / 2 - frameRect.left) / frameRect.width)),
          y: Math.max(0, Math.min(1, (stageRect.top + scroller.clientHeight / 2 - frameRect.top) / frameRect.height)),
        };
      }}
    >
      <div className="bb-page-area">
        <div
          ref={frameWrapRef}
          style={{ width: renderedWidth, height: renderedHeight }}
        >
          <img
            ref={setImgEl}
            className={`bb-frame-img ${canSendInput ? 'bb-frame-img--live' : ''}`}
            src={`data:${liveFrame.mimeType};base64,${liveFrame.data}`}
            alt={
              pageTitle
                ? t(`当前网页画面：${pageTitle}`, `Live browser page: ${pageTitle}`)
                : t('Bot 浏览器实时画面', 'Live Bot browser page')
            }
            draggable={false}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(ev) => {
              if (canSendInput) ev.preventDefault();
            }}
            onDragStart={(ev) => ev.preventDefault()}
          />
        </div>
      </div>
    </div>
  );
}
