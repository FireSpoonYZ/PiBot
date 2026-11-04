import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { openRelayServer } from '../host-core/relay-server.js';
import { openCenterStore } from './data/index.js';
import { openPackageManager } from './packages/index.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';
import { openHostBridge } from './host-bridge.js';
import { openCenterExecution } from './execution.js';
import { openTurnAdmission } from './turns.js';
import { openMcpOAuth } from './oauth/index.js';

const require = createRequire(import.meta.url);
const status = { INVALID_ARGUMENT: 400, INVALID_CWD: 400, UNSUPPORTED_TARGET: 400, VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, CSRF_INVALID: 403, NOT_FOUND: 404, BOT_NOT_FOUND: 404, REVISION_CONFLICT: 409, REQUEST_CONFLICT: 409, TURN_SET_CHANGED: 409, TURN_SYNC_FAILED: 409, TURN_RECOVERY_REQUIRED: 403, INVALID_STATE: 409, PRIMARY_BOT_PROTECTED: 409, BOT_ARCHIVED: 409, PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, CENTER_OFFLINE: 503, DEVICE_OFFLINE: 503 };

export async function openCenterServer({ dataRoot, encryptionKey, sessionKey, ownerPasswordHash, https, listenHost = '127.0.0.1', port = 8443, relay: relayOptions, webRoot, npmPath, publicUrl }) {
  if (!relayOptions?.tls?.cert || !relayOptions?.tls?.key || !https?.cert || !https?.key || !publicUrl || new URL(publicUrl).protocol !== 'https:' || new URL(relayOptions.linkUrl).protocol !== 'wss:') throw new Error('HTTPS and TLS relay are required');
  if (!(encryptionKey instanceof Uint8Array) || !(sessionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32 || sessionKey.byteLength !== 32 || Buffer.from(encryptionKey).equals(Buffer.from(sessionKey))) throw new Error('Independent encryption and session keys are required');
  let store, relay, bridge, packages, execution, oauth, routes, app;
  let closing;
  async function close() {
    if (!closing) closing = (async () => {
      const errors = [];
      for (const fn of [() => routes?.close(), () => app?.close(), () => packages?.close(), () => execution?.close(), () => oauth?.close(), () => bridge?.close(), () => relay?.close(), () => store?.close()]) {
        try { await fn(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Center shutdown failed');
    })();
    return closing;
  }
  try {
    store = openCenterStore({ dataRoot, encryptionKey });
    relay = await openRelayServer({ dataRoot, listenHost: relayOptions.listenHost, port: relayOptions.port, tls: relayOptions.tls });
    bridge = openHostBridge({ dataRoot, store, relay, linkUrl: relayOptions.linkUrl, ca: [relayOptions.tls.cert, ...rootCertificates].join('\n') });
    oauth = openMcpOAuth({ store, publicUrl });
    execution = openCenterExecution({ store, packages: { getInstalled: id => packages.getInstalled(id) }, oauth });
    packages = await openPackageManager({ dataRoot, store, npmPath: npmPath || join(dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js'), onChange: id => routes?.notifyInstallation(id), withActivation: (id, publish) => execution.withActivation(id, publish), probeCenterMcp: (installation, config, identity) => execution.probeGlobal(installation, config, identity) });
    app = Fastify({ https, logger: false, bodyLimit: 1024 * 1024 });
    app.addHook('onRequest', (req, reply, done) => {
      if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
      done();
    });
    app.setErrorHandler((error, req, reply) => {
      let code = error.code;
      if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
      else if (error.statusCode === 429) code = 'RATE_LIMITED';
      else if (error.statusCode === 413) code = 'PAYLOAD_TOO_LARGE';
      else if (error.statusCode === 400 && !status[code]) code = 'INVALID_ARGUMENT';
      else if (['OFFLINE', 'NOT_CONNECTED', 'DISCONNECTED', 'CONNECT_FAILED'].includes(code)) code = 'DEVICE_OFFLINE';
      if (!status[code]) code = 'INTERNAL_ERROR';
      reply.code(status[code] || 500).send({ error: { code, message: code === 'INTERNAL_ERROR' ? 'Internal error' : code.replaceAll('_', ' ').toLowerCase() } });
    });
    await registerAuth(app, { sessionKey, ownerPasswordHash });
    await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 0 } });
    const turns = openTurnAdmission({ store, packages });
    routes = registerRoutes(app, { store, packages, bridge, execution, oauth, linkUrl: relayOptions.linkUrl, turns });
    if (webRoot) {
      await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      });
    }
    const url = await app.listen({ host: listenHost, port });
    return { url, linkUrl: relayOptions.linkUrl, close };
  } catch (error) { try { await close(); } catch {} throw error; }
}
