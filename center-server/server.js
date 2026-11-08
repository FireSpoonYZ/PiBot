import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { openRelayServer } from '../host-core/relay-server.js';
import { openCenterStore } from './data/index.js';
import { openPackageManager } from './packages/index.js';
import { registerAuth } from './auth.js';
import { registerClientReleaseRoutes } from './client-releases.js';
import { registerRoutes } from './routes.js';
import { openHostBridge } from './host-bridge.js';
import { openCenterExecution } from './execution.js';
import { openTurnAdmission } from './turns.js';
import { openMcpOAuth } from './oauth/index.js';
import { openSkillManager } from './skills/index.js';
import { runHermes } from './hermes/index.js';
import { openLearningService } from './learning/index.js';
import { openBotManagement } from './bot-management.js';
import { openCenterVault } from './vault.js';
import { initializeBuiltinPlugins } from './builtin-plugins.js';
import { openModelCatalog } from './model-catalog.js';

const require = createRequire(import.meta.url);
const status = { INVALID_ARGUMENT: 400, INVALID_CWD: 400, UNSUPPORTED_TARGET: 400, VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, CSRF_INVALID: 403, NOT_FOUND: 404, BOT_NOT_FOUND: 404, REVISION_CONFLICT: 409, REQUEST_CONFLICT: 409, TURN_SET_CHANGED: 409, TURN_SYNC_FAILED: 409, TURN_RECOVERY_REQUIRED: 403, INVALID_STATE: 409, PRIMARY_BOT_PROTECTED: 409, BOT_ARCHIVED: 409, PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, PACKAGE_NOT_READY: 409, CALL_TIMEOUT: 504, TIMEOUT: 504, HERMES_ERROR: 502, CENTER_OFFLINE: 503, DEVICE_OFFLINE: 503, VAULT_INVALID_ARGUMENT: 400, VAULT_FORBIDDEN: 403, VAULT_NOT_FOUND: 404, VAULT_NOT_CONFIGURED: 409, VAULT_NEEDS_LOGIN: 409, VAULT_LOGIN_CHALLENGE: 409, VAULT_STALE_SESSION: 409, VAULT_CONFLICT: 409, VAULT_REQUEST_EXPIRED: 409, VAULT_REQUEST_BUSY: 409, VAULT_NOT_INITIALIZED: 409, VAULT_ALREADY_INITIALIZED: 409, VAULT_LOCKED: 409, VAULT_UNLOCK_FAILED: 409, VAULT_UNSUPPORTED: 409, VAULT_CONNECTION_FAILED: 502, VAULT_UNAVAILABLE: 503 };

export async function openCenterServer({ dataRoot, encryptionKey, sessionKey, ownerPasswordHash, listenHost = '127.0.0.1', port = 8080, trustProxy = false, webRoot, npmPath, publicUrl }) {
  // Single public HTTPS origin; the WSS link URL, OAuth callback and client
  // downloads are all derived from it. The service itself never terminates TLS:
  // the user's reverse proxy owns certificates and forwards plain HTTP here.
  if (typeof publicUrl !== 'string' || publicUrl === '') throw new Error('publicUrl is required');
  let publicOrigin;
  try { publicOrigin = new URL(publicUrl); } catch { throw new Error('publicUrl must be a valid URL'); }
  if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash || publicOrigin.pathname !== '/') {
    throw new Error('publicUrl must be an HTTPS origin (scheme, host and optional port only)');
  }
  const linkUrl = `wss://${publicOrigin.host}/v1/link`;
  if (!(encryptionKey instanceof Uint8Array) || !(sessionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32 || sessionKey.byteLength !== 32 || Buffer.from(encryptionKey).equals(Buffer.from(sessionKey))) throw new Error('Independent encryption and session keys are required');
  let store, relay, bridge, packages, execution, oauth, routes, app, skills, learning, botManagement, catalog, vault;
  let closing;
  async function close() {
    if (!closing) closing = (async () => {
      const errors = [];
      // Relay WS teardown runs before app.close() so upgraded sockets are
      // stopped while the HTTP listener is still owned by this process.
      // Skill/learning services close before the package manager and store
      // they mutate through; there is nothing to close on botManagement.
      for (const fn of [() => catalog?.close(), () => routes?.close(), () => relay?.close(), () => app?.close(), () => learning?.close(), () => skills?.close(), () => vault?.close(), () => packages?.close(), () => execution?.close(), () => oauth?.close(), () => bridge?.close(), () => store?.close()]) {
        try { await fn(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Center shutdown failed');
    })();
    return closing;
  }
  try {
    store = openCenterStore({ dataRoot, encryptionKey });
    app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy });
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
    // The relay shares this HTTP server: native ws noServer handleUpgrade on
    // /v1/link keeps first-frame auth, hello timeout, backpressure and
    // disconnect cleanup; the center keeps sole ownership of shutdown.
    relay = await openRelayServer({ dataRoot, httpServer: app.server, onHostDisconnect: (deviceId) => { if (!closing) learning?.cancelDevice(deviceId); } });
    bridge = openHostBridge({ dataRoot, store, relay });
    oauth = openMcpOAuth({ store, publicUrl });
    execution = openCenterExecution({ store, packages: { getInstalled: id => packages.getInstalled(id) }, oauth });
    packages = await openPackageManager({ dataRoot, store, npmPath: npmPath || join(dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js'), onChange: id => routes?.notifyInstallation(id), withActivation: (id, publish) => execution.withActivation(id, publish), probeCenterMcp: (installation, config, identity) => execution.probeGlobal(installation, config, identity) });
    await initializeBuiltinPlugins({ dataRoot, store, packages });
    catalog = openModelCatalog({ store, onChange: () => routes?.notifyAll() });
    await registerAuth(app, { sessionKey, ownerPasswordHash });
    // Already configured: unauthenticated read-only probes for setup polling
    // and health checks; no reset or mutation endpoint exists here.
    app.get('/api/setup', () => ({ required: false }));
    app.get('/api/health', () => ({ status: 'ready' }));
    await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 0 } });
    await registerClientReleaseRoutes(app, { store, dataRoot, registry: bridge.registry, internalDeviceId: bridge.deviceId, publicUrl });
    const turns = openTurnAdmission({ store, packages });
    // New services are constructed after packages (publish/mutation backend)
    // and before routes; notify is delegated lazily until routes exists.
    skills = await openSkillManager({ dataRoot, store, packages, notify: (deviceId) => routes?.notifyDevice?.(deviceId) });
    learning = await openLearningService({ dataRoot, store, skills, runHermes });
    botManagement = openBotManagement({ store, packages, notify: (deviceId) => routes?.notifyDevice?.(deviceId) });
    vault = await openCenterVault({ dataRoot, encryptionKey, store });
    routes = registerRoutes(app, { store, packages, bridge, execution, oauth, linkUrl, turns, skills, learning, botManagement, catalog, publicUrl, vault });
    if (webRoot) {
      await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      });
    }
    const url = await app.listen({ host: listenHost, port });
    void catalog.sync().catch(() => {});
    return { url, linkUrl, close };
  } catch (error) { try { await close(); } catch {} throw error; }
}
