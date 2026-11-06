import { assertId, messageError } from './message-protocol.js';

// Shared boundary for HTTP, local Runtime and remote control.
export function normalizeBotBoardParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params) ||
      Object.keys(params).some((key) => key !== 'botIds') ||
      !Array.isArray(params.botIds) || params.botIds.length > 64) {
    throw messageError('INVALID_ARGUMENT', 'params must contain only botIds, an array of at most 64 IDs');
  }
  for (const botId of params.botIds) assertId(botId, 'botId');
  return { botIds: [...new Set(params.botIds)] };
}
