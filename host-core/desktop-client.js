// host-core/desktop-client.js
// Module 17: client-only Node broker for the desktop Tauri client.
// Reuses existing fixed control clients (createLocalControlAdapter,
// openRemoteControl), pending outbox (openPendingClient), and private UI state
// store (openDesktopUiStore). Never starts a Host, Runtime, or model loop;
// close/disconnect aborts client transports and observations only.
import fs from 'node:fs';
import path from 'node:path';
import { connectCenter, validateCenterUrl } from './center-client.js';
import { createHash } from 'node:crypto';
import { assertId, assertRevision, messageError } from './message-protocol.js';
import { assertUuid } from './pending-store.js';
import { openPendingClient } from './pending-client.js';
import { collectBotDirectory } from './bot-directory.js';
import { createLocalControlAdapter } from './local-control-adapter.js';
import { openRemoteControl } from './remote-control-client.js';
import {
  CONTROL_ERROR_CODES,
  CONTROL_OUTCOMES,
  CONTROL_CLIENT_TIMEOUT_MS,
  CONTROL_MAX_CLIENT_CALLS,
  controlBrokerTimeoutMs,
  normalizeControlCall,
} from './remote-control-protocol.js';
import {
  LIVE_MAX_CLIENT_SUBSCRIPTIONS,
  normalizeLiveTarget,
} from './remote-live-protocol.js';
import { parseRelayUrl, assertDeviceToken, isCertificateError } from './relay-protocol.js';
import { normalizeHostSettings } from './host-settings.js';
import {
  openDesktopUiStore,
  validateLocalControlUrl,
} from './desktop-ui-store.js';

export const DESKTOP_MAX_IN_FLIGHT_REQUESTS = CONTROL_MAX_CLIENT_CALLS; // 8
export const DESKTOP_MAX_OBSERVATIONS = LIVE_MAX_CLIENT_SUBSCRIPTIONS; // 8
export const DESKTOP_CALL_TIMEOUT_MS = CONTROL_CLIENT_TIMEOUT_MS; // 25000 for ordinary calls
export const INTENT_METHODS = new Set([
  'createBot',
  'createScope',
  'updateScope',
  'deleteScope',
  'setPrimaryBot',
  'archiveBot',
  'unarchiveBot',
  'deleteBot',
]);
const MAX_CA_PEM_BYTES = 65536; // 64 KiB
const MAX_ERROR_MESSAGE_BYTES = 512;
const STABLE_ERROR_CODES = new Set([...CONTROL_ERROR_CODES, 'REPLACED', 'PENDING_BUSY', 'CERTIFICATE_ERROR']);
const LOCAL_OFFLINE_OPS = new Set(['pending_enqueue', 'pending_get', 'pending_list', 'pending_cancel', 'ui_get', 'ui_set']);
const CENTER_LIFECYCLE_OPS = new Set(['center_connect', 'center_status', 'center_disconnect', 'center_store', 'status', 'disconnect', 'unobserve']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function brokerError(code, outcome, message) {
  const safeCode = typeof code === 'string' && STABLE_ERROR_CODES.has(code) ? code : 'INTERNAL';
  const safeOutcome = typeof outcome === 'string' && CONTROL_OUTCOMES.has(outcome) ? outcome : 'unconfirmed';
  const defaultMsg = `desktop client ${safeCode.toLowerCase().replace(/_/g, ' ')} (${safeOutcome})`;
  let safeMessage = typeof message === 'string' && message.isWellFormed() && message.trim() !== ''
    ? message
    : defaultMsg;
  if (Buffer.byteLength(safeMessage, 'utf8') > MAX_ERROR_MESSAGE_BYTES) {
    safeMessage = defaultMsg;
  }
  const err = new Error(safeMessage);
  err.name = 'DesktopClientError';
  err.code = safeCode;
  err.outcome = safeOutcome;
  return err;
}

function invalid(message) {
  return brokerError('INVALID_ARGUMENT', 'not-sent', message);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

export function normalizeDesktopError(err, fallbackOutcome = 'unconfirmed') {
  if (err && err.name === 'DesktopClientError' && STABLE_ERROR_CODES.has(err.code) && CONTROL_OUTCOMES.has(err.outcome)) {
    return { code: err.code, message: err.message, outcome: err.outcome };
  }
  const rawCode = err && typeof err.code === 'string' ? err.code : null;
  const code = rawCode && STABLE_ERROR_CODES.has(rawCode) ? rawCode : 'INTERNAL';
  let outcome = fallbackOutcome;
  if (err && typeof err.outcome === 'string' && CONTROL_OUTCOMES.has(err.outcome)) {
    outcome = err.outcome;
  } else if (code === 'INVALID_ARGUMENT' || code === 'REQUEST_TOO_LARGE' || code === 'NOT_CONNECTED' || code === 'RPC_BUSY') {
    outcome = 'not-sent';
  } else if (
    code === 'REQUEST_CONFLICT' ||
    code === 'UNSUPPORTED_SCHEMA' ||
    code === 'STORE_FAILED' ||
    code === 'PENDING_BUSY' ||
    code === 'PRIMARY_BOT_PROTECTED' ||
    code === 'BOT_ARCHIVED' ||
    code === 'INVALID_STATE'
  ) {
    outcome = 'responded';
  }
  const defaultMsg = `desktop client ${code.toLowerCase().replace(/_/g, ' ')} (${outcome})`;
  const message =
    code !== 'INTERNAL' && err && typeof err.message === 'string' && err.message.isWellFormed() && err.message.trim() !== '' &&
    Buffer.byteLength(err.message, 'utf8') <= MAX_ERROR_MESSAGE_BYTES
      ? err.message
      : defaultMsg;
  return { code, message, outcome };
}

function validateCaPem(ca) {
  if (
    typeof ca !== 'string' ||
    !ca.isWellFormed() ||
    ca.trim() === '' ||
    Buffer.byteLength(ca, 'utf8') > MAX_CA_PEM_BYTES ||
    !ca.includes('-----BEGIN CERTIFICATE-----') ||
    !ca.includes('-----END CERTIFICATE-----')
  ) {
    throw invalid('ca must be a valid PEM certificate string of at most 64 KiB');
  }
  return ca;
}

function normalizeConnectionInput(raw) {
  if (!isPlainObject(raw)) throw invalid('connection must be a plain object');
  if (raw.kind === 'local') {
    rejectUnknownFields(raw, new Set(['kind', 'url', 'token', 'expectedDeviceId']), 'local connection');
    const url = validateLocalControlUrl(raw.url);
    try {
      assertDeviceToken(raw.token);
    } catch {
      throw invalid('token must be a URL-safe string of 32-512 characters');
    }
    let expectedDeviceId;
    if (raw.expectedDeviceId !== undefined) {
      try {
        assertId(raw.expectedDeviceId, 'expectedDeviceId');
      } catch (err) {
        throw invalid(err.message);
      }
      expectedDeviceId = raw.expectedDeviceId;
    }
    return {
      kind: 'local',
      url,
      token: raw.token,
      ...(expectedDeviceId !== undefined ? { expectedDeviceId } : {}),
    };
  }
  if (raw.kind === 'relay') {
    rejectUnknownFields(raw, new Set(['kind', 'url', 'deviceId', 'token', 'ca']), 'relay connection');
    try {
      parseRelayUrl(raw.url);
    } catch (err) {
      throw invalid(err.message);
    }
    try {
      assertId(raw.deviceId, 'deviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    try {
      assertDeviceToken(raw.token);
    } catch {
      throw invalid('token must be a URL-safe string of 32-512 characters');
    }
    let ca;
    if (raw.ca !== undefined) {
      ca = validateCaPem(raw.ca);
    }
    return {
      kind: 'relay',
      url: raw.url,
      deviceId: raw.deviceId,
      token: raw.token,
      ...(ca !== undefined ? { ca } : {}),
    };
  }
  throw invalid("connection.kind must be 'local' or 'relay'");
}

export function derivePendingProfileKey(connection) {
  const tuple = connection.kind === 'local'
    ? ['local', connection.url, '']
    : ['relay', connection.url, connection.deviceId];
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

function redactConnection(conn, resolvedDeviceId) {
  if (!conn) return null;
  if (conn.kind === 'local') {
    const out = { kind: 'local', url: conn.url };
    if (conn.expectedDeviceId !== undefined) out.expectedDeviceId = conn.expectedDeviceId;
    if (resolvedDeviceId) out.deviceId = resolvedDeviceId;
    return out;
  }
  return {
    kind: 'relay',
    url: conn.url,
    deviceId: conn.deviceId,
  };
}

function withCallTimeout(parentSignal, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  let onParentAbort = null;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      onParentAbort = () => controller.abort();
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (onParentAbort && parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

export function openDesktopClient(options) {
  if (!isPlainObject(options)) {
    throw invalid('openDesktopClient: options must be a plain object');
  }
  rejectUnknownFields(options, new Set(['dataRoot', 'onEvent', 'persistCenterCredentials']), 'openDesktopClient options');
  const { dataRoot, onEvent, persistCenterCredentials = true } = options;
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalid('openDesktopClient: dataRoot must be a non-empty absolute path');
  }
  if (onEvent !== undefined && typeof onEvent !== 'function') {
    throw invalid('openDesktopClient: onEvent must be a function when provided');
  }
  if (typeof persistCenterCredentials !== 'boolean') {
    throw invalid('openDesktopClient: persistCenterCredentials must be a boolean');
  }

  const resolvedDataRoot = path.resolve(dataRoot);
  const uiStore = openDesktopUiStore({ dataRoot: resolvedDataRoot });
  const clientId = uiStore.clientId;
  const emitEvent = onEvent ?? (() => {});

  let closed = false;
  let closePromise = null;

  // Connection state & generation fence
  let generation = 0;
  let phase = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'failed'
  let redactedConn = null;
  let lastObservedAt = null;
  let errorCode = null;
  let activeSession = null; // { generation, kind, adapter?, remote?, localDeviceId?, connectController? }
  let centerClient = null;
  let centerGeneration = 0;
  let centerState = 'disconnected';
  let centerUrl = '';
  let centerError = null;
  let centerCredentials = null;
  let centerRelayConnection = null;
  let centerAttempt = null;
  let centerAttemptChain = Promise.resolve();
  let centerProbe = null;
  let centerRetryTimer = null;
  let centerRetryCount = 0;
  let selectedCenterKey = null;
  const credentialsFile = path.join(resolvedDataRoot, 'center-credentials.json');

  function readSavedCenterCredentials() {
    if (!persistCenterCredentials) return null;
    try {
      if (!fs.existsSync(credentialsFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
      if (!isPlainObject(parsed) || typeof parsed.url !== 'string' || typeof parsed.deviceId !== 'string' || typeof parsed.deviceToken !== 'string') {
        return null;
      }
      return {
        url: parsed.url,
        deviceId: parsed.deviceId,
        deviceToken: parsed.deviceToken,
        ca: typeof parsed.ca === 'string' ? parsed.ca : '',
      };
    } catch {
      return null;
    }
  }

  // strict=false: best-effort persist (normal connect path) — returns whether
  // the record landed. strict=true: throws STORE_FAILED so center_store can
  // report honestly. Writes go through a same-dir unique tmp + atomic rename so
  // a crash never leaves a truncated credentials file.
  function writeSavedCenterCredentials(record, strict = false) {
    const fail = () => {
      if (strict) throw brokerError('STORE_FAILED', 'not-sent', 'failed to persist center credentials');
      return false;
    };
    if (!persistCenterCredentials) return fail();
    const tmpFile = credentialsFile + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      fs.mkdirSync(resolvedDataRoot, { recursive: true });
      fs.writeFileSync(tmpFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpFile, credentialsFile);
      return true;
    } catch {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
      return fail();
    }
  }

  function clearSavedCenterCredentials() {
    if (!persistCenterCredentials) return;
    try {
      if (fs.existsSync(credentialsFile)) fs.unlinkSync(credentialsFile);
    } catch {
      /* ignore unlink errors */
    }
  }

  function centerProfileKey(credentials) {
    const origin = validateCenterUrl(credentials.url).origin;
    assertId(credentials.deviceId, 'deviceId');
    assertDeviceToken(credentials.deviceToken);
    if (credentials.ca !== '') validateCaPem(credentials.ca);
    return createHash('sha256').update(JSON.stringify([origin, credentials.deviceId, credentials.ca]), 'utf8').digest('hex');
  }

  function readCenterPendingProfile(centerKey, credentials) {
    try {
      const file = path.join(resolvedDataRoot, 'pending', 'center-profiles', centerKey + '.json');
      const { centerUrl, deviceId, relayUrl } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (centerUrl !== validateCenterUrl(credentials.url).origin || deviceId !== credentials.deviceId) return null;
      parseRelayUrl(relayUrl);
      const profileKey = derivePendingProfileKey({ kind: 'relay', url: relayUrl, deviceId });
      return fs.existsSync(path.join(resolvedDataRoot, 'pending', profileKey, 'client-pending.sqlite')) ? profileKey : null;
    } catch {
      return null;
    }
  }

  function writeCenterPendingProfile(centerKey, credentials, relayUrl) {
    try {
      const directory = path.join(resolvedDataRoot, 'pending', 'center-profiles');
      fs.mkdirSync(directory, { recursive: true });
      const mapping = { centerUrl: validateCenterUrl(credentials.url).origin, deviceId: credentials.deviceId, relayUrl };
      fs.writeFileSync(path.join(directory, centerKey + '.json'), JSON.stringify(mapping), { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* An unavailable mapping must not affect the authenticated connection. */
    }
  }

  function describeCenterFailure(error) {
    if (error?.code === 'CERTIFICATE_ERROR' || isCertificateError(error)) {
      return { code: 'CERTIFICATE_ERROR', message: 'center or relay certificate validation failed', permanent: true };
    }
    if (error?.code === 'UNAUTHORIZED' || error?.code === 'REVOKED') {
      return { code: error.code, message: 'center or relay authentication was rejected', permanent: true };
    }
    if (error?.code === 'INVALID_ARGUMENT' || error?.code === 'CONTROL_IDENTITY_MISMATCH') {
      return { code: 'INVALID_ARGUMENT', message: 'invalid center or relay connection parameters', permanent: true };
    }
    return { code: 'CENTER_OFFLINE', message: 'center or relay unavailable', permanent: false };
  }

  function cancelCenterRetry() {
    if (centerRetryTimer) clearTimeout(centerRetryTimer);
    centerRetryTimer = null;
    if (centerAttempt) centerAttempt.controller.abort();
  }

  function abortCenterRequests() {
    for (const record of inflightRequests.values()) {
      if (!CENTER_LIFECYCLE_OPS.has(record.op) && !LOCAL_OFFLINE_OPS.has(record.op)) record.controller.abort();
    }
  }

  function endConnectionObservations(error) {
    for (const record of observations.values()) {
      if (record.connection && !record.settled) {
        record.settled = true;
        void Promise.resolve(emitEvent({ type: 'event', observationId: record.id, error })).catch(() => {});
        record.controller.abort();
      }
    }
  }

  function scheduleCenterRetry(myGeneration) {
    if (closed || myGeneration !== centerGeneration || !centerCredentials || centerRetryTimer || centerAttempt) return;
    const base = Math.min(30000, 1000 * 2 ** Math.min(centerRetryCount++, 5));
    const delay = Math.min(30000, Math.round(base * (0.75 + Math.random() * 0.5)));
    centerRetryTimer = setTimeout(() => {
      centerRetryTimer = null;
      void startCenterAttempt(myGeneration).catch(() => {});
    }, delay);
    centerRetryTimer.unref?.();
  }

  function failCenter(error, myGeneration) {
    if (closed || myGeneration !== centerGeneration) return;
    const failure = describeCenterFailure(error);
    centerError = { code: failure.code, message: failure.message };
    centerState = failure.permanent ? 'disconnected' : 'connecting';
    endConnectionObservations({ ...centerError, outcome: 'unconfirmed' });
    dropTransportForCenter();
    abortCenterRequests();
    const previous = centerClient;
    centerClient = null;
    if (previous) void previous.close();
    if (failure.permanent) {
      centerCredentials = null;
      cancelCenterRetry();
      phase = 'failed';
      errorCode = failure.code;
    } else {
      scheduleCenterRetry(myGeneration);
    }
  }

  function startCenterAttempt(myGeneration, rec) {
    if (centerAttempt?.generation === myGeneration && !centerAttempt.controller.signal.aborted) return centerAttempt.promise;
    const credentials = centerCredentials;
    const attempt = { generation: myGeneration, controller: new AbortController(), failure: null, promise: null };
    const run = centerAttemptChain.then(async () => {
      if (closed || myGeneration !== centerGeneration || attempt.controller.signal.aborted) {
        throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
      }
      let client = null;
      try {
        const centerKey = centerProfileKey(credentials);
        selectedCenterKey = centerKey;
        const savedProfile = readCenterPendingProfile(centerKey, credentials);
        if (savedProfile) await ensurePendingProfile(savedProfile, centerKey, myGeneration);
        if (closed || myGeneration !== centerGeneration || attempt.controller.signal.aborted) {
          throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
        }
        client = await connectCenter({
          centerUrl: credentials.url, deviceId: credentials.deviceId, deviceToken: credentials.deviceToken,
          ca: credentials.ca || undefined, signal: attempt.controller.signal,
          onDisconnect: (error) => {
            if (myGeneration !== centerGeneration || (centerAttempt !== attempt && centerClient !== client)) return;
            attempt.failure = error;
            attempt.controller.abort();
            failCenter(error, myGeneration);
          },
          onChange: () => {},
        });
        if (closed || myGeneration !== centerGeneration || attempt.controller.signal.aborted) {
          await client.close();
          throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
        }
        centerClient = client;
        const { linkUrl } = await client.getConnection(attempt.controller.signal);
        if (closed || myGeneration !== centerGeneration || centerClient !== client || attempt.controller.signal.aborted) {
          throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
        }
        await opConnect({ connection: { kind: 'relay', url: linkUrl, deviceId: credentials.deviceId,
          token: credentials.deviceToken, ...(credentials.ca ? { ca: credentials.ca } : {}) } },
        attempt.controller.signal, rec, true);
        if (closed || myGeneration !== centerGeneration || centerClient !== client || attempt.controller.signal.aborted) {
          throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
        }
        centerRelayConnection = { url: linkUrl, deviceId: credentials.deviceId, ca: credentials.ca };
        centerState = 'ready';
        centerError = null;
        centerRetryCount = 0;
        writeCenterPendingProfile(centerKey, credentials, linkUrl);
        writeSavedCenterCredentials(credentials);
        return centerStatus();
      } catch (error) {
        if (client && centerClient !== client) await client.close();
        if (!closed && myGeneration === centerGeneration) {
          const failure = describeCenterFailure(attempt.failure || error);
          failCenter(attempt.failure || error, myGeneration);
          throw brokerError(failure.permanent ? failure.code : 'NOT_CONNECTED', 'not-sent', failure.message);
        }
        throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
      } finally {
        if (centerAttempt === attempt) {
          centerAttempt = null;
          if (centerState === 'connecting') scheduleCenterRetry(myGeneration);
        }
      }
    });
    attempt.promise = run;
    centerAttempt = attempt;
    centerAttemptChain = run.catch(() => {});
    return run;
  }

  async function opCenterConnect(params, reqSignal, rec) {
    rejectUnknownFields(params, new Set(['url', 'deviceId', 'deviceToken', 'ca']), 'center_connect params');
    let effectiveToken = params.deviceToken;
    if (effectiveToken === '' || effectiveToken === undefined) {
      const saved = readSavedCenterCredentials();
      if (saved && saved.url === params.url && saved.deviceId === params.deviceId && saved.ca === (params.ca || '') && saved.deviceToken) {
        effectiveToken = saved.deviceToken;
      }
    }
    const credentials = { url: params.url, deviceId: params.deviceId, deviceToken: effectiveToken, ca: params.ca ?? '' };
    if (centerCredentials && Object.keys(credentials).every((key) => credentials[key] === centerCredentials[key])) {
      if (centerState === 'ready') return centerStatus();
      if (centerAttempt?.generation === centerGeneration && !centerAttempt.controller.signal.aborted) return centerAttempt.promise;
      if (centerRetryTimer) {
        clearTimeout(centerRetryTimer);
        centerRetryTimer = null;
        return startCenterAttempt(centerGeneration, rec);
      }
    }

    cancelCenterRetry();
    const myGeneration = ++centerGeneration;
    centerCredentials = credentials;
    selectedCenterKey = null;
    centerState = 'connecting';
    centerError = null;
    centerRetryCount = 0;
    centerUrl = '';
    try {
      const parsed = new URL(params.url);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) centerUrl = parsed.origin;
    } catch { /* connectCenter rejects invalid input */ }
    endConnectionObservations({ code: 'CANCELLED', message: 'center connection replaced', outcome: 'unconfirmed' });
    dropTransportForCenter();
    abortCenterRequests();
    const previous = centerClient;
    centerClient = null;
    if (previous) await previous.close();
    if (closed || myGeneration !== centerGeneration || reqSignal?.aborted) {
      throw brokerError('CANCELLED', 'not-sent', 'center connection superseded');
    }
    return startCenterAttempt(myGeneration, rec);
  }

  function centerStatus() {
    const saved = readSavedCenterCredentials();
    return {
      state: centerState,
      centerUrl,
      appliedRevision: null,
      error: centerError,
      clientId,
      ...(saved ? { savedConnection: { url: saved.url, deviceId: saved.deviceId, ca: saved.ca } } : {}),
    };
  }

  function cancelCenterProbe() {
    const probe = centerProbe;
    centerProbe = null;
    if (probe) probe.controller.abort();
  }

  function probeReadyCenter() {
    if (centerProbe) return centerProbe.promise;
    const myGeneration = centerGeneration;
    const client = centerClient;
    const session = activeSession;
    const transportGeneration = generation;
    if (!client || phase !== 'connected' || session?.kind !== 'relay' || !session.remote) {
      failCenter(brokerError('NOT_CONNECTED', 'not-sent', 'center or relay unavailable'), myGeneration);
      return Promise.resolve();
    }
    const probe = { controller: new AbortController(), promise: null };
    const timeout = withCallTimeout(probe.controller.signal, 5000);
    centerProbe = probe;
    probe.promise = (async () => {
      try {
        await Promise.all([
          client.getConnection(timeout.signal),
          session.remote.listDevices({ limit: 1, signal: timeout.signal }),
        ]);
      } catch (error) {
        if (!probe.controller.signal.aborted && !closed && centerState === 'ready' &&
            myGeneration === centerGeneration && centerClient === client &&
            activeSession === session && generation === transportGeneration) {
          failCenter(error, myGeneration);
        }
      } finally {
        probe.controller.abort();
        timeout.cleanup();
        if (centerProbe === probe) centerProbe = null;
      }
    })();
    return probe.promise;
  }

  async function opCenterStatus(params) {
    rejectUnknownFields(params, new Set(['probe']), 'center_status params');
    if (params.probe !== undefined && typeof params.probe !== 'boolean') throw invalid('probe must be a boolean');
    if (params.probe && centerState === 'ready') {
      await probeReadyCenter();
    }
    // A failed foreground/manual probe must also bypass the retry backoff.
    if (params.probe && centerState === 'connecting' && centerCredentials) {
      if (centerRetryTimer) clearTimeout(centerRetryTimer);
      centerRetryTimer = null;
      void startCenterAttempt(centerGeneration).catch(() => {});
    }
    return centerStatus();
  }

  async function opCenterDisconnect(params) {
    rejectUnknownFields(params, new Set(), 'center_disconnect params');
    clearSavedCenterCredentials();
    cancelCenterRetry();
    centerGeneration += 1;
    centerCredentials = null;
    centerState = 'disconnected';
    centerError = null;
    endConnectionObservations({ code: 'CANCELLED', message: 'center disconnected', outcome: 'unconfirmed' });
    dropTransportForCenter();
    abortCenterRequests();
    const previous = centerClient;
    centerClient = null;
    if (previous) await previous.close();
    return centerStatus();
  }

  // UI-local: persists user-authorized device credentials for later reconnects
  // (invoked by desktop_host_pair/adopt after the launcher registered). No
  // network and no Host lifecycle — but any in-flight center session for the
  // previous binding is torn down first so a late success cannot overwrite the
  // new record.
  async function opCenterStore(params) {
    rejectUnknownFields(params, new Set(['url', 'deviceId', 'deviceToken', 'ca']), 'center_store params');
    const credentials = {
      url: params.url,
      deviceId: params.deviceId,
      deviceToken: params.deviceToken,
      ca: params.ca ?? '',
    };
    validateCenterUrl(credentials.url);
    try {
      assertId(credentials.deviceId, 'deviceId');
      assertDeviceToken(credentials.deviceToken);
    } catch (err) {
      throw invalid(err.message);
    }
    if (credentials.ca !== '') validateCaPem(credentials.ca);
    cancelCenterRetry();
    const myGeneration = (centerGeneration += 1);
    centerCredentials = null;
    centerState = 'disconnected';
    centerError = null;
    endConnectionObservations({ code: 'CANCELLED', message: 'center credentials replaced', outcome: 'unconfirmed' });
    dropTransportForCenter();
    abortCenterRequests();
    const previous = centerClient;
    centerClient = null;
    if (previous) await previous.close();
    // A concurrent connect/store could have bumped the generation while we were
    // closing — if so, let it win instead of overwriting it with this record.
    if (centerGeneration !== myGeneration) {
      throw brokerError('CANCELLED', 'not-sent', 'center store superseded');
    }
    writeSavedCenterCredentials(credentials, true);
    return centerStatus();
  }

  async function ownerOperation(params, signal, kind) {
    const allowed = kind === 'session' ? [] : kind === 'login' ? ['password'] : kind === 'get' ? ['deviceId', 'botId'] : ['deviceId', 'botId', 'expectedRevision', 'value'];
    rejectUnknownFields(params, new Set(allowed), `center owner ${kind} params`);
    if (kind === 'login' && (typeof params.password !== 'string' || params.password.length > 1024)) throw invalid('invalid administrator password');
    if (kind === 'get' || kind === 'set') {
      try { assertId(params.deviceId, 'deviceId'); assertId(params.botId, 'botId'); } catch (err) { throw invalid(err.message); }
      if (['.', '..'].includes(params.deviceId) || ['.', '..'].includes(params.botId)) throw invalid('invalid model target');
    }
    if (kind === 'set') {
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) throw invalid('invalid expectedRevision');
      if (!isPlainObject(params.value)) throw invalid('model selection must be an object');
      rejectUnknownFields(params.value, new Set(['modelRef', 'thinkingLevel', 'codemode', 'codemodeOnly']), 'model selection');
      for (const [key, value] of Object.entries(params.value)) {
        if (key === 'codemode' || key === 'codemodeOnly') {
          if (value !== null && typeof value !== 'boolean') throw invalid('invalid model selection');
        } else if (value !== null && (typeof value !== 'string' || !value.length)) {
          throw invalid('invalid model selection');
        }
      }
    }
    const client = centerClient;
    try {
      if (kind === 'session') return await client.ownerSession(signal);
      if (kind === 'login') return await client.ownerLogin(params.password, signal);
      if (kind === 'get') return await client.botModelGet(params.deviceId, params.botId, signal);
      return await client.botModelSet(params.deviceId, params.botId, { expectedRevision: params.expectedRevision, value: params.value }, signal);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.code === 'REQUEST_CONFLICT' || norm.code === 'CONTROL_UNAUTHORIZED' || norm.code === 'BAD_RESPONSE' ? 'responded' : norm.outcome, norm.message);
    }
  }

  function requireCenter() {
    if (centerState !== 'ready') throw brokerError('NOT_CONNECTED', 'not-sent', 'center is disconnected');
  }

  // Device-token-first center reads/writes on fixed paths built from validated ids,
  // with fallback to ownerRequest for older center servers or test mocks.
  async function runCenterAction(action) {
    const client = centerClient;
    try {
      return await action(client);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(
        norm.code,
        norm.code === 'REQUEST_CONFLICT' || norm.code === 'CONTROL_UNAUTHORIZED' || norm.code === 'BAD_RESPONSE' ? 'responded' : norm.outcome,
        norm.message,
      );
    }
  }

  function pathId(value, name) {
    try {
      assertId(value, name);
    } catch (err) {
      throw invalid(err.message);
    }
    if (value === '.' || value === '..') throw invalid(`invalid ${name}`);
    return value;
  }

  const capabilityPath = (targetDeviceId, botId) =>
    '/api/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/capabilities';

  async function opCenterBotCapabilitiesGet(params, reqSignal) {
    rejectUnknownFields(params, new Set(['deviceId', 'botId']), 'center_bot_capabilities_get params');
    const deviceId = pathId(params.deviceId, 'deviceId');
    const botId = pathId(params.botId, 'botId');
    return runCenterAction((client) =>
      typeof client.botCapabilitiesGet === 'function'
        ? client.botCapabilitiesGet(deviceId, botId, reqSignal)
        : client.ownerRequest(capabilityPath(deviceId, botId), { signal: reqSignal }),
    );
  }

  async function opCenterBotCapabilitySet(params, reqSignal) {
    rejectUnknownFields(
      params,
      new Set(['deviceId', 'botId', 'installationId', 'expectedRevision', 'enabled', 'overrides']),
      'center_bot_capability_set params',
    );
    const deviceId = pathId(params.deviceId, 'deviceId');
    const botId = pathId(params.botId, 'botId');
    const installationId = pathId(params.installationId, 'installationId');
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
      throw invalid('expectedRevision must be a non-negative safe integer');
    }
    if (typeof params.enabled !== 'boolean') throw invalid('enabled must be a boolean');
    if (!isPlainObject(params.overrides)) throw invalid('overrides must be a plain object');
    let text;
    const payload = { expectedRevision: params.expectedRevision, enabled: params.enabled, overrides: params.overrides };
    try {
      text = JSON.stringify(payload);
    } catch {
      throw invalid('overrides must be serializable JSON');
    }
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw invalid('capability write must be at most 64 KiB');
    return runCenterAction((client) =>
      typeof client.botCapabilitySet === 'function'
        ? client.botCapabilitySet(deviceId, botId, installationId, payload, reqSignal)
        : client.ownerRequest(capabilityPath(deviceId, botId) + '/' + encodeURIComponent(installationId), {
          method: 'PUT', body: payload, signal: reqSignal,
        }),
    );
  }

  async function opCenterBotCwd(params, reqSignal, write) {
    requireCenter();
    rejectUnknownFields(params, new Set(write ? ['deviceId', 'botId', 'expectedRevision', 'value'] : ['deviceId', 'botId']), 'center bot cwd params');
    const deviceId = pathId(params.deviceId, 'deviceId');
    const botId = pathId(params.botId, 'botId');
    if (write) {
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) throw invalid('invalid expectedRevision');
      if (typeof params.value !== 'string' || params.value.length === 0 || params.value.length > 1024 ||
          params.value.trim() !== params.value || /[\x00-\x1f]/.test(params.value) ||
          !(params.value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(params.value) || /^\\\\[^\\/]+[\\/]+[^\\/]+/.test(params.value))) {
        throw invalid('cwd must be a non-empty absolute path on the target Host');
      }
    }
    return runCenterAction(client => write
      ? client.botCwdSet(deviceId, botId, { expectedRevision: params.expectedRevision, value: params.value }, reqSignal)
      : client.botCwdGet(deviceId, botId, reqSignal));
  }

  async function avatarOperation(params, reqSignal, write) {
    requireCenter();
    rejectUnknownFields(params, new Set(write ? ['deviceId', 'botId', 'expectedRevision', 'value'] : ['deviceId', 'botId']), 'bot avatar params');
    const deviceId = pathId(params.deviceId, 'deviceId');
    const botId = pathId(params.botId, 'botId');
    if (write) {
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) throw invalid('invalid expectedRevision');
      if (params.value !== null && !isPlainObject(params.value)) throw invalid('invalid avatar');
    }
    return runCenterAction(client => write
      ? client.botAvatarSet(deviceId, botId, { expectedRevision: params.expectedRevision, value: params.value }, reqSignal)
      : client.botAvatarGet(deviceId, botId, reqSignal));
  }

  async function opCenterRuntimeStatus(params, reqSignal) {
    rejectUnknownFields(params, new Set(['deviceId']), 'center_runtime_status params');
    const deviceId = pathId(params.deviceId, 'deviceId');
    return runCenterAction((client) =>
      typeof client.runtimeStatus === 'function'
        ? client.runtimeStatus(deviceId, reqSignal)
        : client.ownerRequest('/api/devices/' + encodeURIComponent(deviceId) + '/runtime-status', { signal: reqSignal }),
    );
  }

  function dropTransportForCenter() {
    cancelCenterProbe();
    centerRelayConnection = null;
    generation += 1;
    phase = 'disconnected';
    redactedConn = null;
    abortAllObservations();
    if (activeSession) {
      closeTransportSession(activeSession);
      activeSession = null;
    }
  }

  // Synchronous connect/disconnect switch guard: overlapping lifecycle switches
  // fail fast with RPC_BUSY instead of interleaving session teardown.
  let switching = false;

  // Pending profile management
  let currentProfileKey = null;
  let pendingCenterKey = null;
  let pendingClient = null;
  let pendingSwitchChain = Promise.resolve();

  // Bounded in-flight requests and observations
  const inflightRequests = new Map(); // internalId -> { controller, promise }
  let nextInternalRequestId = 1;
  const observations = new Map(); // observationId -> { id, controller, generation, promise, settled }

  function buildStatusSnapshot() {
    return {
      clientId,
      phase,
      connection: redactedConn ? { ...redactedConn } : null,
      generation,
      lastObservedAt,
      errorCode,
    };
  }

  function markObserved(gen) {
    if (gen === generation) {
      lastObservedAt = new Date().toISOString();
    }
  }

  function abortAllObservations() {
    for (const obs of observations.values()) {
      obs.controller.abort();
    }
  }

  async function joinObservations() {
    await Promise.allSettled([...observations.values()].map((obs) => obs.promise));
  }

  async function cancelAndJoinInflight(excludeRec, preserveCenterOps = false) {
    const pending = [];
    for (const rec of inflightRequests.values()) {
      if (rec !== excludeRec && !(preserveCenterOps && (CENTER_LIFECYCLE_OPS.has(rec.op) || LOCAL_OFFLINE_OPS.has(rec.op)))) {
        rec.controller.abort();
        pending.push(rec.promise);
      }
    }
    await Promise.allSettled(pending);
  }

  function closeTransportSession(session) {
    if (!session) return;
    if (session.connectController) {
      session.connectController.abort();
    }
    if (session.remote) {
      try {
        session.remote.close();
      } catch {
        /* best effort */
      }
      session.remote = null;
    }
    session.adapter = null;
  }

  // Injected transport for PendingClient: routes through the active session
  // when connected; fails fast with {code:'NOT_CONNECTED', outcome:'not-sent'}
  // when disconnected/connecting/failed so offline enqueue/get/list remain usable
  // and accidental offline send never mutates or hangs.
  async function pendingTransportCall(targetDeviceId, method, params, callOpts = {}) {
    requireCenter();
    if (closed || phase !== 'connected' || !activeSession) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is not connected');
    }
    await requireTargetReady(targetDeviceId, callOpts.signal);
    requireCenter();
    const session = activeSession;
    const sessionGen = session.generation;
    const timeout = withCallTimeout(callOpts.signal, controlBrokerTimeoutMs(method));
    try {
      let res;
      if (session.kind === 'local') {
        res = await session.adapter(targetDeviceId, method, params, { signal: timeout.signal });
      } else {
        res = await session.remote.call(targetDeviceId, method, params, { signal: timeout.signal });
      }
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(callOpts.signal && callOpts.signal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'control call timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      if (sessionGen === generation && session.kind === 'local' && (norm.code === 'DISCONNECTED' || norm.code === 'REPLACED' || norm.code === 'REVOKED' || norm.code === 'BAD_FRAME')) {
        phase = 'failed';
        errorCode = norm.code;
      }
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function ensurePendingProfile(profileKey, centerKey = selectedCenterKey, myGeneration = centerGeneration) {
    const run = pendingSwitchChain.then(async () => {
      const checkCurrent = () => {
        if (closed || myGeneration !== centerGeneration || !centerKey || centerKey !== selectedCenterKey) {
          throw brokerError('CANCELLED', 'not-sent', 'pending profile selection superseded');
        }
      };
      checkCurrent();
      if (currentProfileKey === profileKey && pendingClient) {
        pendingCenterKey = centerKey;
        return pendingClient;
      }
      if (pendingClient) {
        const old = pendingClient;
        pendingClient = null;
        currentProfileKey = null;
        pendingCenterKey = null;
        await old.close();
      }
      checkCurrent();
      const profileDir = path.join(resolvedDataRoot, 'pending', profileKey);
      pendingClient = openPendingClient({
        dataRoot: profileDir,
        deviceId: clientId,
        call: pendingTransportCall,
      });
      currentProfileKey = profileKey;
      pendingCenterKey = centerKey;
      return pendingClient;
    });
    pendingSwitchChain = run.catch(() => {});
    return run;
  }

  function requirePendingClient() {
    if (!pendingClient || !selectedCenterKey || pendingCenterKey !== selectedCenterKey) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'no connection profile has been configured for pending operations');
    }
    return pendingClient;
  }

  function requireConnectedSession() {
    if (phase !== 'connected' || !activeSession) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is not connected');
    }
    return activeSession;
  }

  function requireLocalSession(targetDeviceId) {
    try {
      assertId(targetDeviceId, 'targetDeviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    const session = requireConnectedSession();
    if (session.kind !== 'local' || !session.adapter) {
      throw invalid('operation is supported only on a local Host connection');
    }
    return session;
  }

  // ---- Operations ----

  async function opConnect(params, reqSignal, rec, centerManaged = false) {
    if (switching) {
      throw brokerError('RPC_BUSY', 'not-sent', 'another connect/disconnect is already in progress');
    }
    switching = true;
    try {
      rejectUnknownFields(params, new Set(['connection']), 'connect params');
      let rawConnection = params.connection;
      if (isPlainObject(rawConnection) && (rawConnection.token === '' || rawConnection.token === undefined)) {
        if (persistCenterCredentials) {
          const saved = readSavedCenterCredentials();
          if (saved?.deviceToken) rawConnection = { ...rawConnection, token: saved.deviceToken };
        } else if (
          rawConnection.kind === 'relay' && centerState === 'ready' && centerClient && centerCredentials &&
          phase === 'connected' && activeSession?.kind === 'relay' && activeSession.remote &&
          centerRelayConnection && redactedConn?.kind === 'relay' &&
          rawConnection.url === centerRelayConnection.url && rawConnection.url === redactedConn.url &&
          rawConnection.deviceId === centerRelayConnection.deviceId && rawConnection.deviceId === redactedConn.deviceId &&
          (rawConnection.ca === undefined ? '' : rawConnection.ca) === centerRelayConnection.ca
        ) {
          rawConnection = { ...rawConnection, token: centerCredentials.deviceToken };
        }
      }
      const conn = normalizeConnectionInput(rawConnection);
      const profileKey = derivePendingProfileKey(conn);
      cancelCenterProbe();

      // Update phase after validation but before the first await so concurrent
      // requests never target the old session during the drain.
      phase = 'connecting';
      redactedConn = redactConnection(conn, null);
      errorCode = null;

      generation += 1;
      const myGen = generation;
      // Issue every abort before joining; then re-check close/supersede before
      // publishing the new session so a concurrent close cannot be overwritten.
      abortAllObservations();
      await cancelAndJoinInflight(rec, centerManaged);
      await joinObservations();
      if (closed || (reqSignal && reqSignal.aborted) || myGen !== generation) {
        throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
      }
      if (activeSession) {
        closeTransportSession(activeSession);
        activeSession = null;
      }

      const connectController = new AbortController();
      const onReqAbort = () => connectController.abort();
      if (reqSignal) {
        if (reqSignal.aborted) connectController.abort();
        else reqSignal.addEventListener('abort', onReqAbort, { once: true });
      }

      const session = {
        generation: myGen,
        kind: conn.kind,
        adapter: null,
        remote: null,
        localDeviceId: null,
        connectController,
      };
      activeSession = session;

      try {
        await ensurePendingProfile(profileKey);
        if (myGen !== generation || connectController.signal.aborted || closed) {
          throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
        }

        if (conn.kind === 'local') {
          const adapter = createLocalControlAdapter({ url: conn.url, token: conn.token });
          const timeout = withCallTimeout(connectController.signal, DESKTOP_CALL_TIMEOUT_MS);
          let info;
          try {
            info = await adapter.getHostInfo({ signal: timeout.signal });
          } catch (err) {
            if (timeout.wasTimedOut() && !connectController.signal.aborted) {
              throw brokerError('TIMEOUT', 'not-sent', 'local host discovery timed out');
            }
            throw err;
          } finally {
            timeout.cleanup();
          }
          if (myGen !== generation || connectController.signal.aborted || closed) {
            throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
          }
          if (conn.expectedDeviceId !== undefined && info.deviceId !== conn.expectedDeviceId) {
            throw brokerError('CONTROL_IDENTITY_MISMATCH', 'not-sent', 'local host deviceId does not match expectedDeviceId');
          }
          session.adapter = adapter;
          session.localDeviceId = info.deviceId;
          session.connectController = null;
          phase = 'connected';
          redactedConn = redactConnection(conn, info.deviceId);
          lastObservedAt = new Date().toISOString();
          errorCode = null;
          return buildStatusSnapshot();
        }

        // Relay connection
        const timeout = withCallTimeout(connectController.signal, DESKTOP_CALL_TIMEOUT_MS);
        const sessionCenterGeneration = centerGeneration;
        let remote;
        try {
          remote = await openRemoteControl({
            deviceId: conn.deviceId,
            url: conn.url,
            token: conn.token,
            ...(conn.ca !== undefined ? { ca: conn.ca } : {}),
            signal: timeout.signal,
            onClose: (err) => {
              if (activeSession !== session || myGen !== generation || closed) return;
              const error = normalizeDesktopError(err, 'unconfirmed');
              session.terminalError = error;
              phase = 'failed';
              errorCode = error.code;
              for (const record of observations.values()) {
                if (record.connection && record.generation === myGen) {
                  record.settled = true;
                  void Promise.resolve(emitEvent({ type: 'event', observationId: record.id, error })).catch(() => {});
                  record.controller.abort();
                }
              }
              if (centerManaged && sessionCenterGeneration === centerGeneration) {
                if (centerAttempt) centerAttempt.failure = err;
                failCenter(err, sessionCenterGeneration);
              }
            },
          });
        } catch (err) {
          if (timeout.wasTimedOut() && !connectController.signal.aborted) {
            throw brokerError('TIMEOUT', 'not-sent', 'relay connect timed out');
          }
          throw err;
        } finally {
          timeout.cleanup();
        }

        if (myGen !== generation || connectController.signal.aborted || closed) {
          try { remote.close(); } catch { /* ignore */ }
          throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
        }

        if (session.terminalError) {
          remote.close();
          throw brokerError(session.terminalError.code, session.terminalError.outcome, session.terminalError.message);
        }
        session.remote = remote;
        session.connectController = null;
        phase = 'connected';
        redactedConn = redactConnection(conn, null);
        lastObservedAt = new Date().toISOString();
        errorCode = null;
        return buildStatusSnapshot();
      } catch (err) {
        const norm = normalizeDesktopError(err, 'not-sent');
        if (myGen === generation) {
          closeTransportSession(session);
          activeSession = null;
          phase = 'failed';
          errorCode = norm.code;
        }
        throw brokerError(norm.code, norm.outcome, norm.message);
      } finally {
        if (reqSignal) reqSignal.removeEventListener('abort', onReqAbort);
      }
    } finally {
      switching = false;
    }
  }

  async function opDisconnect(params) {
    rejectUnknownFields(params, new Set(), 'disconnect params');
    cancelCenterRetry();
    centerGeneration += 1;
    centerCredentials = null;
    centerState = 'disconnected';
    centerError = null;
    errorCode = null;
    const oldObservations = [...observations.values()].map((obs) => obs.promise);
    endConnectionObservations({ code: 'CANCELLED', message: 'center disconnected', outcome: 'unconfirmed' });
    dropTransportForCenter();
    abortCenterRequests();
    const previous = centerClient;
    centerClient = null;
    if (previous) await previous.close();
    await Promise.allSettled(oldObservations);
    return buildStatusSnapshot();
  }

  async function opStatus(params) {
    rejectUnknownFields(params, new Set(), 'status params');
    return buildStatusSnapshot();
  }

  async function opDevices(params, reqSignal) {
    rejectUnknownFields(params, new Set(['limit', 'cursor']), 'devices params');
    let limit = 20;
    if (params.limit !== undefined) {
      if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) {
        throw invalid('limit must be a positive integer between 1 and 200');
      }
      limit = params.limit;
    }
    let cursor = null;
    if (params.cursor !== undefined && params.cursor !== null) {
      if (!isPlainObject(params.cursor) || Object.keys(params.cursor).length !== 1 || !('afterDeviceId' in params.cursor)) {
        throw invalid('cursor must be {afterDeviceId} or null');
      }
      try {
        assertId(params.cursor.afterDeviceId, 'cursor.afterDeviceId');
      } catch (err) {
        throw invalid(err.message);
      }
      cursor = { afterDeviceId: params.cursor.afterDeviceId };
    }

    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      if (session.kind === 'local') {
        const info = await session.adapter.getHostInfo({ signal: timeout.signal });
        if (session.localDeviceId && info.deviceId !== session.localDeviceId) {
          throw brokerError('CONTROL_IDENTITY_MISMATCH', 'not-sent', 'local host deviceId changed');
        }
        session.localDeviceId = info.deviceId;
        if (redactedConn && redactedConn.kind === 'local') {
          redactedConn.deviceId = info.deviceId;
        }
        markObserved(sessionGen);
        const row = {
          deviceId: info.deviceId,
          displayName: info.displayName || info.deviceId,
          ...(info.platform ? { platform: info.platform } : {}),
          online: true,
          controlProtocol: 2,
          scopeProtocol: 1,
        };
        const include =
          cursor === null ||
          Buffer.compare(Buffer.from(info.deviceId, 'utf8'), Buffer.from(cursor.afterDeviceId, 'utf8')) > 0;
        return {
          items: include ? [row] : [],
          nextCursor: null,
        };
      }

      const page = await session.remote.listDevices({
        limit,
        ...(cursor !== null ? { cursor } : {}),
        signal: timeout.signal,
      });
      markObserved(sessionGen);
      return page;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'devices query timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      if (sessionGen === generation && session.kind === 'local' && (norm.code === 'DISCONNECTED' || norm.code === 'REPLACED' || norm.code === 'REVOKED' || norm.code === 'BAD_FRAME')) {
        phase = 'failed';
        errorCode = norm.code;
      }
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opBotDirectory(params, reqSignal) {
    rejectUnknownFields(params, new Set(), 'bot_directory params');
    const [directory, central] = await Promise.all([
      collectBotDirectory({
        listDevices: (options) => opDevices(options, reqSignal),
        listBots: (deviceId) => opCall({ targetDeviceId: deviceId, method: 'listBots', params: {} }, reqSignal),
      }),
      centerState === 'ready' ? centerClient.getBotSync({}, reqSignal) : null,
    ]);
    if (!central) return directory;
    const known = new Map(central.bots.map(bot => [JSON.stringify([bot.deviceId, bot.botId]), bot]));
    directory.bots = directory.bots.map(bot => {
      const shared = known.get(JSON.stringify([bot.deviceId, bot.botId]));
      // 中心权威字段覆盖 Host 本地报告：avatar 与 cwd 都以中心为准。
      return shared ? {
        ...bot,
        avatar: shared.avatar ?? null, avatarRevision: shared.avatarRevision ?? 0,
        ...(shared.cwd !== undefined ? { cwd: shared.cwd } : {}),
        cwdRevision: shared.cwdRevision ?? 0,
      } : bot;
    });
    const unavailable = new Set(directory.devices.filter(device => !device.online).map(device => device.deviceId));
    for (const err of directory.errors) unavailable.add(err.deviceId);
    for (const bot of central.bots) {
      if (!unavailable.has(bot.deviceId)) continue;
      directory.bots.push({
        ...bot, role: bot.name, description: bot.description ?? '', cwd: bot.cwd ?? '',
        modelRef: bot.modelRef ?? null, primaryConversationId: bot.primaryConversationId ?? '',
        createdAt: bot.createdAt ?? '', isPrimary: Boolean(bot.isPrimary),
        lastActivityAt: bot.lastActivityAt ?? null, lastPreview: bot.lastPreview ?? null,
        archivedAt: bot.archivedAt ?? null, deviceName: bot.deviceName || bot.deviceId, online: false,
        avatar: bot.avatar ?? null, avatarRevision: bot.avatarRevision ?? 0,
        cwdRevision: bot.cwdRevision ?? 0,
      });
    }
    return directory;
  }

  async function opBotSync(params, reqSignal) {
    rejectUnknownFields(params, new Set(['epoch', 'sinceSeq']), 'bot_sync params');
    requireCenter();
    const client = centerClient;
    if (!client || typeof client.getBotSync !== 'function') {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'center is disconnected');
    }
    return client.getBotSync(
      {
        epoch: typeof params.epoch === 'string' ? params.epoch : undefined,
        sinceSeq: Number.isSafeInteger(params.sinceSeq) ? params.sinceSeq : undefined,
      },
      reqSignal,
    );
  }

  async function opRenameDevice(params, reqSignal) {
    rejectUnknownFields(params, new Set(['deviceId', 'displayName']), 'rename_device params');
    const session = requireConnectedSession();
    if (session.kind !== 'relay') throw invalid('central device rename requires a relay connection');
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const result = await session.remote.renameDevice(
        { deviceId: params.deviceId, displayName: params.displayName }, { signal: timeout.signal },
      );
      markObserved(session.generation);
      return result;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'device rename timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  function isLocalVaultCall(op, params) {
    return op === 'call' && params.method === 'vaultControl' && phase === 'connected' &&
      activeSession?.kind === 'local' && typeof activeSession.adapter === 'function';
  }

  async function opCall(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId', 'method', 'params']), 'call params');
    try {
      assertId(params.targetDeviceId, 'targetDeviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    let normalized;
    try {
      normalized = normalizeControlCall(params.method, params.params);
    } catch (err) {
      const code = err && err.code === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_ARGUMENT';
      throw brokerError(code, 'not-sent', err.message);
    }
    if (!isLocalVaultCall('call', params)) {
      await requireTargetReady(params.targetDeviceId, reqSignal);
      requireCenter();
    }
    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, controlBrokerTimeoutMs(normalized.method));
    try {
      let res;
      if (session.kind === 'local') {
        res = await session.adapter(params.targetDeviceId, normalized.method, normalized.params, { signal: timeout.signal });
      } else {
        res = await session.remote.call(params.targetDeviceId, normalized.method, normalized.params, { signal: timeout.signal });
      }
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'control call timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      if (sessionGen === generation && session.kind === 'local' && (norm.code === 'DISCONNECTED' || norm.code === 'REPLACED' || norm.code === 'REVOKED' || norm.code === 'BAD_FRAME')) {
        phase = 'failed';
        errorCode = norm.code;
      }
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opSettingsGet(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId']), 'settings_get params');
    const session = requireLocalSession(params.targetDeviceId);
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const res = await session.adapter.getSettings(params.targetDeviceId, { signal: timeout.signal });
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'settings_get timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opSettingsSet(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId', 'input']), 'settings_set params');
    const session = requireLocalSession(params.targetDeviceId);
    if (!isPlainObject(params.input)) {
      throw invalid('settings_set input must be a plain object');
    }
    rejectUnknownFields(params.input, new Set(['expectedRevision', 'settings']), 'settings_set input');
    try {
      assertRevision(params.input.expectedRevision, 'expectedRevision');
      normalizeHostSettings(params.input.settings);
    } catch (err) {
      throw invalid(err.message);
    }
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const res = await session.adapter.setSettings(
        params.targetDeviceId,
        { expectedRevision: params.input.expectedRevision, settings: params.input.settings },
        { signal: timeout.signal },
      );
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'settings_set timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opServiceStatus(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId']), 'service_status params');
    try { assertId(params.targetDeviceId, 'targetDeviceId'); } catch (err) { throw invalid(err.message); }
    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const res = session.kind === 'local'
        ? await session.adapter.getServiceStatus(params.targetDeviceId, { signal: timeout.signal })
        : await session.remote.call(params.targetDeviceId, 'getServiceStatus', {}, { signal: timeout.signal });
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'service_status timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function requireTargetReady(targetDeviceId, signal) {
    const status = await opServiceStatus({ targetDeviceId }, signal);
    let matches = false;
    try {
      matches = status?.center?.state === 'ready' && new URL(status.center.centerUrl).origin === new URL(centerUrl).origin;
    } catch { /* A malformed remote status cannot establish readiness. */ }
    if (!matches) throw brokerError('NOT_CONNECTED', 'not-sent', 'target Host is not connected to this center');
  }

  async function opPendingEnqueue(params) {
    rejectUnknownFields(params, new Set(['input']), 'pending_enqueue params');
    const pending = requirePendingClient();
    try {
      return await pending.enqueue(params.input);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingGet(params) {
    rejectUnknownFields(params, new Set(['id']), 'pending_get params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.get(params.id);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingList(params) {
    rejectUnknownFields(params, new Set(['options']), 'pending_list params');
    const pending = requirePendingClient();
    try {
      return await pending.list(params.options === undefined ? {} : params.options);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingSend(params, reqSignal) {
    rejectUnknownFields(params, new Set(['id']), 'pending_send params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.send(params.id, { signal: reqSignal });
    } catch (err) {
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingReconcile(params, reqSignal) {
    rejectUnknownFields(params, new Set(['id']), 'pending_reconcile params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.reconcile(params.id, { signal: reqSignal });
    } catch (err) {
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingCancel(params) {
    rejectUnknownFields(params, new Set(['id']), 'pending_cancel params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.cancel(params.id);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opUiGet(params) {
    rejectUnknownFields(params, new Set(), 'ui_get params');
    try {
      return uiStore.get();
    } catch (err) {
      const norm = normalizeDesktopError(err, 'responded');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opUiSet(params) {
    rejectUnknownFields(params, new Set(['expectedRevision', 'state']), 'ui_set params');
    try {
      return uiStore.replace(params);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'responded');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opObserve(params) {
    rejectUnknownFields(params, new Set(['observationId', 'targetDeviceId', 'target']), 'observe params');
    try {
      assertUuid(params.observationId, 'observationId');
      assertId(params.targetDeviceId, 'targetDeviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    const connection = isPlainObject(params.target) && params.target.kind === 'connection';
    let normTarget;
    if (connection) {
      rejectUnknownFields(params.target, new Set(['kind']), 'connection observation target');
    } else {
      try {
        normTarget = normalizeLiveTarget(params.target);
      } catch (err) {
        throw invalid(err.message);
      }
    }
    if (observations.has(params.observationId)) {
      throw invalid(`observationId already active: ${params.observationId}`);
    }
    if (connection) {
      for (const obs of observations.values()) {
        if (obs.connection) {
          obs.settled = true;
          obs.controller.abort();
          observations.delete(obs.id);
        }
      }
    } else if ([...observations.values()].filter((obs) => !obs.connection).length >= DESKTOP_MAX_OBSERVATIONS) {
      throw brokerError('RPC_BUSY', 'not-sent', 'maximum concurrent observations reached');
    }

    if (!connection) await requireTargetReady(params.targetDeviceId);
    requireCenter();
    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const controller = new AbortController();
    const observationId = params.observationId;

    // Install observation record before starting the live stream so routing is
    // ready before any synchronous or immediate snapshot arrives.
    const record = {
      id: observationId,
      controller,
      generation: sessionGen,
      promise: null,
      settled: false,
    };
    observations.set(observationId, record);
    if (connection) {
      record.connection = true;
      record.promise = new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => {
          if (observations.get(observationId) === record) observations.delete(observationId);
          resolve();
        }, { once: true });
      });
      return { observationId };
    }

    let iterable;
    try {
      if (session.kind === 'local') {
        iterable = session.adapter.live(params.targetDeviceId, normTarget, { signal: controller.signal });
      } else {
        iterable = session.remote.live(params.targetDeviceId, normTarget, { signal: controller.signal });
      }
    } catch (err) {
      observations.delete(observationId);
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }

    record.promise = (async () => {
      const iter = iterable[Symbol.asyncIterator]();
      try {
        for (;;) {
          const { value: frame, done } = await iter.next();
          if (done) break;
          if (record.settled || closed || sessionGen !== generation) break;
          markObserved(sessionGen);
          if (frame && frame.type === 'end') {
            record.settled = true;
            await emitEvent({ type: 'event', observationId, frame });
            return;
          }
          await emitEvent({ type: 'event', observationId, frame });
        }
        if (!record.settled && !closed) {
          record.settled = true;
          const error = controller.signal.aborted
            ? { code: 'CANCELLED', message: 'observation cancelled', outcome: 'unconfirmed' }
            : { code: 'BAD_RESPONSE', message: 'live stream ended without an end frame', outcome: 'unconfirmed' };
          await emitEvent({ type: 'event', observationId, error });
        }
      } catch (err) {
        if (!record.settled && !closed) {
          record.settled = true;
          let error;
          if (controller.signal.aborted || (err && err.name === 'AbortError')) {
            error = { code: 'CANCELLED', message: 'observation cancelled', outcome: 'unconfirmed' };
          } else {
            error = normalizeDesktopError(err, 'unconfirmed');
          }
          // Relay transport failures are handled by onClose; a target may fail independently.
          if (sessionGen === generation && session.kind === 'local' && (error.code === 'DISCONNECTED' || error.code === 'REPLACED' || error.code === 'REVOKED' || error.code === 'BAD_FRAME')) {
            phase = 'failed';
            errorCode = error.code;
          }
          await emitEvent({ type: 'event', observationId, error });
        }
      } finally {
        if (observations.get(observationId) === record) observations.delete(observationId);
        try {
          await iter.return?.();
        } catch {
          /* best effort */
        }
      }
    })();
    record.promise.catch(() => {});

    return { observationId };
  }

  async function opUnobserve(params) {
    rejectUnknownFields(params, new Set(['observationId']), 'unobserve params');
    try {
      assertUuid(params.observationId, 'observationId');
    } catch (err) {
      throw invalid(err.message);
    }
    const obs = observations.get(params.observationId);
    if (obs) {
      obs.controller.abort();
    }
    return { observationId: params.observationId };
  }

  const OP_HANDLERS = new Map([
    ['center_connect', opCenterConnect],
    ['center_status', opCenterStatus],
    ['center_disconnect', opCenterDisconnect],
    ['center_store', opCenterStore],
    ['center_owner_session', (params, signal) => ownerOperation(params, signal, 'session')],
    ['center_owner_login', (params, signal) => ownerOperation(params, signal, 'login')],
    ['center_bot_model_get', (params, signal) => ownerOperation(params, signal, 'get')],
    ['center_bot_model_set', (params, signal) => ownerOperation(params, signal, 'set')],
    ['center_bot_avatar_get', (params, signal) => avatarOperation(params, signal, false)],
    ['center_bot_avatar_set', (params, signal) => avatarOperation(params, signal, true)],
    ['center_bot_cwd_get', (params, signal) => opCenterBotCwd(params, signal, false)],
    ['center_bot_cwd_set', (params, signal) => opCenterBotCwd(params, signal, true)],
    ['center_bot_capabilities_get', opCenterBotCapabilitiesGet],
    ['center_bot_capability_set', opCenterBotCapabilitySet],
    ['center_runtime_status', opCenterRuntimeStatus],
    ['connect', opConnect],
    ['disconnect', opDisconnect],
    ['status', opStatus],
    ['devices', opDevices],
    ['bot_directory', opBotDirectory],
    ['bot_sync', opBotSync],
    ['rename_device', opRenameDevice],
    ['call', opCall],
    ['settings_get', opSettingsGet],
    ['settings_set', opSettingsSet],
    ['service_status', opServiceStatus],
    ['pending_enqueue', opPendingEnqueue],
    ['pending_get', opPendingGet],
    ['pending_list', opPendingList],
    ['pending_send', opPendingSend],
    ['pending_reconcile', opPendingReconcile],
    ['pending_cancel', opPendingCancel],
    ['ui_get', opUiGet],
    ['ui_set', opUiSet],
    ['observe', opObserve],
    ['unobserve', opUnobserve],
  ]);

  async function request(op, params = {}) {
    if (closed) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is closed');
    }
    if (typeof op !== 'string' || !OP_HANDLERS.has(op)) {
      throw invalid(`unknown desktop client operation: ${String(op)}`);
    }
    if (params === undefined) params = {};
    if (!isPlainObject(params)) {
      throw invalid(`${op} params must be a plain object`);
    }
    if (!CENTER_LIFECYCLE_OPS.has(op) && !LOCAL_OFFLINE_OPS.has(op) && !isLocalVaultCall(op, params)) requireCenter();
    if (op === 'settings_set') throw brokerError('NOT_CONNECTED', 'not-sent', 'settings are managed by the center');
    // unobserve only aborts a local subscription synchronously (no network, no wait): it must
    // never queue behind the 8 in-flight RPCs or a connect/disconnect switch (a switch already
    // aborts every client observation before its first await), or a cancelled client
    // observation would leak its broker slot. It cannot accumulate: opUnobserve returns at once.
    const localCancel = op === 'unobserve';
    if (
      !localCancel && switching && !CENTER_LIFECYCLE_OPS.has(op) && !LOCAL_OFFLINE_OPS.has(op) &&
      op !== 'connect'
    ) {
      throw brokerError('RPC_BUSY', 'not-sent', 'desktop client is switching connections');
    }
    if (!localCancel && inflightRequests.size >= DESKTOP_MAX_IN_FLIGHT_REQUESTS) {
      throw brokerError('RPC_BUSY', 'not-sent', 'desktop client request capacity reached');
    }

    const handler = OP_HANDLERS.get(op);
    const internalId = nextInternalRequestId++;
    const controller = new AbortController();
    const rec = { controller, promise: null, op };
    inflightRequests.set(internalId, rec);

    rec.promise = (async () => {
      try {
        return await handler(params, controller.signal, rec);
      } finally {
        inflightRequests.delete(internalId);
      }
    })();

    return rec.promise;
  }

  function close() {
    if (!closePromise) {
      closePromise = (async () => {
        closed = true;
        cancelCenterProbe();
        cancelCenterRetry();
        centerRelayConnection = null;
        centerGeneration += 1;
        centerCredentials = null;
        centerState = 'disconnected';
        const previousCenter = centerClient;
        centerClient = null;
        generation += 1;
        // Abort all in-flight broker requests and observations
        for (const rec of inflightRequests.values()) {
          rec.controller.abort();
        }
        abortAllObservations();
        if (activeSession) {
          closeTransportSession(activeSession);
          activeSession = null;
        }
        phase = 'disconnected';

        if (previousCenter) await previousCenter.close();
        await centerAttemptChain;
        await Promise.allSettled([...inflightRequests.values()].map((r) => r.promise));
        await Promise.allSettled([...observations.values()].map((r) => r.promise));

        // Wait for any in-flight pending profile switch, then close pendingClient
        try {
          await pendingSwitchChain;
        } catch {
          /* ignore */
        }
        if (pendingClient) {
          const p = pendingClient;
          pendingClient = null;
          currentProfileKey = null;
          pendingCenterKey = null;
          try {
            await p.close();
          } catch {
            /* best effort */
          }
        }
        try {
          uiStore.close();
        } catch {
          /* best effort */
        }
      })();
    }
    return closePromise;
  }

  const savedCenter = readSavedCenterCredentials();
  if (savedCenter) void opCenterConnect(savedCenter).catch(() => {});

  return {
    request,
    close,
  };
}
