// host-core/google-setup/console.js
// Google service choices, API IDs, Google Cloud Console URLs, URL-only progress
// tracking, and sensitive-page boundary detection for PiBot Center Web OAuth.
//
// Portions adapted from stablyai/orca (MIT License, Copyright (c) 2026 Lovecast Inc.):
// - src/shared/google/google-scopes.ts
// - src/shared/google/google-console-setup.ts
//
// Key PiBot adaptations:
// - Uses Center Web application OAuth + HTTPS callback (/api/oauth/google/callback)
//   instead of Orca Desktop app + 127.0.0.1 loopback.
// - Never populates Orca domains (onorca.dev); derives personal branding links strictly
//   from the administrator's own Center publicUrl.
// - Never provides Web client secret export/download helpers.

import { setupError } from './errors.js';

export const GOOGLE_CONSOLE_ORIGIN = 'https://console.cloud.google.com';
export const GOOGLE_ACCOUNTS_HOST = 'accounts.google.com';
export const GOOGLE_MYACCOUNT_HOST = 'myaccount.google.com';
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/oauth/google/callback';

const FORBIDDEN_UPSTREAM_HOST_RE = /(?:^|\.)onorca\.dev$/i;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const PERSONAL_GMAIL_DOMAIN_RE = /@(?:gmail|googlemail)\.com$/i;

/** Services probed by Center readiness; contacts (People API) is always requested as base. */
export const GOOGLE_SERVICES = Object.freeze([
  'gmail',
  'calendar',
  'drive',
  'docs',
  'sheets',
  'contacts',
]);

/** User-facing service groups selected in the wizard and Center OAuth flow. */
export const GOOGLE_SERVICE_CHOICES = Object.freeze(['gmail', 'calendar', 'files']);

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

export const GOOGLE_SERVICE_INFO = Object.freeze({
  gmail: Object.freeze({
    label: 'Gmail',
    scopes: Object.freeze([`${SCOPE_PREFIX}gmail.modify`]),
    api: 'gmail.googleapis.com',
  }),
  calendar: Object.freeze({
    label: 'Calendar',
    scopes: Object.freeze([
      `${SCOPE_PREFIX}calendar.events`,
      `${SCOPE_PREFIX}calendar.calendarlist.readonly`,
      `${SCOPE_PREFIX}calendar.events.freebusy`,
    ]),
    api: 'calendar-json.googleapis.com',
  }),
  drive: Object.freeze({
    label: 'Drive',
    scopes: Object.freeze([`${SCOPE_PREFIX}drive`]),
    api: 'drive.googleapis.com',
  }),
  docs: Object.freeze({
    label: 'Docs',
    scopes: Object.freeze([`${SCOPE_PREFIX}documents`]),
    api: 'docs.googleapis.com',
  }),
  sheets: Object.freeze({
    label: 'Sheets',
    scopes: Object.freeze([`${SCOPE_PREFIX}spreadsheets`]),
    api: 'sheets.googleapis.com',
  }),
  contacts: Object.freeze({
    label: 'Contacts',
    scopes: Object.freeze([
      `${SCOPE_PREFIX}contacts.readonly`,
      `${SCOPE_PREFIX}contacts.other.readonly`,
      `${SCOPE_PREFIX}directory.readonly`,
    ]),
    api: 'people.googleapis.com',
  }),
});

export const GOOGLE_CHOICE_SERVICES = Object.freeze({
  gmail: Object.freeze(['gmail']),
  calendar: Object.freeze(['calendar']),
  files: Object.freeze(['drive', 'docs', 'sheets']),
});

export const GOOGLE_CHOICE_LABELS = Object.freeze({
  gmail: 'Gmail',
  calendar: 'Calendar',
  files: 'Drive, Docs and Sheets',
});

function servicesScopes(services) {
  return services.flatMap((service) => GOOGLE_SERVICE_INFO[service].scopes);
}

/** Always requested with every sign-in: account identity + People API name lookup. */
export const GOOGLE_BASE_SCOPES = Object.freeze([
  'openid',
  'email',
  ...servicesScopes(['contacts']),
]);

/** Canonical deduplicated service choice ordering. */
export function googleChoices(choices) {
  const picked = new Set(Array.isArray(choices) ? choices : []);
  return GOOGLE_SERVICE_CHOICES.filter((choice) => picked.has(choice));
}

/** Minimal OAuth scopes for the selected service groups plus People base scopes. */
export function googleSignInScopes(choices) {
  return [
    ...GOOGLE_BASE_SCOPES,
    ...googleChoices(choices).flatMap((choice) => servicesScopes(GOOGLE_CHOICE_SERVICES[choice])),
  ];
}

/** Service groups fully covered by a granted scope list. */
export function grantedGoogleChoices(scopes) {
  const granted = new Set(Array.isArray(scopes) ? scopes : []);
  return GOOGLE_SERVICE_CHOICES.filter((choice) =>
    servicesScopes(GOOGLE_CHOICE_SERVICES[choice]).every((scope) => granted.has(scope)),
  );
}

/** Readiness-checked services for these choices; contacts (People API) is always included. */
export function googleChoiceServices(choices) {
  const services = new Set([
    'contacts',
    ...googleChoices(choices).flatMap((choice) => GOOGLE_CHOICE_SERVICES[choice]),
  ]);
  return GOOGLE_SERVICES.filter((service) => services.has(service));
}

/** Cloud Console API IDs to enable for these choices; People API always comes first. */
export function googleConsoleApiIds(choices) {
  return [
    GOOGLE_SERVICE_INFO.contacts.api,
    ...googleChoices(choices).flatMap((choice) =>
      GOOGLE_CHOICE_SERVICES[choice].map((service) => GOOGLE_SERVICE_INFO[service].api),
    ),
  ];
}

export function googleApiEnableUrl(service, projectId) {
  const info = GOOGLE_SERVICE_INFO[service];
  if (!info) {
    throw setupError('INVALID_ARGUMENT', `Unknown Google service: ${String(service)}`);
  }
  const url = new URL(`https://console.cloud.google.com/apis/library/${info.api}`);
  if (projectId && isValidGoogleProjectId(projectId)) {
    url.searchParams.set('project', projectId);
  }
  return url.toString();
}

export function isValidGoogleProjectId(projectId) {
  return typeof projectId === 'string' && PROJECT_ID_RE.test(projectId);
}

export function isPersonalGmailAddress(email) {
  return typeof email === 'string' && PERSONAL_GMAIL_DOMAIN_RE.test(email.trim());
}

/**
 * Derives self-hosted Center redirect URI and personal-app Branding links strictly
 * from the administrator's Center public URL. Rejects any Orca domain (onorca.dev).
 * Returns null if no valid HTTPS Center URL is available yet.
 */
export function deriveCenterBrandingLinks(centerPublicUrl) {
  if (typeof centerPublicUrl !== 'string' || centerPublicUrl.trim().length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(centerPublicUrl.trim());
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || FORBIDDEN_UPSTREAM_HOST_RE.test(hostname)) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  const origin = parsed.origin;
  const isHttps = parsed.protocol === 'https:';
  return Object.freeze({
    origin,
    isHttps,
    homePage: origin,
    privacyPolicy: `${origin}/privacy`,
    authorizedDomain: hostname,
    redirectUri: `${origin}${GOOGLE_OAUTH_CALLBACK_PATH}`,
  });
}

function consoleUrl(path, params) {
  const url = new URL(path, GOOGLE_CONSOLE_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function withGoogleAccount(url, account) {
  if (!account || typeof account !== 'string' || !account.trim()) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('authuser', account.trim());
  return parsed.toString();
}

export function googleEnableApisUrl(choices, target = {}) {
  return consoleUrl('/apis/enableflow', {
    apiid: googleConsoleApiIds(choices).join(','),
    project: target.projectId && isValidGoogleProjectId(target.projectId) ? target.projectId : undefined,
  });
}

export function googleConsoleStepUrl(step, options = {}) {
  const projectId =
    options.projectId && isValidGoogleProjectId(options.projectId) ? options.projectId : undefined;
  const choices = googleChoices(options.choices ?? []);
  const params = { project: projectId };
  let base;
  switch (step) {
    case 'account':
      base = consoleUrl('/', {});
      break;
    case 'project':
      base = consoleUrl('/projectcreate', {});
      break;
    case 'apis':
      base = googleEnableApisUrl(choices, { projectId });
      break;
    case 'branding':
      base = consoleUrl('/auth/overview', params);
      break;
    case 'links':
      base = consoleUrl('/auth/branding', params);
      break;
    case 'publish':
      base = consoleUrl('/auth/audience', params);
      break;
    case 'client':
      base = consoleUrl('/auth/clients/create', params);
      break;
    default:
      return null;
  }
  return withGoogleAccount(base, options.account);
}

/**
 * URL-only inspection of a Google Cloud Console address. Never reads page body.
 */
export function readGoogleConsoleAddress(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return { projectId: null, page: 'other' };
  }
  const project = url.searchParams.get('project');
  const projectId = project && PROJECT_ID_RE.test(project) ? project : null;
  if (url.hostname === GOOGLE_ACCOUNTS_HOST) {
    const refused =
      url.pathname.includes('/signin/rejected') || url.search.includes('disallowed_useragent');
    return { projectId: null, page: refused ? 'sign-in-refused' : 'other' };
  }
  if (url.origin !== GOOGLE_CONSOLE_ORIGIN) {
    return { projectId: null, page: 'other' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  let page = 'other';
  if (path === '/projectcreate') page = 'project-create';
  else if (path === '/apis/enableflow') page = 'enable-flow';
  else if (path.startsWith('/apis/')) page = 'apis';
  else if (path.startsWith('/auth/overview/create') || path.startsWith('/auth/branding')) {
    page = 'branding-wizard';
  } else if (path === '/auth/overview') page = 'branding-overview';
  else if (path === '/auth/audience') page = 'audience';
  else if (path === '/auth/clients/create' || path.startsWith('/auth/clients')) {
    page = 'client-create';
  }
  return { projectId, page };
}

export const GOOGLE_CONSOLE_START = Object.freeze({ done: [], projectId: null, seen: [] });

function tick(done, step) {
  return done.includes(step) ? [...done] : [...done, step];
}

/**
 * Folds a visited Google Cloud URL into URL-only progress.
 * Never ticks `client` or `connect` from a URL; those require trusted Center confirmation.
 */
export function advanceGoogleConsole(progress, address) {
  const current = progress ?? GOOGLE_CONSOLE_START;
  const { page, projectId } = readGoogleConsoleAddress(address);
  const seen = current.seen.includes(page) ? [...current.seen] : [...current.seen, page];
  let done = [...current.done];
  if (projectId && page !== 'project-create' && seen.includes('project-create')) {
    done = tick(done, 'project');
  }
  if (page === 'apis' && seen.includes('enable-flow')) {
    done = tick(done, 'apis');
  }
  if (page === 'branding-overview' && seen.includes('branding-wizard')) {
    done = tick(done, 'branding');
  }
  return { done, projectId: projectId ?? current.projectId, seen };
}

export function isGoogleClientsPage(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === GOOGLE_CONSOLE_ORIGIN &&
      parsed.pathname.startsWith('/auth/clients')
    );
  } catch {
    return false;
  }
}

/**
 * Classifies whether a browser URL crosses a sensitive Google setup boundary.
 * When `sensitive` is true, agent observation (snapshot/screenshot/OCR/DOM) and
 * agent actions MUST be blocked before the page or dialog can reveal secrets or
 * perform authentication/consent.
 */
export function classifyGoogleSetupPageSensitivity(url) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return {
      sensitive: false,
      blockAgentObservation: false,
      blockAgentActions: false,
    };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      sensitive: false,
      blockAgentObservation: false,
      blockAgentActions: false,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === GOOGLE_ACCOUNTS_HOST || host.endsWith(`.${GOOGLE_ACCOUNTS_HOST}`)) {
    return {
      sensitive: true,
      reason: 'google-auth',
      blockAgentObservation: true,
      blockAgentActions: true,
      handoffToSystemBrowser: true,
      note: 'Google sign-in, MFA, and OAuth consent must be performed by the owner directly and never observed or clicked by the bot. Google API OAuth must run in the system browser.',
    };
  }
  if (host === GOOGLE_MYACCOUNT_HOST || host.endsWith(`.${GOOGLE_MYACCOUNT_HOST}`)) {
    return {
      sensitive: true,
      reason: 'google-account-security',
      blockAgentObservation: true,
      blockAgentActions: true,
      handoffToSystemBrowser: true,
      note: 'Google Account security and third-party connection pages are owner-only.',
    };
  }
  if (isGoogleClientsPage(url)) {
    return {
      sensitive: true,
      reason: 'oauth-client-secret',
      blockAgentObservation: true,
      blockAgentActions: true,
      handoffToSystemBrowser: false,
      note: 'Creating or viewing a Web OAuth client reveals the Client Secret. Bot observation and actions are locked before clicking Create; submit credentials only through the private Center configuration control.',
    };
  }
  return {
    sensitive: false,
    blockAgentObservation: false,
    blockAgentActions: false,
  };
}
