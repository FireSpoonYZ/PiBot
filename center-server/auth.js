import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import secureSession from '@fastify/secure-session';
import csrfProtection from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';

const scrypt = promisify(scryptCallback);

export async function registerAuth(app, { sessionKey, ownerPasswordHash }) {
  const match = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/i.exec(ownerPasswordHash ?? '');
  if (!match) throw new Error('invalid owner password hash');
  const salt = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(match[2], 'hex');
  await app.register(secureSession, { key: sessionKey, cookie: { path: '/', httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 } });
  await app.register(csrfProtection, { sessionPlugin: '@fastify/secure-session', getToken: req => req.headers['x-csrf-token'] });
  await app.register(rateLimit, { global: false });
  app.get('/api/session', async (req, reply) => ({ authenticated: req.session.get('owner') === true, csrfToken: reply.generateCsrf() }));
  app.post('/api/session', { onRequest: app.csrfProtection, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 1024) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials' } });
    const actual = await scrypt(password, salt, expected.length);
    if (!timingSafeEqual(actual, expected)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials' } });
    req.session.regenerate();
    req.session.set('owner', true);
    return { authenticated: true, csrfToken: reply.generateCsrf() };
  });
  app.delete('/api/session', { onRequest: [app.csrfProtection, requireOwner] }, async (req, reply) => {
    req.session.delete();
    return reply.code(204).send();
  });
}

export function requireOwner(req, reply, done) {
  if (req.session.get('owner') !== true) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
  done();
}

export function assertPublicCredentialId(id) {
  if (typeof id === 'string' && id.startsWith('center-internal-')) throw Object.assign(new Error('Reserved credential'), { code: 'FORBIDDEN' });
  return id;
}
