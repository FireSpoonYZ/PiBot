// Shared composer-docked active Google Setup wizard container (Desktop & Mobile).
// - Renders nothing when there is no active setup flow or when Host confirms completion/cancellation/expiry.
// - Isolates state by scopeKey + runId and refreshes in place on copy/revision updates.
// - Preserves collapse state across same-step polling/revision/copy changes without unmounting form inputs;
//   auto-expands on first appearance, a genuinely new run, or a new step needing operator action.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { useText } from '../ui';
import {
  deriveGoogleSetupAttention,
  isActiveGoogleSetupPresentation,
  isActiveGoogleSetupState,
  isStaleGoogleSetupResult,
  reconcileGoogleSetupDockState,
  recordAcceptedGoogleSetupOrder,
  setGoogleSetupDockExpanded,
  shouldAcceptGoogleSetupResponse,
  shouldRefreshGoogleSetupStatus,
  shouldShowCurrentGoogleSetup,
  type CurrentGoogleSetupDockState,
  type SetupResponseOrderState,
} from './currentGoogleSetup';
import { googleStepTitle } from './googleCopy';
import { GoogleSetupWizard } from './GoogleSetupWizard';
import type {
  GoogleChatCardContext,
  GoogleSetupControlState,
  GoogleSetupPresentation,
} from './types';
import './google-ui.css';

export interface CurrentGoogleSetupCardProps {
  scopeKey: string;
  presentation?: GoogleSetupPresentation;
  googleContext?: GoogleChatCardContext;
  disabled?: boolean;
}

interface ScopedLiveState {
  scopeKey: string;
  presentationRunId: string;
  activeRunId: string;
  liveSetup: GoogleSetupControlState | null;
  initialChecked: boolean;
}

const EMPTY_ORDER: SetupResponseOrderState = {
  latestRevision: null,
  latestSeq: 0,
};

export function CurrentGoogleSetupCard({
  scopeKey,
  presentation,
  googleContext,
  disabled = false,
}: CurrentGoogleSetupCardProps) {
  const t = useText();
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const inFlightKeyRef = useRef<string | null>(null);

  const activePresentation = isActiveGoogleSetupPresentation(presentation) ? presentation : undefined;
  const presentationRunId = activePresentation?.runId?.trim() ?? '';
  const botId = activePresentation?.botId || googleContext?.botId || '';
  const callGoogleSetup = googleContext?.callGoogleSetup;
  const canQueryHost = Boolean(
    activePresentation &&
      presentationRunId &&
      botId &&
      callGoogleSetup &&
      googleContext?.connected !== false,
  );

  // Track latest scope & presentation run synchronously to discard stale/out-of-order returns.
  const activeScopeRef = useRef(scopeKey);
  const activePresentationRunIdRef = useRef(presentationRunId);
  activeScopeRef.current = scopeKey;
  activePresentationRunIdRef.current = presentationRunId;

  const orderByScopeRef = useRef<{ scopeKey: string; state: SetupResponseOrderState }>({
    scopeKey,
    state: EMPTY_ORDER,
  });
  if (orderByScopeRef.current.scopeKey !== scopeKey) {
    orderByScopeRef.current = { scopeKey, state: EMPTY_ORDER };
    inFlightKeyRef.current = null;
  }

  const [scoped, setScoped] = useState<ScopedLiveState>(() => ({
    scopeKey,
    presentationRunId,
    activeRunId: presentationRunId,
    liveSetup: null,
    initialChecked: !canQueryHost,
  }));

  const isCurrentScope =
    scoped.scopeKey === scopeKey && scoped.presentationRunId === presentationRunId;
  const currentActiveRunId = isCurrentScope ? scoped.activeRunId : presentationRunId;
  const currentLiveSetup = isCurrentScope ? scoped.liveSetup : null;
  const initialChecked = isCurrentScope ? scoped.initialChecked : !canQueryHost;

  const [dockState, setDockState] = useState<CurrentGoogleSetupDockState | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (presentationRunId) return;
    setScoped(prev =>
      prev.scopeKey === scopeKey && prev.presentationRunId === '' && prev.liveSetup === null
        ? prev
        : {
            scopeKey,
            presentationRunId: '',
            activeRunId: '',
            liveSetup: null,
            initialChecked: true,
          },
    );
  }, [presentationRunId, scopeKey]);

  // Fetch initial status once per (scopeKey, runId) and only refresh when presentation
  // indicates genuinely newer revision/copy/step/blocker state than what we already hold.
  const needsStatusFetch =
    canQueryHost &&
    (!initialChecked ||
      shouldRefreshGoogleSetupStatus(currentLiveSetup, activePresentation, currentActiveRunId));

  useEffect(() => {
    if (!needsStatusFetch || !callGoogleSetup || !botId || !presentationRunId) return;
    const fetchKey = `${scopeKey}::${presentationRunId}`;
    if (inFlightKeyRef.current === fetchKey) return;

    const reqScopeKey = scopeKey;
    const reqPresentationRunId = presentationRunId;
    const reqSeq = ++requestSeqRef.current;
    inFlightKeyRef.current = fetchKey;

    void callGoogleSetup({ botId, action: 'status' })
      .then(next => {
        if (!mountedRef.current) return;
        if (
          reqScopeKey !== activeScopeRef.current ||
          reqPresentationRunId !== activePresentationRunIdRef.current
        ) {
          return;
        }
        if (!shouldAcceptGoogleSetupResponse(orderByScopeRef.current.state, next, reqSeq)) {
          setScoped(prev =>
            prev.scopeKey === reqScopeKey && prev.presentationRunId === reqPresentationRunId
              ? { ...prev, initialChecked: true }
              : {
                  scopeKey: reqScopeKey,
                  presentationRunId: reqPresentationRunId,
                  activeRunId: reqPresentationRunId,
                  liveSetup: null,
                  initialChecked: true,
                },
          );
          return;
        }
        orderByScopeRef.current = {
          scopeKey: reqScopeKey,
          state: recordAcceptedGoogleSetupOrder(orderByScopeRef.current.state, next, reqSeq),
        };
        setScoped(prev => {
          const sameEntry =
            prev.scopeKey === reqScopeKey && prev.presentationRunId === reqPresentationRunId;
          return {
            scopeKey: reqScopeKey,
            presentationRunId: reqPresentationRunId,
            activeRunId: sameEntry ? prev.activeRunId : reqPresentationRunId,
            liveSetup: next,
            initialChecked: true,
          };
        });
      })
      .catch(() => {
        if (!mountedRef.current) return;
        if (
          reqScopeKey !== activeScopeRef.current ||
          reqPresentationRunId !== activePresentationRunIdRef.current
        ) {
          return;
        }
        setScoped(prev =>
          prev.scopeKey === reqScopeKey && prev.presentationRunId === reqPresentationRunId
            ? { ...prev, initialChecked: true }
            : {
                scopeKey: reqScopeKey,
                presentationRunId: reqPresentationRunId,
                activeRunId: reqPresentationRunId,
                liveSetup: null,
                initialChecked: true,
              },
        );
      })
      .finally(() => {
        if (inFlightKeyRef.current === fetchKey) {
          inFlightKeyRef.current = null;
        }
      });
  }, [
    botId,
    callGoogleSetup,
    needsStatusFetch,
    presentationRunId,
    scopeKey,
    activePresentation?.revision,
    activePresentation?.copy,
    activePresentation?.step,
    activePresentation?.card,
    activePresentation?.blockerKind,
  ]);

  const handleWizardSetupChange = useCallback(
    (next: GoogleSetupControlState, meta: { action: string }) => {
      if (!mountedRef.current || scopeKey !== activeScopeRef.current) return;
      const reqSeq = ++requestSeqRef.current;
      if (!shouldAcceptGoogleSetupResponse(orderByScopeRef.current.state, next, reqSeq)) {
        return;
      }
      orderByScopeRef.current = {
        scopeKey,
        state: recordAcceptedGoogleSetupOrder(orderByScopeRef.current.state, next, reqSeq),
      };
      setScoped(prev => {
        const sameEntry =
          prev.scopeKey === scopeKey && prev.presentationRunId === presentationRunId;
        const adoptedRunId =
          (meta.action === 'start' || meta.action === 'start-over') &&
          next.applied !== false &&
          !isStaleGoogleSetupResult(next) &&
          isActiveGoogleSetupState(next.state) &&
          typeof next.id === 'string' &&
          next.id.trim()
            ? next.id.trim()
            : sameEntry
              ? prev.activeRunId
              : presentationRunId;
        return {
          scopeKey,
          presentationRunId,
          activeRunId: adoptedRunId,
          liveSetup: next,
          initialChecked: true,
        };
      });
    },
    [presentationRunId, scopeKey],
  );

  const visible =
    Boolean(activePresentation) &&
    Boolean(googleContext) &&
    initialChecked &&
    shouldShowCurrentGoogleSetup(activePresentation, currentLiveSetup, currentActiveRunId);

  const attention = visible
    ? deriveGoogleSetupAttention(currentLiveSetup, activePresentation, currentActiveRunId)
    : null;
  const resolvedDockState = attention
    ? reconcileGoogleSetupDockState(dockState, scopeKey, attention)
    : null;

  useEffect(() => {
    if (resolvedDockState && resolvedDockState !== dockState) {
      setDockState(resolvedDockState);
    }
  }, [dockState, resolvedDockState]);

  const handleCollapse = useCallback(() => {
    if (!resolvedDockState) return;
    setDockState(setGoogleSetupDockExpanded(resolvedDockState, false));
  }, [resolvedDockState]);

  const handleExpand = useCallback(() => {
    if (!resolvedDockState) return;
    setDockState(setGoogleSetupDockExpanded(resolvedDockState, true));
  }, [resolvedDockState]);

  if (!visible || !activePresentation || !googleContext || !resolvedDockState) {
    return null;
  }

  const expanded = resolvedDockState.expanded;
  const activeStep = currentLiveSetup?.card?.step ?? currentLiveSetup?.step ?? activePresentation.step ?? null;
  const activeCard = currentLiveSetup?.card?.card ?? activePresentation.card ?? null;
  const browserLocked = Boolean(
    currentLiveSetup?.browserLock?.active || currentLiveSetup?.browserTakeoverRequired,
  );
  const failed = currentLiveSetup?.state === 'failed' || activePresentation.state === 'failed';
  const dockTitle = t('Google 配置', 'Google setup');
  const statusTone = browserLocked || failed ? 'is-warn' : 'is-accent';
  const stepLabel =
    activeStep
      ? googleStepTitle(activeStep, t)
      : activeCard === 'path'
        ? t('选择操作方式', 'Choose how to set up')
        : activeCard === 'services'
          ? t('选择 Google 服务', 'Choose services')
          : browserLocked
            ? t('等待亲自操作', 'Needs your action')
            : failed
              ? t('已暂停', 'Paused')
              : t('进行中', 'In progress');

  return (
    <div
      className={`gws-dock${expanded ? ' is-expanded' : ' is-collapsed'}`}
      data-scope-key={scopeKey}
      data-run-id={currentActiveRunId}
    >
      {!expanded ? (
        <button
          type="button"
          className="gws-dock-bar"
          aria-expanded={false}
          aria-label={t(`展开${dockTitle}`, `Expand ${dockTitle}`)}
          onClick={handleExpand}
        >
          <span className="gws-dock-bar-main">
            <span className={`gws-dock-dot ${statusTone}`} aria-hidden="true" />
            <span className="gws-dock-title">{dockTitle}</span>
            <span className="gws-dock-sep" aria-hidden="true">·</span>
            <span className="gws-dock-step">{stepLabel}</span>
          </span>
          <span className="gws-dock-expand-label">
            <ChevronUp size={13} aria-hidden="true" />
            <span>{t('展开', 'Expand')}</span>
          </span>
        </button>
      ) : null}

      <div className={`gws-dock-body${expanded ? '' : ' is-collapsed'}`} hidden={!expanded}>
        <GoogleSetupWizard
          key={`${scopeKey}:${currentActiveRunId}`}
          scopeKey={scopeKey}
          api={googleContext.api}
          identity={googleContext.identity}
          botId={botId}
          botName={googleContext.botName}
          isLocalAndroid={googleContext.isLocalAndroid}
          expectedRunId={currentActiveRunId}
          readOnly={Boolean(disabled)}
          managedStatus
          compactChat
          externalSetup={currentLiveSetup}
          callGoogleSetup={callGoogleSetup}
          onOpenBrowser={googleContext.onOpenBrowser}
          onOpenCapabilities={googleContext.onOpenCapabilities}
          onOpenCenterAdmin={googleContext.onOpenCenterAdmin}
          onSetupChange={handleWizardSetupChange}
          onClose={handleCollapse}
        />
      </div>
    </div>
  );
}
