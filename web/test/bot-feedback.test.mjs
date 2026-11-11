import assert from 'node:assert/strict';
import test from 'node:test';
import { BotReadScope } from '../src/botReadScope.ts';
import { deleteBotAndVerify, isDefiniteSendFailure } from '../src/botOperations.ts';

const missing = () => Object.assign(new Error('bot not found'), { code: 'BOT_NOT_FOUND', outcome: 'responded' });

test('deletion fences a late history error before the chat unmounts', async () => {
  const scope = new BotReadScope();
  const revision = scope.snapshot();
  let rejectHistory;
  const history = new Promise((_, reject) => { rejectHistory = reject; });
  const errors = [];
  const pending = history.catch(error => { if (scope.isCurrent(revision)) errors.push(error); });
  scope.suspend();
  rejectHistory(missing());
  await pending;
  assert.deepEqual(errors, []);
  assert.equal(scope.isCurrent(scope.snapshot()), false);
});

test('a failed deletion permits fresh reads without reviving earlier requests', () => {
  const scope = new BotReadScope();
  const oldRevision = scope.snapshot();
  const changes = [];
  const unsubscribe = scope.subscribe(() => changes.push(scope.snapshot()));
  scope.suspend();
  scope.resume();
  assert.equal(scope.isCurrent(oldRevision), false);
  assert.equal(scope.isCurrent(scope.snapshot()), true);
  assert.equal(changes.length, 2);
  unsubscribe();
});

test('a lost delete response resolves from absence without issuing a second delete', async () => {
  let deletes = 0;
  let reads = 0;
  await deleteBotAndVerify(async () => {
    deletes += 1;
    throw Object.assign(new Error('response lost'), { code: 'TIMEOUT' });
  }, async () => { reads += 1; throw missing(); });
  assert.equal(deletes, 1);
  assert.equal(reads, 1);
});

test('a real delete failure is preserved when the bot still exists or cannot be read', async () => {
  const failure = Object.assign(new Error('bot busy'), { code: 'RUNTIME_BUSY' });
  for (const read of [async () => ({ botId: 'still-here' }), async () => { throw new Error('offline'); }]) {
    await assert.rejects(deleteBotAndVerify(async () => { throw failure; }, read), error => error === failure);
  }
});

test('already absent bot completes deletion without a redundant lookup', async () => {
  await deleteBotAndVerify(async () => { throw missing(); }, async () => { assert.fail('unexpected lookup'); });
});

test('only definite send failures release editing; ambiguous failures keep receipt recovery active', () => {
  assert.equal(isDefiniteSendFailure({ outcome: 'not-sent', code: 'OFFLINE' }), true);
  assert.equal(isDefiniteSendFailure(missing()), true);
  assert.equal(isDefiniteSendFailure({ outcome: 'responded', code: 'STORE_FAILED' }), false);
  assert.equal(isDefiniteSendFailure({ outcome: 'unconfirmed', code: 'BOT_NOT_FOUND' }), false);
  assert.equal(isDefiniteSendFailure(new Error('timeout')), false);
});
