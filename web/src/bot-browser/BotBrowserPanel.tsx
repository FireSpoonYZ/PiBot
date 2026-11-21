import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CompositionEvent, FormEvent, KeyboardEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerUpLeft,
  ExternalLink,
  Globe,
  Info,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Square,
  Unlock,
  X,
} from 'lucide-react';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { useText } from '../ui';
import { BotBrowserViewport } from './BotBrowserViewport';
import {
  MAX_TEXT_INPUT_LENGTH,
  POLL_INTERVAL_ACTIVE_MS,
  POLL_INTERVAL_IDLE_MS,
  POLL_INTERVAL_WATCH_MS,
  STREAM_DEGRADE_TIMEOUT_MS,
  ZOOM_STEPS,
  activeTabOf,
  buildBrowserRequest,
  canAcceptManualInput,
  classifyBrowserError,
  classifyPageUrl,
  confirmTakeoverLease,
  inspectFrameRedaction,
  isFrameUsableForView,
  normalizeNavigateUrl,
  parseBrowserFrame,
  parseBrowserView,
  reconcileLeaseWithView,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserView,
  type FrameCursor,
  type OwnedLease,
  type PendingControlAction,
} from './protocol';
import './BotBrowserPanel.css';

export type {
  BrowserControlAction,
  BrowserFrame,
  BrowserInputEvent,
  BrowserPhase,
  BrowserTab,
  BrowserView,
} from './protocol';

export interface BotBrowserPanelProps {
  botId: string;
  deviceId: string;
  request: (input: Record<string, unknown>) => Promise<any>;
  onClose?: () => void;
  botName?: string;
  hostLabel?: string;
  mode?: 'auto' | 'sidebar' | 'fullscreen';
  connected?: boolean;
  onSwitchToExternalGuide?: (url?: string) => void;
  onCancelTask?: () => void | Promise<void>;
  className?: string;
}

const MOBILE_MEDIA_QUERY = '(max-width: 860px)';
const FALLBACK_EXTERNAL_URL = 'https://console.cloud.google.com/';

function readIsMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function readDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function extractRawLease(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.lease === 'string' && obj.lease.trim()) return obj.lease.trim();
  const result = obj.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const inner = result as Record<string, unknown>;
    if (typeof inner.lease === 'string' && inner.lease.trim()) return inner.lease.trim();
  }
  return null;
}

export function BotBrowserPanel({
  botId,
  deviceId,
  request,
  onClose,
  botName,
  hostLabel,
  mode = 'auto',
  connected = true,
  onSwitchToExternalGuide,
  onCancelTask,
  className,
}: BotBrowserPanelProps) {
  const t = useText();

  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(readIsMobileViewport);
  const [pageVisible, setPageVisible] = useState<boolean>(readDocumentVisible);
  const [desktopExpanded, setDesktopExpanded] = useState(false);

  const [view, setView] = useState<BrowserView | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [ownedLease, setOwnedLease] = useState<OwnedLease | null>(null);
  const [isHolder, setIsHolder] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingControlAction>(null);

  const [loadingStatus, setLoadingStatus] = useState(true);
  const [streamDegraded, setStreamDegraded] = useState(false);
  const [frameRedacted, setFrameRedacted] = useState(false);
  const [frameRedactedReason, setFrameRedactedReason] = useState<string | null>(null);

  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
  const [preemptConfirmOpen, setPreemptConfirmOpen] = useState(false);
  const [externalConfirmOpen, setExternalConfirmOpen] = useState(false);

  const [urlDraft, setUrlDraft] = useState('');
  const [urlEditing, setUrlEditing] = useState(false);
  const [zoom, setZoom] = useState(1);

  const panelRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const remoteInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);

  const epochRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const inFlightPollRef = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;

  const viewRef = useRef<BrowserView | null>(null);
  viewRef.current = view;
  const frameRef = useRef<BrowserFrame | null>(null);
  frameRef.current = frame;
  const ownedLeaseRef = useRef<OwnedLease | null>(null);
  ownedLeaseRef.current = ownedLease;
  const isHolderRef = useRef(false);
  isHolderRef.current = isHolder;
  const pendingActionRef = useRef<PendingControlAction>(null);
  pendingActionRef.current = pendingAction;
  const pendingTakeoverLeaseRef = useRef<string | null>(null);
  const lastFrameCursorRef = useRef<FrameCursor | null>(null);
  const streamFailSinceRef = useRef<number | null>(null);
  const streamDegradedRef = useRef(false);
  streamDegradedRef.current = streamDegraded;
  const urlEditingRef = useRef(false);
  urlEditingRef.current = urlEditing;

  const resolvedMode: 'sidebar' | 'fullscreen' =
    mode === 'auto'
      ? isMobileViewport
        ? 'fullscreen'
        : desktopExpanded
          ? 'fullscreen'
          : 'sidebar'
      : mode;

  // Responsive breakpoint listener — switches presentation only, preserves session/tab/lease.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => setIsMobileViewport(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Page visibility tracking — stops polling and clears cached frames when backgrounded.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    onVisibilityChange();
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Accessibility focus management when entering mobile fullscreen dialog.
  useEffect(() => {
    if (resolvedMode !== 'fullscreen' || typeof document === 'undefined') return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      if (closeBtnRef.current) {
        closeBtnRef.current.focus({ preventScroll: true });
      } else {
        panelRef.current?.focus({ preventScroll: true });
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (previousFocus && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [resolvedMode]);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearCachedFrame = useCallback(() => {
    setFrame(null);
    lastFrameCursorRef.current = null;
  }, []);

  const clearLocalLease = useCallback(() => {
    ownedLeaseRef.current = null;
    pendingTakeoverLeaseRef.current = null;
    isHolderRef.current = false;
    setOwnedLease(null);
    setIsHolder(false);
  }, []);

  const applyViewState = useCallback(
    (nextView: BrowserView): { nextLease: OwnedLease | null; nextIsHolder: boolean } => {
      const prevView = viewRef.current;
      let nextLease: OwnedLease | null = null;
      let nextIsHolder = false;
      let preemptedBy: string | null = null;

      // If we requested takeover while Host was draining ('taking'), confirm once Host reaches 'human'.
      if (
        !ownedLeaseRef.current &&
        pendingTakeoverLeaseRef.current &&
        nextView.phase === 'human'
      ) {
        const confirmed = confirmTakeoverLease(nextView, pendingTakeoverLeaseRef.current);
        if (confirmed) {
          ownedLeaseRef.current = confirmed;
          pendingTakeoverLeaseRef.current = null;
          setOwnedLease(confirmed);
          setIsHolder(true);
          isHolderRef.current = true;
          nextLease = confirmed;
          nextIsHolder = true;
          setNoticeBanner(t('已接管当前页面 · Bot 已完全停手', 'You have control · Bot is paused'));
        }
      }

      if (!nextIsHolder) {
        const reconciled = reconcileLeaseWithView(ownedLeaseRef.current, nextView);
        nextLease = reconciled.nextLease;
        nextIsHolder = reconciled.isHolder;
        preemptedBy = reconciled.preemptedBy;

        ownedLeaseRef.current = nextLease;
        isHolderRef.current = nextIsHolder;
        setOwnedLease(nextLease);
        setIsHolder(nextIsHolder);

        if (nextView.phase !== 'taking') {
          pendingTakeoverLeaseRef.current = null;
        }
      }

      if (preemptedBy) {
        setPreemptConfirmOpen(false);
        setNoticeBanner(
          t(`控制权已转移至「${preemptedBy}」，当前视图已转为只读。`, `Control moved to ${preemptedBy}. This view is now read-only.`),
        );
      }

      const activeTab = activeTabOf(nextView);
      const urlInfo = classifyPageUrl(activeTab?.url);
      const nextSensitive = Boolean(nextView.sensitive || urlInfo.isKnownSensitiveUrl);

      // Clear cached frame immediately if unavailable, sensitive bystander, or page/revision changed.
      if (
        !nextView.available ||
        !nextView.canStreamInteract ||
        !nextView.pageId ||
        (nextSensitive && !nextIsHolder) ||
        (prevView && (prevView.pageId !== nextView.pageId || prevView.revision !== nextView.revision))
      ) {
        clearCachedFrame();
      }

      if (!nextView.available || !nextView.canStreamInteract) {
        streamFailSinceRef.current = null;
        setFrameRedacted(false);
        setFrameRedactedReason(null);
      }

      if (!urlEditingRef.current) {
        setUrlDraft(activeTab?.url ?? '');
      }

      viewRef.current = nextView;
      setView(nextView);
      setLoadingStatus(false);
      return { nextLease, nextIsHolder };
    },
    [clearCachedFrame, t],
  );

  // Full session reset whenever botId or deviceId changes, or on unmount.
  // Never sends handback on switch/unmount — Host maintains safe hold semantics.
  useEffect(() => {
    epochRef.current += 1;
    clearPollTimer();
    inFlightPollRef.current = false;
    clearCachedFrame();
    clearLocalLease();
    viewRef.current = null;
    streamFailSinceRef.current = null;
    composingRef.current = false;
    if (remoteInputRef.current) remoteInputRef.current.value = '';

    setView(null);
    setPendingAction(null);
    setLoadingStatus(true);
    setStreamDegraded(false);
    setFrameRedacted(false);
    setFrameRedactedReason(null);
    setErrorBanner(null);
    setNoticeBanner(null);
    setPreemptConfirmOpen(false);
    setExternalConfirmOpen(false);
    setUrlDraft('');
    setUrlEditing(false);
    setZoom(1);

    return () => {
      epochRef.current += 1;
      clearPollTimer();
      clearCachedFrame();
      clearLocalLease();
    };
  }, [botId, deviceId, clearPollTimer, clearCachedFrame, clearLocalLease]);

  const scheduleNextPollRef = useRef<(delayMs?: number) => void>(() => {});

  const pollOnce = useCallback(
    async (epoch: number) => {
      if (inFlightPollRef.current || epoch !== epochRef.current) return;
      inFlightPollRef.current = true;
      let nextDelay = POLL_INTERVAL_IDLE_MS;

      try {
        const rawStatus = await requestRef.current(buildBrowserRequest('status', { botId }));
        if (epoch !== epochRef.current) return;

        const parsedView = parseBrowserView(rawStatus);
        if (!parsedView) {
          setLoadingStatus(false);
          setErrorBanner(t('无法识别 Host 返回的浏览器状态。', 'Unrecognized browser status from target host.'));
          return;
        }

        const { nextLease, nextIsHolder } = applyViewState(parsedView);
        const currentTab = activeTabOf(parsedView);
        const urlMeta = classifyPageUrl(currentTab?.url);
        const isSensitiveNow = Boolean(parsedView.sensitive || urlMeta.isKnownSensitiveUrl);
        const shouldFetchFrame =
          parsedView.available &&
          parsedView.canStreamInteract &&
          Boolean(parsedView.pageId) &&
          !(isSensitiveNow && !nextIsHolder) &&
          !streamDegradedRef.current;

        if (shouldFetchFrame && parsedView.pageId) {
          try {
            const rawFrame = await requestRef.current(
              buildBrowserRequest('frame', {
                botId,
                pageId: parsedView.pageId,
                lease: nextLease?.lease,
                revision: parsedView.revision,
              }),
            );
            if (epoch !== epochRef.current) return;

            const redaction = inspectFrameRedaction(rawFrame);
            if (redaction.redacted) {
              clearCachedFrame();
              setFrameRedacted(true);
              setFrameRedactedReason(redaction.reason ?? null);
              streamFailSinceRef.current = null;
            } else {
              const parsedFrame = parseBrowserFrame(rawFrame);
              if (
                parsedFrame &&
                isFrameUsableForView(parsedFrame, parsedView, lastFrameCursorRef.current)
              ) {
                lastFrameCursorRef.current = {
                  pageId: parsedFrame.pageId,
                  revision: parsedFrame.revision,
                  seq: parsedFrame.seq,
                };
                setFrame(parsedFrame);
                setFrameRedacted(false);
                setFrameRedactedReason(null);
                streamFailSinceRef.current = null;
                if (streamDegradedRef.current) setStreamDegraded(false);
              } else {
                // Bounded frame missing or mismatched: count toward honest 5s stream degrade.
                const now = Date.now();
                if (streamFailSinceRef.current === null) streamFailSinceRef.current = now;
                if (now - streamFailSinceRef.current >= STREAM_DEGRADE_TIMEOUT_MS) {
                  clearCachedFrame();
                  setStreamDegraded(true);
                }
              }
            }
          } catch (frameErr) {
            if (epoch !== epochRef.current) return;
            const classified = classifyBrowserError(frameErr);
            if (classified.sensitiveBlocked) {
              clearCachedFrame();
              setFrameRedacted(true);
              setFrameRedactedReason(classified.message || null);
              streamFailSinceRef.current = null;
            } else if (classified.unavailable) {
              clearCachedFrame();
              setStreamDegraded(true);
            } else if (!classified.staleState) {
              const now = Date.now();
              if (streamFailSinceRef.current === null) streamFailSinceRef.current = now;
              if (now - streamFailSinceRef.current >= STREAM_DEGRADE_TIMEOUT_MS) {
                clearCachedFrame();
                setStreamDegraded(true);
              }
            }
          }
        }

        if (parsedView.available && parsedView.canStreamInteract && !streamDegradedRef.current) {
          if (nextIsHolder || parsedView.phase === 'taking') {
            nextDelay = POLL_INTERVAL_ACTIVE_MS;
          } else if (parsedView.pageId && !(isSensitiveNow && !nextIsHolder)) {
            nextDelay = POLL_INTERVAL_WATCH_MS;
          } else {
            nextDelay = POLL_INTERVAL_IDLE_MS;
          }
        } else {
          nextDelay = POLL_INTERVAL_IDLE_MS;
        }
      } catch (err) {
        if (epoch !== epochRef.current) return;
        setLoadingStatus(false);
        const classified = classifyBrowserError(err);
        if (classified.unavailable) {
          clearCachedFrame();
          setStreamDegraded(true);
        }
        setErrorBanner(
          classified.message ||
            t('读取浏览器状态失败，请检查目标设备连接。', 'Failed to read browser status. Check host connection.'),
        );
      } finally {
        inFlightPollRef.current = false;
        if (epoch === epochRef.current) {
          scheduleNextPollRef.current(nextDelay);
        }
      }
    },
    [botId, applyViewState, clearCachedFrame, t],
  );

  const schedulePoll = useCallback(
    (delayMs = 0) => {
      clearPollTimer();
      const epoch = epochRef.current;
      pollTimerRef.current = window.setTimeout(() => {
        pollTimerRef.current = null;
        void pollOnce(epoch);
      }, Math.max(0, delayMs));
    },
    [clearPollTimer, pollOnce],
  );
  scheduleNextPollRef.current = schedulePoll;

  // Start/stop polling strictly with connected + pageVisible; clear cached frame when paused.
  // Never auto-handback on disconnect or background!
  useEffect(() => {
    epochRef.current += 1;
    clearPollTimer();
    inFlightPollRef.current = false;
    streamFailSinceRef.current = null;

    if (!connected || !pageVisible) {
      clearCachedFrame();
      composingRef.current = false;
      if (remoteInputRef.current) remoteInputRef.current.value = '';
      setPendingAction(null);
      return;
    }

    schedulePoll(0);
    return () => {
      epochRef.current += 1;
      clearPollTimer();
    };
  }, [botId, deviceId, connected, pageVisible, clearPollTimer, clearCachedFrame, schedulePoll]);

  const handleRetry = useCallback(() => {
    setErrorBanner(null);
    streamDegradedRef.current = false;
    setStreamDegraded(false);
    setFrameRedacted(false);
    setFrameRedactedReason(null);
    streamFailSinceRef.current = null;
    schedulePoll(0);
  }, [schedulePoll]);

  const handleTakeover = useCallback(
    async (options?: { force?: boolean }) => {
      if (!connected || pendingActionRef.current !== null) return;
      const currentView = viewRef.current;
      const epoch = epochRef.current;
      setPendingAction('taking');
      setErrorBanner(null);
      setNoticeBanner(null);
      setPreemptConfirmOpen(false);

      try {
        const res = await requestRef.current(
          buildBrowserRequest('takeover', {
            botId,
            pageId: currentView?.pageId,
            revision: currentView?.revision,
            force: options?.force === true,
          }),
        );
        if (epoch !== epochRef.current) return;

        const nextView = parseBrowserView(res);
        const rawLease = extractRawLease(res);

        if (nextView) {
          const confirmed = confirmTakeoverLease(nextView, rawLease);
          if (confirmed) {
            ownedLeaseRef.current = confirmed;
            pendingTakeoverLeaseRef.current = null;
            isHolderRef.current = true;
            setOwnedLease(confirmed);
            setIsHolder(true);
            viewRef.current = nextView;
            setView(nextView);
            streamDegradedRef.current = false;
            setStreamDegraded(false);
            streamFailSinceRef.current = null;
            setNoticeBanner(
              t('已接管当前页面 · Bot 已完全停手', 'You are now in control · Bot is paused'),
            );
            schedulePoll(0);
            return;
          }

          if (nextView.phase === 'taking') {
            pendingTakeoverLeaseRef.current = rawLease ?? nextView.lease ?? null;
            viewRef.current = nextView;
            setView(nextView);
            setNoticeBanner(
              t('正在等待 Bot 完成当前在途动作，确认停手后开放输入…', 'Waiting for the Bot to finish its in-flight action before unlocking input…'),
            );
            schedulePoll(180);
            return;
          }

          applyViewState(nextView);
          setErrorBanner(
            nextView.reason ||
              t('未收到 Host 停手确认，人工输入尚未开放。', 'Host did not confirm takeover. Manual input remains locked.'),
          );
          return;
        }

        // Minimal response containing only { lease } -> verify via immediate status poll before unlocking.
        if (rawLease) {
          pendingTakeoverLeaseRef.current = rawLease;
          schedulePoll(0);
          return;
        }

        setErrorBanner(
          t('接管请求未返回有效确认，人工输入保持锁定。', 'Takeover response was not confirmed. Input remains locked.'),
        );
      } catch (err) {
        if (epoch !== epochRef.current) return;
        const classified = classifyBrowserError(err);
        setErrorBanner(
          classified.message ||
            t('接管失败，请稍后重试。', 'Failed to take over control. Please retry.'),
        );
        schedulePoll(150);
      } finally {
        if (epoch === epochRef.current) {
          setPendingAction(null);
        }
      }
    },
    [botId, connected, applyViewState, schedulePoll, t],
  );

  const handleHandback = useCallback(async () => {
    if (!connected || pendingActionRef.current !== null) return;
    const currentView = viewRef.current;
    const currentLease = ownedLeaseRef.current;
    if (!currentLease && currentView?.phase !== 'held') return;

    const epoch = epochRef.current;
    setPendingAction('handing-back');
    setErrorBanner(null);
    setNoticeBanner(null);

    try {
      const res = await requestRef.current(
        buildBrowserRequest('handback', {
          botId,
          pageId: currentView?.pageId,
          lease: currentLease?.lease,
          revision: currentView?.revision,
        }),
      );
      if (epoch !== epochRef.current) return;

      const nextView = parseBrowserView(res);
      if (nextView) {
        if (nextView.phase === 'human' && nextView.sensitive) {
          setErrorBanner(
            t('当前页面含敏感凭据或登录框，无法交还 Bot，请先完成或离开此页。', 'This page contains sensitive credentials or a login form and cannot be handed back to the Bot yet.'),
          );
          return;
        }
        clearLocalLease();
        applyViewState(nextView);
      } else {
        clearLocalLease();
      }
      setNoticeBanner(
        t('已交还给 Bot · Bot 正在核对当前页面', 'Handed back · Bot is verifying the current page'),
      );
      schedulePoll(0);
    } catch (err) {
      if (epoch !== epochRef.current) return;
      const classified = classifyBrowserError(err);
      if (classified.sensitiveBlocked) {
        setErrorBanner(
          t('当前页面含敏感凭据或登录框，无法交还 Bot，请先完成或离开此页。', 'This page contains sensitive credentials or a login form and cannot be handed back to the Bot yet.'),
        );
      } else {
        if (classified.invalidatesLease) clearLocalLease();
        setErrorBanner(
          classified.message || t('交还失败，请重试。', 'Failed to hand back control. Please retry.'),
        );
        schedulePoll(150);
      }
    } finally {
      if (epoch === epochRef.current) {
        setPendingAction(null);
      }
    }
  }, [botId, connected, clearLocalLease, applyViewState, schedulePoll, t]);

  const handleRelease = useCallback(
    async (alsoCancelTask = false) => {
      if (!connected || pendingActionRef.current !== null) return;
      const currentView = viewRef.current;
      const currentLease = ownedLeaseRef.current;
      const epoch = epochRef.current;
      setPendingAction('releasing');
      setErrorBanner(null);
      setNoticeBanner(null);

      try {
        const res = await requestRef.current(
          buildBrowserRequest('release', {
            botId,
            pageId: currentView?.pageId,
            lease: currentLease?.lease,
            revision: currentView?.revision,
          }),
        );
        if (epoch !== epochRef.current) return;
        clearLocalLease();
        const nextView = parseBrowserView(res);
        if (nextView) applyViewState(nextView);
        setNoticeBanner(t('已释放当前浏览器控制权。', 'Released browser control.'));
        if (alsoCancelTask && onCancelTask) {
          await onCancelTask();
        }
        schedulePoll(0);
      } catch (err) {
        if (epoch !== epochRef.current) return;
        const classified = classifyBrowserError(err);
        if (classified.invalidatesLease) clearLocalLease();
        setErrorBanner(
          classified.message || t('释放控制权失败。', 'Failed to release browser control.'),
        );
      } finally {
        if (epoch === epochRef.current) {
          setPendingAction(null);
        }
      }
    },
    [botId, connected, clearLocalLease, applyViewState, onCancelTask, schedulePoll, t],
  );

  const runPageAction = useCallback(
    async (
      kind: 'navigating' | 'tab',
      action: 'open' | 'navigate' | 'back' | 'forward' | 'reload' | 'select' | 'closeTab',
      extra?: { pageId?: string | null; url?: string },
    ) => {
      if (!connected || pendingActionRef.current !== null) return;
      const currentView = viewRef.current;
      const currentLease = ownedLeaseRef.current;
      const epoch = epochRef.current;
      setPendingAction(kind);
      setErrorBanner(null);

      try {
        const res = await requestRef.current(
          buildBrowserRequest(action, {
            botId,
            pageId: extra?.pageId !== undefined ? extra.pageId : currentView?.pageId,
            lease: currentLease?.lease,
            revision: currentView?.revision,
            url: extra?.url,
          }),
        );
        if (epoch !== epochRef.current) return;
        clearCachedFrame();
        const nextView = parseBrowserView(res);
        if (nextView) applyViewState(nextView);
        schedulePoll(100);
      } catch (err) {
        if (epoch !== epochRef.current) return;
        const classified = classifyBrowserError(err);
        if (classified.invalidatesLease) clearLocalLease();
        setErrorBanner(
          classified.message || t('页面操作未完成，请重试。', 'Browser navigation failed. Please retry.'),
        );
        schedulePoll(150);
      } finally {
        if (epoch === epochRef.current) {
          setPendingAction(null);
        }
      }
    },
    [botId, connected, clearCachedFrame, clearLocalLease, applyViewState, schedulePoll, t],
  );

  const currentTab = useMemo(() => activeTabOf(view), [view]);
  const urlMeta = useMemo(() => classifyPageUrl(currentTab?.url), [currentTab?.url]);
  const isSensitive = Boolean(view?.sensitive || urlMeta.isKnownSensitiveUrl);

  const liveFrame = useMemo(
    () => (isFrameUsableForView(frame, view) ? frame : null),
    [frame, view],
  );

  const canSendInput = canAcceptManualInput({
    connected,
    visible: pageVisible,
    view,
    ownedLease,
    isHolder,
    pendingAction,
    liveFrame,
    streamDegraded,
  });

  // Strict single-shot input dispatch: never queues or replays failed/stale inputs.
  const handleInput = useCallback(
    (event: BrowserInputEvent) => {
      const currentView = viewRef.current;
      const currentLease = ownedLeaseRef.current;
      const currentFrame = isFrameUsableForView(frameRef.current, currentView)
        ? frameRef.current
        : null;
      if (
        !canAcceptManualInput({
          connected,
          visible: pageVisible,
          view: currentView,
          ownedLease: currentLease,
          isHolder: isHolderRef.current,
          pendingAction: pendingActionRef.current,
          liveFrame: currentFrame,
          streamDegraded: streamDegradedRef.current,
        }) ||
        !currentView?.pageId ||
        !currentLease
      ) {
        return;
      }

      const epoch = epochRef.current;
      const payload = buildBrowserRequest('input', {
        botId,
        pageId: currentView.pageId,
        lease: currentLease.lease,
        revision: currentView.revision,
        event,
      });

      void requestRef
        .current(payload)
        .then((res) => {
          if (epoch !== epochRef.current) return;
          const nextView = parseBrowserView(res);
          if (nextView) applyViewState(nextView);
          schedulePoll(120);
        })
        .catch((err) => {
          if (epoch !== epochRef.current) return;
          const classified = classifyBrowserError(err);
          if (classified.invalidatesLease) {
            clearLocalLease();
            setErrorBanner(
              t('控制权已失效或被其他端接管，未重放刚才的输入。', 'Control lease expired or moved. Input was not replayed.'),
            );
          } else if (classified.staleState) {
            clearCachedFrame();
            setErrorBanner(
              t('页面已更新，刚才的输入已跳过（未重放）。', 'Page changed before input arrived; input was skipped without replay.'),
            );
          } else if (classified.sensitiveBlocked) {
            setErrorBanner(
              t('当前页面受敏感保护，Host 已拒绝输入。', 'Host blocked input on this protected sensitive page.'),
            );
          } else {
            setErrorBanner(
              classified.message
                ? t(`输入未确认：${classified.message}（未自动重放）`, `Input not confirmed: ${classified.message} (not replayed)`)
                : t('输入未确认，不会自动重放。', 'Input was not confirmed and will not be replayed.'),
            );
          }
          schedulePoll(100);
        });
    },
    [
      botId,
      connected,
      pageVisible,
      applyViewState,
      clearCachedFrame,
      clearLocalLease,
      schedulePoll,
      t,
    ],
  );

  // Uncontrolled IME-safe remote text input dock.
  const commitRemoteText = useCallback(
    (el: HTMLInputElement) => {
      const value = el.value;
      el.value = '';
      if (!value || !canSendInput) return;
      if (value.length > MAX_TEXT_INPUT_LENGTH) {
        setErrorBanner(
          t(`单次输入不能超过 ${MAX_TEXT_INPUT_LENGTH} 字。`, `Text input exceeds ${MAX_TEXT_INPUT_LENGTH} characters.`),
        );
        return;
      }
      handleInput({ kind: 'text', text: value });
    },
    [canSendInput, handleInput, t],
  );

  const handleRemoteTextChange = (ev: ChangeEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    commitRemoteText(ev.currentTarget);
  };

  const handleRemoteTextCompositionStart = () => {
    composingRef.current = true;
  };

  const handleRemoteTextCompositionEnd = (ev: CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    commitRemoteText(ev.currentTarget);
  };

  const handleRemoteTextKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (!canSendInput || ev.nativeEvent.isComposing) return;
    if (ev.key === 'Enter' || ev.key === 'Tab' || ev.key === 'Escape') {
      ev.preventDefault();
      handleInput({ kind: 'key', key: ev.key });
    } else if (ev.key === 'Backspace' && ev.currentTarget.value.length === 0) {
      ev.preventDefault();
      handleInput({ kind: 'key', key: 'Backspace' });
    }
  };

  const canNavigate =
    connected &&
    pageVisible &&
    pendingAction === null &&
    Boolean(view?.available && view?.canStreamInteract && view?.pageId) &&
    view?.phase === 'human' &&
    isHolder;

  const handleUrlSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (!canNavigate) return;
    const normalized = normalizeNavigateUrl(urlDraft);
    if (!normalized.ok) {
      setErrorBanner(
        normalized.reason === 'disallowed_scheme'
          ? t('仅支持 http:// 或 https:// 网址。', 'Only http:// and https:// URLs are allowed.')
          : t('请输入有效的网址。', 'Enter a valid web address.'),
      );
      return;
    }
    setUrlEditing(false);
    setUrlDraft(normalized.url);
    void runPageAction('navigating', 'navigate', { url: normalized.url });
  };

  const handleConfirmExternalGuide = () => {
    setExternalConfirmOpen(false);
    const candidateUrl =
      (view?.externalUrl && classifyPageUrl(view.externalUrl).isHttpUrl ? view.externalUrl : '') ||
      (currentTab?.url && classifyPageUrl(currentTab.url).isHttpUrl ? currentTab.url : '') ||
      FALLBACK_EXTERNAL_URL;

    if (onSwitchToExternalGuide) {
      onSwitchToExternalGuide(candidateUrl);
    } else {
      void openExternalUrl(candidateUrl);
    }
  };

  const handlePanelKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === 'Escape' && resolvedMode === 'fullscreen' && onClose) {
      // Only close fullscreen drawer on Escape when remote canvas/input isn't consuming Escape.
      const target = ev.target as HTMLElement | null;
      const insideInteractiveCanvas = Boolean(
        target?.closest('.bb-stage--interactive, .bb-input-dock'),
      );
      if (!insideInteractiveCanvas) {
        ev.preventDefault();
        onClose();
      }
    }
  };

  const stepZoom = (delta: 1 | -1) => {
    const idx = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.01);
    const baseIdx = idx === -1 ? ZOOM_STEPS.length - 1 : idx;
    const nextIdx = Math.min(ZOOM_STEPS.length - 1, Math.max(0, baseIdx + delta));
    setZoom(ZOOM_STEPS[nextIdx]);
  };

  const isHeld = view?.phase === 'held';
  const isOtherHolder = Boolean(view?.phase === 'human' && !isHolder);
  const isTaking = pendingAction === 'taking' || view?.phase === 'taking';
  const isHandingBack = pendingAction === 'handing-back';
  const isAvailableInteractive = Boolean(
    connected && view?.available && view?.canStreamInteract && !streamDegraded,
  );
  const signInTakeover = isAvailableInteractive && pageVisible && Boolean(view?.pageId) &&
    isSensitive && urlMeta.isGoogleAuth && !isHolder && !view?.fallbackToSystemBrowser && !frameRedacted;

  // Concise, honest status pill label & semantic tone.
  const statusInfo = (() => {
    if (!connected) {
      return { tone: 'muted', text: t('连接已断开', 'Disconnected'), spinning: false };
    }
    if (!view && loadingStatus) {
      return { tone: 'muted', text: t('连接中…', 'Connecting…'), spinning: true };
    }
    if (!view || !view.available || !view.canStreamInteract || streamDegraded) {
      return { tone: 'warn', text: t('实时浏览不可用', 'Live view unavailable'), spinning: false };
    }
    if (isHandingBack) {
      return { tone: 'muted', text: t('正在交还…', 'Handing back…'), spinning: true };
    }
    if (isTaking) {
      return { tone: 'warn', text: t('正在接管 · 等待停手…', 'Taking over · pausing Bot…'), spinning: true };
    }
    if (isHeld) {
      return { tone: 'warn', text: t('连接中断 · Bot 保持停手', 'Hold active · Bot paused'), spinning: false };
    }
    if (view.phase === 'human' && isHolder) {
      return { tone: 'active', text: t('你正在接管 · Bot 已停手', 'In control · Bot paused'), spinning: false };
    }
    if (isOtherHolder) {
      const label = view.holderLabel || t('其他设备', 'another device');
      return {
        tone: 'muted',
        text: t(`正在 ${label} 接管中`, `Controlled by ${label}`),
        spinning: false,
      };
    }
    if (view.attentionRequested) {
      return { tone: 'warn', text: t('Bot 请求你接管', 'Bot requests takeover'), spinning: false };
    }
    return { tone: 'bot', text: t('Bot 协助中', 'Bot active'), spinning: false };
  })();

  const panelClasses = [
    'bb-panel',
    resolvedMode === 'fullscreen' ? 'bb-panel--fullscreen' : 'bb-panel--sidebar',
    isHolder && view?.phase === 'human' ? 'bb-panel--controlling' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const primaryActionButton = (() => {
    if (!isAvailableInteractive) return null;

    if (isTaking) {
      return (
        <button type="button" className="bb-btn bb-btn--warn" disabled>
          <Loader2 size={14} className="bb-spin" aria-hidden="true" />
          <span>{t('等待停手…', 'Pausing…')}</span>
        </button>
      );
    }

    if (isHandingBack) {
      return (
        <button type="button" className="bb-btn bb-btn--secondary" disabled>
          <Loader2 size={14} className="bb-spin" aria-hidden="true" />
          <span>{t('正在交还…', 'Handing back…')}</span>
        </button>
      );
    }

    if (view?.phase === 'human' && isHolder) {
      return (
        <div className="bb-action-pair">
          <button
            type="button"
            className="bb-btn bb-btn--primary"
            disabled={pendingAction !== null}
            onClick={() => void handleHandback()}
          >
            <Bot size={14} aria-hidden="true" />
            <span>{t('交还给 Bot', 'Hand back')}</span>
          </button>
          <button
            type="button"
            className="bb-btn bb-btn--ghost"
            disabled={pendingAction !== null}
            onClick={() => void handleRelease(false)}
            title={t('释放接管控制权', 'Release control lease')}
          >
            <Square size={13} aria-hidden="true" />
            <span>{t('释放', 'Release')}</span>
          </button>
        </div>
      );
    }

    if (isOtherHolder) {
      return (
        <button
          type="button"
          className="bb-btn bb-btn--secondary"
          disabled={pendingAction !== null}
          onClick={() => setPreemptConfirmOpen(true)}
        >
          <Unlock size={14} aria-hidden="true" />
          <span>{t('切换到本机接管', 'Take control here')}</span>
        </button>
      );
    }

    if (isHeld) {
      return (
        <button
          type="button"
          className="bb-btn bb-btn--warn"
          disabled={pendingAction !== null}
          onClick={() => void handleTakeover({ force: true })}
        >
          <Play size={14} aria-hidden="true" />
          <span>{t('继续接管', 'Resume control')}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        className={`bb-btn ${view?.attentionRequested ? 'bb-btn--warn' : 'bb-btn--primary'}`}
        disabled={pendingAction !== null}
        onClick={() => void handleTakeover()}
      >
        <Unlock size={14} aria-hidden="true" />
        <span>{signInTakeover ? t('接管并登录', 'Take over and sign in') : t('接管此页', 'Take over')}</span>
      </button>
    );
  })();

  return (
    <section
      ref={panelRef}
      className={panelClasses}
      role={resolvedMode === 'fullscreen' ? 'dialog' : 'region'}
      aria-modal={resolvedMode === 'fullscreen' ? true : undefined}
      aria-label={
        botName
          ? t(`${botName} 的 Bot 内置浏览器`, `${botName} Bot browser`)
          : t('Bot 内置浏览器', 'Bot browser')
      }
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
    >
      {/* Top status & primary action header */}
      <header className="bb-header">
        <div className="bb-header-left">
          <div className={`bb-status-pill bb-status-pill--${statusInfo.tone}`} role="status" aria-live="polite">
            {statusInfo.spinning ? (
              <Loader2 size={13} className="bb-spin" aria-hidden="true" />
            ) : (
              <span className="bb-status-dot" aria-hidden="true" />
            )}
            <span className="bb-status-text">{statusInfo.text}</span>
          </div>
          {isSensitive && isHolder ? (
            <span className="bb-shield-chip" title={t('敏感页保护中，Bot 观察与截图已阻断', 'Privacy shield active: Bot observation and screenshots are blocked')}>
              <Shield size={12} aria-hidden="true" />
              <span>{t('隐私保护', 'Private')}</span>
            </span>
          ) : null}
        </div>

        <div className="bb-header-right">
          {resolvedMode === 'sidebar' && !signInTakeover ? primaryActionButton : null}
          {mode === 'auto' && !isMobileViewport ? (
            <button
              type="button"
              className="bb-icon-btn"
              onClick={() => setDesktopExpanded((prev) => !prev)}
              aria-label={
                desktopExpanded
                  ? t('恢复旁栏视图', 'Dock to sidebar')
                  : t('放大为全屏视图', 'Expand to fullscreen')
              }
              title={desktopExpanded ? t('恢复旁栏', 'Sidebar') : t('全屏查看', 'Fullscreen')}
            >
              {desktopExpanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
            </button>
          ) : null}
          {onClose ? (
            <button
              ref={closeBtnRef}
              type="button"
              className="bb-icon-btn"
              onClick={onClose}
              aria-label={t('关闭浏览器面板', 'Close browser panel')}
              title={t('关闭', 'Close')}
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {/* Tabs + address bar (only when browser is available) */}
      {view?.available ? (
        <div className="bb-chrome">
          {view.tabs.length > 0 || isHolder ? (
            <div className="bb-tabs" role="tablist" aria-label={t('浏览器标签页', 'Browser tabs')}>
              {view.tabs.map((tab) => {
                const selected = tab.id === view.pageId;
                const tabHost = classifyPageUrl(tab.url).displayHost;
                const label = tab.title.trim() || tabHost || t('新标签页', 'New tab');
                return (
                  <div
                    key={tab.id}
                    className={`bb-tab ${selected ? 'bb-tab--active' : ''}`}
                    role="presentation"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      className="bb-tab-select"
                      disabled={pendingAction !== null || isOtherHolder}
                      onClick={() => {
                        if (!selected) void runPageAction('tab', 'select', { pageId: tab.id });
                      }}
                      title={tab.url || label}
                    >
                      <Globe size={12} aria-hidden="true" className="bb-tab-icon" />
                      <span className="bb-tab-title">{label}</span>
                    </button>
                    {!isOtherHolder ? (
                      <button
                        type="button"
                        className="bb-tab-close"
                        disabled={pendingAction !== null}
                        aria-label={t(`关闭标签页 ${label}`, `Close tab ${label}`)}
                        onClick={() => void runPageAction('tab', 'closeTab', { pageId: tab.id })}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
              {!isOtherHolder ? (
                <button
                  type="button"
                  className="bb-tab-add"
                  disabled={pendingAction !== null || !connected}
                  aria-label={t('新建标签页', 'New tab')}
                  title={t('新建标签页', 'New tab')}
                  onClick={() => void runPageAction('tab', 'open', { pageId: null })}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="bb-nav-row">
            <div className="bb-nav-buttons">
              <button
                type="button"
                className="bb-icon-btn"
                disabled={!canNavigate || view.canGoBack === false}
                aria-label={t('后退', 'Back')}
                title={canNavigate ? t('后退', 'Back') : t('接管此页后可操作导航', 'Take over to navigate')}
                onClick={() => void runPageAction('navigating', 'back')}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="bb-icon-btn"
                disabled={!canNavigate || view.canGoForward === false}
                aria-label={t('前进', 'Forward')}
                title={canNavigate ? t('前进', 'Forward') : t('接管此页后可操作导航', 'Take over to navigate')}
                onClick={() => void runPageAction('navigating', 'forward')}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="bb-icon-btn"
                disabled={!canNavigate}
                aria-label={t('刷新当前页面', 'Reload page')}
                title={canNavigate ? t('刷新', 'Reload') : t('接管此页后可刷新', 'Take over to reload')}
                onClick={() => void runPageAction('navigating', 'reload')}
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            </div>

            <form className="bb-address-form" onSubmit={handleUrlSubmit}>
              <span className="bb-address-lock" aria-hidden="true">
                {urlMeta.isSecure ? <Lock size={12} /> : <Globe size={12} />}
              </span>
              <input
                type="text"
                className="bb-address-input"
                value={urlDraft}
                readOnly={!canNavigate}
                aria-label={t('当前网页地址', 'Current page URL')}
                placeholder={t('输入网址并回车…', 'Enter URL and press Enter…')}
                onFocus={() => {
                  if (canNavigate) setUrlEditing(true);
                }}
                onBlur={() => {
                  setUrlEditing(false);
                  setUrlDraft(currentTab?.url ?? '');
                }}
                onChange={(ev) => setUrlDraft(ev.target.value)}
              />
            </form>

            {liveFrame ? (
              <div className="bb-zoom-group" role="group" aria-label={t('画面缩放', 'Viewport zoom')}>
                <button
                  type="button"
                  className="bb-zoom-btn"
                  disabled={zoom <= ZOOM_STEPS[0]}
                  aria-label={t('缩小画面', 'Zoom out')}
                  onClick={() => stepZoom(-1)}
                >
                  −
                </button>
                <button
                  type="button"
                  className="bb-zoom-label"
                  onClick={() => setZoom(1)}
                  title={t('重置为 100%', 'Reset zoom to 100%')}
                >
                  {`${Math.round(zoom * 100)}%`}
                </button>
                <button
                  type="button"
                  className="bb-zoom-btn"
                  disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  aria-label={t('放大画面', 'Zoom in')}
                  onClick={() => stepZoom(1)}
                >
                  +
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Contextual banners — shown only when actionable */}
      <div className="bb-banners">
        {view?.attentionRequested && view.phase === 'bot' && isAvailableInteractive && !signInTakeover ? (
          <div className="bb-banner bb-banner--warn" role="status">
            <AlertTriangle size={15} className="bb-banner-icon" aria-hidden="true" />
            <div className="bb-banner-body">
              <div className="bb-banner-title">
                {view.attentionMessage ||
                  t('Bot 请求你接管当前页面以完成需人工确认的步骤。', 'Bot paused and requests you to take over this page.')}
              </div>
            </div>
            <button
              type="button"
              className="bb-btn bb-btn--warn bb-btn--sm"
              disabled={pendingAction !== null}
              onClick={() => void handleTakeover()}
            >
              {t('接管此页', 'Take over')}
            </button>
          </div>
        ) : null}

        {isHeld ? (
          <div className="bb-banner bb-banner--warn" role="status">
            <AlertTriangle size={15} className="bb-banner-icon" aria-hidden="true" />
            <div className="bb-banner-body">
              <div className="bb-banner-title">
                {t('刚才接管时连接中断，Bot 仍处于停手状态，不会擅自继续操作。', 'Connection dropped during takeover. The Bot remains paused until you decide.')}
              </div>
              {currentTab?.url && !isSensitive ? (
                <div className="bb-banner-sub">{urlMeta.displayHost || currentTab.url}</div>
              ) : null}
              <div className="bb-banner-actions">
                <button
                  type="button"
                  className="bb-btn bb-btn--warn bb-btn--sm"
                  disabled={pendingAction !== null}
                  onClick={() => void handleTakeover({ force: true })}
                >
                  {t('继续接管', 'Resume control')}
                </button>
                <button
                  type="button"
                  className="bb-btn bb-btn--secondary bb-btn--sm"
                  disabled={pendingAction !== null}
                  onClick={() => void handleHandback()}
                >
                  {t('交还给 Bot', 'Hand back')}
                </button>
                <button
                  type="button"
                  className="bb-btn bb-btn--ghost bb-btn--sm"
                  disabled={pendingAction !== null}
                  onClick={() => void handleRelease(true)}
                >
                  {t('中止任务', 'Cancel task')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {preemptConfirmOpen && isOtherHolder ? (
          <div className="bb-banner bb-banner--info" role="alertdialog" aria-label={t('确认切换控制权', 'Confirm takeover switch')}>
            <Info size={15} className="bb-banner-icon" aria-hidden="true" />
            <div className="bb-banner-body">
              <div className="bb-banner-title">
                {t(`确定将控制权从「${view?.holderLabel || '另一台设备'}」切换到本机？原设备将立即转为只读。`, `Move control from ${view?.holderLabel || 'the other device'} to here? The other view will become read-only.`)}
              </div>
              <div className="bb-banner-actions">
                <button
                  type="button"
                  className="bb-btn bb-btn--primary bb-btn--sm"
                  disabled={pendingAction !== null}
                  onClick={() => void handleTakeover({ force: true })}
                >
                  {t('确认切换', 'Switch here')}
                </button>
                <button
                  type="button"
                  className="bb-btn bb-btn--ghost bb-btn--sm"
                  onClick={() => setPreemptConfirmOpen(false)}
                >
                  {t('取消', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {externalConfirmOpen ? (
          <div className="bb-banner bb-banner--info" role="alertdialog" aria-label={t('确认切换外部浏览器指导', 'Confirm external browser guide')}>
            <ExternalLink size={15} className="bb-banner-icon" aria-hidden="true" />
            <div className="bb-banner-body">
              <div className="bb-banner-title">
                {t('将在你的系统浏览器中打开新页面，不继承当前表单已填内容。确认切换？', 'This opens a fresh session in your system browser and does not carry over filled form fields. Continue?')}
              </div>
              <div className="bb-banner-actions">
                <button
                  type="button"
                  className="bb-btn bb-btn--primary bb-btn--sm"
                  onClick={handleConfirmExternalGuide}
                >
                  {t('打开系统浏览器', 'Open system browser')}
                </button>
                <button
                  type="button"
                  className="bb-btn bb-btn--ghost bb-btn--sm"
                  onClick={() => setExternalConfirmOpen(false)}
                >
                  {t('留在当前页', 'Stay here')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {errorBanner ? (
          <div className="bb-banner bb-banner--danger" role="alert">
            <AlertTriangle size={15} className="bb-banner-icon" aria-hidden="true" />
            <div className="bb-banner-body">{errorBanner}</div>
            <button
              type="button"
              className="bb-icon-btn bb-icon-btn--sm"
              aria-label={t('关闭错误提示', 'Dismiss error')}
              onClick={() => setErrorBanner(null)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {noticeBanner && !errorBanner ? (
          <div className="bb-banner bb-banner--notice" role="status" aria-live="polite">
            <Info size={14} className="bb-banner-icon" aria-hidden="true" />
            <div className="bb-banner-body">{noticeBanner}</div>
            <button
              type="button"
              className="bb-icon-btn bb-icon-btn--sm"
              aria-label={t('关闭提示', 'Dismiss notice')}
              onClick={() => setNoticeBanner(null)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {/* Main viewport stage */}
      <BotBrowserViewport
        connected={connected}
        visible={pageVisible}
        view={view}
        liveFrame={liveFrame}
        loadingStatus={loadingStatus}
        streamDegraded={streamDegraded}
        frameRedacted={frameRedacted}
        frameRedactedReason={frameRedactedReason}
        isHolder={isHolder}
        canSendInput={canSendInput}
        isSensitive={isSensitive}
        signInTakeoverAction={signInTakeover ? primaryActionButton : null}
        zoom={zoom}
        hostLabel={hostLabel}
        onZoomChange={setZoom}
        onInput={handleInput}
        onRetry={handleRetry}
        onOpenTab={
          !isOtherHolder && connected
            ? () => void runPageAction('tab', 'open', { pageId: null })
            : undefined
        }
        onRequestExternalGuide={() => setExternalConfirmOpen(true)}
        onExitStageFocus={() => closeBtnRef.current?.focus({ preventScroll: true })}
      />

      {/* Remote keyboard & touch input dock (visible only when actively holding confirmed lease) */}
      {canSendInput ? (
        <div className="bb-input-dock" aria-label={t('远程页面键盘与滚轮输入', 'Remote page keyboard and scroll controls')}>
          <input
            ref={remoteInputRef}
            type="text"
            className="bb-remote-input"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('向当前网页输入文字（支持中文输入法）…', 'Type into the live page (IME supported)…')}
            aria-label={t('向当前网页输入文字', 'Type text into the live webpage')}
            onChange={handleRemoteTextChange}
            onCompositionStart={handleRemoteTextCompositionStart}
            onCompositionEnd={handleRemoteTextCompositionEnd}
            onKeyDown={handleRemoteTextKeyDown}
          />
          <div className="bb-key-strip">
            <button
              type="button"
              className="bb-key-btn"
              onClick={() => handleInput({ kind: 'key', key: 'Enter' })}
              aria-label={t('发送回车键', 'Send Enter key')}
              title="Enter"
            >
              <CornerUpLeft size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="bb-key-btn"
              onClick={() => handleInput({ kind: 'key', key: 'Tab' })}
              title="Tab"
            >
              Tab
            </button>
            <button
              type="button"
              className="bb-key-btn"
              onClick={() => handleInput({ kind: 'key', key: 'Backspace' })}
              aria-label={t('发送退格键', 'Send Backspace key')}
              title="Backspace"
            >
              ⌫
            </button>
            <button
              type="button"
              className="bb-key-btn"
              onClick={() => handleInput({ kind: 'key', key: 'Escape' })}
              title="Escape"
            >
              Esc
            </button>
            {resolvedMode === 'fullscreen' ? (
              <>
                <button
                  type="button"
                  className="bb-key-btn"
                  onClick={() => handleInput({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: -280 })}
                  aria-label={t('向上滚动页面', 'Scroll page up')}
                >
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bb-key-btn"
                  onClick={() => handleInput({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 280 })}
                  aria-label={t('向下滚动页面', 'Scroll page down')}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Footer: mobile thumb action bar OR quiet desktop isolation footer */}
      <footer className={`bb-footer ${resolvedMode === 'fullscreen' ? 'bb-footer--mobile' : ''}`}>
        {resolvedMode === 'fullscreen' ? (
          <div className="bb-footer-mobile-row">
            {!signInTakeover ? <div className="bb-footer-primary">{primaryActionButton}</div> : null}
            <button
              type="button"
              className="bb-btn bb-btn--ghost bb-btn--sm"
              onClick={() => setExternalConfirmOpen(true)}
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>{t('外置引导', 'External')}</span>
            </button>
          </div>
        ) : (
          <div className="bb-footer-desktop-row">
            <button
              type="button"
              className="bb-link-btn"
              onClick={() => setExternalConfirmOpen(true)}
            >
              <ExternalLink size={12} aria-hidden="true" />
              <span>{t('切换外置引导', 'Guide in my browser')}</span>
            </button>
            <span className="bb-isolation-tag" title={t('该浏览器的 Cookie 与存储按 Bot 独立隔离，不等同于 Google API 授权', 'Cookies and storage are isolated per Bot and separate from Google API grants')}>
              <ShieldCheck size={12} aria-hidden="true" />
              <span>{t('仅本 Bot 独立浏览态', 'Isolated per-Bot session')}</span>
            </span>
          </div>
        )}
      </footer>
    </section>
  );
}

export default BotBrowserPanel;
