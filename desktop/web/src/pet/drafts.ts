import type { DesktopPetAction, DesktopPetResult } from './protocol';

/** Confirmed enqueue owns draft cleanup, even if the pet closed while the request was in flight. */
export function completePetAction(
  action: DesktopPetAction,
  result: DesktopPetResult,
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
): DesktopPetResult {
  if (action.kind !== 'send' || !result.pendingId) return result;
  const queuedDraft = { deviceId: action.deviceId, botId: action.botId, text: action.text };
  const key = 'pibot-desktop-pet-draft:v1:' + action.deviceId + ':' + action.botId;
  try {
    if (storage.getItem(key) === action.text) storage.removeItem(key);
  } catch { /* The result also clears an open editor if local storage is unavailable. */ }
  return { ...result, queuedDraft };
}
