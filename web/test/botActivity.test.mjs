import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canStopBotActivity,
  isBotLlmRunningPhase,
  isBotPreLlmPhase,
  resolveBotActivity,
  resolveComposerActionKind,
  shouldShowComposerStop,
} from '../src/botActivity.ts';

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

test('shouldShowComposerStop covers all 6 stoppable phases and hides when stopping, offline, archived, disallowed, or settled', () => {
  const stoppablePhases = ['queued', 'preparing', 'running', 'compacting', 'interrupting', 'failed'];

  for (const phase of stoppablePhases) {
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

  for (const phase of ['stopping', 'idle', 'stopped', null, undefined]) {
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
