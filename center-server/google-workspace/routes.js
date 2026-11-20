// HTTP routes for Center-hosted Google Workspace account management,
// public OAuth callback, and per-Bot Google trigger rules.
//
// Auth & security invariants:
// - Owner reads mount on requireOwner; owner mutations mount on [requireOwner, csrfUnlessOAuth].
// - GET /api/oauth/google/callback is mounted directly on app (no requireOwner / CSRF),
//   enforces no-store + no-referrer + strict CSP, consumes single-use state via
//   accounts.callback(URLSearchParams), and never echoes code, state, or tokens.
// - No request body or query secrets are logged; Cache-Control: no-store on every route.

import { randomBytes } from 'node:crypto';
import {
  GOOGLE_ACTION_BODY_LIMIT,
  GOOGLE_CALLBACK_PATH,
  GOOGLE_CONFIGURE_BODY_LIMIT,
  GOOGLE_RULE_BODY_LIMIT,
} from './constants.js';
import { scrubGoogleSecrets } from './mcp-server.js';

export const GOOGLE_ERROR_STATUS = Object.freeze({
  GOOGLE_INVALID_ARGUMENT: 400,
  GOOGLE_INVALID_CLIENT_FILE: 400,
  GOOGLE_INVALID_CLIENT: 400,
  GOOGLE_REDIRECT_MISMATCH: 400,
  GOOGLE_INVALID_STATE: 400,
  GOOGLE_INVALID_CALLBACK: 400,
  GOOGLE_SCOPE_REQUIRED: 400,
  GOOGLE_UNAUTHENTICATED: 401,
  GOOGLE_OAUTH_DENIED: 401,
  GOOGLE_AUTH_FAILED: 401,
  GOOGLE_FORBIDDEN: 403,
  GOOGLE_SCOPE_DENIED: 403,
  GOOGLE_API_DISABLED: 403,
  GOOGLE_ADMIN_BLOCKED: 403,
  GOOGLE_NOT_FOUND: 404,
  GOOGLE_ACCOUNT_NOT_FOUND: 404,
  GOOGLE_FLOW_NOT_FOUND: 404,
  GOOGLE_RULE_NOT_FOUND: 404,
  GOOGLE_NOT_CONFIGURED: 409,
  GOOGLE_NOT_CONNECTED: 409,
  GOOGLE_NO_ACCOUNTS: 409,
  GOOGLE_ACCOUNT_REQUIRED: 409,
  GOOGLE_ACCOUNT_AMBIGUOUS: 409,
  GOOGLE_MULTIPLE_ACCOUNTS: 409,
  GOOGLE_RECONNECT_REQUIRED: 409,
  GOOGLE_FLOW_EXPIRED: 409,
  GOOGLE_FLOW_CONFLICT: 409,
  GOOGLE_FLOW_USED: 409,
  GOOGLE_FLOW_CANCELLED: 409,
  GOOGLE_CONFLICT: 409,
  GOOGLE_STATE_EXPIRED: 410,
  GOOGLE_CLIENT_FILE_TOO_LARGE: 413,
  GOOGLE_RATE_LIMITED: 429,
  GOOGLE_OAUTH_FAILED: 502,
  GOOGLE_TOKEN_EXCHANGE_FAILED: 502,
  GOOGLE_REVOKE_FAILED: 502,
  GOOGLE_UPSTREAM_ERROR: 502,
  GOOGLE_API_ERROR: 502,
  GOOGLE_UNAVAILABLE: 503,
});

const GOOGLE_CODE_RE = /^GOOGLE_[A-Z0-9_]{1,56}$/;

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ARGUMENT', 'Expected an object');
  }
  return value;
}

function optionalBoundedId(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value.trim();
}

function setNoCacheHeaders(reply) {
  reply
    .header('Cache-Control', 'no-store')
    .header('Pragma', 'no-cache')
    .header('Referrer-Policy', 'no-referrer');
}

function setCallbackSecurityHeaders(reply) {
  setNoCacheHeaders(reply);
  reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
}

/**
 * Derives an unforgeable per-owner-caller key for OAuth flow ownership binding.
 * - Device OAuth Bearer callers (`pboauth_*`) bind to their authenticated deviceId.
 * - Browser owner cookie callers bind to an encrypted session-scoped random ID.
 */
export function deriveGoogleOwnerKey(req) {
  if (typeof req.oauthDeviceId === 'string' && req.oauthDeviceId) {
    return 'oauth-device:' + req.oauthDeviceId;
  }
  if (req.session && req.session.get('owner') === true) {
    let sessionId = req.session.get('ownerSessionId');
    if (typeof sessionId !== 'string' || !sessionId) {
      sessionId = randomBytes(16).toString('base64url');
      req.session.set('ownerSessionId', sessionId);
    }
    return 'session:' + sessionId;
  }
  fail('UNAUTHENTICATED', 'Authentication required');
}

function safeGoogleErrorDetails(err) {
  const details = {};
  if (typeof err?.service === 'string' && err.service.trim()) details.service = err.service.trim();
  if (typeof err?.state === 'string' && err.state.trim()) details.state = err.state.trim();
  if (typeof err?.redirectUri === 'string' && err.redirectUri.startsWith('https://')) {
    details.redirectUri = err.redirectUri;
  }
  const rawAccounts = err?.accounts ?? err?.details?.accounts;
  if (Array.isArray(rawAccounts)) {
    const safeAccounts = rawAccounts
      .map((item) => {
        if (typeof item === 'string' && item.trim()) return { email: item.trim() };
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const entry = {};
          if (typeof item.id === 'string' && item.id) entry.id = item.id;
          if (typeof item.email === 'string' && item.email) entry.email = item.email;
          if (item.status === 'connected' || item.status === 'reconnect') entry.status = item.status;
          return Object.keys(entry).length ? entry : null;
        }
        return null;
      })
      .filter(Boolean);
    if (safeAccounts.length) details.accounts = safeAccounts;
  }
  return Object.keys(details).length ? details : undefined;
}

function handleGoogleRouteError(reply, err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (GOOGLE_CODE_RE.test(code)) {
    const mapped = GOOGLE_ERROR_STATUS[code]
      ?? (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 400);
    const message = typeof err?.message === 'string' && err.message.trim()
      ? scrubGoogleSecrets(err.message.trim()).slice(0, 400)
      : code.replaceAll('_', ' ').toLowerCase();
    const details = safeGoogleErrorDetails(err);
    return reply.code(mapped).send({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    });
  }
  throw err;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function prefersJson(req) {
  const accept = String(req.headers?.accept || '').toLowerCase();
  if (!accept) return false;
  if (accept.includes('text/html') || accept.includes('application/xhtml+xml')) return false;
  return accept.includes('application/json');
}

function sanitizeCallbackResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: true, phase: 'connected' };
  }
  const phase = typeof result.phase === 'string'
    ? result.phase
    : (result.ok === false ? 'failed' : 'connected');
  const ok = typeof result.ok === 'boolean' ? result.ok : phase === 'connected';
  const email = typeof result.account?.email === 'string'
    ? result.account.email
    : (typeof result.email === 'string' ? result.email : undefined);
  const accountId = typeof result.account?.id === 'string' ? result.account.id : undefined;
  const errorMessage = typeof result.error === 'string'
    ? scrubGoogleSecrets(result.error).slice(0, 300)
    : (typeof result.error?.message === 'string' ? scrubGoogleSecrets(result.error.message).slice(0, 300) : undefined);
  return {
    ok,
    phase,
    ...(email || accountId ? { account: { ...(accountId ? { id: accountId } : {}), ...(email ? { email } : {}) } } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

function renderCallbackHtml({ ok, phase, email, errorMessage }) {
  const cancelled = phase === 'cancelled';
  const titleZh = ok
    ? 'Google 授权已完成'
    : cancelled
      ? 'Google 授权已取消'
      : 'Google 授权未完成';
  const titleEn = ok
    ? 'Google authorization complete'
    : cancelled
      ? 'Google authorization cancelled'
      : 'Google authorization was not completed';
  const detail = ok
    ? (email
        ? `已连接账号 ${email}。现在可以关闭此标签页并返回 PiBot。`
        : '授权已收到，现在可以关闭此标签页并返回 PiBot。')
    : (errorMessage || '请关闭此标签页并返回 PiBot 重试。');
  const detailEn = ok
    ? 'You may close this tab and return to PiBot.'
    : 'Close this tab and return to PiBot to retry.';
  const badgeColor = ok ? '#15803d' : '#b45309';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(titleZh)} - PiBot</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px 16px; background: #f8fafc; color: #0f172a; display: flex; justify-content: center; align-items: center; min-height: 100vh; box-sizing: border-box; }
  main { max-width: 460px; width: 100%; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 28px 24px; box-shadow: 0 4px 20px rgba(15, 23, 42, 0.06); }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; color: ${badgeColor}; margin-bottom: 10px; }
  h1 { font-size: 20px; margin: 0 0 8px; line-height: 1.35; }
  .sub { font-size: 14px; color: #475569; margin: 0 0 16px; }
  p { font-size: 14px; line-height: 1.6; margin: 0 0 8px; color: #334155; }
  .en { font-size: 13px; color: #64748b; margin-top: 10px; }
</style>
</head>
<body>
<main>
  <div class="badge">PiBot Center · Google Workspace</div>
  <h1>${escapeHtml(titleZh)}</h1>
  <div class="sub">${escapeHtml(titleEn)}</div>
  <p>${escapeHtml(detail)}</p>
  <p class="en">${escapeHtml(detailEn)}</p>
</main>
</body>
</html>`;
}

export function registerGoogleWorkspaceRoutes(app, { route, store, bridge, publicUrl, google }) {
  const { accounts, rules, ruleDispatch } = google || {};
  if (!accounts) throw new Error('google.accounts is required');

  const runOwner = (fn) => async (req, reply) => {
    setNoCacheHeaders(reply);
    try {
      return await fn(req, reply);
    } catch (err) {
      return handleGoogleRouteError(reply, err);
    }
  };

  route('GET', '/api/google/status', runOwner(async () => accounts.status()));

  const manageActions = [
    ['configure', GOOGLE_CONFIGURE_BODY_LIMIT],
    ['authorize', GOOGLE_ACTION_BODY_LIMIT],
    ['flow', GOOGLE_ACTION_BODY_LIMIT],
    ['cancel', GOOGLE_ACTION_BODY_LIMIT],
    ['check', GOOGLE_ACTION_BODY_LIMIT],
    ['remove', GOOGLE_ACTION_BODY_LIMIT],
  ];

  for (const [action, bodyLimit] of manageActions) {
    route('POST', `/api/google/${action}`, runOwner(async (req) => {
      const body = requireObject(req.body ?? {});
      const ownerKey = deriveGoogleOwnerKey(req);
      return await accounts.manage(action, body, ownerKey);
    }), true, bodyLimit);
  }

  // Public HTTPS OAuth redirect target from Google: intentionally outside
  // requireOwner/CSRF; binds strictly to single-use state + PKCE in accounts.
  app.get(GOOGLE_CALLBACK_PATH, async (req, reply) => {
    setCallbackSecurityHeaders(reply);
    const searchParams = new URL(req.url, publicUrl).searchParams;
    const jsonWanted = prefersJson(req);
    try {
      const raw = await accounts.callback(searchParams);
      const safe = sanitizeCallbackResult(raw);
      if (jsonWanted) return safe;
      const statusCode = safe.ok ? 200 : (safe.phase === 'cancelled' ? 200 : 400);
      return reply
        .code(statusCode)
        .type('text/html; charset=utf-8')
        .send(renderCallbackHtml({
          ok: safe.ok,
          phase: safe.phase,
          email: safe.account?.email,
          errorMessage: safe.error,
        }));
    } catch (err) {
      if (jsonWanted) return handleGoogleRouteError(reply, err);
      const code = typeof err?.code === 'string' ? err.code : '';
      const statusCode = GOOGLE_ERROR_STATUS[code]
        ?? (code === 'INVALID_ARGUMENT' ? 400 : code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 400);
      const message = typeof err?.message === 'string' && err.message.trim()
        ? scrubGoogleSecrets(err.message.trim()).slice(0, 300)
        : 'Authorization state is invalid or expired. Return to PiBot to start again.';
      return reply
        .code(statusCode)
        .type('text/html; charset=utf-8')
        .send(renderCallbackHtml({ ok: false, phase: 'failed', errorMessage: message }));
    }
  });

  if (rules) {
    route('GET', '/api/google/rules', runOwner(async (req) => {
      const deviceId = optionalBoundedId(req.query?.deviceId, 'deviceId');
      const botId = optionalBoundedId(req.query?.botId, 'botId');
      const filter = {
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(botId !== undefined ? { botId } : {}),
      };
      return await rules.manage('list', filter);
    }));

    route('POST', '/api/google/rules/save', runOwner(async (req) => {
      const body = requireObject(req.body);
      const deviceId = optionalBoundedId(body.deviceId, 'deviceId');
      const botId = optionalBoundedId(body.botId, 'botId');
      if (deviceId !== undefined) {
        const device = bridge?.registry?.get?.(deviceId);
        if (!device || device.revokedAt !== null || deviceId === bridge?.deviceId) {
          fail('NOT_FOUND', 'Device not found');
        }
        if (botId !== undefined && !store.listDeviceBots(deviceId).some((bot) => bot.botId === botId)) {
          fail('BOT_NOT_FOUND', 'Bot not found');
        }
      }
      return await rules.manage('save', body);
    }), true, GOOGLE_RULE_BODY_LIMIT);

    route('POST', '/api/google/rules/remove', runOwner(async (req) => {
      const body = requireObject(req.body);
      const ruleId = optionalBoundedId(body.id ?? body.ruleId, 'id');
      const result = await rules.manage('remove', body);
      const removedId = ruleId ?? optionalBoundedId(result?.id ?? result?.ruleId, 'id');
      if (removedId) {
        try { ruleDispatch?.cancelRule?.(removedId); } catch { /* best-effort cancel of pending events */ }
      }
      return result;
    }), true, GOOGLE_ACTION_BODY_LIMIT);
  }
}
