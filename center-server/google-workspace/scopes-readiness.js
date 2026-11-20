// Adapted from stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea (MIT License, Copyright (c) 2026 Lovecast Inc.)
// Preserves Orca's Google scopes, choice grouping, readiness classification, and GoogleApi contract.
//
// When `./orca-domain.js` is present (merged Center workspace), readiness probing
// and Workspace API construction delegate directly to `./orca-domain.js`
// (`loadOrca()['google-readiness']` and `createWorkspaceApi`). When running in
// isolation before integration, the MIT-adapted implementations below provide
// the exact same behavior and destination boundaries.

export const GOOGLE_SERVICES = Object.freeze([
  'gmail',
  'calendar',
  'drive',
  'docs',
  'sheets',
  'contacts',
]);

export const GOOGLE_SERVICE_CHOICES = Object.freeze(['gmail', 'calendar', 'files']);

const SCOPE = 'https://www.googleapis.com/auth/';
const PROBE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_DETAIL_CHARS = 200;
const TOOL_DOWNLOAD_MAX_BYTES = 2_900_000;
const ABSENT_ID = 'orca-readiness-check';

const ADMIN_BLOCK =
  /admin|domain policy|not enabled for (this|the) (user|domain)|mail service not enabled/i;
const CONSOLE_URL = /^https:\/\/console\.(developers|cloud)\.google\.com\//;

export const GOOGLE_SERVICE_INFO = Object.freeze({
  gmail: Object.freeze({
    label: 'Gmail',
    scopes: Object.freeze([`${SCOPE}gmail.modify`]),
    api: 'gmail.googleapis.com',
  }),
  calendar: Object.freeze({
    label: 'Calendar',
    scopes: Object.freeze([
      `${SCOPE}calendar.events`,
      `${SCOPE}calendar.calendarlist.readonly`,
      `${SCOPE}calendar.events.freebusy`,
    ]),
    api: 'calendar-json.googleapis.com',
  }),
  drive: Object.freeze({
    label: 'Drive',
    scopes: Object.freeze([`${SCOPE}drive`]),
    api: 'drive.googleapis.com',
  }),
  docs: Object.freeze({
    label: 'Docs',
    scopes: Object.freeze([`${SCOPE}documents`]),
    api: 'docs.googleapis.com',
  }),
  sheets: Object.freeze({
    label: 'Sheets',
    scopes: Object.freeze([`${SCOPE}spreadsheets`]),
    api: 'sheets.googleapis.com',
  }),
  contacts: Object.freeze({
    label: 'Contacts',
    scopes: Object.freeze([
      `${SCOPE}contacts.readonly`,
      `${SCOPE}contacts.other.readonly`,
      `${SCOPE}directory.readonly`,
    ]),
    api: 'people.googleapis.com',
  }),
});

export const GOOGLE_CHOICE_SERVICES = Object.freeze({
  gmail: Object.freeze(['gmail']),
  calendar: Object.freeze(['calendar']),
  files: Object.freeze(['drive', 'docs', 'sheets']),
});

function servicesScopes(services) {
  return services.flatMap((service) => GOOGLE_SERVICE_INFO[service].scopes);
}

export const GOOGLE_BASE_SCOPES = Object.freeze([
  'openid',
  'email',
  ...servicesScopes(['contacts']),
]);

export function googleChoices(choices) {
  const picked = new Set(choices);
  return GOOGLE_SERVICE_CHOICES.filter((choice) => picked.has(choice));
}

export function googleSignInScopes(choices) {
  return [
    ...GOOGLE_BASE_SCOPES,
    ...googleChoices(choices).flatMap((choice) => servicesScopes(GOOGLE_CHOICE_SERVICES[choice])),
  ];
}

export function grantedGoogleChoices(scopes) {
  const granted = new Set(scopes);
  return GOOGLE_SERVICE_CHOICES.filter((choice) =>
    servicesScopes(GOOGLE_CHOICE_SERVICES[choice]).every((scope) => granted.has(scope))
  );
}

export function googleChoiceServices(choices) {
  const services = new Set([
    'contacts',
    ...googleChoices(choices).flatMap((choice) => GOOGLE_CHOICE_SERVICES[choice]),
  ]);
  return GOOGLE_SERVICES.filter((service) => services.has(service));
}

export function googleApiEnableUrl(service, projectId) {
  const url = new URL(
    `https://console.cloud.google.com/apis/library/${GOOGLE_SERVICE_INFO[service].api}`
  );
  if (projectId) {
    url.searchParams.set('project', projectId);
  }
  return url.toString();
}

const PROBES = Object.freeze({
  gmail: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' },
  calendar: { url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1' },
  drive: { url: 'https://www.googleapis.com/drive/v3/about?fields=user' },
  docs: { url: `https://docs.googleapis.com/v1/documents/${ABSENT_ID}`, absentIsReady: true },
  sheets: { url: `https://sheets.googleapis.com/v4/spreadsheets/${ABSENT_ID}`, absentIsReady: true },
  contacts: {
    url: 'https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=names',
  },
});

const ALLOWED_SERVICE_DESTINATIONS = Object.freeze({
  gmail: [
    { host: 'gmail.googleapis.com', prefixes: ['/gmail/v1/', '/upload/gmail/v1/'] },
  ],
  calendar: [
    { host: 'www.googleapis.com', prefixes: ['/calendar/v3/'] },
  ],
  drive: [
    { host: 'www.googleapis.com', prefixes: ['/drive/v3/', '/upload/drive/v3/'] },
    { host: 'drive.googleapis.com', prefixes: ['/drive/v3/', '/upload/drive/v3/'] },
  ],
  docs: [
    { host: 'docs.googleapis.com', prefixes: ['/v1/documents'] },
  ],
  sheets: [
    { host: 'sheets.googleapis.com', prefixes: ['/v4/spreadsheets'] },
  ],
  contacts: [
    { host: 'people.googleapis.com', prefixes: ['/v1/'] },
  ],
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readGoogleApiError(status, body) {
  const error = isPlainObject(body) && isPlainObject(body.error) ? body.error : null;
  const details = Array.isArray(error?.details) ? error.details : [];
  const errors = Array.isArray(error?.errors) ? error.errors : [];
  const entries = [...details, ...errors].filter(isPlainObject);
  const reasons = [
    ...entries.flatMap((entry) => (typeof entry.reason === 'string' && entry.reason ? [entry.reason] : [])),
    ...(typeof error?.status === 'string' && error.status ? [error.status] : []),
  ];
  const activationUrl = entries
    .map((entry) => (isPlainObject(entry.metadata) ? entry.metadata.activationUrl : undefined))
    .find((url) => typeof url === 'string' && CONSOLE_URL.test(url));
  return {
    status,
    message: typeof error?.message === 'string' ? error.message.slice(0, MAX_DETAIL_CHARS) : `HTTP ${status}`,
    reasons,
    ...(activationUrl ? { activationUrl } : {}),
  };
}

export function classifyGoogleApiError(service, error, projectId) {
  const has = (...names) => error.reasons.some((reason) => names.includes(reason));
  const result = (state, extra = {}) => ({ service, state, ...extra });
  if (has('SERVICE_DISABLED', 'accessNotConfigured')) {
    return result('api-disabled', {
      detail: `The ${GOOGLE_SERVICE_INFO[service].label} API is turned off in your Google project.`,
      enableUrl: error.activationUrl ?? googleApiEnableUrl(service, projectId),
    });
  }
  if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions')) {
    return result('needs-permission');
  }
  if ((error.status === 403 || error.status === 400) && ADMIN_BLOCK.test(error.message)) {
    return result('blocked-by-admin', { detail: error.message });
  }
  return result('error', { detail: error.message });
}

async function probeService(http, service, accessToken, projectId) {
  const { url, absentIsReady } = PROBES[service];
  let response;
  try {
    response = await http(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { service, state: 'error', detail: "Couldn't reach Google." };
  }
  if (response.ok || (absentIsReady && (response.status === 404 || response.status === 400))) {
    return { service, state: 'ready' };
  }
  const body = await response.json().catch(() => null);
  return classifyGoogleApiError(service, readGoogleApiError(response.status, body), projectId);
}

export async function checkGoogleServicesFallback({
  http,
  accessToken,
  grantedScopes,
  choices,
  projectId,
}) {
  const granted = new Set(grantedScopes);
  return Promise.all(
    googleChoiceServices(choices).map((service) =>
      GOOGLE_SERVICE_INFO[service].scopes.every((scope) => granted.has(scope))
        ? probeService(http, service, accessToken, projectId)
        : Promise.resolve({ service, state: 'needs-permission' })
    )
  );
}

export class GoogleToolError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'GoogleToolError';
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}

function assertAllowedGoogleApiUrl(service, rawUrl) {
  const rules = ALLOWED_SERVICE_DESTINATIONS[service];
  if (!rules) {
    throw new GoogleToolError(`Unsupported Google service: ${String(service)}`, undefined, 'INVALID_ARGUMENT');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GoogleToolError('Invalid Google API URL.', undefined, 'INVALID_ARGUMENT');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port !== '' ||
    parsed.hash
  ) {
    throw new GoogleToolError('Disallowed Google API URL.', undefined, 'FORBIDDEN');
  }
  // Reject path traversal segments before matching prefix.
  const normalizedPath = parsed.pathname;
  if (normalizedPath.includes('..')) {
    throw new GoogleToolError('Disallowed Google API URL path.', undefined, 'FORBIDDEN');
  }
  const allowed = rules.some(
    (rule) =>
      parsed.hostname === rule.host &&
      rule.prefixes.some((prefix) => normalizedPath.startsWith(prefix))
  );
  if (!allowed) {
    throw new GoogleToolError(
      `Destination host/path is not allowed for Google ${service}.`,
      undefined,
      'FORBIDDEN'
    );
  }
  return parsed.href;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatMegabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
}

function failureSentence(service, status, body, projectId) {
  const readiness = classifyGoogleApiError(service, readGoogleApiError(status, body), projectId);
  switch (readiness.state) {
    case 'api-disabled':
      return `${readiness.detail ?? 'This Google API is turned off.'} Ask your owner to turn it on: ${readiness.enableUrl ?? googleApiEnableUrl(service, projectId)}`;
    case 'needs-permission':
      return 'Google access for this was not allowed. Ask your owner to reconnect it in Center and allow it.';
    case 'blocked-by-admin':
      return `Your company Google admin blocked this: ${readiness.detail ?? ''}`.trim();
    case 'ready':
    case 'error':
      return status === 401
        ? 'Google refused the sign-in. Ask your owner to reconnect it in Center.'
        : status === 429
          ? 'Google says too many requests right now. Wait a minute and try again.'
          : `Google refused: ${readiness.detail ?? `HTTP ${status}`}`;
  }
}

export function createFallbackWorkspaceApi({ email, projectId, getAccessToken, fetchImpl }) {
  const http = fetchImpl ?? ((input, init) => fetch(input, init));

  async function call(service, request, retried = false) {
    const safeUrl = assertAllowedGoogleApiUrl(service, request.url);
    const bearer = await getAccessToken(retried);
    let response;
    try {
      response = await http(safeUrl, {
        method: request.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(request.contentType ? { 'content-type': request.contentType } : {}),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleToolError("Couldn't reach Google. Try again in a moment.", undefined, 'GOOGLE_UNAVAILABLE');
    }
    return response.status === 401 && !retried ? call(service, request, true) : response;
  }

  async function failResponse(service, response) {
    const body = await response.json().catch(() => null);
    throw new GoogleToolError(
      failureSentence(service, response.status, body, projectId),
      response.status
    );
  }

  async function jsonRequest(service, request, read, absentIsNull) {
    const response = await call(service, request);
    if (absentIsNull && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return failResponse(service, response);
    }
    const value = read(parseBody(await response.text()));
    if (value === null) {
      throw new GoogleToolError('Google answered in an unexpected format.');
    }
    return value;
  }

  return {
    email,
    get: async (service, url, read) => {
      const value = await jsonRequest(service, { method: 'GET', url }, read, false);
      if (value === null) {
        throw new GoogleToolError('Google found nothing there.');
      }
      return value;
    },
    find: (service, url, read) => jsonRequest(service, { method: 'GET', url }, read, true),
    send: async (service, write, read) => {
      const body =
        write.raw?.body ?? (write.json !== undefined ? JSON.stringify(write.json) : undefined);
      const contentType =
        write.raw?.contentType ?? (write.json !== undefined ? 'application/json' : undefined);
      const value = await jsonRequest(
        service,
        {
          method: write.method,
          url: write.url,
          ...(body !== undefined ? { body } : {}),
          ...(contentType ? { contentType } : {}),
        },
        read,
        false
      );
      if (value === null) {
        throw new GoogleToolError('Google answered in an unexpected format.');
      }
      return value;
    },
    bytes: async (service, url, maxBytes = TOOL_DOWNLOAD_MAX_BYTES) => {
      const response = await call(service, { method: 'GET', url });
      if (!response.ok) {
        return failResponse(service, response);
      }
      const tooLarge = () =>
        new GoogleToolError(
          `That file is larger than ${formatMegabytes(maxBytes)}, which exceeds the download limit.`
        );
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge();
      }
      const chunks = [];
      let total = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    },
  };
}

let orcaDomainCache = null;

async function tryLoadOrcaDomain() {
  if (!orcaDomainCache) {
    orcaDomainCache = import('./orca-domain.js').catch((error) => {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
      throw error;
    });
  }
  return orcaDomainCache;
}

/**
 * Probes per-service readiness using `./orca-domain.js` (`google-readiness`) when
 * available, falling back to the built-in MIT-adapted readiness prober otherwise.
 */
export async function checkGoogleServices(args) {
  const domain = await tryLoadOrcaDomain();
  if (domain && typeof domain.loadOrca === 'function') {
    const modules = await domain.loadOrca();
    if (typeof modules?.['google-readiness']?.checkGoogleServices === 'function') {
      return modules['google-readiness'].checkGoogleServices(args);
    }
  }
  return checkGoogleServicesFallback(args);
}

/**
 * Builds a synchronous GoogleApi handle whose async methods delegate to
 * `./orca-domain.js`'s `createWorkspaceApi` when present (or the built-in
 * destination-bounded fallback when running standalone).
 */
export function buildGoogleWorkspaceApi({ email, id, projectId, getAccessToken, fetchImpl }) {
  let innerPromise = null;
  function getInner() {
    if (!innerPromise) {
      innerPromise = tryLoadOrcaDomain().then((domain) => {
        if (domain && typeof domain.createWorkspaceApi === 'function') {
          return domain.createWorkspaceApi({
            email,
            ...(projectId ? { projectId } : {}),
            getAccessToken,
            fetchImpl,
          });
        }
        return createFallbackWorkspaceApi({
          email,
          ...(projectId ? { projectId } : {}),
          getAccessToken,
          fetchImpl,
        });
      });
    }
    return innerPromise;
  }

  return {
    email,
    id,
    async get(service, url, read) {
      const safeUrl = assertAllowedGoogleApiUrl(service, url);
      return (await getInner()).get(service, safeUrl, read);
    },
    async find(service, url, read) {
      const safeUrl = assertAllowedGoogleApiUrl(service, url);
      return (await getInner()).find(service, safeUrl, read);
    },
    async send(service, write, read) {
      const safeUrl = assertAllowedGoogleApiUrl(service, write?.url);
      return (await getInner()).send(service, { ...write, url: safeUrl }, read);
    },
    async bytes(service, url, maxBytes) {
      const safeUrl = assertAllowedGoogleApiUrl(service, url);
      return (await getInner()).bytes(service, safeUrl, maxBytes);
    },
  };
}
