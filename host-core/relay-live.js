// host-core/relay-live.js
// Module 14: bounded correlation table for relayed live observations. Stores
// only the exact client/host connection objects, watchId/routeId/
// targetDeviceId/target, the last sequence + conversationId and an opening
// deadline — never snapshots/docs/args; payload exists only on the current
// call stack while a frame is forwarded.
import { randomUUID } from 'node:crypto';
import {
  LIVE_OPEN_TIMEOUT_MS,
  LIVE_MAX_CLIENT_SUBSCRIPTIONS,
  LIVE_MAX_HOST_SUBSCRIPTIONS,
  LIVE_MAX_SUBSCRIPTIONS,
  normalizeLiveSnapshot
} from './remote-live-protocol.js';

export {
  LIVE_OPEN_TIMEOUT_MS,
  LIVE_MAX_CLIENT_SUBSCRIPTIONS,
  LIVE_MAX_HOST_SUBSCRIPTIONS,
  LIVE_MAX_SUBSCRIPTIONS
};

export function openLiveRoutes() {
  // No per-client index: reads scan the bounded byRouteId table (<=128 rows)
  // like controlRoutes, so no per-connection map survives a disconnect.
  const byRouteId = new Map();

  function countClient(client) {
    let n = 0;
    for (const record of byRouteId.values()) {
      if (record.client === client) n += 1;
    }
    return n;
  }

  function countHost(host) {
    let n = 0;
    for (const record of byRouteId.values()) {
      if (record.host === host) n += 1;
    }
    return n;
  }

  return {
    open(client, watchId, host, targetDeviceId, target) {
      if (
        byRouteId.size >= LIVE_MAX_SUBSCRIPTIONS ||
        countClient(client) >= LIVE_MAX_CLIENT_SUBSCRIPTIONS ||
        countHost(host) >= LIVE_MAX_HOST_SUBSCRIPTIONS
      ) {
        return null;
      }
      const record = {
        client,
        watchId,
        host,
        targetDeviceId,
        target,
        routeId: randomUUID(),
        seq: null,
        conversationId: null,
        opening: true,
        openingDeadline: Date.now() + LIVE_OPEN_TIMEOUT_MS,
      };
      byRouteId.set(record.routeId, record);
      return record;
    },
    findByRoute(routeId) {
      return byRouteId.get(routeId);
    },
    findByClientWatch(client, watchId) {
      for (const record of byRouteId.values()) {
        if (record.client === client && record.watchId === watchId) return record;
      }
      return undefined;
    },
    remove(routeId) {
      const record = byRouteId.get(routeId);
      if (record !== undefined) byRouteId.delete(routeId);
      return record;
    },
    listForClient(client) {
      return [...byRouteId.values()].filter((record) => record.client === client);
    },
    listForHost(host) {
      return [...byRouteId.values()].filter((record) => record.host === host);
    },
    countClient,
    countHost,
    size() {
      return byRouteId.size;
    },
    expiredOpening(now) {
      return [...byRouteId.values()].filter(
        (record) => record.opening && record.openingDeadline <= now
      );
    },
    // Validate a host-supplied snapshot against the stored target and per-route
    // monotonic sequence / conversationId transition rules. Returns the
    // normalized snapshot on success; on violation the caller closes the host
    // and nothing is forwarded. No payload is retained in the record.
    applyFrame(record, frame) {
      let snapshot;
      try {
        snapshot = normalizeLiveSnapshot(frame, record.target);
      } catch {
        return { ok: false };
      }
      if (record.seq !== null && snapshot.sequence <= record.seq) {
        return { ok: false };
      }
      if (
        record.conversationId !== null &&
        (snapshot.conversationId === null ||
          snapshot.conversationId !== record.conversationId)
      ) {
        return { ok: false };
      }
      record.seq = snapshot.sequence;
      if (record.conversationId === null) {
        record.conversationId = snapshot.conversationId;
      }
      if (record.opening) {
        record.opening = false;
        delete record.openingDeadline;
      }
      return { ok: true, snapshot };
    },
    clear() {
      byRouteId.clear();
    },
  };
}
