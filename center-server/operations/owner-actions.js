// Fixed adapter for ordinary management actions also served to the web UI.
// A tool cannot supply a verb, URL, session, authorization header, or raw response.
const reusableActions = new Set([
  'GET /api/devices',
  'GET /api/bot-sync',
  'GET /api/client-releases',
  'POST /api/client-releases/:id/publish',
  'PATCH /api/devices/:deviceId',
  'GET /api/devices/:deviceId/runtime-status',
  'GET /api/devices/:deviceId/bots',
  'POST /api/devices/:deviceId/bots',
  'PATCH /api/devices/:deviceId/bots/:botId',
  'POST /api/devices/:deviceId/bots/:botId/primary',
  'POST /api/devices/:deviceId/bots/:botId/archive',
  'POST /api/devices/:deviceId/bots/:botId/unarchive',
  'DELETE /api/devices/:deviceId/bots/:botId',
  'GET /api/devices/:deviceId/bots/:botId/avatar',
  'PUT /api/devices/:deviceId/bots/:botId/avatar',
  'GET /api/devices/:deviceId/bots/:botId/cwd',
  'PUT /api/devices/:deviceId/bots/:botId/cwd',
  'GET /api/devices/:deviceId/bots/:botId/model-config',
  'PUT /api/devices/:deviceId/bots/:botId/model-config',
  'GET /api/devices/:deviceId/bots/:botId/capabilities',
  'GET /api/devices/:deviceId/bots/:botId/capabilities/:id',
  'PUT /api/devices/:deviceId/bots/:botId/capabilities/:id',
  'POST /api/devices/:deviceId/bots/:botId/skills',
  'POST /api/devices/:deviceId/bots/:botId/skill-reviews',
  'POST /api/devices/:deviceId/bots/:botId/learning',
  'POST /api/devices/:deviceId/bots/:botId/installations',
  'GET /api/capabilities',
  'GET /api/installations/:id',
  'PATCH /api/installations/:id',
  'GET /api/installations/:id/config',
  'PUT /api/installations/:id/config',
  'GET /api/installations/:id/deployments',
  'GET /api/installations/:id/actions',
  'GET /api/installations/:id/bot-bindings',
  'GET /api/installations/:id/skill-files',
  'PUT /api/installations/:id/skill-files',
  'POST /api/installations/:id/tools/list',
  'POST /api/installations/:id/validate',
  'POST /api/installations/:id/updates/check',
  'POST /api/installations/:id/update',
  'DELETE /api/installations/:id',
  'POST /api/installations/:id/enable',
  'POST /api/installations/:id/disable',
  'GET /api/operations/:id',
  'GET /api/tasks',
  'POST /api/tasks/action',
  'GET /api/google/rules',
  'GET /api/google/rules/:id/events',
  'POST /api/google/rules/save',
  'POST /api/google/rules/remove',
  'GET /api/google/assistant',
  'GET /api/google/assistant/events',
  'POST /api/google/assistant/save',
  'POST /api/google/assistant/remove',
  'GET /api/webhooks',
  'PUT /api/webhooks/:id',
  'DELETE /api/webhooks/:id',
  'GET /api/webhooks/:id/events',
  'GET /api/model-picker',
  'PUT /api/model-stars',
  'GET /api/model-catalog',
  'POST /api/model-catalog/sync',
  'GET /api/model-config',
  'PUT /api/model-config',
  'GET /api/providers',
  'GET /api/provider-auth-status',
  'GET /api/providers/:id/auth-status',
  'PUT /api/providers/:id',
  'POST /api/providers/:id/validate',
  'POST /api/providers/:id/discover',
  'GET /api/providers/:id',
  'GET /api/providers/:id/models',
  'POST /api/providers/:id/models',
  'POST /api/providers/:id/models/batch',
  'PUT /api/providers/:id/models/:modelId',
  'DELETE /api/providers/:id/models/:modelId',
]);

export function retainOwnerAction(actions, method, path, handler) {
  const key = method + ' ' + path;
  if (reusableActions.has(key)) actions.set(key, handler);
}

export async function invokeOwnerAction(actions, method, path, { params = {}, body, query = {} } = {}) {
  const key = method + ' ' + path;
  const handler = reusableActions.has(key) && actions.get(key);
  if (!handler) throw Object.assign(new Error('Owner action is not reusable'), { code: 'FORBIDDEN' });

  let status = 200;
  let sent = false;
  let payload;
  const reply = {
    header() { return this; },
    code(value) { status = value; return this; },
    send(value) { sent = true; payload = value; return this; },
  };
  const value = await handler({ params, body, query }, reply);
  if (status >= 400) throw Object.assign(new Error('Management action failed'), { code: payload?.error?.code ?? 'INVALID_STATE' });
  return sent ? payload : value;
}
