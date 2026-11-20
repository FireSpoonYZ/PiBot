export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setNoStoreHeaders(reply) {
  reply
    .header('Cache-Control', 'no-store')
    .header('Pragma', 'no-cache')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff');
}

export function setHtmlSecurityHeaders(reply, { formAction = "'none'" } = {}) {
  setNoStoreHeaders(reply);
  reply
    .header('X-Frame-Options', 'DENY')
    .header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`,
    )
    .type('text/html; charset=utf-8');
}

function pageShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; line-height: 1.5; }
  main { max-width: 620px; margin: 24px auto; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; }
  h1 { margin: 0 0 12px; font-size: 20px; color: #f8fafc; }
  h2 { margin: 18px 0 8px; font-size: 15px; color: #cbd5e1; }
  p { margin: 8px 0; color: #cbd5e1; }
  .notice { background: #451a03; border: 1px solid #b45309; color: #fde68a; padding: 12px 14px; border-radius: 8px; margin: 14px 0; font-size: 14px; }
  .meta { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; font-size: 13px; word-break: break-all; }
  .meta dt { color: #94a3b8; font-weight: 600; margin-top: 8px; }
  .meta dt:first-child { margin-top: 0; }
  .meta dd { margin: 2px 0 0; color: #f1f5f9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  ul { margin: 8px 0; padding-left: 20px; }
  li { margin: 4px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #f1f5f9; }
  .muted { color: #94a3b8; font-size: 13px; }
  .actions { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
  button, a.btn { display: inline-block; padding: 10px 18px; border-radius: 8px; border: 1px solid transparent; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; }
  .approve { background: #2563eb; color: #ffffff; }
  .deny { background: #334155; color: #e2e8f0; border-color: #475569; }
</style>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

export function renderConsentPage({
  authorizePath,
  clientId,
  redirectUri,
  resource,
  scopes,
  botTargets,
  consentId,
  csrfToken,
}) {
  const scopeItems = scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('');
  const botTargetSection = botTargets.length > 0
    ? `<ul>${botTargets.map((target) => `<li>device=${escapeHtml(target.deviceId)} / bot=${escapeHtml(target.botId)}</li>`).join('')}</ul>`
    : '<p class="muted">No dispatch Bots configured for this client (dispatch targets: none).</p>';

  const body = `
<h1>Authorize MCP OAuth Access</h1>
<p>Client <strong>${escapeHtml(clientId)}</strong> is requesting scoped OAuth access to this PiBot Center MCP endpoint.</p>
<div class="notice">
  <strong>Center-wide scope warning:</strong> Approving this request grants <strong>Center-wide scope</strong> permissions for the scopes listed below on <code>${escapeHtml(resource)}</code>. Access tokens are short-lived and stored in server memory; restarting Center requires re-authorization.
</div>
<dl class="meta">
  <dt>Client ID</dt>
  <dd>${escapeHtml(clientId)}</dd>
  <dt>Protected Resource</dt>
  <dd>${escapeHtml(resource)}</dd>
  <dt>Redirect URI</dt>
  <dd>${escapeHtml(redirectUri)}</dd>
</dl>
<h2>Requested Center-wide Scopes</h2>
<ul>${scopeItems}</ul>
<h2>Configured Dispatch Bots</h2>
${botTargetSection}
<form method="POST" action="${escapeHtml(authorizePath)}">
  <input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
  <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
  <div class="actions">
    <button type="submit" name="decision" value="approve" class="approve">Approve Access</button>
    <button type="submit" name="decision" value="deny" class="deny">Deny</button>
  </div>
</form>`;

  return pageShell('Authorize MCP OAuth Access', body);
}

export function renderLoginRequiredPage({ clientId, continueHref }) {
  const body = `
<h1>Owner Sign-In Required</h1>
<p>You must be signed in as the Center owner in this browser session to review and approve MCP OAuth access for <strong>${escapeHtml(clientId)}</strong>.</p>
<p class="muted">Bearer tokens and device credentials are not accepted for owner authorization.</p>
<div class="actions">
  <a class="btn approve" href="${escapeHtml(continueHref)}">Continue to Consent</a>
  <a class="btn deny" href="/" target="_blank" rel="noopener noreferrer">Open Center Sign-In</a>
</div>`;

  return pageShell('Owner Sign-In Required', body);
}

export function renderErrorPage({ title, message }) {
  const body = `
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>`;

  return pageShell(title, body);
}
