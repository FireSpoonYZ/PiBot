import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { assertDeviceId } from '../host-core/relay-protocol.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('INVALID_ARGUMENT', 'Expected an object');
function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT', 'Unknown field');
  return value;
}
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Wire format of a pairing code, shared by every client:
 *   "pibot1." + base64url(JSON { u: centerOrigin, c: secret, a?: caPem })
 * The prefix lets a client reject unrelated pasted text before decoding.
 */
export const PAIRING_CODE_PREFIX = 'pibot1.';
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/** 24 random bytes as base64url: 32 characters, far beyond what rate limiting has to defend. */
const SECRET_RE = /^[A-Za-z0-9_-]{32,64}$/;
const MAX_CA_CHARS = 64 * 1024;
const MAX_CA_CERTS = 8;
const CERT_RE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n\t ]+?-----END CERTIFICATE-----/g;

export function encodePairingCode({ url, secret, ca }) {
  const payload = { u: url, c: secret, ...(ca ? { a: ca } : {}) };
  return PAIRING_CODE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

const certificates = pem => (pem.match(CERT_RE) ?? []).map(block => new X509Certificate(block));
const summarize = certs => certs.map(cert => ({ subject: cert.subject.replaceAll('\n', ', '), fingerprint256: cert.fingerprint256, validTo: new Date(cert.validTo).toISOString() }));

/** Accepts only PEM certificates (no keys, no stray text) and returns them re-encoded. */
export function normalizeCaBundle(value) {
  if (typeof value !== 'string' || value.length > MAX_CA_CHARS || !value.isWellFormed()) fail('INVALID_ARGUMENT', 'Invalid CA certificate');
  const blocks = value.match(CERT_RE) ?? [];
  if (blocks.length < 1 || blocks.length > MAX_CA_CERTS || value.replace(CERT_RE, '').trim() !== '') fail('INVALID_ARGUMENT', 'CA must contain only PEM certificates');
  let certs;
  try { certs = certificates(value); } catch { fail('INVALID_ARGUMENT', 'CA certificate cannot be parsed'); }
  return certs.map(cert => cert.toString().trim()).join('\n') + '\n';
}

export function registerPairingRoutes(app, { store, bridge, route, notify, publicUrl, deviceRegistration }) {
  const caValue = () => {
    const ca = store.getPairingCa();
    return { ca, certificates: ca === null ? [] : summarize(certificates(ca)) };
  };
  const deviceRef = deviceId => ({ deviceId, name: bridge.registry.get(deviceId)?.displayName ?? deviceId });
  const present = value => {
    const { deviceId, targetDeviceId, ...rest } = value;
    return {
      ...rest,
      ...(deviceId === null ? {} : { device: deviceRef(deviceId) }),
      ...(targetDeviceId === null ? {} : { target: deviceRef(targetDeviceId) }),
    };
  };

  // The private CA embedded into every code: pasted once here instead of once per device.
  route('GET', '/api/pairing/ca', caValue);
  route('PUT', '/api/pairing/ca', req => {
    const body = fields(req.body, ['ca']);
    store.setPairingCa(body.ca === null ? null : normalizeCaBundle(body.ca));
    return caValue();
  }, true);

  // The plaintext secret is returned here once; only its hash is stored.
  // With `deviceId` the owner issues the code to RE-BIND that one existing device (the "re-pair" action
  // on its card). Without it the code registers a new device ID, or adds back one the owner deleted:
  // handing out a code must never be enough to take over a device that is still active.
  route('POST', '/api/pairing-codes', (req, reply) => {
    const body = fields(req.body ?? {}, ['deviceId']);
    if (typeof publicUrl !== 'string' || publicUrl === '') fail('INVALID_STATE', 'Center public URL is not configured');
    let target = null;
    if (body.deviceId !== undefined) {
      assertDeviceId(body.deviceId);
      const device = body.deviceId === bridge.deviceId ? null : bridge.registry.get(body.deviceId);
      if (device === null || device.revokedAt !== null) fail('NOT_FOUND', 'Device not found');
      target = device.deviceId;
    }
    const secret = randomBytes(24).toString('base64url');
    const value = store.createPairingCode(sha256(secret), PAIRING_CODE_TTL_MS, target);
    const ca = store.getPairingCa();
    return reply.code(201).send({
      id: value.id,
      code: encodePairingCode({ url: new URL(publicUrl).origin, secret, ca }),
      expiresAt: value.expiresAt,
      ttlSeconds: PAIRING_CODE_TTL_MS / 1000,
      includesCa: ca !== null,
      target: target === null ? null : deviceRef(target),
    });
  }, true);
  route('GET', '/api/pairing-codes/:id', req => present(store.getPairingCode(req.params.id)));
  route('DELETE', '/api/pairing-codes/:id', (req, reply) => {
    store.revokePairingCode(req.params.id);
    return reply.code(204).send();
  }, true);

  // Called by devices, not browsers: no owner session and no CSRF token. The one-time
  // secret is the credential. The device brings its own identity and token (generated
  // before the call, so a lost response can be retried with the same values).
  app.post('/api/pairing/redeem', {
    bodyLimit: 8 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, (req, reply) => {
    const { code, ...rest } = object(req.body);
    if (typeof code !== 'string' || !SECRET_RE.test(code)) fail('PAIRING_CODE_INVALID', 'Pairing code is not valid');
    const device = deviceRegistration({ ...rest, replaceExisting: true });
    if (device.deviceId === undefined || device.deviceToken === undefined) fail('INVALID_ARGUMENT', 'deviceId and deviceToken are required');
    if (device.deviceId === bridge.deviceId) fail('FORBIDDEN', 'Reserved device ID');

    const { deviceId, deviceToken, displayName, platform } = device;
    const tokenHash = sha256(deviceToken);
    const existing = bridge.registry.get(deviceId);

    // The policy runs before the code is marked used, so a refused attempt never burns it. The handler is
    // synchronous end to end, so nothing can change the registry between this check and the write below.
    const claim = store.redeemPairingCode(sha256(code), { deviceId, tokenHash }, ({ replay, targetDeviceId }) => {
      if (replay) {
        // A retry of a registration that already happened. It only holds while the credential is still the
        // one this code created: a token the owner has since replaced or revoked must not come back.
        if (existing !== null && bridge.registry.authenticate(deviceId, deviceToken) === null) fail('PAIRING_CODE_USED', 'Pairing code has already been used');
        return;
      }
      if (targetDeviceId !== null) {
        if (deviceId !== targetDeviceId) fail('PAIRING_CODE_DEVICE_MISMATCH', 'Pairing code was issued for a different device');
        // Deleted or revoked since the owner issued the code: their intent no longer holds.
        if (existing === null || existing.revokedAt !== null) fail('PAIRING_CODE_EXPIRED', 'Pairing code has expired');
      } else if (existing !== null && existing.revokedAt === null) {
        // A live device is only ever re-bound by a code the owner issued for it.
        fail('DEVICE_ALREADY_REGISTERED', 'Device is already registered; the owner can issue a code for it from its device card');
      }
      // A deleted device (revoked: the owner removed it, its Bots and bindings with it) is free again,
      // so a generic code may add the same machine back under its persistent ID.
    });

    // A device the owner had deleted comes back as an addition, not a re-pair.
    const added = existing === null || existing.revokedAt !== null;
    let registered;
    try {
      // Both branches are idempotent for the same token, so a replayed claim can simply run again.
      // `rotate` also lifts the revocation of a deleted device being added back.
      if (existing === null) bridge.registry.register({ deviceId, token: deviceToken, displayName });
      else bridge.registry.rotate({ deviceId, token: deviceToken });
      // Only fills a missing name, so a rename made by the owner survives re-pairing.
      registered = bridge.registry.updateMetadata(deviceId, { displayName, platform });
      // A deleted device keeps the name it had before (the delete is a soft revoke). It comes back as a
      // new registration, so the name the machine reports now is the one to show, not the stale one.
      if (existing !== null && added) registered = bridge.registry.rename(deviceId, displayName);
    } catch (error) {
      // The registry is a separate database, so the claim cannot be rolled back with it: give the code back.
      if (!claim.replay) store.releasePairingCode(claim.id, tokenHash);
      throw error;
    }
    // A rebound device invalidates streams still holding its previous credential.
    if (existing !== null) notify(deviceId);
    return reply.code(added ? 201 : 200).send({ deviceId, deviceToken, displayName: registered.displayName ?? displayName, platform });
  });
}
