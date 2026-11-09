import { assertId, messageError } from './message-protocol.js';

const fields = Object.freeze({
  list: ['action'],
  read: ['action', 'skillId', 'path', 'expectedRevision'],
  approve: ['action', 'skillId', 'expectedRevision', 'requestId'],
});
const invalid = (message) => messageError('INVALID_ARGUMENT', message);

export function normalizeSkillReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.action !== 'string' || !Object.hasOwn(fields, input.action)) {
    throw invalid('input.action must be one of list|read|approve');
  }
  const { action, skillId, path, expectedRevision, requestId } = input;
  if (Object.keys(input).some(key => !fields[action].includes(key))) throw invalid('unknown skill review field');
  if (action === 'list') return { action };
  assertId(skillId, 'skillId');
  if (action === 'read' && path === undefined && expectedRevision === undefined) return { action, skillId };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw invalid('expectedRevision must be a nonnegative safe integer');
  }
  if (action === 'approve') {
    assertId(requestId, 'requestId');
    return { action, skillId, expectedRevision, requestId };
  }
  if (typeof path !== 'string' || !path.isWellFormed() || !path.trim()) throw invalid('path must be a nonempty string');
  return { action, skillId, path, expectedRevision };
}
