// host-core/google-setup/service.js
// PiBot Bot-side Google setup wizard & state machine service.
//
// Exports `createGoogleSetupService(options)` ->
//   { control(input, authority), toolsForBot(context), getAgentBrowserPolicy(botId, url?),
//     syncBrowserUrl(botId, url), getRun(botId), listRuns(), forgetBot(botId), close() }
//
// Design & security invariants (strictly aligned with 04-frontend-interaction.md and integration.md):
// - Shared Center Google MCP model: configures one Center Web OAuth client + HTTPS callback
//   (`/api/oauth/google/callback`) so all current and future bots share approved Google connections.
// - Never uses Orca domains (onorca.dev), never creates Desktop JSON files for sharing,
//   and never exports or echoes Web Client Secret.
// - Three setup modes (`do-it-for-me`, `guide-here`, `guide-browser`) with honest capability
//   checks: headless or Android local Hosts report embedded modes unavailable and default to
//   `guide-browser`.
// - Strict owner vs agent privilege separation:
//   - Owner RPC (`control`) requires trusted owner authority.
//   - Agent tool (`toolsForBot`) binds bot identity via persistent conversation ownership
//     (`resolveBotIdentity`), never model-supplied `botId`, and cannot grant itself clicking
//     control, accept terms/consent, submit credentials, or mark `client`/`connect` done.
// - Sensitive browser locking: locks bot browser observation and actions BEFORE User Data Policy
//   acceptance (`branding`), BEFORE Web OAuth Client Secret creation (`client`), and on any
//   Google auth/account page (`accounts.google.com`, `/auth/clients`). Falls back to system
//   browser when Host cannot isolate sensitive pages.
// - Authoritative Center verification: `client` and `connect` completion rely exclusively on
//   trusted Center status (`client.configured`, account status, per-service readiness). Chat
//   messages ("I authorized") are never accepted as evidence.
// - Non-sensitive persistence only: stores wizard progress under `<dataRoot>/google-setup/runs.json`
//   with zero secrets, tokens, callbacks, leases, or page bodies.

import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-durable';
import { resolveBotIdentity as defaultResolveBotIdentity } from '../bot-identity.js';
import {
  advanceGoogleConsole,
  classifyGoogleSetupPageSensitivity,
  deriveCenterBrandingLinks,
  GOOGLE_CONSOLE_START,
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_SERVICE_CHOICES,
  GOOGLE_SERVICES,
  googleChoices,
  googleConsoleStepUrl,
  isValidGoogleProjectId,
} from './console.js';
import {
  googleSetupAccount,
  googleSetupActionLabel,
  googleSetupBlocker,
  googleSetupDoneRefusal,
  googleSetupKeyBlocker,
} from './blocker.js';
import {
  assertNonEmptyString,
  assertNoSecretMaterial,
  GoogleSetupError,
  SETUP_ERROR_CODES,
  SETUP_ERROR_CODE_SET,
  setupError,
} from './errors.js';
import {
  buildBotGuidance,
  buildSetupCard,
  buildSetupPresentation,
  GOOGLE_SETUP_CARD_PRESENTATION,
  googleSetupCardKey,
  googleSetupCardsDue,
  googleSetupWaitingCard,
  stampCardRefs,
} from './guidance.js';
import {
  applyRunChange,
  assertModeAvailable,
  CENTER_CONFIGURED_SKIPPED_STEPS,
  currentGoogleSetupStep,
  evaluateModeAvailability,
  GOOGLE_SETUP_CARDS,
  GOOGLE_SETUP_MODES,
  GOOGLE_SETUP_RUN_MODES,
  GOOGLE_SETUP_STEPS,
  isCard,
  isDuplicateCardAnswer,
  isMode,
  isStep,
  normalizeServicesInput,
  personDoesGoogleSetupStep,
  resolveStartMode,
  reviveRun,
} from './rules.js';
import { createGoogleSetupStore } from './store.js';

export {
  GOOGLE_SETUP_STEPS,
  GOOGLE_SETUP_MODES,
  GOOGLE_SETUP_RUN_MODES,
  GOOGLE_SETUP_CARDS,
  GOOGLE_SERVICE_CHOICES,
  GOOGLE_SERVICES,
  GOOGLE_SETUP_CARD_PRESENTATION,
  GOOGLE_OAUTH_CALLBACK_PATH,
  SETUP_ERROR_CODES,
  GoogleSetupError,
  classifyGoogleSetupPageSensitivity,
  deriveCenterBrandingLinks,
  evaluateModeAvailability,
  buildSetupPresentation,
};

const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
const CONTROL_ACTIONS = new Set(['status', 'start', 'answer', 'advance', 'cancel', 'resume']);
const SYSTEM_SENSITIVE_LOCK_AUTHORITY = Object.freeze({
  actor: 'system',
  reason: 'google-setup-sensitive-lock',
  trustedSystem: true,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOwnerAuthority(authority) {
  if (authority === 'owner') return;
  if (
    isPlainObject(authority) &&
    (authority.actor === 'owner' || authority.trustedOwner === true) &&
    authority.actor !== 'bot' &&
    authority.actor !== 'agent'
  ) {
    return;
  }
  throw setupError(
    'SETUP_FORBIDDEN',
    'googleSetupControl requires authenticated owner authority.',
  );
}

function normalizeCenterStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.reachable === false) {
    return {
      reachable: false,
      client: { configured: false },
      accounts: [],
      ...(typeof raw.isAdmin === 'boolean' ? { isAdmin: raw.isAdmin } : {}),
      ...(typeof raw.publicUrl === 'string' ? { publicUrl: raw.publicUrl } : {}),
    };
  }
  const rawClient = isPlainObject(raw.client) ? raw.client : {};
  const client = {
    configured: rawClient.configured === true,
    ...(typeof rawClient.clientId === 'string' && rawClient.clientId
      ? { clientId: rawClient.clientId }
      : {}),
    ...(typeof rawClient.projectId === 'string' && rawClient.projectId
      ? { projectId: rawClient.projectId }
      : {}),
    ...(typeof rawClient.redirectUri === 'string' && rawClient.redirectUri
      ? { redirectUri: rawClient.redirectUri }
      : {}),
  };
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts
        .filter((entry) => isPlainObject(entry) && typeof entry.email === 'string' && entry.email)
        .map((entry) => ({
          ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
          email: entry.email,
          status: entry.status === 'reconnect' ? 'reconnect' : 'connected',
          ...(Number.isSafeInteger(entry.connectedAt) ? { connectedAt: entry.connectedAt } : {}),
          choices: googleChoices(entry.choices ?? []),
          services: Array.isArray(entry.services)
            ? entry.services
                .filter((svc) => isPlainObject(svc) && typeof svc.service === 'string')
                .map((svc) => ({
                  service: svc.service,
                  state: typeof svc.state === 'string' ? svc.state : 'error',
                  ...(typeof svc.detail === 'string' ? { detail: svc.detail } : {}),
                  ...(typeof svc.enableUrl === 'string' ? { enableUrl: svc.enableUrl } : {}),
                }))
            : [],
        }))
    : [];
  return {
    reachable: true,
    client,
    accounts,
    ...(raw.clientKey === 'works' || raw.clientKey === 'gone' || raw.clientKey === 'unknown'
      ? { clientKey: raw.clientKey }
      : {}),
    ...(typeof raw.isAdmin === 'boolean' ? { isAdmin: raw.isAdmin } : {}),
    ...(typeof raw.publicUrl === 'string' && raw.publicUrl ? { publicUrl: raw.publicUrl } : {}),
  };
}

function summarizeCenterForView(centerStatus) {
  if (!centerStatus) return null;
  const contactsStates = (centerStatus.accounts ?? [])
    .map((acc) => {
      const contacts = (acc.services ?? []).find((svc) => svc.service === 'contacts');
      return contacts ? { email: acc.email, state: contacts.state } : null;
    })
    .filter(Boolean);
  return {
    reachable: centerStatus.reachable !== false,
    ...(typeof centerStatus.isAdmin === 'boolean' ? { isAdmin: centerStatus.isAdmin } : {}),
    client: {
      configured: centerStatus.client?.configured === true,
      ...(centerStatus.client?.clientId ? { clientId: centerStatus.client.clientId } : {}),
      ...(centerStatus.client?.projectId ? { projectId: centerStatus.client.projectId } : {}),
      ...(centerStatus.client?.redirectUri ? { redirectUri: centerStatus.client.redirectUri } : {}),
    },
    accounts: (centerStatus.accounts ?? []).map((acc) => ({
      ...(acc.id ? { id: acc.id } : {}),
      email: acc.email,
      status: acc.status,
      choices: acc.choices,
      services: acc.services,
    })),
    ...(contactsStates.length > 0 ? { contactsStates } : {}),
  };
}

function withLabeledActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => ({
    ...action,
    label: googleSetupActionLabel(action),
  }));
}

function toolTextOutput(payload) {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_OUTPUT_BYTES) {
    return {
      isError: true,
      output: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 'INVALID_ARGUMENT',
            message: 'Google setup response exceeded size budget.',
          }),
        },
      ],
    };
  }
  return {
    output: [{ type: 'text', text }],
    structuredOutput: payload,
  };
}

function toolErrorOutput(code, message, extra = undefined) {
  return {
    isError: true,
    output: [
      {
        type: 'text',
        text: JSON.stringify({
          code,
          message,
          ...(extra ?? {}),
        }),
      },
    ],
  };
}

/**
 * Creates the Host-side Google setup wizard service.
 *
 * @param {object} [options]
 * @param {string} [options.dataRoot] Host data directory (stores `<dataRoot>/google-setup/runs.json`).
 * @param {object} [options.store] Optional custom store implementing `{ get, list, save, forget, close }`.
 * @param {object} [options.host] Host instance (`{ deviceId, getBot(botId), listBots() }`).
 * @param {function} [options.getHarness] Returns durable harness for `resolveBotIdentity`.
 * @param {function} [options.resolveBotIdentity] Optional override `(api, context) => Promise<{ botId, deviceId, ... }>`.
 * @param {function} [options.getCenterGoogleStatus] Async `({ botId, fresh, signal }) => CenterGoogleStatus`.
 * @param {string|function} [options.centerPublicUrl] Center public HTTPS URL or getter.
 * @param {function} [options.browserControl] Optional `botBrowserService.control(input, authority)` reference.
 * @param {function} [options.browserLock] Optional dedicated sensitive lock hook.
 * @param {function} [options.browserUnlock] Optional sensitive unlock notification hook.
 * @param {object|function} [options.platformCapabilities] Host platform capabilities (`{ isAndroidLocalHost, isHeadless, browserAvailable, canStreamInteract, canIsolateSensitivePages, reason }`).
 * @param {function} [options.isBotTurnRunning] Optional `(botId) => boolean | null`.
 * @param {function} [options.onEvent] Optional `(event) => void | Promise<void>` for delivering chat cards/answers.
 * @param {boolean} [options.enableToolPresentation] Whether `toolsForBot` publishes `api.details({ presentation })`.
 * @param {function} [options.now] Optional clock (default `Date.now`).
 */
export function createGoogleSetupService(options = {}) {
  const store = options.store ?? createGoogleSetupStore({ dataRoot: options.dataRoot });
  const host = options.host ?? null;
  const getHarness = options.getHarness ?? null;
  const customResolveBotIdentity = options.resolveBotIdentity ?? null;
  const getCenterGoogleStatus = options.getCenterGoogleStatus ?? null;
  const browserControl = options.browserControl ?? null;
  const browserLockHook = options.browserLock ?? null;
  const browserUnlockHook = options.browserUnlock ?? null;
  const isBotTurnRunning = options.isBotTurnRunning ?? null;
  const onEvent = options.onEvent ?? null;
  const enableToolPresentation = options.enableToolPresentation === true;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let closed = false;
  const botLanes = new Map();
  const consoleProgressByBot = new Map();
  const lastRewrittenCardByBot = new Map();

  function assertOpen() {
    if (closed) {
      throw setupError('SETUP_CLOSED', 'Google setup service is closed.');
    }
  }

  function assertLocalBot(botId, { allowArchived = false } = {}) {
    const cleanId = assertNonEmptyString(botId, 'botId', 200);
    assertNoSecretMaterial(cleanId, 'botId');
    if (host && typeof host.getBot === 'function') {
      const bot = host.getBot(cleanId);
      if (!bot || (host.deviceId && bot.deviceId !== host.deviceId)) {
        throw setupError('BOT_NOT_FOUND', `Local bot not found: ${cleanId}`);
      }
      if (!allowArchived && bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw setupError('BOT_ARCHIVED', `Bot ${cleanId} is archived and read-only.`);
      }
    }
    return cleanId;
  }

  function withBotLane(botId, operation) {
    assertOpen();
    const prev = botLanes.get(botId) ?? Promise.resolve();
    const next = prev.then(operation, operation);
    botLanes.set(botId, next);
    const cleanup = () => {
      if (botLanes.get(botId) === next) botLanes.delete(botId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  function resolveCenterPublicUrl(centerStatus) {
    if (typeof options.centerPublicUrl === 'function') {
      const value = options.centerPublicUrl();
      if (typeof value === 'string' && value.trim()) return value.trim();
    } else if (typeof options.centerPublicUrl === 'string' && options.centerPublicUrl.trim()) {
      return options.centerPublicUrl.trim();
    }
    if (typeof centerStatus?.publicUrl === 'string' && centerStatus.publicUrl.trim()) {
      return centerStatus.publicUrl.trim();
    }
    if (typeof centerStatus?.client?.redirectUri === 'string' && centerStatus.client.redirectUri.trim()) {
      try {
        return new URL(centerStatus.client.redirectUri).origin;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function readPlatformCapabilities(botId) {
    const base =
      typeof options.platformCapabilities === 'function'
        ? await options.platformCapabilities(botId)
        : options.platformCapabilities ?? {};
    const merged = { ...(isPlainObject(base) ? base : {}) };

    if (typeof browserControl === 'function') {
      try {
        const status = await browserControl({ action: 'status', botId }, SYSTEM_SENSITIVE_LOCK_AUTHORITY);
        if (isPlainObject(status)) {
          if (typeof status.available === 'boolean') merged.browserAvailable = status.available;
          if (typeof status.canStreamInteract === 'boolean') {
            merged.canStreamInteract = status.canStreamInteract;
          }
          if (typeof status.canIsolateSensitivePages === 'boolean') {
            merged.canIsolateSensitivePages = status.canIsolateSensitivePages;
          }
          if (typeof status.reason === 'string' && status.reason && !merged.reason) {
            merged.reason = status.reason;
          }
        }
      } catch {
        if (merged.browserAvailable === undefined) merged.browserAvailable = false;
        if (merged.canStreamInteract === undefined) merged.canStreamInteract = false;
      }
    }
    return merged;
  }

  async function readCenterStatus(botId, { fresh = false, signal = undefined } = {}) {
    if (typeof getCenterGoogleStatus !== 'function') return null;
    try {
      const raw = await getCenterGoogleStatus({ botId, fresh, signal });
      return normalizeCenterStatus(raw);
    } catch {
      return {
        reachable: false,
        client: { configured: false },
        accounts: [],
      };
    }
  }

  async function emit(event) {
    if (typeof onEvent !== 'function') return;
    try {
      await onEvent(event);
    } catch {
      // Event delivery failures must not corrupt committed setup state.
    }
  }

  async function lockBrowserForSensitiveStep(run, step, reason, availability) {
    const requiresSystemBrowser =
      reason === 'google-auth' ||
      (reason === 'oauth-client-secret' && availability?.clientStepRequiresSystemBrowser === true);

    const lockMeta = {
      active: true,
      step,
      reason,
      lockedAt: now(),
      ...(requiresSystemBrowser ? { requiresSystemBrowser: true } : {}),
    };

    if (typeof browserLockHook === 'function') {
      try {
        const result = await browserLockHook({
          botId: run.botId,
          pageId: run.browserPageId,
          step,
          reason,
          blockObservation: true,
          blockActions: true,
        });
        if (result?.requiresSystemBrowser === true) {
          lockMeta.requiresSystemBrowser = true;
        }
      } catch {
        // Logical lock remains enforced even if browser session is not open yet.
        if (reason === 'oauth-client-secret') lockMeta.requiresSystemBrowser = true;
      }
    } else if (typeof browserControl === 'function' && run.mode !== 'guide-browser') {
      try {
        await browserControl(
          {
            action: 'takeover',
            botId: run.botId,
            ...(run.browserPageId ? { pageId: run.browserPageId } : {}),
            reason,
            sensitive: true,
          },
          SYSTEM_SENSITIVE_LOCK_AUTHORITY,
        );
      } catch {
        // If Host browser cannot confirm takeover/isolation before Client Secret, fall back to system browser.
        if (reason === 'oauth-client-secret') lockMeta.requiresSystemBrowser = true;
      }
    }

    run.browserLock = lockMeta;
    await emit({
      type: 'browser-locked',
      botId: run.botId,
      runId: run.id,
      step,
      reason,
      requiresSystemBrowser: lockMeta.requiresSystemBrowser === true,
    });
    return lockMeta;
  }

  async function notifyBrowserUnlock(run, step, reason) {
    if (typeof browserUnlockHook !== 'function') return;
    try {
      await browserUnlockHook({
        botId: run.botId,
        pageId: run.browserPageId,
        step,
        reason,
      });
    } catch {
      // Never block setup progress on advisory unlock notification.
    }
  }

  function buildView(botId, run, { centerStatus, modeAvailability, cardsDue = [] }) {
    const turnRunning =
      typeof isBotTurnRunning === 'function' ? isBotTurnRunning(botId) : null;
    const blocker = googleSetupBlocker({
      run,
      google: centerStatus,
      botTurnRunning: turnRunning,
      now: now(),
    });
    const publicUrl = resolveCenterPublicUrl(centerStatus);
    const brandingLinks = deriveCenterBrandingLinks(publicUrl);
    const waitingRef = run ? googleSetupWaitingCard(run) : null;
    const card =
      run && waitingRef
        ? buildSetupCard(waitingRef, run, {
            blocker,
            modeAvailability,
            brandingLinks,
            centerStatus,
          })
        : run && run.state === 'done'
          ? buildSetupCard(
              { botId: run.botId, runId: run.id, card: 'connected' },
              run,
              { blocker, modeAvailability, brandingLinks, centerStatus },
            )
          : null;
    const builtDueCards = run
      ? cardsDue.map((ref) =>
          buildSetupCard(ref, run, {
            blocker,
            modeAvailability,
            brandingLinks,
            centerStatus,
          }),
        )
      : [];
    const guidance = buildBotGuidance(run, {
      blocker,
      centerStatus,
      brandingLinks,
      modeAvailability,
    });
    const step = run ? currentGoogleSetupStep(run) : null;
    const actions = withLabeledActions(blocker?.actions ?? card?.actions ?? []);

    return {
      id: run?.id ?? null,
      botId,
      revision: run?.revision ?? 0,
      state: run?.state ?? 'idle',
      ...(run ? { mode: run.mode } : {}),
      step,
      steps: run ? structuredClone(run.steps) : {},
      ...(run?.services ? { choices: [...run.services] } : {}),
      ...(run?.projectId ? { projectId: run.projectId } : {}),
      ...(run?.account ? { account: run.account } : {}),
      ...(run?.accounts ? { accounts: [...run.accounts] } : {}),
      ...(run?.kind ? { kind: run.kind } : {}),
      ...(run?.personStep ? { personStep: run.personStep } : {}),
      ...(run?.browserPageId ? { browserPageId: run.browserPageId } : {}),
      ...(run?.browserLock ? { browserLock: structuredClone(run.browserLock) } : {}),
      ...(run?.lastError ? { lastError: run.lastError } : {}),
      ...(run?.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run?.updatedAt !== undefined ? { updatedAt: run.updatedAt } : {}),
      ...(brandingLinks ? { brandingLinks } : {}),
      center: summarizeCenterForView(centerStatus),
      modeAvailability,
      blocker: blocker
        ? { ...blocker, actions: withLabeledActions(blocker.actions) }
        : null,
      actions,
      card,
      ...(builtDueCards.length > 0 ? { cardsDue: builtDueCards } : {}),
      guidance,
    };
  }

  function needsEmbeddedAccountPage(run) {
    return run?.state === 'running' &&
      (run.mode === 'do-it-for-me' || run.mode === 'guide-here') &&
      run.answers?.path?.values?.[0] === run.mode &&
      Boolean(run.services?.length) &&
      !run.browserLock?.active &&
      currentGoogleSetupStep(run) === 'account';
  }

  async function prepareAccountPage(run, modeAvailability) {
    if (typeof browserControl !== 'function' || !modeAvailability.modes[run.mode]?.available) return false;

    const botId = run.botId;
    try {
      const status = await browserControl({ action: 'status', botId }, SYSTEM_SENSITIVE_LOCK_AUTHORITY);
      if (!status?.available || !status.canStreamInteract) return false;
      if (run.browserPageId && status.tabs?.some(tab => tab.id === run.browserPageId)) return true;
      delete run.browserPageId;

      // The normal owner navigation rules also protect any active takeover.
      const opened = await browserControl({
        action: 'open',
        botId,
        url: googleConsoleStepUrl('account'),
      }, SYSTEM_SENSITIVE_LOCK_AUTHORITY);
      if (!opened?.pageId) return false;
      run.browserPageId = opened.pageId;
      return true;
    } catch {
      // A browser failure must leave the wizard available for retry or external guidance.
      return false;
    }
  }

  async function commitRun(prev, next, {
    centerStatus, modeAvailability, extraEvent = null, prepareBrowser = false,
  }) {
    if (prepareBrowser && needsEmbeddedAccountPage(next) &&
        (prev?.id !== next.id || !needsEmbeddedAccountPage(prev) || !next.browserPageId)) {
      await prepareAccountPage(next, modeAvailability);
    }
    const dueRefs = googleSetupCardsDue(prev, next);
    const stampedRefs = dueRefs.length > 0 ? stampCardRefs(next, dueRefs) : [];
    const saved = await store.save(next);
    const view = buildView(saved.botId, saved, {
      centerStatus,
      modeAvailability,
      cardsDue: stampedRefs,
    });
    if (stampedRefs.length > 0) {
      await emit({
        type: 'cards-due',
        botId: saved.botId,
        run: saved,
        view,
        cards: view.cardsDue ?? [],
      });
    }
    if (extraEvent) {
      await emit({ ...extraEvent, botId: saved.botId, run: saved, view });
    }
    await emit({ type: 'run-changed', botId: saved.botId, run: saved, view });
    return view;
  }

  async function rewriteWaitingCardOnce(run, { centerStatus, modeAvailability }) {
    const waiting = googleSetupWaitingCard(run);
    if (!waiting) return;
    const prev = lastRewrittenCardByBot.get(run.botId);
    if (prev && prev.runId === run.id && prev.revision === run.revision) return;
    const next = structuredClone(run);
    const [stamped] = stampCardRefs(next, [waiting]);
    next.revision = run.revision + 1;
    const saved = await store.save(next);
    lastRewrittenCardByBot.set(run.botId, { runId: saved.id, revision: saved.revision });
    const view = buildView(saved.botId, saved, {
      centerStatus,
      modeAvailability,
      cardsDue: stamped ? [stamped] : [],
    });
    await emit({
      type: 'cards-due',
      botId: saved.botId,
      run: saved,
      view,
      cards: view.cardsDue ?? [],
    });
  }

  function checkCardStaleness(current, { runId, card, step, cardCopy, expectedRevision }) {
    if (runId !== undefined) {
      const cleanRunId = assertNonEmptyString(runId, 'runId', 80);
      if (!current || cleanRunId !== current.id) {
        return { stale: true, staleReason: 'STALE_RUN' };
      }
    }
    if (cardCopy !== undefined) {
      if (!Number.isSafeInteger(cardCopy) || cardCopy < 0) {
        throw setupError('INVALID_ARGUMENT', 'cardCopy must be a non-negative integer.');
      }
      if (current && card) {
        const key = googleSetupCardKey({ card, step });
        const latest = current.cardCopies?.[key];
        if (latest !== undefined && cardCopy < latest) {
          return { stale: true, staleReason: 'STALE_CARD_COPY' };
        }
      }
    }
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw setupError('INVALID_ARGUMENT', 'expectedRevision must be a non-negative integer.');
      }
    }
    return null;
  }

  /**
   * Owner-only volatile RPC handler (`googleSetupControl`).
   * Input: `{ botId, action: 'status'|'start'|'answer'|'advance'|'cancel'|'resume', ... }`
   */
  async function control(rawInput, authority) {
    assertOpen();
    assertOwnerAuthority(authority);
    if (!isPlainObject(rawInput)) {
      throw setupError('INVALID_ARGUMENT', 'googleSetupControl input must be an object.');
    }
    assertNoSecretMaterial(rawInput, 'googleSetupControl');

    const action = rawInput.action;
    if (typeof action !== 'string' || !CONTROL_ACTIONS.has(action)) {
      throw setupError(
        'INVALID_ARGUMENT',
        `Unsupported setupControl action: ${String(action)}. Expected status, start, answer, advance, cancel, or resume.`,
      );
    }

    const botId = assertLocalBot(rawInput.botId, { allowArchived: action === 'status' });

    return withBotLane(botId, async () => {
      const current = await store.get(botId);
      const capabilities = await readPlatformCapabilities(botId);
      const modeAvailability = evaluateModeAvailability(capabilities);
      const freshCenter =
        rawInput.fresh === true ||
        action === 'start' ||
        action === 'advance' ||
        action === 'resume' ||
        (action === 'answer' &&
          rawInput.card === 'step' &&
          Array.isArray(rawInput.values) &&
          (rawInput.values[0] === 'continue-without' ||
            rawInput.values[0] === 'keep-account' ||
            (rawInput.values[0] === 'done' &&
              (rawInput.values[1] === 'client' || rawInput.values[1] === 'connect'))));
      const centerStatus = await readCenterStatus(botId, {
        fresh: freshCenter,
        signal: rawInput.signal,
      });

      if (action === 'status') {
        return buildView(botId, current, { centerStatus, modeAvailability });
      }

      if (action === 'start') {
        const restart = rawInput.restart === true;
        if (current?.state === 'running' && !restart) {
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }
        if (
          centerStatus &&
          centerStatus.reachable !== false &&
          centerStatus.client?.configured !== true &&
          centerStatus.isAdmin === false
        ) {
          throw setupError(
            'SETUP_ADMIN_REQUIRED',
            'Center does not have a Google Web OAuth app configured yet. Contact your Center administrator.',
          );
        }

        const mode = resolveStartMode('owner', rawInput.mode ?? 'unchosen', modeAvailability);
        const ts = now();
        const next = {
          id: randomUUID(),
          botId,
          state: 'running',
          mode,
          steps: {},
          answers: {},
          ...(rawInput.browserPageId !== undefined
            ? { browserPageId: assertNonEmptyString(rawInput.browserPageId, 'browserPageId', 200) }
            : {}),
          startedAt: ts,
          updatedAt: ts,
          revision: (current?.revision ?? 0) + 1,
        };

        if (rawInput.choices !== undefined || rawInput.services !== undefined) {
          const picked = normalizeServicesInput(rawInput.choices ?? rawInput.services);
          next.services = picked;
          next.answers.services = { values: picked, at: ts };
        }
        if (mode !== 'unchosen') {
          next.answers.path = { values: [mode], at: ts };
        }

        // Journey 1A shortcut: if Center Web OAuth client is already configured and owner
        // is not explicitly reconfiguring it, skip Cloud Console build steps and go to connect.
        if (centerStatus?.client?.configured === true && rawInput.reconfigureClient !== true) {
          for (const step of CENTER_CONFIGURED_SKIPPED_STEPS) {
            next.steps[step] = { status: 'skipped', at: ts };
          }
          if (centerStatus.client.projectId && isValidGoogleProjectId(centerStatus.client.projectId)) {
            next.projectId = centerStatus.client.projectId;
          }
          if (next.mode === 'unchosen') {
            next.mode = 'guide-browser';
          }
        }

        const view = await commitRun(current, next, { centerStatus, modeAvailability, prepareBrowser: true });
        return { ...view, applied: true };
      }

      // Check old-card staleness before mutating.
      const staleness = checkCardStaleness(current, {
        runId: rawInput.runId,
        card: rawInput.card,
        step: rawInput.step,
        cardCopy: rawInput.cardCopy,
        expectedRevision: rawInput.expectedRevision,
      });
      if (staleness) {
        return {
          ...buildView(botId, current, { centerStatus, modeAvailability }),
          applied: false,
          idempotent: true,
          ...staleness,
        };
      }

      if (action === 'cancel') {
        if (!current) {
          return {
            ...buildView(botId, null, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }
        if (current.state === 'cancelled') {
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }
        if (rawInput.expectedRevision !== undefined && rawInput.expectedRevision !== current.revision) {
          throw setupError(
            'SETUP_REVISION_CONFLICT',
            `Setup revision mismatch: expected ${rawInput.expectedRevision}, current is ${current.revision}.`,
            { expectedRevision: rawInput.expectedRevision, currentRevision: current.revision },
          );
        }
        if (current.state !== 'running' && current.state !== 'failed') {
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }
        const prevLock = current.browserLock;
        const next = structuredClone(current);
        next.state = 'cancelled';
        delete next.browserLock;
        next.updatedAt = now();
        next.revision = current.revision + 1;
        if (prevLock?.active) {
          await notifyBrowserUnlock(next, prevLock.step, 'cancelled');
        }
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ...view, applied: true };
      }

      if (action === 'resume') {
        if (!current) {
          throw setupError('SETUP_NOT_RUNNING', 'No Google setup run exists for this bot.');
        }
        const requestedMode = rawInput.mode;
        if (requestedMode !== undefined) {
          if (!isMode(requestedMode)) {
            throw setupError('INVALID_ARGUMENT', `Invalid setup mode: ${String(requestedMode)}`);
          }
          assertModeAvailable(requestedMode, modeAvailability);
        }
        if (rawInput.expectedRevision !== undefined && rawInput.expectedRevision !== current.revision) {
          throw setupError(
            'SETUP_REVISION_CONFLICT',
            `Setup revision mismatch: expected ${rawInput.expectedRevision}, current is ${current.revision}.`,
            { expectedRevision: rawInput.expectedRevision, currentRevision: current.revision },
          );
        }
        if (current.state === 'running' && (requestedMode === undefined || requestedMode === current.mode)) {
          if (needsEmbeddedAccountPage(current)) {
            const next = structuredClone(current);
            const pageReady = await prepareAccountPage(next, modeAvailability);
            if (next.browserPageId !== current.browserPageId) {
              next.updatedAt = now();
              next.revision = current.revision + 1;
              const view = await commitRun(current, next, { centerStatus, modeAvailability });
              return { ...view, applied: true };
            }
            if (!pageReady) {
              const { browserPageId: _unconfirmedPage, ...view } = buildView(botId, current, { centerStatus, modeAvailability });
              return { ...view, applied: false, idempotent: true };
            }
          }
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }
        const ts = now();
        let next = reviveRun(current, 'owner', { action: 'resume' }, ts);
        if (!next) {
          if (current.state !== 'running') {
            throw setupError(
              'SETUP_NOT_RUNNING',
              `Cannot resume setup in state "${current.state}". Start a new run instead.`,
            );
          }
          next = structuredClone(current);
          next.updatedAt = ts;
          next.revision = current.revision + 1;
        }
        if (requestedMode !== undefined) {
          next.mode = requestedMode;
          delete next.personStep;
          next.answers.path = { values: [requestedMode], at: ts };
        }
        const view = await commitRun(current, next, { centerStatus, modeAvailability, prepareBrowser: true });
        return { ...view, applied: true };
      }

      if (action === 'answer') {
        const card = rawInput.card;
        const values = rawInput.values;
        if (!isCard(card)) {
          throw setupError('INVALID_ARGUMENT', `Unknown setup card: ${String(card)}`);
        }
        if (!Array.isArray(values) || values.length === 0) {
          throw setupError('INVALID_ARGUMENT', 'answer requires a non-empty values array.');
        }

        if (!current) {
          throw setupError('SETUP_NOT_RUNNING', 'No Google setup run exists for this bot.');
        }

        // Duplicate answer on current run is strictly idempotent (no revision bump, no conflict error).
        if (
          current.state === 'running' &&
          card !== 'step' &&
          isDuplicateCardAnswer(current, card, values)
        ) {
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }

        if (rawInput.expectedRevision !== undefined && rawInput.expectedRevision !== current.revision) {
          throw setupError(
            'SETUP_REVISION_CONFLICT',
            `Setup revision mismatch: expected ${rawInput.expectedRevision}, current is ${current.revision}.`,
            { expectedRevision: rawInput.expectedRevision, currentRevision: current.revision },
          );
        }

        const ts = now();
        const revived = reviveRun(current, 'owner', { action: 'answer', card, values }, ts);
        if (revived) {
          const view = await commitRun(current, revived, {
            centerStatus,
            modeAvailability,
            prepareBrowser: true,
            extraEvent: { type: 'owner-answer', card, values },
          });
          return { ...view, applied: true };
        }

        if (current.state !== 'running') {
          throw setupError('SETUP_NOT_RUNNING', 'Google setup is not currently running.');
        }

        // Center-verified gate for owner clicking Done on `client` or `connect`.
        if (card === 'step' && values[0] === 'done' && values[1] === 'client') {
          const keyBlocker = googleSetupKeyBlocker(current, centerStatus);
          if (keyBlocker) {
            if (!current.clientMissed && keyBlocker.kind !== 'center-unreachable') {
              const missed = structuredClone(current);
              applyRunChange(missed, 'owner', { action: 'client-missed' }, ts);
              missed.updatedAt = ts;
              missed.revision = current.revision + 1;
              const view = await commitRun(current, missed, { centerStatus, modeAvailability });
              return { ...view, applied: false };
            }
            return {
              ...buildView(botId, current, { centerStatus, modeAvailability }),
              applied: false,
            };
          }
        }

        if (card === 'step' && values[0] === 'done' && values[1] === 'connect') {
          const account = googleSetupAccount(current, centerStatus?.accounts ?? []);
          if (!centerStatus || centerStatus.reachable === false || !account) {
            return {
              ...buildView(botId, current, { centerStatus, modeAvailability }),
              applied: false,
            };
          }
        }

        const next = structuredClone(current);
        const prevLock = next.browserLock;
        applyRunChange(
          next,
          'owner',
          { action: 'answer', card, values },
          ts,
          {
            availability: modeAvailability,
            centerClientConfigured: centerStatus?.client?.configured === true,
          },
        );

        // Lock browser if direct configuration landed on client step.
        if (
          card === 'path' &&
          (values[0] === 'configure-directly' || values[0] === 'import') &&
          centerStatus?.client?.configured !== true
        ) {
          await lockBrowserForSensitiveStep(next, 'client', 'oauth-client-secret', modeAvailability);
        }

        // If owner redoes client step, activate sensitive lock immediately.
        if (card === 'step' && values[0] === 'redo' && values[1] === 'client') {
          await lockBrowserForSensitiveStep(next, 'client', 'oauth-client-secret', modeAvailability);
        }

        // If owner finished `connect` or resolved a post-connect blocker (`continue-without` /
        // `keep-account`) and Center confirms 100% readiness, finalize the run.
        if (
          (card === 'step' &&
            (values[0] === 'continue-without' ||
              values[0] === 'keep-account' ||
              (values[0] === 'done' && values[1] === 'connect'))) ||
          ((card === 'services' || card === 'account') && next.steps.connect?.status === 'done')
        ) {
          const refusal = googleSetupDoneRefusal(next, centerStatus);
          if (refusal === null) {
            next.steps.connect = { status: 'done', by: 'user', at: ts };
            next.state = 'done';
            delete next.personStep;
            delete next.browserLock;
          }
        }

        if (prevLock?.active && !next.browserLock?.active) {
          await notifyBrowserUnlock(next, prevLock.step, 'owner-completed');
        }

        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, {
          centerStatus,
          modeAvailability,
          prepareBrowser: true,
          extraEvent: { type: 'owner-answer', card, values },
        });
        return { ...view, applied: true };
      }

      if (action === 'advance') {
        if (!current) {
          throw setupError('SETUP_NOT_RUNNING', 'No Google setup run exists for this bot.');
        }
        if (current.state !== 'running') {
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
            idempotent: true,
          };
        }
        if (rawInput.expectedRevision !== undefined && rawInput.expectedRevision !== current.revision) {
          throw setupError(
            'SETUP_REVISION_CONFLICT',
            `Setup revision mismatch: expected ${rawInput.expectedRevision}, current is ${current.revision}.`,
            { expectedRevision: rawInput.expectedRevision, currentRevision: current.revision },
          );
        }

        const ts = now();
        const next = structuredClone(current);
        const prevLock = next.browserLock;
        let mutated = false;

        if (rawInput.mode !== undefined) {
          if (!isMode(rawInput.mode)) {
            throw setupError('INVALID_ARGUMENT', `Invalid setup mode: ${String(rawInput.mode)}`);
          }
          assertModeAvailable(rawInput.mode, modeAvailability);
          next.mode = rawInput.mode;
          next.answers.path = { values: [rawInput.mode], at: ts };
          delete next.personStep;
          mutated = true;
        }
        if (rawInput.choices !== undefined || rawInput.services !== undefined) {
          const picked = normalizeServicesInput(rawInput.choices ?? rawInput.services);
          next.services = picked;
          next.answers.services = { values: picked, at: ts };
          mutated = true;
        }
        if (rawInput.account !== undefined) {
          applyRunChange(next, 'owner', { action: 'set', account: rawInput.account }, ts);
          mutated = true;
        }
        if (rawInput.kind !== undefined) {
          applyRunChange(next, 'owner', { action: 'set', kind: rawInput.kind }, ts);
          mutated = true;
        }
        if (rawInput.projectId !== undefined) {
          applyRunChange(next, 'owner', { action: 'set', projectId: rawInput.projectId }, ts);
          mutated = true;
        }

        const targetStep = rawInput.step !== undefined ? rawInput.step : currentGoogleSetupStep(next);
        if (targetStep !== null) {
          if (!isStep(targetStep)) {
            throw setupError('INVALID_ARGUMENT', `Unknown setup step: ${String(targetStep)}`);
          }
          if (targetStep === 'client') {
            const keyBlocker = googleSetupKeyBlocker(next, centerStatus);
            if (!keyBlocker) {
              next.steps.client = { status: 'done', by: 'user', at: ts };
              delete next.clientMissed;
              if (next.personStep === 'client') delete next.personStep;
              if (next.browserLock?.step === 'client') delete next.browserLock;
              mutated = true;
            } else if (!next.clientMissed && keyBlocker.kind !== 'center-unreachable') {
              applyRunChange(next, 'owner', { action: 'client-missed' }, ts);
              mutated = true;
            }
          } else if (targetStep === 'connect') {
            const matchedAccount = googleSetupAccount(next, centerStatus?.accounts ?? []);
            if (centerStatus && centerStatus.reachable !== false && matchedAccount) {
              next.steps.connect = { status: 'done', by: 'user', at: ts };
              const refusal = googleSetupDoneRefusal(next, centerStatus);
              if (refusal === null) {
                next.state = 'done';
                delete next.personStep;
                delete next.browserLock;
              }
              mutated = true;
            }
          } else {
            next.steps[targetStep] = {
              status: 'done',
              by: 'user',
              at: ts,
              ...(rawInput.note !== undefined ? { note: assertNonEmptyString(rawInput.note, 'note', 500) } : {}),
            };
            if (next.personStep === targetStep) delete next.personStep;
            if (next.browserLock?.step === targetStep) delete next.browserLock;
            mutated = true;
          }
        }

        // If advancing landed directly on `client`, proactively lock browser before Create.
        if (next.state === 'running' && currentGoogleSetupStep(next) === 'client' && !next.browserLock?.active) {
          await lockBrowserForSensitiveStep(next, 'client', 'oauth-client-secret', modeAvailability);
          mutated = true;
        }

        if (!mutated) {
          return {
            ...buildView(botId, current, { centerStatus, modeAvailability }),
            applied: false,
          };
        }

        if (prevLock?.active && !next.browserLock?.active) {
          await notifyBrowserUnlock(next, prevLock.step, 'owner-advanced');
        }
        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability, prepareBrowser: true });
        return { ...view, applied: true };
      }

      throw setupError('INVALID_ARGUMENT', `Unhandled setupControl action: ${String(action)}`);
    });
  }

  /**
   * Computes the current agent browser policy for `botId` (and optional target `url`).
   * Used by `bot-browser` / transport hooks to enforce read-only mode in `guide-here`
   * and hard observation/action blocks on sensitive pages & locked setup steps.
   */
  async function getAgentBrowserPolicy(botId, url = undefined) {
    assertOpen();
    if (url !== undefined) {
      const sensitivity = classifyGoogleSetupPageSensitivity(url);
      if (sensitivity.sensitive) {
        return {
          allowed: false,
          mode: 'locked-sensitive',
          reason: sensitivity.reason,
          note: sensitivity.note,
          handoffToSystemBrowser: sensitivity.handoffToSystemBrowser === true,
        };
      }
    }
    const run = await store.get(botId);
    if (!run || run.state !== 'running') {
      return { allowed: true, mode: 'unrestricted' };
    }
    if (run.browserLock?.active) {
      return {
        allowed: false,
        mode: 'locked-sensitive',
        step: run.browserLock.step,
        reason: run.browserLock.reason,
        requiresSystemBrowser: run.browserLock.requiresSystemBrowser === true,
      };
    }
    if (run.mode === 'guide-browser') {
      return {
        allowed: false,
        mode: 'none',
        reason: 'Setup is running in the owner’s own system browser.',
      };
    }
    const current = currentGoogleSetupStep(run);
    if (current === 'client' || current === 'connect') {
      return {
        allowed: false,
        mode: 'locked-sensitive',
        step: current,
        reason: current === 'client' ? 'oauth-client-secret' : 'google-auth',
      };
    }
    if (current && personDoesGoogleSetupStep(run, current)) {
      return {
        allowed: true,
        mode: 'read-only',
        step: current,
        reason: 'Owner does the clicking on this step; bot may only read non-sensitive pages.',
      };
    }
    return {
      allowed: true,
      mode: 'drive',
      step: current,
    };
  }

  /**
   * URL-only observation hook for `guide-here` / `do-it-for-me`.
   * Never reads page bodies or cookies. Detects sensitive URLs (locking immediately)
   * and tracks URL-derived `projectId` without ever completing `client` or `connect`.
   */
  async function syncBrowserUrl(botId, url) {
    assertOpen();
    const cleanBotId = assertLocalBot(botId);
    assertNoSecretMaterial(url, 'url');
    return withBotLane(cleanBotId, async () => {
      const current = await store.get(cleanBotId);
      const sensitivity = classifyGoogleSetupPageSensitivity(url);
      if (!current || current.state !== 'running') {
        return { sensitivity, locked: sensitivity.sensitive, run: current };
      }

      const capabilities = await readPlatformCapabilities(cleanBotId);
      const modeAvailability = evaluateModeAvailability(capabilities);
      const centerStatus = await readCenterStatus(cleanBotId, { fresh: false });

      if (sensitivity.sensitive) {
        const next = structuredClone(current);
        const step =
          sensitivity.reason === 'oauth-client-secret'
            ? 'client'
            : currentGoogleSetupStep(next) ?? 'account';
        await lockBrowserForSensitiveStep(next, step, sensitivity.reason, modeAvailability);
        next.updatedAt = now();
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { sensitivity, locked: true, view };
      }

      const prevProgress = consoleProgressByBot.get(cleanBotId) ?? GOOGLE_CONSOLE_START;
      const nextProgress = advanceGoogleConsole(prevProgress, url);
      consoleProgressByBot.set(cleanBotId, nextProgress);

      if (nextProgress.projectId && nextProgress.projectId !== current.projectId) {
        const next = structuredClone(current);
        next.projectId = nextProgress.projectId;
        next.updatedAt = now();
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { sensitivity, locked: false, progress: nextProgress, view };
      }

      return { sensitivity, locked: false, progress: nextProgress };
    });
  }

  /**
   * Executes an agent-side `google_setup` tool action for a verified `botId`.
   */
  async function executeBotAction(botId, args, { signal } = {}) {
    assertOpen();
    assertLocalBot(botId);
    assertNoSecretMaterial(args, 'google_setup');

    return withBotLane(botId, async () => {
      const action = args?.action;
      const current = await store.get(botId);
      const capabilities = await readPlatformCapabilities(botId);
      const modeAvailability = evaluateModeAvailability(capabilities);
      const needsFreshCenter =
        action === 'done' ||
        action === 'start' ||
        (action === 'step' && args.step === 'client' && args.status === 'done');
      const centerStatus = await readCenterStatus(botId, { fresh: needsFreshCenter, signal });

      if (action === 'show') {
        const view = buildView(botId, current, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (action === 'start') {
        if (current?.state === 'running') {
          const view = buildView(botId, current, { centerStatus, modeAvailability });
          return { ok: true, resumed: true, view };
        }

        // If Center already has a configured app + ready account, no setup is needed!
        if (centerStatus?.reachable !== false && centerStatus?.client?.configured === true) {
          const readyAccounts = (centerStatus.accounts ?? []).filter(
            (acc) =>
              acc.status === 'connected' &&
              (acc.services ?? []).some((svc) => svc.service !== 'contacts' && svc.state === 'ready'),
          );
          if (readyAccounts.length > 0 && args.reconfigureClient !== true) {
            const view = buildView(botId, current, { centerStatus, modeAvailability });
            return {
              ok: true,
              routed: 'ready',
              message:
                'Center already has a configured Google Web OAuth app and ready shared account(s). All bots can use Google MCP directly without setup.',
              view,
            };
          }
        }

        if (
          centerStatus &&
          centerStatus.reachable !== false &&
          centerStatus.client?.configured !== true &&
          centerStatus.isAdmin === false
        ) {
          const view = buildView(botId, current, { centerStatus, modeAvailability });
          return {
            ok: false,
            routed: 'admin-required',
            message:
              'Center does not have a Google Web OAuth app configured yet. Ask the Center administrator to configure it once.',
            view,
          };
        }

        const mode = resolveStartMode('bot', args.mode, modeAvailability);
        const ts = now();
        const next = {
          id: randomUUID(),
          botId,
          state: 'running',
          mode,
          steps: {},
          answers: {},
          ...(args.browserPageId !== undefined
            ? { browserPageId: assertNonEmptyString(args.browserPageId, 'browserPageId', 200) }
            : {}),
          startedAt: ts,
          updatedAt: ts,
          revision: (current?.revision ?? 0) + 1,
        };

        if (centerStatus?.client?.configured === true) {
          for (const step of CENTER_CONFIGURED_SKIPPED_STEPS) {
            next.steps[step] = { status: 'skipped', at: ts };
          }
          if (centerStatus.client.projectId && isValidGoogleProjectId(centerStatus.client.projectId)) {
            next.projectId = centerStatus.client.projectId;
          }
          if (next.mode === 'unchosen') next.mode = 'guide-browser';
        }

        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (!current || current.state !== 'running') {
        throw setupError(
          'SETUP_NOT_RUNNING',
          'No Google setup run is active for this bot. Call google_setup(action="start") first.',
        );
      }

      const ts = now();

      if (action === 'step') {
        if (!isStep(args.step)) {
          throw setupError('INVALID_ARGUMENT', `Unknown setup step: ${String(args.step)}`);
        }

        // Bot cannot mark `client` done unless trusted Center status confirms client.configured.
        if (args.step === 'client' && args.status === 'done') {
          const keyBlocker = googleSetupKeyBlocker(current, centerStatus);
          if (keyBlocker) {
            if (!current.clientMissed && keyBlocker.kind !== 'center-unreachable') {
              const missed = structuredClone(current);
              applyRunChange(missed, 'owner', { action: 'client-missed' }, ts);
              missed.updatedAt = ts;
              missed.revision = current.revision + 1;
              await commitRun(current, missed, { centerStatus, modeAvailability });
            } else {
              await rewriteWaitingCardOnce(current, { centerStatus, modeAvailability });
            }
            throw setupError(
              'SETUP_NOT_READY',
              'Center does not have a valid configured Web OAuth client for this project yet. The owner must save the Client ID and Client Secret in the private Center configuration control.',
            );
          }
          // Center confirmed client configured: advance client cleanly.
          const next = structuredClone(current);
          const prevLock = next.browserLock;
          next.steps.client = { status: 'done', by: 'user', at: ts };
          delete next.clientMissed;
          if (next.personStep === 'client') delete next.personStep;
          if (next.browserLock?.step === 'client') delete next.browserLock;
          if (prevLock?.active && !next.browserLock?.active) {
            await notifyBrowserUnlock(next, prevLock.step, 'center-client-verified');
          }
          next.updatedAt = ts;
          next.revision = current.revision + 1;
          const view = await commitRun(current, next, { centerStatus, modeAvailability });
          return { ok: true, view };
        }

        const next = structuredClone(current);
        applyRunChange(
          next,
          'bot',
          {
            action: 'step',
            step: args.step,
            status: args.status,
            ...(args.note !== undefined ? { note: args.note } : {}),
          },
          ts,
        );

        // Activating `client` or `connect` proactively locks the bot browser BEFORE
        // any sensitive dialog or OAuth screen can open!
        if (args.step === 'client' && args.status === 'active') {
          await lockBrowserForSensitiveStep(next, 'client', 'oauth-client-secret', modeAvailability);
        } else if (args.step === 'connect' && args.status === 'active') {
          await lockBrowserForSensitiveStep(next, 'connect', 'google-auth', modeAvailability);
        }

        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (action === 'need_user') {
        if (!isStep(args.step)) {
          throw setupError('INVALID_ARGUMENT', `Unknown setup step: ${String(args.step)}`);
        }
        const next = structuredClone(current);
        applyRunChange(
          next,
          'bot',
          { action: 'need-user', step: args.step, note: args.note },
          ts,
        );

        const lockReason =
          args.step === 'branding'
            ? 'policy-consent'
            : args.step === 'client'
              ? 'oauth-client-secret'
              : args.step === 'connect'
                ? 'google-auth'
                : args.lockBrowser === true
                  ? 'user-takeover'
                  : null;
        if (lockReason) {
          await lockBrowserForSensitiveStep(next, args.step, lockReason, modeAvailability);
        }

        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (action === 'set') {
        const next = structuredClone(current);
        applyRunChange(
          next,
          'bot',
          {
            action: 'set',
            ...(args.account !== undefined ? { account: args.account } : {}),
            ...(args.accounts !== undefined ? { accounts: args.accounts } : {}),
            ...(args.kind !== undefined ? { kind: args.kind } : {}),
            ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
            ...(args.services !== undefined ? { services: args.services } : {}),
            ...(args.browserPageId !== undefined ? { browserPageId: args.browserPageId } : {}),
          },
          ts,
        );
        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (action === 'record_typed_answer') {
        const next = structuredClone(current);
        applyRunChange(
          next,
          'bot',
          {
            action: 'answer',
            card: args.card,
            values: args.values,
          },
          ts,
          {
            availability: modeAvailability,
            centerClientConfigured: centerStatus?.client?.configured === true,
          },
        );
        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (action === 'done') {
        const refusal = googleSetupDoneRefusal(current, centerStatus);
        if (refusal) {
          await rewriteWaitingCardOnce(current, { centerStatus, modeAvailability });
          throw setupError('SETUP_NOT_READY', `${refusal} Run done again once Center confirms readiness.`);
        }
        const next = structuredClone(current);
        if (next.steps.connect?.status !== 'done') {
          next.steps.connect = { status: 'done', by: 'user', at: ts };
        }
        const prevLock = next.browserLock;
        applyRunChange(next, 'bot', { action: 'done' }, ts);
        if (prevLock?.active) {
          await notifyBrowserUnlock(next, prevLock.step, 'setup-done');
        }
        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      if (action === 'fail') {
        const next = structuredClone(current);
        applyRunChange(next, 'bot', { action: 'fail', error: args.error }, ts);
        next.updatedAt = ts;
        next.revision = current.revision + 1;
        const view = await commitRun(current, next, { centerStatus, modeAvailability });
        return { ok: true, view };
      }

      throw setupError('INVALID_ARGUMENT', `Unknown google_setup action: ${String(action)}`);
    });
  }

  /**
   * Returns PiBot `defineTool` tool definitions for the Bot's conversation runtime.
   *
   * @param {object} [context]
   * @param {string} [context.botId] Optional pre-bound verified botId (must match `resolveBotIdentity` when harness is active).
   * @param {object} [context.host] Optional override for `host`.
   * @param {function} [context.getHarness] Optional override for `getHarness`.
   * @param {function} [context.resolveBotIdentity] Optional override for identity resolver.
   */
  function toolsForBot(toolCtx = {}) {
    const boundBotId = typeof toolCtx?.botId === 'string' && toolCtx.botId ? toolCtx.botId : null;
    const effectiveHost = toolCtx?.host ?? host;
    const effectiveGetHarness = toolCtx?.getHarness ?? getHarness;
    const effectiveResolver = toolCtx?.resolveBotIdentity ?? customResolveBotIdentity;

    async function resolveCallerBotId(api, execContext) {
      if (typeof effectiveResolver === 'function') {
        const identity = await effectiveResolver(api, execContext);
        if (!identity?.botId) {
          throw setupError('BOT_CONTEXT_REQUIRED', 'Unable to verify bot conversation ownership.');
        }
        if (boundBotId && identity.botId !== boundBotId) {
          throw setupError('SETUP_FORBIDDEN', 'A bot can only operate on its own Google setup.');
        }
        return identity.botId;
      }
      if (effectiveHost && typeof effectiveGetHarness === 'function' && api?.conversationId !== undefined) {
        const identity = await defaultResolveBotIdentity(
          effectiveHost,
          effectiveGetHarness(),
          api.conversationId,
          execContext,
        );
        if (boundBotId && identity.botId !== boundBotId) {
          throw setupError('SETUP_FORBIDDEN', 'A bot can only operate on its own Google setup.');
        }
        return identity.botId;
      }
      if (boundBotId) return boundBotId;
      throw setupError('BOT_CONTEXT_REQUIRED', 'Conversation is not bound to a verified local bot.');
    }

    return [
      defineTool({
        name: 'google_setup',
        description:
          'Manage the Center Google Web OAuth setup wizard for this bot (three modes: do-it-for-me, guide-here, guide-browser). ' +
          'Call action="show" at the start of every turn to read current mode, steps, blockers, exact owner card buttons, and executable step instructions. ' +
          'Call action="start" to initiate setup (or check whether Center already has a ready shared Google connection). ' +
          'Use action="set" for non-sensitive fields (account, accounts, kind, projectId, services, browserPageId), ' +
          'action="step" to mark non-sensitive steps active/done/skipped/failed, ' +
          'action="need_user" to lock and hand off sensitive steps (User Data Policy checkbox in branding, Web OAuth Client Secret in client, system-browser OAuth in connect) or after 2 misses, ' +
          'action="record_typed_answer" for non-privileged choices typed in chat, ' +
          'action="done" to finalize ONLY after Center verifies every selected service is ready, and action="fail" if setup cannot continue. ' +
          'Never pass Client Secret, OAuth tokens, or callback URLs; never click terms/consent boxes or read the Client Secret dialog.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'show',
                'start',
                'step',
                'need_user',
                'set',
                'record_typed_answer',
                'done',
                'fail',
              ],
            },
            mode: {
              type: 'string',
              enum: ['unchosen', 'guide-here', 'guide-browser'],
            },
            step: {
              type: 'string',
              enum: [...GOOGLE_SETUP_STEPS],
            },
            status: {
              type: 'string',
              enum: ['pending', 'active', 'done', 'skipped', 'failed'],
            },
            note: { type: 'string', minLength: 1, maxLength: 500 },
            error: { type: 'string', minLength: 1, maxLength: 500 },
            account: { type: 'string', minLength: 1, maxLength: 320 },
            accounts: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 320 },
              maxItems: 10,
            },
            kind: { type: 'string', enum: ['work', 'personal'] },
            projectId: { type: 'string', minLength: 6, maxLength: 63 },
            services: {
              type: 'array',
              items: { type: 'string', enum: [...GOOGLE_SERVICE_CHOICES] },
              minItems: 1,
              maxItems: 3,
            },
            browserPageId: { type: 'string', minLength: 1, maxLength: 200 },
            card: {
              type: 'string',
              enum: [...GOOGLE_SETUP_CARDS],
            },
            values: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 320 },
              minItems: 1,
              maxItems: 20,
            },
            lockBrowser: { type: 'boolean' },
            reconfigureClient: { type: 'boolean' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        replay: 'unsafe',
        outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
        async execute(args, api, execContext) {
          try {
            execContext?.abortSignal?.throwIfAborted();
            const callerBotId = await resolveCallerBotId(api, execContext);
            execContext?.abortSignal?.throwIfAborted();
            const result = await executeBotAction(callerBotId, args ?? {}, {
              signal: execContext?.abortSignal,
            });
            execContext?.abortSignal?.throwIfAborted();
            if (enableToolPresentation && result?.view && typeof api?.details === 'function') {
              const presentation = buildSetupPresentation(result.view);
              if (presentation) {
                await api.details({ presentation }, execContext);
              }
            }
            return toolTextOutput(result);
          } catch (error) {
            execContext?.abortSignal?.throwIfAborted();
            if (SETUP_ERROR_CODE_SET.has(error?.code)) {
              return toolErrorOutput(error.code, error.message);
            }
            throw error;
          }
        },
      }),
    ];
  }

  return {
    control,
    toolsForBot,
    getAgentBrowserPolicy,
    syncBrowserUrl,
    getRun: (botId) => store.get(botId),
    listRuns: () => store.list(),
    forgetBot: async (botId) => {
      consoleProgressByBot.delete(botId);
      lastRewrittenCardByBot.delete(botId);
      await store.forget(botId);
    },
    async close() {
      closed = true;
      await Promise.allSettled([...botLanes.values()]);
      consoleProgressByBot.clear();
      lastRewrittenCardByBot.clear();
      await store.close();
    },
  };
}
