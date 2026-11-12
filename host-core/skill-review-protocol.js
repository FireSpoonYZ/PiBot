import { assertId, messageError } from './message-protocol.js';

const fields = Object.freeze({
  list: ['action', 'includeArchived'],
  read: ['action', 'skillId', 'path', 'expectedRevision'],
  history: ['action', 'skillId'],
  rollback: ['action', 'skillId', 'expectedRevision', 'revision', 'requestId'],
  pin: ['action', 'skillId', 'expectedRevision', 'pinned', 'requestId'],
  lock: ['action', 'skillId', 'expectedRevision', 'locked', 'requestId'],
  archive: ['action', 'skillId', 'expectedRevision', 'requestId'],
  restore: ['action', 'skillId', 'expectedRevision', 'requestId'],
  approve: ['action', 'skillId', 'expectedRevision', 'requestId'],
  publish: ['action', 'skillId', 'expectedRevision', 'requestId'],
});
const invalid = (message) => messageError('INVALID_ARGUMENT', message);

export function normalizeSkillReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.action !== 'string' || !Object.hasOwn(fields, input.action)) {
    throw invalid('input.action must be one of list|read|history|rollback|pin|lock|archive|restore|approve|publish');
  }
  const { action, skillId, path, expectedRevision, revision, pinned, locked, requestId, includeArchived } = input;
  if (Object.keys(input).some(key => !fields[action].includes(key))) throw invalid('unknown skill review field');
  if (action === 'list') {
    if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
      throw invalid('includeArchived must be boolean');
    }
    return includeArchived === undefined ? { action } : { action, includeArchived };
  }
  assertId(skillId, 'skillId');
  if (action === 'history') return { action, skillId };
  if (action === 'read') {
    const out = { action, skillId };
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw invalid('expectedRevision must be a nonnegative safe integer');
      }
      out.expectedRevision = expectedRevision;
    }
    if (path !== undefined) {
      if (typeof path !== 'string' || !path.isWellFormed() || !path.trim()) {
        throw invalid('path must be a nonempty string');
      }
      out.path = path;
    }
    return out;
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw invalid('expectedRevision must be a nonnegative safe integer');
  }
  if (requestId !== undefined) assertId(requestId, 'requestId');
  if (action === 'approve' || action === 'publish') {
    assertId(requestId, 'requestId');
    return { action, skillId, expectedRevision, requestId };
  }
  if (action === 'rollback') {
    assertId(requestId, 'requestId');
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw invalid('revision must be a positive safe integer');
    }
    return { action, skillId, expectedRevision, revision, requestId };
  }
  if (action === 'pin') {
    if (typeof pinned !== 'boolean') throw invalid('pinned must be boolean');
    return { action, skillId, expectedRevision, pinned, ...(requestId ? { requestId } : {}) };
  }
  if (action === 'lock') {
    if (typeof locked !== 'boolean') throw invalid('locked must be boolean');
    return { action, skillId, expectedRevision, locked, ...(requestId ? { requestId } : {}) };
  }
  return { action, skillId, expectedRevision, ...(requestId ? { requestId } : {}) };
}
