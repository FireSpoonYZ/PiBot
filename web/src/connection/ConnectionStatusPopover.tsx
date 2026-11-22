import { RefreshCw, Settings, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from '../components/ui';
import {
  getViewportSafeBounds,
  useTopLayerClose,
  useViewportInsetEffect,
} from '../components/ui/Overlay';
import { humanizeError, useText } from '../ui';
import type { ConnectionPhase } from './connectionPhase';
import { useConnectionPhaseContext } from './ConnectionPhaseContext';
import './connection-status.css';

export interface ConnectionStatusPopoverProps {
  /** Explicit phase override (e.g. Desktop App.tsx); falls back to `useConnectionPhaseContext().phase`. */
  phase?: ConnectionPhase;
  /** Optional explicit failure reason / detail; falls back to `context.centerError ?? context.detail`. */
  reason?: string | null;
  /** Optional center or host endpoint label shown inside the popover. */
  endpointLabel?: string | null;
  /** Optional custom concise label for the pill trigger. */
  label?: string;
  /** Keep hidden (completely quiet) when `phase === 'online'` unless true. */
  showWhenOnline?: boolean;
  /** Retry connection callback; when provided renders a Retry button in the popover. */
  onRetry?: () => void | Promise<unknown>;
  /** External retrying state indicator. */
  retrying?: boolean;
  /** Open connection settings callback; falls back to `useConnectionPhaseContext().onOpenSettings`. */
  onOpenSettings?: () => void;
  /** Render a tighter trigger pill for dense headers. */
  compact?: boolean;
  /** Horizontal alignment of the popover relative to the trigger pill. */
  align?: 'start' | 'end';
  /** Vertical placement of the popover relative to the trigger pill. */
  side?: 'top' | 'bottom';
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

const VIEWPORT_MARGIN = 10;
const POPOVER_GAP = 8;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    ref.current = value;
  }
}

export function ConnectionStatusPopover({
  phase: phaseProp,
  reason: reasonProp,
  endpointLabel,
  label: labelProp,
  showWhenOnline = false,
  onRetry,
  retrying = false,
  onOpenSettings,
  compact = false,
  align = 'end',
  side = 'bottom',
  className = '',
  ref,
}: ConnectionStatusPopoverProps) {
  const t = useText();
  const ctx = useConnectionPhaseContext();
  const popoverId = useId();
  const titleId = useId();
  const descId = useId();

  const resolvedPhase: ConnectionPhase = phaseProp ?? ctx.phase;
  const resolvedReason = reasonProp !== undefined ? reasonProp : (ctx.centerError || ctx.detail || null);
  const resolvedOpenSettings = onOpenSettings ?? ctx.onOpenSettings;

  const [open, setOpen] = useState(false);
  const [busyRetry, setBusyRetry] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const setTriggerNode = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, []);

  // Automatically dismiss popover if status recovers to quiet online mode.
  useEffect(() => {
    if (resolvedPhase === 'online' && !showWhenOnline && open) {
      setOpen(false);
    }
  }, [resolvedPhase, showWhenOnline, open]);

  const computePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const popoverEl = popoverRef.current;
    if (!triggerEl || !popoverEl || typeof window === 'undefined') return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bounds = getViewportSafeBounds(VIEWPORT_MARGIN);

    const spaceBelow = vh - bounds.bottom - triggerRect.bottom;
    const spaceAbove = triggerRect.top - bounds.top;

    let resolvedSide: 'top' | 'bottom' = side;
    if (side === 'bottom' && popoverRect.height + POPOVER_GAP > spaceBelow && spaceAbove > spaceBelow) {
      resolvedSide = 'top';
    } else if (side === 'top' && popoverRect.height + POPOVER_GAP > spaceAbove && spaceBelow > spaceAbove) {
      resolvedSide = 'bottom';
    }

    const maxHeight = Math.max(140, bounds.height - POPOVER_GAP);
    const renderedHeight = Math.min(popoverRect.height, maxHeight);
    const rawTop =
      resolvedSide === 'bottom'
        ? triggerRect.bottom + POPOVER_GAP
        : triggerRect.top - POPOVER_GAP - renderedHeight;
    const maxTop = Math.max(bounds.top, vh - bounds.bottom - renderedHeight);
    const clampedTop = Math.min(Math.max(bounds.top, rawTop), maxTop);

    const rawLeft =
      align === 'end'
        ? triggerRect.right - popoverRect.width
        : triggerRect.left;
    const maxLeft = Math.max(bounds.left, vw - bounds.right - popoverRect.width);
    const clampedLeft = Math.min(Math.max(bounds.left, rawLeft), maxLeft);

    const originY = resolvedSide === 'bottom' ? 'top' : 'bottom';
    const originX = align === 'end' ? 'right' : 'left';

    setPopoverStyle({
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
    const rafId = requestAnimationFrame(() => {
      computePosition();
      popoverRef.current?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [open, computePosition]);

  useTopLayerClose(open, {
    kind: 'floating',
    getElement: () => popoverRef.current,
    onClose: () => close(true),
  });

  useViewportInsetEffect(computePosition, open);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      close(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, close]);

  const handlePopoverKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    },
    [close],
  );

  const handleRetry = useCallback(async () => {
    if (!onRetry || busyRetry || retrying) return;
    setBusyRetry(true);
    try {
      await onRetry();
    } finally {
      setBusyRetry(false);
    }
  }, [onRetry, busyRetry, retrying]);

  const handleOpenSettings = useCallback(() => {
    close(false);
    resolvedOpenSettings?.();
  }, [close, resolvedOpenSettings]);

  if (resolvedPhase === 'online' && !showWhenOnline) {
    return null;
  }

  const pillLabel =
    labelProp ??
    (resolvedPhase === 'online'
      ? t('已连接', 'Connected')
      : resolvedPhase === 'connecting'
        ? t('连接中', 'Connecting')
        : resolvedPhase === 'error'
          ? t('连接异常', 'Connection issue')
          : t('已离线', 'Offline'));

  const dialogTitle =
    resolvedPhase === 'online'
      ? t('连接正常', 'Connected')
      : resolvedPhase === 'connecting'
        ? t('正在连接中心…', 'Connecting to center…')
        : resolvedPhase === 'error'
          ? t('连接出现异常', 'Connection issue')
          : t('当前处于离线状态', 'Currently offline');

  const parsedReason = resolvedReason ? humanizeError(resolvedReason, t) : null;
  const fallbackDescription =
    resolvedPhase === 'online'
      ? t('与中心的实时连接正常运行。', 'Real-time connection to the center is healthy.')
      : resolvedPhase === 'connecting'
        ? t('正在尝试重新建立与中心的连接，请稍候。', 'Attempting to re-establish connection to the center.')
        : resolvedPhase === 'error'
          ? t('无法完成连接，可重试或检查连接设置。', 'Unable to connect. Retry or review connection settings.')
          : t('暂未连接到中心，本机可用功能不受影响。', 'Not connected to the center. Local features remain available.');

  const reasonHeadline = parsedReason?.title || fallbackDescription;
  const reasonSecondary = parsedReason?.description;
  const isRetrying = retrying || busyRetry;
  const showRetryButton = Boolean(onRetry && resolvedPhase !== 'online');
  const showSettingsButton = Boolean(resolvedOpenSettings);

  const triggerCls = [
    'conn-status-pill',
    `is-${resolvedPhase}`,
    compact ? 'is-compact' : '',
    open ? 'is-open' : '',
    className,
  ].filter(Boolean).join(' ');

  const portalTarget = typeof document !== 'undefined' ? document.body : null;

  return (
    <>
      <button
        ref={setTriggerNode}
        type="button"
        className={triggerCls}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`${pillLabel} · ${t('查看连接详情', 'Inspect connection status')}`}
        onClick={() => setOpen(prev => !prev)}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
        }}
      >
        <span className={`conn-status-dot is-${resolvedPhase}`} aria-hidden="true" />
        <span className="conn-status-label">{pillLabel}</span>
      </button>

      {open && portalTarget
        ? createPortal(
            <div
              ref={popoverRef}
              id={popoverId}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              aria-describedby={descId}
              tabIndex={-1}
              data-ui-dialog="open"
              data-floating-ui="true"
              className={`conn-status-popover is-${resolvedPhase}`}
              style={popoverStyle}
              onKeyDown={handlePopoverKeyDown}
            >
              <header className="conn-status-popover-head">
                <span className="conn-status-popover-title-wrap">
                  <span className={`conn-status-dot is-${resolvedPhase}`} aria-hidden="true" />
                  <h3 id={titleId} className="conn-status-popover-title">
                    {dialogTitle}
                  </h3>
                </span>
                <IconButton
                  label={t('关闭', 'Close')}
                  size="sm"
                  onClick={() => close(true)}
                >
                  <X aria-hidden="true" />
                </IconButton>
              </header>

              {endpointLabel ? (
                <div className="conn-status-popover-endpoint">{endpointLabel}</div>
              ) : null}

              <div id={descId} className="conn-status-popover-body">
                <p className="conn-status-popover-reason">{reasonHeadline}</p>
                {reasonSecondary ? (
                  <p className="conn-status-popover-sub">{reasonSecondary}</p>
                ) : null}
              </div>

              {showRetryButton || showSettingsButton ? (
                <footer className="conn-status-popover-actions">
                  {showRetryButton ? (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={isRetrying}
                      leadingIcon={<RefreshCw aria-hidden="true" />}
                      onClick={() => {
                        void handleRetry();
                      }}
                    >
                      {t('重试', 'Retry')}
                    </Button>
                  ) : null}
                  {showSettingsButton ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={<Settings aria-hidden="true" />}
                      onClick={handleOpenSettings}
                    >
                      {t('连接设置', 'Connection settings')}
                    </Button>
                  ) : null}
                </footer>
              ) : null}
            </div>,
            portalTarget,
          )
        : null}
    </>
  );
}
