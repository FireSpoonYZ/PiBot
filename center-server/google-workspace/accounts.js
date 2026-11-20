// Adapted from stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea (MIT License, Copyright (c) 2026 Lovecast Inc.)
// Center-side shared Google Web OAuth client & multi-account encrypted grant manager.
//
// Security & architectural invariants:
// - Single Web application OAuth client + shared multi-account pool in Center (no per-Bot toggles).
// - All client secrets and OAuth tokens are stored exclusively under `center-internal-*`
//   credential IDs in Center's encrypted SQLite store (AES-256-GCM + AAD in /data),
//   blocked from generic /api/credentials/:id, device snapshots, and Host turn bundles
//   by `assertPublicCredentialId`.
// - Redirect URI is derived strictly from Center's fixed HTTPS `publicUrl`.
// - All token exchange, refresh, revoke, and API requests go strictly to hardcoded Google
//   endpoints; auth_uri / token_uri in uploaded JSON files are ignored.
// - OAuth sign-in flows are bound to the initiating `ownerKey`, use 5-minute TTL + PKCE S256
//   + single-use `state`, and strictly validate OIDC ID token `iss`, `aud`/`azp`, `exp`,
//   `iat`/`nbf`, `sub`, and verified `email`.
// - Multiple accounts require an explicit `account` selector on `api(account?)`; never guesses.

import { randomUUID } from 'node:crypto';
import {
  parseGoogleClientConfigureInput,
  resolveGoogleRedirectUri,
} from './client-config.js';
import {
  GOOGLE_REFRESH_AHEAD_MS,
  GOOGLE_SIGN_IN_TTL_MS,
  GoogleTokenError,
  buildGoogleAuthorizeUrl,
  checkGoogleClientKey,
  createPkceSecrets,
  exchangeGoogleCode,
  parseGoogleTokenEndpointIdToken,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from './token-client.js';
import {
  GOOGLE_SERVICE_CHOICES,
  buildGoogleWorkspaceApi,
  checkGoogleServices,
  googleChoiceServices,
  googleChoices,
  googleSignInScopes,
  grantedGoogleChoices,
} from './scopes-readiness.js';

export const GOOGLE_CLIENT_CREDENTIAL_ID = 'center-internal-google-workspace-client';
export const GOOGLE_ACCOUNTS_CREDENTIAL_ID = 'center-internal-google-workspace-accounts';

const MAX_PENDING_FLOWS = 32;
const MAX_PENDING_PER_OWNER = 8;
const MAX_STORED_FLOWS = 128;
const SETTLED_FLOW_RETENTION_MS = 10 * 60 * 1000;
const CAS_MAX_RETRIES = 4;
const EMAIL_HINT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GOOGLE_CALLBACK_REFUSALS = Object.freeze({
  access_denied: 'Google sign-in was cancelled, or access was not allowed.',
  admin_policy_enforced: "Your organization's Google admin blocked this app. Ask them to allow it.",
  org_internal:
    'This Google OAuth app is limited to its own organization. Sign in with an account from that organization.',
});

function fail(code, message, extra) {
  const err = Object.assign(new Error(message), { code });
  if (extra && typeof extra === 'object') {
    Object.assign(err, extra);
  }
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertStore(store) {
  if (
    !store ||
    typeof store.getCredential !== 'function' ||
    typeof store.putCredential !== 'function' ||
    typeof store.resolveCredential !== 'function' ||
    typeof store.deleteCredential !== 'function'
  ) {
    throw fail('INVALID_ARGUMENT', 'A valid Center credential store is required.');
  }
}

function assertOwnerKey(ownerKey) {
  if (typeof ownerKey !== 'string' || ownerKey.trim().length === 0 || ownerKey.length > 256) {
    throw fail('FORBIDDEN', 'Authenticated owner context is required.');
  }
  return ownerKey.trim();
}

function assertBoundedString(value, name, maxLen = 320) {
  if (typeof value !== 'string') {
    throw fail('INVALID_ARGUMENT', `${name} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) {
    throw fail('INVALID_ARGUMENT', `${name} must be 1-${maxLen} characters.`);
  }
  return trimmed;
}

function assertAllowedKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw fail('INVALID_ARGUMENT', `Unexpected field "${key}" in ${label}.`);
    }
  }
}

function normalizeCallbackParams(input) {
  if (input instanceof URL) {
    return normalizeCallbackParams(input.searchParams);
  }
  if (input instanceof URLSearchParams) {
    const seen = new Set();
    for (const key of input.keys()) {
      if (seen.has(key)) {
        throw fail('INVALID_ARGUMENT', `Duplicate OAuth callback parameter: ${key}`);
      }
      seen.add(key);
    }
    return input;
  }
  if (typeof input === 'string') {
    return normalizeCallbackParams(new URLSearchParams(input));
  }
  if (isPlainObject(input)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (Array.isArray(value)) {
        throw fail('INVALID_ARGUMENT', `Duplicate OAuth callback parameter: ${key}`);
      }
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        throw fail('INVALID_ARGUMENT', `Invalid OAuth callback parameter: ${key}`);
      }
      params.set(key, value);
    }
    return params;
  }
  throw fail('INVALID_ARGUMENT', 'Invalid OAuth callback parameters.');
}

function sanitizeServiceView(entry) {
  return {
    service: entry.service,
    state: entry.state,
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...(entry.enableUrl ? { enableUrl: entry.enableUrl } : {}),
  };
}

function accountView(record) {
  return {
    id: record.id,
    email: record.email,
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    choices: [...(record.choices ?? [])],
    services: Array.isArray(record.services) ? record.services.map(sanitizeServiceView) : [],
    ...(record.checkedAt !== undefined ? { checkedAt: record.checkedAt } : {}),
    connectedAt: record.connectedAt,
  };
}

function formatExchangeError(error) {
  if (error instanceof GoogleTokenError) {
    if (error.oauthError === 'invalid_client' || error.oauthError === 'unauthorized_client') {
      return 'Google rejected the configured Web OAuth client credentials. Check the client ID and secret in Center.';
    }
    if (error.oauthError === 'redirect_uri_mismatch') {
      return 'Google rejected the callback URL. Verify the Authorized redirect URI in Google Cloud Console matches Center.';
    }
    if (error.oauthError === 'invalid_grant') {
      return 'Google authorization code expired or was already used. Start sign-in again.';
    }
    return `Google sign-in failed (${error.oauthError}).`;
  }
  return "Couldn't complete Google sign-in. Check Center connectivity to Google and try again.";
}

function uniqueNonEmptyStrings(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function clientFingerprint(client) {
  return `${client.clientId}:${client.savedAt}`;
}

export function openGoogleAccounts({ store, publicUrl, fetchImpl, now = Date.now }) {
  assertStore(store);
  const redirectUri = resolveGoogleRedirectUri(publicUrl);
  const http = fetchImpl ?? ((input, init) => fetch(input, init));
  if (typeof http !== 'function') {
    throw fail('INVALID_ARGUMENT', 'fetchImpl must be a function.');
  }
  if (typeof now !== 'function') {
    throw fail('INVALID_ARGUMENT', 'now must be a function.');
  }

  const serviceAbort = new AbortController();
  const flowsById = new Map();
  const statesByValue = new Map();
  const refreshInFlight = new Map();
  let clientKeyCache = null;
  let closed = false;

  function assertOpen() {
    if (closed) {
      throw fail('INVALID_STATE', 'Google accounts service is closed.');
    }
  }

  function readInternalRecord(credentialId) {
    const meta = store.getCredential(credentialId);
    if (!meta || !meta.configured) {
      return { revision: meta?.revision ?? null, data: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(store.resolveCredential(credentialId));
    } catch {
      throw fail('INTERNAL_ERROR', 'Stored Google workspace state is unreadable.');
    }
    if (!isPlainObject(parsed)) {
      throw fail('INTERNAL_ERROR', 'Stored Google workspace state is corrupted.');
    }
    return { revision: meta.revision, data: parsed };
  }

  function mutateInternalRecord(credentialId, updater) {
    for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt += 1) {
      const { revision, data } = readInternalRecord(credentialId);
      const next = updater(data);
      if (next === undefined) {
        return data;
      }
      try {
        store.putCredential(credentialId, {
          expectedRevision: revision,
          value: JSON.stringify(next),
        });
        return next;
      } catch (err) {
        if (err?.code === 'REVISION_CONFLICT' && attempt < CAS_MAX_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw fail('REVISION_CONFLICT', 'Concurrent update to Google workspace state.');
  }

  function readClientConfig() {
    const { data } = readInternalRecord(GOOGLE_CLIENT_CREDENTIAL_ID);
    if (!data || typeof data.clientId !== 'string' || typeof data.clientSecret !== 'string') {
      return null;
    }
    return data;
  }

  function readAccountsMap() {
    const { data } = readInternalRecord(GOOGLE_ACCOUNTS_CREDENTIAL_ID);
    if (!data || !isPlainObject(data.accounts)) {
      return {};
    }
    return data.accounts;
  }

  function listAccountRecords() {
    return Object.values(readAccountsMap())
      .filter((entry) => isPlainObject(entry) && typeof entry.id === 'string' && typeof entry.email === 'string')
      .sort((a, b) => a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
  }

  function findAccountRecord(accountsMap, identifier) {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    if (Object.hasOwn(accountsMap, trimmed)) {
      return accountsMap[trimmed];
    }
    const lower = trimmed.toLowerCase();
    for (const record of Object.values(accountsMap)) {
      if (isPlainObject(record) && record.email === lower) {
        return record;
      }
    }
    return null;
  }

  function clientView(client) {
    if (!client) {
      return {
        configured: false,
        redirectUri,
      };
    }
    const keyState =
      clientKeyCache && clientKeyCache.fingerprint === clientFingerprint(client)
        ? clientKeyCache.state
        : undefined;
    return {
      configured: true,
      clientId: client.clientId,
      ...(client.projectId ? { projectId: client.projectId } : {}),
      redirectUri,
      ...(client.savedAt !== undefined ? { savedAt: client.savedAt } : {}),
      ...(keyState ? { clientKey: keyState } : {}),
    };
  }

  function status() {
    const client = readClientConfig();
    const accounts = listAccountRecords().map(accountView);
    return {
      client: clientView(client),
      accounts,
    };
  }

  function pruneFlows(currentNow = now()) {
    for (const flow of flowsById.values()) {
      if (flow.phase === 'pending' && !flow.consuming && currentNow >= flow.expiresAt) {
        statesByValue.delete(flow.state);
        flow.phase = 'failed';
        flow.error = 'Google sign-in expired. Start again.';
        flow.settledAt = currentNow;
      }
    }
    for (const [id, flow] of flowsById.entries()) {
      if (
        flow.phase !== 'pending' &&
        flow.settledAt !== null &&
        currentNow - flow.settledAt >= SETTLED_FLOW_RETENTION_MS
      ) {
        flowsById.delete(id);
      }
    }
    if (flowsById.size > MAX_STORED_FLOWS) {
      for (const [id, flow] of flowsById.entries()) {
        if (flow.phase !== 'pending') {
          flowsById.delete(id);
          if (flowsById.size <= MAX_STORED_FLOWS) break;
        }
      }
    }
  }

  function flowView(flow) {
    return {
      flowId: flow.flowId,
      phase: flow.phase,
      ...(flow.error ? { error: flow.error } : {}),
      ...(flow.account ? { account: flow.account } : {}),
    };
  }

  function getOwnedFlow(flowId, ownerKey) {
    const id = assertBoundedString(flowId, 'flowId', 128);
    pruneFlows();
    const flow = flowsById.get(id);
    if (!flow || flow.ownerKey !== ownerKey) {
      throw fail('NOT_FOUND', 'Google OAuth flow not found.');
    }
    return flow;
  }

  function configure(input) {
    const parsed = parseGoogleClientConfigureInput(input, redirectUri);
    const saved = {
      version: 1,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      savedAt: now(),
    };
    mutateInternalRecord(GOOGLE_CLIENT_CREDENTIAL_ID, () => saved);
    clientKeyCache = null;
    return status();
  }

  function authorize(input, ownerKey) {
    const body = input === undefined || input === null ? {} : input;
    if (!isPlainObject(body)) {
      throw fail('INVALID_ARGUMENT', 'Expected an authorization request object.');
    }
    assertAllowedKeys(body, new Set(['choices', 'account']), 'authorize');

    const client = readClientConfig();
    if (!client) {
      throw fail('INVALID_STATE', 'Configure a Google Web OAuth client in Center first.');
    }

    const currentNow = now();
    pruneFlows(currentNow);

    let totalPending = 0;
    let ownerPending = 0;
    for (const existingFlow of flowsById.values()) {
      if (existingFlow.phase === 'pending') {
        totalPending += 1;
        if (existingFlow.ownerKey === ownerKey) ownerPending += 1;
      }
    }
    if (totalPending >= MAX_PENDING_FLOWS || ownerPending >= MAX_PENDING_PER_OWNER) {
      throw fail('REQUEST_CONFLICT', 'Too many pending Google sign-in flows. Finish or cancel one first.');
    }

    const accountsMap = readAccountsMap();
    let existingAccount = null;
    let loginHint;
    if (body.account !== undefined && body.account !== null && body.account !== '') {
      const accountRef = assertBoundedString(body.account, 'account', 320);
      existingAccount = findAccountRecord(accountsMap, accountRef);
      if (existingAccount) {
        loginHint = existingAccount.email;
      } else if (EMAIL_HINT_PATTERN.test(accountRef)) {
        loginHint = accountRef.toLowerCase();
      } else {
        throw fail('NOT_FOUND', 'Google account not found.');
      }
    }

    const existingChoices = Array.isArray(existingAccount?.choices)
      ? existingAccount.choices
      : existingAccount
        ? grantedGoogleChoices(existingAccount.grantedScopes ?? [])
        : [];

    let requestedChoices;
    if (body.choices !== undefined) {
      if (!Array.isArray(body.choices) || body.choices.length === 0) {
        throw fail('INVALID_ARGUMENT', 'choices must be a non-empty array of Google service groups.');
      }
      for (const item of body.choices) {
        if (typeof item !== 'string' || !GOOGLE_SERVICE_CHOICES.includes(item)) {
          throw fail('INVALID_ARGUMENT', `Invalid Google service choice: ${String(item)}`);
        }
      }
      requestedChoices = body.choices;
    } else {
      requestedChoices = existingChoices.length > 0 ? existingChoices : GOOGLE_SERVICE_CHOICES;
    }

    const choices = googleChoices([...requestedChoices, ...existingChoices]);
    const scopes = googleSignInScopes(choices);
    const { state, codeVerifier, codeChallenge } = createPkceSecrets();
    const flowId = randomUUID();
    const expiresAt = currentNow + GOOGLE_SIGN_IN_TTL_MS;

    const authorizationUrl = buildGoogleAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge,
      loginHint,
    });

    const flow = {
      flowId,
      ownerKey,
      state,
      codeVerifier,
      choices,
      client: {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        ...(client.projectId ? { projectId: client.projectId } : {}),
      },
      createdAt: currentNow,
      expiresAt,
      phase: 'pending',
      consuming: false,
      cancelled: false,
      error: null,
      account: null,
      settledAt: null,
      abortController: new AbortController(),
    };

    flowsById.set(flowId, flow);
    statesByValue.set(state, flow);

    return {
      flowId,
      authorizationUrl,
      expiresAt,
    };
  }

  function inspectFlow(input, ownerKey) {
    if (!isPlainObject(input)) {
      throw fail('INVALID_ARGUMENT', 'Expected a flow lookup object.');
    }
    assertAllowedKeys(input, new Set(['flowId']), 'flow');
    const flow = getOwnedFlow(input.flowId, ownerKey);
    return flowView(flow);
  }

  function cancelFlow(input, ownerKey) {
    if (!isPlainObject(input)) {
      throw fail('INVALID_ARGUMENT', 'Expected a cancel request object.');
    }
    assertAllowedKeys(input, new Set(['flowId']), 'cancel');
    const flow = getOwnedFlow(input.flowId, ownerKey);
    if (flow.phase === 'pending') {
      statesByValue.delete(flow.state);
      flow.cancelled = true;
      flow.phase = 'cancelled';
      flow.settledAt = now();
      flow.abortController.abort();
    }
    return flowView(flow);
  }

  async function callback(searchParams) {
    const params = normalizeCallbackParams(searchParams);
    const state = params.get('state');
    if (!state) {
      throw fail('INVALID_ARGUMENT', 'Missing OAuth state.');
    }

    const flow = statesByValue.get(state);
    if (!flow) {
      throw fail('INVALID_ARGUMENT', 'Invalid, expired, or already used OAuth state.');
    }
    // Single-use consumption synchronously before any await.
    statesByValue.delete(state);

    if (closed) {
      throw fail('INVALID_STATE', 'Google accounts service is closed.');
    }
    if (flow.cancelled || flow.phase !== 'pending') {
      throw fail('INVALID_STATE', 'Google OAuth flow is no longer active.');
    }
    const receivedAt = now();
    if (receivedAt >= flow.expiresAt) {
      flow.phase = 'failed';
      flow.error = 'Google sign-in expired. Start again.';
      flow.settledAt = receivedAt;
      throw fail('INVALID_STATE', flow.error);
    }

    flow.consuming = true;
    try {
      const oauthError = params.get('error');
      if (oauthError) {
        const message =
          GOOGLE_CALLBACK_REFUSALS[oauthError] ??
          `Google refused the sign-in (${oauthError.slice(0, 64)}).`;
        flow.phase = 'failed';
        flow.error = message;
        flow.settledAt = now();
        return { ok: false, phase: 'failed', error: message };
      }

      const code = params.get('code');
      if (!code) {
        const message = 'Google did not return an authorization code.';
        flow.phase = 'failed';
        flow.error = message;
        flow.settledAt = now();
        return { ok: false, phase: 'failed', error: message };
      }

      const signal = AbortSignal.any([serviceAbort.signal, flow.abortController.signal]);
      let tokens;
      try {
        tokens = await exchangeGoogleCode(
          http,
          flow.client,
          { code, codeVerifier: flow.codeVerifier, redirectUri },
          signal
        );
      } catch (error) {
        if (flow.cancelled || closed) {
          flow.phase = 'cancelled';
          flow.settledAt ??= now();
          return { ok: false, phase: 'cancelled', error: 'Google sign-in was cancelled.' };
        }
        const message = formatExchangeError(error);
        flow.phase = 'failed';
        flow.error = message;
        flow.settledAt = now();
        return { ok: false, phase: 'failed', error: message };
      }

      if (flow.cancelled || closed) {
        const tokenToRevoke = tokens.refreshToken ?? tokens.accessToken;
        if (tokenToRevoke) {
          void revokeGoogleToken(http, tokenToRevoke).catch(() => {});
        }
        flow.phase = 'cancelled';
        flow.settledAt ??= now();
        return { ok: false, phase: 'cancelled', error: 'Google sign-in was cancelled.' };
      }

      let identity;
      try {
        // Trust boundary (OIDC Core §3.1.3.7): `tokens` came directly over TLS from
        // hardcoded GOOGLE_TOKEN_URL via `exchangeGoogleCode` (never frontend-supplied).
        identity = parseGoogleTokenEndpointIdToken(tokens, {
          expectedClientId: flow.client.clientId,
          nowMs: now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Google ID token validation failed.';
        flow.phase = 'failed';
        flow.error = message;
        flow.settledAt = now();
        return { ok: false, phase: 'failed', error: message };
      }

      const existingBeforeSave = readAccountsMap()[identity.sub] ?? null;
      const refreshToken =
        tokens.refreshToken ??
        (existingBeforeSave?.status === 'connected' &&
        existingBeforeSave.client?.clientId === flow.client.clientId
          ? existingBeforeSave.refreshToken
          : null);

      if (!refreshToken) {
        const message = "Google didn't return a lasting sign-in (missing refresh token). Try again.";
        flow.phase = 'failed';
        flow.error = message;
        flow.settledAt = now();
        return { ok: false, phase: 'failed', error: message };
      }

      const grantedScopes = uniqueNonEmptyStrings((tokens.scope ?? '').split(/\s+/));
      const mergedChoices = googleChoices([
        ...flow.choices,
        ...(existingBeforeSave?.choices ?? []),
        ...grantedGoogleChoices(grantedScopes),
      ]);

      const services = await checkGoogleServices({
        http,
        accessToken: tokens.accessToken,
        grantedScopes,
        choices: mergedChoices,
        ...(flow.client.projectId ? { projectId: flow.client.projectId } : {}),
      }).catch(() =>
        googleChoiceServices(mergedChoices).map((service) => ({
          service,
          state: 'error',
          detail: 'Readiness probe failed.',
        }))
      );

      if (flow.cancelled || closed) {
        void revokeGoogleToken(http, refreshToken).catch(() => {});
        flow.phase = 'cancelled';
        flow.settledAt ??= now();
        return { ok: false, phase: 'cancelled', error: 'Google sign-in was cancelled.' };
      }

      const savedAt = now();
      let savedRecord = null;
      mutateInternalRecord(GOOGLE_ACCOUNTS_CREDENTIAL_ID, (current) => {
        const accounts = isPlainObject(current?.accounts) ? { ...current.accounts } : {};
        // Remove any stale account carrying the same email under a different sub to keep email lookup unambiguous.
        for (const [key, entry] of Object.entries(accounts)) {
          if (key !== identity.sub && isPlainObject(entry) && entry.email === identity.email) {
            delete accounts[key];
          }
        }
        const prev = isPlainObject(accounts[identity.sub]) ? accounts[identity.sub] : null;
        savedRecord = {
          id: identity.sub,
          sub: identity.sub,
          email: identity.email,
          client: {
            clientId: flow.client.clientId,
            clientSecret: flow.client.clientSecret,
          },
          ...(flow.client.projectId ? { projectId: flow.client.projectId } : {}),
          refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: savedAt + tokens.expiresIn * 1000,
          grantedScopes,
          choices: mergedChoices,
          status: 'connected',
          services: services.map(sanitizeServiceView),
          checkedAt: savedAt,
          connectedAt: typeof prev?.connectedAt === 'number' ? prev.connectedAt : savedAt,
          updatedAt: savedAt,
        };
        accounts[identity.sub] = savedRecord;
        return { version: 1, accounts };
      });

      const view = accountView(savedRecord);
      flow.account = view;
      flow.phase = 'connected';
      flow.settledAt = savedAt;
      return {
        ok: true,
        phase: 'connected',
        account: view,
      };
    } finally {
      if (flow.phase === 'pending') {
        flow.phase = 'failed';
        flow.error = 'Google sign-in failed.';
        flow.settledAt = now();
      }
    }
  }

  async function refreshAccountOnce(accountId, force) {
    const record = readAccountsMap()[accountId];
    if (!record || record.status !== 'connected' || !record.refreshToken) {
      return { outcome: 'none' };
    }
    const currentNow = now();
    const isDue = !record.accessToken || record.expiresAt - currentNow <= GOOGLE_REFRESH_AHEAD_MS;
    if (!force && !isDue) {
      return { outcome: 'fresh' };
    }

    const currentClient = readClientConfig();
    const clientSecret =
      currentClient && currentClient.clientId === record.client.clientId
        ? currentClient.clientSecret
        : record.client.clientSecret;
    const usedRefreshToken = record.refreshToken;

    const refreshed = await refreshGoogleAccessToken(
      http,
      {
        clientId: record.client.clientId,
        clientSecret,
        refreshToken: usedRefreshToken,
      },
      serviceAbort.signal
    );

    if (refreshed.kind === 'offline') {
      return { outcome: 'offline' };
    }

    let finalOutcome = refreshed.kind === 'refreshed' ? 'refreshed' : 'ended';
    mutateInternalRecord(GOOGLE_ACCOUNTS_CREDENTIAL_ID, (current) => {
      const accounts = isPlainObject(current?.accounts) ? { ...current.accounts } : null;
      const latest = accounts?.[accountId];
      // If removed or re-authorized while the refresh was in flight, never clobber the newer state.
      if (!latest || latest.refreshToken !== usedRefreshToken) {
        finalOutcome = 'superseded';
        return undefined;
      }

      const updatedAt = now();
      if (refreshed.kind === 'refreshed') {
        const nextScopes = refreshed.tokens.scope
          ? uniqueNonEmptyStrings(refreshed.tokens.scope.split(/\s+/))
          : latest.grantedScopes;
        accounts[accountId] = {
          ...latest,
          accessToken: refreshed.tokens.accessToken,
          refreshToken: refreshed.tokens.refreshToken ?? latest.refreshToken,
          expiresAt: updatedAt + refreshed.tokens.expiresIn * 1000,
          grantedScopes: nextScopes,
          updatedAt,
        };
      } else {
        accounts[accountId] = {
          ...latest,
          status: 'reconnect',
          reason: refreshed.reason,
          refreshToken: null,
          accessToken: null,
          expiresAt: 0,
          updatedAt,
        };
      }
      return { version: 1, accounts };
    });

    return { outcome: finalOutcome };
  }

  function serializedRefresh(accountId, force) {
    let pending = refreshInFlight.get(accountId);
    if (!pending) {
      pending = refreshAccountOnce(accountId, force).finally(() => {
        if (refreshInFlight.get(accountId) === pending) {
          refreshInFlight.delete(accountId);
        }
      });
      refreshInFlight.set(accountId, pending);
    }
    return pending;
  }

  async function getAccessTokenForAccount(accountId, force = false) {
    assertOpen();
    const initial = readAccountsMap()[accountId];
    if (!initial) {
      throw fail('GOOGLE_ACCOUNT_NOT_FOUND', 'Google account is not connected in Center.');
    }
    if (initial.status !== 'connected' || !initial.refreshToken) {
      throw fail(
        'GOOGLE_RECONNECT_REQUIRED',
        initial.reason ?? 'Google access ended. Reconnect this account in Center.'
      );
    }

    const currentNow = now();
    const isDue = !initial.accessToken || initial.expiresAt - currentNow <= GOOGLE_REFRESH_AHEAD_MS;
    if (!force && !isDue) {
      return initial.accessToken;
    }

    const { outcome } = await serializedRefresh(accountId, force);
    const latest = readAccountsMap()[accountId];
    if (!latest) {
      throw fail('GOOGLE_ACCOUNT_NOT_FOUND', 'Google account is not connected in Center.');
    }
    if (latest.status !== 'connected') {
      throw fail(
        'GOOGLE_RECONNECT_REQUIRED',
        latest.reason ?? 'Google access ended. Reconnect this account in Center.'
      );
    }
    if (outcome === 'offline' && (force || !latest.accessToken || latest.expiresAt <= now())) {
      throw fail(
        'GOOGLE_UNAVAILABLE',
        `Couldn't reach Google to renew ${latest.email}'s sign-in. Try again in a moment.`
      );
    }
    if (!latest.accessToken) {
      throw fail(
        'GOOGLE_RECONNECT_REQUIRED',
        latest.reason ?? 'Google access ended. Reconnect this account in Center.'
      );
    }
    return latest.accessToken;
  }

  async function probeOneAccount(accountId) {
    let accessToken;
    try {
      accessToken = await getAccessTokenForAccount(accountId, false);
    } catch (error) {
      if (
        error?.code === 'GOOGLE_RECONNECT_REQUIRED' ||
        error?.code === 'GOOGLE_UNAVAILABLE' ||
        error?.code === 'GOOGLE_ACCOUNT_NOT_FOUND'
      ) {
        return;
      }
      throw error;
    }

    const snapshot = readAccountsMap()[accountId];
    if (!snapshot || snapshot.status !== 'connected') {
      return;
    }

    const choices = Array.isArray(snapshot.choices) && snapshot.choices.length > 0
      ? snapshot.choices
      : grantedGoogleChoices(snapshot.grantedScopes ?? []);
    const services = await checkGoogleServices({
      http,
      accessToken,
      grantedScopes: snapshot.grantedScopes ?? [],
      choices,
      ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
    });

    const checkedAt = now();
    mutateInternalRecord(GOOGLE_ACCOUNTS_CREDENTIAL_ID, (current) => {
      const accounts = isPlainObject(current?.accounts) ? { ...current.accounts } : null;
      const latest = accounts?.[accountId];
      if (!latest || latest.status !== 'connected') {
        return undefined;
      }
      accounts[accountId] = {
        ...latest,
        services: services.map(sanitizeServiceView),
        checkedAt,
        updatedAt: checkedAt,
      };
      return { version: 1, accounts };
    });
  }

  async function check(input) {
    const body = input === undefined || input === null ? {} : input;
    if (!isPlainObject(body)) {
      throw fail('INVALID_ARGUMENT', 'Expected a check request object.');
    }
    assertAllowedKeys(body, new Set(['account']), 'check');

    const accountsMap = readAccountsMap();
    if (body.account !== undefined && body.account !== null && body.account !== '') {
      const ref = assertBoundedString(body.account, 'account', 320);
      const target = findAccountRecord(accountsMap, ref);
      if (!target) {
        throw fail('NOT_FOUND', 'Google account not found.');
      }
      await probeOneAccount(target.id);
      const updated = readAccountsMap()[target.id];
      const currentStatus = status();
      return {
        ...currentStatus,
        ...(updated ? { account: accountView(updated) } : {}),
      };
    }

    const client = readClientConfig();
    if (client) {
      const keyState = await checkGoogleClientKey(http, client, redirectUri, serviceAbort.signal);
      if (keyState !== 'unknown') {
        clientKeyCache = { fingerprint: clientFingerprint(client), state: keyState };
      }
    }

    const ids = listAccountRecords().map((record) => record.id);
    await Promise.all(ids.map((id) => probeOneAccount(id)));
    return status();
  }

  async function remove(input) {
    if (!isPlainObject(input)) {
      throw fail('INVALID_ARGUMENT', 'Expected a remove request object.');
    }
    assertAllowedKeys(input, new Set(['account', 'revoke']), 'remove');

    const accountRef = assertBoundedString(input.account, 'account', 320);
    if (input.revoke !== undefined && typeof input.revoke !== 'boolean') {
      throw fail('INVALID_ARGUMENT', 'revoke must be a boolean.');
    }
    const revokeRequested = input.revoke === true;

    let removedRecord = null;
    mutateInternalRecord(GOOGLE_ACCOUNTS_CREDENTIAL_ID, (current) => {
      const accounts = isPlainObject(current?.accounts) ? { ...current.accounts } : {};
      const match = findAccountRecord(accounts, accountRef);
      if (!match) {
        throw fail('NOT_FOUND', 'Google account not found.');
      }
      removedRecord = match;
      delete accounts[match.id];
      return { version: 1, accounts };
    });

    if (!revokeRequested) {
      return {
        removed: true,
        accountId: removedRecord.id,
        email: removedRecord.email,
        revokeRequested: false,
        revoked: null,
        revokeStatus: 'skipped',
      };
    }

    const tokenToRevoke = removedRecord.refreshToken ?? removedRecord.accessToken;
    if (!tokenToRevoke) {
      return {
        removed: true,
        accountId: removedRecord.id,
        email: removedRecord.email,
        revokeRequested: true,
        revoked: null,
        revokeStatus: 'no-token',
      };
    }

    const revokeResult = await revokeGoogleToken(http, tokenToRevoke, serviceAbort.signal);
    if (revokeResult.ok) {
      return {
        removed: true,
        accountId: removedRecord.id,
        email: removedRecord.email,
        revokeRequested: true,
        revoked: true,
        revokeStatus: 'revoked',
      };
    }

    return {
      removed: true,
      accountId: removedRecord.id,
      email: removedRecord.email,
      revokeRequested: true,
      revoked: false,
      revokeStatus: 'failed',
      revokeError: `Removed ${removedRecord.email} from Center, but failed to revoke access at Google: ${revokeResult.reason}`,
    };
  }

  async function manage(action, input, ownerKey) {
    if (action === 'status') {
      return status();
    }
    assertOpen();
    const owner = assertOwnerKey(ownerKey);
    switch (action) {
      case 'configure':
        return configure(input);
      case 'authorize':
        return authorize(input, owner);
      case 'flow':
        return inspectFlow(input, owner);
      case 'cancel':
        return cancelFlow(input, owner);
      case 'check':
        return check(input);
      case 'remove':
        return remove(input);
      default:
        throw fail('INVALID_ARGUMENT', `Unsupported Google accounts action: ${String(action)}`);
    }
  }

  function resolveAccountForApi(wanted) {
    assertOpen();
    const accountsMap = readAccountsMap();
    if (wanted !== undefined && wanted !== null) {
      const ref = assertBoundedString(wanted, 'account', 320);
      const match = findAccountRecord(accountsMap, ref);
      if (!match) {
        throw fail(
          'GOOGLE_ACCOUNT_NOT_FOUND',
          `Google account "${ref}" is not connected in Center.`
        );
      }
      return match;
    }

    const all = listAccountRecords();
    if (all.length === 0) {
      throw fail(
        'GOOGLE_ACCOUNT_NOT_CONNECTED',
        'No Google account is connected in Center. Connect one in Center Google settings.'
      );
    }
    if (all.length > 1) {
      const choices = all.map((entry) => ({
        id: entry.id,
        email: entry.email,
        status: entry.status,
      }));
      throw fail(
        'GOOGLE_ACCOUNT_AMBIGUOUS',
        `Multiple Google accounts are connected (${all.map((entry) => entry.email).join(', ')}); specify which account to use.`,
        { accounts: choices }
      );
    }
    return all[0];
  }

  function api(account) {
    const record = resolveAccountForApi(account);
    return buildGoogleWorkspaceApi({
      id: record.id,
      email: record.email,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      getAccessToken: (force) => getAccessTokenForAccount(record.id, Boolean(force)),
      fetchImpl: http,
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    const closedAt = now();
    serviceAbort.abort();
    for (const flow of flowsById.values()) {
      if (flow.phase === 'pending') {
        flow.cancelled = true;
        flow.phase = 'cancelled';
        flow.settledAt = closedAt;
        flow.abortController.abort();
      }
    }
    statesByValue.clear();
  }

  return {
    status,
    manage,
    callback,
    api,
    close,
  };
}
