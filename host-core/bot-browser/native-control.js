import { assertId } from '../message-protocol.js';
import { BROWSER_ERROR_CODES, browserError, isPlainObject, normalizePageId } from './protocol.js';

const FIELDS = new Map([
  ['rendererAttach', ['rendererId']],
  ['rendererNext', ['rendererId']],
  ['rendererReply', ['rendererId', 'operationId', 'result', 'code']],
  ['rendererDetach', ['rendererId']],
  ['rendererClose', ['rendererId']],
  ['rendererEgressAuthorize', ['rendererId']],
  ['nativeGrant', ['pageId', 'lease']],
  ['nativeDismiss', ['pageId', 'lease']],
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]{16,96}$/;
const RESULT_KEYS = new Set([
  'url', 'title', 'width', 'height', 'documentGeneration', 'hints', 'text', 'elements',
  'mimeType', 'data', 'ok', 'canGoBack', 'canGoForward',
]);
const SAFE_ERRORS = new Set(BROWSER_ERROR_CODES);

export function normalizeNativeBrowserControl(input, maxBytes) {
  const fields = FIELDS.get(input?.action);
  if (!fields) return null;
  if (!isPlainObject(input) || Object.keys(input).some(key => key !== 'action' && key !== 'botId' && !fields.includes(key))) {
    throw browserError('INVALID_ARGUMENT');
  }
  assertId(input.botId, 'botId');
  const output = { action: input.action, botId: input.botId };
  for (const key of ['rendererId', 'operationId']) {
    if (!fields.includes(key)) continue;
    if (typeof input[key] !== 'string' || !ID_PATTERN.test(input[key])) throw browserError('INVALID_ARGUMENT');
    output[key] = input[key];
  }
  if (fields.includes('lease')) {
    output.pageId = normalizePageId(input.pageId);
    if (typeof input.lease !== 'string' || input.lease.length < 8 || input.lease.length > 256 || /\s/u.test(input.lease)) {
      throw browserError('INVALID_ARGUMENT');
    }
    output.lease = input.lease;
  }
  if (input.action === 'rendererReply') {
    if (typeof input.code === 'string' && SAFE_ERRORS.has(input.code) && input.result === undefined) {
      output.code = input.code;
    } else if (input.code === undefined && isPlainObject(input.result) &&
        Object.keys(input.result).every(key => RESULT_KEYS.has(key)) &&
        Buffer.byteLength(JSON.stringify(input.result)) <= maxBytes + 24_576) {
      output.result = input.result;
    } else {
      throw browserError('INVALID_ARGUMENT');
    }
  }
  return output;
}
