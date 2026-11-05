// center-server/setup.js
// First-run onboarding listener: same web root and listen address as the real
// center (TLS cert in direct mode, plain HTTP in proxy mode) but no business
// store or relay. Exposes only GET /api/health, GET/POST /api/setup and the
// static web bundle. A serialized one-shot POST writes center-config.json
// atomically; once the HTTP response completes the caller closes this
// listener and starts the real center without overwriting the config.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import {
  CENTER_SETUP_TOKEN_FILE,
  deriveLinkUrl,
  hashOwnerPassword,
  normalizeLinkUrl,
  normalizePublicUrl,
  writeCenterConfig,
} from './config.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const status = { INVALID_ARGUMENT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, REQUEST_CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, INTERNAL_ERROR: 500 };

export async function openSetupServer({ dataRoot, https, tlsMode, listenHost = '127.0.0.1', port = 8443, webRoot, defaults = {}, setupToken }) {
  const app = Fastify({ https, logger: false, bodyLimit: 16 * 1024 });
  let configured = null;
  let submitting = false;
  let resolveConfigured;
  const configuredPromise = new Promise((resolve) => { resolveConfigured = resolve; });

  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    done();
  });
  app.setErrorHandler((error, req, reply) => {
    let code = error.code;
    // Business errors thrown via fail()/invalid() carry our own safe field
    // messages (no request data); surface them so the user knows what to fix.
    // Fastify errors (JSON parse, content-type, limits) keep generic text and
    // never echo body fragments back.
    const business = typeof code === 'string' && status[code] !== undefined;
    if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 413) code = 'PAYLOAD_TOO_LARGE';
    else if (!business && (error.statusCode === 400 || error.statusCode === 415 || String(code).startsWith('FST_ERR_CTP'))) code = 'INVALID_ARGUMENT';
    if (!status[code]) code = 'INTERNAL_ERROR';
    const message = business ? error.message : code === 'INTERNAL_ERROR' ? 'Internal error' : code.replaceAll('_', ' ').toLowerCase();
    reply.code(status[code] || 500).send({ error: { code, message } });
  });
  await app.register(rateLimit, { global: false });

  app.get('/api/health', async () => ({ status: 'setup' }));
  app.get('/api/setup', async () => configured
    ? { required: false }
    : {
      required: true,
      ...(defaults.publicUrl ? { publicUrl: defaults.publicUrl } : {}),
      ...(defaults.linkUrl ? { linkUrl: defaults.linkUrl } : {}),
      tlsMode,
    });
  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (configured || submitting) return reply.code(409).send({ error: { code: 'REQUEST_CONFLICT', message: 'Center is already configured' } });
    // Same-origin guard: browsers always send Origin on POST; a mismatch is a
    // cross-site form. Compare host only because a TLS-terminating proxy still
    // forwards the public Host while the listener itself is plain HTTP.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* rejected below */ }
      if (originHost === null || originHost !== String(req.headers.host || '').toLowerCase()) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Origin does not match this center' } });
      }
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return reply.code(415).send({ error: { code: 'INVALID_ARGUMENT', message: 'Content-Type must be application/json' } });
    }
    submitting = true;
    try {
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_ARGUMENT', 'Expected an object');
      const expected = Buffer.from(setupToken, 'utf8');
      const actual = Buffer.from(typeof body.setupToken === 'string' ? body.setupToken : '', 'utf8');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('UNAUTHENTICATED', 'Invalid setup token');
      const password = body.ownerPassword;
      if (typeof password !== 'string' || password.length < 12 || password.length > 1024) fail('INVALID_ARGUMENT', 'ownerPassword must be 12-1024 characters');
      const publicUrl = defaults.publicUrl
        ?? (body.publicUrl !== undefined && body.publicUrl !== '' ? normalizePublicUrl(body.publicUrl) : fail('INVALID_ARGUMENT', 'publicUrl is required'));
      let linkUrl = defaults.linkUrl;
      if (linkUrl === undefined) {
        linkUrl = body.linkUrl === undefined || body.linkUrl === null || body.linkUrl === ''
          ? deriveLinkUrl(publicUrl)
          : normalizeLinkUrl(body.linkUrl);
      }
      if (new URL(linkUrl).pathname !== '/v1/link') fail('INVALID_ARGUMENT', 'linkUrl must end with /v1/link');
      const encryptionKey = randomBytes(32);
      const sessionKey = randomBytes(32);
      const record = {
        version: 1,
        publicUrl,
        linkUrl,
        encryptionKeyHex: encryptionKey.toString('hex'),
        sessionKeyHex: sessionKey.toString('hex'),
        ownerPasswordHash: hashOwnerPassword(password),
      };
      writeCenterConfig(dataRoot, record);
      // One-shot token: consumed by the first successful configuration.
      try { unlinkSync(join(dataRoot, CENTER_SETUP_TOKEN_FILE)); } catch { /* already gone */ }
      configured = { ...record, encryptionKey, sessionKey };
      // The response must complete before the setup listener closes; 'finish'
      // fires once it is flushed ('close' covers an aborted connection), then
      // the caller swaps in the real center.
      const done = () => resolveConfigured(configured);
      reply.raw.once('finish', done);
      reply.raw.once('close', done);
      return { configured: true };
    } finally {
      submitting = false;
    }
  });

  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
  }
  app.setNotFoundHandler((req, reply) => {
    if (webRoot && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  const url = await app.listen({ host: listenHost, port });
  return { url, configured: configuredPromise, close: () => app.close() };
}
