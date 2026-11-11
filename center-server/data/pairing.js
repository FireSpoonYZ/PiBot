import { randomUUID } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Pairing codes stay listed for a day after they stop being usable, then are purged. */
const RETAIN_MS = 24 * 60 * 60 * 1000;
/**
 * A redeemed code may be replayed by the very same device (same deviceId and
 * token) for a short window, so a lost response can be retried without minting
 * a second code. Any other caller sees the code as used.
 */
const REPLAY_WINDOW_MS = 10 * 60 * 1000;

function codeStatus(row, now) {
  if (row.redeemed_at !== null) return 'redeemed';
  if (row.revoked_at !== null) return 'revoked';
  return row.expires_at <= now ? 'expired' : 'pending';
}

function codeValue(row, now) {
  return {
    id: row.id,
    status: codeStatus(row, now),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deviceId: row.device_id,
    targetDeviceId: row.target_device_id,
  };
}

/**
 * One-time pairing codes and the private CA that is embedded into them.
 * Only the SHA-256 of a code secret is stored; the plaintext exists in the
 * creation response and nowhere else.
 *
 * A code may name a `targetDeviceId`: the owner issued it to re-bind that one
 * existing device. Codes without a target register new device IDs or add back
 * deleted ones; they never re-bind an active device.
 */
export function pairingStore(db, transaction) {
  return {
    createPairingCode(codeHash, ttlMs, targetDeviceId = null) {
      return transaction(() => {
        const created = new Date();
        const now = created.toISOString();
        db.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').run(new Date(created.getTime() - RETAIN_MS).toISOString());
        const id = randomUUID();
        db.prepare('INSERT INTO pairing_codes (id, code_hash, created_at, expires_at, target_device_id) VALUES (?, ?, ?, ?, ?)')
          .run(id, codeHash, now, new Date(created.getTime() + ttlMs).toISOString(), targetDeviceId);
        return codeValue(db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id), now);
      });
    },
    getPairingCode(id) {
      const row = db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id);
      if (!row) fail('NOT_FOUND', 'Pairing code not found');
      return codeValue(row, new Date().toISOString());
    },
    /** Voids a pending code; redeemed or already-void codes are left untouched. */
    revokePairingCode(id) {
      return transaction(() => {
        const now = new Date().toISOString();
        const row = db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id);
        if (!row) fail('NOT_FOUND', 'Pairing code not found');
        if (codeStatus(row, now) === 'pending') db.prepare('UPDATE pairing_codes SET revoked_at = ? WHERE id = ?').run(now, id);
        return codeValue(db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id), now);
      });
    },
    /**
     * Claims a code for one device.
     *
     * `admit({ replay, targetDeviceId })` runs after the code itself is found usable and BEFORE it is
     * marked used. The caller applies its policy there (which device IDs this code may bind) and
     * throws to refuse; a refusal leaves the code untouched, so a wrong-device attempt cannot burn
     * the owner's code. `replay` is true when the same device and token already claimed this code.
     */
    redeemPairingCode(codeHash, { deviceId, tokenHash }, admit = () => {}) {
      return transaction(() => {
        const nowDate = new Date();
        const now = nowDate.toISOString();
        const row = db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(codeHash);
        if (!row) fail('PAIRING_CODE_INVALID', 'Pairing code is not valid');
        if (row.redeemed_at !== null) {
          const same = row.device_id === deviceId && row.token_hash === tokenHash;
          if (!same || Date.parse(row.redeemed_at) + REPLAY_WINDOW_MS <= nowDate.getTime()) fail('PAIRING_CODE_USED', 'Pairing code has already been used');
          admit({ replay: true, targetDeviceId: row.target_device_id });
          return { id: row.id, replay: true };
        }
        if (row.revoked_at !== null || row.expires_at <= now) fail('PAIRING_CODE_EXPIRED', 'Pairing code has expired');
        admit({ replay: false, targetDeviceId: row.target_device_id });
        db.prepare('UPDATE pairing_codes SET redeemed_at = ?, device_id = ?, token_hash = ? WHERE id = ?').run(now, deviceId, tokenHash, row.id);
        return { id: row.id, replay: false };
      });
    },
    /**
     * Gives a just-claimed code back when the device could not be registered after all, so a
     * center-side failure does not burn the owner's code. Only the claim made with this very
     * token is undone.
     */
    releasePairingCode(id, tokenHash) {
      db.prepare('UPDATE pairing_codes SET redeemed_at = NULL, device_id = NULL, token_hash = NULL WHERE id = ? AND token_hash = ?').run(id, tokenHash);
    },
    getPairingCa() {
      return db.prepare('SELECT ca_pem FROM pairing_settings WHERE id = 1').get()?.ca_pem ?? null;
    },
    setPairingCa(pem) {
      db.prepare(`INSERT INTO pairing_settings (id, ca_pem, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ca_pem = excluded.ca_pem, updated_at = excluded.updated_at`)
        .run(pem, new Date().toISOString());
      return pem;
    },
  };
}
