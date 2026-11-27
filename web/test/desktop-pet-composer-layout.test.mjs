import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PET_LAYOUT_CONSTANTS,
  ackComposerOpenNative,
  beginComposerClose,
  beginComposerOpen,
  canCommitComposerOpen,
  commitComposerOpen,
  completeComposerClose,
  createInitialComposerState,
  doesViewportMatchLayout,
  estimateComposerHeight,
  evaluateComposerFocusEvent,
  forceCloseComposer,
  isViewportReadyForTarget,
  mergePetOrientation,
  planComposerCloseLayout,
  planComposerOpenLayout,
  shouldHoldOrientationUpdate,
  shouldRenderComposer,
  shouldSyncNormalNativeLayout,
} from '../../desktop/web/src/pet/composerLayout.ts';

test('PET_LAYOUT_CONSTANTS stays synchronized with native and CSS geometry', () => {
  assert.equal(PET_LAYOUT_CONSTANTS.COLLAPSED_W, 164);
  assert.equal(PET_LAYOUT_CONSTANTS.COLLAPSED_H, 128);
  assert.equal(PET_LAYOUT_CONSTANTS.MAX_STAGE_W, 520);
  assert.equal(PET_LAYOUT_CONSTANTS.MAX_STAGE_H, 720);
  assert.equal(PET_LAYOUT_CONSTANTS.STAGE_PAD, 12);
  assert.equal(PET_LAYOUT_CONSTANTS.DOCK_HEIGHT, 104);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_PILL_WIDTH, 296);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_PILL_BASE_HEIGHT, 44);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_LINE_HEIGHT, 19);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_TEXTAREA_BASE_HEIGHT, 28);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_TEXTAREA_MAX_HEIGHT, 72);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_RECALL_GAP, 5);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_RECALL_HEIGHT, 22);
  assert.equal(PET_LAYOUT_CONSTANTS.COMPOSER_GAP, 8);
  assert.equal(PET_LAYOUT_CONSTANTS.VIEWPORT_SIZE_TOLERANCE, 4);
  assert.equal(PET_LAYOUT_CONSTANTS.OPEN_READY_TIMEOUT_MS, 120);
  assert.equal(PET_LAYOUT_CONSTANTS.OPEN_IPC_TIMEOUT_MS, 350);
  assert.equal(PET_LAYOUT_CONSTANTS.BLUR_DISMISS_GRACE_MS, 180);
});

test('estimateComposerHeight accounts for gap, recall chip, multiline and wrapped drafts with clamping', () => {
  assert.equal(estimateComposerHeight({ canRecallReply: false, draft: '' }), 52);
  assert.equal(estimateComposerHeight({ canRecallReply: true, draft: '' }), 79);
  assert.equal(estimateComposerHeight({ canRecallReply: false, draft: 'hello' }), 52);

  // Explicit line breaks: 2 lines (+19), 3+ lines capped at +38
  assert.equal(estimateComposerHeight({ canRecallReply: false, draft: 'line 1\nline 2' }), 71);
  assert.equal(estimateComposerHeight({ canRecallReply: true, draft: 'line 1\nline 2' }), 98);
  assert.equal(estimateComposerHeight({ canRecallReply: false, draft: 'a\nb\nc' }), 90);
  assert.equal(estimateComposerHeight({ canRecallReply: true, draft: 'a\nb\nc\nd\ne' }), 117);

  // Soft-wrapped long single lines (22 chars per visual line)
  assert.equal(estimateComposerHeight({ canRecallReply: false, draft: 'x'.repeat(22) }), 52);
  assert.equal(estimateComposerHeight({ canRecallReply: false, draft: 'x'.repeat(23) }), 71);
  assert.equal(estimateComposerHeight({ canRecallReply: true, draft: 'x'.repeat(60) }), 117);
});

test('planComposerOpenLayout and planComposerCloseLayout preserve bounds across collapsed, recall, and bubble states', () => {
  // Collapsed dock only (140x104 content) -> 320x180 without recall, 320x207 with recall
  assert.deepEqual(
    planComposerOpenLayout({
      baseContentWidth: 140,
      baseContentHeight: 104,
      canRecallReply: false,
      draft: '',
    }),
    { width: 320, height: 180, composerHeight: 52 },
  );
  assert.deepEqual(
    planComposerOpenLayout({
      baseContentWidth: 140,
      baseContentHeight: 104,
      canRecallReply: true,
      draft: '',
    }),
    { width: 320, height: 207, composerHeight: 79 },
  );

  // Center-dock idle width (170px) still expands cleanly to 320px pill envelope
  assert.deepEqual(
    planComposerOpenLayout({
      baseContentWidth: 170,
      baseContentHeight: 104,
      canRecallReply: false,
    }),
    { width: 320, height: 180, composerHeight: 52 },
  );

  // Active speech reply bubble (332px wide, bubble + gap + dock = 358px tall)
  assert.deepEqual(
    planComposerOpenLayout({
      baseContentWidth: 332,
      baseContentHeight: 358,
      canRecallReply: false,
    }),
    { width: 356, height: 434, composerHeight: 52 },
  );

  // Active questionnaire bubble (344px wide) + recall chip + 2-line draft
  assert.deepEqual(
    planComposerOpenLayout({
      baseContentWidth: 344,
      baseContentHeight: 480,
      canRecallReply: true,
      draft: 'first\nsecond',
    }),
    { width: 368, height: 602, composerHeight: 98 },
  );

  // Clamps to MAX_STAGE_W x MAX_STAGE_H and keeps composerHeight <= height - COLLAPSED_H
  const clamped = planComposerOpenLayout({
    baseContentWidth: 640,
    baseContentHeight: 700,
    canRecallReply: true,
    draft: 'a\nb\nc',
  });
  assert.equal(clamped.width, PET_LAYOUT_CONSTANTS.MAX_STAGE_W);
  assert.equal(clamped.height, PET_LAYOUT_CONSTANTS.MAX_STAGE_H);
  assert.equal(clamped.composerHeight, 117);
  assert.ok(clamped.composerHeight <= clamped.height - PET_LAYOUT_CONSTANTS.COLLAPSED_H);

  // Closing without bubble always collapses to exact 164x128 regardless of previous content size
  assert.deepEqual(
    planComposerCloseLayout({
      hasBubble: false,
      baseContentWidth: 296,
      baseContentHeight: 180,
    }),
    { width: 164, height: 128, composerHeight: 0 },
  );

  // Closing with an active reply bubble keeps bubble envelope and resets composerHeight to 0
  assert.deepEqual(
    planComposerCloseLayout({
      hasBubble: true,
      baseContentWidth: 332,
      baseContentHeight: 358,
    }),
    { width: 356, height: 382, composerHeight: 0 },
  );
  assert.deepEqual(
    planComposerCloseLayout({
      hasBubble: true,
      baseContentWidth: 600,
      baseContentHeight: 800,
    }),
    { width: 520, height: 720, composerHeight: 0 },
  );
  assert.deepEqual(
    planComposerCloseLayout({
      hasBubble: true,
      baseContentWidth: 80,
      baseContentHeight: 80,
    }),
    { width: 164, height: 128, composerHeight: 0 },
  );
});

test('two-phase composer open blocks DOM mount in collapsed viewport and reveals synchronously with native orientation', () => {
  const target = planComposerOpenLayout({
    baseContentWidth: 140,
    baseContentHeight: 104,
    canRecallReply: false,
  });
  let orientation = { dockSide: 'right', panelSide: 'top', composited: true };

  // Phase 0: closed
  const s0 = createInitialComposerState();
  assert.equal(s0.phase, 'closed');
  assert.equal(shouldRenderComposer(s0.phase, false), false);
  assert.equal(shouldSyncNormalNativeLayout(s0.phase), true);
  assert.equal(shouldHoldOrientationUpdate(s0.phase), false);
  assert.deepEqual(canCommitComposerOpen(s0, { width: 320, height: 180 }), {
    ready: false,
    reason: 'not-opening',
  });

  // Phase 1: click avatar -> enter opening, request native set-layout, keep composer unmounted
  const s1 = beginComposerOpen(s0, target);
  assert.equal(s1.phase, 'opening');
  assert.equal(s1.token, s0.token + 1);
  assert.equal(s1.nativeAcked, false);
  assert.equal(shouldRenderComposer(s1.phase, false), false, 'composer must not mount into collapsed 164x128 viewport');
  assert.equal(shouldHoldOrientationUpdate(s1.phase), true, 'orientation must hold until native expansion commits');
  assert.equal(shouldSyncNormalNativeLayout(s1.phase), false, 'normal layout sync must pause during opening');
  assert.deepEqual(canCommitComposerOpen(s1, { width: 164, height: 128 }), {
    ready: false,
    reason: 'awaiting-native',
  });
  assert.deepEqual(canCommitComposerOpen(s1, { width: 320, height: 180 }), {
    ready: false,
    reason: 'awaiting-native',
  });

  // Stale token ack is ignored
  const staleAck = ackComposerOpenNative(s1, s1.token - 1, {
    dockSide: 'left',
    panelSide: 'bottom',
  });
  assert.equal(staleAck.nativeAcked, false);
  assert.equal(staleAck.pendingOrientation, null);

  // Phase 2: native set-layout resolves (e.g. Windows 1.5x monitor Right -> Center transition),
  // but WebView2 SetBounds is still catching up (viewport still collapsed 164x128)
  const s2 = ackComposerOpenNative(s1, s1.token, {
    dockSide: 'center',
    panelSide: 'top',
    composited: true,
    focused: true,
  });
  assert.equal(s2.phase, 'opening');
  assert.equal(s2.nativeAcked, true);
  assert.equal(s2.nativeFocused, true);
  assert.equal(shouldRenderComposer(s2.phase, false), false, 'composer must wait for WebView2 viewport growth');
  assert.deepEqual(canCommitComposerOpen(s2, { width: 164, height: 128 }), {
    ready: false,
    reason: 'awaiting-viewport',
  });
  assert.deepEqual(canCommitComposerOpen(s2, { width: 300, height: 180 }), {
    ready: false,
    reason: 'awaiting-viewport',
  });

  // Phase 3: viewport reaches target within tolerance -> ready to commit synchronously with new orientation
  assert.deepEqual(canCommitComposerOpen(s2, { width: 316, height: 176 }), {
    ready: true,
    reason: 'viewport-ready',
  });
  const committed = commitComposerOpen(s2, 1000, false);
  orientation = mergePetOrientation(orientation, committed.orientation);
  assert.equal(committed.state.phase, 'open');
  assert.equal(committed.state.openedAt, 1000);
  assert.equal(committed.state.pendingTarget, null);
  assert.equal(committed.state.pendingOrientation, null);
  assert.equal(committed.state.nativeFocused, true);
  assert.equal(committed.state.hasConfirmedFocus, false);
  assert.deepEqual(orientation, { dockSide: 'center', panelSide: 'top', composited: true });
  assert.equal(shouldRenderComposer(committed.state.phase, false), true);
  assert.equal(shouldRenderComposer(committed.state.phase, true), false, 'settings bubble suppresses composer');
  assert.equal(shouldHoldOrientationUpdate(committed.state.phase), false);
  assert.equal(shouldSyncNormalNativeLayout(committed.state.phase), true);

  // Calling commitComposerOpen outside opening is a safe no-op
  const noopCommit = commitComposerOpen(committed.state, 1050);
  assert.equal(noopCommit.state, committed.state);
  assert.equal(noopCommit.orientation, null);
});

test('ackComposerOpenNative converges work-area capped sizes and timeout fallback prevents deadlocks', () => {
  const s0 = createInitialComposerState();
  const requested = planComposerOpenLayout({
    baseContentWidth: 344,
    baseContentHeight: 498,
    canRecallReply: true,
  });
  const s1 = beginComposerOpen(s0, requested);

  // Timeout fallback commits even if native IPC or viewport resize never completes
  assert.deepEqual(canCommitComposerOpen(s1, { width: 164, height: 128 }, true), {
    ready: true,
    reason: 'timeout-fallback',
  });

  // Small monitor caps native height from 601 -> 540: viewport at 540 becomes immediately ready
  const s2 = ackComposerOpenNative(s1, s1.token, {
    width: 368,
    height: 540,
    dockSide: 'left',
    panelSide: 'bottom',
  });
  assert.equal(s2.pendingTarget?.width, 368);
  assert.equal(s2.pendingTarget?.height, 540);
  assert.deepEqual(canCommitComposerOpen(s2, { width: 368, height: 540 }), {
    ready: true,
    reason: 'viewport-ready',
  });

  // Timeout fallback never fires outside opening phase
  const committed = commitComposerOpen(s2, 2000).state;
  assert.deepEqual(canCommitComposerOpen(committed, { width: 164, height: 128 }, true), {
    ready: false,
    reason: 'not-opening',
  });
});

test('isViewportReadyForTarget allows larger viewports while doesViewportMatchLayout enforces tolerance band', () => {
  const target = { width: 320, height: 180 };

  assert.equal(isViewportReadyForTarget({ width: 320, height: 180 }, target), true);
  assert.equal(doesViewportMatchLayout({ width: 320, height: 180 }, target), true);

  // Exact tolerance boundaries (+/-4)
  assert.equal(isViewportReadyForTarget({ width: 316, height: 176 }, target), true);
  assert.equal(doesViewportMatchLayout({ width: 316, height: 176 }, target), true);
  assert.equal(isViewportReadyForTarget({ width: 315, height: 180 }, target), false);
  assert.equal(isViewportReadyForTarget({ width: 320, height: 175 }, target), false);
  assert.equal(doesViewportMatchLayout({ width: 315, height: 180 }, target), false);

  // Larger viewport is safe to mount composer (no overflow) but not an exact hit-rect match
  assert.equal(isViewportReadyForTarget({ width: 324, height: 184 }, target), true);
  assert.equal(doesViewportMatchLayout({ width: 324, height: 184 }, target), true);
  assert.equal(isViewportReadyForTarget({ width: 380, height: 320 }, target), true);
  assert.equal(doesViewportMatchLayout({ width: 380, height: 320 }, target), false);
  assert.equal(doesViewportMatchLayout({ width: 325, height: 180 }, target), false);
});

test('composer close exits visible DOM layout before native window shrink and rejects stale tokens', () => {
  const target = planComposerOpenLayout({
    baseContentWidth: 140,
    baseContentHeight: 104,
    canRecallReply: false,
  });
  let state = beginComposerOpen(createInitialComposerState(), target);
  state = ackComposerOpenNative(state, state.token, { dockSide: 'right', panelSide: 'top', focused: true });
  state = commitComposerOpen(state, 1000).state;
  assert.equal(shouldRenderComposer(state.phase, false), true);

  // Begin close -> composer immediately exits visible layout while native shrink is pending
  const closing = beginComposerClose(state);
  assert.equal(closing.phase, 'closing');
  assert.equal(closing.token, state.token + 1);
  assert.equal(shouldRenderComposer(closing.phase, false), false, 'composer must unmount before native window shrinks');
  assert.equal(shouldSyncNormalNativeLayout(closing.phase), false, 'normal layout sync paused until shrink finishes');
  assert.equal(shouldHoldOrientationUpdate(closing.phase), true);

  // Stale close completion is ignored
  const stillClosing = completeComposerClose(closing, closing.token - 1);
  assert.equal(stillClosing.phase, 'closing');

  // Matching close completion restores steady closed phase
  const closed = completeComposerClose(closing, closing.token);
  assert.equal(closed.phase, 'closed');
  assert.equal(shouldRenderComposer(closed.phase, false), false);
  assert.equal(shouldSyncNormalNativeLayout(closed.phase), true);
  assert.equal(shouldHoldOrientationUpdate(closed.phase), false);

  // Rapid reopen during closing invalidates the previous close token
  const reopened = beginComposerOpen(closing, target);
  assert.equal(reopened.phase, 'opening');
  assert.equal(reopened.token, closing.token + 1);
  const afterStaleClose = completeComposerClose(reopened, closing.token);
  assert.equal(afterStaleClose.phase, 'opening');

  // forceCloseComposer immediately exits any active phase (e.g. window hide / Escape / send)
  const forced = forceCloseComposer(reopened);
  assert.equal(forced.phase, 'closed');
  assert.equal(forced.token, reopened.token + 1);
  assert.equal(ackComposerOpenNative(forced, reopened.token, { dockSide: 'left' }).phase, 'closed');
});

test('Windows focused:false echoes during opening and grace window never falsely close composer', () => {
  const target = planComposerOpenLayout({
    baseContentWidth: 140,
    baseContentHeight: 104,
    canRecallReply: false,
  });

  // 1. During opening phase, native focused:false echoes and transient blurs are completely ignored
  let s = beginComposerOpen(createInitialComposerState({ nativeFocused: false, domFocused: true }), target);
  let res = evaluateComposerFocusEvent(s, {
    kind: 'native-focus',
    focused: false,
    documentHasFocus: false,
    now: 900,
  });
  assert.equal(res.shouldDismiss, false);
  assert.equal(res.state.phase, 'opening');

  res = evaluateComposerFocusEvent(res.state, {
    kind: 'window-blur',
    documentHasFocus: false,
    now: 920,
  });
  assert.equal(res.shouldDismiss, false);
  assert.equal(res.state.phase, 'opening');

  res = evaluateComposerFocusEvent(res.state, {
    kind: 'composer-blur',
    targetInComposer: false,
    targetInDock: false,
    hasRelatedTarget: true,
    documentHasFocus: false,
    now: 930,
  });
  assert.equal(res.shouldDismiss, false);

  // 2. Native ack omits focused (or old Windows is_focused() returned false); commit opens at t=1000
  s = ackComposerOpenNative(res.state, res.state.token, { dockSide: 'center', panelSide: 'top' });
  s = commitComposerOpen(s, 1000, true).state;
  assert.equal(s.phase, 'open');
  assert.equal(s.nativeFocused, false);
  assert.equal(s.hasConfirmedFocus, false);

  // Stale pibot:pet-window focused:false right after open while document still has focus -> immune
  res = evaluateComposerFocusEvent(s, {
    kind: 'native-focus',
    focused: false,
    documentHasFocus: true,
    now: 1020,
  });
  assert.equal(res.shouldDismiss, false);

  // Repeated set-layout focused:false echo even AFTER grace period while document still has focus -> still immune!
  res = evaluateComposerFocusEvent(res.state, {
    kind: 'native-focus',
    focused: false,
    documentHasFocus: true,
    now: 1500,
  });
  assert.equal(res.shouldDismiss, false);

  // Native focused:false before grace expires (179ms < 180ms) with unconfirmed focus -> immune
  res = evaluateComposerFocusEvent(s, {
    kind: 'native-focus',
    focused: false,
    documentHasFocus: false,
    now: 1179,
  });
  assert.equal(res.shouldDismiss, false);

  // Native focused:false when neither native nor DOM ever confirmed focus -> still immune even after grace
  res = evaluateComposerFocusEvent(s, {
    kind: 'native-focus',
    focused: false,
    documentHasFocus: false,
    now: 1300,
  });
  assert.equal(res.shouldDismiss, false);

  // Window blur inside grace window before focus confirmation -> immune
  res = evaluateComposerFocusEvent(s, {
    kind: 'window-blur',
    documentHasFocus: false,
    now: 1100,
  });
  assert.equal(res.shouldDismiss, false);

  // Window blur while documentHasFocus is still true -> immune even after grace
  res = evaluateComposerFocusEvent(s, {
    kind: 'window-blur',
    documentHasFocus: true,
    now: 1500,
  });
  assert.equal(res.shouldDismiss, false);

  // Composer blur with null relatedTarget inside grace before focus confirmation -> immune
  res = evaluateComposerFocusEvent(s, {
    kind: 'composer-blur',
    targetInComposer: false,
    targetInDock: false,
    hasRelatedTarget: false,
    documentHasFocus: false,
    now: 1100,
  });
  assert.equal(res.shouldDismiss, false);
});

test('real focus loss after stable focus dismisses composer while preserving internal controls, avatar click, and recording', () => {
  const target = planComposerOpenLayout({
    baseContentWidth: 140,
    baseContentHeight: 104,
    canRecallReply: false,
  });
  const openWithNativeAck = (focused) => {
    let s = beginComposerOpen(createInitialComposerState(), target);
    s = ackComposerOpenNative(s, s.token, { dockSide: 'right', panelSide: 'top', focused });
    return commitComposerOpen(s, 1000, false).state;
  };

  // Case 1: Confirmed native + composer focus -> real OS focus loss dismisses even inside grace period
  let s = openWithNativeAck(true);
  s = evaluateComposerFocusEvent(s, { kind: 'composer-focus', now: 1010 }).state;
  assert.equal(s.hasConfirmedFocus, true);
  assert.equal(s.domFocused, true);

  // Spurious native false while document still focused within grace -> immune
  assert.equal(
    evaluateComposerFocusEvent(s, {
      kind: 'native-focus',
      focused: false,
      documentHasFocus: true,
      now: 1050,
    }).shouldDismiss,
    false,
  );

  // Real OS switch (both native and document lost focus) -> dismisses
  assert.equal(
    evaluateComposerFocusEvent(s, {
      kind: 'native-focus',
      focused: false,
      documentHasFocus: false,
      now: 1050,
    }).shouldDismiss,
    true,
  );

  // Case 2: Disabled textarea (no composer-focus, only native ack focused:true) -> dismisses at exact grace boundary (180ms)
  const disabledTextareaState = openWithNativeAck(true);
  assert.equal(
    evaluateComposerFocusEvent(disabledTextareaState, {
      kind: 'native-focus',
      focused: false,
      documentHasFocus: false,
      now: 1179,
    }).shouldDismiss,
    false,
  );
  assert.equal(
    evaluateComposerFocusEvent(disabledTextareaState, {
      kind: 'native-focus',
      focused: false,
      documentHasFocus: false,
      now: 1180,
    }).shouldDismiss,
    true,
  );

  // Case 3: Native focus arrives after commit -> subsequent native focus loss dismisses
  let s3 = openWithNativeAck(undefined);
  s3 = evaluateComposerFocusEvent(s3, {
    kind: 'native-focus',
    focused: true,
    documentHasFocus: true,
    now: 1030,
  }).state;
  assert.equal(s3.nativeFocused, true);
  assert.equal(s3.hasConfirmedFocus, true);
  assert.equal(
    evaluateComposerFocusEvent(s3, {
      kind: 'native-focus',
      focused: false,
      documentHasFocus: false,
      now: 1250,
    }).shouldDismiss,
    true,
  );

  // Case 4: window-blur after window-focus (or after grace) dismisses
  let s4 = openWithNativeAck(undefined);
  s4 = evaluateComposerFocusEvent(s4, { kind: 'window-focus', now: 1015 }).state;
  assert.equal(
    evaluateComposerFocusEvent(s4, {
      kind: 'window-blur',
      documentHasFocus: false,
      now: 1050,
    }).shouldDismiss,
    true,
  );
  assert.equal(
    evaluateComposerFocusEvent(openWithNativeAck(undefined), {
      kind: 'window-blur',
      documentHasFocus: false,
      now: 1180,
    }).shouldDismiss,
    true,
  );

  // Case 5: composer-blur keeps focus inside composer or dock (for avatar toggle), dismisses outside
  const confirmed = evaluateComposerFocusEvent(openWithNativeAck(true), {
    kind: 'composer-focus',
    now: 1010,
  }).state;
  assert.equal(
    evaluateComposerFocusEvent(confirmed, {
      kind: 'composer-blur',
      targetInComposer: true,
      targetInDock: false,
      hasRelatedTarget: true,
      documentHasFocus: true,
      now: 1200,
    }).shouldDismiss,
    false,
  );
  assert.equal(
    evaluateComposerFocusEvent(confirmed, {
      kind: 'composer-blur',
      targetInComposer: false,
      targetInDock: true,
      hasRelatedTarget: true,
      documentHasFocus: true,
      now: 1200,
    }).shouldDismiss,
    false,
  );
  assert.equal(
    evaluateComposerFocusEvent(confirmed, {
      kind: 'composer-blur',
      targetInComposer: false,
      targetInDock: false,
      hasRelatedTarget: true,
      documentHasFocus: true,
      now: 1020,
    }).shouldDismiss,
    true,
  );
  assert.equal(
    evaluateComposerFocusEvent(confirmed, {
      kind: 'composer-blur',
      targetInComposer: false,
      targetInDock: false,
      hasRelatedTarget: false,
      documentHasFocus: false,
      now: 1050,
    }).shouldDismiss,
    true,
  );
  assert.equal(
    evaluateComposerFocusEvent(openWithNativeAck(undefined), {
      kind: 'composer-blur',
      targetInComposer: false,
      targetInDock: false,
      hasRelatedTarget: false,
      documentHasFocus: false,
      now: 1180,
    }).shouldDismiss,
    true,
  );

  // Case 6: Active voice recording or avatar pointer press blocks dismissal across all blur events
  for (const guard of [{ isRecording: true }, { isAvatarPressing: true }]) {
    assert.equal(
      evaluateComposerFocusEvent(confirmed, {
        kind: 'native-focus',
        focused: false,
        documentHasFocus: false,
        now: 2000,
        ...guard,
      }).shouldDismiss,
      false,
    );
    assert.equal(
      evaluateComposerFocusEvent(confirmed, {
        kind: 'window-blur',
        documentHasFocus: false,
        now: 2000,
        ...guard,
      }).shouldDismiss,
      false,
    );
    assert.equal(
      evaluateComposerFocusEvent(confirmed, {
        kind: 'composer-blur',
        targetInComposer: false,
        targetInDock: false,
        hasRelatedTarget: true,
        documentHasFocus: false,
        now: 2000,
        ...guard,
      }).shouldDismiss,
      false,
    );
  }
});

test('all six dockSide x panelSide orientations and recall/bubble combinations satisfy open-close layout invariants', () => {
  const dockSides = ['right', 'center', 'left'];
  const panelSides = ['top', 'bottom'];
  const scenarios = [
    { name: 'collapsed', hasBubble: false, baseContentWidth: 140, baseContentHeight: 104, canRecallReply: false },
    { name: 'collapsed+recall', hasBubble: false, baseContentWidth: 140, baseContentHeight: 104, canRecallReply: true },
    { name: 'reply-bubble', hasBubble: true, baseContentWidth: 332, baseContentHeight: 358, canRecallReply: false },
    { name: 'qa-bubble+recall', hasBubble: true, baseContentWidth: 344, baseContentHeight: 460, canRecallReply: true },
  ];

  for (const dockSide of dockSides) {
    for (const panelSide of panelSides) {
      for (const composited of [true, false]) {
        const merged = mergePetOrientation(
          { dockSide: 'right', panelSide: 'top', composited: true },
          { dockSide, panelSide, composited },
        );
        assert.deepEqual(merged, { dockSide, panelSide, composited });
        assert.deepEqual(mergePetOrientation(merged, null), merged);
        assert.deepEqual(mergePetOrientation(merged, undefined), merged);
        assert.deepEqual(mergePetOrientation(merged, { dockSide }), merged);
      }

      for (const scenario of scenarios) {
        const initialOrientation = { dockSide: 'right', panelSide: 'top', composited: true };
        const openTarget = planComposerOpenLayout(scenario);
        const closeTarget = planComposerCloseLayout(scenario);

        assert.ok(openTarget.width >= PET_LAYOUT_CONSTANTS.COMPOSER_PILL_WIDTH + PET_LAYOUT_CONSTANTS.STAGE_PAD * 2);
        assert.ok(openTarget.width <= PET_LAYOUT_CONSTANTS.MAX_STAGE_W);
        assert.ok(openTarget.height <= PET_LAYOUT_CONSTANTS.MAX_STAGE_H);
        assert.ok(openTarget.height > closeTarget.height || openTarget.height === PET_LAYOUT_CONSTANTS.MAX_STAGE_H);
        assert.ok(openTarget.composerHeight > 0);
        assert.equal(closeTarget.composerHeight, 0);

        // Open cycle: unmounted until native ack + viewport readiness, then reveals with target orientation
        let st = beginComposerOpen(createInitialComposerState(), openTarget);
        assert.equal(shouldRenderComposer(st.phase, false), false, `${dockSide}/${panelSide}/${scenario.name}`);
        st = ackComposerOpenNative(st, st.token, { dockSide, panelSide, focused: true });
        assert.equal(canCommitComposerOpen(st, { width: 164, height: 128 }).ready, false);
        assert.equal(canCommitComposerOpen(st, { width: openTarget.width, height: openTarget.height }).ready, true);

        const committed = commitComposerOpen(st, 1000);
        const appliedOrientation = mergePetOrientation(initialOrientation, committed.orientation);
        assert.equal(appliedOrientation.dockSide, dockSide);
        assert.equal(appliedOrientation.panelSide, panelSide);
        assert.equal(shouldRenderComposer(committed.state.phase, false), true);

        // Close cycle: unmounts before native shrink completes
        const closing = beginComposerClose(committed.state);
        assert.equal(shouldRenderComposer(closing.phase, false), false);
        const closed = completeComposerClose(closing, closing.token);
        assert.equal(closed.phase, 'closed');
      }
    }
  }
});
