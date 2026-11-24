// HTTP routes for Center-hosted Google Workspace account management,
// public OAuth callback, and per-Bot Google trigger rules.
//
// Auth & security invariants:
// - Owner reads mount on requireOwner; owner mutations mount on [requireOwner, csrfUnlessOAuth].
// - GET /api/oauth/google/callback is mounted directly on app (no requireOwner / CSRF),
//   enforces no-store + no-referrer + strict CSP, consumes single-use state via
//   accounts.callback(URLSearchParams), and never echoes code, state, or tokens.
// - No request body or query secrets are logged; Cache-Control: no-store on every route.

import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_GOOGLE_ASSISTANT_SOUL } from '../../center-contract/google-workspace.js';
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
  GOOGLE_ACCOUNT_NOT_CONNECTED: 409,
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
const STANDARD_CLIENT_ERROR_STATUS = Object.freeze({
  INVALID_ARGUMENT: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BOT_NOT_FOUND: 404,
  BOT_ARCHIVED: 409,
  INVALID_STATE: 409,
  REQUEST_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
});

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ARGUMENT', 'Expected an object');
  }
  return value;
}

function optionalBoundedText(value, name, max = 128) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value.trim();
}

function optionalQueryBoolean(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  fail('INVALID_ARGUMENT', `Invalid ${name}`);
}

function optionalQueryInt(value, name, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return parsed;
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
  if (GOOGLE_CODE_RE.test(code) || Object.prototype.hasOwnProperty.call(STANDARD_CLIENT_ERROR_STATUS, code)) {
    const mapped = GOOGLE_ERROR_STATUS[code]
      ?? STANDARD_CLIENT_ERROR_STATUS[code]
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

const ASSISTANT_SETUP_FIELDS = new Set([
  'mode',
  'deviceId',
  'botId',
  'createBot',
  'accounts',
  'batchWindowMinutes',
  'digestTimes',
  'calendarEnabled',
  'calendarLeadMinutes',
  'hindsightPrivateMemory',
]);
const ASSISTANT_CREATE_BOT_FIELDS = new Set([
  'role',
  'description',
  'modelRef',
  'thinkingLevel',
  'cwd',
]);
const ASSISTANT_THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const ASSISTANT_MODEL_REF_RE = /^[^/\s]+\/.+$/u;
const ASSISTANT_DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isAbsoluteBotPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && value.isWellFormed()
    && value.trim() === value
    && !/[\x00-\x1f\x7f]/.test(value)
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/]+[^\\/]+/.test(value));
}

function assertAllowedRouteFields(obj, allowed) {
  requireObject(obj);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail('INVALID_ARGUMENT', `Unknown field: ${key}`);
  }
  return obj;
}

function validateCreateBotInput(raw) {
  if (raw === undefined) {
    return {
      role: '邮件与日程管家',
      description: '专职负责 Gmail 邮件与 Google Calendar 日程的主动感知、摘要与回复草稿准备',
      modelRef: undefined,
      thinkingLevel: undefined,
      cwd: undefined,
    };
  }
  const obj = assertAllowedRouteFields(raw, ASSISTANT_CREATE_BOT_FIELDS);
  const role = obj.role !== undefined
    ? optionalBoundedText(obj.role, 'createBot.role', 80) ?? fail('INVALID_ARGUMENT', 'Invalid createBot.role')
    : '邮件与日程管家';
  let description = '专职负责 Gmail 邮件与 Google Calendar 日程的主动感知、摘要与回复草稿准备';
  if (obj.description !== undefined) {
    if (typeof obj.description !== 'string' || !obj.description.isWellFormed() || obj.description.length > 2000) {
      fail('INVALID_ARGUMENT', 'Invalid createBot.description');
    }
    description = obj.description.trim();
  }
  let modelRef;
  if (obj.modelRef !== undefined) {
    if (obj.modelRef === null) {
      modelRef = null;
    } else if (
      typeof obj.modelRef === 'string'
      && obj.modelRef.isWellFormed()
      && obj.modelRef.trim() === obj.modelRef
      && obj.modelRef.length <= 512
      && !/[\x00-\x1f\x7f]/.test(obj.modelRef)
      && ASSISTANT_MODEL_REF_RE.test(obj.modelRef)
    ) {
      modelRef = obj.modelRef;
    } else {
      fail('INVALID_ARGUMENT', 'Invalid createBot.modelRef');
    }
  }
  let thinkingLevel;
  if (obj.thinkingLevel !== undefined) {
    if (obj.thinkingLevel === null) {
      thinkingLevel = null;
    } else if (typeof obj.thinkingLevel === 'string' && ASSISTANT_THINKING_LEVELS.has(obj.thinkingLevel)) {
      thinkingLevel = obj.thinkingLevel;
    } else {
      fail('INVALID_ARGUMENT', 'Invalid createBot.thinkingLevel');
    }
  }
  let cwd;
  if (obj.cwd !== undefined) {
    if (!isAbsoluteBotPath(obj.cwd)) {
      fail('INVALID_ARGUMENT', 'createBot.cwd must be a non-empty absolute path');
    }
    cwd = obj.cwd;
  }
  return { role, description, modelRef, thinkingLevel, cwd };
}

export function registerGoogleWorkspaceRoutes(app, { route, store, bridge, publicUrl, google, notifyDevice, notify, learning, packages } = {}) {
  const { accounts, rules } = google || {};
  if (!accounts) throw new Error('google.accounts is required');
  const notifyConfig = typeof notifyDevice === 'function'
    ? notifyDevice
    : (typeof notify === 'function' ? notify : null);

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
      const result = await accounts.manage(action, body, ownerKey);
      if (action === 'remove' && result?.removed === true) {
        try { rules?.onAccountRemoved?.(result.email ?? body.account); } catch { /* non-fatal runtime sync */ }
      } else if (action === 'check') {
        try { rules?.onAccountChanged?.(body.account); } catch { /* non-fatal runtime sync */ }
      }
      return result;
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
      if (safe.ok && safe.phase === 'connected') {
        try { rules?.onAccountChanged?.(safe.account?.email); } catch { /* non-fatal runtime sync */ }
      }
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
        ?? STANDARD_CLIENT_ERROR_STATUS[code]
        ?? 400;
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
      const deviceId = optionalBoundedText(req.query?.deviceId, 'deviceId', 128);
      const botId = optionalBoundedText(req.query?.botId, 'botId', 128);
      const account = optionalBoundedText(req.query?.account, 'account', 320);
      const enabled = optionalQueryBoolean(req.query?.enabled, 'enabled');
      const filter = {
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(botId !== undefined ? { botId } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      };
      return await rules.manage('list', filter);
    }));

    route('POST', '/api/google/rules/save', runOwner(async (req) => {
      const body = requireObject(req.body);
      return await rules.manage('save', body);
    }), true, GOOGLE_RULE_BODY_LIMIT);

    route('POST', '/api/google/rules/remove', runOwner(async (req) => {
      const body = requireObject(req.body);
      return await rules.manage('remove', body);
    }), true, GOOGLE_ACTION_BODY_LIMIT);

    route('GET', '/api/google/rules/:id/events', runOwner(async (req) => {
      const ruleId = optionalBoundedText(req.params?.id, 'id', 128);
      if (!ruleId) fail('INVALID_ARGUMENT', 'Invalid id');
      const limit = optionalQueryInt(req.query?.limit, 'limit', 1, 200);
      return await rules.manage('events', {
        ruleId,
        ...(limit !== undefined ? { limit } : {}),
      });
    }));

    if (typeof rules.assistantManage === 'function') {
      route('GET', '/api/google/assistant', runOwner(async () => rules.assistantManage('get')));

      route('POST', '/api/google/assistant/save', runOwner(async (req) => {
        const body = requireObject(req.body);
        const previous = typeof store?.getGoogleAssistant === 'function' ? store.getGoogleAssistant() : null;
        const result = await rules.assistantManage('save', body);
        const nextDeviceId = result?.assistant?.deviceId;
        if (nextDeviceId) notifyConfig?.(nextDeviceId, 'config-changed');
        if (previous?.deviceId && previous.deviceId !== nextDeviceId) {
          notifyConfig?.(previous.deviceId, 'config-changed');
        }
        try { rules?.onAccountChanged?.(); } catch { /* non-fatal runtime sync */ }
        return result;
      }), true, GOOGLE_RULE_BODY_LIMIT);

      route('POST', '/api/google/assistant/setup', runOwner(async (req) => {
        const body = assertAllowedRouteFields(req.body, ASSISTANT_SETUP_FIELDS);
        const mode = body.mode === 'dedicated' || body.mode === 'existing'
          ? body.mode
          : fail('INVALID_ARGUMENT', 'mode must be dedicated or existing');
        const deviceId = optionalBoundedText(body.deviceId, 'deviceId', 128);
        if (!deviceId) fail('INVALID_ARGUMENT', 'deviceId is required');
        if (bridge?.registry) {
          const device = bridge.registry.get(deviceId);
          if (!device || device.revokedAt !== null || deviceId === bridge.deviceId) {
            fail('NOT_FOUND', 'Device not found');
          }
        }

        // Pre-validate common schedule/account inputs before any Host RPC side effects.
        if (body.batchWindowMinutes !== undefined && (!Number.isInteger(body.batchWindowMinutes) || body.batchWindowMinutes < 1 || body.batchWindowMinutes > 1440)) {
          fail('INVALID_ARGUMENT', 'batchWindowMinutes must be an integer between 1 and 1440');
        }
        if (body.digestTimes !== undefined) {
          if (!Array.isArray(body.digestTimes) || body.digestTimes.length > 6 || body.digestTimes.some(item => typeof item !== 'string' || !ASSISTANT_DIGEST_TIME_RE.test(item.trim()))) {
            fail('INVALID_ARGUMENT', 'Invalid digestTimes');
          }
        }
        if (body.calendarEnabled !== undefined && typeof body.calendarEnabled !== 'boolean') {
          fail('INVALID_ARGUMENT', 'calendarEnabled must be a boolean');
        }
        if (body.calendarLeadMinutes !== undefined && (!Number.isInteger(body.calendarLeadMinutes) || body.calendarLeadMinutes < 0 || body.calendarLeadMinutes > 1440)) {
          fail('INVALID_ARGUMENT', 'calendarLeadMinutes must be an integer between 0 and 1440');
        }
        if (body.hindsightPrivateMemory !== undefined && typeof body.hindsightPrivateMemory !== 'boolean') {
          fail('INVALID_ARGUMENT', 'hindsightPrivateMemory must be a boolean');
        }

        const googleStatus = await accounts.status();
        let resolvedAccounts;
        if (body.accounts !== undefined) {
          if (!Array.isArray(body.accounts) || body.accounts.length === 0 || body.accounts.length > 20) {
            fail('INVALID_ARGUMENT', 'accounts must be a non-empty array');
          }
          const matchedList = [];
          for (const rawAcct of body.accounts) {
            const textAcct = optionalBoundedText(rawAcct, 'accounts entry', 200);
            if (!textAcct) fail('INVALID_ARGUMENT', 'Invalid accounts entry');
            const lowered = textAcct.toLowerCase();
            const found = (googleStatus?.accounts ?? []).find(
              entry => entry && (
                (typeof entry.email === 'string' && entry.email.toLowerCase() === lowered)
                || (typeof entry.id === 'string' && entry.id.toLowerCase() === lowered)
              ),
            );
            if (!found || typeof found.email !== 'string') {
              fail('NOT_FOUND', `Google account not found: ${textAcct}`);
            }
            matchedList.push(found.email.toLowerCase());
          }
          resolvedAccounts = [...new Set(matchedList)].sort();
        } else {
          const connected = (googleStatus?.accounts ?? [])
            .filter(entry => entry && entry.status === 'connected' && typeof entry.email === 'string')
            .map(entry => entry.email.toLowerCase());
          if (connected.length === 0) {
            fail('INVALID_STATE', 'No connected Google account is available');
          }
          resolvedAccounts = [...new Set(connected)].sort();
        }

        const previous = typeof store?.getGoogleAssistant === 'function' ? store.getGoogleAssistant() : null;
        let targetBotId = optionalBoundedText(body.botId, 'botId', 128);
        let createdBot;

        if (mode === 'existing') {
          if (body.createBot !== undefined) {
            fail('INVALID_ARGUMENT', 'createBot is only allowed when mode is dedicated');
          }
          if (!targetBotId) {
            fail('INVALID_ARGUMENT', 'botId is required when mode is existing');
          }
        } else if (body.createBot !== undefined || !targetBotId) {
          if (typeof bridge?.call !== 'function') {
            fail('INVALID_STATE', 'Host bridge is unavailable to create a dedicated Bot');
          }
          const createSpec = validateCreateBotInput(body.createBot);
          const created = await bridge.call(deviceId, 'createBot', {
            requestId: randomUUID(),
            role: createSpec.role,
            ...(createSpec.description ? { description: createSpec.description } : {}),
            ...(createSpec.cwd ? { cwd: createSpec.cwd } : {}),
          });
          const createdBotId = optionalBoundedText(created?.botId, 'created botId', 128);
          if (!createdBotId) {
            fail('INVALID_STATE', 'Host createBot did not return a valid botId');
          }
          if (typeof store?.upsertDeviceBot === 'function') {
            let botRecord = store.upsertDeviceBot(deviceId, {
              ...created,
              deviceId,
              botId: createdBotId,
              name: typeof created?.name === 'string' ? created.name : (created?.role ?? createSpec.role),
            });
            if (botRecord.cwd === undefined && typeof created?.cwd === 'string' && isAbsoluteBotPath(created.cwd)) {
              try {
                botRecord = store.upsertDeviceBot(
                  deviceId,
                  { botId: botRecord.botId, name: botRecord.name },
                  { kind: 'cwd', expectedRevision: 0, value: created.cwd },
                );
              } catch (err) {
                if (err?.code !== 'REVISION_CONFLICT') throw err;
              }
            }
          }
          try { await packages?.reconcileDevice?.(deviceId); } catch { /* best-effort */ }

          let soulApplied = false;
          try {
            const currentSoul = await bridge.call(deviceId, 'getBotSoul', { botId: createdBotId });
            if (typeof currentSoul?.revision === 'string' && currentSoul.revision) {
              await bridge.call(deviceId, 'setBotSoul', {
                botId: createdBotId,
                input: {
                  expectedRevision: currentSoul.revision,
                  text: DEFAULT_GOOGLE_ASSISTANT_SOUL,
                },
              });
              soulApplied = true;
            }
          } catch { /* best-effort */ }

          let modelApplied = false;
          if (
            (createSpec.modelRef !== undefined || createSpec.thinkingLevel !== undefined)
            && typeof store?.getBotModelConfig === 'function'
            && typeof store?.putBotModelConfig === 'function'
          ) {
            try {
              const currentModel = store.getBotModelConfig(deviceId, createdBotId);
              const nextOverrides = { ...(currentModel?.overrides || {}) };
              if (createSpec.modelRef !== undefined) {
                if (createSpec.modelRef === null) delete nextOverrides.modelRef;
                else nextOverrides.modelRef = createSpec.modelRef;
              }
              if (createSpec.thinkingLevel !== undefined) {
                if (createSpec.thinkingLevel === null) delete nextOverrides.thinkingLevel;
                else nextOverrides.thinkingLevel = createSpec.thinkingLevel;
              }
              store.putBotModelConfig(deviceId, createdBotId, currentModel?.revision ?? 0, nextOverrides);
              modelApplied = true;
            } catch { /* best-effort */ }
          }

          if (learning) {
            try {
              if (typeof learning.configure === 'function') {
                await learning.configure(
                  { deviceId, botId: createdBotId },
                  { expectedRevision: 0, config: { review: { enabled: false } } },
                );
              } else if (typeof learning.execute === 'function') {
                const statusRes = await learning.execute({ deviceId, botId: createdBotId }, { action: 'status' });
                await learning.execute(
                  { deviceId, botId: createdBotId },
                  {
                    action: 'configure',
                    expectedRevision: statusRes?.settings?.revision ?? 0,
                    config: { review: { enabled: false } },
                  },
                );
              }
            } catch { /* best-effort */ }
          }

          targetBotId = createdBotId;
          createdBot = {
            deviceId,
            botId: createdBotId,
            role: createSpec.role,
            soulApplied,
            modelApplied,
          };
        }

        const savePayload = {
          enabled: true,
          deviceId,
          botId: targetBotId,
          mode,
          accounts: resolvedAccounts,
          batchWindowMinutes: body.batchWindowMinutes ?? 10,
          digestTimes: body.digestTimes !== undefined
            ? body.digestTimes
            : (mode === 'existing' ? ['09:00', '18:00'] : []),
          calendarEnabled: body.calendarEnabled ?? true,
          calendarLeadMinutes: body.calendarLeadMinutes ?? 15,
          hindsightPrivateMemory: body.hindsightPrivateMemory !== undefined
            ? body.hindsightPrivateMemory
            : mode === 'dedicated',
        };
        const result = await rules.assistantManage('save', savePayload);
        notifyConfig?.(deviceId, 'config-changed');
        if (previous?.deviceId && previous.deviceId !== deviceId) {
          notifyConfig?.(previous.deviceId, 'config-changed');
        }
        try { rules?.onAccountChanged?.(); } catch { /* non-fatal runtime sync */ }
        return {
          ...result,
          ...(createdBot ? { createdBot } : {}),
        };
      }), true, GOOGLE_RULE_BODY_LIMIT);

      route('POST', '/api/google/assistant/remove', runOwner(async (req) => {
        const body = requireObject(req.body ?? {});
        const previous = typeof store?.getGoogleAssistant === 'function' ? store.getGoogleAssistant() : null;
        const result = await rules.assistantManage('remove', body);
        if (previous?.deviceId) {
          notifyConfig?.(previous.deviceId, 'config-changed');
        }
        return { removed: Boolean(result?.removed) };
      }), true, GOOGLE_ACTION_BODY_LIMIT);

      route('GET', '/api/google/assistant/events', runOwner(async (req) => {
        const limit = optionalQueryInt(req.query?.limit, 'limit', 1, 200);
        return await rules.assistantManage('events', {
          ...(limit !== undefined ? { limit } : {}),
        });
      }));
    }
  }
}
