// host-core/google-setup/rules.js
// Setup state schema, mode availability matrix, owner/agent authority separation,
// and state transitions for PiBot's three-mode Google setup wizard.
//
// Portions adapted from stablyai/orca (MIT License, Copyright (c) 2026 Lovecast Inc.):
// - src/shared/google/google-setup-run.ts
// - src/main/google/google-setup-rules.ts
// - src/main/google/google-setup-runs.ts
//
// Mode availability conditions (documented and enforced at runtime):
// 1. `do-it-for-me` (自动代办):
//    - Requires an interactive, streamable Bot browser on a desktop/supported Host:
//      `browserAvailable === true && canStreamInteract === true && !isAndroidLocalHost && !isHeadless`.
//    - Bot may drive ONLY non-sensitive Cloud Console steps. Before User Data Policy
//      acceptance (`branding`) and before clicking Create on OAuth Client (`client`),
//      the browser MUST lock for human takeover/isolation. If `canIsolateSensitivePages`
//      is false, `client` creation falls back to the owner's system browser.
// 2. `guide-here` (内嵌指导):
//    - Requires the same streamable Bot browser (`browserAvailable && canStreamInteract && !isAndroidLocalHost && !isHeadless`).
//    - Owner does every click/fill; Bot may only navigate/read non-sensitive pages to
//      track progress, and is still blocked on sensitive pages (`accounts.google.com`,
//      `/auth/clients` secret dialog).
// 3. `guide-browser` (外部浏览器指导):
//    - Always available on every Host (desktop, headless server, mobile remote, Android local Host).
//    - Default recommended path on Android local Host and headless/non-streamable Hosts.
//    - Owner works in their own system browser; Bot never opens or inspects that browser.

import { randomUUID } from 'node:crypto';
import {
  GOOGLE_SERVICE_CHOICES,
  googleChoices,
  isPersonalGmailAddress,
  isValidGoogleProjectId,
} from './console.js';
import {
  assertNonEmptyString,
  assertNoSecretMaterial,
  scrubNonSensitiveText,
  setupError,
} from './errors.js';

/** The setup's steps, in canonical order. */
export const GOOGLE_SETUP_STEPS = Object.freeze([
  'account',
  'project',
  'apis',
  'branding',
  'links',
  'publish',
  'client',
  'connect',
]);

export const GOOGLE_SETUP_MODES = Object.freeze([
  'do-it-for-me',
  'guide-here',
  'guide-browser',
]);

export const GOOGLE_SETUP_RUN_MODES = Object.freeze([
  ...GOOGLE_SETUP_MODES,
  'unchosen',
]);

export const GOOGLE_SETUP_STEP_STATUSES = Object.freeze([
  'pending',
  'active',
  'needs-user',
  'done',
  'failed',
  'skipped',
]);

export const GOOGLE_SETUP_CARDS = Object.freeze([
  'path',
  'account',
  'kind',
  'services',
  'step',
]);

export const GOOGLE_SETUP_STATES = Object.freeze([
  'running',
  'done',
  'failed',
  'cancelled',
]);

export const GOOGLE_SETUP_STEPS_SET = new Set(GOOGLE_SETUP_STEPS);
export const GOOGLE_SETUP_MODES_SET = new Set(GOOGLE_SETUP_MODES);
export const GOOGLE_SETUP_RUN_MODES_SET = new Set(GOOGLE_SETUP_RUN_MODES);
export const GOOGLE_SETUP_STEP_STATUSES_SET = new Set(GOOGLE_SETUP_STEP_STATUSES);
export const GOOGLE_SETUP_CARDS_SET = new Set(GOOGLE_SETUP_CARDS);
export const GOOGLE_SETUP_STATES_SET = new Set(GOOGLE_SETUP_STATES);
export const GOOGLE_SERVICE_SET = new Set(GOOGLE_SERVICE_CHOICES);

/** Steps that are always person-owned for completion. */
export const PERSON_ONLY_COMPLETION_STEPS = new Set(['client', 'connect']);

/** Steps skipped when the owner chooses direct credential entry (already has Web OAuth creds). */
export const DIRECT_CONFIGURE_SKIPPED_STEPS = Object.freeze([
  'account',
  'project',
  'apis',
  'branding',
  'links',
  'publish',
]);

/** Steps skipped when Center already has a valid configured Web OAuth client (Journey 1A). */
export const CENTER_CONFIGURED_SKIPPED_STEPS = Object.freeze([
  'account',
  'project',
  'apis',
  'branding',
  'links',
  'publish',
  'client',
]);

const OWNER_ONLY_STEP_ANSWERS = new Set([
  'redo',
  'resume',
  'start-over',
  'take-over',
  'done',
  'continue-without',
  'keep-account',
]);

export const PERSON_FINISHES =
  'Only the owner can finish this step (Google sign-in, Web OAuth client credential entry, or a step handed to them). Wait for their action or Center verification instead of marking it done.';

export const BOT_CANNOT_TAKE_CLICKS =
  'Only the owner can grant or hand clicking control back to the bot. Ask them to choose it on the setup card.';

export const OWNER_RECOVERS =
  'Only the owner can press Make a new key, Continue, Start over, Done, or Take over from here on the setup card.';

export function isStep(value) {
  return typeof value === 'string' && GOOGLE_SETUP_STEPS_SET.has(value);
}

export function isMode(value) {
  return typeof value === 'string' && GOOGLE_SETUP_MODES_SET.has(value);
}

export function isRunMode(value) {
  return typeof value === 'string' && GOOGLE_SETUP_RUN_MODES_SET.has(value);
}

export function isCard(value) {
  return typeof value === 'string' && GOOGLE_SETUP_CARDS_SET.has(value);
}

export function isServiceChoice(value) {
  return typeof value === 'string' && GOOGLE_SERVICE_SET.has(value);
}

/**
 * Evaluates honest availability for all three setup modes given actual Host & browser
 * capabilities. Never reports `do-it-for-me` or `guide-here` as available when the
 * Host cannot provide a live interactive streamable Bot browser.
 */
export function evaluateModeAvailability(capabilities = {}) {
  const isAndroidLocalHost = capabilities.isAndroidLocalHost === true;
  const isHeadless = capabilities.isHeadless === true;
  const browserAvailable = capabilities.browserAvailable === true;
  const canStreamInteract = capabilities.canStreamInteract === true;
  const canIsolateSensitivePages = capabilities.canIsolateSensitivePages === true;
  const explicitReason =
    typeof capabilities.reason === 'string' && capabilities.reason.trim()
      ? capabilities.reason.trim()
      : undefined;

  let embeddedUnavailableReason = null;
  if (isAndroidLocalHost) {
    embeddedUnavailableReason =
      explicitReason ??
      'Android local Host does not bundle a desktop-grade automated browser; use external browser guidance instead.';
  } else if (isHeadless) {
    embeddedUnavailableReason =
      explicitReason ??
      'This Host is headless and cannot stream an interactive browser view; use external browser guidance instead.';
  } else if (!browserAvailable) {
    embeddedUnavailableReason =
      explicitReason ??
      'Bot browser is unavailable on this Host; use external browser guidance instead.';
  } else if (!canStreamInteract) {
    embeddedUnavailableReason =
      explicitReason ??
      'Live interactive browser streaming is unavailable on this Host; use external browser guidance instead.';
  }

  const embeddedAvailable = embeddedUnavailableReason === null;
  const clientStepRequiresSystemBrowser = !embeddedAvailable || !canIsolateSensitivePages;

  return {
    recommendedMode: embeddedAvailable ? 'guide-here' : 'guide-browser',
    clientStepRequiresSystemBrowser,
    modes: {
      'do-it-for-me': embeddedAvailable
        ? {
            available: true,
            canIsolateSensitivePages,
            clientStepRequiresSystemBrowser,
            ...(clientStepRequiresSystemBrowser
              ? {
                  caveat:
                    'Sensitive Web OAuth Client Secret creation cannot be isolated in-page on this Host; the client step will hand off to your system browser and private Center configuration control.',
                }
              : {}),
          }
        : {
            available: false,
            reason: embeddedUnavailableReason,
            fallbackMode: 'guide-browser',
          },
      'guide-here': embeddedAvailable
        ? {
            available: true,
            canIsolateSensitivePages,
            clientStepRequiresSystemBrowser,
          }
        : {
            available: false,
            reason: embeddedUnavailableReason,
            fallbackMode: 'guide-browser',
          },
      'guide-browser': {
        available: true,
        recommended: !embeddedAvailable,
      },
    },
  };
}

export function assertModeAvailable(mode, availability) {
  if (mode === 'unchosen' || mode === 'guide-browser') return;
  const info = availability?.modes?.[mode];
  if (info && info.available === false) {
    throw setupError(
      'SETUP_MODE_UNAVAILABLE',
      info.reason || `Setup mode "${mode}" is unavailable on this Host. Use "guide-browser" instead.`,
      { mode, fallbackMode: 'guide-browser', availability },
    );
  }
}

/** First step that is not done or skipped; null once all steps are complete. */
export function currentGoogleSetupStep(run) {
  if (!run || !run.steps) return GOOGLE_SETUP_STEPS[0];
  return (
    GOOGLE_SETUP_STEPS.find((step) => {
      const status = run.steps[step]?.status ?? 'pending';
      return status !== 'done' && status !== 'skipped';
    }) ?? null
  );
}

/** Whether the person, not the bot, does this step. */
export function personDoesGoogleSetupStep(run, step) {
  if (!run) return true;
  if (step === 'connect') return true;
  if (run.browserLock?.active && run.browserLock.step === step) return true;
  return run.mode !== 'do-it-for-me' || run.personStep === step;
}

/** Whether a step can only be finished by the owner (or Center verification). */
export function isPersonOwnedStep(run, step) {
  if (!run) return true;
  return (
    PERSON_ONLY_COMPLETION_STEPS.has(step) ||
    run.personStep === step ||
    run.steps?.[step]?.status === 'needs-user' ||
    (run.browserLock?.active === true && run.browserLock.step === step)
  );
}

/** Whether the bot is permitted to click/fill controls on this step. */
export function botClicks(run, step) {
  if (!run || run.state !== 'running') return false;
  if (step === 'connect' || step === 'client') return false;
  if (run.browserLock?.active) return false;
  return !personDoesGoogleSetupStep(run, step);
}

/** Whether the setup is still awaiting Center Web OAuth client configuration. */
export function googleSetupAwaitsClient(run) {
  const client = run?.steps?.client?.status;
  return run?.state === 'running' && client !== 'done' && client !== 'skipped';
}

/** Determines initial mode enforcing owner/bot privilege separation and availability. */
export function resolveStartMode(actor, asked, availability) {
  if (asked !== undefined && !isRunMode(asked)) {
    throw setupError('INVALID_ARGUMENT', `Invalid setup mode: ${String(asked)}`);
  }
  if (actor === 'bot') {
    if (asked === 'do-it-for-me') {
      throw setupError(
        'SETUP_FORBIDDEN',
        'Only the owner can choose "do-it-for-me" on the setup card. Start without mode or use "unchosen" / "guide-browser".',
      );
    }
    const desired = asked ?? 'unchosen';
    if (desired === 'guide-here' && availability?.modes?.['guide-here']?.available === false) {
      return 'guide-browser';
    }
    return desired;
  }
  const desired = asked ?? 'unchosen';
  assertModeAvailable(desired, availability);
  return desired;
}

/** Applies work (Workspace Internal) vs personal (External) branching to links & publish. */
export function applyKindBranching(run, kind, now) {
  run.kind = kind;
  if (kind === 'work') {
    for (const step of ['links', 'publish']) {
      const current = run.steps[step]?.status;
      if (!current || current === 'pending' || current === 'active') {
        run.steps[step] = {
          status: 'skipped',
          at: now,
          note: 'Skipped for Google Workspace Internal app.',
        };
      }
    }
  } else if (kind === 'personal') {
    for (const step of ['links', 'publish']) {
      if (run.steps[step]?.status === 'skipped') {
        delete run.steps[step];
      }
    }
  }
}

export function normalizeAccountList(accounts) {
  if (!Array.isArray(accounts)) {
    throw setupError('INVALID_ARGUMENT', 'accounts must be an array of email addresses.');
  }
  if (accounts.length > 10) {
    throw setupError('INVALID_ARGUMENT', 'accounts may list at most 10 entries.');
  }
  const seen = new Set();
  const out = [];
  for (const item of accounts) {
    const email = assertNonEmptyString(item, 'account', 320);
    assertNoSecretMaterial(email, 'accounts');
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}

export function normalizeServicesInput(values) {
  if (!Array.isArray(values)) {
    throw setupError('INVALID_ARGUMENT', 'services/choices must be an array.');
  }
  for (const value of values) {
    if (!isServiceChoice(value)) {
      throw setupError(
        'INVALID_ARGUMENT',
        `Unknown Google service choice: ${String(value)}. Expected gmail, calendar, or files.`,
      );
    }
  }
  const canonical = googleChoices(values);
  if (canonical.length === 0) {
    throw setupError(
      'INVALID_ARGUMENT',
      'Select at least one Google service group (gmail, calendar, or files).',
    );
  }
  return canonical;
}

export function answersEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Checks whether an incoming card answer is already recorded verbatim on the current run
 * (used for idempotent retries / double-clicks on setup cards).
 */
export function isDuplicateCardAnswer(run, card, values) {
  if (!run || !run.answers) return false;
  const existing = run.answers[card];
  if (!existing) return false;
  if (card === 'services') {
    const normalized = googleChoices(values);
    return answersEqual(existing.values, normalized);
  }
  return answersEqual(existing.values, values);
}

/**
 * Records a card answer on `run` (mutating the cloned run in place).
 * Enforces strict owner vs bot permissions and Host mode availability.
 */
export function recordAnswer(run, actor, card, rawValues, now, options = {}) {
  if (!isCard(card)) {
    throw setupError('INVALID_ARGUMENT', `Unknown setup card: ${String(card)}`);
  }
  if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.length > 20) {
    throw setupError('INVALID_ARGUMENT', 'Card answer values must be a non-empty array of at most 20 items.');
  }
  const values = rawValues.map((item) => {
    const text = assertNonEmptyString(item, `answers.${card}`, 320);
    assertNoSecretMaterial(text, `answers.${card}`);
    return text;
  });
  const [first, second] = values;
  const availability = options.availability;
  const centerClientConfigured = options.centerClientConfigured === true;

  switch (card) {
    case 'path': {
      if (first === 'configure-directly' || first === 'import' || first === 'not-now') {
        if (actor === 'bot') {
          throw setupError(
            'SETUP_FORBIDDEN',
            'Only the owner can choose direct Center credential configuration or cancel setup.',
          );
        }
        if (first === 'not-now') {
          run.state = 'cancelled';
          delete run.browserLock;
        } else {
          // Owner already has Web OAuth credentials and will enter them privately into Center.
          const skipList = centerClientConfigured
            ? CENTER_CONFIGURED_SKIPPED_STEPS
            : DIRECT_CONFIGURE_SKIPPED_STEPS;
          for (const step of skipList) {
            run.steps[step] = { status: 'skipped', at: now };
          }
          if (!centerClientConfigured) {
            run.steps.client = {
              status: 'needs-user',
              at: now,
              note: 'Enter your Web OAuth Client ID and Client Secret directly in the private Center configuration control.',
            };
          }
          if (run.mode === 'unchosen') {
            run.mode = 'guide-browser';
          }
          delete run.personStep;
        }
        break;
      }
      if (!isMode(first)) {
        throw setupError(
          'INVALID_ARGUMENT',
          'Choose do-it-for-me, guide-here, guide-browser, configure-directly, or not-now.',
        );
      }
      if (actor === 'bot' && first === 'do-it-for-me' && run.mode !== 'do-it-for-me') {
        throw setupError('SETUP_FORBIDDEN', BOT_CANNOT_TAKE_CLICKS);
      }
      assertModeAvailable(first, availability);
      run.mode = first;
      delete run.personStep;
      break;
    }

    case 'step': {
      if (OWNER_ONLY_STEP_ANSWERS.has(first) && actor === 'bot') {
        throw setupError('SETUP_FORBIDDEN', OWNER_RECOVERS);
      }
      if (first === 'resume' || first === 'start-over') {
        // State revival is handled by reviveRun; here resume simply records the wake answer.
      } else if (first === 'redo' && isStep(second)) {
        run.steps[second] = { status: 'active', at: now };
        if (second === 'client') {
          delete run.steps.connect;
          delete run.clientMissed;
        }
      } else if (first === 'take-over') {
        if (actor === 'bot') {
          throw setupError('SETUP_FORBIDDEN', BOT_CANNOT_TAKE_CLICKS);
        }
        if (run.browserLock?.active) {
          throw setupError(
            'SETUP_SENSITIVE_LOCKED',
            'Cannot hand clicking back to the bot while a sensitive step is locked. Complete or leave the sensitive step first.',
          );
        }
        assertModeAvailable('do-it-for-me', availability);
        run.mode = 'do-it-for-me';
        delete run.personStep;
        for (const [step, stepState] of Object.entries(run.steps)) {
          if (
            stepState?.status === 'needs-user' &&
            isStep(step) &&
            step !== 'connect' &&
            step !== 'client'
          ) {
            run.steps[step] = { status: 'active', at: now };
          }
        }
      } else if (first === 'let-me' && isStep(second)) {
        run.personStep = second;
      } else if (first === 'done' && isStep(second)) {
        if (actor === 'bot') {
          throw setupError('SETUP_FORBIDDEN', PERSON_FINISHES);
        }
        // Note: `client` and `connect` completion are verified against trusted Center
        // status by the service layer before calling recordAnswer.
        const theirs = isPersonOwnedStep(run, second) || !botClicks(run, second);
        run.steps[second] = { status: 'done', by: theirs ? 'user' : 'bot', at: now };
        if (second === 'client') {
          delete run.clientMissed;
        }
        if (run.personStep === second) {
          delete run.personStep;
        }
        if (run.browserLock?.step === second) {
          delete run.browserLock;
        }
      } else if (first === 'continue-without') {
        const drop = new Set(values.slice(1).filter(isServiceChoice));
        if (drop.size === 0) {
          throw setupError('INVALID_ARGUMENT', 'continue-without requires at least one service to drop.');
        }
        const remaining = googleChoices((run.services ?? []).filter((svc) => !drop.has(svc)));
        if (remaining.length === 0) {
          throw setupError(
            'INVALID_ARGUMENT',
            'Cannot drop all selected Google services; keep at least one service or cancel setup.',
          );
        }
        run.services = remaining;
        run.answers.services = { values: remaining, at: now };
      } else if (first === 'keep-account') {
        const kept = assertNonEmptyString(second, 'account', 320);
        assertNoSecretMaterial(kept, 'account');
        run.account = kept;
        run.answers.account = { values: [kept], at: now };
      } else {
        throw setupError(
          'INVALID_ARGUMENT',
          'A step answer must be take-over, let-me <step>, done <step>, redo <step>, continue-without <services>, keep-account <email>, resume, or start-over.',
        );
      }
      break;
    }

    case 'account': {
      if (first === 'other') {
        delete run.account;
        run.steps.account = { status: 'active', at: now };
      } else {
        run.account = first;
        // Personal Gmail addresses are always External; custom domains are never
        // assumed to have Workspace Internal permission (04 doc §2.2).
        if (!run.kind && isPersonalGmailAddress(first)) {
          applyKindBranching(run, 'personal', now);
        }
      }
      break;
    }

    case 'kind': {
      if (first !== 'work' && first !== 'personal') {
        throw setupError('INVALID_ARGUMENT', 'Choose work or personal.');
      }
      applyKindBranching(run, first, now);
      break;
    }

    case 'services': {
      const canonical = normalizeServicesInput(values);
      run.services = canonical;
      run.answers[card] = {
        values: canonical,
        at: now,
        ...(actor === 'bot' ? { typed: true } : {}),
      };
      return;
    }
  }

  run.answers[card] = {
    values,
    at: now,
    ...(actor === 'bot' ? { typed: true } : {}),
  };
}

/**
 * Owner's Start over (new run preserving non-import choices) and Resume on a failed run.
 */
export function reviveRun(current, actor, change, now) {
  if (!current || actor !== 'owner') return null;

  const isStartOver =
    change.action === 'answer' &&
    change.card === 'step' &&
    Array.isArray(change.values) &&
    change.values[0] === 'start-over';

  const isResumeAction =
    change.action === 'resume' ||
    (change.action === 'answer' &&
      change.card === 'step' &&
      Array.isArray(change.values) &&
      change.values[0] === 'resume');

  const revision = current.revision + 1;

  if (isStartOver) {
    const { path: chosen, services, account, kind } = current.answers ?? {};
    const firstPath = chosen?.values?.[0];
    const keepPath =
      firstPath && firstPath !== 'import' && firstPath !== 'configure-directly' && firstPath !== 'not-now'
        ? chosen
        : undefined;
    const answer = { values: ['start-over'], at: now };
    const nextRun = {
      id: randomUUID(),
      botId: current.botId,
      state: 'running',
      mode: keepPath && isMode(firstPath) ? firstPath : 'unchosen',
      steps: {},
      answers: {
        ...(keepPath ? { path: keepPath } : {}),
        ...(services ? { services } : {}),
        ...(account ? { account } : {}),
        ...(kind ? { kind } : {}),
        step: answer,
      },
      ...(current.account ? { account: current.account } : {}),
      ...(current.accounts ? { accounts: [...current.accounts] } : {}),
      ...(current.kind ? { kind: current.kind } : {}),
      ...(current.services ? { services: [...current.services] } : {}),
      ...(current.browserPageId ? { browserPageId: current.browserPageId } : {}),
      startedAt: now,
      updatedAt: now,
      revision,
    };
    if (nextRun.kind === 'work') {
      applyKindBranching(nextRun, 'work', now);
    }
    return nextRun;
  }

  if (isResumeAction && current.state === 'failed') {
    const next = structuredClone(current);
    delete next.lastError;
    next.state = 'running';
    next.answers = {
      ...next.answers,
      step: { values: ['resume'], at: now },
    };
    next.updatedAt = now;
    next.revision = revision;
    return next;
  }

  return null;
}

/**
 * Applies a validated state change to a cloned running setup run.
 */
export function applyRunChange(run, actor, change, now, options = {}) {
  switch (change.action) {
    case 'step': {
      if (!isStep(change.step)) {
        throw setupError('INVALID_ARGUMENT', `Unknown setup step: ${String(change.step)}`);
      }
      if (
        typeof change.status !== 'string' ||
        !GOOGLE_SETUP_STEP_STATUSES_SET.has(change.status) ||
        change.status === 'needs-user'
      ) {
        throw setupError(
          'INVALID_ARGUMENT',
          `Invalid step status: ${String(change.status)}. Use need-user for owner handoff.`,
        );
      }
      const finishes = change.status === 'done' || change.status === 'skipped';
      if (actor === 'bot') {
        if (change.step === 'connect' && finishes) {
          throw setupError('SETUP_FORBIDDEN', PERSON_FINISHES);
        }
        if (run.browserLock?.active && run.browserLock.step === change.step) {
          throw setupError(
            'SETUP_SENSITIVE_LOCKED',
            `Step "${change.step}" is locked for the owner because it involves a sensitive boundary (${run.browserLock.reason}). Wait for the owner to complete and hand back.`,
          );
        }
        if (
          run.steps[change.step]?.status === 'needs-user' ||
          (finishes && isPersonOwnedStep(run, change.step))
        ) {
          throw setupError('SETUP_FORBIDDEN', PERSON_FINISHES);
        }
      }
      const note = change.note !== undefined ? scrubNonSensitiveText(change.note, 500) : undefined;
      if (change.note !== undefined) assertNoSecretMaterial(change.note, 'note');
      const by =
        change.status === 'done'
          ? actor === 'owner'
            ? 'user'
            : botClicks(run, change.step)
              ? 'bot'
              : 'user'
          : undefined;
      run.steps[change.step] = {
        status: change.status,
        at: now,
        ...(by ? { by } : {}),
        ...(note ? { note } : {}),
      };
      if (change.step === 'client' && change.status === 'done') {
        delete run.clientMissed;
      }
      if (change.status === 'done' && run.personStep === change.step) {
        delete run.personStep;
      }
      if (change.status === 'done' && run.browserLock?.step === change.step) {
        delete run.browserLock;
      }
      return;
    }

    case 'need-user': {
      if (!isStep(change.step)) {
        throw setupError('INVALID_ARGUMENT', `Unknown setup step: ${String(change.step)}`);
      }
      const note = assertNonEmptyString(change.note, 'note', 500);
      assertNoSecretMaterial(note, 'note');
      run.steps[change.step] = { status: 'needs-user', at: now, note };
      return;
    }

    case 'set': {
      if (change.account !== undefined) {
        const account = assertNonEmptyString(change.account, 'account', 320);
        assertNoSecretMaterial(account, 'account');
        run.account = account;
        if (!run.kind && change.kind === undefined && isPersonalGmailAddress(account)) {
          applyKindBranching(run, 'personal', now);
        }
      }
      if (change.accounts !== undefined) {
        run.accounts = normalizeAccountList(change.accounts);
      }
      if (change.kind !== undefined) {
        if (change.kind !== 'work' && change.kind !== 'personal') {
          throw setupError('INVALID_ARGUMENT', 'kind must be work or personal.');
        }
        applyKindBranching(run, change.kind, now);
      }
      if (change.projectId !== undefined) {
        const projectId = assertNonEmptyString(change.projectId, 'projectId', 120);
        assertNoSecretMaterial(projectId, 'projectId');
        if (!isValidGoogleProjectId(projectId)) {
          throw setupError(
            'INVALID_ARGUMENT',
            'projectId must match Google Cloud project ID format (6-63 lowercase letters, digits, or hyphens).',
          );
        }
        run.projectId = projectId;
      }
      if (change.services !== undefined) {
        run.services = normalizeServicesInput(change.services);
      }
      if (change.browserPageId !== undefined) {
        const pageId = assertNonEmptyString(change.browserPageId, 'browserPageId', 200);
        assertNoSecretMaterial(pageId, 'browserPageId');
        run.browserPageId = pageId;
      }
      return;
    }

    case 'answer':
      recordAnswer(run, actor, change.card, change.values, now, options);
      return;

    case 'client-missed': {
      const reason =
        change.reason !== undefined ? scrubNonSensitiveText(change.reason, 500) : undefined;
      run.clientMissed = { at: now, ...(reason ? { reason } : {}) };
      return;
    }

    case 'done':
      run.state = 'done';
      delete run.personStep;
      delete run.browserLock;
      return;

    case 'fail': {
      const errorText = assertNonEmptyString(change.error, 'error', 500);
      assertNoSecretMaterial(errorText, 'error');
      run.state = 'failed';
      run.lastError = errorText;
      return;
    }

    case 'cancel':
      if (actor === 'bot') {
        throw setupError('SETUP_FORBIDDEN', 'Only the owner can cancel Google setup.');
      }
      run.state = 'cancelled';
      delete run.browserLock;
      return;

    default:
      throw setupError('INVALID_ARGUMENT', `Unknown setup change action: ${String(change.action)}`);
  }
}
