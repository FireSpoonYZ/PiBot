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
