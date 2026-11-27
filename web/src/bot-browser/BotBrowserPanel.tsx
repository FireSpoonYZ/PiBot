import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CompositionEvent, FormEvent, KeyboardEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronUp,
  Delete,
  Ellipsis,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  Square,
  Unlock,
  X,
} from 'lucide-react';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { InlineBanner, PopoverMenu, type PopoverMenuItem } from '../components/ui';
import { useExternalOverlayPresent, useTopLayerClose } from '../components/ui/Overlay';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import type { GoogleSignInRejectionContext } from '../google/currentGoogleSetup';
import { useText } from '../ui';
import { BotBrowserViewport } from './BotBrowserViewport';
import { useNativeBrowserPresentation } from './nativePresentation';
import type { NativeBrowserPresenter, NativePresentationTarget } from './nativePresentation';
import type { SubscribeBrowserFrames } from './relayStream';
import {
  MAX_TEXT_INPUT_LENGTH,
  POLL_INTERVAL_ACTIVE_MS,
  POLL_INTERVAL_LOCAL_FRAME_MS,
  POLL_INTERVAL_IDLE_MS,
  POLL_INTERVAL_WATCH_MS,
  STREAM_DEGRADE_TIMEOUT_MS,
  ZOOM_STEPS,
  activeTabOf,
  buildBrowserRequest,
  canAcceptManualInput,
  classifyBrowserError,
  classifyClientBrowserUnavailable,
  classifyPageUrl,
  confirmTakeoverLease,
  inspectFrameRedaction,
  isFrameUsableForView,
  normalizeNavigateUrl,
  normalizeWheelDelta,
  parseBrowserFrame,
  parseBrowserView,
  reconcileLeaseWithView,
  resolveExternalGuideUrl,
  type BrowserFrame,
  type BrowserDestination,
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
  destination?: BrowserDestination;
  onDestinationConsumed?: () => void;
  subscribeFrames?: SubscribeBrowserFrames;
  nativePresenter?: NativeBrowserPresenter;
  browserPlacement?: {
    value: 'client' | 'server';
    canChange: boolean;
    set(value: 'client' | 'server'): void;
  };
  onClose?: () => void;
  botName?: string;
  mode?: 'auto' | 'sidebar' | 'fullscreen';
  connected?: boolean;
  onSwitchToExternalGuide?: (
    url?: string,
    reason?: 'google-sign-in-rejected',
    rejection?: GoogleSignInRejectionContext,
  ) => void | Promise<void>;
  onCancelTask?: () => void | Promise<void>;
  className?: string;
}

const MOBILE_MEDIA_QUERY = '(max-width: 860px)';
const MAX_PENDING_BROWSER_INPUTS = 64;

interface BrowserInputTarget {
  botId: string;
  deviceId: string;
  epoch: number;
  sessionId: BrowserView['sessionId'];
  pageId: string;
  revision: number;
  lease: string;
}

interface PendingBrowserInputs {
  target: BrowserInputTarget;
  events: BrowserInputEvent[];
}

function sameBrowserInputTarget(current: BrowserInputTarget | null, target: BrowserInputTarget): boolean {
  return current !== null &&
    current.botId === target.botId && current.deviceId === target.deviceId &&
    current.epoch === target.epoch && current.sessionId === target.sessionId &&
    current.pageId === target.pageId && current.revision === target.revision && current.lease === target.lease;
}

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

function isOlderBrowserView(incoming: BrowserView, current: BrowserView | null): boolean {
  return Boolean(current?.sessionId && incoming.sessionId === current.sessionId && incoming.revision < current.revision);
}

export function BotBrowserPanel({
  botId,
  deviceId,
  request,
  destination,
  onDestinationConsumed,
  subscribeFrames,
  nativePresenter,
  browserPlacement,
  onClose,
  botName,
  mode = 'auto',
  connected = true,
  onSwitchToExternalGuide,
  onCancelTask,
  className,
}: BotBrowserPanelProps) {
  const t = useText();
  const addressErrorId = useId();

  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(readIsMobileViewport);
  const [pageVisible, setPageVisible] = useState<boolean>(readDocumentVisible);
  const [desktopExpanded, setDesktopExpanded] = useState(false);

  const [view, setView] = useState<BrowserView | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [ownedLease, setOwnedLease] = useState<OwnedLease | null>(null);
  const [isHolder, setIsHolder] = useState(false);
  const [pendingAction, setPendingActionState] = useState<PendingControlAction>(null);
  const [attemptedSharedPage, setAttemptedSharedPage] = useState<string | null>(null);
  const consumedDestinationRef = useRef<BrowserDestination | null>(null);
  const [failedDestination, setFailedDestination] = useState<BrowserDestination | null>(null);
  useEffect(() => {
    consumedDestinationRef.current = null;
    setFailedDestination(null);
  }, [botId, deviceId]);

  const [loadingStatus, setLoadingStatus] = useState(true);
  const [streamDegraded, setStreamDegraded] = useState(false);
  const [frameRedacted, setFrameRedacted] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [streamBlocked, setStreamBlocked] = useState<{
    pageId: string; sessionId: string; revision: number; lease: string | undefined;
  } | null>(null);

  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
  const [preemptConfirmOpen, setPreemptConfirmOpen] = useState(false);
  const [externalConfirmOpen, setExternalConfirmOpen] = useState(false);
  const [externalGuideOpening, setExternalGuideOpening] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [nativeStage, setNativeStage] = useState<HTMLDivElement | null>(null);
  const [nativeAttempt, setNativeAttempt] = useState(0);

  const [urlDraft, setUrlDraft] = useState('');
  const [urlEditing, setUrlEditing] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [preferredZoom, setPreferredZoom] = useState<number | null>(null);

  const panelRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const remoteInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const externalGuideRequestRef = useRef<symbol | null>(null);

  const epochRef = useRef(0);
  const browserContextRef = useRef({ botId, deviceId, connected, pageVisible });
  browserContextRef.current = { botId, deviceId, connected, pageVisible };
  const pendingBrowserInputsRef = useRef<PendingBrowserInputs | null>(null);
  const sendingBrowserInputsRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);
  const inFlightPollRef = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const hasRelayStreamRef = useRef(false);
  hasRelayStreamRef.current = Boolean(subscribeFrames);
  const useLegacyFramesRef = useRef(false);
  const pendingStreamFrameRef = useRef<{ frame: BrowserFrame; sessionId: string } | null>(null);

  const viewRef = useRef<BrowserView | null>(null);
  viewRef.current = view;
  const frameRef = useRef<BrowserFrame | null>(null);
  frameRef.current = frame;
  const ownedLeaseRef = useRef<OwnedLease | null>(null);
  ownedLeaseRef.current = ownedLease;
  const isHolderRef = useRef(false);
  isHolderRef.current = isHolder;
  const pendingActionRef = useRef<PendingControlAction>(null);
  const setPendingAction = useCallback((action: PendingControlAction) => {
    pendingActionRef.current = action;
    if (action !== null) pendingBrowserInputsRef.current = null;
    setPendingActionState(action);
  }, []);
  const pendingTakeoverLeaseRef = useRef<string | null>(null);
  const mayReconnectSharedInputRef = useRef(true);
  const lastFrameCursorRef = useRef<FrameCursor | null>(null);
  const streamFailSinceRef = useRef<number | null>(null);
  const streamDegradedRef = useRef(false);
  streamDegradedRef.current = streamDegraded;
  const urlEditingRef = useRef(false);
  urlEditingRef.current = urlEditing;

  const nativePageId = view?.pageId;
  const nativeSessionId = view?.sessionId;
  const nativeRendererId = view?.rendererId;
  const canPresentNative = Boolean(nativePresenter && connected && pageVisible && view?.available &&
    view.nativePresentation && view.phase === 'human' && isHolder);
  const nativeLease = ownedLease && ownedLease.pageId === nativePageId &&
    ownedLease.sessionId === (nativeSessionId ?? null) && ownedLease.revision === view?.revision
    ? ownedLease.lease : undefined;
  const nativeTarget = useMemo<NativePresentationTarget | null>(() =>
    canPresentNative && nativePageId && nativeLease
      ? { botId, deviceId, sessionId: nativeSessionId, pageId: nativePageId, lease: nativeLease, rendererId: nativeRendererId }
      : null,
  [botId, deviceId, canPresentNative, nativePageId, nativeSessionId, nativeRendererId, nativeLease]);
  const externalOverlayVisible = useExternalOverlayPresent(canPresentNative, panelRef);
  const nativeReady = useNativeBrowserPresentation({
    presenter: nativePresenter,
    target: nativeTarget,
    stage: nativeStage,
    requestRef,
    suspended:
      moreOpen ||
      preemptConfirmOpen ||
      externalConfirmOpen ||
      externalGuideOpening ||
      pendingAction !== null ||
      externalOverlayVisible,
    attempt: nativeAttempt,
  });
  const nativeReadyRef = useRef(nativeReady);
  nativeReadyRef.current = nativeReady;
  const wasNativeReadyRef = useRef(false);

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
    frameRef.current = null;
    setFrame(null);
    lastFrameCursorRef.current = null;
  }, []);

  const acceptFrame = useCallback((nextFrame: BrowserFrame): boolean => {
    if (nativeReadyRef.current) return false;
    const currentView = viewRef.current;
    if (!isFrameUsableForView(nextFrame, currentView, lastFrameCursorRef.current)) return false;
    const urlInfo = classifyPageUrl(activeTabOf(currentView)?.url);
    if (!isHolderRef.current && (currentView?.sensitive || urlInfo.isKnownSensitiveUrl)) {
      return false;
    }
    lastFrameCursorRef.current = { pageId: nextFrame.pageId, revision: nextFrame.revision, seq: nextFrame.seq };
    frameRef.current = nextFrame;
    setFrame(nextFrame);
    setFrameRedacted(false);
    streamFailSinceRef.current = null;
    if (streamDegradedRef.current) setStreamDegraded(false);
    return true;
  }, []);

  const clearLocalLease = useCallback(() => {
    pendingBrowserInputsRef.current = null;
    ownedLeaseRef.current = null;
    pendingTakeoverLeaseRef.current = null;
    isHolderRef.current = false;
    setOwnedLease(null);
    setIsHolder(false);
  }, []);

  const applyViewState = useCallback(
    (nextView: BrowserView): { nextLease: OwnedLease | null; nextIsHolder: boolean } => {
      const prevView = viewRef.current;
      const wasHolder = isHolderRef.current;
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
      if (nextIsHolder && nextView.sharedInput) {
        mayReconnectSharedInputRef.current = false;
        if (!wasHolder) {
          setNoticeBanner(null);
          setPreemptConfirmOpen(false);
        }
      }

      const activeTab = activeTabOf(nextView);
      const urlInfo = classifyPageUrl(activeTab?.url);
      const nextSensitive = Boolean(nextView.sensitive || urlInfo.isKnownSensitiveUrl);
      const targetChanged = prevView?.pageId !== nextView.pageId || prevView?.revision !== nextView.revision ||
        prevView?.sessionId !== nextView.sessionId;
      if (!nextIsHolder || targetChanged) {
        pendingBrowserInputsRef.current = null;
      }

      // Clear cached frame immediately if unavailable, sensitive bystander, or page/revision changed.
      if (
        !nextView.available ||
        !nextView.canStreamInteract ||
        !nextView.pageId ||
        (nextSensitive && !nextIsHolder) ||
        targetChanged
      ) {
        clearCachedFrame();
      }

      if (!nextView.available || !nextView.canStreamInteract || !nextView.pageId) {
        pendingStreamFrameRef.current = null;
      }

      if (!nextView.available || !nextView.canStreamInteract) {
        streamFailSinceRef.current = null;
        setFrameRedacted(false);
      } else if (prevView && (!prevView.available || !prevView.canStreamInteract)) {
        streamDegradedRef.current = false;
        setStreamDegraded(false);
      }

      if (!urlEditingRef.current) {
        setUrlDraft(activeTab?.url ?? '');
      }

      viewRef.current = nextView;
      setView(nextView);
      setLoadingStatus(false);
      const pending = pendingStreamFrameRef.current;
      if (pending && (pending.sessionId !== nextView.sessionId || pending.frame.pageId !== nextView.pageId ||
          pending.frame.revision <= nextView.revision)) {
        pendingStreamFrameRef.current = null;
        if (pending.sessionId === nextView.sessionId) acceptFrame(pending.frame);
      }
      return { nextLease, nextIsHolder };
    },
    [acceptFrame, clearCachedFrame, t],
  );

  // Full session reset whenever botId or deviceId changes, or on unmount.
  // Never sends handback on switch/unmount — Host maintains safe hold semantics.
  useEffect(() => {
    epochRef.current += 1;
    clearPollTimer();
    inFlightPollRef.current = false;
    clearCachedFrame();
    clearLocalLease();
    mayReconnectSharedInputRef.current = true;
    viewRef.current = null;
    pendingStreamFrameRef.current = null;
    useLegacyFramesRef.current = false;
    streamFailSinceRef.current = null;
    composingRef.current = false;
    if (remoteInputRef.current) remoteInputRef.current.value = '';

    setView(null);
    setPendingAction(null);
    setAttemptedSharedPage(null);
    setLoadingStatus(true);
    setStreamDegraded(false);
    setFrameRedacted(false);
    setStreamBlocked(null);
    setErrorBanner(null);
    setNoticeBanner(null);
    setUrlError(null);
    setPreemptConfirmOpen(false);
    setExternalConfirmOpen(false);
    setExternalGuideOpening(false);
    setMoreOpen(false);
    setUrlDraft('');
    setUrlEditing(false);
    setPreferredZoom(null);

    return () => {
      externalGuideRequestRef.current = null;
      epochRef.current += 1;
      clearPollTimer();
      clearCachedFrame();
      clearLocalLease();
    };
  }, [botId, deviceId, clearPollTimer, clearCachedFrame, clearLocalLease, setPendingAction]);

  const scheduleNextPollRef = useRef<(delayMs?: number) => void>(() => {});

  const pollOnce = useCallback(
    async (epoch: number) => {
      if (inFlightPollRef.current || epoch !== epochRef.current) return;
      inFlightPollRef.current = true;
      let nextDelay = POLL_INTERVAL_IDLE_MS;

      try {
        const lease = ownedLeaseRef.current?.lease ?? pendingTakeoverLeaseRef.current;
        const rawStatus = await requestRef.current(buildBrowserRequest('status', { botId, lease }));
        if (epoch !== epochRef.current) return;
        // Holder status belongs to the token sent with this poll, which may have rotated in flight.
        if (lease !== (ownedLeaseRef.current?.lease ?? pendingTakeoverLeaseRef.current)) {
          nextDelay = POLL_INTERVAL_ACTIVE_MS;
          return;
        }

        const parsedView = parseBrowserView(rawStatus);
        if (!parsedView) {
          setLoadingStatus(false);
          setErrorBanner(t('无法识别 Host 返回的浏览器状态。', 'Unrecognized browser status from target host.'));
          return;
        }
        if (isOlderBrowserView(parsedView, viewRef.current)) {
          nextDelay = POLL_INTERVAL_ACTIVE_MS;
          return;
        }

        const { nextLease, nextIsHolder } = applyViewState(parsedView);
        const currentTab = activeTabOf(parsedView);
        const urlMeta = classifyPageUrl(currentTab?.url);
        const isSensitiveNow = Boolean(parsedView.sensitive || urlMeta.isKnownSensitiveUrl);
        const shouldFetchFrame =
          !nativeReadyRef.current && parsedView.available &&
          parsedView.canStreamInteract &&
          Boolean(parsedView.pageId) &&
          !(isSensitiveNow && !nextIsHolder) &&
          (!hasRelayStreamRef.current || !parsedView.sessionId || useLegacyFramesRef.current) &&
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
            if (epoch !== epochRef.current || nativeReadyRef.current) return;

            const redaction = inspectFrameRedaction(rawFrame);
            if (redaction.redacted) {
              clearCachedFrame();
              setFrameRedacted(true);
              streamFailSinceRef.current = null;
            } else {
              const parsedFrame = parseBrowserFrame(rawFrame);
              if (!parsedFrame || !acceptFrame(parsedFrame)) {
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
            if (epoch !== epochRef.current || nativeReadyRef.current) return;
            const classified = classifyBrowserError(frameErr);
            if (classified.sensitiveBlocked) {
              clearCachedFrame();
              setFrameRedacted(true);
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

        if (nativeReadyRef.current || (parsedView.available && parsedView.canStreamInteract && !streamDegradedRef.current)) {
          if (nextIsHolder || parsedView.phase === 'taking') {
            nextDelay = shouldFetchFrame ? POLL_INTERVAL_LOCAL_FRAME_MS : POLL_INTERVAL_ACTIVE_MS;
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
    [botId, acceptFrame, applyViewState, clearCachedFrame, t],
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

  useEffect(() => {
    if (nativeReady) {
      pendingBrowserInputsRef.current = null;
      pendingStreamFrameRef.current = null;
      streamFailSinceRef.current = null;
      streamDegradedRef.current = false;
      setStreamDegraded(false);
      clearCachedFrame();
    } else if (wasNativeReadyRef.current && connected && pageVisible) {
      schedulePoll(0);
    }
    wasNativeReadyRef.current = nativeReady;
  }, [nativeReady, connected, pageVisible, clearCachedFrame, schedulePoll]);

  // Start/stop polling strictly with connected + pageVisible; clear cached frame when paused.
  // Never auto-handback on disconnect or background!
  useEffect(() => {
    epochRef.current += 1;
    pendingBrowserInputsRef.current = null;
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
      pendingBrowserInputsRef.current = null;
      clearPollTimer();
    };
  }, [botId, deviceId, connected, pageVisible, clearPollTimer, clearCachedFrame, schedulePoll, setPendingAction]);

  const streamPage = view?.pageId;
  const streamSession = view?.sessionId;
  const streamLease = isHolder ? ownedLease?.lease : undefined;
  const streamUrlInfo = classifyPageUrl(activeTabOf(view)?.url);
  const streamAllowed = Boolean(!nativeReady && view?.available && view?.canStreamInteract &&
    (!(view.sensitive || streamUrlInfo.isKnownSensitiveUrl) || streamLease) &&
    !(streamBlocked && streamBlocked.sessionId === streamSession && streamBlocked.pageId === streamPage &&
      streamBlocked.lease === streamLease && streamBlocked.revision === view.revision));

  useEffect(() => {
    if (!subscribeFrames || !connected || !pageVisible || !streamAllowed || !streamPage || !streamSession ||
        useLegacyFramesRef.current) return;

    let active = true;
    let dispose: (() => void) | undefined;
    let retry: number | undefined;
    const epoch = epochRef.current;
    const onError = (error: unknown) => {
      if (!active || epoch !== epochRef.current || nativeReadyRef.current) return;
      active = false;
      dispose?.();
      pendingStreamFrameRef.current = null;
      clearCachedFrame();
      const detail = classifyBrowserError(error);
      if (detail.code === 'CONTROL_UNAVAILABLE') {
        useLegacyFramesRef.current = true;
        streamDegradedRef.current = false;
        setStreamDegraded(false);
      } else if (detail.sensitiveBlocked) {
        setFrameRedacted(true);
        setStreamBlocked({
          pageId: streamPage, sessionId: streamSession, lease: streamLease, revision: viewRef.current?.revision ?? -1,
        });
      } else {
        if (!detail.staleState) setStreamDegraded(true);
        // Retry transient link or navigation changes. No input is replayed.
        if (detail.staleState || ['BACKPRESSURE', 'DISCONNECTED', 'NETWORK', 'TIMEOUT'].includes(detail.code)) {
          retry = window.setTimeout(() => setStreamAttempt((attempt) => attempt + 1), detail.staleState ? 400 : 2000);
        }
      }
      schedulePoll(0);
    };

    try {
      dispose = subscribeFrames({
        pageId: streamPage,
        sessionId: streamSession,
        ...(streamLease ? { lease: streamLease } : {}),
      }, {
        onFrame: (raw) => {
          const currentView = viewRef.current;
          if (!active || epoch !== epochRef.current || nativeReadyRef.current || currentView?.sessionId !== streamSession ||
              currentView.pageId !== streamPage || (ownedLeaseRef.current?.lease ?? undefined) !== streamLease) return;
          const nextFrame = parseBrowserFrame(raw);
          if (!nextFrame || nextFrame.pageId !== streamPage || acceptFrame(nextFrame)) return;
          if (nextFrame.revision > currentView.revision) {
            const needsStatus = pendingStreamFrameRef.current?.frame.revision !== nextFrame.revision;
            pendingStreamFrameRef.current = { frame: nextFrame, sessionId: streamSession };
            if (needsStatus) schedulePoll(0);
          }
        },
        onError,
      });
      if (!active) dispose();
    } catch (error) {
      onError(error);
    }

    return () => {
      active = false;
      dispose?.();
      if (retry !== undefined) window.clearTimeout(retry);
      pendingStreamFrameRef.current = null;
    };
  }, [subscribeFrames, connected, pageVisible, streamAllowed, streamPage, streamSession, streamLease,
    streamAttempt, acceptFrame, clearCachedFrame, schedulePoll]);

  const handleRetry = useCallback(() => {
    setErrorBanner(null);
    setAttemptedSharedPage(null);
    streamDegradedRef.current = false;
    setStreamDegraded(false);
    setFrameRedacted(false);
    streamFailSinceRef.current = null;
    useLegacyFramesRef.current = false;
    setStreamBlocked(null);
    setStreamAttempt((attempt) => attempt + 1);
    setNativeAttempt((attempt) => attempt + 1);
    schedulePoll(0);
  }, [schedulePoll]);

  const handleTakeover = useCallback(
    async (options?: { force?: boolean; shared?: boolean; automatic?: boolean }) => {
      if (!connected || pendingActionRef.current !== null) return;
      const currentView = viewRef.current;
      const epoch = epochRef.current;
      const shared = options?.shared === true;
      const automatic = options?.automatic === true;
      const failureMessage = shared
        ? t('无法在本机启用页面操作，请重试。', 'Could not enable input on this device. Please retry.')
        : t('接管失败，请稍后重试。', 'Failed to take over control. Please retry.');
      setPendingAction(shared ? 'sharing' : 'taking');
      if (!automatic) {
        setErrorBanner(null);
        setNoticeBanner(null);
        setPreemptConfirmOpen(false);
      }

      try {
        const res = await requestRef.current(
          buildBrowserRequest('takeover', {
            botId,
            pageId: currentView?.pageId,
            revision: currentView?.revision,
            force: options?.force === true,
            shared,
          }),
        );
        if (epoch !== epochRef.current) return;

        const nextView = parseBrowserView(res);
        const latestView = viewRef.current;
        const rawLease = extractRawLease(res);
        if (shared && rawLease) mayReconnectSharedInputRef.current = false;
        if (latestView && ((nextView && nextView.revision < latestView.revision) ||
            (latestView.sessionId !== currentView?.sessionId &&
              (!nextView || latestView.sessionId !== nextView.sessionId)))) {
          // An earlier grant can be verified only while the newer view still shows the same session in human control.
          if (rawLease && !ownedLeaseRef.current && latestView.phase === 'human' &&
              nextView && latestView.sessionId === nextView.sessionId) {
            pendingTakeoverLeaseRef.current = rawLease;
          }
          schedulePoll(0);
          return;
        }

        if (nextView) {
          const confirmed = confirmTakeoverLease(nextView, rawLease);
          if (confirmed) {
            ownedLeaseRef.current = confirmed;
            pendingTakeoverLeaseRef.current = null;
            applyViewState(nextView);
            streamDegradedRef.current = false;
            setStreamDegraded(false);
            streamFailSinceRef.current = null;
            schedulePoll(0);
            return;
          }

          if (!shared && nextView.phase === 'taking') {
            pendingTakeoverLeaseRef.current = rawLease ?? nextView.lease ?? null;
            viewRef.current = nextView;
            setView(nextView);
            schedulePoll(180);
            return;
          }

          applyViewState(nextView);
          if (!automatic) setErrorBanner(nextView.reason || failureMessage);
          schedulePoll(150);
          return;
        }

        // Minimal response containing only { lease } -> verify via immediate status poll before unlocking.
        if (rawLease) {
          pendingTakeoverLeaseRef.current = rawLease;
          schedulePoll(0);
          return;
        }

        if (!automatic) setErrorBanner(failureMessage);
        schedulePoll(150);
      } catch (err) {
        if (epoch !== epochRef.current) return;
        const classified = classifyBrowserError(err);
        if (!automatic) setErrorBanner(classified.message || failureMessage);
        schedulePoll(150);
      } finally {
        if (epoch === epochRef.current) {
          setPendingAction(null);
        }
      }
    },
    [botId, connected, applyViewState, schedulePoll, setPendingAction, t],
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
      clearLocalLease();
      if (nextView) applyViewState(nextView);
      schedulePoll(0);
    } catch (err) {
      if (epoch !== epochRef.current) return;
      const classified = classifyBrowserError(err);
      if (classified.invalidatesLease) clearLocalLease();
      setErrorBanner(
        classified.sensitiveBlocked
          ? t('请更新目标 Host 后再交还。', 'Update the target host before handing back.')
          : classified.message || t('交还失败，请重试。', 'Failed to hand back control. Please retry.'),
      );
      schedulePoll(150);
    } finally {
      if (epoch === epochRef.current) {
        setPendingAction(null);
      }
    }
  }, [botId, connected, clearLocalLease, applyViewState, schedulePoll, setPendingAction, t]);

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
    [botId, connected, clearLocalLease, applyViewState, onCancelTask, schedulePoll, setPendingAction, t],
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
        return nextView;
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
    [botId, connected, clearCachedFrame, clearLocalLease, applyViewState, schedulePoll, setPendingAction, t],
  );

  useEffect(() => {
    const requestedDestination = destination ?? failedDestination;
    if (!requestedDestination || consumedDestinationRef.current === requestedDestination || !connected || !pageVisible ||
        !view?.available || viewRef.current !== view || pendingAction !== null ||
        (view.phase !== 'bot' && !(view.phase === 'human' && isHolder))) return;
    consumedDestinationRef.current = requestedDestination;
    onDestinationConsumed?.();
    const epoch = epochRef.current;
    const target = view.tabs.find(tab => tab.id === requestedDestination.pageId) ??
      view.tabs.find(tab => tab.url === requestedDestination.url);
    void (async () => {
      let completed = false;
      if (!target) {
        completed = Boolean(await runPageAction('tab', 'open', { pageId: null, url: requestedDestination.url }));
      } else {
        const selected = view.pageId === target.id ? view : await runPageAction('tab', 'select', { pageId: target.id });
        if (epoch !== epochRef.current) return;
        if (selected?.pageId === target.id) {
          completed = target.url === requestedDestination.url ||
            Boolean(await runPageAction('navigating', 'navigate', { pageId: target.id, url: requestedDestination.url }));
        }
      }
      if (epoch === epochRef.current) setFailedDestination(completed ? null : requestedDestination);
    })();
  }, [destination, failedDestination, connected, pageVisible, view, pendingAction, isHolder, onDestinationConsumed, runPageAction]);

  const currentTab = useMemo(() => activeTabOf(view), [view]);
  const urlMeta = useMemo(() => classifyPageUrl(currentTab?.url), [currentTab?.url]);
  const isSensitive = Boolean(view?.sensitive || urlMeta.isKnownSensitiveUrl);
  const frameRestricted = frameRedacted || (isSensitive && !isHolder);
  const allowsSharedInput = Boolean(view?.supportsSharedInput && !isSensitive && !frameRedacted &&
    !urlMeta.isCloudSecretArea && !view.attentionRequested && !view.fallbackToSystemBrowser);
  const canReconnectSharedInput = allowsSharedInput && view?.sharedInput && view.isHolder === true && !isHolder;
  const canAcquireSharedInput = view?.phase === 'bot' ||
    (canReconnectSharedInput && mayReconnectSharedInputRef.current);
  const sharedPage = connected && pageVisible && allowsSharedInput && view?.available &&
    (view.canStreamInteract || (nativePresenter && view.nativePresentation)) &&
    view.pageId && currentTab?.id === view.pageId && canAcquireSharedInput
    ? JSON.stringify([botId, deviceId, view.sessionId, view.pageId, view.phase])
    : null;

  useEffect(() => {
    if (!sharedPage) {
      if (attemptedSharedPage !== null) setAttemptedSharedPage(null);
      return;
    }
    if (attemptedSharedPage === sharedPage || pendingAction !== null || pendingActionRef.current !== null ||
        viewRef.current !== view || pendingTakeoverLeaseRef.current || !readDocumentVisible()) return;

    setAttemptedSharedPage(sharedPage);
    if (view?.phase === 'human') mayReconnectSharedInputRef.current = false;
    void handleTakeover({ shared: true, automatic: true });
  }, [sharedPage, attemptedSharedPage, pendingAction, view, handleTakeover]);

  const zoomForSignIn = resolvedMode === 'fullscreen' && isMobileViewport && isHolder && urlMeta.isGoogleAuth;
  const zoom = preferredZoom ?? (zoomForSignIn ? 2 : 1);

  const canShowStream = !nativeReady && connected && pageVisible && view?.available &&
    view.canStreamInteract && !streamDegraded && !frameRestricted;
  const liveFrame = canShowStream && isFrameUsableForView(frame, view) ? frame : null;

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

  const readBrowserInputTarget = useCallback((): BrowserInputTarget | null => {
    if (nativeReadyRef.current) return null;
    const context = browserContextRef.current;
    const currentView = viewRef.current;
    const currentLease = ownedLeaseRef.current;
    const currentFrame = isFrameUsableForView(frameRef.current, currentView) ? frameRef.current : null;
    if (
      !currentView?.pageId || !currentLease ||
      !canAcceptManualInput({
        connected: context.connected,
        visible: context.pageVisible && readDocumentVisible(),
        view: currentView,
        ownedLease: currentLease,
        isHolder: isHolderRef.current,
        pendingAction: pendingActionRef.current,
        liveFrame: currentFrame,
        streamDegraded: streamDegradedRef.current,
      })
    ) {
      return null;
    }
    return {
      botId: context.botId,
      deviceId: context.deviceId,
      epoch: epochRef.current,
      sessionId: currentView.sessionId,
      pageId: currentView.pageId,
      revision: currentView.revision,
      lease: currentLease.lease,
    };
  }, []);

  const drainBrowserInputs = useCallback(async () => {
    if (sendingBrowserInputsRef.current) return;
    sendingBrowserInputsRef.current = true;
    try {
      while (pendingBrowserInputsRef.current) {
        const batch = pendingBrowserInputsRef.current;
        const { target, events } = batch;
        const event = events.shift();
        if (!event || !sameBrowserInputTarget(readBrowserInputTarget(), target)) {
          pendingBrowserInputsRef.current = null;
          continue;
        }

        try {
          const res = await requestRef.current(buildBrowserRequest('input', {
            botId: target.botId,
            pageId: target.pageId,
            lease: target.lease,
            revision: target.revision,
            event,
          }));
          if (pendingBrowserInputsRef.current !== batch || !sameBrowserInputTarget(readBrowserInputTarget(), target)) {
            continue;
          }
          const nextView = parseBrowserView(res);
          if (nextView) {
            applyViewState(nextView);
          } else if (res?.ok !== true) {
            throw new Error(t('Host 未返回有效的输入确认。', 'Host did not return a valid input acknowledgement.'));
          }
        } catch (err) {
          if (pendingBrowserInputsRef.current !== batch || !sameBrowserInputTarget(readBrowserInputTarget(), target)) {
            continue;
          }
          // Later keystrokes or clicks may depend on this input's result. Discard them on failure.
          pendingBrowserInputsRef.current = null;
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
        }
      }
    } finally {
      sendingBrowserInputsRef.current = false;
    }
  }, [applyViewState, clearCachedFrame, clearLocalLease, readBrowserInputTarget, schedulePoll, t]);

  const handleInput = useCallback((event: BrowserInputEvent) => {
    const target = readBrowserInputTarget();
    if (!target) return;

    let batch = pendingBrowserInputsRef.current;
    if (!batch || !sameBrowserInputTarget(target, batch.target)) {
      batch = { target, events: [] };
      pendingBrowserInputsRef.current = batch;
    }
    const previous = batch.events.at(-1);
    if (event.kind === 'wheel' && previous?.kind === 'wheel') {
      const delta = normalizeWheelDelta(previous.deltaX + event.deltaX, previous.deltaY + event.deltaY, 0);
      if (delta.deltaX === 0 && delta.deltaY === 0) {
        batch.events.pop();
      } else {
        batch.events[batch.events.length - 1] = { ...event, ...delta };
      }
    } else if (batch.events.length < MAX_PENDING_BROWSER_INPUTS) {
      batch.events.push(event);
    } else if (event.kind !== 'wheel') {
      setErrorBanner(t('待发送的输入过多。请等当前输入完成。', 'Too much input pending. Wait for the current inputs to finish.'));
    }
    void drainBrowserInputs();
  }, [drainBrowserInputs, readBrowserInputTarget, t]);

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
      if (ev.key === 'Escape') ev.stopPropagation();
      handleInput({ kind: 'key', key: ev.key });
    } else if (ev.key === 'Backspace' && ev.currentTarget.value.length === 0) {
      ev.preventDefault();
      handleInput({ kind: 'key', key: 'Backspace' });
    }
  };

  const canNavigateBase =
    connected &&
    pageVisible &&
    Boolean(view?.available && (view.canStreamInteract || view.nativePresentation) && view.pageId) &&
    view?.phase === 'human' &&
    isHolder;
  const canNavigate = canNavigateBase && pendingAction === null;

  const handleUrlSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (!canNavigate) return;
    const normalized = normalizeNavigateUrl(urlDraft);
    if (!normalized.ok) {
      const msg = normalized.reason === 'disallowed_scheme'
        ? t('仅支持 http:// 或 https:// 网址。', 'Only http:// and https:// URLs are allowed.')
        : t('请输入有效的网址。', 'Enter a valid web address.');
      setUrlError(msg);
      setErrorBanner(msg);
      return;
    }
    setUrlError(null);
    setErrorBanner(null);
    setUrlEditing(false);
    setUrlDraft(normalized.url);
    void runPageAction('navigating', 'navigate', { url: normalized.url });
  };

  const handleRequestExternalGuide = () => {
    if (externalGuideRequestRef.current === null) setExternalConfirmOpen(true);
  };

  const handleOpenExternalGuide = async (expectedReason?: 'google-sign-in-rejected') => {
    if (externalGuideRequestRef.current !== null) return;
    const currentView = expectedReason ? view : viewRef.current;
    const currentTab = activeTabOf(currentView);
    const reason = classifyPageUrl(currentTab?.url).isGoogleSignInRejected
      ? 'google-sign-in-rejected'
      : undefined;
    if (expectedReason && reason !== expectedReason) return;

    const openingRequest = Symbol();
    externalGuideRequestRef.current = openingRequest;
    const rejection: GoogleSignInRejectionContext | undefined = reason ? {
      pageId: currentView?.pageId === currentTab?.id ? currentView?.pageId : undefined,
      isCurrent: () => {
        const context = browserContextRef.current;
        const liveView = viewRef.current;
        const liveTab = activeTabOf(liveView);
        const pending = pendingActionRef.current;
        return externalGuideRequestRef.current === openingRequest &&
          context.botId === botId && context.deviceId === deviceId && context.connected &&
          pending !== 'navigating' && pending !== 'tab' &&
          liveView?.sessionId === currentView?.sessionId && liveView?.pageId === currentView?.pageId &&
          liveView?.revision === currentView?.revision && liveTab?.id === currentTab?.id &&
          classifyPageUrl(liveTab?.url).isGoogleSignInRejected;
      },
    } : undefined;
    if (rejection && !rejection.isCurrent()) {
      externalGuideRequestRef.current = null;
      return;
    }
    setExternalConfirmOpen(false);
    setExternalGuideOpening(true);
    setErrorBanner(null);
    try {
      const candidateUrl = resolveExternalGuideUrl(currentView);
      if (onSwitchToExternalGuide) {
        await onSwitchToExternalGuide(candidateUrl, reason, rejection);
      } else {
        await openExternalUrl(candidateUrl);
      }
    } catch {
      if (externalGuideRequestRef.current === openingRequest && (!rejection || rejection.isCurrent())) {
        setErrorBanner(t('无法在系统浏览器中继续。请重试。', 'Could not continue in your system browser. Try again.'));
      }
    } finally {
      if (externalGuideRequestRef.current === openingRequest) {
        externalGuideRequestRef.current = null;
        setExternalGuideOpening(false);
      }
    }
  };

  const handlePanelKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.defaultPrevented) return;
    if (
      ev.key === 'Escape' &&
      resolvedMode === 'fullscreen' &&
      onClose &&
      !moreOpen &&
      !preemptConfirmOpen &&
      !externalConfirmOpen &&
      !urlEditing
    ) {
      // Only close fullscreen drawer on Escape when remote canvas/input isn't consuming Escape.
      const target = ev.target as HTMLElement | null;
      const isRemoteInput = Boolean(
        target?.closest('.bb-stage--interactive, .bb-remote-input'),
      );
      if (!isRemoteInput) {
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      }
    }
  };

  const stepZoom = (delta: 1 | -1) => {
    const next = delta > 0
      ? ZOOM_STEPS.find((level) => level > zoom + 0.01)
      : ZOOM_STEPS.filter((level) => level < zoom - 0.01).at(-1);
    if (next !== undefined) setPreferredZoom(next);
  };

  const isHeld = view?.phase === 'held';
  const isOtherHolder = Boolean(view?.phase === 'human' && !isHolder);

  // LIFO Escape & Android app-back dismissal for local browser inline confirmations & URL editing
  // BEFORE exiting the fullscreen browser panel or desktop browser dialog.
  useTopLayerClose(urlEditing, {
    kind: 'floating',
    getElement: () => addressInputRef.current,
    onClose: () => {
      setUrlEditing(false);
      setUrlError(null);
      setUrlDraft(activeTabOf(viewRef.current)?.url ?? '');
      addressInputRef.current?.blur();
    },
  });

  useTopLayerClose(preemptConfirmOpen && isOtherHolder, {
    kind: 'floating',
    getElement: () => panelRef.current,
    onClose: () => setPreemptConfirmOpen(false),
  });

  useTopLayerClose(externalConfirmOpen, {
    kind: 'floating',
    getElement: () => panelRef.current,
    onClose: () => setExternalConfirmOpen(false),
  });

  // In fullscreen mobile mode, Android hardware Back navigates browser history when available
  // while deferring to any open local floating overlay/popover in LIFO order.
  const hasLocalBrowserOverlay =
    moreOpen || urlEditing || (preemptConfirmOpen && isOtherHolder) || externalConfirmOpen;
  const canHardwareBackNavigateHistory =
    resolvedMode === 'fullscreen' &&
    canNavigateBase &&
    (pendingAction === null || pendingAction === 'navigating') &&
    view?.canGoBack === true &&
    !hasLocalBrowserOverlay;
  const runPageActionRef = useRef(runPageAction);
  runPageActionRef.current = runPageAction;

  useEffect(() => {
    if (!canHardwareBackNavigateHistory) return;
    return registerOverlayBackHandler(() => {
      void runPageActionRef.current('navigating', 'back');
    });
  }, [canHardwareBackNavigateHistory]);
  const isTaking = pendingAction === 'taking' || view?.phase === 'taking';
  const isConnectingSharedInput = pendingAction === 'sharing' ||
    Boolean(sharedPage && attemptedSharedPage !== sharedPage && pendingAction === null);
  const canRetrySharedInput = canReconnectSharedInput || (sharedPage !== null && attemptedSharedPage === sharedPage);
  const isHandingBack = pendingAction === 'handing-back';
  const supportsNative = Boolean(nativePresenter && view?.nativePresentation);
  const isAvailableInteractive = Boolean(
    connected && view?.available && (supportsNative || (view.canStreamInteract && !streamDegraded)),
  );
  const signInTakeover = isAvailableInteractive && pageVisible && Boolean(view?.pageId) &&
    isSensitive && urlMeta.isGoogleAuth && !urlMeta.isGoogleSignInRejected && !isHolder &&
    !view?.fallbackToSystemBrowser && !frameRedacted;
  const showExternalRecovery = connected && pageVisible && !externalConfirmOpen &&
    (urlMeta.isGoogleSignInRejected || (frameRestricted && view?.fallbackToSystemBrowser));
  const clientUnavailableKind = classifyClientBrowserUnavailable(view);
  const canRetry = connected && !nativeReady &&
    (view ? !view.available || !view.canStreamInteract || streamDegraded : !loadingStatus);

  // Concise, honest status pill label & semantic tone.
  const statusInfo = (() => {
    if (!connected) {
      return { tone: 'muted', text: t('连接已断开', 'Disconnected'), spinning: false };
    }
    if (!view && loadingStatus) {
      return { tone: 'muted', text: t('连接中…', 'Connecting…'), spinning: true };
    }
    if (!isAvailableInteractive || !view) {
      if (clientUnavailableKind === 'window-closed') {
        return { tone: 'warn', text: t('桌面浏览器窗口已关闭', 'Desktop browser window closed'), spinning: false };
      }
      if (clientUnavailableKind === 'disconnected') {
        return { tone: 'warn', text: t('桌面浏览器暂未连上', 'Desktop browser disconnected'), spinning: false };
      }
      return { tone: 'warn', text: t('实时浏览不可用', 'Live view unavailable'), spinning: false };
    }
    if (isHandingBack) {
      return { tone: 'muted', text: t('正在交还…', 'Handing back…'), spinning: true };
    }
    if (isConnectingSharedInput) {
      return { tone: 'muted', text: t('正在连接页面…', 'Connecting to page…'), spinning: true };
    }
    if (isTaking) {
      return { tone: 'warn', text: t('正在接管…', 'Taking over…'), spinning: true };
    }
    if (isHeld || (view.phase === 'bot' && isSensitive)) {
      return { tone: 'warn', text: t('Bot 已暂停', 'Bot paused'), spinning: false };
    }
    if (view.phase === 'human' && isHolder) {
      if (view.sharedInput) {
        if (nativeReady || canSendInput) {
          return { tone: 'active', text: t('可直接操作', 'Ready for input'), spinning: false };
        }
        if (frameRestricted) {
          return { tone: 'warn', text: t('画面受保护', 'View protected'), spinning: false };
        }
        if (streamDegraded) {
          return { tone: 'warn', text: t('实时浏览不可用', 'Live view unavailable'), spinning: false };
        }
        return { tone: 'muted', text: t('正在获取画面…', 'Waiting for live view…'), spinning: true };
      }
      return { tone: 'active', text: t('已接管', 'In control'), spinning: false };
    }
    if (canRetrySharedInput) {
      return { tone: 'muted', text: t('页面操作待连接', 'Page input disconnected'), spinning: false };
    }
    if (isOtherHolder) {
      const label = view.holderLabel || t('其他设备', 'another device');
      return {
        tone: 'muted',
        text: view.sharedInput
          ? t(`${label} 正在操作`, `${label} is operating this page`)
          : t(`正在 ${label} 接管中`, `Controlled by ${label}`),
        spinning: false,
      };
    }
    if (view.attentionRequested) {
      return { tone: 'warn', text: t('Bot 请求你接管', 'Bot requests takeover'), spinning: false };
    }
    if (!view.pageId && view.tabs.length === 0) {
      return { tone: 'muted', text: t('没有打开的标签页', 'No open tabs'), spinning: false };
    }
    if (canShowStream && view.pageId && !liveFrame) {
      return { tone: 'muted', text: t('正在获取画面…', 'Waiting for live view…'), spinning: true };
    }
    return { tone: 'bot', text: t('Bot 协助中', 'Bot active'), spinning: false };
  })();

  const panelClasses = [
    'bb-panel',
    resolvedMode === 'fullscreen' ? 'bb-panel--fullscreen' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const hasOpenBrowserPage = Boolean(view?.pageId || view?.tabs.length);
  const canChangeBrowserPlacement = Boolean(browserPlacement?.canChange && connected && view &&
    !hasOpenBrowserPage && pendingAction === null);

  const navigationButtons = [
    { action: 'back', label: t('后退', 'Back'), Icon: ArrowLeft, available: view?.canGoBack !== false },
    { action: 'forward', label: t('前进', 'Forward'), Icon: ArrowRight, available: view?.canGoForward !== false },
    { action: 'reload', label: t('刷新', 'Reload'), Icon: RefreshCw, available: true },
  ] as const;
  const remoteKeys = [
    { key: 'Enter', label: t('回车', 'Enter') },
    { key: 'Tab', label: 'Tab' },
    { key: 'Backspace', label: t('退格', 'Backspace'), CompactIcon: Delete },
    { key: 'Escape', label: 'Esc' },
  ];

  const primaryActionButton = (() => {
    if (!isAvailableInteractive || isHeld || isConnectingSharedInput) return null;

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
      if (view.sharedInput) return null;
      return (
        <button
          type="button"
          className="bb-btn bb-btn--primary"
          disabled={pendingAction !== null}
          onClick={() => void handleHandback()}
        >
          <Bot size={16} aria-hidden="true" />
          <span>{t('交还给 Bot', 'Hand back')}</span>
        </button>
      );
    }

    if (canRetrySharedInput) {
      return (
        <button
          type="button"
          className="bb-btn bb-btn--secondary"
          disabled={pendingAction !== null}
          onClick={() => void handleTakeover({ shared: true })}
        >
          {t('重新连接页面', 'Reconnect to page')}
        </button>
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
          <span>
            {view?.sharedInput ? t('切换到本机操作', 'Switch input to this device') : t('切换到本机接管', 'Take control here')}
          </span>
        </button>
      );
    }

    if (view?.supportsSharedInput && !view.pageId && !view.attentionRequested) return null;

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

  const externalRecoveryButton = showExternalRecovery ? (
    <button
      type="button"
      className="bb-btn bb-btn--primary bb-btn--sm"
      disabled={externalGuideOpening}
      onClick={() => {
        if (urlMeta.isGoogleSignInRejected) void handleOpenExternalGuide('google-sign-in-rejected');
        else handleRequestExternalGuide();
      }}
    >
      <ExternalLink size={14} aria-hidden="true" />
      <span>{externalGuideOpening
        ? t('正在打开…', 'Opening…')
        : t('在系统浏览器中继续', 'Continue in system browser')}</span>
    </button>
  ) : null;

  const showReleaseMenuItem = (isHolder && view?.phase === 'human') || !connected || canRetry;
  const effectivePlacement = hasOpenBrowserPage ? view?.renderPlacement ?? 'server' : browserPlacement?.value ?? 'server';
  const moreMenuItems: PopoverMenuItem[] = [
    ...(browserPlacement
      ? [
          {
            key: 'placement-client',
            label:
              hasOpenBrowserPage && view?.renderPlacement === 'client' && !view.rendererId
                ? t('网页运行位置：其他客户端', 'Run webpages on: Another client')
                : t('网页运行位置：当前客户端', 'Run webpages on: This device'),
            checked: effectivePlacement === 'client',
            disabled: !canChangeBrowserPlacement,
            onSelect: () => {
              if (canChangeBrowserPlacement) browserPlacement.set('client');
            },
          },
          {
            key: 'placement-server',
            label: t('网页运行位置：Bot 所在设备', 'Run webpages on: Bot host'),
            checked: effectivePlacement === 'server',
            disabled: !canChangeBrowserPlacement,
            onSelect: () => {
              if (canChangeBrowserPlacement) browserPlacement.set('server');
            },
          },
          ...(hasOpenBrowserPage
            ? [
                {
                  key: 'placement-hint',
                  label: t('关闭所有标签页后可切换运行位置', 'Close all tabs to change placement'),
                  disabled: true,
                  onSelect: () => {},
                },
              ]
            : []),
        ]
      : []),
    ...(showReleaseMenuItem
      ? [
          {
            key: 'release',
            separatorBefore: Boolean(browserPlacement),
            icon: <Square size={15} aria-hidden="true" />,
            label: view?.sharedInput ? t('关闭浏览器会话', 'Close browser session') : t('释放控制权', 'Release control'),
            disabled: pendingAction !== null,
            onSelect: () => {
              void handleRelease(false);
            },
          },
        ]
      : []),
    {
      key: 'external-guide',
      separatorBefore: !showReleaseMenuItem && Boolean(browserPlacement),
      icon: <ExternalLink size={15} aria-hidden="true" />,
      label: t('切换外置引导', 'Use external browser'),
      disabled: externalGuideOpening,
      onSelect: () => {
        handleRequestExternalGuide();
      },
    },
  ];

  return (
    <section
      ref={panelRef}
      className={panelClasses}
      data-browser-overlay={resolvedMode === 'fullscreen' ? 'true' : undefined}
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
          <div className="bb-heading">
            <h2 className="bb-title">{t('浏览器', 'Browser')}</h2>
            {botName ? <span className="bb-bot-name" title={botName}>{botName}</span> : null}
          </div>
          <div className="bb-header-context">
            <span className={`bb-status bb-status--${statusInfo.tone}`} role="status" title={statusInfo.text}>
              {statusInfo.spinning ? (
                <Loader2 size={13} className="bb-spin" aria-hidden="true" />
              ) : (
                <span className="bb-status-dot" aria-hidden="true" />
              )}
              <span className="bb-status-text">{statusInfo.text}</span>
            </span>
          </div>
        </div>

        <div className="bb-header-right">
          {primaryActionButton}
          {failedDestination ? (
            <button
              type="button"
              className="bb-btn bb-btn--secondary"
              disabled={!connected || !pageVisible || !view?.available || pendingAction !== null || (view?.phase !== 'bot' && !isHolder)}
              onClick={() => {
                setFailedDestination({ ...failedDestination });
              }}
            >
              {t('重试打开步骤页面', 'Retry opening step page')}
            </button>
          ) : null}
          {canRetry ? (
            <button
              type="button"
              className="bb-icon-btn"
              aria-label={t('重新检查浏览器', 'Retry browser connection')}
              title={t('重新检查浏览器', 'Retry browser connection')}
              onClick={handleRetry}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          ) : null}
          <PopoverMenu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            align="end"
            side="bottom"
            ariaLabel={t('更多浏览器操作', 'More browser actions')}
            items={moreMenuItems}
            trigger={({ triggerProps }) => (
              <button
                type="button"
                className={`bb-icon-btn${moreOpen ? ' is-open' : ''}`}
                aria-label={t('更多浏览器操作', 'More browser actions')}
                title={t('更多操作', 'More actions')}
                {...triggerProps}
              >
                <Ellipsis size={20} aria-hidden="true" />
              </button>
            )}
          />
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
          {view.tabs.length > 0 || isHolder || (isAvailableInteractive && !view.pageId && !isOtherHolder) ? (
            <div className="bb-tabs-row">
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
                        <Globe size={16} aria-hidden="true" className="bb-tab-icon" />
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
                          <X size={16} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {!isOtherHolder ? (
                <button
                  type="button"
                  className="bb-tab-add"
                  disabled={pendingAction !== null || !connected}
                  aria-label={t('新建标签页', 'New tab')}
                  title={t('新建标签页', 'New tab')}
                  onClick={() => void runPageAction('tab', 'open', { pageId: null })}
                >
                  <Plus size={18} aria-hidden="true" />
                  <span>{t('新建', 'New tab')}</span>
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="bb-nav-row">
            <div className="bb-nav-buttons">
              {navigationButtons.map(({ action, label, Icon, available }) => (
                <button
                  key={action}
                  type="button"
                  className="bb-nav-btn"
                  disabled={!canNavigate || !available}
                  title={label}
                  onClick={() => void runPageAction('navigating', action)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <form className={`bb-address-form${urlError ? ' is-invalid' : ''}`} onSubmit={handleUrlSubmit} noValidate>
              <span className="bb-address-lock" aria-hidden="true">
                {urlMeta.isSecure ? <Lock size={16} /> : <Globe size={16} />}
              </span>
              <input
                ref={addressInputRef}
                type="text"
                className="bb-address-input"
                value={urlDraft}
                readOnly={!canNavigate}
                aria-label={t('当前网页地址', 'Current page URL')}
                aria-invalid={Boolean(urlError) || undefined}
                aria-describedby={urlError && errorBanner ? addressErrorId : undefined}
                placeholder={t('输入网址并回车…', 'Enter URL and press Enter…')}
                onFocus={() => {
                  if (canNavigate) setUrlEditing(true);
                }}
                onBlur={() => {
                  setUrlEditing(false);
                  setUrlDraft(currentTab?.url ?? '');
                }}
                onChange={(ev) => {
                  setUrlDraft(ev.target.value);
                  if (urlError) setUrlError(null);
                }}
              />
              {canNavigate ? (
                <button
                  type="submit"
                  className="bb-address-submit"
                  aria-label={t('前往该网址', 'Go to URL')}
                  title={t('前往', 'Go')}
                >
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              ) : null}
            </form>

            {liveFrame ? (
              <div className="bb-zoom-group" role="group" aria-label={t('画面缩放', 'Viewport zoom')}>
                <button
                  type="button"
                  className="bb-zoom-btn"
                  disabled={zoom <= ZOOM_STEPS[0] + 0.01}
                  aria-label={t('缩小画面', 'Zoom out')}
                  title={t('缩小画面', 'Zoom out')}
                  onClick={() => stepZoom(-1)}
                >
                  <Minus size={18} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bb-zoom-label"
                  onClick={() => setPreferredZoom(1)}
                  aria-label={t('适应窗口', 'Fit to window')}
                  title={t('适应窗口', 'Fit to window')}
                >
                  {zoom === 1 ? t('适应', 'Fit') : `${Math.round(zoom * 100)}%`}
                </button>
                <button
                  type="button"
                  className="bb-zoom-btn"
                  disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.01}
                  aria-label={t('放大画面', 'Zoom in')}
                  title={t('放大画面', 'Zoom in')}
                  onClick={() => stepZoom(1)}
                >
                  <Plus size={18} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Contextual banners — unified on InlineBanner */}
      <div className="bb-banners">
        {connected && clientUnavailableKind !== null ? (
          <InlineBanner
            tone="attention"
            role="status"
            compact
            title={
              clientUnavailableKind === 'window-closed'
                ? t('桌面浏览器窗口已关闭，当前已停止共享。', 'The desktop browser window was closed and sharing has stopped.')
                : t('桌面浏览器暂未连上，正在等待恢复连接。', 'The desktop browser is temporarily disconnected and waiting to reconnect.')
            }
            detail={
              clientUnavailableKind === 'window-closed'
                ? t('重新打开 Pi Bot 桌面窗口后，可开始新的共享会话。', 'Reopen the Pi Bot desktop window to start a new sharing session.')
                : t('如果桌面窗口仍开着，短暂断线后会重新连接到原页面。', 'If the desktop window is still open, a brief interruption will reconnect to the same page.')
            }
          />
        ) : null}

        {view?.attentionRequested && view.attentionMessage && view.phase === 'bot' && isAvailableInteractive && !signInTakeover ? (
          <InlineBanner
            tone="attention"
            role="status"
            compact
            title={view.attentionMessage}
          />
        ) : null}

        {isHeld ? (
          <InlineBanner
            tone="attention"
            role="status"
            compact
            title={
              urlMeta.isGoogleSignInRejected
                ? t('Google 拒绝了本次登录。', 'Google blocked this sign-in.')
                : view?.attentionMessage || t('浏览器已暂停，请选择如何继续。', 'Browser paused. Choose how to continue.')
            }
            detail={currentTab?.url && !isSensitive ? (urlMeta.displayHost || currentTab.url) : undefined}
            actions={
              <>
                {externalRecoveryButton}
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
              </>
            }
          />
        ) : null}

        {externalRecoveryButton && !isHeld ? (
          <InlineBanner
            tone={urlMeta.isGoogleSignInRejected ? 'attention' : 'neutral'}
            role="status"
            compact
            title={
              urlMeta.isGoogleSignInRejected
                ? t('Google 拒绝了本次登录。', 'Google blocked this sign-in.')
                : t('可改用系统浏览器继续当前页面。', 'Continue this page in your system browser.')
            }
            actions={externalRecoveryButton}
          />
        ) : null}

        {preemptConfirmOpen && isOtherHolder ? (
          <InlineBanner
            tone="info"
            role="alert"
            compact
            title={t(`确定将控制权从「${view?.holderLabel || '另一台设备'}」切换到本机？原设备将立即转为只读。`, `Move control from ${view?.holderLabel || 'the other device'} to here? The other view will become read-only.`)}
            actions={
              <>
                <button
                  type="button"
                  className="bb-btn bb-btn--primary bb-btn--sm"
                  disabled={pendingAction !== null}
                  onClick={() => void handleTakeover({ force: true, shared: allowsSharedInput && view?.sharedInput === true })}
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
              </>
            }
          />
        ) : null}

        {externalConfirmOpen ? (
          <InlineBanner
            tone="info"
            role="alert"
            compact
            icon={<ExternalLink size={16} aria-hidden="true" />}
            title={
              urlMeta.isGoogleSignInRejected
                ? t('登录后，返回 Pi Bot 继续当前步骤。', 'After signing in, return to Pi Bot to continue the current step.')
                : t('将在你的系统浏览器中打开新页面，不继承当前表单已填内容。确认切换？', 'This opens a fresh session in your system browser and does not carry over filled form fields. Continue?')
            }
            actions={
              <>
                <button
                  type="button"
                  className="bb-btn bb-btn--primary bb-btn--sm"
                  onClick={() => void handleOpenExternalGuide()}
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
              </>
            }
          />
        ) : null}

        {errorBanner ? (
          <div id={urlError ? addressErrorId : undefined} className="bb-banner-slot">
            <InlineBanner
              tone="danger"
              role="alert"
              compact
              title={errorBanner}
              onDismiss={() => {
                setErrorBanner(null);
                setUrlError(null);
              }}
              dismissLabel={t('关闭错误提示', 'Dismiss error')}
            />
          </div>
        ) : null}

        {noticeBanner && !errorBanner ? (
          <InlineBanner
            tone="neutral"
            role="status"
            compact
            title={noticeBanner}
            onDismiss={() => setNoticeBanner(null)}
            dismissLabel={t('关闭提示', 'Dismiss notice')}
          />
        ) : null}
      </div>

      <div className="bb-viewport" ref={setNativeStage} aria-hidden={nativeReady || undefined}>
        {liveFrame ? (
          <BotBrowserViewport
            liveFrame={liveFrame}
            pageTitle={currentTab?.title}
            canSendInput={canSendInput}
            zoom={zoom}
            onZoomChange={setPreferredZoom}
            onInput={handleInput}
            onExitStageFocus={() => {
              const fallback = closeBtnRef.current ?? remoteInputRef.current ?? panelRef.current;
              fallback?.focus({ preventScroll: true });
            }}
          />
        ) : !nativeReady ? (
          <div className="bb-viewport-empty" role="status">
            <div className="bb-viewport-empty-icon" aria-hidden="true">
              {!connected ? (
                <Globe size={24} />
              ) : !view && loadingStatus ? (
                <Loader2 size={24} className="bb-spin" />
              ) : frameRestricted ? (
                <Lock size={24} />
              ) : canShowStream && view?.pageId ? (
                <Loader2 size={24} className="bb-spin" />
              ) : (
                <Globe size={24} />
              )}
            </div>
            <p className="bb-viewport-empty-title">
              {!connected
                ? t('连接已断开', 'Connection lost')
                : !view && loadingStatus
                  ? t('正在连接浏览器…', 'Connecting to browser…')
                  : clientUnavailableKind === 'window-closed'
                    ? t('桌面浏览器窗口已关闭', 'Desktop browser window closed')
                    : clientUnavailableKind === 'disconnected'
                      ? t('桌面浏览器暂未连上', 'Desktop browser disconnected')
                      : frameRestricted
                        ? t('当前页面受敏感保护', 'Sensitive page hidden')
                        : !view || !view.available || !view.canStreamInteract || streamDegraded
                          ? (streamDegraded ? t('实时画面暂时不可用', 'Live stream temporarily unavailable') : t('实时浏览不可用', 'Live view unavailable'))
                          : !view.pageId && view.tabs.length === 0
                            ? t('当前没有打开的标签页', 'No open tabs')
                            : t('正在获取画面…', 'Loading live view…')}
            </p>
            <p className="bb-viewport-empty-desc">
              {!connected
                ? t('预览与操作已暂停，网络恢复后将自动重连。', 'Live view and input are paused until the connection returns.')
                : !view && loadingStatus
                  ? t('正在读取目标设备浏览器状态，请稍候。', 'Reading browser status from the target device.')
                  : clientUnavailableKind === 'window-closed'
                    ? t('重新打开 Pi Bot 桌面窗口后，可点击重试恢复查看。', 'Reopen the Pi Bot desktop window, then retry to restore live view.')
                    : clientUnavailableKind === 'disconnected'
                      ? t('正在等待桌面端恢复连接，或手动重试检查状态。', 'Waiting for the desktop window to reconnect, or retry now.')
                      : frameRestricted
                        ? (signInTakeover ? t('接管此页后可在本机查看画面并完成登录。', 'Take over this page to view it privately and finish signing in.') : t('为保护账号与凭据隐私，只读视图已隐藏画面。', 'Live preview is hidden in read-only view to protect sensitive content.'))
                        : !view || !view.available || !view.canStreamInteract || streamDegraded
                          ? (view?.reason || t('可重试恢复画面，或改用系统浏览器继续。', 'Retry to restore live view, or continue in your system browser.'))
                          : !view.pageId && view.tabs.length === 0
                            ? t('新建标签页，或等待 Bot 打开网页。', 'Open a new tab, or wait for the Bot to navigate to a page.')
                            : t('请稍候，画面加载完成后将自动显示。', 'Please wait — the live view will appear automatically.')}
            </p>
            <div className="bb-viewport-empty-actions">
              {signInTakeover ? (
                <button
                  type="button"
                  className="bb-btn bb-btn--primary"
                  disabled={pendingAction !== null}
                  onClick={() => void handleTakeover()}
                >
                  <Unlock size={14} aria-hidden="true" />
                  <span>{t('接管并登录', 'Take over and sign in')}</span>
                </button>
              ) : null}
              {canRetry ? (
                <button
                  type="button"
                  className="bb-btn bb-btn--secondary"
                  disabled={pendingAction !== null}
                  onClick={handleRetry}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>{t('重试连接', 'Retry')}</span>
                </button>
              ) : null}
              {connected && view?.available && !view.pageId && view.tabs.length === 0 && !isOtherHolder ? (
                <button
                  type="button"
                  className="bb-btn bb-btn--primary"
                  disabled={pendingAction !== null}
                  onClick={() => void runPageAction('tab', 'open', { pageId: null })}
                >
                  <Plus size={15} aria-hidden="true" />
                  <span>{t('新建标签页', 'New tab')}</span>
                </button>
              ) : null}
              {!signInTakeover && showExternalRecovery ? externalRecoveryButton : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Remote keyboard & touch input dock (visible only when actively holding confirmed lease) */}
      {canSendInput ? (
        <div className="bb-input-dock" aria-label={t('远程页面键盘与滚轮输入', 'Remote page keyboard and scroll controls')}>
          <input
            ref={remoteInputRef}
            type="text"
            className="bb-remote-input"
            maxLength={MAX_TEXT_INPUT_LENGTH}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('输入到网页（支持输入法）', 'Type into the page (IME supported)')}
            aria-label={t('向当前网页输入文字', 'Type text into the live webpage')}
            onChange={handleRemoteTextChange}
            onCompositionStart={handleRemoteTextCompositionStart}
            onCompositionEnd={handleRemoteTextCompositionEnd}
            onKeyDown={handleRemoteTextKeyDown}
          />
          <div className="bb-key-strip">
            {remoteKeys.map(({ key, label, CompactIcon }) => (
              <button
                key={key}
                type="button"
                className="bb-key-btn"
                aria-label={label}
                title={label}
                onClick={() => handleInput({ kind: 'key', key })}
              >
                {CompactIcon ? <CompactIcon className="bb-key-compact-icon" size={18} aria-hidden="true" /> : null}
                <span className="bb-key-label">{label}</span>
              </button>
            ))}
            {resolvedMode === 'fullscreen' ? (
              <>
                <button
                  type="button"
                  className="bb-key-btn"
                  onClick={() => handleInput({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: -280 })}
                  aria-label={t('向上滚动页面', 'Scroll page up')}
                >
                  <ChevronUp size={18} aria-hidden="true" />
                  {t('上滚', 'Up')}
                </button>
                <button
                  type="button"
                  className="bb-key-btn"
                  onClick={() => handleInput({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 280 })}
                  aria-label={t('向下滚动页面', 'Scroll page down')}
                >
                  <ChevronDown size={18} aria-hidden="true" />
                  {t('下滚', 'Down')}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default BotBrowserPanel;
