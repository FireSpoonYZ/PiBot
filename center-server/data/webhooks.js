import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const progress = { dispatching: 0, queued: 1, running: 2 };
const hash = value => createHash('sha256').update(value).digest();

function routeValue(row) {
  return {
    id: row.id, name: row.name, deviceId: row.device_id, botId: row.bot_id,
    instruction: row.instruction, enabled: Boolean(row.enabled),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function eventValue(row, host = false) {
  return {
    id: row.id, routeId: row.route_id, routeName: row.route_name,
    deviceId: row.device_id, botId: row.bot_id, requestId: row.request_id,
    idempotencyKey: row.idempotency_key, status: row.status,
    receivedAt: row.received_at, expiresAt: row.expires_at, updatedAt: row.updated_at,
    ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) }),
    ...(host ? { instruction: row.instruction, payload: JSON.parse(row.payload_json) } : {}),
  };
}

export function webhookStore(db, transaction) {
  function requireRoute(id) {
    const row = db.prepare('SELECT * FROM webhook_routes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) fail('NOT_FOUND', 'Webhook not found');
    return row;
  }
  function authenticate(id, token) {
    const row = requireRoute(id);
    if (typeof token !== 'string' || !timingSafeEqual(hash(token), Buffer.from(row.token_hash, 'hex'))) {
      fail('UNAUTHENTICATED', 'Webhook authentication required');
    }
    return row;
  }
  function cancelPending(where, params, now, code, message) {
    db.prepare(`UPDATE webhook_events SET status = 'cancelled', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND ${where}`).run(now, JSON.stringify({ code, message }), ...params);
  }
  function settlePending(where, params, now) {
    db.prepare(`UPDATE webhook_events SET status = 'expired', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND expires_at <= ? AND ${where}`)
      .run(now, JSON.stringify({ code: 'WEBHOOK_EXPIRED', message: 'Webhook was not dispatched within 24 hours' }), now, ...params);
    cancelPending(`(${where}) AND (
      NOT EXISTS (SELECT 1 FROM webhook_routes r WHERE r.id = webhook_events.route_id AND r.enabled = 1 AND r.deleted_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM device_bots b WHERE b.device_id = webhook_events.device_id AND b.bot_id = webhook_events.bot_id)
    )`, params, now, 'WEBHOOK_UNAVAILABLE', 'Webhook or target is no longer available');
  }
  return {
    listWebhookRoutes() {
      return db.prepare('SELECT * FROM webhook_routes WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC').all().map(routeValue);
    },
    authenticateWebhookRoute(id, token) { return routeValue(authenticate(id, token)); },
    createWebhookRoute(input, token) {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(`INSERT INTO webhook_routes
        (id, name, device_id, bot_id, instruction, enabled, token_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.deviceId, input.botId, input.instruction, input.enabled ? 1 : 0, hash(token).toString('hex'), now, now);
      return routeValue(requireRoute(id));
    },
    updateWebhookRoute(id, input) {
      return transaction(() => {
        requireRoute(id);
        const now = new Date().toISOString();
        db.prepare('UPDATE webhook_routes SET name = ?, instruction = ?, enabled = ?, updated_at = ? WHERE id = ?')
          .run(input.name, input.instruction, input.enabled ? 1 : 0, now, id);
        if (!input.enabled) cancelPending('route_id = ?', [id], now, 'WEBHOOK_DISABLED', 'Webhook was disabled before dispatch');
        return routeValue(requireRoute(id));
      });
    },
    rotateWebhookToken(id, token) {
      requireRoute(id);
      db.prepare('UPDATE webhook_routes SET token_hash = ?, updated_at = ? WHERE id = ?')
        .run(hash(token).toString('hex'), new Date().toISOString(), id);
      return routeValue(requireRoute(id));
    },
    deleteWebhookRoute(id) {
      return transaction(() => {
        const row = requireRoute(id);
        const now = new Date().toISOString();
        db.prepare('UPDATE webhook_routes SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
        cancelPending('route_id = ?', [id], now, 'WEBHOOK_DELETED', 'Webhook was deleted before dispatch');
        return routeValue(row);
      });
    },
    // Called inside the existing Bot deletion/directory replacement transaction.
    cancelWebhookEventsForBot(deviceId, botId) {
      cancelPending('device_id = ? AND bot_id = ?', [deviceId, botId], new Date().toISOString(), 'BOT_NOT_FOUND', 'Target Bot was deleted before dispatch');
    },
    acceptWebhookEvent(id, token, idempotencyKey, payloadJson) {
      return transaction(() => {
        // Recheck after body parsing: deletion, disabling or token rotation may have happened meanwhile.
        const route = authenticate(id, token);
        if (!route.enabled) fail('INVALID_STATE', 'Webhook is disabled');
        const now = new Date().toISOString();
        settlePending('route_id = ?', [id], now);
        const digest = hash(payloadJson).toString('hex');
        const previous = db.prepare('SELECT * FROM webhook_events WHERE route_id = ? AND idempotency_key = ?').get(id, idempotencyKey);
        if (previous) {
          if (previous.body_digest !== digest) fail('REQUEST_CONFLICT', 'Idempotency key was used with a different payload');
          return { event: eventValue(previous), created: false };
        }
        const eventId = randomUUID();
        db.prepare(`INSERT INTO webhook_events
          (id, route_id, route_name, device_id, bot_id, request_id, idempotency_key, body_digest,
           status, received_at, expires_at, updated_at, instruction, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
          .run(eventId, id, route.name, route.device_id, route.bot_id, randomUUID(), idempotencyKey, digest,
            now, new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(), now, route.instruction, payloadJson);
        settlePending('id = ?', [eventId], now);
        return { event: eventValue(db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(eventId)), created: true };
      });
    },
    listWebhookEvents(id) {
      return transaction(() => {
        requireRoute(id);
        settlePending('route_id = ?', [id], new Date().toISOString());
        return db.prepare('SELECT * FROM webhook_events WHERE route_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 100').all(id).map(row => eventValue(row));
      });
    },
    pollWebhookEvents(deviceId) {
      return transaction(() => {
        const now = new Date().toISOString();
        settlePending('device_id = ?', [deviceId], now);
        const rows = db.prepare(`SELECT * FROM webhook_events WHERE device_id = ?
          AND status IN ('pending', 'dispatching', 'queued', 'running') ORDER BY received_at, rowid LIMIT 50`).all(deviceId);
        for (const row of rows) {
          if (row.status !== 'pending') continue;
          db.prepare("UPDATE webhook_events SET status = 'dispatching', updated_at = ? WHERE id = ?").run(now, row.id);
          row.status = 'dispatching';
          row.updated_at = now;
        }
        return rows.map(row => eventValue(row, true));
      });
    },
    reportWebhookEvent(deviceId, id, input) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM webhook_events WHERE id = ? AND device_id = ?').get(id, deviceId);
        if (!row) fail('NOT_FOUND', 'Webhook event not found');
        if (terminal.has(row.status)) return eventValue(row);
        if (row.status === 'pending') fail('INVALID_STATE', 'Webhook event has not been dispatched');
        if (!terminal.has(input.status) && progress[input.status] <= progress[row.status]) return eventValue(row);
        row.status = input.status;
        row.updated_at = new Date().toISOString();
        row.error_json = input.error == null ? null : JSON.stringify(input.error);
        db.prepare('UPDATE webhook_events SET status = ?, updated_at = ?, error_json = ? WHERE id = ?')
          .run(row.status, row.updated_at, row.error_json, id);
        return eventValue(row);
      });
    },
  };
}
