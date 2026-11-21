// host-core/google-setup/guidance.js
// Chat-deliverable setup cards and executable step-by-step Bot guidance for
// PiBot's three-mode Google setup wizard.
//
// Portions adapted from stablyai/orca (MIT License, Copyright (c) 2026 Lovecast Inc.):
// - src/shared/google/google-setup-card.ts
// - src/main/google/google-setup-chat-cards.ts
// - src/renderer/src/components/bots/google/setup-cards/google-setup-card-copy.ts
// - skill-guides/orca-cli/references/google-setup.md
//
// Key PiBot adaptations (per 04-frontend-interaction.md):
// - Center Web application OAuth + HTTPS callback (/api/oauth/google/callback),
//   never Desktop app JSON export or 127.0.0.1 loopback.
// - Never populates Orca domains (onorca.dev); uses administrator's own Center domain.
// - Shared Center Google connection: all current and future bots automatically share
//   the approved services once Center verifies readiness (no per-bot enable step).
// - Hard sensitive locks before User Data Policy checkbox, Client Secret dialog,
//   and system-browser OAuth consent.

import {
  googleChoices,
  googleConsoleApiIds,
  googleConsoleStepUrl,
  GOOGLE_CHOICE_LABELS,
} from './console.js';
import {
  googleSetupActionLabel,
  googleSetupActionsLine,
  googleSetupBlockerLine,
  googleSetupChoicesWords,
} from './blocker.js';
import {
  currentGoogleSetupStep,
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep,
} from './rules.js';

export const GOOGLE_SETUP_CARD_PRESENTATION = 'google-setup';

export const GOOGLE_SETUP_CARD_KINDS = Object.freeze([
  'path',
  'account',
  'services',
  'progress',
  'step',
  'connect',
  'connected',
]);

export const SHARED_CENTER_SCOPE_NOTICE =
  'Once connected, all current and future bots on this Center can use the approved Google services as this account; anyone able to assign tasks to those bots may access that data through them.';

export const GOOGLE_WEB_LOGIN_BOUNDARY_NOTICE =
  'Signing into Google inside the bot browser does not grant Google API access (Google API grant != browser web login). Complete Google API authorization in your system browser.';

export function googleSetupCardKey(ref) {
  return ref?.step ? `step:${ref.step}` : String(ref?.card ?? '');
}

export function isNewestGoogleSetupCard(run, ref) {
  if (!run || !ref || run.id !== ref.runId) return false;
  return (run.cardCopies?.[googleSetupCardKey(ref)] ?? 0) === (ref.copy ?? 0);
}

function personsTurn(run, step) {
  const status = run?.steps?.[step]?.status;
  return (
    status === 'needs-user' ||
    (status === 'active' && run !== null && personDoesGoogleSetupStep(run, step))
  );
}

function answered(run, card) {
  return run?.answers?.[card] !== undefined;
}

function clientDone(run) {
  const status = run?.steps?.client?.status;
  return status === 'done' || status === 'skipped';
}

/**
 * Computes which setup cards became due on the transition from `prev` to `next`.
 */
export function googleSetupCardsDue(prev, next) {
  if (!next) return [];
  const before = prev?.id === next.id ? prev : null;
  const ref = (card, step = undefined) => ({
    botId: next.botId,
    runId: next.id,
    card,
    ...(step ? { step } : {}),
  });

  if (!before) {
    if (next.state !== 'running') return [];
    if (clientDone(next)) {
      return [answered(next, 'services') ? ref('connect') : ref('services')];
    }
    if (!answered(next, 'path') || next.mode === 'unchosen') {
      return [ref('path')];
    }
    return [answered(next, 'services') ? ref('progress') : ref('services')];
  }

  if (next.state === 'done') {
    return before.state === 'done' ? [] : [ref('connected')];
  }
  if (next.state === 'failed') {
    return before.state === 'failed' ? [] : [ref('progress')];
  }
  if (next.state !== 'running') {
    return [];
  }

  const due = [];
  const pathChoice = next.answers?.path?.values?.[0];
  const directConfigure = pathChoice === 'configure-directly' || pathChoice === 'import';

  if (!answered(before, 'path') && answered(next, 'path')) {
    if (directConfigure) {
      if (!clientDone(next)) {
        due.push(ref('step', 'client'));
      } else {
        due.push(answered(next, 'services') ? ref('connect') : ref('services'));
      }
    } else {
      due.push(answered(next, 'services') ? ref('progress') : ref('services'));
    }
  }

  if (!answered(before, 'services') && answered(next, 'services')) {
    if (clientDone(next)) {
      due.push(ref('connect'));
    } else if (answered(next, 'path') && !directConfigure) {
      due.push(ref('progress'));
    }
  }

  if ((next.accounts?.length ?? 0) > 1 && !(before.accounts?.length > 1) && !answered(next, 'account')) {
    due.push(ref('account'));
  }

  for (const step of GOOGLE_SETUP_STEPS) {
    if (step !== 'connect' && personsTurn(next, step) && !personsTurn(before, step)) {
      // Avoid duplicate client step card when directConfigure already queued it.
      if (!due.some((item) => item.card === 'step' && item.step === step)) {
        due.push(ref('step', step));
      }
    }
  }

  if (clientDone(next) && !clientDone(before)) {
    if (!due.some((item) => item.card === 'connect')) {
      due.push(answered(next, 'services') ? ref('connect') : ref('services'));
    }
  }

  if (next.clientMissed && !before.clientMissed && !clientDone(next)) {
    due.push(ref('progress'));
  }

  return due;
}

/**
 * Returns the card currently awaiting owner input, or null when the setup is not waiting.
 */
export function googleSetupWaitingCard(run) {
  if (!run || run.state !== 'running') return null;
  const base = { botId: run.botId, runId: run.id };
  if (clientDone(run)) {
    if (!answered(run, 'services') && !(run.services?.length > 0)) {
      return { ...base, card: 'services' };
    }
    return { ...base, card: 'connect' };
  }
  if (!answered(run, 'path') || run.mode === 'unchosen') {
    return { ...base, card: 'path' };
  }
  const pathChoice = run.answers?.path?.values?.[0];
  const directConfigure = pathChoice === 'configure-directly' || pathChoice === 'import';
  if (!directConfigure && !answered(run, 'services') && !(run.services?.length > 0)) {
    return { ...base, card: 'services' };
  }
  if ((run.accounts?.length ?? 0) > 1 && !run.account && !answered(run, 'account')) {
    return { ...base, card: 'account' };
  }
  const handed = GOOGLE_SETUP_STEPS.find((step) => personsTurn(run, step) && step !== 'connect');
  if (handed) {
    return { ...base, card: 'step', step: handed };
  }
  if (run.clientMissed) {
    return { ...base, card: 'progress' };
  }
  return { ...base, card: 'progress' };
}

/**
 * Stamps monotonic copy numbers onto `refs` and updates `run.cardCopies` in place.
 */
export function stampCardRefs(run, refs) {
  if (!run || !Array.isArray(refs) || refs.length === 0) return [];
  const copies = { ...(run.cardCopies ?? {}) };
  const stamped = refs.map((ref) => {
    if (ref.runId !== run.id) return ref;
    const key = googleSetupCardKey(ref);
    const copy = key in copies ? copies[key] + 1 : 0;
    copies[key] = copy;
    return { ...ref, copy };
  });
  run.cardCopies = copies;
  return stamped;
}

export function stepTitle(step, choices = []) {
  const servicesText = googleSetupChoicesWords(choices);
  switch (step) {
    case 'account':
      return 'Choose Google account & audience';
    case 'project':
      return 'Create Google Cloud project';
    case 'apis':
      return servicesText
        ? `Enable APIs (People + ${servicesText})`
        : 'Enable Google APIs';
    case 'branding':
      return 'Configure Google Auth Platform';
    case 'links':
      return 'Add Center home & privacy links (personal app)';
    case 'publish':
      return 'Publish or confirm audience (personal app)';
    case 'client':
      return 'Create Web OAuth client & save to Center';
    case 'connect':
      return 'Sign in to Google in system browser';
    default:
      return String(step);
  }
}

export function pathModeTitle(mode) {
  switch (mode) {
    case 'do-it-for-me':
      return 'Do it for me';
    case 'guide-here':
      return 'Guide me here';
    case 'guide-browser':
      return 'Guide me in my browser';
    default:
      return 'Choose setup mode';
  }
}

/**
 * Builds a complete, non-sensitive, chat-deliverable card object for UI rendering
 * and plain-text chat fallback.
 */
export function buildSetupCard(ref, run, context = {}) {
  const {
    blocker = null,
    modeAvailability = null,
    brandingLinks = null,
    centerStatus = null,
  } = context;
  const choices = googleChoices(run.services ?? []);
  const copy = ref.copy ?? run.cardCopies?.[googleSetupCardKey(ref)] ?? 0;
  const base = {
    presentation: GOOGLE_SETUP_CARD_PRESENTATION,
    botId: run.botId,
    runId: run.id,
    revision: run.revision,
    card: ref.card,
    ...(ref.step ? { step: ref.step } : {}),
    copy,
    isNewest: isNewestGoogleSetupCard(run, { ...ref, copy }),
    state: run.state,
    mode: run.mode,
  };

  switch (ref.card) {
    case 'path': {
      const options = [
        {
          id: 'do-it-for-me',
          label: 'Do it for me',
          description:
            'The bot fills non-sensitive Google Cloud pages in the built-in browser and pauses for you at sign-in, User Data Policy, and Client Secret.',
          available: modeAvailability?.modes?.['do-it-for-me']?.available !== false,
          reason: modeAvailability?.modes?.['do-it-for-me']?.reason,
        },
        {
          id: 'guide-here',
          label: 'Guide me here',
          description:
            'The bot opens each page in the built-in browser and tracks progress while you do every click.',
          available: modeAvailability?.modes?.['guide-here']?.available !== false,
          reason: modeAvailability?.modes?.['guide-here']?.reason,
        },
        {
          id: 'guide-browser',
          label: 'Guide me in my browser',
          description:
            'You follow step-by-step links in your own system browser and press Done after each step.',
          available: true,
          recommended: modeAvailability?.recommendedMode === 'guide-browser',
        },
        {
          id: 'configure-directly',
          label: 'I already have Web OAuth credentials',
          description:
            'Skip Cloud Console creation and enter your Web OAuth Client ID and Client Secret directly into the private Center configuration control.',
          available: true,
        },
      ];
      return {
        ...base,
        title: 'Set up Google for Center',
        summary:
          'Configure one Google Web OAuth app in Center so all bots across your hosts can share approved Google connections without repeating setup per machine.',
        options,
        answered: run.answers?.path ?? null,
        fallbackText:
          'Google setup: choose how to configure the Center Google Web OAuth app (Do it for me, Guide me here, Guide me in my browser, or enter existing Web OAuth credentials).',
      };
    }

    case 'services': {
      const options = [
        {
          id: 'gmail',
          label: GOOGLE_CHOICE_LABELS.gmail,
          description: 'Search, read, draft, send, and label email',
        },
        {
          id: 'calendar',
          label: GOOGLE_CHOICE_LABELS.calendar,
          description: 'List calendars, check free/busy, and read or edit events',
        },
        {
          id: 'files',
          label: GOOGLE_CHOICE_LABELS.files,
          description: 'Read and edit Google Drive files, Docs, and Sheets',
        },
      ];
      return {
        ...base,
        title: 'Choose Google services',
        summary:
          'Select which Google service groups to enable and request. Contacts lookup (People API) is always included as base access.',
        baseIncluded: 'Account identity and Contacts lookup (People API)',
        sharedScopeNotice: SHARED_CENTER_SCOPE_NOTICE,
        options,
        selected: choices,
        answered: run.answers?.services ?? null,
        fallbackText:
          'Google setup: choose which Google services to connect (Gmail, Calendar, Drive/Docs/Sheets). Contacts (People API) is included automatically.',
      };
    }

    case 'account': {
      return {
        ...base,
        title: 'Choose Google account',
        summary: 'Multiple Google accounts are signed in. Pick which account owns this Google Cloud project and connection.',
        accounts: run.accounts ?? [],
        selected: run.account ?? null,
        allowOther: true,
        answered: run.answers?.account ?? null,
        fallbackText: `Google setup: choose which Google account to use (${(run.accounts ?? []).join(', ') || 'specify account'}).`,
      };
    }

    case 'step': {
      const step = ref.step ?? currentGoogleSetupStep(run) ?? 'account';
      const consoleUrl = googleConsoleStepUrl(step, {
        choices,
        projectId: run.projectId,
        account: run.account,
      });
      const sensitiveBoundary =
        step === 'client'
          ? {
              kind: 'oauth-client-secret',
              botLocked: true,
              requiresSystemBrowser:
                run.browserLock?.requiresSystemBrowser === true ||
                modeAvailability?.clientStepRequiresSystemBrowser === true,
              notice:
                'Bot observation and actions are locked before creating the Web OAuth Client Secret. Never paste Client Secret into chat; submit it only in the private Center configuration control.',
            }
          : step === 'branding' && (run.browserLock?.step === 'branding' || run.steps?.branding?.status === 'needs-user')
            ? {
                kind: 'policy-consent',
                botLocked: true,
                notice:
                  'Only you may accept the Google API Services: User Data Policy. Take over the page to tick the box and finish, then hand back.',
              }
            : null;
      const stepNote = run.steps?.[step]?.note;
      const summary = stepNote ?? stepOwnerSummary(step, {
        choices, brandingLinks, mode: run.mode, projectId: run.projectId,
      });
      const actions = blocker?.actions ?? (
        step === 'client'
          ? [{ id: 'configure-client' }, { id: 'check-again' }]
          : [{ id: 'done', step }]
      );
      return {
        ...base,
        step,
        title: stepTitle(step, choices),
        summary,
        consoleUrl,
        ...(step === 'apis' ? { apiIds: googleConsoleApiIds(choices) } : {}),
        ...(step === 'links' ? { brandingLinks } : {}),
        ...(step === 'client'
          ? {
              clientType: 'Web application',
              redirectUri: brandingLinks?.redirectUri ?? centerStatus?.client?.redirectUri ?? null,
            }
          : {}),
        sensitiveBoundary,
        actions: actions.map((action) => ({
          ...action,
          label: googleSetupActionLabel(action),
        })),
        fallbackText: `Google setup — ${stepTitle(step, choices)}: ${summary}`,
      };
    }

    case 'connect': {
      const actions = blocker?.actions ?? [
        { id: 'sign-in', ...(run.account ? { email: run.account } : {}) },
        { id: 'check-again' },
      ];
      return {
        ...base,
        title: 'Sign in to Google in your system browser',
        summary: blocker
          ? googleSetupBlockerLine(blocker)
          : 'Sign in through your system browser so Center can receive the HTTPS callback and verify each selected service.',
        sharedScopeNotice: SHARED_CENTER_SCOPE_NOTICE,
        webLoginBoundaryNotice: GOOGLE_WEB_LOGIN_BOUNDARY_NOTICE,
        choices,
        account: run.account ?? null,
        redirectUri: brandingLinks?.redirectUri ?? centerStatus?.client?.redirectUri ?? null,
        blocker,
        actions: actions.map((action) => ({
          ...action,
          label: googleSetupActionLabel(action),
        })),
        fallbackText: blocker
          ? `Google setup: ${googleSetupBlockerLine(blocker)} (${googleSetupActionsLine(blocker)})`
          : 'Google setup: open your system browser to sign in to Google and approve the selected services.',
      };
    }

    case 'connected': {
      const servicesLabel = googleSetupChoicesWords(choices);
      return {
        ...base,
        title: 'Google connected for Center',
        summary: servicesLabel
          ? `${run.account ?? 'Your Google account'} is connected (${servicesLabel} ready). All current and future bots on this Center can use these services.`
          : 'Google is connected and ready for all bots on this Center.',
        account: run.account ?? null,
        choices,
        fallbackText: `Google is connected${run.account ? ` (${run.account})` : ''}${servicesLabel ? ` · ${servicesLabel} ready` : ''} · available to all bots on this Center.`,
      };
    }

    case 'progress':
    default: {
      const current = currentGoogleSetupStep(run);
      const stepList = GOOGLE_SETUP_STEPS.map((step) => ({
        step,
        title: stepTitle(step, choices),
        status: run.steps?.[step]?.status ?? 'pending',
        by: run.steps?.[step]?.by,
        note: run.steps?.[step]?.note,
      }));
      return {
        ...base,
        title:
          run.state === 'failed'
            ? 'Google setup stopped'
            : `Google setup (${pathModeTitle(run.mode)})`,
        summary: blocker
          ? googleSetupBlockerLine(blocker)
          : current
            ? `Current step: ${stepTitle(current, choices)}`
            : 'All setup steps completed.',
        currentStep: current,
        steps: stepList,
        choices,
        projectId: run.projectId ?? null,
        blocker,
        actions: (blocker?.actions ?? []).map((action) => ({
          ...action,
          label: googleSetupActionLabel(action),
        })),
        fallbackText: blocker
          ? `Google setup: ${googleSetupBlockerLine(blocker)} (${googleSetupActionsLine(blocker)})`
          : `Google setup (${pathModeTitle(run.mode)}): ${current ? stepTitle(current, choices) : 'completed'}.`,
      };
    }
  }
}

function stepOwnerSummary(step, { choices, brandingLinks, mode, projectId }) {
  switch (step) {
    case 'account':
      return 'Confirm which Google account owns this Google Cloud project, and whether it uses a Google Workspace organization (Internal) or personal Gmail (External).';
    case 'project':
      if (mode !== 'guide-browser') {
        return 'Create the project in the built-in browser. PiBot reads the Project ID when the Google Cloud dashboard opens.';
      }
      return projectId
        ? 'Confirm that the Google Cloud project is ready, then continue.'
        : 'Create the Google Cloud project, then enter the Project ID from the page address (the value of project=) to continue.';
    case 'apis': {
      const ids = googleConsoleApiIds(choices).join(', ');
      return `Enable the required project APIs (${ids}). Enabling APIs turns on project capabilities only and does not authorize personal data.`;
    }
    case 'branding':
      return 'Complete Google Auth Platform setup (app name, support email, audience, contact email). Only you may tick "I agree to the Google API Services: User Data Policy" and finish.';
    case 'links':
      return brandingLinks
        ? `On Branding, enter your own Center URLs — Home page: ${brandingLinks.homePage}, Privacy policy: ${brandingLinks.privacyPolicy}, Authorized domain: ${brandingLinks.authorizedDomain} — then Save.`
        : 'On Branding, enter your self-hosted Center home page, privacy policy URL, and authorized domain (never an Orca domain), then Save.';
    case 'publish':
      return 'On Audience, choose Publish app (In production) to avoid the 7-day External Testing refresh token expiry, or keep Testing with test users if preferred.';
    case 'client': {
      const redirectText = brandingLinks?.redirectUri
        ? ` with Authorized redirect URI ${brandingLinks.redirectUri}`
        : ' with your Center HTTPS callback https://<your-center-domain>/api/oauth/google/callback';
      return `Create a "Web application" OAuth client${redirectText}${projectId ? ` in project ${projectId}` : ''}. After clicking Create, enter the Client ID and Client Secret directly in the private Center configuration control (never paste secrets in chat).`;
    }
    case 'connect':
      return 'Sign in to Google in your system browser to approve the chosen services and let Center verify readiness.';
    default:
      return 'Continue the Google setup step.';
  }
}

/**
 * Bounded, non-sensitive presentation object compatible with PiBot's tool-presentation
 * lane (kind: 'google-setup', version: 1).
 */
export function buildSetupPresentation(view) {
  if (!view || typeof view !== 'object') return null;
  const activeCard = view.card ?? null;
  return {
    kind: GOOGLE_SETUP_CARD_PRESENTATION,
    version: 1,
    botId: view.botId,
    runId: view.id ?? null,
    revision: view.revision ?? 0,
    state: view.state ?? 'idle',
    mode: view.mode ?? null,
    step: view.step ?? null,
    card: activeCard?.card ?? null,
    copy: activeCard?.copy ?? 0,
    title: activeCard?.title ?? 'Google setup',
    summary: activeCard?.summary ?? '',
    blockerKind: view.blocker?.kind ?? null,
    actions: (view.actions ?? []).slice(0, 4).map((action) => ({
      id: action.id,
      label: action.label ?? googleSetupActionLabel(action),
      ...(action.step ? { step: action.step } : {}),
    })),
  };
}

/**
 * Builds concrete, step-aware operational guidance for the Bot so it actively drives
 * non-sensitive Cloud Console steps with `bot_browser` tools in `do-it-for-me` mode,
 * reads/verifies pages in `guide-here` mode, or guides the owner in `guide-browser`
 * mode — while strictly enforcing all sensitive and Center-verification boundaries.
 */
export function buildBotGuidance(run, context = {}) {
  const {
    blocker = null,
    centerStatus = null,
    brandingLinks = null,
    modeAvailability = null,
  } = context;

  const neverRules = [
    'Never tick "I agree to the Google API Services: User Data Policy" or any other terms/consent checkbox; always lock and hand off to the owner via need_user.',
    'Never snapshot, screenshot, read, or click Create on the OAuth Client Secret dialog; lock the browser before client creation and direct the owner to the private Center configuration control.',
    'Never ask for, accept, or echo Client Secret, refresh tokens, access tokens, or OAuth callback URLs in chat.',
    'Never fill Orca domains (onorca.dev) into Branding links or authorized domains; always use the administrator’s own Center domain.',
    'Never export or instruct exporting a Center Web Client Secret file for sharing.',
    'Never trust a chat message like "I authorized" as completion; only Center status verification can complete client or connect.',
    'Google MCP is shared across all bots on this Center; never tell the owner to enable Google per bot.',
  ];

  if (!run) {
    if (centerStatus?.client?.configured === true) {
      const readyAccounts = (centerStatus.accounts ?? []).filter((acc) => acc.status === 'connected');
      if (readyAccounts.length > 0) {
        return {
          phase: 'ready',
          allowedBrowserActions: 'none',
          nextAction:
            'Center already has a configured Google Web OAuth app and connected account(s). Use the shared Google MCP tools directly; if multiple accounts exist and the user did not name one, ask which account to use for this request.',
          neverRules,
        };
      }
      return {
        phase: 'connect-only',
        allowedBrowserActions: 'none',
        nextAction:
          'Center already has a Web OAuth app configured, but no Google account is connected yet. Call google_setup(action="start") so the owner receives the service selection and system-browser Google sign-in card.',
        neverRules,
      };
    }
    if (centerStatus?.isAdmin === false) {
      return {
        phase: 'admin-required',
        allowedBrowserActions: 'none',
        nextAction:
          'Center does not have a Google Web OAuth app configured and this user is not a Center administrator. Inform them clearly to contact their Center administrator.',
        neverRules,
      };
    }
    return {
      phase: 'not-started',
      allowedBrowserActions: 'none',
      nextAction:
        'Call google_setup(action="start") and then end your turn so the owner can choose a setup mode and services on the setup cards.',
      modeAvailability,
      neverRules,
    };
  }

  if (run.state === 'done') {
    return {
      phase: 'done',
      allowedBrowserActions: 'none',
      nextAction:
        'Google setup is complete and verified by Center. All current and future bots on this Center can now use the ready Google services.',
      neverRules,
    };
  }

  if (run.state === 'cancelled') {
    return {
      phase: 'cancelled',
      allowedBrowserActions: 'none',
      nextAction: 'The owner cancelled Google setup. Do not continue unless they ask to start again.',
      neverRules,
    };
  }

  if (run.state === 'failed') {
    return {
      phase: 'failed',
      allowedBrowserActions: 'none',
      nextAction: blocker
        ? `Setup stopped (${googleSetupBlockerLine(blocker)}). Tell the owner plainly and name only their card buttons: ${googleSetupActionsLine(blocker)}.`
        : 'Setup failed. Wait for the owner to press Continue or Start over.',
      neverRules,
    };
  }

  // Waiting on initial path or services card before opening any Cloud Console page.
  const pathChoice = run.answers?.path?.values?.[0];
  const directConfigure = pathChoice === 'configure-directly' || pathChoice === 'import';
  if (!clientDone(run) && (!run.answers?.path || run.mode === 'unchosen')) {
    return {
      phase: 'awaiting-path',
      allowedBrowserActions: 'none',
      nextAction:
        'End your turn and wait for the owner to answer the setup mode card (Do it for me, Guide me here, Guide me in my browser, or existing Web OAuth credentials). Do not open Google Cloud yet.',
      modeAvailability,
      neverRules,
    };
  }

  if (!directConfigure && !run.answers?.services && !(run.services?.length > 0)) {
    return {
      phase: 'awaiting-services',
      allowedBrowserActions: 'none',
      nextAction:
        'End your turn and wait for the owner to choose services on the services card. Do not ask for services again in chat and do not open Google Cloud yet.',
      neverRules,
    };
  }

  const step = currentGoogleSetupStep(run);
  const choices = googleChoices(run.services ?? []);
  const consoleUrl = step
    ? googleConsoleStepUrl(step, { choices, projectId: run.projectId, account: run.account })
    : null;

  let allowedBrowserActions = 'none';
  if (run.browserLock?.active || step === 'client' || step === 'connect') {
    allowedBrowserActions = 'locked-sensitive';
  } else if (run.mode === 'guide-browser') {
    allowedBrowserActions = 'none';
  } else if (step && personDoesGoogleSetupStep(run, step)) {
    allowedBrowserActions = 'read-only';
  } else if (run.mode === 'do-it-for-me') {
    allowedBrowserActions = 'drive';
  }

  if (blocker) {
    return {
      phase: 'blocked',
      step,
      mode: run.mode,
      allowedBrowserActions,
      consoleUrl,
      blockerLine: googleSetupBlockerLine(blocker),
      ownerButtons: googleSetupActionsLine(blocker),
      nextAction: `Waiting on owner: ${googleSetupBlockerLine(blocker)} Tell them in one line what is true and name only these card buttons: ${googleSetupActionsLine(blocker)}.`,
      neverRules,
    };
  }

  const stepSpec = buildStepInstruction(step, {
    run,
    choices,
    consoleUrl,
    brandingLinks,
    centerStatus,
    allowedBrowserActions,
    modeAvailability,
  });

  return {
    phase: 'active-step',
    step,
    mode: run.mode,
    allowedBrowserActions,
    consoleUrl,
    ...stepSpec,
    missPolicy:
      'On a miss: (1) re-read the page before retrying because the step may already be done; (2) retry at most once; (3) after a second miss on the same step, call google_setup(action="need_user", step, note) and end your turn.',
    neverRules,
  };
}

function buildStepInstruction(step, {
  run,
  choices,
  consoleUrl,
  brandingLinks,
  centerStatus,
  allowedBrowserActions,
  modeAvailability,
}) {
  const redirectUri =
    brandingLinks?.redirectUri ??
    centerStatus?.client?.redirectUri ??
    'https://<your-center-domain>/api/oauth/google/callback';

  switch (step) {
    case 'account':
      if (run.mode === 'guide-browser') {
        return {
          nextAction:
            'Ask in one line which Google account the owner will use for Google Cloud. Record it via google_setup(action="set", account=..., kind=...) — gmail.com/googlemail.com is personal, otherwise do not assume Workspace Internal without checking — then mark account done.',
          doneSignal: 'Owner names the Google account and work/personal audience.',
        };
      }
      if (run.browserPageId) {
        return {
          browserPageId: run.browserPageId,
          nextAction:
            `Reuse the Google Cloud Console tab (pageId=${run.browserPageId}). If it has been closed, ask the owner to reopen it from the current card. If Google asks to sign in, stop and let the owner take over or switch to guide-browser. Once they return to Cloud Console, read the Account label on that tab: record one account with set(account), or use set(accounts=[...]) so the owner picks.`,
          doneSignal: 'Target Google account recorded on the setup run.',
        };
      }
      return {
        nextAction:
          'The wizard has not opened a Google Cloud tab yet. Ask the owner to open the Google sign-in page from the current card or switch to guide-browser, then end your turn.',
        doneSignal: 'Target Google account recorded on the setup run.',
      };

    case 'project':
      if (run.mode === 'guide-browser') {
        return {
          nextAction: run.projectId
            ? 'Mark project active and wait for the owner to confirm the project on the setup card. Use the recorded Project ID.'
            : 'Mark project active so the owner gets the Create project card. The card asks for the Project ID from the console address once the project is created. If the owner provides it in chat, record it with set(projectId=...). Wait for their confirmation on the card.',
          doneSignal: 'The Project ID is recorded and the owner has marked the project done.',
        };
      }
      return {
        nextAction:
          allowedBrowserActions === 'drive'
            ? `Mark project active. Check the setup tab first. If the project has not been created, open ${consoleUrl}, fill a clear project name (e.g., PiBot Center), and click Create. Once /home/dashboard?project=<id> confirms creation, record the ID with google_setup(action="set", projectId=<id>) and mark project done. Read the ID from the built-in browser.`
            : `Mark project active and check the setup tab. Open ${consoleUrl} if the owner still needs to create the project. Do not click or fill. Once the dashboard URL shows ?project=<id>, record set(projectId=<id>) and mark project done. Read the ID from the built-in browser.`,
        doneSignal: 'Google Cloud dashboard shows ?project=<id> and projectId is saved.',
      };

    case 'apis': {
      const apiIds = googleConsoleApiIds(choices);
      return {
        apiIds,
        nextAction:
          run.mode === 'guide-browser'
            ? `Mark apis active so the owner opens ${consoleUrl} in their browser and enables the listed APIs (People + ${googleSetupChoicesWords(choices)}). Wait for their Done.`
            : allowedBrowserActions === 'drive'
              ? `Mark apis active, navigate to ${consoleUrl}, click Next then Enable to turn on ${apiIds.join(', ')}, verify the page confirms APIs are enabled, then mark apis done.`
              : `Mark apis active and open ${consoleUrl} for the owner to click Next and Enable (do not click). Confirm the page shows APIs enabled, then mark apis done.`,
        doneSignal: 'Google Cloud confirms the selected APIs are enabled for this project.',
      };
    }

    case 'branding':
      return {
        nextAction:
          run.mode === 'guide-browser'
            ? `Mark branding active so the owner opens ${consoleUrl} and completes Google Auth Platform (app name, support email, Internal for Workspace or External for personal, contact email, User Data Policy checkbox, and Finish). Wait for their Done and record kind (work vs personal).`
            : allowedBrowserActions === 'drive'
              ? `Mark branding active, open ${consoleUrl}, click Get started, fill non-sensitive fields (app name, support email, Internal/External audience — confirm kind with set(kind), never assume work purely from email domain — and contact email). STOP BEFORE the "Google API Services: User Data Policy" checkbox and call google_setup(action="need_user", step="branding", note="Tick the User Data Policy checkbox under Finish and submit"). Do not click or tick any terms box.`
              : `Mark branding active and open ${consoleUrl} for the owner to complete Google Auth Platform including the User Data Policy checkbox (do not click). Call need_user if needed and wait for owner completion.`,
        doneSignal:
          'Owner ticked the User Data Policy box, finished Auth Platform setup, and overview no longer says not configured.',
      };

    case 'links': {
      if (run.kind === 'work') {
        return {
          nextAction: 'Work (Workspace Internal) apps skip Branding links. Call google_setup(action="step", step="links", status="skipped").',
          doneSignal: 'links step marked skipped.',
        };
      }
      const linksNote = brandingLinks
        ? `Home page: ${brandingLinks.homePage}, Privacy policy: ${brandingLinks.privacyPolicy}, Authorized domain: ${brandingLinks.authorizedDomain}`
        : 'the administrator’s own self-hosted Center domain (NEVER onorca.dev)';
      return {
        brandingLinks,
        nextAction:
          run.mode === 'guide-browser'
            ? `Mark links active so the owner enters ${linksNote} on ${consoleUrl} and saves. Wait for their Done.`
            : allowedBrowserActions === 'drive'
              ? `Mark links active, open ${consoleUrl}, enter ${linksNote}, click Save, verify all three fields persisted, and mark links done.`
              : `Mark links active and open ${consoleUrl} so the owner can enter ${linksNote} and Save (do not click). Verify saved and mark links done.`,
        doneSignal: 'Branding page saved with Center home page, privacy link, and authorized domain.',
      };
    }

    case 'publish':
      if (run.kind === 'work') {
        return {
          nextAction: 'Work (Workspace Internal) apps skip Publish. Call google_setup(action="step", step="publish", status="skipped").',
          doneSignal: 'publish step marked skipped.',
        };
      }
      return {
        nextAction:
          run.mode === 'guide-browser'
            ? `Mark publish active so the owner opens ${consoleUrl} and clicks Publish app -> Confirm (In production, avoiding External Testing's 7-day refresh token expiry) or confirms Testing/Personal mode. Wait for their Done.`
            : allowedBrowserActions === 'drive'
              ? `Mark publish active, open ${consoleUrl}, click Publish app and Confirm so the app enters "In production", verify the status, and mark publish done.`
              : `Mark publish active and open ${consoleUrl} so the owner can publish the app (do not click). Confirm "In production" and mark publish done.`,
        doneSignal: 'Audience page confirms the app publishing state.',
      };

    case 'client': {
      const mustUseSystemBrowser =
        run.mode === 'guide-browser' ||
        run.browserLock?.requiresSystemBrowser === true ||
        modeAvailability?.clientStepRequiresSystemBrowser === true;
      return {
        clientType: 'Web application',
        redirectUri,
        sensitiveLockRequired: true,
        requiresSystemBrowser: mustUseSystemBrowser,
        nextAction: mustUseSystemBrowser
          ? `SENSITIVE BOUNDARY: Browser observation/actions are locked for client creation. Tell the owner to open ${consoleUrl} in their own system browser, choose Application type "Web application" (NOT Desktop app), add Authorized redirect URI "${redirectUri}" (tick any AI agent box if shown), click Create, and submit the resulting Client ID and Client Secret directly into PiBot's private Center configuration control. Never ask them to paste secrets in chat or download/share a secret file.`
          : `SENSITIVE BOUNDARY: Calling step/need_user on client locks the bot browser BEFORE clicking Create so the Client Secret dialog is never observed, screenshotted, or logged. Have the owner create a "Web application" client with Authorized redirect URI "${redirectUri}" and save Client ID + Client Secret directly in the private Center configuration control. Once Center confirms client.configured=true, proceed to connect.`,
        doneSignal: 'Trusted Center status reports client.configured === true for this project.',
      };
    }

    case 'connect':
      return {
        sensitiveLockRequired: true,
        requiresSystemBrowser: true,
        nextAction:
          'Owner must sign in to Google via their system browser from the Connect card (never inside the bot browser, and never by pasting callback URLs into chat). After the owner completes sign-in, call google_setup(action="done") to verify every selected service against trusted Center status.',
        doneSignal:
          'Trusted Center status confirms a connected account and state === "ready" for every selected service.',
      };

    default:
      return {
        nextAction: 'All steps completed. Call google_setup(action="done") to finalize after Center verification.',
        doneSignal: 'Center readiness check passes for all chosen services.',
      };
  }
}
