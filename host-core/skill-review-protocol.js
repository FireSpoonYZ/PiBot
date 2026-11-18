import { assertId, messageError } from './message-protocol.js';

const fields = Object.freeze({
  list: ['action', 'includeArchived'],
  read: ['action', 'skillId', 'path', 'expectedRevision'],
  pin: ['action', 'skillId', 'expectedRevision', 'pinned', 'requestId'],
  lock: ['action', 'skillId', 'expectedRevision', 'locked', 'requestId'],
  archive: ['action', 'skillId', 'expectedRevision', 'requestId'],
  restore: ['action', 'skillId', 'expectedRevision', 'requestId'],
});
const invalid = (message) => messageError('INVALID_ARGUMENT', message);

export function normalizeSkillReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.action !== 'string' || !Object.hasOwn(fields, input.action)) {
    throw invalid('input.action must be one of list|read|pin|lock|archive|restore');
  }
  const { action, skillId, path, expectedRevision, pinned, locked, requestId, includeArchived } = input;
  if (Object.keys(input).some(key => !fields[action].includes(key))) throw invalid('unknown skill review field');
  if (action === 'list') {
    if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
      throw invalid('includeArchived must be boolean');
    }
    return includeArchived === undefined ? { action } : { action, includeArchived };
  }
  assertId(skillId, 'skillId');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw invalid('expectedRevision must be a nonnegative safe integer');
  }
  const rev = expectedRevision !== undefined ? { expectedRevision } : {};
  if (action === 'read') {
    const out = { action, skillId, ...rev };
    if (path !== undefined) {
      if (typeof path !== 'string' || !path.isWellFormed() || !path.trim()) {
        throw invalid('path must be a nonempty string');
      }
      out.path = path;
    }
    return out;
  }
  if (requestId !== undefined) assertId(requestId, 'requestId');
  const req = requestId ? { requestId } : {};
  if (action === 'pin') {
    if (typeof pinned !== 'boolean') throw invalid('pinned must be boolean');
    return { action, skillId, ...rev, pinned, ...req };
  }
  if (action === 'lock') {
    if (typeof locked !== 'boolean') throw invalid('locked must be boolean');
    return { action, skillId, ...rev, locked, ...req };
  }
  return { action, skillId, ...rev, ...req };
}
