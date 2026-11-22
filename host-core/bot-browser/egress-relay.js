import { randomUUID } from 'node:crypto';
import { EGRESS_MAX_STREAMS, EGRESS_TIMEOUT_MS } from './egress-protocol.js';

export function createBrowserEgressRelay({ findHost, usable, send }) {
  const routes = new Map();
  function finish(route) {
    if (!routes.delete(route.id)) return;
    clearTimeout(route.timer);
    if (usable(route.client)) send(route.client, { type: 'browser-egress', op: 'close', id: route.clientId });
    if (usable(route.host)) send(route.host, { type: 'browser-egress', op: 'close', id: route.id });
  }
  function touch(route) {
    clearTimeout(route.timer);
    route.timer = setTimeout(() => finish(route), EGRESS_TIMEOUT_MS);
    route.timer.unref?.();
  }
  function handle(conn, frame) {
    if (frame.op === 'open') {
      const host = findHost(frame.targetDeviceId);
      const owned = [...routes.values()].filter((route) => route.client === conn);
      if (conn.role !== 'client' || frame.fromDeviceId || !host || !usable(host) || host.controlProtocol !== 2 || !host.browserEgress ||
          routes.size >= 256 || owned.length >= EGRESS_MAX_STREAMS || owned.some((route) => route.clientId === frame.id) ||
          [...routes.values()].filter((route) => route.host === host).length >= 64) {
        send(conn, { type: 'browser-egress', op: 'close', id: frame.id }); return;
      }
      const route = { id: randomUUID(), clientId: frame.id, client: conn, host, ready: false, clientPending: false, hostPending: false };
      routes.set(route.id, route); touch(route);
      const { targetDeviceId, ...outbound } = frame;
      if (!send(host, { ...outbound, id: route.id, fromDeviceId: conn.deviceId })) finish(route);
      return;
    }
    const route = conn.role === 'client'
      ? [...routes.values()].find((item) => item.client === conn && item.clientId === frame.id)
      : routes.get(frame.id);
    if (!route || (conn !== route.client && conn !== route.host)) return;
    if (!usable(route.client) || !usable(route.host) || frame.op === 'close') return finish(route);
    const clientSide = conn === route.client;
    const pending = clientSide ? 'clientPending' : 'hostPending';
    const opposite = clientSide ? 'hostPending' : 'clientPending';
    if (frame.op === 'ready' && !clientSide && !route.ready) route.ready = true;
    else if (frame.op === 'data' && route.ready && !route[pending] && !route[`${pending}Ended`]) route[pending] = true;
    else if (frame.op === 'ack' && route.ready && route[opposite]) route[opposite] = false;
    else if (frame.op === 'fin' && route.ready && !route[pending] && !route[`${pending}Ended`]) route[`${pending}Ended`] = true;
    else return finish(route);
    touch(route);
    if (!send(clientSide ? route.host : route.client, { ...frame, id: clientSide ? route.id : route.clientId })) finish(route);
  }
  return { handle, disconnect(conn) { for (const route of routes.values()) if (route.client === conn || route.host === conn) finish(route); } };
}
