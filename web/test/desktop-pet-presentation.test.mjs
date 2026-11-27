import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STREAMING_TO_WORKING_DWELL_MS,
  canAutoShowLatestReply,
  captureDismissedStream,
  planMascotTransition,
  reconcileDismissedStream,
} from '../../desktop/web/src/pet/petPresentation.ts';

test('STREAMING_TO_WORKING_DWELL_MS matches the one-sided mascot dwell window', () => {
  assert.equal(STREAMING_TO_WORKING_DWELL_MS, 450);
});

test('captureDismissedStream and reconcileDismissedStream suppress only the dismissed stream and its committed reply', () => {
  const historyBeforeStream = [
    { id: 'u1', role: 'user' },
    { id: 'a0', role: 'assistant' },
    { id: 'u2', role: 'user' },
  ];

  // No active dismissed cursor -> no-op
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed: null,
      streamingText: 'Streaming reply...',
      generationId: 'dev:bot:1',
      messages: historyBeforeStream,
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // Capture anchor at the last committed message before stream A finishes
  const dismissed = captureDismissedStream(historyBeforeStream, 'dev:bot:1');
  assert.deepEqual(dismissed, { anchor: 'u2', generationId: 'dev:bot:1' });

  // While the same generationId is still streaming, keep the exact dismissed cursor and do not dismiss any speech ID yet
  const stillStreaming = reconcileDismissedStream({
    dismissed,
    streamingText: 'First chunk of stream A',
    generationId: 'dev:bot:1',
    messages: historyBeforeStream,
  });
  assert.equal(stillStreaming.dismissed, dismissed);
  assert.equal(stillStreaming.dismissSpeechId, null);

  const stillStreamingMore = reconcileDismissedStream({
    dismissed: stillStreaming.dismissed,
    streamingText: 'First chunk of stream A, continued...',
    generationId: 'dev:bot:1',
    messages: historyBeforeStream,
  });
  assert.equal(stillStreamingMore.dismissed, dismissed);
  assert.equal(stillStreamingMore.dismissSpeechId, null);

  // Same-generation suppression also holds when generationId is null throughout streaming
  const dismissedWithoutGenId = captureDismissedStream(historyBeforeStream, null);
  assert.deepEqual(dismissedWithoutGenId, { anchor: 'u2', generationId: null });
  const stillStreamingNullGen = reconcileDismissedStream({
    dismissed: dismissedWithoutGenId,
    streamingText: 'Streaming without generationId',
    generationId: null,
    messages: historyBeforeStream,
  });
  assert.equal(stillStreamingNullGen.dismissed, dismissedWithoutGenId);
  assert.equal(stillStreamingNullGen.dismissSpeechId, null);

  // When stream A ends and commits assistant message A right after anchor, suppress speech:<A> to prevent resurrection
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [...historyBeforeStream, { id: 'a1', role: 'assistant' }],
    }),
    { dismissed: null, dismissSpeechId: 'speech:a1' },
  );

  // Multi-segment turn where anchor itself was a prior assistant message
  const afterFirstSegment = [...historyBeforeStream, { id: 'a1', role: 'assistant' }];
  const dismissedSecondSegment = captureDismissedStream(afterFirstSegment, 'dev:bot:2');
  assert.deepEqual(dismissedSecondSegment, { anchor: 'a1', generationId: 'dev:bot:2' });
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed: dismissedSecondSegment,
      streamingText: '',
      generationId: null,
      messages: [...afterFirstSegment, { id: 'a2', role: 'assistant' }],
    }),
    { dismissed: null, dismissSpeechId: 'speech:a2' },
  );
});

test('reconcileDismissedStream handles empty history before the dismissed stream (anchor === "")', () => {
  const dismissed = captureDismissedStream([], 'dev:bot:1');
  assert.deepEqual(dismissed, { anchor: '', generationId: 'dev:bot:1' });

  // Same stream still running against empty history keeps cursor
  const stillStreaming = reconcileDismissedStream({
    dismissed,
    streamingText: 'First reply ever...',
    generationId: 'dev:bot:1',
    messages: [],
  });
  assert.equal(stillStreaming.dismissed, dismissed);
  assert.equal(stillStreaming.dismissSpeechId, null);

  // Assistant message A commits as messages[0] -> suppresses speech:<A>
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [{ id: 'a1', role: 'assistant' }],
    }),
    { dismissed: null, dismissSpeechId: 'speech:a1' },
  );

  // Aborted stream with empty history -> clears cursor without suppressing anything
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [],
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // User message lands at messages[0] instead of an assistant commit -> clears cursor without swallowing later reply
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [
        { id: 'u1', role: 'user' },
        { id: 'a2', role: 'assistant' },
      ],
    }),
    { dismissed: null, dismissSpeechId: null },
  );
});

test('reconcileDismissedStream handles coalesced frames without suppressing a subsequent stream or reply', () => {
  const historyBeforeA = [{ id: 'u1', role: 'user' }];
  const dismissed = captureDismissedStream(historyBeforeA, 'dev:bot:1');

  // Coalesced frame 1: stream A commits as a1 AND stream B is already streaming with a new generationId
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: 'Stream B already underway',
      generationId: 'dev:bot:2',
      messages: [
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant' },
      ],
    }),
    { dismissed: null, dismissSpeechId: 'speech:a1' },
  );

  // Same coalesced transition when history before stream A was empty
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed: captureDismissedStream([], 'dev:bot:1'),
      streamingText: 'Stream B already underway',
      generationId: 'dev:bot:2',
      messages: [{ id: 'a1', role: 'assistant' }],
    }),
    { dismissed: null, dismissSpeechId: 'speech:a1' },
  );

  // Coalesced frame 2: stream A commits as a1 AND message B (a2) also already committed
  const coalescedCommitted = reconcileDismissedStream({
    dismissed,
    streamingText: '',
    generationId: null,
    messages: [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'a2', role: 'assistant' },
    ],
  });
  assert.deepEqual(coalescedCommitted, { dismissed: null, dismissSpeechId: 'speech:a1' });

  // Only speech:a1 is suppressed, leaving speech:a2 eligible to auto-show
  const dismissedIds = new Set(coalescedCommitted.dismissSpeechId ? [coalescedCommitted.dismissSpeechId] : []);
  assert.equal(
    canAutoShowLatestReply({
      replyId: 'speech:a2',
      initialReplyId: '',
      hasPendingUserTurn: false,
      forcedReplyId: null,
      dndMode: false,
      dismissedIds,
      suppressingStream: false,
    }),
    true,
  );

  // Coalesced double-commit with empty initial history also suppresses only messages[0]
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed: captureDismissedStream([], 'dev:bot:1'),
      streamingText: '',
      generationId: null,
      messages: [
        { id: 'a1', role: 'assistant' },
        { id: 'a2', role: 'assistant' },
      ],
    }),
    { dismissed: null, dismissSpeechId: 'speech:a1' },
  );
});

test('reconcileDismissedStream clears cursor safely on abort, new user message, or rotated/reset history', () => {
  const historyBeforeA = [
    { id: 'u1', role: 'user' },
    { id: 'a0', role: 'assistant' },
    { id: 'u2', role: 'user' },
  ];
  const dismissed = captureDismissedStream(historyBeforeA, 'dev:bot:1');

  // Aborted stream with no new commit after anchor
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: historyBeforeA,
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // Aborted stream followed immediately by a new generation with no commit after anchor
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: 'Fresh generation',
      generationId: 'dev:bot:2',
      messages: historyBeforeA,
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // New user message arrives right after anchor (without an assistant commit from stream A)
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [
        ...historyBeforeA,
        { id: 'u3', role: 'user' },
      ],
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // New user message right after anchor followed by a reply to that new user turn must not swallow the new reply
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [
        ...historyBeforeA,
        { id: 'u3', role: 'user' },
        { id: 'a3', role: 'assistant' },
      ],
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // History cleared/reset so anchor is gone
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [],
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // History rotated/reset with unrelated new assistant replies -> anchor not found, never swallows them
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: '',
      generationId: null,
      messages: [
        { id: 'a-unrelated-1', role: 'assistant' },
        { id: 'a-unrelated-2', role: 'assistant' },
      ],
    }),
    { dismissed: null, dismissSpeechId: null },
  );

  // Rotated history combined with a new streaming generation also clears safely
  assert.deepEqual(
    reconcileDismissedStream({
      dismissed,
      streamingText: 'New session stream',
      generationId: 'dev:bot:9',
      messages: [{ id: 'a-unrelated-1', role: 'assistant' }],
    }),
    { dismissed: null, dismissSpeechId: null },
  );
});

test('canAutoShowLatestReply gates baseline, pending turns, DND, stream suppression, dismissal, and explicit recall', () => {
  const autoShow = (overrides = {}) =>
    canAutoShowLatestReply({
      replyId: 'speech:a2',
      initialReplyId: 'speech:a1',
      hasPendingUserTurn: false,
      forcedReplyId: null,
      dndMode: false,
      dismissedIds: new Set(),
      suppressingStream: false,
      ...overrides,
    });

  // Baseline suppression: suppresses initial baseline reply and uncaptured baseline (null)
  assert.equal(autoShow({ replyId: 'speech:a1', initialReplyId: 'speech:a1' }), false);
  assert.equal(autoShow({ initialReplyId: null }), false);

  // Fresh reply shows when baseline is captured (including empty initial baseline) and no blockers are active
  assert.equal(autoShow(), true);
  assert.equal(autoShow({ initialReplyId: '' }), true);
  assert.equal(autoShow({ dismissedIds: new Set(['speech:a1']) }), true);

  // Dismissed reply stays hidden
  assert.equal(autoShow({ dismissedIds: new Set(['speech:a2']) }), false);

  // Active turn/DND/stream-suppression blockers hide previous-turn reply
  assert.equal(autoShow({ hasPendingUserTurn: true }), false);
  assert.equal(autoShow({ dndMode: true }), false);
  assert.equal(autoShow({ suppressingStream: true }), false);

  // Explicit recall (forcedReplyId === replyId) overrides pending turn, DND, stream suppression, and baseline
  assert.equal(autoShow({ forcedReplyId: 'speech:a2', hasPendingUserTurn: true }), true);
  assert.equal(autoShow({ forcedReplyId: 'speech:a2', dndMode: true }), true);
  assert.equal(autoShow({ forcedReplyId: 'speech:a2', suppressingStream: true }), true);
  assert.equal(
    autoShow({
      replyId: 'speech:a1',
      initialReplyId: 'speech:a1',
      forcedReplyId: 'speech:a1',
      hasPendingUserTurn: true,
      dndMode: true,
      suppressingStream: true,
    }),
    true,
  );
  assert.equal(autoShow({ initialReplyId: null, forcedReplyId: 'speech:a2' }), true);

  // Mismatched forcedReplyId does not bypass blockers or baseline
  assert.equal(autoShow({ forcedReplyId: 'speech:other', hasPendingUserTurn: true }), false);
  assert.equal(autoShow({ forcedReplyId: 'speech:other', dndMode: true }), false);
  assert.equal(autoShow({ forcedReplyId: 'speech:other', suppressingStream: true }), false);
  assert.equal(autoShow({ replyId: 'speech:a1', initialReplyId: 'speech:a1', forcedReplyId: 'speech:other' }), false);

  // Explicit dismissal still wins over explicit recall
  assert.equal(
    autoShow({
      forcedReplyId: 'speech:a2',
      dismissedIds: new Set(['speech:a2']),
    }),
    false,
  );
  assert.equal(
    autoShow({
      forcedReplyId: 'speech:a2',
      hasPendingUserTurn: true,
      dndMode: true,
      suppressingStream: true,
      dismissedIds: new Set(['speech:a2']),
    }),
    false,
  );
});

test('planMascotTransition delays only non-overridden streaming-to-working transitions', () => {
  // Same state always returns noop regardless of local override
  const states = [
    'idle',
    'working',
    'streaming',
    'blocked',
    'failed',
    'powering-down',
    'listening',
    'thinking',
    'dictating',
  ];
  for (const state of states) {
    assert.deepEqual(
      planMascotTransition({ displayed: state, target: state, hasLocalOverride: false }),
      { kind: 'noop' },
    );
    assert.deepEqual(
      planMascotTransition({ displayed: state, target: state, hasLocalOverride: true }),
      { kind: 'noop' },
    );
  }

  // Only streaming -> working without a local override uses the one-sided dwell delay
  assert.deepEqual(
    planMascotTransition({
      displayed: 'streaming',
      target: 'working',
      hasLocalOverride: false,
    }),
    { kind: 'delay', state: 'working', delayMs: STREAMING_TO_WORKING_DWELL_MS },
  );

  // Local override bypasses dwell delay and commits working immediately
  assert.deepEqual(
    planMascotTransition({
      displayed: 'streaming',
      target: 'working',
      hasLocalOverride: true,
    }),
    { kind: 'immediate', state: 'working' },
  );

  // All other state transitions apply immediately
  const immediateTransitions = [
    ['idle', 'working'],
    ['working', 'streaming'],
    ['streaming', 'idle'],
    ['streaming', 'blocked'],
    ['streaming', 'failed'],
    ['streaming', 'powering-down'],
    ['streaming', 'listening'],
    ['streaming', 'thinking'],
    ['streaming', 'dictating'],
    ['working', 'blocked'],
    ['working', 'idle'],
    ['blocked', 'working'],
    ['listening', 'working'],
  ];
  for (const [displayed, target] of immediateTransitions) {
    assert.deepEqual(
      planMascotTransition({ displayed, target, hasLocalOverride: false }),
      { kind: 'immediate', state: target },
      `${displayed} -> ${target} (no override)`,
    );
    assert.deepEqual(
      planMascotTransition({ displayed, target, hasLocalOverride: true }),
      { kind: 'immediate', state: target },
      `${displayed} -> ${target} (override)`,
    );
  }
});
