import { randomBytes } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', 'Expected an object');
  return value;
}
function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT', 'Unknown field');
  return value;
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) fail('INVALID_ARGUMENT', `Invalid ${name}`);
  return value;
}
function routeInput(value, create = false) {
  const body = fields(value, create ? ['name', 'deviceId', 'botId', 'instruction', 'enabled'] : ['name', 'instruction', 'enabled']);
  const enabled = create && body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== 'boolean') fail('INVALID_ARGUMENT', 'Invalid enabled');
  return {
    name: text(body.name, 'name', 80).trim(),
    instruction: text(body.instruction, 'instruction', 8000),
    enabled,
    ...(create ? { deviceId: text(body.deviceId, 'deviceId', 128), botId: text(body.botId, 'botId', 128) } : {}),
  };
}
function receiptInput(value) {
  const body = fields(value, ['status', 'error']);
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(body.status)) fail('INVALID_ARGUMENT', 'Invalid webhook receipt');
  let error = null;
  if (body.error != null) {
    fields(body.error, ['code', 'message']);
    if (typeof body.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(body.error.code) || typeof body.error.message !== 'string') {
      fail('INVALID_ARGUMENT', 'Invalid webhook error');
    }
    error = { code: body.error.code, message: body.error.message.slice(0, 300) };
  }
  return { status: body.status, error };
}

// Sort object keys without recursion: even a deeply nested, size-bounded JSON body is untrusted.
function stablePayload(payload) {
  object(payload);
  const chunks = [];
  const stack = [{ value: payload }];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') { chunks.push(item); continue; }
    const value = item.value;
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) fail('INVALID_ARGUMENT', 'Invalid JSON number');
      chunks.push(JSON.stringify(value));
      continue;
    }
    const array = Array.isArray(value);
    const keys = array ? Object.keys(value) : Object.keys(value).sort();
    chunks.push(array ? '[' : '{');
    stack.push(array ? ']' : '}');
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      stack.push({ value: value[key] });
      if (!array) stack.push(JSON.stringify(key) + ':');
      if (index > 0) stack.push(',');
    }
  }
  return chunks.join('');
}
const bearer = req => /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization || '')?.[1];

export function registerWebhookRoutes(app, { store, bridge, route, host, publicUrl, notify }) {
  const present = value => ({ ...value, url: new URL(`/api/webhooks/${value.id}/events`, publicUrl).href });
  const changed = value => { notify(value.deviceId); return present(value); };
  route('GET', '/api/webhooks', () => ({ items: store.listWebhookRoutes().map(present) }));
  route('POST', '/api/webhooks', (req, reply) => {
    const input = routeInput(req.body, true);
    const device = bridge.registry.get(input.deviceId);
    if (!device || device.revokedAt !== null || input.deviceId === bridge.deviceId) fail('NOT_FOUND', 'Device not found');
    if (!store.listDeviceBots(input.deviceId).some(bot => bot.botId === input.botId)) fail('BOT_NOT_FOUND', 'Bot not found');
    const token = randomBytes(32).toString('base64url');
    const value = store.createWebhookRoute(input, token);
    return reply.code(201).send({ route: changed(value), token });
  }, true);
  route('PUT', '/api/webhooks/:id', req => changed(store.updateWebhookRoute(req.params.id, routeInput(req.body))), true);
  route('POST', '/api/webhooks/:id/rotate-token', req => {
    fields(req.body, []);
    const token = randomBytes(32).toString('base64url');
    return { route: changed(store.rotateWebhookToken(req.params.id, token)), token };
  }, true);
  route('DELETE', '/api/webhooks/:id', (req, reply) => {
    const value = store.deleteWebhookRoute(req.params.id);
    notify(value.deviceId);
    return reply.code(204).send();
  }, true);
  route('GET', '/api/webhooks/:id/events', req => ({ items: store.listWebhookEvents(req.params.id) }));

  app.post('/api/webhooks/:id/events', {
    bodyLimit: 64 * 1024,
    onRequest(req, _reply, done) {
      store.authenticateWebhookRoute(req.params.id, bearer(req));
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') fail('INVALID_ARGUMENT', 'Content-Type must be application/json');
      done();
    },
    preHandler: app.rateLimit({ max: 30, timeWindow: 60 * 1000, keyGenerator: req => req.params.id }),
  }, (req, reply) => {
    const key = text(req.headers['idempotency-key'], 'Idempotency-Key', 200);
    const { event, created } = store.acceptWebhookEvent(req.params.id, bearer(req), key, stablePayload(req.body));
    if (created) notify(event.deviceId);
    return reply.code(202).send({ eventId: event.id, status: event.status });
  });

  host('POST', '/api/host/webhook-events/poll', req => {
    fields(req.body, []);
    return { items: store.pollWebhookEvents(req.centerDevice.deviceId) };
  });
  host('POST', '/api/host/webhook-events/:id/receipt', req =>
    store.reportWebhookEvent(req.centerDevice.deviceId, req.params.id, receiptInput(req.body)));
}
