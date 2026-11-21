import { connect } from 'node:net';
import { BrowserEgressChannel } from './egress-channel.js';
import { EGRESS_MAX_STREAMS } from './egress-protocol.js';
import { relayControlCaller } from '../host-control.js';

export function createBrowserEgressHost({ execute, deviceId, controlUrl, send }) {
  const streams = new Map();
  let controlPort = null;
  try { const url = new URL(controlUrl); controlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80)); } catch { /* absent adapter is rejected below */ }
  function reset() {
    for (const record of streams.values()) {
      record.abort.abort();
      record.channel.destroy();
      record.socket?.destroy();
    }
    streams.clear();
  }
  function handle(frame) {
    if (frame.op !== 'open') {
      streams.get(frame.id)?.channel.accept(frame);
      return;
    }
    if (!execute || !frame.fromDeviceId || frame.targetDeviceId || streams.has(frame.id) || streams.size >= EGRESS_MAX_STREAMS) {
      send({ type: 'browser-egress', op: 'close', id: frame.id });
      return;
    }
    const record = { abort: new AbortController(), socket: null, channel: null };
    const channel = new BrowserEgressChannel(frame.id, send, () => {
      record.abort.abort();
      record.socket?.destroy();
      streams.delete(frame.id);
    });
    record.channel = channel;
    streams.set(frame.id, record);
    channel.on('error', () => {});
    Promise.resolve().then(() => execute(deviceId, 'browserControl', {
      action: 'rendererEgressAuthorize', botId: frame.botId, rendererId: frame.rendererId,
    }, { signal: record.abort.signal, caller: relayControlCaller(frame.fromDeviceId) })).then((policy) => {
      if (channel.destroyed) return;
      const ports = [80, 443, ...(Array.isArray(policy?.allowedPorts) ? policy.allowedPorts : [])];
      if (policy?.allowed !== true || !ports.includes(frame.port) || frame.port === controlPort ||
          policy.blockedPorts?.includes(frame.port)) throw new Error('Browser destination denied');
      // DNS and TCP connection occur only here on the authenticated target Host.
      const socket = connect({ host: frame.host, port: frame.port });
      record.socket = socket;
      socket.setNoDelay(true);
      socket.on('error', () => channel.destroy());
      socket.on('close', () => { if (!socket.readableEnded) channel.destroy(); });
      socket.once('connect', () => {
        if (channel.destroyed) return socket.destroy();
        channel.ready = true;
        channel.frame('ready');
        channel.pipe(socket);
        socket.pipe(channel);
      });
    }).catch(() => channel.destroy());
  }
  return { handle, reset, close: reset };
}
