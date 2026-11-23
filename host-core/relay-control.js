// host-core/relay-control.js
// Module 9: correlation table for relayed control calls. Stores only the exact
// client/host connection objects, callId/routeId/targetDeviceId and a deadline
// — never the method/params/result/body of a call. The per-call timeout is
// supplied by the caller (memory methods get the longer budget) and defaults
// to the shared control timeout.
import { randomUUID } from 'node:crypto';
import { CONTROL_TIMEOUT_MS } from './remote-control-protocol.js';

export { CONTROL_TIMEOUT_MS };

export function openControlRoutes() {
  const byRouteId = new Map();

  return {
    add(client, callId, host, targetDeviceId, timeoutMs = CONTROL_TIMEOUT_MS) {
      const record = {
        client,
        callId,
        host,
        targetDeviceId,
        routeId: randomUUID(),
        deadline: Date.now() + timeoutMs,
      };
      byRouteId.set(record.routeId, record);
      return record;
    },
    remove(routeId) {
      const record = byRouteId.get(routeId);
      if (record !== undefined) byRouteId.delete(routeId);
      return record;
    },
    findByRoute(routeId) {
      return byRouteId.get(routeId);
    },
    findByClientCall(client, callId) {
      for (const record of byRouteId.values()) {
        if (record.client === client && record.callId === callId) return record;
      }
      return undefined;
    },
    listForClient(client) {
      return [...byRouteId.values()].filter((record) => record.client === client);
    },
    listForHost(host) {
      return [...byRouteId.values()].filter((record) => record.host === host);
    },
    expired(now) {
      return [...byRouteId.values()].filter((record) => record.deadline <= now);
    },
    clear() {
      byRouteId.clear();
    },
  };
}
