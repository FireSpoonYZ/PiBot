import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Info,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useText } from '../ui';
import { useTopLayerClose } from '../components/ui/Overlay';
import './notice-layer.css';

export type NoticeTone = 'info' | 'warning' | 'error' | 'success';

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface NoticeInput {
  id: string;
  tone: NoticeTone;
  title: string;
  detail?: string;
  action?: NoticeAction;
  sticky?: boolean;
  durationMs?: number;
}

export interface NoticeContextValue {
  notify: (notice: NoticeInput) => void;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

export interface NoticeProviderProps {
  children: ReactNode;
  /** Automatically mount `<NoticeLayer />` inside the provider. Defaults to `true`. */
  mountLayer?: boolean;
  /** Optional portal target when `mountLayer` is enabled (defaults to `document.body`). */
  portalContainer?: Element | null;
}

export interface NoticeLayerProps {
  /** Optional portal target (defaults to `document.body`). */
  portalContainer?: Element | null;
  /** Optional extra class name on the fixed overlay container. */
  className?: string;
}

export const MAX_VISIBLE_NOTICES = 2;
export const DEFAULT_NOTICE_DURATION_MS = 4500;
export const DEFAULT_ERROR_DURATION_MS = 6000;

const EXIT_ANIMATION_MS = 160;
const MIN_RESUME_DURATION_MS = 800;

interface NoticeRecord {
  id: string;
  tone: NoticeTone;
  title: string;
  detail?: string;
  action?: NoticeAction;
  sticky: boolean;
  durationMs?: number;
  updatedSeq: number;
  exiting: boolean;
}

interface AutoDismissTimerEntry {
  timeoutId: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
}

interface NoticeInternalState {
  notices: readonly NoticeRecord[];
  dismiss: (id: string) => void;
  pauseAutoDismiss: (id: string, reason: string) => void;
  resumeAutoDismiss: (id: string, reason: string) => void;
}

const NOOP = () => {};

const NOOP_NOTICE_CONTEXT: NoticeContextValue = Object.freeze({
  notify: NOOP,
  dismiss: NOOP,
  dismissAll: NOOP,
});

const NoticeContext = createContext<NoticeContextValue>(NOOP_NOTICE_CONTEXT);
const NoticeInternalContext = createContext<NoticeInternalState | null>(null);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function resolveDurationMs(notice: Pick<NoticeInput, 'tone' | 'sticky' | 'durationMs'>): number | null {
  if (notice.sticky) return null;
  if (typeof notice.durationMs === 'number') {
    if (!Number.isFinite(notice.durationMs) || notice.durationMs <= 0) return null;
    return notice.durationMs;
  }
  return notice.tone === 'error' ? DEFAULT_ERROR_DURATION_MS : DEFAULT_NOTICE_DURATION_MS;
}

function normalizeDetail(detail: string | undefined): string | undefined {
  if (typeof detail !== 'string') return undefined;
  const trimmed = detail.trim();
  return trimmed.length > 0 ? detail : undefined;
}

/**
 * Selects a single notice index to evict when adding a new notice would exceed
 * `MAX_VISIBLE_NOTICES`.
 *
 * Eviction priority:
 * 1. Any notice already in `exiting` state (oldest `updatedSeq` first).
 * 2. Oldest non-sticky active notice (lowest `updatedSeq`).
 * 3. If all active notices are sticky, oldest active notice (lowest `updatedSeq`)
 *    so the newly arriving notice is always visible.
 */
function pickEvictionIndex(list: readonly NoticeRecord[]): number {
  let candidate = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].exiting) continue;
    if (candidate === -1 || list[i].updatedSeq < list[candidate].updatedSeq) {
      candidate = i;
    }
  }
  if (candidate !== -1) return candidate;

  for (let i = 0; i < list.length; i += 1) {
    if (list[i].sticky) continue;
    if (candidate === -1 || list[i].updatedSeq < list[candidate].updatedSeq) {
      candidate = i;
    }
  }
  if (candidate !== -1) return candidate;

  for (let i = 0; i < list.length; i += 1) {
    if (candidate === -1 || list[i].updatedSeq < list[candidate].updatedSeq) {
      candidate = i;
    }
  }
  return candidate;
}

export function NoticeProvider({
  children,
  mountLayer = true,
  portalContainer,
}: NoticeProviderProps) {
  const [notices, setNotices] = useState<NoticeRecord[]>([]);
  const noticesRef = useRef<NoticeRecord[]>([]);
  const seqRef = useRef(0);
  const autoTimersRef = useRef<Map<string, AutoDismissTimerEntry>>(new Map());
  const pauseReasonsRef = useRef<Map<string, Set<string>>>(new Map());
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearAutoTimer = useCallback((id: string) => {
    const entry = autoTimersRef.current.get(id);
    if (!entry) return;
    if (entry.timeoutId !== null) {
      clearTimeout(entry.timeoutId);
    }
    autoTimersRef.current.delete(id);
  }, []);

  const clearExitTimer = useCallback((id: string) => {
    const timeoutId = exitTimersRef.current.get(id);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      exitTimersRef.current.delete(id);
    }
  }, []);

  const removeNoticeNow = useCallback(
    (id: string) => {
      clearAutoTimer(id);
      clearExitTimer(id);
      pauseReasonsRef.current.delete(id);
      const prev = noticesRef.current;
      if (!prev.some(item => item.id === id)) return;
      const next = prev.filter(item => item.id !== id);
      noticesRef.current = next;
      setNotices(next);
    },
    [clearAutoTimer, clearExitTimer],
  );

  const dismiss = useCallback(
    (id: string) => {
      if (!id) return;
      const prev = noticesRef.current;
      const index = prev.findIndex(item => item.id === id);
      if (index === -1) return;

      clearAutoTimer(id);

      if (prefersReducedMotion()) {
        removeNoticeNow(id);
        return;
      }

      if (prev[index].exiting) return;

      const next = prev.slice();
      next[index] = { ...prev[index], exiting: true };
      noticesRef.current = next;
      setNotices(next);

      clearExitTimer(id);
      const timeoutId = setTimeout(() => {
        exitTimersRef.current.delete(id);
        removeNoticeNow(id);
      }, EXIT_ANIMATION_MS);
      exitTimersRef.current.set(id, timeoutId);
    },
    [clearAutoTimer, clearExitTimer, removeNoticeNow],
  );

  const scheduleAutoTimer = useCallback(
    (id: string, durationMs: number | null) => {
      const existing = autoTimersRef.current.get(id);
      if (existing && existing.timeoutId !== null) {
        clearTimeout(existing.timeoutId);
        existing.timeoutId = null;
      }

      if (durationMs === null) {
        autoTimersRef.current.delete(id);
        return;
      }

      const isPaused = (pauseReasonsRef.current.get(id)?.size ?? 0) > 0;
      const entry: AutoDismissTimerEntry = {
        timeoutId: null,
        remainingMs: durationMs,
        startedAt: Date.now(),
      };
      if (!isPaused) {
        entry.timeoutId = setTimeout(() => {
          autoTimersRef.current.delete(id);
          dismiss(id);
        }, durationMs);
      }
      autoTimersRef.current.set(id, entry);
    },
    [dismiss],
  );

  const pauseAutoDismiss = useCallback((id: string, reason: string) => {
    let reasons = pauseReasonsRef.current.get(id);
    if (!reasons) {
      reasons = new Set<string>();
      pauseReasonsRef.current.set(id, reasons);
    }
    const wasPaused = reasons.size > 0;
    reasons.add(reason);

    const entry = autoTimersRef.current.get(id);
    if (!entry || wasPaused || entry.timeoutId === null) return;
    clearTimeout(entry.timeoutId);
    entry.timeoutId = null;
    const elapsed = Math.max(0, Date.now() - entry.startedAt);
    entry.remainingMs = Math.max(entry.remainingMs - elapsed, MIN_RESUME_DURATION_MS);
  }, []);

  const resumeAutoDismiss = useCallback(
    (id: string, reason: string) => {
      const reasons = pauseReasonsRef.current.get(id);
      if (reasons) {
        reasons.delete(reason);
        if (reasons.size === 0) {
          pauseReasonsRef.current.delete(id);
        } else {
          return;
        }
      }
      const entry = autoTimersRef.current.get(id);
      if (!entry || entry.timeoutId !== null) return;
      entry.startedAt = Date.now();
      entry.timeoutId = setTimeout(() => {
        autoTimersRef.current.delete(id);
        dismiss(id);
      }, entry.remainingMs);
    },
    [dismiss],
  );

  const notify = useCallback(
    (input: NoticeInput) => {
      if (!input || !input.id) return;
      const id = input.id;
      const nextSeq = ++seqRef.current;
      const normalizedDetail = normalizeDetail(input.detail);
      const sticky = Boolean(input.sticky);
      const durationMs = resolveDurationMs({
        tone: input.tone,
        sticky,
        durationMs: input.durationMs,
      });

      const prev = noticesRef.current;
      const existingIndex = prev.findIndex(item => item.id === id);

      if (existingIndex !== -1) {
        // Update in place: preserve array position, React key, and DOM node.
        clearExitTimer(id);
        const next = prev.slice();
        next[existingIndex] = {
          id,
          tone: input.tone,
          title: input.title,
          detail: normalizedDetail,
          action: input.action,
          sticky,
          durationMs: input.durationMs,
          updatedSeq: nextSeq,
          exiting: false,
        };
        noticesRef.current = next;
        setNotices(next);
        scheduleAutoTimer(id, durationMs);
        return;
      }

      const next = prev.slice();
      const evictedIds: string[] = [];
      while (next.length >= MAX_VISIBLE_NOTICES) {
        const evictIndex = pickEvictionIndex(next);
        if (evictIndex === -1) break;
        const [evicted] = next.splice(evictIndex, 1);
        if (evicted) evictedIds.push(evicted.id);
      }

      next.push({
        id,
        tone: input.tone,
        title: input.title,
        detail: normalizedDetail,
        action: input.action,
        sticky,
        durationMs: input.durationMs,
        updatedSeq: nextSeq,
        exiting: false,
      });

      for (const evictedId of evictedIds) {
        clearAutoTimer(evictedId);
        clearExitTimer(evictedId);
        pauseReasonsRef.current.delete(evictedId);
      }

      noticesRef.current = next;
      setNotices(next);
      scheduleAutoTimer(id, durationMs);
    },
    [clearAutoTimer, clearExitTimer, scheduleAutoTimer],
  );

  const dismissAll = useCallback(() => {
    const prev = noticesRef.current;
    if (prev.length === 0) return;

    for (const item of prev) {
      clearAutoTimer(item.id);
    }

    if (prefersReducedMotion()) {
      for (const item of prev) {
        clearExitTimer(item.id);
        pauseReasonsRef.current.delete(item.id);
      }
      noticesRef.current = [];
      setNotices([]);
      return;
    }

    const next = prev.map(item => (item.exiting ? item : { ...item, exiting: true }));
    noticesRef.current = next;
    setNotices(next);

    for (const item of prev) {
      if (exitTimersRef.current.has(item.id)) continue;
      const id = item.id;
      const timeoutId = setTimeout(() => {
        exitTimersRef.current.delete(id);
        removeNoticeNow(id);
      }, EXIT_ANIMATION_MS);
      exitTimersRef.current.set(id, timeoutId);
    }
  }, [clearAutoTimer, clearExitTimer, removeNoticeNow]);

  useEffect(() => {
    const autoTimers = autoTimersRef.current;
    const exitTimers = exitTimersRef.current;
    const pauseReasons = pauseReasonsRef.current;
    return () => {
      for (const entry of autoTimers.values()) {
        if (entry.timeoutId !== null) clearTimeout(entry.timeoutId);
      }
      autoTimers.clear();
      for (const timeoutId of exitTimers.values()) {
        clearTimeout(timeoutId);
      }
      exitTimers.clear();
      pauseReasons.clear();
    };
  }, []);

  const contextValue = useMemo<NoticeContextValue>(
    () => ({ notify, dismiss, dismissAll }),
    [notify, dismiss, dismissAll],
  );

  const internalValue = useMemo<NoticeInternalState>(
    () => ({ notices, dismiss, pauseAutoDismiss, resumeAutoDismiss }),
    [notices, dismiss, pauseAutoDismiss, resumeAutoDismiss],
  );

  return (
    <NoticeContext.Provider value={contextValue}>
      <NoticeInternalContext.Provider value={internalValue}>
        {children}
        {mountLayer ? <NoticeLayer portalContainer={portalContainer} /> : null}
      </NoticeInternalContext.Provider>
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeContextValue {
  return useContext(NoticeContext);
}

function NoticeIcon({ tone }: { tone: NoticeTone }) {
  if (tone === 'success') return <CheckCircle2 size={15} aria-hidden="true" />;
  if (tone === 'warning') return <TriangleAlert size={15} aria-hidden="true" />;
  if (tone === 'error') return <CircleAlert size={15} aria-hidden="true" />;
  return <Info size={15} aria-hidden="true" />;
}

interface NoticeCardProps {
  notice: NoticeRecord;
  onDismiss: (id: string) => void;
  onPause: (id: string, reason: string) => void;
  onResume: (id: string, reason: string) => void;
}

function NoticeCard({ notice, onDismiss, onPause, onResume }: NoticeCardProps) {
  const t = useText();
  const detailId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [detailExpanded, setDetailExpanded] = useState(false);

  const hasDetail = Boolean(notice.detail);
  const showDetail = hasDetail && detailExpanded;

  useTopLayerClose(!notice.exiting, {
    kind: 'toast',
    getElement: () => cardRef.current,
    canHandleEscape: () => Boolean(cardRef.current?.contains(document.activeElement)),
    canHandleBack: () => false,
    onClose: () => onDismiss(notice.id),
  });

  useEffect(() => {
    if (showDetail) {
      onPause(notice.id, 'detail');
      return () => {
        onResume(notice.id, 'detail');
      };
    }
    return undefined;
  }, [notice.id, onPause, onResume, showDetail]);

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        onPause(notice.id, 'hover');
      }
    },
    [notice.id, onPause],
  );

  const handlePointerLeave = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        onResume(notice.id, 'hover');
      }
    },
    [notice.id, onResume],
  );

  const handleFocus = useCallback(() => {
    onPause(notice.id, 'focus');
  }, [notice.id, onPause]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && event.currentTarget.contains(nextTarget)) {
        return;
      }
      onResume(notice.id, 'focus');
    },
    [notice.id, onResume],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss(notice.id);
      }
    },
    [notice.id, onDismiss],
  );

  const isCritical = notice.tone === 'error';

  return (
    <div
      ref={cardRef}
      className={`notice-layer-card is-${notice.tone}${notice.exiting ? ' is-exiting' : ''}`}
      role={isCritical ? 'alert' : 'status'}
      aria-live={isCritical ? 'assertive' : 'polite'}
      aria-atomic="true"
      tabIndex={-1}
      data-floating-ui="true"
      data-notice-id={notice.id}
      data-notice-tone={notice.tone}
      data-notice-sticky={notice.sticky ? 'true' : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <div className="notice-layer-row">
        <span className="notice-layer-icon" aria-hidden="true">
          <NoticeIcon tone={notice.tone} />
        </span>

        <div className="notice-layer-content">
          <div className="notice-layer-title">{notice.title}</div>
          {hasDetail ? (
            <button
              type="button"
              className="notice-layer-detail-toggle"
              aria-expanded={showDetail}
              aria-controls={detailId}
              onClick={() => setDetailExpanded(prev => !prev)}
            >
              <span>{showDetail ? t('收起详情', 'Hide details') : t('查看详情', 'Details')}</span>
              {showDetail ? (
                <ChevronUp size={13} aria-hidden="true" />
              ) : (
                <ChevronDown size={13} aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>

        <div className="notice-layer-actions">
          {notice.action ? (
            <button
              type="button"
              className="notice-layer-action"
              onClick={notice.action.onClick}
            >
              {notice.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="notice-layer-dismiss"
            aria-label={t('关闭提示', 'Dismiss')}
            onClick={() => onDismiss(notice.id)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {showDetail ? (
        <pre id={detailId} className="notice-layer-detail-code">
          {notice.detail}
        </pre>
      ) : null}
    </div>
  );
}

export function NoticeLayer({ portalContainer, className }: NoticeLayerProps = {}) {
  const internal = useContext(NoticeInternalContext);
  const t = useText();

  if (!internal) return null;

  const target =
    portalContainer !== undefined
      ? portalContainer
      : typeof document !== 'undefined'
        ? document.body
        : null;
  if (!target) return null;

  const rootClassName = className ? `notice-layer-root ${className}` : 'notice-layer-root';

  return createPortal(
    <div className={rootClassName} role="region" aria-label={t('通知', 'Notifications')}>
      {internal.notices.map(notice => (
        <NoticeCard
          key={notice.id}
          notice={notice}
          onDismiss={internal.dismiss}
          onPause={internal.pauseAutoDismiss}
          onResume={internal.resumeAutoDismiss}
        />
      ))}
    </div>,
    target,
  );
}
