import { messageError } from './message-protocol.js';

export function normalizeDeviceName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw messageError('INVALID_ARGUMENT', 'displayName must be a well-formed string');
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 120) {
    throw messageError('INVALID_ARGUMENT', 'displayName must contain 1-120 characters');
  }
  return name;
}

export function normalizeDevicePlatform(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length < 1 || value.trim().length > 120) {
    throw messageError('INVALID_ARGUMENT', 'platform must contain 1-120 characters');
  }
  return value.trim();
}
