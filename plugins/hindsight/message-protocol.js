import { createHash } from 'node:crypto';
const MAX_ID_BYTES = 256;
export function messageError(code, message) { return Object.assign(new Error(message), { code }); }
function invalid(message) { return messageError('INVALID_ARGUMENT', message); }
export function assertId(value, name) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES
  ) {
    throw invalid(`${name} must be a well-formed non-blank string of at most 256 UTF-8 bytes`);
  }
}

function sha256Hex(json) { return createHash('sha256').update(json, 'utf8').digest('hex'); }
export function digest(normalizedValue) {
  return sha256Hex(JSON.stringify(normalizedValue));
}

