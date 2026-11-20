import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openCenterStore } from '../../center-server/data/index.js';
import { assertPublicCredentialId } from '../../center-server/auth.js';
import {
  GOOGLE_ACCOUNTS_CREDENTIAL_ID,
  GOOGLE_CLIENT_CREDENTIAL_ID,
  openGoogleAccounts,
} from '../../center-server/google-workspace/accounts.js';
import {
  GOOGLE_SERVICE_CHOICES,
  googleSignInScopes,
} from '../../center-server/google-workspace/scopes-readiness.js';
import { parseGoogleTokenEndpointIdToken } from '../../center-server/google-workspace/token-client.js';

const PUBLIC_URL = 'https://center.example.com';
const REDIRECT_URI = 'https://center.example.com/api/oauth/google/callback';
const CLIENT_ID = '123456-web.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-center-web-secret';
const PROJECT_ID = 'acme-center-project';
const ALL_SCOPES = googleSignInScopes(GOOGLE_SERVICE_CHOICES).join(' ');

function makeWebClientJson(overrides = {}) {
  return JSON.stringify({
    web: {
      client_id: CLIENT_ID,
      project_id: PROJECT_ID,
      // Malicious endpoints must be ignored by Center; only hardcoded Google URLs may be called.
      auth_uri: 'https://evil.example/oauth/auth',
      token_uri: 'https://evil.example/oauth/token',
      client_secret: CLIENT_SECRET,
      redirect_uris: [REDIRECT_URI],
      ...overrides,
    },
  });
}

function makeIdToken(claims, headerOverrides = {}) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT', ...headerOverrides })}.${b64(claims)}.fake-signature`;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFakeGoogle(getNow) {
  const state = {
    calls: [],
    expectedChallenge: null,
    expectedCode: 'auth-code-1',
    nextAccount: { sub: '1044', email: 'Ada@Acme.dev', email_verified: true },
    idTokenOverrides: null,
    idTokenHeaderOverrides: null,
    rawIdTokenOverride: null,
    grantedScope: ALL_SCOPES,
    omitRefreshToken: false,
    refreshMode: 'ok', // 'ok' | 'invalid_grant' | 'offline'
    revokeMode: 'ok', // 'ok' | 'offline' | 'error'
    calendarDisabled: false,
    gmailStatusSequence: [],
    refreshDelayMs: 0,
    nextAccessTokenSeq: 1,
    http: async (input, init = {}) => {
      const url = String(input);
      const form = typeof init.body === 'string' && init.headers?.['content-type'] === 'application/x-www-form-urlencoded'
        ? new URLSearchParams(init.body)
        : null;
      state.calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, redirect: init.redirect, form });

      if (url === 'https://oauth2.googleapis.com/token') {
        const grantType = form?.get('grant_type');
        if (grantType === 'authorization_code') {
          if (form?.get('code') === 'pibot-center-key-check') {
            return jsonResponse(400, { error: 'invalid_grant' });
          }
          const verifier = form?.get('code_verifier') ?? '';
          const s256 = createHash('sha256').update(verifier, 'ascii').digest('base64url');
          if (
            form?.get('code') !== state.expectedCode ||
            form?.get('redirect_uri') !== REDIRECT_URI ||
            form?.get('client_id') !== CLIENT_ID ||
            form?.get('client_secret') !== CLIENT_SECRET ||
            (state.expectedChallenge && s256 !== state.expectedChallenge)
          ) {
            return jsonResponse(400, { error: 'invalid_grant' });
          }
          const nowSec = Math.floor(getNow() / 1000);
          const claims = {
            iss: 'https://accounts.google.com',
            aud: CLIENT_ID,
            azp: CLIENT_ID,
            iat: nowSec - 5,
            exp: nowSec + 3600,
            ...state.nextAccount,
            ...(state.idTokenOverrides ?? {}),
          };
          const seq = state.nextAccessTokenSeq++;
          return jsonResponse(200, {
            access_token: `at-${seq}`,
            expires_in: 3600,
            ...(state.omitRefreshToken ? {} : { refresh_token: `rt-${state.nextAccount.sub}` }),
            scope: state.grantedScope,
            id_token:
              state.rawIdTokenOverride ??
              makeIdToken(claims, state.idTokenHeaderOverrides ?? {}),
          });
        }

        if (grantType === 'refresh_token') {
          if (state.refreshDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
          }
          if (state.refreshMode === 'offline') {
            throw new TypeError('fetch failed');
          }
          if (state.refreshMode === 'invalid_grant') {
            return jsonResponse(400, {
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.',
            });
          }
          const seq = state.nextAccessTokenSeq++;
          return jsonResponse(200, {
            access_token: `at-refreshed-${seq}`,
            expires_in: 3600,
            scope: state.grantedScope,
          });
        }
      }

      if (url === 'https://oauth2.googleapis.com/revoke') {
        if (state.revokeMode === 'offline') throw new TypeError('fetch failed');
        if (state.revokeMode === 'error') return jsonResponse(500, { error: 'server_error' });
        return jsonResponse(200, {});
      }

      if (url.startsWith('https://www.googleapis.com/calendar/')) {
        if (state.calendarDisabled) {
          return jsonResponse(403, {
            error: {
              code: 403,
              message: 'Google Calendar API has not been used in project before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [
                {
                  reason: 'SERVICE_DISABLED',
                  metadata: {
                    activationUrl:
                      'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=42',
                  },
                },
              ],
            },
          });
        }
        return jsonResponse(200, { items: [] });
      }

      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/')) {
        if (state.gmailStatusSequence.length > 0) {
          const nextStatus = state.gmailStatusSequence.shift();
          if (nextStatus === 302) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://evil.example/steal-bearer' },
            });
          }
          if (nextStatus !== 200) {
            return jsonResponse(nextStatus, { error: { code: nextStatus, message: 'Refused' } });
          }
        }
        return jsonResponse(200, { emailAddress: state.nextAccount.email.toLowerCase() });
      }

      if (url.includes('orca-readiness-check')) {
        return jsonResponse(404, { error: { code: 404, message: 'Requested entity was not found.' } });
      }

      return jsonResponse(200, {});
    },
  };
  return state;
}

function openFixture() {
  let currentNow = 1_800_000_000_000;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-google-accounts-test-'));
  const encryptionKey = new Uint8Array(32).fill(9);
  const store = openCenterStore({ dataRoot, encryptionKey });
  const google = createFakeGoogle(() => currentNow);
  const accounts = openGoogleAccounts({
    store,
    publicUrl: PUBLIC_URL,
    fetchImpl: google.http,
    now: () => currentNow,
  });
  return {
    dataRoot,
    encryptionKey,
    store,
    google,
    accounts,
    now: () => currentNow,
    advance(ms) {
      currentNow += ms;
    },
    cleanup() {
      accounts.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

async function connectAccount(fixture, { owner = 'owner-1', choices, account } = {}) {
  const started = await fixture.accounts.manage(
    'authorize',
    { ...(choices ? { choices } : {}), ...(account ? { account } : {}) },
    owner
  );
  const authUrl = new URL(started.authorizationUrl);
  fixture.google.expectedChallenge = authUrl.searchParams.get('code_challenge');
  const cb = await fixture.accounts.callback(
    new URLSearchParams({
      state: authUrl.searchParams.get('state'),
      code: fixture.google.expectedCode,
    })
  );
  return { started, authUrl, cb };
}

test('rejects invalid publicUrl and validates Web OAuth client JSON strictly', async () => {
  const fixture = openFixture();
  try {
    assert.throws(
      () => openGoogleAccounts({ store: fixture.store, publicUrl: 'http://center.example.com' }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );
    assert.throws(
      () => openGoogleAccounts({ store: fixture.store, publicUrl: 'https://center.example.com/sub' }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    const initial = fixture.accounts.status();
    assert.deepEqual(initial, {
      client: { configured: false, redirectUri: REDIRECT_URI },
      accounts: [],
    });

    // Rejects service_account, Desktop (installed), authorized_user, token file, wrong redirect_uri, oversized file.
    const invalidFiles = [
      JSON.stringify({ type: 'service_account', private_key: 'k', client_email: 'a@b.iam.gserviceaccount.com' }),
      JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }),
      JSON.stringify({ type: 'authorized_user', refresh_token: 'rt', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
      JSON.stringify({ access_token: 'at', refresh_token: 'rt' }),
      makeWebClientJson({ redirect_uris: ['https://other.example.com/api/oauth/google/callback'] }),
      makeWebClientJson({ redirect_uris: [] }),
      makeWebClientJson({ client_id: 'evil.example.com' }),
    ];
    for (const badFile of invalidFiles) {
      await assert.rejects(
        () => fixture.accounts.manage('configure', { clientFile: badFile }, 'owner-1'),
        (err) => err.code === 'INVALID_ARGUMENT'
      );
    }

    const oversized = JSON.stringify({ web: { pad: 'x'.repeat(70_000) } });
    await assert.rejects(
      () => fixture.accounts.manage('configure', { clientFile: oversized }, 'owner-1'),
      (err) => err.code === 'PAYLOAD_TOO_LARGE'
    );

    // Requires authenticated ownerKey for mutating actions.
    await assert.rejects(
      () => fixture.accounts.manage('configure', { clientFile: makeWebClientJson() }, ''),
      (err) => err.code === 'FORBIDDEN'
    );

    // Accepts valid Web client JSON and never exposes clientSecret.
    const configured = await fixture.accounts.manage(
      'configure',
      { clientFile: makeWebClientJson() },
      'owner-1'
    );
    assert.equal(configured.client.configured, true);
    assert.equal(configured.client.clientId, CLIENT_ID);
    assert.equal(configured.client.projectId, PROJECT_ID);
    assert.equal(configured.client.redirectUri, REDIRECT_URI);
    assert.equal('clientSecret' in configured.client, false);
    assert.equal(JSON.stringify(configured).includes(CLIENT_SECRET), false);

    // Internal credential IDs are isolated from generic public credential APIs.
    assert.throws(
      () => assertPublicCredentialId(GOOGLE_CLIENT_CREDENTIAL_ID),
      (err) => err.code === 'FORBIDDEN'
    );
    assert.throws(
      () => assertPublicCredentialId(GOOGLE_ACCOUNTS_CREDENTIAL_ID),
      (err) => err.code === 'FORBIDDEN'
    );
  } finally {
    fixture.cleanup();
  }
});

test('enforces owner-private flows, PKCE, single-use state, 5-min expiry, cancel, and persists across restart', async () => {
  const fixture = openFixture();
  try {
    await fixture.accounts.manage('configure', { clientFile: makeWebClientJson() }, 'owner-1');

    const flowA = await fixture.accounts.manage('authorize', { choices: ['gmail'] }, 'owner-A');
    const urlA = new URL(flowA.authorizationUrl);
    assert.equal(urlA.origin + urlA.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(urlA.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(urlA.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(urlA.searchParams.get('access_type'), 'offline');
    assert.equal(urlA.searchParams.get('prompt'), 'consent');
    assert.ok(urlA.searchParams.get('scope').includes('gmail.modify'));
    assert.ok(!urlA.searchParams.get('scope').includes('drive'));

    // Cross-owner isolation: owner-B cannot inspect or cancel owner-A's flow.
    await assert.rejects(
      () => fixture.accounts.manage('flow', { flowId: flowA.flowId }, 'owner-B'),
      (err) => err.code === 'NOT_FOUND'
    );
    await assert.rejects(
      () => fixture.accounts.manage('cancel', { flowId: flowA.flowId }, 'owner-B'),
      (err) => err.code === 'NOT_FOUND'
    );

    // Duplicate callback params are refused without spending state.
    const dupParams = new URLSearchParams();
    dupParams.append('state', urlA.searchParams.get('state'));
    dupParams.append('state', urlA.searchParams.get('state'));
    dupParams.append('code', 'auth-code-1');
    await assert.rejects(
      () => fixture.accounts.callback(dupParams),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    // Cancel invalidates state permanently.
    const cancelled = await fixture.accounts.manage('cancel', { flowId: flowA.flowId }, 'owner-A');
    assert.equal(cancelled.phase, 'cancelled');
    await assert.rejects(
      () =>
        fixture.accounts.callback(
          new URLSearchParams({ state: urlA.searchParams.get('state'), code: 'auth-code-1' })
        ),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    // 5-minute TTL expiry rejects late callbacks.
    const expiring = await fixture.accounts.manage('authorize', { choices: ['gmail'] }, 'owner-A');
    const expState = new URL(expiring.authorizationUrl).searchParams.get('state');
    fixture.advance(5 * 60 * 1000 + 1);
    await assert.rejects(
      () => fixture.accounts.callback(new URLSearchParams({ state: expState, code: 'auth-code-1' })),
      (err) => err.code === 'INVALID_STATE'
    );
    const expView = await fixture.accounts.manage('flow', { flowId: expiring.flowId }, 'owner-A');
    assert.equal(expView.phase, 'failed');

    // Valid callback completes once; replay with same state fails.
    fixture.google.calendarDisabled = true;
    const { started, authUrl, cb } = await connectAccount(fixture, {
      owner: 'owner-A',
      choices: ['gmail', 'calendar'],
    });
    assert.equal(cb.ok, true);
    assert.equal(cb.phase, 'connected');
    assert.equal(cb.account.id, '1044');
    assert.equal(cb.account.email, 'ada@acme.dev');
    assert.equal(cb.account.status, 'connected');
    assert.equal(
      cb.account.services.find((s) => s.service === 'calendar')?.state,
      'api-disabled'
    );
    assert.equal(
      cb.account.services.find((s) => s.service === 'gmail')?.state,
      'ready'
    );

    // Token endpoint must be Google's hardcoded URL, never evil.example from client JSON.
    assert.equal(
      fixture.google.calls.some((call) => call.url.includes('evil.example')),
      false
    );

    // Replay of the same state is rejected.
    await assert.rejects(
      () =>
        fixture.accounts.callback(
          new URLSearchParams({ state: authUrl.searchParams.get('state'), code: 'auth-code-1' })
        ),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    const flowDone = await fixture.accounts.manage('flow', { flowId: started.flowId }, 'owner-A');
    assert.equal(flowDone.phase, 'connected');
    assert.equal(flowDone.account.email, 'ada@acme.dev');
    assert.equal(JSON.stringify(flowDone).includes('rt-1044'), false);

    // Persistence across Center restart using the same /data SQLite store.
    fixture.accounts.close();
    fixture.store.close();
    const reopenedStore = openCenterStore({
      dataRoot: fixture.dataRoot,
      encryptionKey: fixture.encryptionKey,
    });
    const reopenedAccounts = openGoogleAccounts({
      store: reopenedStore,
      publicUrl: PUBLIC_URL,
      fetchImpl: fixture.google.http,
      now: fixture.now,
    });
    try {
      const restored = reopenedAccounts.status();
      assert.equal(restored.client.configured, true);
      assert.equal(restored.client.clientId, CLIENT_ID);
      assert.equal(restored.accounts.length, 1);
      assert.equal(restored.accounts[0].id, '1044');
      assert.equal(restored.accounts[0].email, 'ada@acme.dev');
    } finally {
      reopenedAccounts.close();
      reopenedStore.close();
    }
  } finally {
    try { fixture.accounts.close(); } catch {}
    try { fixture.store.close(); } catch {}
    fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('strictly validates OIDC ID token trust boundary, JWS header, iss, aud, exp, sub, and email_verified', async () => {
  const fixture = openFixture();
  try {
    await fixture.accounts.manage('configure', { clientFile: makeWebClientJson() }, 'owner-1');
    const nowSec = Math.floor(fixture.now() / 1000);
    const validRawToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      iat: nowSec - 5,
      exp: nowSec + 3600,
      sub: '1044',
      email: 'ada@acme.dev',
      email_verified: true,
    });

    // Trust boundary: untrusted/frontend-supplied strings or plain objects are always refused.
    assert.throws(
      () =>
        parseGoogleTokenEndpointIdToken(validRawToken, {
          expectedClientId: CLIENT_ID,
          nowMs: fixture.now(),
        }),
      /untrusted ID token source/i
    );
    assert.throws(
      () =>
        parseGoogleTokenEndpointIdToken(
          { idToken: validRawToken },
          { expectedClientId: CLIENT_ID, nowMs: fixture.now() }
        ),
      /untrusted ID token source/i
    );

    // Malformed / disallowed JWS headers from token endpoint are rejected.
    const badHeaders = [
      { alg: 'none' },
      { alg: 'HS256' },
      { typ: 'JWE' },
      { crit: ['exp'] },
      { jwk: { kty: 'RSA' } },
      { kid: '' },
    ];
    for (const headerOverride of badHeaders) {
      fixture.google.idTokenHeaderOverrides = headerOverride;
      const { cb } = await connectAccount(fixture, { owner: 'owner-1', choices: ['gmail'] });
      assert.equal(cb.ok, false);
      assert.equal(cb.phase, 'failed');
    }
    fixture.google.idTokenHeaderOverrides = null;

    fixture.google.rawIdTokenOverride = `${Buffer.from('not-json').toString('base64url')}.${validRawToken.split('.')[1]}.sig`;
    const nonJsonHeader = await connectAccount(fixture, { owner: 'owner-1', choices: ['gmail'] });
    assert.equal(nonJsonHeader.cb.ok, false);
    assert.equal(nonJsonHeader.cb.phase, 'failed');
    fixture.google.rawIdTokenOverride = null;

    const badCases = [
      { iss: 'https://evil.example' },
      { aud: 'other-client.apps.googleusercontent.com', azp: 'other-client.apps.googleusercontent.com' },
      { exp: nowSec - 10 },
      { email_verified: false },
      { sub: 'bad@subject' },
    ];
    for (const override of badCases) {
      fixture.google.idTokenOverrides = override;
      const { cb } = await connectAccount(fixture, { owner: 'owner-1', choices: ['gmail'] });
      assert.equal(cb.ok, false);
      assert.equal(cb.phase, 'failed');
    }
    assert.deepEqual(fixture.accounts.status().accounts, []);
  } finally {
    fixture.cleanup();
  }
});

test('serializes concurrent refresh, separates invalid_grant vs offline, enforces multi-account selection and remove vs revoke', async () => {
  const fixture = openFixture();
  try {
    await fixture.accounts.manage('configure', { clientFile: makeWebClientJson() }, 'owner-1');

    // 0 accounts -> explicit error code.
    assert.throws(
      () => fixture.accounts.api(),
      (err) => err.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED'
    );

    // Connect account 1.
    await connectAccount(fixture, { owner: 'owner-1', choices: ['gmail'] });
    fixture.google.calls.length = 0;

    // 1 account -> api() defaults to it, enforces fixed Google API origin via orca-domain,
    // and refuses unexpected redirects so Bearer tokens never leak off-origin.
    const singleApi = fixture.accounts.api();
    assert.equal(singleApi.email, 'ada@acme.dev');
    assert.equal(singleApi.id, '1044');
    await assert.rejects(
      () => singleApi.get('gmail', 'https://evil.example/steal', (x) => x),
      (err) => err.name === 'GoogleToolError' && /disallowed Google API origin/i.test(err.message)
    );
    assert.equal(fixture.google.calls.length, 0);

    fixture.google.gmailStatusSequence = [302];
    await assert.rejects(
      () => singleApi.get('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (x) => x),
      (err) => err.name === 'GoogleToolError' && /unexpected redirect/i.test(err.message)
    );
    assert.equal(fixture.google.calls[0]?.redirect, 'manual');
    fixture.google.calls.length = 0;

    // Concurrent calls near expiry perform exactly 1 serialized token refresh.
    fixture.advance(58 * 60 * 1000);
    fixture.google.refreshDelayMs = 20;
    const [r1, r2] = await Promise.all([
      singleApi.get('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (x) => x),
      singleApi.get('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (x) => x),
    ]);
    assert.equal(r1.emailAddress, 'ada@acme.dev');
    assert.equal(r2.emailAddress, 'ada@acme.dev');
    const refreshes = fixture.google.calls.filter(
      (call) => call.form?.get('grant_type') === 'refresh_token'
    );
    assert.equal(refreshes.length, 1);

    // Transient offline during refresh keeps account connected.
    fixture.google.refreshDelayMs = 0;
    fixture.google.refreshMode = 'offline';
    fixture.advance(2 * 60 * 60 * 1000);
    await assert.rejects(
      () => singleApi.get('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (x) => x),
      (err) => err.code === 'GOOGLE_UNAVAILABLE'
    );
    assert.equal(fixture.accounts.status().accounts[0].status, 'connected');

    // invalid_grant transitions account to reconnect and stops calling Google.
    fixture.google.refreshMode = 'invalid_grant';
    await assert.rejects(
      () => singleApi.get('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (x) => x),
      (err) => err.code === 'GOOGLE_RECONNECT_REQUIRED'
    );
    assert.equal(fixture.accounts.status().accounts[0].status, 'reconnect');
    fixture.google.calls.length = 0;
    await assert.rejects(
      () => singleApi.get('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (x) => x),
      (err) => err.code === 'GOOGLE_RECONNECT_REQUIRED'
    );
    assert.equal(fixture.google.calls.length, 0);

    // Connect a second account: multi-account api() without selector must NOT guess even though account 1 is reconnect.
    fixture.google.refreshMode = 'ok';
    fixture.google.nextAccount = { sub: '2088', email: 'Grace@Acme.dev', email_verified: true };
    await connectAccount(fixture, { owner: 'owner-1', choices: ['gmail'] });

    assert.throws(
      () => fixture.accounts.api(),
      (err) => err.code === 'GOOGLE_ACCOUNT_AMBIGUOUS' && err.accounts.length === 2
    );
    assert.equal(fixture.accounts.api('grace@acme.dev').email, 'grace@acme.dev');
    assert.equal(fixture.accounts.api('2088').email, 'grace@acme.dev');

    // Remove with revoke failure still removes locally and reports revocation failure separately.
    fixture.google.revokeMode = 'offline';
    const removedFail = await fixture.accounts.manage(
      'remove',
      { account: 'grace@acme.dev', revoke: true },
      'owner-1'
    );
    assert.equal(removedFail.removed, true);
    assert.equal(removedFail.revokeRequested, true);
    assert.equal(removedFail.revoked, false);
    assert.equal(removedFail.revokeStatus, 'failed');
    assert.ok(typeof removedFail.revokeError === 'string' && removedFail.revokeError.length > 0);
    assert.equal(fixture.accounts.status().accounts.length, 1);

    // Remove account in reconnect state (no token left) with revoke: true -> revokeStatus 'no-token'.
    const removedReconnect = await fixture.accounts.manage(
      'remove',
      { account: '1044', revoke: true },
      'owner-1'
    );
    assert.equal(removedReconnect.removed, true);
    assert.equal(removedReconnect.revoked, null);
    assert.equal(removedReconnect.revokeStatus, 'no-token');
    assert.equal(fixture.accounts.status().accounts.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('supports direct client config, partial-scope readiness, 401 single retry, check, and confirmed revoke', async () => {
  const fixture = openFixture();
  try {
    const configured = await fixture.accounts.manage(
      'configure',
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, projectId: PROJECT_ID },
      'owner-1'
    );
    assert.equal(configured.client.configured, true);
    assert.equal(JSON.stringify(configured).includes(CLIENT_SECRET), false);

    // Partial consent: user grants Gmail + Contacts but unticks Calendar.
    fixture.google.grantedScope = googleSignInScopes(['gmail']).join(' ');
    const { cb } = await connectAccount(fixture, {
      owner: 'owner-1',
      choices: ['gmail', 'calendar'],
    });
    assert.equal(cb.ok, true);
    assert.equal(cb.account.services.find((s) => s.service === 'gmail')?.state, 'ready');
    assert.equal(
      cb.account.services.find((s) => s.service === 'calendar')?.state,
      'needs-permission'
    );
    // Calendar endpoint must not be probed when calendar scopes were not granted.
    assert.equal(
      fixture.google.calls.some((call) => call.url.includes('/calendar/')),
      false
    );

    // 401 on API call triggers one forced refresh and succeeds on retry.
    fixture.google.calls.length = 0;
    fixture.google.gmailStatusSequence = [401, 200];
    const api = fixture.accounts.api();
    const profile = await api.get(
      'gmail',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      (x) => x
    );
    assert.equal(profile.emailAddress, 'ada@acme.dev');
    assert.equal(
      fixture.google.calls.filter((call) => call.form?.get('grant_type') === 'refresh_token').length,
      1
    );

    // Full check updates clientKey and account readiness.
    const checked = await fixture.accounts.manage('check', {}, 'owner-1');
    assert.equal(checked.client.clientKey, 'works');
    assert.equal(checked.accounts.length, 1);

    // Confirmed revoke reports removed: true, revoked: true, revokeStatus: 'revoked'.
    const removed = await fixture.accounts.manage(
      'remove',
      { account: 'ada@acme.dev', revoke: true },
      'owner-1'
    );
    assert.equal(removed.removed, true);
    assert.equal(removed.revokeRequested, true);
    assert.equal(removed.revoked, true);
    assert.equal(removed.revokeStatus, 'revoked');
  } finally {
    fixture.cleanup();
  }
});
