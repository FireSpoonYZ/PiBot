// What one CLI call may send a host: a paired server refuses a larger request by closing the
// connection, which fails every call on it. Files ride inside as base64, a third larger.
// Adapted from upstream src/shared/remote-runtime/paired-request-budget.ts &
// remote-runtime-memory-limits.ts without pulling the full remote-runtime RPC serializer.

// Why: a host refuses a larger client frame by closing the socket (1009), failing every call on it.
export const REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES = 1024 * 1024
// Why: a sealed frame is base64 of nonce, MAC and (v2) a 42-byte header around the request JSON.
const REMOTE_RUNTIME_MAX_SEALING_OVERHEAD_BYTES = 128
/** The largest request JSON that still fits a host's inbound frame once sealed. */
export const REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES =
  Math.floor(REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES / 4) * 3 -
  REMOTE_RUNTIME_MAX_SEALING_OVERHEAD_BYTES

// Request id, device token, method name and JSON framing around the params.
const REQUEST_ENVELOPE_RESERVE_BYTES = 4 * 1024

/** The most JSON one call's params may take. */
export const PAIRED_REQUEST_PARAMS_MAX_BYTES =
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES - REQUEST_ENVELOPE_RESERVE_BYTES

/** Raw file bytes whose base64 fits the params, with `reserveBytes` left for the other fields. */
export function pairedRequestFileBudget(reserveBytes: number): number {
  return Math.floor((PAIRED_REQUEST_PARAMS_MAX_BYTES - reserveBytes) / 4) * 3
}
