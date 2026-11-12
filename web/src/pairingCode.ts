/**
 * Reads what the user pasted into the "pairing code" box. Shared by the desktop client and the
 * Android UI, so both react to a paste in exactly the same way.
 *
 * The wire format belongs to the center (`center-server/pairing.js`):
 *   "pibot1." + base64url(JSON { u: centerOrigin, c: oneTimeSecret, a?: caPem })
 *
 * This is only a front-door check so the UI can react at once (and show which center the
 * code points at): it must not accept anything the native layer would refuse, because a valid
 * paste starts pairing by itself. The authoritative decode happens natively (`pairing_code.rs`
 * and `host_service.rs` on desktop, `PairingCode.java` on Android), and the secret and
 * certificate never enter frontend state beyond the pasted text itself.
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
  /** Starts like a code but is cut off, garbled or carries an address that cannot be used. */
  | { kind: 'damaged' };

const SECRET = /^[A-Za-z0-9_-]{32,64}$/;
/** Same limits as the native decoders. */
const MAX_CODE_CHARS = 96 * 1024;
const MAX_CA_CHARS = 64 * 1024;
const MAX_URL_CHARS = 2048;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

/**
 * The host to show for a center address, or undefined when the address cannot be used: it must be a
 * bare origin (scheme, host and optional port, at most one trailing slash), with `https`, or plain
 * `http` for a loopback host only (a development center next to the desktop client; the phone's own
 * loopback is never the center, so Android turns that off). A path, query, fragment or userinfo would redirect requests or hide
 * the real host, so such a code is treated as damaged instead of being sent on to be refused later.
 */
function centerHostOf(raw: string, allowLoopbackHttp: boolean): string | undefined {
  if (raw.length > MAX_URL_CHARS || !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return undefined;
    if (url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return url.host;
  } catch {
    // Not a URL at all.
  }
  return undefined;
}

export interface ReadPasteOptions {
  /** Accept `http://localhost`-style centers (desktop development setups). Default true. */
  allowLoopbackHttp?: boolean;
}

/** Whitespace anywhere is ignored: chat apps and terminals like to wrap long strings. */
export function readPaste(text: string, options: ReadPasteOptions = {}): PasteKind {
  const compact = text.replace(/\s+/g, '');
  if (compact === '') return { kind: 'empty' };
  if (!compact.startsWith(PAIRING_CODE_PREFIX)) return { kind: isOtherVersion(compact) ? 'unsupported' : 'not-code' };
  if (compact.length > MAX_CODE_CHARS) return { kind: 'damaged' };

  const payload = decodePayload(compact.slice(PAIRING_CODE_PREFIX.length)) as { u?: unknown; c?: unknown; a?: unknown } | undefined;
  if (!payload || typeof payload !== 'object' || typeof payload.u !== 'string' || typeof payload.c !== 'string' || !SECRET.test(payload.c)) {
    return { kind: 'damaged' };
  }
  if (payload.a !== undefined && payload.a !== null) {
    if (typeof payload.a !== 'string') return { kind: 'damaged' };
    const ca = payload.a.trim();
    if (ca !== '' && (ca.length > MAX_CA_CHARS || !ca.includes('-----BEGIN CERTIFICATE-----'))) return { kind: 'damaged' };
  }
  const centerHost = centerHostOf(payload.u.trim(), options.allowLoopbackHttp !== false);
  return centerHost === undefined ? { kind: 'damaged' } : { kind: 'code', centerHost };
}
