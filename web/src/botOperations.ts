export function isBotMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'BOT_NOT_FOUND';
}

/** A lost delete response is resolved by an authoritative read, never by another delete. */
export async function deleteBotAndVerify(remove: () => Promise<unknown>, read: () => Promise<unknown>): Promise<void> {
  try { await remove(); }
  catch (error) {
    if (isBotMissing(error)) return;
    try { await read(); }
    catch (readError) { if (isBotMissing(readError)) return; }
    throw error;
  }
}

/** Ambiguous server/storage failures keep the original request locked for receipt recovery. */
export function isDefiniteSendFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, outcome } = error as { code?: string; outcome?: string };
  if (outcome === 'not-sent') return true;
  return outcome === 'responded' && new Set([
    'INVALID_ARGUMENT', 'INVALID_CWD', 'BOT_NOT_FOUND', 'BOT_ARCHIVED',
    'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'MODEL_REQUIRED', 'MODEL_NOT_FOUND', 'REQUEST_CONFLICT',
  ]).has(code ?? '');
}

export interface DirectoryPeerError {
  deviceId: string;
  code: string;
  message?: string;
}

export function isPeerUnavailableDirectoryError(error: { code?: unknown }): boolean {
  return (
    error.code === 'OFFLINE' ||
    error.code === 'CONTROL_UNAVAILABLE' ||
    error.code === 'DISCONNECTED'
  );
}

/**
 * Peer-level offline / control-unavailable errors already degrade those peers'
 * bots to cached offline entries and must not raise a global directory error banner.
 */
export function formatActionableDirectoryError(
  errors: readonly DirectoryPeerError[],
  devices: readonly { deviceId: string; displayName?: string }[],
  separator = ' · ',
): string {
  const actionable = errors.filter((error) => !isPeerUnavailableDirectoryError(error));
  if (actionable.length === 0) return '';
  return actionable
    .map((error) => {
      const devName =
        devices.find((device) => device.deviceId === error.deviceId)?.displayName ||
        error.deviceId;
      const msg = typeof error.message === 'string' ? error.message.trim() : '';
      const detail = msg
        ? error.code && !msg.startsWith(`${error.code}:`)
          ? `${error.code}: ${msg}`
          : msg
        : error.code;
      return `${devName}: ${detail}`;
    })
    .join(separator);
}

export function isRemoteBotOnline(input: {
  remoteConnected: boolean;
  deviceOnline?: boolean;
  botOnline?: boolean;
}): boolean {
  return Boolean(input.remoteConnected && input.deviceOnline && input.botOnline !== false);
}
