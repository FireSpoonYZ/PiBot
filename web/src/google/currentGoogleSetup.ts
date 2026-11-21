// Pure selector, dock collapse/expand state machine, response-ordering guard,
// and wire-safe mutation guard builder for the active Google Setup wizard.
// Intentionally free of React/CSS runtime imports so it can be unit-tested directly.
import type { ChatToolCallItem, ChatTurn } from '../chatTurnModel';
import type { GoogleSetupControlCall, GoogleSetupControlState, GoogleSetupPresentation } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isOptString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';
const isOptNullableString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';
const isNonNegativeInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Strictly validate a `google-setup` tool presentation (version 1).
 * Shared by ToolPresentation and selectCurrentGoogleSetup so history and live dock agree.
 */
export function readGoogleSetupPresentation(value: unknown): GoogleSetupPresentation | null {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'google-setup') return null;
  if (!isOptString(value.installationId) || !isOptString(value.botId)) return null;
  if (
    !isOptNullableString(value.runId) ||
    !isOptNullableString(value.card) ||
    !isOptNullableString(value.step)
  ) {
    return null;
  }
  if (
    !isOptNullableString(value.mode) ||
    !isOptString(value.state) ||
    !isOptString(value.title) ||
    !isOptString(value.summary)
  ) {
    return null;
  }
  if (!isOptNullableString(value.blockerKind)) return null;
  if (value.revision !== undefined && !isNonNegativeInt(value.revision)) return null;
  if (value.copy !== undefined && !isNonNegativeInt(value.copy)) return null;
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) return null;
    const validActions = value.actions.every(
      item =>
        isRecord(item) &&
        isNonEmptyString(item.id) &&
        isOptString(item.label) &&
        isOptString(item.step),
    );
    if (!validActions) return null;
  }
  return value as unknown as GoogleSetupPresentation;
}

export function isTerminalGoogleSetupState(state: string | null | undefined): boolean {
  return (
    state === 'done' ||
    state === 'completed' ||
    state === 'cancelled' ||
    state === 'idle' ||
    state === 'not_started'
  );
}

export function isActiveGoogleSetupState(state: string | null | undefined): boolean {
  return state === 'running' || state === 'failed';
}

export interface GoogleSignInRejectionContext {
  pageId: string | undefined;
  isCurrent: () => boolean;
}

export async function continueGoogleSetupAfterSignInRejection(
  request: GoogleSetupControlCall,
  openExternal: (url: string) => Promise<void>,
  rejection?: GoogleSignInRejectionContext,
): Promise<boolean> {
  if (rejection && !rejection.isCurrent()) return false;
  const current = rejection?.pageId ? await request({ action: 'status' }) : null;
  if (rejection && !rejection.isCurrent()) return false;
  if (!current || !rejection || current.browserPageId !== rejection.pageId ||
      !current.id || !isActiveGoogleSetupState(current.state)) {
    await openExternal(GOOGLE_CONSOLE_ORIGIN + '/');
    return false;
  }
  if (current.unavailable) throw new Error('Google setup is unavailable');

  const next = await request({
    action: 'resume',
    mode: 'guide-browser',
    runId: current.id,
    expectedRevision: current.revision,
  });
  if (!rejection.isCurrent()) return false;
  if (next.id !== current.id || next.unavailable || next.mode !== 'guide-browser' || isStaleGoogleSetupResult(next)) {
    throw new Error('Google setup could not switch to external guidance');
  }
  const url = googleSetupConsoleUrl(next.step, next);
  if (url) await openExternal(url);
  return rejection.isCurrent();
}

export function isActiveGoogleSetupPresentation(
  presentation: GoogleSetupPresentation | null | undefined,
): presentation is GoogleSetupPresentation {
  if (!presentation) return false;
  if (!isActiveGoogleSetupState(presentation.state)) return false;
  return typeof presentation.runId === 'string' && presentation.runId.trim().length > 0;
}

function visitToolsForGoogleSetup(
  tools: readonly ChatToolCallItem[] | undefined,
  onPresentation: (presentation: GoogleSetupPresentation) => void,
): void {
  if (!tools || tools.length === 0) return;
  for (const tool of tools) {
    const presentation = readGoogleSetupPresentation(tool.presentation);
    if (tool.status === 'running') {
      if (presentation) onPresentation(presentation);
      visitToolsForGoogleSetup(tool.children, onPresentation);
    } else {
      visitToolsForGoogleSetup(tool.children, onPresentation);
      if (presentation) onPresentation(presentation);
    }
  }
}

/**
 * Shared contract: select the chronologically latest valid `google-setup` flow from
 * the complete `ChatTurn[]` (ordered `blocks` tools, legacy `turn.tools`, and nested `children`).
 * If the latest valid record is terminal (`done`/`completed`/`cancelled`/`idle`), returns
 * `undefined` and never resurrects an earlier running state.
 */
export function selectCurrentGoogleSetup(
  turns: readonly ChatTurn[],
): GoogleSetupPresentation | undefined {
  let latest: GoogleSetupPresentation | undefined;
  for (const turn of turns) {
    if (turn.blocks && turn.blocks.some(block => block.kind === 'tools')) {
      for (const block of turn.blocks) {
        if (block.kind === 'tools') {
          visitToolsForGoogleSetup(block.tools, presentation => {
            latest = presentation;
          });
        }
      }
    } else if (turn.tools && turn.tools.length > 0) {
      visitToolsForGoogleSetup(turn.tools, presentation => {
        latest = presentation;
      });
    }
  }
  if (!latest || !isActiveGoogleSetupPresentation(latest)) {
    return undefined;
  }
  return latest;
}

/* ------------------------------------------------------------------ */
/* Dock collapse/expand state machine                                  */
/* ------------------------------------------------------------------ */

const OPERATOR_ACTION_CARDS = new Set(['path', 'services', 'account', 'kind', 'step', 'connect']);
const PRE_STEP_CARDS = new Set(['path', 'services', 'kind']);

export interface GoogleSetupAttentionSignal {
  runId: string;
  /** Identifies the current step only (excludes revision, copy, blocker, browser lock, and mode degradation). */
  stepKey: string;
  needsOperatorAction: boolean;
}

export interface CurrentGoogleSetupDockState {
  scopeKey: string;
  runId: string;
  stepKey: string;
  expanded: boolean;
  collapsedStepKey: string | null;
}

export function deriveGoogleSetupAttention(
  setup: GoogleSetupControlState | null | undefined,
  presentation: GoogleSetupPresentation | null | undefined,
  activeRunId?: string | null,
): GoogleSetupAttentionSignal | null {
  const runId =
    (activeRunId && activeRunId.trim()) ||
    (setup?.id && setup.id.trim()) ||
    (presentation?.runId && presentation.runId.trim()) ||
    '';
  if (!runId) return null;

  const useLive = Boolean(setup && !setup.unavailable && setup.id === runId);
  const card = useLive ? (setup!.card?.card ?? '') : (presentation?.card ?? '');
  const step = useLive
    ? (setup!.card?.step ?? setup!.step ?? '')
    : (presentation?.step ?? '');
  const rawBlocker = useLive
    ? (setup!.blocker?.kind ?? '')
    : (presentation?.blockerKind ?? '');
  const locked = useLive
    ? Boolean(setup!.browserLock?.active || setup!.browserTakeoverRequired)
    : false;
  const blocker = rawBlocker || (locked ? 'needs-user' : '');
  const mode = useLive ? (setup!.mode ?? '') : (presentation?.mode ?? '');
  const state = useLive ? setup!.state : (presentation?.state ?? '');
  const personStep = useLive ? (setup!.personStep ?? '') : '';

  // True step identity: excludes revision, card copy, blocker, browser lock, mode degradation,
  // and progress/step card switches on the same step so collapsing a step stays collapsed.
  const stepKey = PRE_STEP_CARDS.has(card)
    ? `card:${card}`
    : step
      ? `step:${step}`
      : `card:${card}`;
  const needsOperatorAction =
    state === 'failed' ||
    Boolean(blocker) ||
    Boolean(personStep) ||
    OPERATOR_ACTION_CARDS.has(card) ||
    (mode === 'guide-browser' && Boolean(step));

  return { runId, stepKey, needsOperatorAction };
}

export function reconcileGoogleSetupDockState(
  prev: CurrentGoogleSetupDockState | null,
  scopeKey: string,
  signal: GoogleSetupAttentionSignal,
): CurrentGoogleSetupDockState {
  // First display, scope switch, or genuinely new run -> default expanded.
  if (!prev || prev.scopeKey !== scopeKey || prev.runId !== signal.runId) {
    return {
      scopeKey,
      runId: signal.runId,
      stepKey: signal.stepKey,
      expanded: true,
      collapsedStepKey: null,
    };
  }
  // Same scope, same run, same step -> never pop open if the user collapsed this step.
  if (prev.stepKey === signal.stepKey) {
    if (!prev.expanded && signal.needsOperatorAction && prev.collapsedStepKey !== signal.stepKey) {
      return {
        scopeKey,
        runId: signal.runId,
        stepKey: signal.stepKey,
        expanded: true,
        collapsedStepKey: null,
      };
    }
    return prev;
  }
  // Same run transitioned to a genuinely new step: auto-expand when operator action is needed.
  if (signal.needsOperatorAction) {
    return {
      scopeKey,
      runId: signal.runId,
      stepKey: signal.stepKey,
      expanded: true,
      collapsedStepKey: null,
    };
  }
  // Autonomous bot progress transition (no operator action required): keep current visibility.
  return {
    ...prev,
    stepKey: signal.stepKey,
  };
}

export function setGoogleSetupDockExpanded(
  state: CurrentGoogleSetupDockState,
  expanded: boolean,
): CurrentGoogleSetupDockState {
  if (state.expanded === expanded) return state;
  return {
    ...state,
    expanded,
    collapsedStepKey: expanded ? null : state.stepKey,
  };
}

/* ------------------------------------------------------------------ */
/* Monotonic revision / out-of-order response & visibility guards      */
/* ------------------------------------------------------------------ */

export interface SetupResponseOrderState {
  latestRevision: number | null;
  latestSeq: number;
}

export function shouldAcceptGoogleSetupResponse(
  order: SetupResponseOrderState,
  incoming: Pick<GoogleSetupControlState, 'revision' | 'unavailable'>,
  reqSeq: number,
): boolean {
  if (incoming.unavailable) {
    return reqSeq >= order.latestSeq;
  }
  const incomingRev = isNonNegativeInt(incoming.revision) ? incoming.revision : null;
  if (order.latestRevision !== null && incomingRev !== null) {
    if (incomingRev < order.latestRevision) return false;
    if (incomingRev === order.latestRevision && reqSeq < order.latestSeq) return false;
    return true;
  }
  return reqSeq >= order.latestSeq;
}

export function recordAcceptedGoogleSetupOrder(
  order: SetupResponseOrderState,
  incoming: Pick<GoogleSetupControlState, 'revision' | 'unavailable'>,
  reqSeq: number,
): SetupResponseOrderState {
  const incomingRev =
    !incoming.unavailable && isNonNegativeInt(incoming.revision)
      ? incoming.revision
      : order.latestRevision;
  return {
    latestRevision:
      order.latestRevision === null
        ? incomingRev
        : incomingRev === null
          ? order.latestRevision
          : Math.max(order.latestRevision, incomingRev),
    latestSeq: Math.max(order.latestSeq, reqSeq),
  };
}

export function shouldShowCurrentGoogleSetup(
  presentation: GoogleSetupPresentation | null | undefined,
  liveSetup: GoogleSetupControlState | null | undefined,
  expectedRunId?: string | null,
): boolean {
  if (!presentation || !isActiveGoogleSetupPresentation(presentation)) return false;
  if (!liveSetup) return true;
  if (liveSetup.unavailable) return true;
  if (isTerminalGoogleSetupState(liveSetup.state)) return false;
  if (!isActiveGoogleSetupState(liveSetup.state)) return false;
  if (!liveSetup.id || !liveSetup.id.trim()) return false;
  const targetRunId = (expectedRunId && expectedRunId.trim()) || presentation.runId?.trim();
  if (targetRunId && liveSetup.id !== targetRunId) return false;
  return true;
}

export function shouldRefreshGoogleSetupStatus(
  liveSetup: GoogleSetupControlState | null | undefined,
  presentation: GoogleSetupPresentation | null | undefined,
  expectedRunId?: string | null,
): boolean {
  if (!presentation || !isActiveGoogleSetupPresentation(presentation)) return false;
  if (!liveSetup) return true;
  if (liveSetup.unavailable) return false;

  const targetRunId = (expectedRunId && expectedRunId.trim()) || presentation.runId?.trim();
  const sameRun = Boolean(targetRunId && liveSetup.id === targetRunId);
  if (!sameRun) {
    // Only refetch if presentation carries a strictly newer revision than what we saw.
    return (
      typeof presentation.revision === 'number' &&
      isNonNegativeInt(liveSetup.revision) &&
      presentation.revision > liveSetup.revision
    );
  }

  if (typeof presentation.revision === 'number' && isNonNegativeInt(liveSetup.revision)) {
    if (presentation.revision > liveSetup.revision) return true;
    if (presentation.revision < liveSetup.revision) return false;
    if (
      typeof presentation.copy === 'number' &&
      typeof liveSetup.card?.copy === 'number' &&
      presentation.copy > liveSetup.card.copy
    ) {
      return true;
    }
    return false;
  }

  if (isTerminalGoogleSetupState(liveSetup.state)) return false;

  if (
    typeof presentation.copy === 'number' &&
    typeof liveSetup.card?.copy === 'number' &&
    presentation.copy > liveSetup.card.copy
  ) {
    return true;
  }
  if (presentation.step && presentation.step !== (liveSetup.card?.step ?? liveSetup.step)) {
    return true;
  }
  if (presentation.card && presentation.card !== liveSetup.card?.card) {
    return true;
  }
  if (
    presentation.blockerKind !== undefined &&
    (presentation.blockerKind ?? null) !== (liveSetup.blocker?.kind ?? null)
  ) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Wire-safe CAS & staleness mutation guard builder                    */
/* ------------------------------------------------------------------ */

const MUTATING_SETUP_ACTIONS = new Set(['answer', 'advance', 'cancel', 'resume']);
const FRONTEND_ONLY_KEYS = [
  'expectedRunId',
  'expectedCard',
  'expectedStep',
  'expectedCardCopy',
] as const;

/**
 * Build the wire-safe `googleSetupControl` payload from the currently displayed setup state.
 * - Attaches `runId`, `expectedRevision`, and applicable `card`/`step`/`cardCopy` for
 *   `answer`, `advance`, `cancel`, and `resume`.
 * - Never sends frontend-only prop names (`expectedRunId`, `expectedCard`, `expectedStep`,
 *   `expectedCardCopy`).
 * - Leaves `status` and `start` free of staleness/CAS fields rejected by Host wire validation.
 */
export function buildGoogleSetupMutationPayload(
  displayedSetup: GoogleSetupControlState | null | undefined,
  rawPayload: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...rawPayload };
  for (const key of FRONTEND_ONLY_KEYS) {
    delete payload[key];
  }

  const action = typeof payload.action === 'string' ? payload.action : '';
  if (!MUTATING_SETUP_ACTIONS.has(action)) {
    delete payload.runId;
    delete payload.expectedRevision;
    delete payload.card;
    delete payload.step;
    delete payload.cardCopy;
    return payload;
  }

  if (!displayedSetup) {
    return payload;
  }

  if (payload.runId === undefined && typeof displayedSetup.id === 'string' && displayedSetup.id.trim()) {
    payload.runId = displayedSetup.id;
  }
  if (payload.expectedRevision === undefined && isNonNegativeInt(displayedSetup.revision)) {
    payload.expectedRevision = displayedSetup.revision;
  }

  const displayedCard = displayedSetup.card?.card;
  const displayedStep = displayedSetup.card?.step;
  const displayedCopy = isNonNegativeInt(displayedSetup.card?.copy)
    ? displayedSetup.card!.copy
    : undefined;

  if (action === 'answer') {
    const targetCard = typeof payload.card === 'string' ? payload.card : undefined;
    const explicitStep =
      typeof payload.step === 'string'
        ? payload.step
        : targetCard === 'step' &&
            Array.isArray(payload.values) &&
            typeof payload.values[1] === 'string'
          ? payload.values[1]
          : undefined;
    if (targetCard && displayedCard === targetCard) {
      const stepMatches =
        targetCard !== 'step' || !explicitStep || !displayedStep || explicitStep === displayedStep;
      if (stepMatches) {
        if (payload.step === undefined && typeof displayedStep === 'string' && displayedStep) {
          payload.step = displayedStep;
        }
        if (payload.cardCopy === undefined && displayedCopy !== undefined) {
          payload.cardCopy = displayedCopy;
        }
      }
    }
    return payload;
  }

  if (action === 'advance') {
    const explicitStep = typeof payload.step === 'string' ? payload.step : undefined;
    if (typeof displayedCard === 'string' && displayedCard) {
      const stepMatches =
        displayedCard !== 'step' || !explicitStep || !displayedStep || explicitStep === displayedStep;
      if (stepMatches) {
        if (payload.card === undefined) {
          payload.card = displayedCard;
        }
        if (payload.step === undefined && typeof displayedStep === 'string' && displayedStep) {
          payload.step = displayedStep;
        }
        if (payload.cardCopy === undefined && displayedCopy !== undefined) {
          payload.cardCopy = displayedCopy;
        }
      }
    }
    return payload;
  }

  // `cancel` and `resume`
  if (typeof displayedCard === 'string' && displayedCard) {
    if (payload.card === undefined) {
      payload.card = displayedCard;
    }
    if (payload.step === undefined && typeof displayedStep === 'string' && displayedStep) {
      payload.step = displayedStep;
    }
    if (payload.cardCopy === undefined && displayedCopy !== undefined) {
      payload.cardCopy = displayedCopy;
    }
  }
  return payload;
}

export function isStaleGoogleSetupResult(
  result: GoogleSetupControlState | null | undefined,
): boolean {
  if (!result) return false;
  if (result.stale === true) return true;
  return result.applied === false && typeof result.staleReason === 'string' && result.staleReason.length > 0;
}

/* ------------------------------------------------------------------ */
/* Canonical Google Cloud Console URLs (aligned with host-core)        */
/* ------------------------------------------------------------------ */

const GOOGLE_CONSOLE_ORIGIN = 'https://console.cloud.google.com';
const GOOGLE_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;

const CHOICE_CONSOLE_APIS: Record<string, readonly string[]> = {
  gmail: ['gmail.googleapis.com'],
  calendar: ['calendar-json.googleapis.com'],
  files: ['drive.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com'],
};

export function googleSetupConsoleUrl(
  step: string | null | undefined,
  options?: {
    projectId?: string | null;
    choices?: readonly string[] | null;
    account?: string | null;
  },
): string | null {
  if (!step) return null;
  const rawProjectId = typeof options?.projectId === 'string' ? options.projectId.trim() : '';
  const projectId = rawProjectId && GOOGLE_PROJECT_ID_RE.test(rawProjectId) ? rawProjectId : undefined;
  let path: string | null = null;
  const params: Record<string, string | undefined> = {};

  switch (step) {
    case 'account':
      path = '/';
      break;
    case 'project':
      path = '/projectcreate';
      break;
    case 'apis': {
      const apiIds = ['people.googleapis.com'];
      const picked = new Set(Array.isArray(options?.choices) ? options!.choices : []);
      for (const choice of ['gmail', 'calendar', 'files']) {
        if (picked.has(choice)) {
          for (const apiId of CHOICE_CONSOLE_APIS[choice]) {
            if (!apiIds.includes(apiId)) apiIds.push(apiId);
          }
        }
      }
      path = '/apis/enableflow';
      params.apiid = apiIds.join(',');
      params.project = projectId;
      break;
    }
    case 'branding':
      path = '/auth/overview';
      params.project = projectId;
      break;
    case 'links':
      path = '/auth/branding';
      params.project = projectId;
      break;
    case 'publish':
      path = '/auth/audience';
      params.project = projectId;
      break;
    case 'client':
      path = '/auth/clients/create';
      params.project = projectId;
      break;
    default:
      return null;
  }

  const url = new URL(path, GOOGLE_CONSOLE_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const account = typeof options?.account === 'string' ? options.account.trim() : '';
  if (account) {
    url.searchParams.set('authuser', account);
  }
  return url.toString();
}
