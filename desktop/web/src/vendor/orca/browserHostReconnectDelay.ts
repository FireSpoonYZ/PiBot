// MIT; Copyright (c) 2026 Lovecast Inc.
// Extracted from stablyai/orca 1e8546eadfcd69ae3438c0e3c0a3693cf771067a.
// src/main/browser/client-hosts/leases/browser-host-lease-reconnect-delay.ts; see THIRD_PARTY_NOTICES.md.
const MAX_RECONNECT_RETRY_DELAY_MS = 2_000

export function nextBrowserHostReconnectDelay(options: {
  baseDelayMs: number
  attempt: number
  remainingMs: number
  browserHostClientId: string
}): number {
  const exponent = Math.min(options.attempt, 30)
  const ceiling = Math.min(MAX_RECONNECT_RETRY_DELAY_MS, options.baseDelayMs * 2 ** exponent)
  const jitter = 0.5 + stableFraction(`${options.browserHostClientId}:${options.attempt}`) / 2
  return Math.max(1, Math.min(options.remainingMs, Math.floor(ceiling * jitter)))
}

function stableFraction(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) / 0xffffffff
}
