/**
 * Reads what the user pasted into the "pairing code" box.
 *
 * The wire format belongs to the center (`center-server/pairing.js`):
 *   "pibot1." + base64url(JSON { u: centerOrigin, c: oneTimeSecret, a?: caPem })
 *
 * This is only a front-door check so the UI can react at once (and show which center the
 * code points at). The authoritative decode happens in Rust (`pairing_code.rs`), and the
 * secret and certificate never enter frontend state beyond the pasted text itself.
 */

export const PAIRING_CODE_PREFIX = 'pibot1.';

export type PasteKind =
  /** Nothing pasted yet. */
  | { kind: 'empty' }
  /** A complete code; `centerHost` is for display ("center.example.com:8443"). */
  | { kind: 'code'; centerHost: string }
  /** Some other text: a URL, a password, a stray sentence. */
  | { kind: 'not-code' }
  /** A `pibotN.` code from a center newer than this client. */
  | { kind: 'unsupported' }
  /** Starts like a code but is cut off or garbled. */
  | { kind: 'damaged' };

const SECRET = /^[A-Za-z0-9_-]{32,64}$/;

/** `pibot2.…` and friends. */
const isOtherVersion = (compact: string): boolean => /^pibot\d+\./.test(compact) && !compact.startsWith(PAIRING_CODE_PREFIX);

function decodePayload(body: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
  const padded = body.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(body.length / 4) * 4, '=');
  try {
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Whitespace anywhere is ignored: chat apps and terminals like to wrap long strings. */
export function readPaste(text: string): PasteKind {
  const compact = text.replace(/\s+/g, '');
  if (compact === '') return { kind: 'empty' };
  if (!compact.startsWith(PAIRING_CODE_PREFIX)) return { kind: isOtherVersion(compact) ? 'unsupported' : 'not-code' };

  const payload = decodePayload(compact.slice(PAIRING_CODE_PREFIX.length)) as { u?: unknown; c?: unknown; a?: unknown } | undefined;
  if (!payload || typeof payload !== 'object' || typeof payload.u !== 'string' || typeof payload.c !== 'string' || !SECRET.test(payload.c)) {
    return { kind: 'damaged' };
  }
  if (payload.a !== undefined && payload.a !== null && typeof payload.a !== 'string') return { kind: 'damaged' };
  try {
    const origin = new URL(payload.u);
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return { kind: 'damaged' };
    return { kind: 'code', centerHost: origin.host };
  } catch {
    return { kind: 'damaged' };
  }
}
