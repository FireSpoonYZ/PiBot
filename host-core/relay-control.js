// host-core/relay-control.js
// Module 9: bounded correlation table for relayed control calls. Stores only
// the exact client/host connection objects, callId/routeId/targetDeviceId and a
// deadline — never the method/params/result/body of a call. All capacity and
// timeout bounds live with the table so the server cannot drift from them.
// The per-call timeout is supplied by the caller (memory methods get the
// longer budget) and defaults to the shared control timeout.
import { randomUUID } from 'node:crypto';
import {
  CONTROL_TIMEOUT_MS,
  CONTROL_MAX_CLIENT_CALLS,
  CONTROL_MAX_HOST_CALLS,
  CONTROL_MAX_PENDING
} from './remote-control-protocol.js';

export {
  CONTROL_TIMEOUT_MS,
  CONTROL_MAX_CLIENT_CALLS,
  CONTROL_MAX_HOST_CALLS,
  CONTROL_MAX_PENDING
};

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
    countClient(client) {
      let n = 0;
      for (const record of byRouteId.values()) {
        if (record.client === client) n += 1;
      }
      return n;
    },
    countHost(host) {
      let n = 0;
      for (const record of byRouteId.values()) {
        if (record.host === host) n += 1;
      }
      return n;
    },
    size() {
      return byRouteId.size;
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
