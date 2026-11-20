import assert from 'node:assert/strict';
import test from 'node:test';
import { projectBotBoardItem } from '../../host-core/runtime-bot-board.js';
import { projectLiveState } from '../../host-core/runtime-live-projection.js';
import {
  canStopBotActivity,
  isBotLlmRunningPhase,
  isBotPreLlmPhase,
  resolveBotActivity,
  resolveComposerActionKind,
  shouldShowComposerStop,
} from '../src/botActivity.ts';
import {
  botBoardBucket,
  botBoardKey,
  getBotBoardRecord,
  invalidateBotBoardTarget,
  readBotBoardBatch,
} from '../src/useBotBoard.ts';

test('isBotPreLlmPhase and isBotLlmRunningPhase partition pre-LLM vs active LLM phases', () => {
  for (const phase of ['queued', 'preparing', 'interrupting']) {
    assert.equal(isBotPreLlmPhase(phase), true, `expected ${phase} to be pre-LLM`);
    assert.equal(isBotLlmRunningPhase(phase), false, `expected ${phase} not to be LLM running`);
  }
  for (const phase of ['running', 'compacting']) {
    assert.equal(isBotLlmRunningPhase(phase), true, `expected ${phase} to be LLM running`);
    assert.equal(isBotPreLlmPhase(phase), false, `expected ${phase} not to be pre-LLM`);
  }
  for (const phase of ['idle', 'stopping', 'stopped', 'failed', null, undefined]) {
    assert.equal(isBotPreLlmPhase(phase), false);
    assert.equal(isBotLlmRunningPhase(phase), false);
  }
});

test('resolveComposerActionKind enforces pre-LLM spinner & queue lock, then stop/queue during LLM run', () => {
  // 1. Pre-LLM phases keep non-clickable loading spinner even when draft has text (no queueing yet).
  for (const phase of ['queued', 'preparing', 'interrupting']) {
    assert.equal(
      resolveComposerActionKind({ phase, online: true, hasDraft: false, canStop: true }),
      'loading',
    );
    assert.equal(
      resolveComposerActionKind({ phase, online: true, hasDraft: true, canStop: true }),
      'loading',
    );
  }

  // Local/remote send RPC in-flight also spins and blocks duplicate send.
  assert.equal(
    resolveComposerActionKind({ phase: 'idle', online: true, isSending: true, hasDraft: false }),
    'loading',
  );
  assert.equal(
    resolveComposerActionKind({
      phase: 'idle',
      online: true,
      pendingAdmissionWaiting: true,
      hasDraft: true,
    }),
    'loading',
  );

  // 2. Active LLM execution: empty input shows static Stop; non-empty input shows Queue (↑).
  for (const phase of ['running', 'compacting']) {
    assert.equal(
      resolveComposerActionKind({
        phase,
        online: true,
        hasDraft: false,
        canStop: canStopBotActivity(resolveBotActivity({ activity: { phase, source: 'primary', scopeId: null, requestId: 'r1', startedAt: null } })),
      }),
      'stop',
    );
    assert.equal(
      resolveComposerActionKind({
        phase,
        online: true,
        hasDraft: true,
        canStop: true,
        pendingAdmissionWaiting: true,
      }),
      'queue',
    );
  }

  // 3. Stopping takes highest priority until settled.
  assert.equal(
    resolveComposerActionKind({ phase: 'running', online: true, isStopping: true, hasDraft: true, canStop: true }),
    'stopping',
  );
  assert.equal(
    resolveComposerActionKind({ phase: 'stopping', online: true, hasDraft: true, canStop: false }),
    'stopping',
  );

  // 4. Settled/Idle phases (including failed admission) show send only when draft is non-empty, never stop.
  for (const phase of ['idle', 'stopped', 'failed']) {
    assert.equal(
      resolveComposerActionKind({ phase, online: true, hasDraft: false, canStop: phase === 'failed' }),
      'idle',
    );
    assert.equal(
      resolveComposerActionKind({ phase, online: true, hasDraft: true, canStop: phase === 'failed' }),
      'send',
    );
  }
});

test('shouldShowComposerStop covers active stoppable phases and settles cleanly on failed/stopped/idle', () => {
  const activeStoppablePhases = ['queued', 'preparing', 'running', 'compacting', 'interrupting'];

  for (const phase of activeStoppablePhases) {
    assert.equal(
      canStopBotActivity({ phase, source: 'primary', scopeId: null, requestId: 'r1', startedAt: null }),
      true,
      `expected canStopBotActivity to be true for ${phase}`,
    );
    assert.equal(
      shouldShowComposerStop({
        phase,
        online: true,
        archived: false,
        isStopping: false,
        canStop: true,
      }),
      true,
      `expected shouldShowComposerStop to be true for ${phase}`,
    );
    assert.equal(
      shouldShowComposerStop({
        phase,
        online: true,
        archived: false,
        isStopping: true,
        canStop: true,
      }),
      false,
      `expected isStopping:true to hide clickable stop for ${phase}`,
    );
    assert.equal(
      shouldShowComposerStop({
        phase,
        online: false,
        archived: false,
        isStopping: false,
        canStop: true,
      }),
      false,
      `expected online:false to hide stop for ${phase}`,
    );
    assert.equal(
      shouldShowComposerStop({
        phase,
        online: true,
        archived: true,
        isStopping: false,
        canStop: true,
      }),
      false,
      `expected archived:true to hide stop for ${phase}`,
    );
    assert.equal(
      shouldShowComposerStop({
        phase,
        online: true,
        archived: false,
        isStopping: false,
        canStop: false,
      }),
      false,
      `expected canStop:false to hide stop for ${phase}`,
    );
  }

  // Terminated generation failure (requestId: null) is already stopped/settled: neither canStopBotActivity nor composer stop stays active.
  const runFailureActivity = resolveBotActivity({
    activity: {
      phase: 'failed',
      source: null,
      scopeId: null,
      requestId: null,
      startedAt: null,
      error: { code: 'GENERATION_FAILED', message: 'generation failed: error' },
    },
  });
  assert.equal(canStopBotActivity(runFailureActivity), false);
  assert.equal(
    shouldShowComposerStop({
      phase: runFailureActivity.phase,
      online: true,
      archived: false,
      isStopping: false,
      canStop: canStopBotActivity(runFailureActivity),
    }),
    false,
  );

  // Failed pre-LLM admission (requestId !== null) remains cancellable via explicit banner, but never keeps composer stop stuck.
  const admissionFailureActivity = resolveBotActivity({
    turnAdmission: { phase: 'failed', requestId: 'req-adm-1', source: 'primary' },
  });
  assert.equal(canStopBotActivity(admissionFailureActivity), true);
  assert.equal(
    shouldShowComposerStop({
      phase: admissionFailureActivity.phase,
      online: true,
      archived: false,
      isStopping: false,
      canStop: true,
    }),
    false,
  );

  for (const phase of ['stopping', 'idle', 'stopped', 'failed', null, undefined]) {
    assert.equal(
      shouldShowComposerStop({
        phase,
        online: true,
        archived: false,
        isStopping: false,
        canStop: true,
      }),
      false,
      `expected phase ${String(phase)} to return false`,
    );
  }
});

test('Bot Board does not ask for attention after a finished generation interruption', () => {
  const failureSnapshot = (reason) => {
    const view = {
      entries: [],
      docs: { 'pi.live': { runFailure: { taskId: 10, inputs: [1], reason, first: 1 } } },
    };
    return projectBotBoardItem('bot_1', 'conv_1', projectLiveState(view), view, null);
  };
  const interrupted = failureSnapshot('interrupted');
  assert.equal(botBoardBucket(interrupted), 'idle');
  assert.equal(botBoardBucket(failureSnapshot('model_error')), 'attention');
  assert.equal(botBoardBucket({ ...interrupted, queuedCount: 1 }), 'working');
  assert.equal(botBoardBucket({
    ...interrupted,
    attention: { kind: 'questionnaire', requestId: 'question_1', summary: 'Review the plan', count: 1 },
  }), 'attention');
});

test('clearing a Bot drops its cached interruption and rejects stale board responses', async () => {
  const boardKey = botId => botBoardKey('clear-test', 'device-1', botId);
  const item = (botId, activity) => ({
    botId,
    conversationId: botId,
    activity: { source: null, scopeId: null, requestId: null, startedAt: null, ...activity },
    queuedCount: 0,
    attention: null,
    progress: null,
    lastResult: null,
  });
  const interrupted = item('a', {
    phase: 'failed', error: { code: 'GENERATION_FAILED', message: 'generation failed: interrupted' },
  });
  const snapshot = (...items) => ({ items, errors: [], updatedAt: new Date(0).toISOString() });
  const read = (fetch, botIds = ['a', 'b']) => readBotBoardBatch(
    botIds.map(botId => ({ key: boardKey(botId), botId, generation: '1', read: fetch })),
  );
  const key = boardKey('a');
  const otherKey = boardKey('b');
  await read(async () => snapshot(interrupted, item('b', { phase: 'idle' })));
  assert.equal(getBotBoardRecord(key)?.item?.activity.phase, 'failed');
  const otherBeforeClear = getBotBoardRecord(otherKey);

  const stale = Promise.withResolvers();
  const polling = read(() => stale.promise);
  invalidateBotBoardTarget(key);
  assert.deepEqual(getBotBoardRecord(key), {});
  assert.equal(getBotBoardRecord(otherKey), otherBeforeClear);
  stale.resolve(snapshot(interrupted, item('b', { phase: 'running' })));
  await polling;
  assert.deepEqual(getBotBoardRecord(key), {});
  assert.equal(getBotBoardRecord(otherKey)?.item?.activity.phase, 'running');

  for (const finish of [
    pending => pending.reject(new Error('network timeout')),
    pending => pending.resolve({ ...snapshot(), errors: [{ botId: 'a', code: 'BOARD_UNAVAILABLE' }] }),
  ]) {
    const pending = Promise.withResolvers();
    const pollingError = read(() => pending.promise, ['a']);
    invalidateBotBoardTarget(key);
    finish(pending);
    await pollingError;
    assert.deepEqual(getBotBoardRecord(key), {});
  }

  await read(async () => snapshot(item('a', { phase: 'idle' })), ['a']);
  assert.equal(getBotBoardRecord(key)?.item?.activity.phase, 'idle');
});
