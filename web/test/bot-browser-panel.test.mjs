import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FRAME_BASE64_LENGTH,
  activeTabOf,
  buildBrowserRequest,
  canAcceptManualInput,
  classifyBrowserError,
  classifyPageUrl,
  confirmTakeoverLease,
  inspectFrameRedaction,
  isFrameUsableForView,
  mapClientPointToNormalized,
  mapKeyboardEventKey,
  normalizeNavigateUrl,
  normalizeWheelDelta,
  parseBrowserFrame,
  parseBrowserView,
  reconcileLeaseWithView,
} from '../src/bot-browser/protocol.ts';

test('parseBrowserView normalizes direct and wrapped DTOs and forces canStreamInteract=false when unavailable', () => {
  const view = parseBrowserView({
    result: {
      available: true,
      canStreamInteract: true,
      phase: 'bot',
      sessionId: 'sess-1',
      pageId: 'tab-1',
      revision: 4,
      tabs: [
        { id: 'tab-1', title: 'Google Cloud', url: 'https://console.cloud.google.com/' },
        { id: '', title: 'bad', url: '' },
      ],
      attentionRequested: true,
    },
  });

  assert.ok(view);
  assert.equal(view.available, true);
  assert.equal(view.canStreamInteract, true);
  assert.equal(view.phase, 'bot');
  assert.equal(view.revision, 4);
  assert.equal(view.tabs.length, 1);
  assert.equal(activeTabOf(view)?.id, 'tab-1');
  assert.equal(view.attentionRequested, true);

  const unavailable = parseBrowserView({
    available: false,
    reason: 'headless host',
    canStreamInteract: true,
    phase: 'bot',
    revision: 0,
    tabs: [],
  });
  assert.ok(unavailable);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.canStreamInteract, false);
  assert.equal(unavailable.reason, 'headless host');

  assert.equal(parseBrowserView(null), null);
  assert.equal(parseBrowserView({ foo: 'bar' }), null);
});

test('parseBrowserFrame validates bounds, mimeType, dimensions, and redaction flags', () => {
  const valid = parseBrowserFrame({
    seq: 7,
    mimeType: 'image/jpeg',
    data: 'AAAA',
    width: 1280,
    height: 800,
    revision: 3,
    pageId: 'tab-1',
  });
  assert.ok(valid);
  assert.equal(valid.seq, 7);
  assert.equal(valid.pageId, 'tab-1');

  // Disallowed mimeType
  assert.equal(
    parseBrowserFrame({
      seq: 1,
      mimeType: 'image/svg+xml',
      data: 'AAAA',
      width: 100,
      height: 100,
      revision: 1,
      pageId: 'tab-1',
    }),
    null,
  );

  // Oversized frame rejected
  assert.equal(
    parseBrowserFrame({
      seq: 1,
      mimeType: 'image/png',
      data: 'A'.repeat(MAX_FRAME_BASE64_LENGTH + 1),
      width: 100,
      height: 100,
      revision: 1,
      pageId: 'tab-1',
    }),
    null,
  );

  // Redacted sensitive frame rejected and detected by inspectFrameRedaction
  const redactedRaw = { redacted: true, sensitive: true, reason: 'OAuth consent screen' };
  assert.equal(parseBrowserFrame(redactedRaw), null);
  assert.deepEqual(inspectFrameRedaction(redactedRaw), {
    redacted: true,
    sensitive: true,
    reason: 'OAuth consent screen',
  });
});

test('isFrameUsableForView rejects mismatched pageId, stale revision, and out-of-order seq', () => {
  const view = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'human',
    pageId: 'tab-2',
    revision: 5,
    tabs: [{ id: 'tab-2', title: 'Form', url: 'https://example.com/form' }],
  });
  const matching = parseBrowserFrame({
    seq: 10,
    mimeType: 'image/jpeg',
    data: 'BBBB',
    width: 1200,
    height: 800,
    revision: 5,
    pageId: 'tab-2',
  });
  const staleRev = parseBrowserFrame({
    seq: 11,
    mimeType: 'image/jpeg',
    data: 'BBBB',
    width: 1200,
    height: 800,
    revision: 4,
    pageId: 'tab-2',
  });
  const wrongPage = parseBrowserFrame({
    seq: 12,
    mimeType: 'image/jpeg',
    data: 'BBBB',
    width: 1200,
    height: 800,
    revision: 5,
    pageId: 'tab-1',
  });

  assert.equal(isFrameUsableForView(matching, view, null), true);
  assert.equal(isFrameUsableForView(staleRev, view, null), false);
  assert.equal(isFrameUsableForView(wrongPage, view, null), false);
  assert.equal(
    isFrameUsableForView(matching, view, { pageId: 'tab-2', revision: 5, seq: 11 }),
    false,
  );
  assert.equal(
    isFrameUsableForView(matching, view, { pageId: 'tab-2', revision: 5, seq: 10 }),
    true,
  );
});

test('takeover confirmation and lease reconciliation enforce stop receipt, preemption, and held fail-closed', () => {
  const takingView = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'taking',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 1,
    lease: 'lease-pending',
    tabs: [],
  });
  assert.equal(confirmTakeoverLease(takingView), null);

  const humanView = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'human',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 2,
    lease: 'lease-abc',
    holderLabel: 'MacBook',
    tabs: [],
  });
  const owned = confirmTakeoverLease(humanView);
  assert.deepEqual(owned, {
    lease: 'lease-abc',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 2,
  });

  // Same holder navigates to revision 3 without echoing secret lease in status poll
  const nextNavView = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'human',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 3,
    holderLabel: 'MacBook',
    tabs: [],
  });
  const kept = reconcileLeaseWithView(owned, nextNavView);
  assert.equal(kept.isHolder, true);
  assert.equal(kept.preemptedBy, null);
  assert.equal(kept.nextLease?.lease, 'lease-abc');
  assert.equal(kept.nextLease?.revision, 3);

  // Another device preempts control
  const preemptedView = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'human',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 4,
    isHolder: false,
    holderLabel: 'Android Phone',
    tabs: [],
  });
  const preempted = reconcileLeaseWithView(kept.nextLease, preemptedView);
  assert.equal(preempted.isHolder, false);
  assert.equal(preempted.nextLease, null);
  assert.equal(preempted.preemptedBy, 'Android Phone');

  // Disconnect hold locks manual input
  const heldView = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'held',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 4,
    tabs: [],
  });
  const held = reconcileLeaseWithView(kept.nextLease, heldView);
  assert.equal(held.isHolder, false);
  assert.equal(held.nextLease, null);
});

test('canAcceptManualInput requires every live, lease, frame, and visibility gate', () => {
  const view = parseBrowserView({
    available: true,
    canStreamInteract: true,
    phase: 'human',
    sessionId: 'sess-1',
    pageId: 'tab-1',
    revision: 2,
    lease: 'lease-1',
    tabs: [{ id: 'tab-1', title: 'Page', url: 'https://example.com' }],
  });
  const ownedLease = confirmTakeoverLease(view);
  const liveFrame = parseBrowserFrame({
    seq: 1,
    mimeType: 'image/jpeg',
    data: 'AAAA',
    width: 1000,
    height: 600,
    revision: 2,
    pageId: 'tab-1',
  });

  const base = {
    connected: true,
    visible: true,
    view,
    ownedLease,
    isHolder: true,
    pendingAction: null,
    liveFrame,
    streamDegraded: false,
  };

  assert.equal(canAcceptManualInput(base), true);
  assert.equal(canAcceptManualInput({ ...base, connected: false }), false);
  assert.equal(canAcceptManualInput({ ...base, visible: false }), false);
  assert.equal(canAcceptManualInput({ ...base, streamDegraded: true }), false);
  assert.equal(canAcceptManualInput({ ...base, pendingAction: 'handing-back' }), false);
  assert.equal(canAcceptManualInput({ ...base, isHolder: false }), false);
  assert.equal(canAcceptManualInput({ ...base, liveFrame: null }), false);
  assert.equal(
    canAcceptManualInput({
      ...base,
      liveFrame: { ...liveFrame, revision: 1 },
    }),
    false,
  );
});

test('mapClientPointToNormalized projects accurately inside object-fit:contain and ignores letterbox', () => {
  // 16:9 content inside a 200x200 square container -> rendered 200x100 centered at y=[50..150]
  const squareRect = { left: 100, top: 200, width: 200, height: 200 };
  const center = mapClientPointToNormalized(200, 300, squareRect, 1600, 800);
  assert.deepEqual(center, { x: 0.5, y: 0.5 });

  const topLeftOfContent = mapClientPointToNormalized(100, 250, squareRect, 1600, 800);
  assert.deepEqual(topLeftOfContent, { x: 0, y: 0 });

  // Inside top letterbox margin (y=220 < 250) -> ignored
  assert.equal(mapClientPointToNormalized(200, 220, squareRect, 1600, 800), null);

  // Narrow portrait content (500x1000) in wide container (400x200) -> rendered 100x200 centered at x=[150..250]
  const wideRect = { left: 0, top: 0, width: 400, height: 200 };
  assert.equal(mapClientPointToNormalized(100, 100, wideRect, 500, 1000), null);
  assert.deepEqual(mapClientPointToNormalized(200, 100, wideRect, 500, 1000), { x: 0.5, y: 0.5 });
});

test('classifyPageUrl and normalizeNavigateUrl enforce Google auth awareness and safe URL schemes', () => {
  const auth = classifyPageUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=123');
  assert.equal(auth.isGoogleAuth, true);
  assert.equal(auth.isKnownSensitiveUrl, true);
  assert.equal(auth.isSecure, true);

  const cloud = classifyPageUrl('https://console.cloud.google.com/apis/credentials');
  assert.equal(cloud.isGoogleAuth, false);
  assert.equal(cloud.isCloudSecretArea, true);

  assert.deepEqual(normalizeNavigateUrl('console.cloud.google.com/auth'), {
    ok: true,
    url: 'https://console.cloud.google.com/auth',
  });
  assert.deepEqual(normalizeNavigateUrl('javascript:alert(1)'), {
    ok: false,
    reason: 'disallowed_scheme',
  });
  assert.deepEqual(normalizeNavigateUrl('file:///etc/passwd'), {
    ok: false,
    reason: 'disallowed_scheme',
  });
});

test('normalizeWheelDelta, mapKeyboardEventKey, classifyBrowserError, and buildBrowserRequest behave cleanly', () => {
  assert.deepEqual(normalizeWheelDelta(0, 3, 1), { deltaX: 0, deltaY: 96 });
  assert.deepEqual(normalizeWheelDelta(0, 5000, 0), { deltaX: 0, deltaY: 600 });

  assert.equal(mapKeyboardEventKey('Enter'), 'Enter');
  assert.equal(mapKeyboardEventKey(' '), 'Space');
  assert.equal(mapKeyboardEventKey('a'), null);

  const errLease = classifyBrowserError({ code: 'LEASE_EXPIRED', message: 'lease expired' });
  assert.equal(errLease.invalidatesLease, true);
  assert.equal(errLease.staleState, false);

  const errSensitive = classifyBrowserError('HANDBACK_BLOCKED_SENSITIVE: login form visible');
  assert.equal(errSensitive.sensitiveBlocked, true);
  assert.equal(errSensitive.code, 'HANDBACK_BLOCKED_SENSITIVE');

  assert.deepEqual(
    buildBrowserRequest('input', {
      botId: 'bot-1',
      pageId: 'tab-1',
      lease: 'lease-xyz',
      revision: 7,
      event: { kind: 'click', x: 0.25, y: 0.75 },
    }),
    {
      action: 'input',
      botId: 'bot-1',
      pageId: 'tab-1',
      lease: 'lease-xyz',
      revision: 7,
      event: { kind: 'click', x: 0.25, y: 0.75 },
    },
  );
});
