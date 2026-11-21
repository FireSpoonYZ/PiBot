// host-core/google-setup/blocker.js
// Determines where a bot's Google setup run is blocked and the exact owner actions
// available to move it forward, using trusted Center status as the sole source of
// truth for Web OAuth client configuration, account connection, and per-service
// readiness.
//
// Portions adapted from stablyai/orca (MIT License, Copyright (c) 2026 Lovecast Inc.):
// - src/shared/google/google-setup-blocker.ts
//
// Key PiBot adaptations (per 04-frontend-interaction.md):
// - Center Web OAuth client configuration (`client.configured`) replaces local Desktop
//   key files; never offers secret export.
// - Transient Center unreachability (`reachable === false`) produces `center-unreachable`
//   with `check-again` rather than falsely claiming `signed-out` or `no-key`.
// - Non-admin users when Center is unconfigured see `admin-required`.
// - Chat text ("I authorized") NEVER satisfies `googleSetupDoneRefusal`.

import {
  GOOGLE_CHOICE_LABELS,
  GOOGLE_CHOICE_SERVICES,
  googleApiEnableUrl,
} from './console.js';
import {
  currentGoogleSetupStep,
  googleSetupNeedsKind,
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep,
} from './rules.js';

/** How long a bot-driven step may sit with no active turn before offering Continue. */
export const GOOGLE_SETUP_PAUSED_AFTER_MS = 30_000;

/** Allow button names individual services up to this count. */
export const GOOGLE_SETUP_ALLOW_NAMES_UP_TO = 2;

function stepFinished(run, step) {
  const status = run?.steps?.[step]?.status;
  return status === 'done' || status === 'skipped';
}

/**
 * Resolves the connected Center account matching this setup run:
 * the specifically targeted email, or the most recently connected account if unspecified.
 */
export function googleSetupAccount(run, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const wanted = typeof run?.account === 'string' ? run.account.trim().toLowerCase() : '';
  if (wanted) {
    return list.find((entry) => typeof entry?.email === 'string' && entry.email.toLowerCase() === wanted) ?? null;
  }
  if (list.length === 0) return null;
  return list.reduce((latest, entry) => {
    if (!latest) return entry;
    const latestAt = typeof latest.connectedAt === 'number' ? latest.connectedAt : 0;
    const entryAt = typeof entry.connectedAt === 'number' ? entry.connectedAt : 0;
    return entryAt > latestAt ? entry : latest;
  }, null);
}

/** Selected service groups that contain at least one service in `state`. */
function choicesInState(run, account, state) {
  const services = Array.isArray(account?.services) ? account.services : [];
  return (run.services ?? []).filter((choice) =>
    GOOGLE_CHOICE_SERVICES[choice].some((service) =>
      services.some((entry) => entry?.service === service && entry?.state === state),
    ),
  );
}

function enableUrlsForChoices(choices, account, projectId) {
  const services = Array.isArray(account?.services) ? account.services : [];
  const urls = [];
  for (const choice of choices) {
    for (const service of GOOGLE_CHOICE_SERVICES[choice]) {
      const entry = services.find((item) => item?.service === service && item?.state === 'api-disabled');
      if (!entry) continue;
      urls.push({
        service,
        url: typeof entry.enableUrl === 'string' && entry.enableUrl
          ? entry.enableUrl
          : googleApiEnableUrl(service, projectId),
      });
    }
  }
  return urls;
}

/**
 * Checks whether Center's Web OAuth client satisfies this setup run.
 * Returns a blocker object or null when Center client is ready for this project.
 */
export function googleSetupKeyBlocker(run, google) {
  if (!google || google.reachable === false) {
    return { kind: 'center-unreachable', actions: [{ id: 'check-again' }] };
  }
  if (!google.client || google.client.configured !== true) {
    if (google.isAdmin === false) {
      return {
        kind: 'admin-required',
        actions: [{ id: 'copy-for-admin' }, { id: 'check-again' }],
      };
    }
    return {
      kind: 'no-key',
      actions: [{ id: 'configure-client' }, { id: 'make-new-key' }],
    };
  }
  if (google.clientKey === 'gone') {
    return {
      kind: 'key-gone',
      actions: [{ id: 'make-new-key' }, { id: 'start-over' }],
    };
  }
  const keyProjectId = google.client.projectId;
  if (keyProjectId && run?.projectId && keyProjectId !== run.projectId) {
    return {
      kind: 'key-other-project',
      keyProjectId,
      projectId: run.projectId,
      actions: [{ id: 'configure-client' }, { id: 'make-new-key' }],
    };
  }
  return null;
}

function accountBlocker(run, google) {
  const accounts = Array.isArray(google?.accounts) ? google.accounts : [];
  const account = googleSetupAccount(run, accounts);
  if (!account) {
    // Owner signed in with a different Google account than this setup targeted.
    const other = accounts.find(
      (entry) => typeof entry?.connectedAt === 'number' && entry.connectedAt >= run.startedAt,
    );
    if (other && run.account) {
      return {
        kind: 'other-account',
        signedIn: other.email,
        wanted: run.account,
        actions: [
          { id: 'keep-account', email: other.email },
          { id: 'sign-in-again', email: run.account },
        ],
      };
    }
    return null;
  }

  if (account.status === 'reconnect') {
    return {
      kind: 'signed-out',
      email: account.email,
      actions: [{ id: 'sign-in-again', email: account.email }],
    };
  }

  const unallowed = choicesInState(run, account, 'needs-permission');
  if (unallowed.length > 0) {
    return {
      kind: 'needs-permission',
      services: unallowed,
      actions: [
        { id: 'allow', services: unallowed },
        ...(unallowed.length < (run.services ?? []).length
          ? [{ id: 'continue-without', services: unallowed }]
          : []),
      ],
    };
  }

  const recheck = { id: 'check-again' };
  const off = choicesInState(run, account, 'api-disabled');
  if (off.length > 0) {
    return {
      kind: 'api-off',
      services: off,
      enableUrls: enableUrlsForChoices(off, account, google?.client?.projectId ?? run.projectId),
      actions: [{ id: 'turn-on', services: off }, recheck],
    };
  }

  const blocked = choicesInState(run, account, 'blocked-by-admin');
  if (blocked.length > 0) {
    return {
      kind: 'admin-blocked',
      services: blocked,
      actions: [{ id: 'copy-for-admin' }, recheck],
    };
  }

  const failed = choicesInState(run, account, 'error');
  if (failed.length > 0) {
    return {
      kind: 'check-failed',
      services: failed,
      actions: [recheck],
    };
  }

  return null;
}

/**
 * Computes the active blocker for `run`, or null when the setup is progressing cleanly.
 */
export function googleSetupBlocker({
  run,
  google,
  botTurnRunning = null,
  now = Date.now(),
}) {
  if (!run) {
    if (google && google.reachable === false) {
      return { kind: 'center-unreachable', actions: [{ id: 'check-again' }] };
    }
    if (google && google.client?.configured !== true && google.isAdmin === false) {
      return {
        kind: 'admin-required',
        actions: [{ id: 'copy-for-admin' }, { id: 'check-again' }],
      };
    }
    return null;
  }

  const current = currentGoogleSetupStep(run);

  if (run.state === 'failed') {
    return {
      kind: 'stopped',
      step: current,
      ...(run.lastError ? { reason: run.lastError } : {}),
      actions: [{ id: 'continue' }, { id: 'start-over' }],
    };
  }

  if (run.state !== 'running') {
    return null;
  }

  // Non-admin cannot build a Center Web OAuth client.
  if (google && google.reachable !== false && google.client?.configured !== true && google.isAdmin === false) {
    return {
      kind: 'admin-required',
      actions: [{ id: 'copy-for-admin' }, { id: 'check-again' }],
    };
  }

  // Once client step is done or missed, verify Center Web OAuth client & account readiness.
  if (google && (stepFinished(run, 'client') || run.clientMissed)) {
    const key = googleSetupKeyBlocker(run, google);
    if (key) return key;

    const matchedAccount = googleSetupAccount(run, google.accounts);
    if (run.steps.connect?.status === 'done' || matchedAccount || (google.accounts?.length ?? 0) > 0) {
      const account = accountBlocker(run, google);
      if (account) return account;
    }
  }

  // Sensitive lock / owner-handed step.
  const handed = GOOGLE_SETUP_STEPS.find((step) => run.steps?.[step]?.status === 'needs-user');
  if (handed) {
    const note = run.steps[handed]?.note;
    if (handed === 'client') {
      return {
        kind: 'needs-user',
        step: handed,
        sensitive: true,
        ...(note ? { note } : {}),
        actions: [{ id: 'configure-client' }, { id: 'check-again' }],
      };
    }
    if (handed === 'connect') {
      return {
        kind: 'needs-user',
        step: handed,
        sensitive: true,
        ...(note ? { note } : {}),
        actions: [{ id: 'sign-in', ...(run.account ? { email: run.account } : {}) }, { id: 'check-again' }],
      };
    }
    const actions = run.browserLock?.active && run.browserLock.step === handed
      ? [{ id: 'takeover-browser', step: handed }, { id: 'done', step: handed }]
      : [{ id: 'done', step: handed }];
    return {
      kind: 'needs-user',
      step: handed,
      ...(run.browserLock?.active && run.browserLock.step === handed ? { sensitive: true } : {}),
      ...(note ? { note } : {}),
      actions,
    };
  }

  // Bot-driven step idle with no active turn for >= 30s.
  if (
    botTurnRunning === false &&
    current !== null &&
    current !== 'connect' &&
    current !== 'client' &&
    !personDoesGoogleSetupStep(run, current) &&
    !googleSetupNeedsKind(run) &&
    now - run.updatedAt >= GOOGLE_SETUP_PAUSED_AFTER_MS
  ) {
    return {
      kind: 'paused',
      step: current,
      actions: [{ id: 'continue' }, { id: 'let-me', step: current }],
    };
  }

  return null;
}

/**
 * Returns a plain-English refusal explaining why `done` cannot succeed yet,
 * or null ONLY when Center confirms client configuration, account connection,
 * and every chosen service is `ready`.
 */
export function googleSetupDoneRefusal(run, google) {
  if (!google || google.reachable === false) {
    return 'Center Google status is currently unreachable. Retry checking once Center is reachable; do not assume authorization succeeded.';
  }
  const blocker = googleSetupBlocker({
    run,
    google,
    botTurnRunning: null,
    now: run.updatedAt,
  });
  if (blocker) {
    return `${googleSetupBlockerLine(blocker)} The owner card shows: ${googleSetupActionsLine(blocker)}.`;
  }
  const key = googleSetupKeyBlocker(run, google);
  if (key) {
    return `${googleSetupBlockerLine(key)} The owner card shows: ${googleSetupActionsLine(key)}.`;
  }
  const left = currentGoogleSetupStep(run);
  if (left && left !== 'connect') {
    return `The ${left} step is not finished yet.`;
  }
  const account = googleSetupAccount(run, google.accounts);
  if (!account) {
    return 'No Google account is connected in Center for this setup yet. The owner must complete Google sign-in in their system browser.';
  }
  const accBlocker = accountBlocker(run, google);
  if (accBlocker) {
    return `${googleSetupBlockerLine(accBlocker)} The owner card shows: ${googleSetupActionsLine(accBlocker)}.`;
  }
  const chosen = run.services ?? [];
  if (chosen.length === 0) {
    return 'No Google services have been selected for this setup yet.';
  }
  // Double-check every chosen service reports explicit 'ready' in Center status.
  const serviceMap = new Map(
    (account.services ?? []).map((entry) => [entry.service, entry.state]),
  );
  const notReady = chosen.filter((choice) =>
    GOOGLE_CHOICE_SERVICES[choice].some((service) => serviceMap.get(service) !== 'ready'),
  );
  if (notReady.length > 0) {
    return `${googleSetupChoicesWords(notReady)} is not ready yet according to Center verification. Check again once permissions and APIs are confirmed.`;
  }
  return null;
}

export function googleSetupChoicesWords(choices) {
  const words = (choices ?? []).map((choice) => GOOGLE_CHOICE_LABELS[choice] ?? choice);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')}${words.length > 2 ? ',' : ''} and ${words[words.length - 1]}`;
}

export function googleSetupActionLabel(action) {
  switch (action.id) {
    case 'configure-client':
      return 'Enter Center Web OAuth credentials';
    case 'make-new-key':
      return 'Make a new Web OAuth client';
    case 'sign-in':
      return action.email ? `Sign in as ${action.email}` : 'Sign in to Google';
    case 'takeover-browser':
      return 'Take over page';
    case 'allow':
      return action.services.length <= GOOGLE_SETUP_ALLOW_NAMES_UP_TO
        ? `Allow ${googleSetupChoicesWords(action.services)}`
        : 'Sign in again';
    case 'continue-without':
      return 'Continue without them';
    case 'keep-account':
      return `Keep ${action.email}`;
    case 'sign-in-again':
      return action.email ? `Sign in as ${action.email}` : 'Sign in again';
    case 'turn-on':
      return 'Turn on APIs';
    case 'copy-for-admin':
      return 'Copy for your admin';
    case 'check-again':
      return 'Check again';
    case 'continue':
      return 'Continue';
    case 'start-over':
      return 'Start over';
    case 'let-me':
      return 'Let me do this one';
    case 'done':
      return 'Done';
    default:
      return String(action.id);
  }
}

export function googleSetupActionsLine(blocker) {
  return (blocker?.actions ?? []).map(googleSetupActionLabel).join(' · ');
}

export function googleSetupBlockerLine(blocker) {
  switch (blocker.kind) {
    case 'admin-required':
      return 'Center does not have a Google Web OAuth app configured yet. Contact your Center administrator to configure it once.';
    case 'center-unreachable':
      return 'Center is temporarily unreachable. Existing credentials were not cleared; retry checking once online.';
    case 'stopped':
      return blocker.reason ? `Setup stopped: ${blocker.reason}` : 'Setup stopped.';
    case 'paused':
      return `Setup paused at ${blocker.step}. All progress so far is saved.`;
    case 'needs-user':
      return blocker.note ?? `Owner action required on ${blocker.step}.`;
    case 'no-key':
      return 'Center still needs the Web OAuth Client ID and Client Secret saved through the private configuration control.';
    case 'key-gone':
      return 'This Web OAuth client no longer works: it was removed or invalidated in Google Cloud.';
    case 'key-other-project':
      return `Center has a Web OAuth client from project ${blocker.keyProjectId}, not ${blocker.projectId}.`;
    case 'other-account':
      return `Owner signed in as ${blocker.signedIn}; this setup was for ${blocker.wanted}.`;
    case 'signed-out':
      return `The Google sign-in for ${blocker.email} needs reconnection.`;
    case 'needs-permission':
      return `Almost there: allow ${googleSetupChoicesWords(blocker.services)} in your system browser. Tick every permission box on the consent screen.`;
    case 'api-off':
      return `${googleSetupChoicesWords(blocker.services)} API is turned off in Google Cloud.`;
    case 'admin-blocked':
      return `The organization Google administrator blocked ${googleSetupChoicesWords(blocker.services)}.`;
    case 'check-failed':
      return `Center could not verify ${googleSetupChoicesWords(blocker.services)} right now.`;
    default:
      return 'Setup requires attention.';
  }
}
