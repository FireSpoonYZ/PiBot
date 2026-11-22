// host-core/google-setup/console.js
// Adapts vendored Orca Google scopes, Console links, and URL-only progress to
// PiBot's inputs. Center Web OAuth owns branding and sensitive-page policy.

import { setupError } from './errors.js';
import * as orcaConsole from './vendor/orca/google-console-setup.js';
import * as orcaScopes from './vendor/orca/google-scopes.js';
import { isGoogleClientsPage } from './vendor/orca/google-setup-run.js';

export { isGoogleClientsPage };
export const GOOGLE_CONSOLE_ORIGIN = orcaConsole.GOOGLE_CONSOLE_ORIGIN;
export const GOOGLE_ACCOUNTS_HOST = 'accounts.google.com';
export const GOOGLE_MYACCOUNT_HOST = 'myaccount.google.com';
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/oauth/google/callback';

const FORBIDDEN_UPSTREAM_HOST_RE = /(?:^|\.)onorca\.dev$/i;
const PERSONAL_GMAIL_DOMAIN_RE = /@(?:gmail|googlemail)\.com$/i;

export const GOOGLE_SERVICES = Object.freeze([...orcaScopes.GOOGLE_SERVICES]);
export const GOOGLE_SERVICE_CHOICES = Object.freeze([...orcaScopes.GOOGLE_SERVICE_CHOICES]);
export const GOOGLE_BASE_SCOPES = Object.freeze([...orcaScopes.GOOGLE_BASE_SCOPES]);
export const GOOGLE_SERVICE_INFO = Object.freeze(Object.fromEntries(
  Object.entries(orcaScopes.GOOGLE_SERVICE_INFO).map(([service, info]) => [
    service,
    Object.freeze({ ...info, scopes: Object.freeze([...info.scopes]) }),
  ]),
));
export const GOOGLE_CHOICE_SERVICES = Object.freeze(Object.fromEntries(
  Object.entries(orcaScopes.GOOGLE_CHOICE_SERVICES)
    .map(([choice, services]) => [choice, Object.freeze([...services])]),
));

export const GOOGLE_CHOICE_LABELS = Object.freeze({
  gmail: 'Gmail',
  calendar: 'Calendar',
  files: 'Drive, Docs and Sheets',
});

// Persisted or untyped callers may supply a non-array for choices or scopes.
export function googleChoices(choices) {
  return orcaScopes.googleChoices(Array.isArray(choices) ? choices : []);
}

export function googleSignInScopes(choices) {
  return orcaScopes.googleSignInScopes(Array.isArray(choices) ? choices : []);
}

export function grantedGoogleChoices(scopes) {
  return orcaScopes.grantedGoogleChoices(Array.isArray(scopes) ? scopes : []);
}

export function googleChoiceServices(choices) {
  return orcaScopes.googleChoiceServices(Array.isArray(choices) ? choices : []);
}

export function googleConsoleApiIds(choices) {
  return orcaConsole.googleConsoleApiIds(Array.isArray(choices) ? choices : []);
}

export function googleApiEnableUrl(service, projectId) {
  if (typeof service !== 'string' || !Object.hasOwn(GOOGLE_SERVICE_INFO, service)) {
    throw setupError('INVALID_ARGUMENT', `Unknown Google service: ${String(service)}`);
  }
  return orcaScopes.googleApiEnableUrl(service, isValidGoogleProjectId(projectId) ? projectId : undefined);
}

export function isValidGoogleProjectId(projectId) {
  return typeof projectId === 'string' && orcaConsole.PROJECT_ID.test(projectId);
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

export function withGoogleAccount(url, account) {
  return orcaConsole.withGoogleAccount(url, typeof account === 'string' ? account.trim() : undefined);
}

export function googleEnableApisUrl(choices, target = {}) {
  return orcaConsole.googleEnableApisUrl(Array.isArray(choices) ? choices : [], {
    projectId: isValidGoogleProjectId(target.projectId) ? target.projectId : undefined,
  });
}

export function googleConsoleStepUrl(step, options = {}) {
  // Account confirmation is a separate Center wizard step.
  const base = step === 'account'
    ? `${GOOGLE_CONSOLE_ORIGIN}/`
    : orcaConsole.googleConsoleStepUrl(step, {
        choices: Array.isArray(options.choices) ? options.choices : [],
        projectId: isValidGoogleProjectId(options.projectId) ? options.projectId : undefined,
      });
  return base ? withGoogleAccount(base, options.account) : null;
}

/** Preserve PiBot's page tags for the project home and client management views. */
export function readGoogleConsoleAddress(address) {
  const result = orcaConsole.readGoogleConsoleAddress(address);
  if (result.page !== 'other') return result;
  let url;
  try {
    url = new URL(address);
  } catch {
    return result;
  }
  if (url.origin !== GOOGLE_CONSOLE_ORIGIN) return result;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/home/dashboard' || path === '/welcome') return { ...result, page: 'project-dashboard' };
  if (isGoogleClientsPage(url)) return { ...result, page: 'client-create' };
  return result;
}

export const GOOGLE_CONSOLE_START = Object.freeze({
  ...orcaConsole.GOOGLE_CONSOLE_START,
  done: [...orcaConsole.GOOGLE_CONSOLE_START.done],
  seen: [...orcaConsole.GOOGLE_CONSOLE_START.seen],
});

export function advanceGoogleConsole(progress, address) {
  const next = orcaConsole.advanceGoogleConsole(progress ?? GOOGLE_CONSOLE_START, address);
  return { ...next, done: [...next.done], seen: [...next.seen] };
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
