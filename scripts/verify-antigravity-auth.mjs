#!/usr/bin/env node
// scripts/verify-antigravity-auth.mjs — Center Web-Auth broker E2E check for Antigravity (`agy`).
// Scope: verifies existing Center HTTP auth endpoints using real `openCenterServer` and real `agy`:
//   1. `GET /api/providers/antigravity/auth-status` detects existing CLI login cache (precondition).
//   2. `POST /api/providers/antigravity/login` + polling exposes official Google `auth_url` and `manual_code` prompt.
//   3. `POST /api/providers/antigravity/login/:flowId/answer` rejects empty & oversized inputs at boundary.
//   4. Single invalid authorization code drives the flow to `failed` with a safe non-leaking error.
//   5. Cancelling an active login flow drives it to `cancelled` and exits cleanly.
//   6. Existing login cache & catalog remain healthy afterward (`/auth-status`, `/validate`, `/discover`).
// Automated interactive Google browser consent with a real valid code is NOT performed.
//
// Usage:
//   node scripts/verify-antigravity-auth.mjs
//   PIBOT_AGY_HOME=/path/to/isolated-gemini PIBOT_AGY_BIN=/usr/local/bin/agy node scripts/verify-antigravity-auth.mjs

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCenterServer } from '../center-server/server.js';
import { hashOwnerPassword } from '../center-server/config.js';

const PROVIDER_ID = 'antigravity';
const FIXED_INVALID_CODE = 'PIBOT_VERIFY_INVALID_OAUTH_CODE_0000';
const POLL_INTERVAL_MS = 250;

function parseTimeoutMs() {
  const raw = process.env.PIBOT_AGY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return 120_000;
  const parsed = Number(raw);
  assert.ok(Number.isInteger(parsed) && parsed > 0, 'PIBOT_AGY_TIMEOUT_MS must be a positive integer');
  return parsed;
}

function assertNotDailyGeminiHome(geminiHome) {
  const dailyGemini = path.resolve(os.homedir(), '.gemini');
  const candidate = existsSync(geminiHome) ? realpathSync(geminiHome) : path.resolve(geminiHome);
  const dailyResolved = existsSync(dailyGemini) ? realpathSync(dailyGemini) : dailyGemini;
  assert.notEqual(
    candidate,
    dailyResolved,
    'Refusing to use daily ~/.gemini profile; omit PIBOT_AGY_HOME or pass an isolated directory',
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactAuthUrlForLog(rawUrl) {
  const parsed = new URL(rawUrl);
  assert.equal(parsed.protocol, 'https:', 'Google auth_url must use https');
  assert.ok(
    parsed.hostname === 'accounts.google.com' || parsed.hostname.endsWith('.google.com'),
    `unexpected auth_url host: ${parsed.hostname}`,
  );
  return `${parsed.origin}${parsed.pathname}`;
}

function createOwnerHttpClient(baseUrl, timeoutMs) {
  const cookies = new Map();
  let csrfToken = '';

  const absorbCookies = (headers) => {
    const rawList = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of rawList) {
      const pair = String(raw).split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies.set(pair.slice(0, eq).trim(), pair.trim());
      }
    }
  };

  const cookieHeader = () => Array.from(cookies.values()).join('; ');

  async function requestRaw(method, pathname, body) {
    const headers = {};
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD') {
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    absorbCookies(res.headers);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok && json && typeof json.csrfToken === 'string' && json.csrfToken) {
      csrfToken = json.csrfToken;
    }
    return { status: res.status, ok: res.ok, json };
  }

  async function request(method, pathname, body) {
    const result = await requestRaw(method, pathname, body);
    if (!result.ok) {
      const code = result.json?.error?.code ? ` ${result.json.error.code}` : '';
      const msg = result.json?.error?.message ? `: ${result.json.error.message}` : '';
      throw new Error(`Center HTTP ${method} ${pathname} failed (${result.status}${code})${msg}`);
    }
    return result.json;
  }

  return {
    request,
    requestRaw,
    async login(password) {
      await request('GET', '/api/session');
      const loginRes = await request('POST', '/api/session', { password });
      assert.equal(loginRes?.authenticated, true, 'owner login must authenticate');
      const verifyRes = await request('GET', '/api/session');
      assert.equal(verifyRes?.authenticated, true, 'owner session cookie must stay authenticated');
    },
  };
}

async function pollFlowUntil(ownerHttp, flowId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastFlow = null;
  while (Date.now() < deadline) {
    lastFlow = await ownerHttp.request('GET', `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(flowId)}`);
    if (predicate(lastFlow)) {
      return lastFlow;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for login flow (${label}): status=${lastFlow?.status ?? 'unknown'} error=${lastFlow?.error ?? 'none'}`,
  );
}

async function run() {
  const timeoutMs = parseTimeoutMs();
  const externalGeminiHome = process.env.PIBOT_AGY_HOME?.trim() || undefined;
  if (externalGeminiHome) {
    assertNotDailyGeminiHome(externalGeminiHome);
  }

  const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-auth-e2e-')));
  const centerDataRoot = path.join(tempRoot, 'center-data');
  mkdirSync(centerDataRoot, { recursive: true, mode: 0o700 });

  let center;
  let primaryError = null;

  console.log(
    '[SCOPE] Center Antigravity Web-Auth broker HTTP E2E (auth_url/manual_code/bounds/invalid-code failure/cancel/cache reuse; interactive Google consent with valid code out of scope)',
  );
  console.log(`[INIT] tempRoot=${tempRoot} profile=${externalGeminiHome ? 'external-PIBOT_AGY_HOME' : 'isolated-temp'}`);

  try {
    const encryptionKey = randomBytes(32);
    const sessionKey = randomBytes(32);
    const ownerPassword = randomBytes(24).toString('base64url');
    const ownerPasswordHash = hashOwnerPassword(ownerPassword);

    center = await openCenterServer({
      dataRoot: centerDataRoot,
      encryptionKey,
      sessionKey,
      ownerPasswordHash,
      listenHost: '127.0.0.1',
      port: 0,
      publicUrl: 'https://127.0.0.1',
    });

    const ownerHttp = createOwnerHttpClient(center.url, timeoutMs);
    await ownerHttp.login(ownerPassword);

    // 1. Precondition: auth-status must detect the existing local CLI login cache
    const initialAuth = await ownerHttp.request('GET', `/api/providers/${PROVIDER_ID}/auth-status`);
    assert.equal(initialAuth?.providerId, PROVIDER_ID);
    assert.equal(initialAuth?.oauth, true, 'antigravity auth-status must advertise oauth=true');
    assert.equal(initialAuth?.apiKey, false, 'antigravity auth-status must advertise apiKey=false');
    if (initialAuth?.method !== 'oauth') {
      throw new Error(
        `Precondition failed: Antigravity CLI login cache not detected via /api/providers/antigravity/auth-status (method=${initialAuth?.method ?? 'none'}). Complete CLI login for this service user/profile first.`,
      );
    }
    console.log(`[STEP 1/5] auth-status precondition ok: method=${initialAuth.method} oauth=${initialAuth.oauth}`);

    // 2. Start web-auth flow -> obtain official Google auth_url & manual_code prompt
    const started = await ownerHttp.request('POST', `/api/providers/${PROVIDER_ID}/login`, {});
    const flowId = started?.flowId;
    assert.ok(typeof flowId === 'string' && flowId.length > 0, 'POST /login must return flowId');

    const promptFlow = await pollFlowUntil(
      ownerHttp,
      flowId,
      (flow) => {
        if (flow.status === 'failed' || flow.status === 'cancelled') return true;
        const hasAuthUrl = Array.isArray(flow.events) && flow.events.some((ev) => ev?.type === 'auth_url');
        return flow.status === 'pending' && hasAuthUrl && flow.prompt?.type === 'manual_code';
      },
      timeoutMs,
      'auth_url + manual_code prompt',
    );
    assert.equal(
      promptFlow.status,
      'pending',
      `expected pending flow with manual_code prompt, got status=${promptFlow.status} error=${promptFlow.error ?? ''}`,
    );
    const authUrlEvent = promptFlow.events.find((ev) => ev?.type === 'auth_url');
    assert.ok(authUrlEvent && typeof authUrlEvent.url === 'string', 'auth_url event missing');
    const safeUrlBase = redactAuthUrlForLog(authUrlEvent.url);
    assert.equal(promptFlow.prompt?.type, 'manual_code', 'expected manual_code prompt');
    console.log(`[STEP 2/5] login prompt ok: authUrlBase=${safeUrlBase} prompt=${promptFlow.prompt.type}`);

    // 3. Input boundary validation (empty & oversized > 8192 chars rejected with 400; flow stays pending)
    const emptyRes = await ownerHttp.requestRaw(
      'POST',
      `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(flowId)}/answer`,
      { answer: '   ' },
    );
    assert.equal(emptyRes.status, 400, `expected 400 on empty answer, got ${emptyRes.status}`);

    const oversizedRes = await ownerHttp.requestRaw(
      'POST',
      `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(flowId)}/answer`,
      { answer: 'a'.repeat(8193) },
    );
    assert.equal(oversizedRes.status, 400, `expected 400 on oversized answer, got ${oversizedRes.status}`);

    const stillPending = await ownerHttp.request(
      'GET',
      `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(flowId)}`,
    );
    assert.equal(stillPending?.status, 'pending', 'rejected boundary inputs must keep flow pending');
    assert.equal(stillPending?.prompt?.type, 'manual_code', 'manual_code prompt must remain active after invalid input');
    console.log('[STEP 3/5] empty & oversized answer boundary rejection ok (flow remained pending)');

    // 4. Submit a single fixed invalid authorization code -> flow must reach `failed` with sanitized error
    const invalidSubmit = await ownerHttp.request(
      'POST',
      `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(flowId)}/answer`,
      { answer: FIXED_INVALID_CODE },
    );
    assert.equal(invalidSubmit?.accepted, true, 'validly shaped answer must be accepted for upstream exchange');

    const failedFlow = await pollFlowUntil(
      ownerHttp,
      flowId,
      (flow) => flow.status !== 'pending',
      timeoutMs,
      'invalid code terminal status',
    );
    assert.equal(
      failedFlow.status,
      'failed',
      `expected failed status for invalid code, got ${failedFlow.status}`,
    );
    assert.ok(
      typeof failedFlow.error === 'string' && failedFlow.error.trim().length > 0,
      'failed flow must expose a non-empty user-safe error message',
    );
    assert.equal(
      failedFlow.error.includes(FIXED_INVALID_CODE),
      false,
      'failed flow error must not leak submitted authorization code',
    );
    assert.equal(
      /Bearer\s+|access_token|refresh_token|id_token|client_secret|\n\s*at\s+/i.test(failedFlow.error),
      false,
      'failed flow error must not leak raw tokens or stack traces',
    );
    console.log(`[STEP 4/5] single invalid code failure ok: status=${failedFlow.status}`);

    // 5. Start a second login flow -> cancel -> verify `cancelled`, then confirm cached login/catalog still healthy
    const secondStart = await ownerHttp.request('POST', `/api/providers/${PROVIDER_ID}/login`, {});
    const cancelFlowId = secondStart?.flowId;
    assert.ok(typeof cancelFlowId === 'string' && cancelFlowId.length > 0, 'second POST /login must return flowId');

    const cancelReady = await pollFlowUntil(
      ownerHttp,
      cancelFlowId,
      (flow) => flow.status !== 'pending' || flow.prompt?.type === 'manual_code',
      timeoutMs,
      'second flow active before cancel',
    );
    assert.equal(cancelReady.status, 'pending', `second flow failed before cancel: ${cancelReady.error ?? ''}`);

    const cancelRes = await ownerHttp.request(
      'POST',
      `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(cancelFlowId)}/cancel`,
      {},
    );
    assert.equal(cancelRes?.status, 'cancelled', 'POST /cancel must return status=cancelled');

    const cancelledFlow = await ownerHttp.request(
      'GET',
      `/api/providers/${PROVIDER_ID}/login/${encodeURIComponent(cancelFlowId)}`,
    );
    assert.equal(cancelledFlow?.status, 'cancelled', 'cancelled flow must report status=cancelled');

    const postAuth = await ownerHttp.request('GET', `/api/providers/${PROVIDER_ID}/auth-status`);
    assert.equal(postAuth?.method, 'oauth', 'cached CLI login must stay authenticated after failed/cancelled attempts');

    const validation = await ownerHttp.request('POST', `/api/providers/${PROVIDER_ID}/validate`, {});
    assert.equal(validation?.ok, true, 'POST /api/providers/antigravity/validate must stay ok after failed/cancelled flows');

    const discovered = await ownerHttp.request('POST', `/api/providers/${PROVIDER_ID}/discover`, {});
    assert.ok(
      Array.isArray(discovered?.models) && discovered.models.length > 0,
      'POST /api/providers/antigravity/discover must still return catalog models after failed/cancelled flows',
    );
    console.log(
      `[STEP 5/5] cancel + post-failure health ok: cancelStatus=${cancelledFlow.status} validateModel=${validation.message} catalogCount=${discovered.models.length}`,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (center?.close) {
      try {
        await center.close();
      } catch (closeErr) {
        if (!primaryError) {
          primaryError = closeErr;
        } else {
          console.error('[CLEANUP] center.close() failed:', closeErr?.message ?? String(closeErr));
        }
      }
    }
    // Never delete externally provided PIBOT_AGY_HOME; remove only tempRoot with bounded retries.
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    } catch (rmErr) {
      console.error(`[CLEANUP] failed to remove tempRoot (${tempRoot}):`, rmErr?.message ?? String(rmErr));
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  console.log('[PASS] Antigravity Center Web-Auth broker HTTP E2E passed.');
}

run().catch((error) => {
  console.error('[FAIL] ' + (error?.message ?? String(error)));
  process.exitCode = 1;
});
