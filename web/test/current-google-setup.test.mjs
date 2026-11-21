import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGoogleSetupControl } from '../../host-core/browser-setup-protocol.js';
import {
  buildGoogleSetupMutationPayload,
  deriveGoogleSetupAttention,
  googleSetupConsoleUrl,
  isStaleGoogleSetupResult,
  readGoogleSetupPresentation,
  reconcileGoogleSetupDockState,
  recordAcceptedGoogleSetupOrder,
  selectCurrentGoogleSetup,
  setGoogleSetupDockExpanded,
  shouldAcceptGoogleSetupResponse,
  shouldRefreshGoogleSetupStatus,
  shouldShowCurrentGoogleSetup,
} from '../src/google/currentGoogleSetup.ts';

function makeSetupPresentation(overrides = {}) {
  return {
    kind: 'google-setup',
    version: 1,
    botId: 'bot-a',
    runId: 'run-1',
    revision: 1,
    state: 'running',
    mode: 'guide-browser',
    step: 'project',
    card: 'step',
    copy: 0,
    title: 'Google setup',
    summary: 'Create project',
    blockerKind: null,
    ...overrides,
  };
}

function makeTool(id, presentation, extra = {}) {
  return {
    id,
    name: extra.name ?? 'google_setup',
    status: extra.status ?? 'done',
    ...(presentation !== undefined ? { presentation } : {}),
    ...(extra.children ? { children: extra.children } : {}),
  };
}

function makeTurn(id, entryId, extra = {}) {
  return {
    id,
    role: 'assistant',
    text: extra.text ?? '',
    entryId,
    ...(extra.blocks ? { blocks: extra.blocks } : {}),
    ...(extra.tools ? { tools: extra.tools } : {}),
  };
}

test('selectCurrentGoogleSetup selects latest valid active flow across blocks, legacy tools, and nested children', () => {
  const first = makeSetupPresentation({ runId: 'run-1', revision: 1, step: 'project', copy: 0 });
  const nestedUpdated = makeSetupPresentation({ runId: 'run-1', revision: 2, step: 'apis', copy: 1 });
  const latestBlock = makeSetupPresentation({ runId: 'run-1', revision: 3, step: 'apis', copy: 2 });

  const turns = [
    // Legacy turn.tools without blocks
    makeTurn('t1', 1, {
      tools: [makeTool('call-1', first)],
    }),
    // Ordered blocks with nested children inside codemode
    makeTurn('t2', 2, {
      blocks: [
        { id: 'b1', kind: 'text', text: 'Working...' },
        {
          id: 'b2',
          kind: 'tools',
          tools: [
            makeTool('call-codemode', undefined, {
              name: 'codemode',
              children: [makeTool('call-child-1', nestedUpdated)],
            }),
          ],
        },
        { id: 'b3', kind: 'text', text: 'Still waiting...' },
        {
          id: 'b4',
          kind: 'tools',
          tools: [
            makeTool('call-2', latestBlock),
            // Malformed presentation must be ignored
            makeTool('call-bad', { kind: 'google-setup', version: 2, runId: 'bad', state: 'running' }),
          ],
        },
      ],
    }),
  ];

  const selected = selectCurrentGoogleSetup(turns);
  assert.deepEqual(selected, latestBlock);
});

test('selectCurrentGoogleSetup never resurrects earlier running flow after terminal done/cancelled/idle record', () => {
  const running = makeSetupPresentation({ runId: 'run-1', revision: 2, state: 'running' });

  for (const terminalState of ['done', 'completed', 'cancelled', 'idle']) {
    const terminal = makeSetupPresentation({
      runId: terminalState === 'idle' ? null : 'run-1',
      revision: 3,
      state: terminalState,
    });
    const turns = [
      makeTurn('t1', 1, { blocks: [{ id: 'b1', kind: 'tools', tools: [makeTool('c1', running)] }] }),
      makeTurn('t2', 2, {
        blocks: [
          {
            id: 'b2',
            kind: 'tools',
            tools: [
              makeTool('c2', undefined, {
                name: 'codemode',
                children: [makeTool('c2-child', terminal)],
              }),
            ],
          },
        ],
      }),
    ];
    assert.equal(selectCurrentGoogleSetup(turns), undefined, `terminal state "${terminalState}" must not resurrect earlier run`);
  }

  // A genuinely new active run after a completed run IS selected.
  const newRun = makeSetupPresentation({ runId: 'run-2', revision: 4, state: 'running', step: 'connect' });
  const turnsWithNewRun = [
    makeTurn('t1', 1, { tools: [makeTool('c1', makeSetupPresentation({ runId: 'run-1', state: 'done', revision: 3 }))] }),
    makeTurn('t2', 2, { tools: [makeTool('c2', newRun)] }),
  ];
  assert.deepEqual(selectCurrentGoogleSetup(turnsWithNewRun), newRun);
});

test('dock collapse persists across same-step polling, revision bumps, and card copy updates, but expands for new operator steps and new runs', () => {
  const baseSetup = {
    id: 'run-1',
    botId: 'bot-a',
    revision: 2,
    state: 'running',
    mode: 'do-it-for-me',
    step: 'project',
    card: { card: 'step', step: 'project', copy: 1 },
    blocker: { kind: 'needs-user', step: 'project' },
  };
  const basePres = makeSetupPresentation({
    runId: 'run-1',
    revision: 2,
    mode: 'do-it-for-me',
    step: 'project',
    card: 'step',
    copy: 1,
    blockerKind: 'needs-user',
  });

  // 1. First display -> expanded by default.
  const sig1 = deriveGoogleSetupAttention(baseSetup, basePres, 'run-1');
  assert.ok(sig1);
  let dock = reconcileGoogleSetupDockState(null, 'scope-a', sig1);
  assert.equal(dock.expanded, true);

  // 2. User collapses current step.
  dock = setGoogleSetupDockExpanded(dock, false);
  assert.equal(dock.expanded, false);
  assert.equal(dock.collapsedStepKey, sig1.stepKey);

  // 3. Same run, same step: polling, revision bump, card copy bump, blocker changes,
  //    browser lock toggles, and mode degradation MUST NOT re-expand a collapsed step.
  const sameStepCopyBump = {
    ...baseSetup,
    revision: 5,
    card: { card: 'step', step: 'project', copy: 3 },
  };
  const sameStepPresBump = makeSetupPresentation({
    ...basePres,
    revision: 5,
    copy: 3,
  });
  const sigSame = deriveGoogleSetupAttention(sameStepCopyBump, sameStepPresBump, 'run-1');
  assert.ok(sigSame);
  assert.equal(sigSame.stepKey, sig1.stepKey);
  dock = reconcileGoogleSetupDockState(dock, 'scope-a', sigSame);
  assert.equal(dock.expanded, false);

  const sameStepBlockerAndLock = {
    ...sameStepCopyBump,
    revision: 6,
    mode: 'guide-browser',
    card: { card: 'progress', step: 'project', copy: 4 },
    blocker: { kind: 'center-unreachable', step: 'project' },
    browserLock: { active: true, step: 'project' },
    modeAvailability: {
      modes: {
        'do-it-for-me': { available: false, reason: 'chromium_start_failed' },
        'guide-here': { available: false, reason: 'chromium_start_failed' },
        'guide-browser': { available: true },
      },
    },
  };
  const sigSameBlocker = deriveGoogleSetupAttention(sameStepBlockerAndLock, null, 'run-1');
  assert.ok(sigSameBlocker);
  assert.equal(sigSameBlocker.stepKey, sig1.stepKey);
  dock = reconcileGoogleSetupDockState(dock, 'scope-a', sigSameBlocker);
  assert.equal(dock.expanded, false);

  const sameStepBlockerCleared = {
    ...sameStepBlockerAndLock,
    revision: 7,
    blocker: null,
    browserLock: { active: false },
  };
  const sigSameCleared = deriveGoogleSetupAttention(sameStepBlockerCleared, null, 'run-1');
  assert.ok(sigSameCleared);
  assert.equal(sigSameCleared.stepKey, sig1.stepKey);
  dock = reconcileGoogleSetupDockState(dock, 'scope-a', sigSameCleared);
  assert.equal(dock.expanded, false);

  // 4. Autonomous bot progress without operator action keeps collapsed.
  const botProgress = {
    id: 'run-1',
    botId: 'bot-a',
    revision: 8,
    state: 'running',
    mode: 'do-it-for-me',
    step: 'apis',
    card: { card: 'progress', copy: 0 },
    blocker: null,
  };
  const sigAuto = deriveGoogleSetupAttention(botProgress, null, 'run-1');
  assert.ok(sigAuto);
  assert.equal(sigAuto.needsOperatorAction, false);
  dock = reconcileGoogleSetupDockState(dock, 'scope-a', sigAuto);
  assert.equal(dock.expanded, false);

  // 5. New step requiring operator action (e.g. sensitive branding takeover) auto-expands.
  const needsUserStep = {
    id: 'run-1',
    botId: 'bot-a',
    revision: 9,
    state: 'running',
    mode: 'do-it-for-me',
    step: 'branding',
    card: { card: 'step', step: 'branding', copy: 0 },
    blocker: { kind: 'needs-user', step: 'branding' },
    browserLock: { active: true, step: 'branding' },
  };
  const sigOperator = deriveGoogleSetupAttention(needsUserStep, null, 'run-1');
  assert.ok(sigOperator);
  assert.equal(sigOperator.needsOperatorAction, true);
  dock = reconcileGoogleSetupDockState(dock, 'scope-a', sigOperator);
  assert.equal(dock.expanded, true);

  // 6. Collapse again, then start a genuinely new run -> auto-expands.
  dock = setGoogleSetupDockExpanded(dock, false);
  const newRunSig = deriveGoogleSetupAttention(
    { ...needsUserStep, id: 'run-2', revision: 10 },
    null,
    'run-2',
  );
  assert.ok(newRunSig);
  dock = reconcileGoogleSetupDockState(dock, 'scope-a', newRunSig);
  assert.equal(dock.expanded, true);
  assert.equal(dock.runId, 'run-2');

  // 7. Collapse again, switch scopeKey -> isolated & defaults expanded.
  dock = setGoogleSetupDockExpanded(dock, false);
  dock = reconcileGoogleSetupDockState(dock, 'scope-b', newRunSig);
  assert.equal(dock.expanded, true);
  assert.equal(dock.scopeKey, 'scope-b');
});

test('response ordering, visibility gating, and status refresh deduplication handle out-of-order and expired data', () => {
  let order = { latestRevision: null, latestSeq: 0 };

  assert.equal(shouldAcceptGoogleSetupResponse(order, { revision: 3 }, 2), true);
  order = recordAcceptedGoogleSetupOrder(order, { revision: 3 }, 2);

  // Older revision arriving later (even with higher seq) is rejected.
  assert.equal(shouldAcceptGoogleSetupResponse(order, { revision: 2 }, 3), false);
  // Same revision from an earlier seq is rejected.
  assert.equal(shouldAcceptGoogleSetupResponse(order, { revision: 3 }, 1), false);
  // Newer monotonic revision (including across runs) is accepted.
  assert.equal(shouldAcceptGoogleSetupResponse(order, { revision: 4 }, 4), true);

  const pres = makeSetupPresentation({ runId: 'run-1', revision: 4, copy: 1 });

  // Terminal or mismatched-run live setup hides the dock.
  assert.equal(shouldShowCurrentGoogleSetup(pres, { id: 'run-1', revision: 5, state: 'done' }, 'run-1'), false);
  assert.equal(shouldShowCurrentGoogleSetup(pres, { id: 'run-1', revision: 5, state: 'cancelled' }, 'run-1'), false);
  assert.equal(shouldShowCurrentGoogleSetup(pres, { id: 'run-2', revision: 5, state: 'running' }, 'run-1'), false);
  assert.equal(shouldShowCurrentGoogleSetup(pres, { id: 'run-1', revision: 4, state: 'running' }, 'run-1'), true);

  // Avoid duplicate status requests when live setup is already at or ahead of presentation.
  const syncedLive = { id: 'run-1', revision: 4, state: 'running', card: { card: 'step', step: 'project', copy: 1 } };
  assert.equal(shouldRefreshGoogleSetupStatus(syncedLive, pres, 'run-1'), false);
  assert.equal(
    shouldRefreshGoogleSetupStatus(syncedLive, makeSetupPresentation({ runId: 'run-1', revision: 3, copy: 0 }), 'run-1'),
    false,
  );
  // Higher revision or copy in presentation triggers refresh.
  assert.equal(
    shouldRefreshGoogleSetupStatus(syncedLive, makeSetupPresentation({ runId: 'run-1', revision: 5, copy: 1 }), 'run-1'),
    true,
  );
  assert.equal(
    shouldRefreshGoogleSetupStatus(syncedLive, makeSetupPresentation({ runId: 'run-1', revision: 4, copy: 2 }), 'run-1'),
    true,
  );
});

test('buildGoogleSetupMutationPayload attaches wire-safe CAS/staleness fields, strips frontend names, and passes Host wire validation', () => {
  const displayed = {
    id: 'run-42',
    botId: 'bot-a',
    revision: 7,
    state: 'running',
    step: 'branding',
    card: { card: 'step', step: 'branding', copy: 2 },
  };

  // Answer on matching displayed step card includes runId, expectedRevision, step, cardCopy and strips frontend keys.
  const answerPayload = buildGoogleSetupMutationPayload(displayed, {
    action: 'answer',
    card: 'step',
    values: ['done', 'branding'],
    expectedRunId: 'should-be-stripped',
    expectedCard: 'should-be-stripped',
    expectedStep: 'should-be-stripped',
    expectedCardCopy: 99,
  });
  assert.deepEqual(answerPayload, {
    action: 'answer',
    card: 'step',
    values: ['done', 'branding'],
    runId: 'run-42',
    expectedRevision: 7,
    step: 'branding',
    cardCopy: 2,
  });
  assert.doesNotThrow(() => normalizeGoogleSetupControl({ botId: 'bot-a', ...answerPayload }));

  // CAS-guarded start-over uses answer(card='step', values=['start-over']) with runId + expectedRevision.
  const startOverPayload = buildGoogleSetupMutationPayload(displayed, {
    action: 'answer',
    card: 'step',
    values: ['start-over'],
  });
  assert.deepEqual(startOverPayload, {
    action: 'answer',
    card: 'step',
    values: ['start-over'],
    runId: 'run-42',
    expectedRevision: 7,
    step: 'branding',
    cardCopy: 2,
  });
  assert.doesNotThrow(() => normalizeGoogleSetupControl({ botId: 'bot-a', ...startOverPayload }));

  // Advance, cancel, and resume all include displayed runId, expectedRevision, card, step, cardCopy and pass Host wire validation.
  for (const raw of [
    { action: 'advance', step: 'branding' },
    { action: 'cancel' },
    { action: 'resume', mode: 'guide-browser' },
  ]) {
    const built = buildGoogleSetupMutationPayload(displayed, raw);
    assert.equal(built.runId, 'run-42');
    assert.equal(built.expectedRevision, 7);
    assert.equal(built.card, 'step');
    assert.equal(built.step, 'branding');
    assert.equal(built.cardCopy, 2);
    assert.doesNotThrow(() => normalizeGoogleSetupControl({ botId: 'bot-a', ...built }));
  }

  // Answer for a different card does not attach mismatched cardCopy from another card.
  const pathAnswer = buildGoogleSetupMutationPayload(displayed, {
    action: 'answer',
    card: 'path',
    values: ['guide-browser'],
  });
  assert.equal(pathAnswer.runId, 'run-42');
  assert.equal(pathAnswer.expectedRevision, 7);
  assert.equal(pathAnswer.cardCopy, undefined);
  assert.doesNotThrow(() => normalizeGoogleSetupControl({ botId: 'bot-a', ...pathAnswer }));

  // status and start never receive runId/expectedRevision/card/step/cardCopy.
  const startPayload = buildGoogleSetupMutationPayload(displayed, { action: 'start', restart: true, expectedRunId: 'x' });
  assert.deepEqual(startPayload, { action: 'start', restart: true });
  assert.doesNotThrow(() => normalizeGoogleSetupControl({ botId: 'bot-a', ...startPayload }));

  const statusPayload = buildGoogleSetupMutationPayload(displayed, { action: 'status', expectedRunId: 'x' });
  assert.deepEqual(statusPayload, { action: 'status' });
  assert.doesNotThrow(() => normalizeGoogleSetupControl({ botId: 'bot-a', ...statusPayload }));

  // Canonical Google Cloud Console URLs match host-core step paths.
  assert.equal(googleSetupConsoleUrl('account'), 'https://console.cloud.google.com/');
  assert.equal(
    googleSetupConsoleUrl('account', { account: 'owner@example.com' }),
    'https://console.cloud.google.com/?authuser=owner%40example.com',
  );
  assert.equal(googleSetupConsoleUrl('project'), 'https://console.cloud.google.com/projectcreate');
  assert.equal(
    googleSetupConsoleUrl('client', { projectId: 'my-demo-proj-1' }),
    'https://console.cloud.google.com/auth/clients/create?project=my-demo-proj-1',
  );
  assert.equal(googleSetupConsoleUrl('connect'), null);

  // Stale detection covers Host stale:true / applied:false responses.
  assert.equal(isStaleGoogleSetupResult({ revision: 8, state: 'running', stale: true, applied: false, staleReason: 'STALE_CARD_COPY' }), true);
  assert.equal(isStaleGoogleSetupResult({ revision: 8, state: 'running', applied: false, staleReason: 'STALE_RUN' }), true);
  assert.equal(isStaleGoogleSetupResult({ revision: 8, state: 'running', applied: true }), false);
  assert.equal(readGoogleSetupPresentation({ kind: 'google-setup', version: 1, revision: -1 }), null);
});
