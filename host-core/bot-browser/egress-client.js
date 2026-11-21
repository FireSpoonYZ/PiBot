import { Agent, createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { BrowserEgressChannel } from './egress-channel.js';
import { EGRESS_MAX_STREAMS, readBrowserEgress } from './egress-protocol.js';

export function createBrowserEgressClient({ send, available = () => true }) {
  const streams = new Map();
  const proxies = new Set();
  let closed = false;
  function reset() {
    closed = true;
    for (const proxy of [...proxies]) proxy.close();
    for (const channel of streams.values()) channel.destroy();
    streams.clear();
  }
  async function openBrowserEgress({ targetDeviceId, botId, rendererId }) {
    if (closed || !available() || proxies.size >= 8) throw new Error('Browser egress unavailable');
    const sockets = new Set();
    const ownStreams = new Set();
    let stopped = false;
    function tunnel(host, port) {
      if (stopped || closed || streams.size >= EGRESS_MAX_STREAMS) throw new Error('Browser egress busy');
      const id = randomUUID();
      const frame = readBrowserEgress({ type: 'browser-egress', op: 'open', id, targetDeviceId, botId, rendererId, host, port });
      const channel = new BrowserEgressChannel(id, send, () => { streams.delete(id); ownStreams.delete(channel); });
      channel.on('error', () => {});
      streams.set(id, channel);
      ownStreams.add(channel);
      const sent = send(frame);
      if (sent === false || sent?.ok === false) channel.destroy();
      return channel;
    }
    // Native WebViews use CONNECT for HTTPS. The bytes after CONNECT, including
    // TLS and WebSocket frames, remain opaque to Center and this local proxy.
    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid proxy URL');
        const channel = tunnel(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 80));
        const headers = { ...request.headers, host: url.host, connection: 'close' };
        delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => channel;
        const upstream = httpRequest(url, { method: request.method, headers, agent }, (reply) => {
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
        });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        response.on('close', () => { upstream.destroy(); agent.destroy(); channel.destroy(); });
        request.on('aborted', () => upstream.destroy());
        request.pipe(upstream);
      } catch { response.writeHead(502); response.end(); }
    });
    const rawTunnel = (request, socket, head, connectRequest) => {
      try {
        const url = new URL(connectRequest ? `https://${request.url}` : request.url);
        if (url.protocol !== (connectRequest ? 'https:' : 'http:') || url.username || url.password || (connectRequest && (url.pathname !== '/' || url.search || url.hash))) throw new Error('Invalid tunnel');
        const channel = tunnel(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || (connectRequest ? 443 : 80)));
        socket.pause();
        channel.once('connect', () => {
          if (connectRequest) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          else {
            const headers = { ...request.headers, host: url.host };
            delete headers['proxy-authorization']; delete headers['proxy-connection'];
            channel.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
          }
          if (head.length) channel.write(head);
          socket.pipe(channel); channel.pipe(socket); socket.resume();
        });
        channel.on('close', () => socket.destroy());
        socket.on('error', () => channel.destroy());
        socket.on('close', () => channel.destroy());
      } catch { socket.destroy(); }
    };
    server.on('connect', (request, socket, head) => rawTunnel(request, socket, head, true));
    server.on('upgrade', (request, socket, head) => rawTunnel(request, socket, head, false));
    server.on('clientError', (_error, socket) => socket.destroy());
    server.maxConnections = 64;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.setTimeout(30000, () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    });
    const proxy = { proxyUrl: null, close() {
      stopped = true; proxies.delete(proxy);
      for (const channel of ownStreams) channel.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
    } };
    proxies.add(proxy);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      if (stopped || closed) throw new Error('Browser egress closed');
      proxy.proxyUrl = `http://127.0.0.1:${server.address().port}`;
      return proxy;
    } catch (error) { proxy.close(); throw error; }
  }
  return { openBrowserEgress, reset, handle(frame) { streams.get(frame.id)?.accept(frame); } };
}
