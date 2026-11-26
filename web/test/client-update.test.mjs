import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIENT_UPDATE_AUTO_INTERVAL_MS,
  CLIENT_UPDATE_CANCEL_DELAY_MS,
  CLIENT_UPDATE_MIN_CHECK_MS,
  CLIENT_UPDATE_POLL_MS,
  CLIENT_UPDATE_STATUS_EVENT,
  computeMinCheckDelayMs,
  createOptimisticCheckingStatus,
  extractClientUpdateEventStatus,
  formatLastChecked,
  formatUpdateBytes,
  isCheckSettledPhase,
  nextPreservedRelease,
  resolveAutoInstallAction,
  resolveDisplayedRelease,
  shouldCommitOpResult,
  shouldShowCancelUpdateAction,
  updateProgress,
} from '../src/ClientUpdate.ts';

test('resolveAutoInstallAction chains downloaded -> install only when user armed download-and-install', () => {
  // Unarmed (e.g. reopened app with a previously downloaded package): never auto-install.
  assert.equal(resolveAutoInstallAction(false, 'downloaded'), 'clear');
  assert.equal(resolveAutoInstallAction(false, 'downloading'), 'clear');
  assert.equal(resolveAutoInstallAction(false, 'available'), 'clear');
  assert.equal(resolveAutoInstallAction(false, undefined), 'clear');

  // Armed after user clicked "下载并安装":
  // - still downloading (async platforms like Android): keep waiting
  assert.equal(resolveAutoInstallAction(true, 'downloading'), 'keep');
  // - download finished: immediately trigger install
  assert.equal(resolveAutoInstallAction(true, 'downloaded'), 'install');

  // Any terminal / cancelled / error / idle / already-installing phase clears the armed intent
  for (const phase of [
    'idle',
    'checking',
    'available',
    'up-to-date',
    'waiting-permission',
    'waiting-install',
    'waiting-tasks',
    'installing',
    'complete',
    'cancelled',
    'error',
    undefined,
  ]) {
    assert.equal(resolveAutoInstallAction(true, phase), 'clear', `phase=${String(phase)}`);
  }
});

test('updateProgress and formatUpdateBytes handle edge cases cleanly', () => {
  assert.equal(updateProgress(undefined), null);
  assert.equal(updateProgress({ phase: 'downloading', currentVersion: '0.0.30', downloadedBytes: 0, totalBytes: 0 }), null);
  assert.equal(updateProgress({ phase: 'downloading', currentVersion: '0.0.30', downloadedBytes: 50, totalBytes: 200 }), 25);
  assert.equal(updateProgress({ phase: 'downloading', currentVersion: '0.0.30', downloadedBytes: 300, totalBytes: 200 }), 100);
  assert.equal(formatUpdateBytes(512), '512 B');
  assert.equal(formatUpdateBytes(1024 * 1024 * 64.2), '64.2 MB');
  assert.equal(formatUpdateBytes(undefined), '');
});

test('timing constants preserve 24h auto interval and use low-frequency fallback poll', () => {
  assert.equal(CLIENT_UPDATE_AUTO_INTERVAL_MS, 24 * 60 * 60 * 1000);
  assert.equal(CLIENT_UPDATE_POLL_MS, 4000);
  assert.equal(CLIENT_UPDATE_MIN_CHECK_MS, 320);
  assert.equal(CLIENT_UPDATE_CANCEL_DELAY_MS, 2500);
});

test('extractClientUpdateEventStatus validates CustomEvent snapshots and rejects plain or malformed events', () => {
  // Desktop CustomEvent with full release & progress payload
  const fullEvent = new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
    detail: {
      phase: 'downloading',
      currentVersion: '0.0.32',
      downloadedBytes: 512,
      totalBytes: 2048,
      message: 'downloading',
      release: {
        id: 'rel-33',
        version: '0.0.33',
        notes: 'Bug fixes',
        size: 2048,
        sha256: 'abc',
        versionCode: 33,
        sourceCommit: 'deadbeef',
      },
    },
  });
  assert.deepEqual(extractClientUpdateEventStatus(fullEvent), {
    phase: 'downloading',
    currentVersion: '0.0.32',
    downloadedBytes: 512,
    totalBytes: 2048,
    message: 'downloading',
    release: {
      id: 'rel-33',
      version: '0.0.33',
      notes: 'Bug fixes',
      size: 2048,
      sha256: 'abc',
      versionCode: 33,
      sourceCommit: 'deadbeef',
    },
  });

  // Nullable optional fields (e.g. Rust Option::None serialized as null, Android JSONObject.NULL)
  const nullableFieldsEvent = new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
    detail: {
      phase: 'available',
      currentVersion: '0.0.32',
      totalBytes: null,
      message: null,
      release: {
        id: 'rel-34',
        version: '0.0.34',
        notes: null,
        size: 4096,
      },
    },
  });
  assert.deepEqual(extractClientUpdateEventStatus(nullableFieldsEvent), {
    phase: 'available',
    currentVersion: '0.0.32',
    release: {
      id: 'rel-34',
      version: '0.0.34',
      size: 4096,
    },
  });

  // Plain Event (Android form without detail) -> null (triggers coalesced refresh)
  assert.equal(extractClientUpdateEventStatus(new Event(CLIENT_UPDATE_STATUS_EVENT)), null);
  assert.equal(extractClientUpdateEventStatus(new CustomEvent(CLIENT_UPDATE_STATUS_EVENT)), null);

  // Malformed payloads -> null
  assert.equal(extractClientUpdateEventStatus(null), null);
  assert.equal(extractClientUpdateEventStatus(undefined), null);
  assert.equal(extractClientUpdateEventStatus({ detail: 'up-to-date' }), null);
  assert.equal(extractClientUpdateEventStatus({ detail: [] }), null);
  assert.equal(
    extractClientUpdateEventStatus(
      new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, { detail: { phase: 'unknown', currentVersion: '0.0.32' } }),
    ),
    null,
  );
  assert.equal(
    extractClientUpdateEventStatus(
      new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, { detail: { phase: 'idle', currentVersion: 32 } }),
    ),
    null,
  );
  assert.equal(
    extractClientUpdateEventStatus(
      new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
        detail: { phase: 'available', currentVersion: '0.0.32', release: { version: '0.0.33' } },
      }),
    ),
    null,
  );
  assert.equal(
    extractClientUpdateEventStatus(
      new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
        detail: { phase: 'downloading', currentVersion: '0.0.32', downloadedBytes: Number.NaN },
      }),
    ),
    null,
  );
  assert.equal(
    extractClientUpdateEventStatus(
      new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
        detail: { phase: 'downloading', currentVersion: '0.0.32', totalBytes: '100' },
      }),
    ),
    null,
  );
  assert.equal(
    extractClientUpdateEventStatus(
      new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
        detail: { phase: 'error', currentVersion: '0.0.32', message: 404 },
      }),
    ),
    null,
  );
});

test('computeMinCheckDelayMs enforces minimum manual check duration without delaying auto or cancel', () => {
  // Fast manual checks (< 320ms) hold until 320ms elapsed
  assert.equal(computeMinCheckDelayMs(1000, 1050, 'up-to-date'), 270);
  assert.equal(computeMinCheckDelayMs(1000, 1120, 'available'), 200);
  assert.equal(computeMinCheckDelayMs(1000, 1000, 'error'), 320);

  // Slow manual checks (>= 320ms) commit immediately
  assert.equal(computeMinCheckDelayMs(1000, 1320, 'up-to-date'), 0);
  assert.equal(computeMinCheckDelayMs(1000, 1800, 'available'), 0);

  // Cancelled check always commits immediately
  assert.equal(computeMinCheckDelayMs(1000, 1010, 'cancelled'), 0);

  // Automatic check (startedAt === null) never delays
  assert.equal(computeMinCheckDelayMs(null, 1050, 'up-to-date'), 0);
  assert.equal(computeMinCheckDelayMs(null, 1050, 'available'), 0);
  assert.equal(computeMinCheckDelayMs(null, 1050, 'error'), 0);

  // Non-settled / live phases commit immediately
  for (const phase of ['idle', 'checking', 'downloading', 'downloaded', 'installing', 'complete', undefined]) {
    assert.equal(computeMinCheckDelayMs(1000, 1020, phase), 0, `phase=${String(phase)}`);
  }

  // Clock skew (now < startedAt) caps delay at min duration
  assert.equal(computeMinCheckDelayMs(2000, 1500, 'up-to-date'), 320);

  // Settled check phase detection for lastCheckedAt tracking
  assert.equal(isCheckSettledPhase('up-to-date'), true);
  assert.equal(isCheckSettledPhase('available'), true);
  assert.equal(isCheckSettledPhase('error'), false);
  assert.equal(isCheckSettledPhase('cancelled'), false);
  assert.equal(isCheckSettledPhase('checking'), false);
  assert.equal(isCheckSettledPhase(undefined), false);
});

test('formatLastChecked renders relative timestamps and handles null/future edge cases', () => {
  const zh = (z) => z;
  const en = (_, e) => e;
  const base = 1_700_000_000_000;

  assert.equal(formatLastChecked(null, base, zh), '');
  assert.equal(formatLastChecked(undefined, base, en), '');
  assert.equal(formatLastChecked(0, base, zh), '');
  assert.equal(formatLastChecked(-100, base, zh), '');
  assert.equal(formatLastChecked(Number.NaN, base, zh), '');

  // Just now (< 60s) and future timestamps (clock skew)
  assert.equal(formatLastChecked(base, base, zh), '刚刚');
  assert.equal(formatLastChecked(base, base, en), 'just now');
  assert.equal(formatLastChecked(base, base + 59_999, zh), '刚刚');
  assert.equal(formatLastChecked(base + 30_000, base, zh), '刚刚');
  assert.equal(formatLastChecked(base + 30_000, base, en), 'just now');

  // Minutes (1..59 min)
  assert.equal(formatLastChecked(base, base + 60_000, zh), '1 分钟前');
  assert.equal(formatLastChecked(base, base + 60_000, en), '1 min ago');
  assert.equal(formatLastChecked(base, base + 59 * 60_000, zh), '59 分钟前');
  assert.equal(formatLastChecked(base, base + 59 * 60_000, en), '59 min ago');

  // Hours (1..23 hr)
  assert.equal(formatLastChecked(base, base + 60 * 60_000, zh), '1 小时前');
  assert.equal(formatLastChecked(base, base + 60 * 60_000, en), '1 hr ago');
  assert.equal(formatLastChecked(base, base + 23 * 60 * 60_000, zh), '23 小时前');
  assert.equal(formatLastChecked(base, base + 23 * 60 * 60_000, en), '23 hr ago');

  // Days (>= 24 hr)
  assert.equal(formatLastChecked(base, base + 24 * 60 * 60_000, zh), '1 天前');
  assert.equal(formatLastChecked(base, base + 24 * 60 * 60_000, en), '1 d ago');
  assert.equal(formatLastChecked(base, base + 72 * 60 * 60_000, zh), '3 天前');
});

test('shouldShowCancelUpdateAction delays cancel during checking and allows immediate cancel for download/mobile wait', () => {
  // Checking: hidden at <= 2500ms, shown at > 2500ms
  assert.equal(shouldShowCancelUpdateAction({ phase: 'checking', isDesktop: true, checkingElapsedMs: 0 }), false);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'checking', isDesktop: true, checkingElapsedMs: 2500 }), false);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'checking', isDesktop: false, checkingElapsedMs: 2500 }), false);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'checking', isDesktop: true, checkingElapsedMs: 2501 }), true);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'checking', isDesktop: false, checkingElapsedMs: 3000 }), true);

  // Downloading: always immediately cancellable
  assert.equal(shouldShowCancelUpdateAction({ phase: 'downloading', isDesktop: true, checkingElapsedMs: 0 }), true);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'downloading', isDesktop: false, checkingElapsedMs: 0 }), true);

  // Mobile system-install waiting states: immediately cancellable on mobile only
  assert.equal(shouldShowCancelUpdateAction({ phase: 'waiting-permission', isDesktop: false, checkingElapsedMs: 0 }), true);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'waiting-install', isDesktop: false, checkingElapsedMs: 0 }), true);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'waiting-permission', isDesktop: true, checkingElapsedMs: 0 }), false);
  assert.equal(shouldShowCancelUpdateAction({ phase: 'waiting-install', isDesktop: true, checkingElapsedMs: 0 }), false);

  // Installing and settled phases: not cancellable via secondary button
  for (const phase of ['installing', 'idle', 'available', 'up-to-date', 'downloaded', 'complete', 'cancelled', 'error']) {
    assert.equal(
      shouldShowCancelUpdateAction({ phase, isDesktop: true, checkingElapsedMs: 5000 }),
      false,
      `desktop phase=${phase}`,
    );
    assert.equal(
      shouldShowCancelUpdateAction({ phase, isDesktop: false, checkingElapsedMs: 5000 }),
      false,
      `mobile phase=${phase}`,
    );
  }
});

test('nextPreservedRelease and resolveDisplayedRelease retain available release during re-check', () => {
  const rel1 = { id: 'rel-1', version: '0.0.33', notes: 'Initial notes', size: 1024 };
  const rel2 = { id: 'rel-2', version: '0.0.34', notes: 'Newer notes', size: 2048 };

  // Idle -> checking without prior release stays undefined
  let preserved = nextPreservedRelease('idle', undefined, undefined);
  assert.equal(preserved, undefined);
  preserved = nextPreservedRelease('checking', undefined, preserved);
  assert.equal(preserved, undefined);
  assert.equal(resolveDisplayedRelease('checking', undefined, preserved), undefined);

  // Available -> captures release
  preserved = nextPreservedRelease('available', rel1, preserved);
  assert.equal(preserved, rel1);
  assert.equal(resolveDisplayedRelease('available', rel1, preserved), rel1);

  // Re-check where native omits release during checking -> retains rel1
  preserved = nextPreservedRelease('checking', undefined, preserved);
  assert.equal(preserved, rel1);
  assert.equal(resolveDisplayedRelease('checking', undefined, preserved), rel1);

  // Re-check settles with a newer release -> updates to rel2
  preserved = nextPreservedRelease('available', rel2, preserved);
  assert.equal(preserved, rel2);
  assert.equal(resolveDisplayedRelease('available', rel2, preserved), rel2);

  // Re-check again, then settles to up-to-date / error / idle -> clears preserved release
  for (const terminal of ['up-to-date', 'error', 'idle', 'cancelled']) {
    const duringCheck = nextPreservedRelease('checking', undefined, rel2);
    assert.equal(resolveDisplayedRelease('checking', undefined, duringCheck), rel2);
    const afterSettle = nextPreservedRelease(terminal, undefined, duringCheck);
    assert.equal(afterSettle, undefined, `terminal=${terminal}`);
    assert.equal(resolveDisplayedRelease(terminal, undefined, afterSettle), undefined, `terminal=${terminal}`);
  }

  // Downloading uses native release directly even though preserved cache clears
  const duringDownload = nextPreservedRelease('downloading', rel2, rel2);
  assert.equal(duringDownload, undefined);
  assert.equal(resolveDisplayedRelease('downloading', rel2, duringDownload), rel2);
});

test('createOptimisticCheckingStatus strips stale message while preserving version and release metadata', () => {
  const rel = { id: 'rel-35', version: '0.0.35', notes: 'notes', size: 1024 };
  assert.deepEqual(
    createOptimisticCheckingStatus({
      phase: 'error',
      currentVersion: '0.0.32',
      message: 'TLS handshake failed',
    }),
    {
      phase: 'checking',
      currentVersion: '0.0.32',
    },
  );
  assert.deepEqual(
    createOptimisticCheckingStatus({
      phase: 'available',
      currentVersion: '0.0.32',
      release: rel,
      totalBytes: 1024,
      message: 'stale notice',
    }),
    {
      phase: 'checking',
      currentVersion: '0.0.32',
      release: rel,
      totalBytes: 1024,
    },
  );
});

test('shouldCommitOpResult prevents stale check/download/cancel invoke replies from regressing push-observed state', () => {
  // Without an intervening push/poll during this op, always commit
  assert.equal(shouldCommitOpResult('check', 'checking', false), true);
  assert.equal(shouldCommitOpResult('download', 'downloading', false), true);
  assert.equal(shouldCommitOpResult('cancel', 'checking', false), true);
  assert.equal(shouldCommitOpResult('cancel', 'downloading', false), true);

  // When a push/poll already observed newer state during this op, drop stale intermediate replies
  assert.equal(shouldCommitOpResult('check', 'checking', true), false);
  assert.equal(shouldCommitOpResult('download', 'downloading', true), false);
  assert.equal(shouldCommitOpResult('cancel', 'checking', true), false);
  assert.equal(shouldCommitOpResult('cancel', 'downloading', true), false);

  // Settled replies and install ops still commit
  assert.equal(shouldCommitOpResult('check', 'up-to-date', true), true);
  assert.equal(shouldCommitOpResult('check', 'available', true), true);
  assert.equal(shouldCommitOpResult('download', 'downloaded', true), true);
  assert.equal(shouldCommitOpResult('cancel', 'cancelled', true), true);
  assert.equal(shouldCommitOpResult('install', 'installing', true), true);
});
