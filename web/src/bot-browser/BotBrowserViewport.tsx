import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Globe,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Shield,
} from 'lucide-react';
import { useText } from '../ui';
import {
  activeTabOf,
  classifyPageUrl,
  mapClientPointToNormalized,
  mapKeyboardEventKey,
  normalizeWheelDelta,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserView,
} from './protocol';

export interface BotBrowserViewportProps {
  connected: boolean;
  visible: boolean;
  view: BrowserView | null;
  liveFrame: BrowserFrame | null;
  loadingStatus: boolean;
  streamDegraded: boolean;
  frameRedacted: boolean;
  frameRedactedReason: string | null;
  isHolder: boolean;
  canSendInput: boolean;
  isSensitive: boolean;
  signInTakeoverAction?: ReactNode;
  zoom: number;
  hostLabel?: string;
  onZoomChange: (nextZoom: number) => void;
  onInput: (event: BrowserInputEvent) => void;
  onRetry: () => void;
  onOpenTab?: () => void;
  onRequestExternalGuide: () => void;
  onExitStageFocus?: () => void;
}

interface TapRipple {
  id: number;
  xPct: number;
  yPct: number;
}

const TAP_MOVE_THRESHOLD_PX = 10;
const MIN_ZOOM = 1;
const MAX_ZOOM = 2.5;

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_ZOOM;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 100) / 100;
}

export function BotBrowserViewport({
  connected,
  visible,
  view,
  liveFrame,
  loadingStatus,
  streamDegraded,
  frameRedacted,
  frameRedactedReason,
  isHolder,
  canSendInput,
  isSensitive,
  signInTakeoverAction,
  zoom,
  hostLabel,
  onZoomChange,
  onInput,
  onRetry,
  onOpenTab,
  onRequestExternalGuide,
  onExitStageFocus,
}: BotBrowserViewportProps) {
  const t = useText();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [ripple, setRipple] = useState<TapRipple | null>(null);
  const rippleTimerRef = useRef<number | null>(null);
  const rippleSeqRef = useRef(0);

  const pointerStartRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    button: number;
  } | null>(null);
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startZoom: number } | null>(null);
  const suppressNextClickRef = useRef(false);

  const wheelPendingRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const wheelRafRef = useRef<number | null>(null);

  const canSendInputRef = useRef(canSendInput);
  canSendInputRef.current = canSendInput;
  const liveFrameRef = useRef(liveFrame);
  liveFrameRef.current = liveFrame;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  useEffect(() => {
    return () => {
      if (rippleTimerRef.current !== null) window.clearTimeout(rippleTimerRef.current);
      if (wheelRafRef.current !== null) window.cancelAnimationFrame(wheelRafRef.current);
    };
  }, []);

  const showRipple = useCallback((xPct: number, yPct: number) => {
    const id = ++rippleSeqRef.current;
    setRipple({ id, xPct, yPct });
    if (rippleTimerRef.current !== null) window.clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = window.setTimeout(() => {
      setRipple((curr) => (curr && curr.id === id ? null : curr));
    }, 360);
  }, []);

  // Non-passive wheel forwarding: accurately projects cursor position and coalesces trackpad deltas.
  useEffect(() => {
    const el = imgEl;
    if (!el) return;

    const flushWheel = () => {
      wheelRafRef.current = null;
      const pending = wheelPendingRef.current;
      wheelPendingRef.current = null;
      if (!pending || !canSendInputRef.current) return;
      if (pending.dx === 0 && pending.dy === 0) return;
      onInputRef.current({
        kind: 'wheel',
        x: pending.x,
        y: pending.y,
        deltaX: pending.dx,
        deltaY: pending.dy,
      });
    };

    const onWheel = (ev: WheelEvent) => {
      if (!canSendInputRef.current) return;
      const frame = liveFrameRef.current;
      if (!frame) return;
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
      const normalized = normalizeWheelDelta(ev.deltaX, ev.deltaY, ev.deltaMode);
      if (normalized.deltaX === 0 && normalized.deltaY === 0) return;

      const prev = wheelPendingRef.current;
      if (prev) {
        prev.x = point.x;
        prev.y = point.y;
        prev.dx = Math.max(-600, Math.min(600, prev.dx + normalized.deltaX));
        prev.dy = Math.max(-600, Math.min(600, prev.dy + normalized.deltaY));
      } else {
        wheelPendingRef.current = {
          x: point.x,
          y: point.y,
          dx: normalized.deltaX,
          dy: normalized.deltaY,
        };
      }

      if (wheelRafRef.current === null) {
        wheelRafRef.current = window.requestAnimationFrame(flushWheel);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (wheelRafRef.current !== null) {
        window.cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
      wheelPendingRef.current = null;
    };
  }, [imgEl]);

  const handlePointerDown = (ev: PointerEvent<HTMLImageElement>) => {
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

    if (!canSendInput) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;

    pointerStartRef.current = {
      pointerId: ev.pointerId,
      clientX: ev.clientX,
      clientY: ev.clientY,
      button: ev.button,
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
    if (start && start.pointerId === ev.pointerId) {
      const moved = Math.hypot(ev.clientX - start.clientX, ev.clientY - start.clientY);
      if (moved > TAP_MOVE_THRESHOLD_PX) {
        pointerStartRef.current = null;
      }
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

    if (!start || start.pointerId !== ev.pointerId || !canSendInput || !imgEl || !liveFrame) {
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

    stageRef.current?.focus({ preventScroll: true });
    const wrapRect = frameWrapRef.current?.getBoundingClientRect();
    if (wrapRect && wrapRect.width > 0 && wrapRect.height > 0) {
      showRipple(
        ((ev.clientX - wrapRect.left) / wrapRect.width) * 100,
        ((ev.clientY - wrapRect.top) / wrapRect.height) * 100,
      );
    } else {
      showRipple(point.x * 100, point.y * 100);
    }
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
      stageRef.current?.blur();
      onExitStageFocus?.();
      return;
    }

    const special = mapKeyboardEventKey(ev.key);
    if (special) {
      ev.preventDefault();
      onInput({ kind: 'key', key: special });
      return;
    }

    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
      ev.preventDefault();
      onInput({ kind: 'text', text: ev.key });
    }
  };

  const currentTab = activeTabOf(view);
  const urlMeta = classifyPageUrl(currentTab?.url);
  const safeUrlSummary =
    !isSensitive && currentTab?.url ? urlMeta.displayHost || currentTab.url : '';

  // 1. Disconnected or hidden tab: never show stale frame as live.
  if (!connected || !visible) {
    return (
      <div className="bb-stage bb-stage--state" role="status" aria-live="polite">
        <div className="bb-state-card">
          <div className="bb-state-icon bb-state-icon--muted" aria-hidden="true">
            <AlertTriangle size={22} />
          </div>
          <h3 className="bb-state-title">
            {!connected
              ? t('已断开与目标设备的连接', 'Disconnected from target host')
              : t('页面已切至后台，画面轮询已暂停', 'Paused while view is hidden')}
          </h3>
          <p className="bb-state-desc">
            {!connected
              ? t('不会把旧截图冒充实时画面；若刚才处于接管中，Bot 会保持停手直到你重新确认。', 'Cached frames are cleared so stale images are never shown. If you were taking over, the Bot remains paused until you confirm.')
              : t('回到前台后将自动刷新最新页面状态。', 'Live status will refresh automatically when you return.')}
          </p>
          {connected ? null : (
            <div className="bb-state-actions">
              <button type="button" className="bb-btn bb-btn--secondary" onClick={onRetry}>
                <RefreshCw size={14} aria-hidden="true" />
                <span>{t('重新检查', 'Retry')}</span>
              </button>
              <button type="button" className="bb-btn bb-btn--ghost" onClick={onRequestExternalGuide}>
                <ExternalLink size={14} aria-hidden="true" />
                <span>{t('外部浏览器指导', 'Guide in my browser')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 2. Initial loading before first status arrives.
  if (!view && loadingStatus) {
    return (
      <div className="bb-stage bb-stage--state" role="status" aria-live="polite">
        <div className="bb-state-card">
          <div className="bb-state-icon bb-state-icon--muted" aria-hidden="true">
            <Loader2 size={22} className="bb-spin" />
          </div>
          <h3 className="bb-state-title">{t('正在连接 Bot 浏览器…', 'Connecting to Bot browser…')}</h3>
          <p className="bb-state-desc">
            {t('正在向目标 Host 读取实时浏览能力与当前标签页。', 'Checking real-time browser capability and active tabs from the target host.')}
          </p>
        </div>
      </div>
    );
  }

  // 3. Honest degradation when unavailable, non-interactable, or stream failed for >= 5s.
  if (!view || !view.available || !view.canStreamInteract || streamDegraded) {
    const reasonText = streamDegraded
      ? t('连续 5 秒未收到有效实时画面，已停止交互以避免误操作。', 'No live frame received for 5 seconds. Interaction is disabled to avoid blind clicks.')
      : view?.reason
        ? view.reason
        : !view
          ? t('暂时无法读取目标设备的浏览器状态。', 'Unable to read browser status from the target host.')
          : !view.available
            ? t('当前 Host 未提供可用的 Bot 内置浏览器环境。', 'The target host does not currently have an available Bot browser.')
            : t('当前 Host 不支持实时画面流与同页接管（例如无头模式或网络受限）。', 'This host cannot stream interactive frames right now (e.g., headless mode or restricted relay).');

    return (
      <div className="bb-stage bb-stage--state" role="region" aria-label={t('浏览器不可用说明', 'Browser unavailable details')}>
        <div className="bb-state-card">
          <div className="bb-state-icon bb-state-icon--warn" aria-hidden="true">
            <Monitor size={22} />
          </div>
          <h3 className="bb-state-title">
            {t('当前无法实时查看或接管此浏览器', 'Live browser control is unavailable')}
          </h3>
          <p className="bb-state-desc">{reasonText}</p>

          {(view?.stepText || safeUrlSummary || currentTab?.title) && !isSensitive ? (
            <div className="bb-readonly-summary">
              <div className="bb-readonly-label">
                {t('文字进度参考（只读，不可直接点击）', 'Text status only (read-only)')}
              </div>
              {view?.stepText ? <div className="bb-readonly-line">{view.stepText}</div> : null}
              {currentTab?.title ? <div className="bb-readonly-line">{currentTab.title}</div> : null}
              {safeUrlSummary ? <div className="bb-readonly-url">{safeUrlSummary}</div> : null}
            </div>
          ) : null}

          <div className="bb-state-actions">
            <button type="button" className="bb-btn bb-btn--primary" onClick={onRequestExternalGuide}>
              <ExternalLink size={14} aria-hidden="true" />
              <span>{t('改用外部系统浏览器指导', 'Guide me in my browser')}</span>
            </button>
            <button type="button" className="bb-btn bb-btn--secondary" onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />
              <span>{t('重新检查', 'Retry')}</span>
            </button>
          </div>

          {hostLabel ? (
            <p className="bb-state-footnote">
              {t(`若需保留原表单继续操作，请前往目标设备「${hostLabel}」本机处理。`, `To continue on the original form, open the browser directly on ${hostLabel}.`)}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  // 4. Privacy Shield: never render private frames to bystanders, or when Host redacted the frame.
  if ((isSensitive && !isHolder) || frameRedacted) {
    return (
      <div className="bb-stage bb-stage--state" role="status" aria-live="polite">
        <div className="bb-state-card bb-state-card--shield">
          <div className="bb-state-icon bb-state-icon--shield" aria-hidden="true">
            <Shield size={22} />
          </div>
          {signInTakeoverAction ? (
            <>
              <h3 className="bb-state-title">{t('登录 Google', 'Sign in to Google')}</h3>
              <p className="bb-state-desc">
                {t('接管后可在这里登录。Bot 会暂停操作。', 'Take over to sign in here. The Bot will pause.')}
              </p>
              <div className="bb-state-actions">{signInTakeoverAction}</div>
            </>
          ) : (
            <>
              <h3 className="bb-state-title">
                {isHolder
                  ? t('此步骤受敏感保护，Host 已停止推流', 'Protected sensitive step')
                  : t('已启用隐私遮罩', 'Privacy shield active')}
              </h3>
              <p className="bb-state-desc">
                {frameRedactedReason || view.sensitiveReason ||
                  t('实时画面受到隐私保护。', 'Live frames are protected by the privacy shield.')}
              </p>
              {view.fallbackToSystemBrowser ? (
                <div className="bb-state-actions">
                  <button type="button" className="bb-btn bb-btn--primary" onClick={onRequestExternalGuide}>
                    <ExternalLink size={14} aria-hidden="true" />
                    <span>{t('在系统浏览器中继续', 'Open in system browser')}</span>
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  // 5. Available browser with no open tabs yet.
  if (!view.pageId && view.tabs.length === 0) {
    return (
      <div className="bb-stage bb-stage--state" role="status">
        <div className="bb-state-card">
          <div className="bb-state-icon bb-state-icon--muted" aria-hidden="true">
            <Globe size={22} />
          </div>
          <h3 className="bb-state-title">{t('当前没有打开的标签页', 'No open browser tab')}</h3>
          <p className="bb-state-desc">
            {t('每个 Bot 使用独立的隔离浏览会话。打开新标签页或等待 Bot 发起浏览任务。', 'Each Bot runs in an isolated browsing session. Open a new tab or wait for the Bot to start browsing.')}
          </p>
          {onOpenTab ? (
            <div className="bb-state-actions">
              <button type="button" className="bb-btn bb-btn--primary" onClick={onOpenTab}>
                <Plus size={14} aria-hidden="true" />
                <span>{t('新建标签页', 'New tab')}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // 6. Waiting for a bounded live frame that matches the current pageId & revision.
  if (!liveFrame) {
    return (
      <div className="bb-stage bb-stage--state" role="status" aria-live="polite">
        <div className="bb-state-card">
          <div className="bb-state-icon bb-state-icon--muted" aria-hidden="true">
            <Loader2 size={22} className="bb-spin" />
          </div>
          <h3 className="bb-state-title">{t('正在获取最新实时画面…', 'Waiting for live frame…')}</h3>
          <p className="bb-state-desc">
            {t('收到与当前页面一致的实时画面后才会开放点击与输入。', 'Interaction unlocks only after a verified live frame for the current page arrives.')}
          </p>
        </div>
      </div>
    );
  }

  // 7. Live interactive (or read-only) frame stage.
  const zoomed = zoom > 1.01;
  const stageClass = [
    'bb-stage',
    canSendInput ? 'bb-stage--interactive' : 'bb-stage--readonly',
    zoomed ? 'bb-stage--zoomed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={stageRef}
      className={stageClass}
      tabIndex={canSendInput ? 0 : -1}
      role={canSendInput ? 'application' : 'region'}
      aria-label={
        canSendInput
          ? t('Bot 浏览器实时接管画布，点击或输入将发送到当前页面，按 Shift+Esc 退出画布焦点', 'Interactive Bot browser canvas. Clicks and keys go to the live page. Press Shift+Escape to leave canvas focus.')
          : t('Bot 浏览器只读实时画面', 'Read-only live view of Bot browser')
      }
      onKeyDown={handleStageKeyDown}
    >
      <div
        ref={frameWrapRef}
        className="bb-frame-wrap"
        style={
          zoomed
            ? {
                width: `${Math.round(zoom * 100)}%`,
                aspectRatio: `${liveFrame.width} / ${liveFrame.height}`,
              }
            : undefined
        }
      >
        <img
          ref={setImgEl}
          className={`bb-frame-img ${canSendInput ? 'bb-frame-img--live' : ''}`}
          src={`data:${liveFrame.mimeType};base64,${liveFrame.data}`}
          alt={
            currentTab?.title
              ? t(`当前网页画面：${currentTab.title}`, `Live browser page: ${currentTab.title}`)
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
        {ripple ? (
          <span
            key={ripple.id}
            className="bb-tap-ripple"
            style={{ left: `${ripple.xPct}%`, top: `${ripple.yPct}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
}
