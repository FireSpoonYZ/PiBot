import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIENT_UPDATE_AUTO_INTERVAL_MS,
  CLIENT_UPDATE_CANCEL_DELAY_MS,
  CLIENT_UPDATE_COOLDOWN_MS,
  CLIENT_UPDATE_DISMISSED_MAX_ENTRIES,
  CLIENT_UPDATE_DISMISSED_STORAGE_KEY,
  CLIENT_UPDATE_FOREGROUND_DEBOUNCE_MS,
  CLIENT_UPDATE_FOREGROUND_EVENT,
  CLIENT_UPDATE_MIN_CHECK_MS,
  CLIENT_UPDATE_OPEN_EVENT,
  CLIENT_UPDATE_PERIODIC_TICK_MS,
  CLIENT_UPDATE_POLL_MS,
  CLIENT_UPDATE_PUSH_JITTER_MAX_MS,
  CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT,
  CLIENT_UPDATE_STATUS_EVENT,
  clientUpdateReleaseKey,
  computeMinCheckDelayMs,
  computePushCheckJitterMs,
  createClientUpdateController,
  createMobileUpdatePromptState,
  createOptimisticCheckingStatus,
  dismissMobileUpdatePromptRelease,
  extractClientUpdateEventStatus,
  formatLastChecked,
  formatUpdateBytes,
  isCheckSettledPhase,
  nextPreservedRelease,
  normalizeDismissedCenterKey,
  parseDismissedClientUpdateReleases,
  readDismissedClientUpdateMap,
  readDismissedClientUpdateRelease,
  reopenMobileUpdatePrompt,
  resolveAutoInstallAction,
  resolveDisplayedRelease,
  shouldCommitOpResult,
  shouldRunAutoUpdateCheck,
  shouldShowCancelUpdateAction,
  shouldShowMobileUpdatePrompt,
  shouldSkipAutoUpdateCheck,
  syncMobileUpdatePromptCenter,
  updateProgress,
  writeDismissedClientUpdateRelease,
} from '../src/ClientUpdate.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));

function createFakeClock(initialNow = 1_000_000) {
  let current = initialNow;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      const delay = Math.max(0, Number(ms) || 0);
      timers.set(id, { id, due: current + delay, delay, callback });
      return id;
    },
    clearTimeout: id => {
      timers.delete(id);
    },
    pendingCount: () => timers.size,
    advanceBy(ms) {
      const target = current + ms;
      while (true) {
        let earliest = null;
        for (const entry of timers.values()) {
          if (
            entry.due <= target &&
            (!earliest || entry.due < earliest.due || (entry.due === earliest.due && entry.id < earliest.id))
          ) {
            earliest = entry;
          }
        }
        if (!earliest) break;
        timers.delete(earliest.id);
        current = earliest.due;
        earliest.callback();
      }
      current = target;
    },
    async advanceByAndSettle(ms) {
      const target = current + ms;
      while (true) {
        let earliest = null;
        for (const entry of timers.values()) {
          if (
            entry.due <= target &&
            (!earliest || entry.due < earliest.due || (entry.due === earliest.due && entry.id < earliest.id))
          ) {
            earliest = entry;
          }
        }
        if (!earliest) break;
        timers.delete(earliest.id);
        current = earliest.due;
        earliest.callback();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}

function createFakeEventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) listeners.delete(type);
    },
    dispatch(type) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        fn();
      }
    },
    listenerCount(type) {
      if (type !== undefined) return listeners.get(type)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

const makeRelease = (id, version, versionCode) => ({
  id,
  version,
  ...(versionCode !== undefined ? { versionCode } : {}),
});

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

test('graded cooldown constants and shouldRunAutoUpdateCheck enforce exact boundaries for all 5 reasons', () => {
  assert.deepEqual(CLIENT_UPDATE_COOLDOWN_MS, {
    push: 0,
    'updates-page': 30_000,
    startup: 120_000,
    foreground: 600_000,
    periodic: 4 * 60 * 60 * 1000,
  });
  assert.equal(CLIENT_UPDATE_AUTO_INTERVAL_MS, 4 * 60 * 60 * 1000);
  assert.equal(CLIENT_UPDATE_POLL_MS, 4000);
  assert.equal(CLIENT_UPDATE_MIN_CHECK_MS, 320);
  assert.equal(CLIENT_UPDATE_CANCEL_DELAY_MS, 2500);
  assert.equal(CLIENT_UPDATE_FOREGROUND_DEBOUNCE_MS, 300);
  assert.equal(CLIENT_UPDATE_PUSH_JITTER_MAX_MS, 3000);
  assert.equal(CLIENT_UPDATE_PERIODIC_TICK_MS, 60_000);
  assert.equal(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT, 'assistant-update-release-published');
  assert.equal(CLIENT_UPDATE_FOREGROUND_EVENT, 'assistant-update-foreground');

  const base = 500_000;
  // Never checked yet (lastCheckedAt = 0): every reason runs immediately.
  for (const reason of ['push', 'updates-page', 'startup', 'foreground', 'periodic']) {
    assert.equal(shouldRunAutoUpdateCheck(reason, 0, base), true, `initial ${reason}`);
  }

  // push has 0ms cooldown: passes even at exact same timestamp.
  assert.equal(shouldRunAutoUpdateCheck('push', base, base), true);

  // Exact boundary check (cooldown - 1 -> false, cooldown -> true) for each non-zero reason.
  for (const reason of ['updates-page', 'startup', 'foreground', 'periodic']) {
    const cooldown = CLIENT_UPDATE_COOLDOWN_MS[reason];
    assert.equal(shouldRunAutoUpdateCheck(reason, base, base), false, `${reason} at 0`);
    assert.equal(shouldRunAutoUpdateCheck(reason, base, base + cooldown - 1), false, `${reason} before boundary`);
    assert.equal(shouldRunAutoUpdateCheck(reason, base, base + cooldown), true, `${reason} at boundary`);
    // Wall clock rollback (now < lastCheckedAt) never locks out auto checks.
    assert.equal(shouldRunAutoUpdateCheck(reason, base, base - 10_000), true, `${reason} clock rollback`);
  }

  assert.equal(computePushCheckJitterMs(0), 0);
  assert.equal(computePushCheckJitterMs(-0.5), 0);
  assert.equal(computePushCheckJitterMs(0.5), 1500);
  assert.equal(computePushCheckJitterMs(1), 3000);
  assert.equal(computePushCheckJitterMs(Number.NaN), 0);
});

test('shouldSkipAutoUpdateCheck skips active update phases and permits stable/error phases', () => {
  for (const activePhase of [
    'downloading',
    'downloaded',
    'waiting-permission',
    'waiting-install',
    'waiting-tasks',
    'installing',
    'complete',
  ]) {
    assert.equal(shouldSkipAutoUpdateCheck(activePhase), true, `skip ${activePhase}`);
  }

  for (const allowedPhase of ['idle', 'checking', 'available', 'up-to-date', 'cancelled', 'error', undefined]) {
    assert.equal(shouldSkipAutoUpdateCheck(allowedPhase), false, `allow ${String(allowedPhase)}`);
  }
});

test('persisted dismissed release helpers sanitize centerKey, isolate centers, bound entries, and handle broken storage', () => {
  // Strip credentials, paths, queries, and fragments from URLs inside centerKey.
  assert.equal(
    normalizeDismissedCenterKey('https://user:secret@center.example.com:8443/api?token=abc#frag|dev-1'),
    'https://center.example.com:8443|dev-1',
  );
  assert.equal(
    normalizeDismissedCenterKey(JSON.stringify(['https://center.example.com/p?token=xyz', 'client-1', 'dev-1'])),
    JSON.stringify(['https://center.example.com', 'client-1', 'dev-1']),
  );
  assert.equal(normalizeDismissedCenterKey('   '), '');

  const storage = createMemoryStorage();
  assert.equal(writeDismissedClientUpdateRelease('https://a.example/x?token=topsecret|dev-1', 'rel-1:10', storage), true);
  assert.equal(writeDismissedClientUpdateRelease('https://b.example|dev-2', 'rel-2:20', storage), true);

  const rawStored = storage.getItem(CLIENT_UPDATE_DISMISSED_STORAGE_KEY);
  assert.ok(rawStored);
  assert.equal(rawStored.includes('topsecret'), false);
  assert.equal(readDismissedClientUpdateRelease('https://a.example|dev-1', storage), 'rel-1:10');
  assert.equal(readDismissedClientUpdateRelease('https://b.example|dev-2', storage), 'rel-2:20');
  assert.equal(readDismissedClientUpdateRelease('https://c.example|dev-3', storage), '');

  // Corrupted JSON, non-object payloads, and prototype-polluting keys degrade safely.
  assert.deepEqual(parseDismissedClientUpdateReleases('{bad-json'), {});
  assert.deepEqual(parseDismissedClientUpdateReleases('["not-an-object"]'), {});
  assert.deepEqual(parseDismissedClientUpdateReleases('null'), {});
  assert.deepEqual(
    parseDismissedClientUpdateReleases(
      '{"__proto__":"evil","constructor":"bad","prototype":"bad","center-a":"rel-1:10","center-b":123}',
    ),
    { 'center-a': 'rel-1:10' },
  );

  // Entry cap evicts oldest centers while always preserving the most recently written entries.
  const cappedStorage = createMemoryStorage();
  for (let i = 0; i < CLIENT_UPDATE_DISMISSED_MAX_ENTRIES + 8; i += 1) {
    assert.equal(writeDismissedClientUpdateRelease(`center-${i}`, `rel-${i}:1`, cappedStorage), true);
  }
  const map = readDismissedClientUpdateMap(cappedStorage);
  assert.equal(Object.keys(map).length, CLIENT_UPDATE_DISMISSED_MAX_ENTRIES);
  assert.equal(readDismissedClientUpdateRelease('center-0', cappedStorage), '');
  assert.equal(
    readDismissedClientUpdateRelease(`center-${CLIENT_UPDATE_DISMISSED_MAX_ENTRIES + 7}`, cappedStorage),
    `rel-${CLIENT_UPDATE_DISMISSED_MAX_ENTRIES + 7}:1`,
  );

  // Missing or throwing storage never throws.
  assert.equal(readDismissedClientUpdateRelease('center-a', null), '');
  assert.equal(writeDismissedClientUpdateRelease('center-a', 'rel-1:10', null), false);
  const brokenStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(readDismissedClientUpdateRelease('center-a', brokenStorage), '');
  assert.equal(writeDismissedClientUpdateRelease('center-a', 'rel-1:10', brokenStorage), false);
});

test('controller orchestrates startup, debounced foreground, updates-page, jittered push, and 4h periodic fallback', async () => {
  const clock = createFakeClock(1_000_000);
  const win = createFakeEventTarget();
  const doc = createFakeEventTarget({ hidden: false });
  const calls = [];
  let nextStatus = { phase: 'up-to-date', currentVersion: '0.0.32' };

  const controller = createClientUpdateController({
    request: async (op, params) => {
      calls.push({ op, params, at: clock.now() });
      return nextStatus;
    },
    now: clock.now,
    random: () => 0.5,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    windowTarget: win,
    documentTarget: doc,
  });

  // 1. Connect ready -> immediate startup check.
  controller.start({ ready: true, centerKey: 'https://center-a.example|dev-1' });
  await settle();
  assert.deepEqual(
    calls.map(c => ({ op: c.op, params: c.params })),
    [{ op: 'check', params: { automatic: true, reason: 'startup' } }],
  );

  // 2. Opening updates page within 30s cooldown is throttled; at exact 30s runs updates-page check.
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, 1);

  await clock.advanceByAndSettle(29_999);
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, 1);

  await clock.advanceByAndSettle(1);
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, { automatic: true, reason: 'updates-page' });

  // 3. Foreground triggers (visibilitychange + focus + CLIENT_UPDATE_FOREGROUND_EVENT) coalesce with 300ms debounce.
  await clock.advanceByAndSettle(CLIENT_UPDATE_COOLDOWN_MS.foreground);
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  await clock.advanceByAndSettle(100);
  win.dispatch('focus');
  await clock.advanceByAndSettle(100);
  win.dispatch(CLIENT_UPDATE_FOREGROUND_EVENT);

  // Not yet fired at 299ms after the last foreground event.
  await clock.advanceByAndSettle(299);
  assert.equal(calls.length, 2);

  // Fires exactly once at 300ms after the last event.
  await clock.advanceByAndSettle(1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].params, { automatic: true, reason: 'foreground' });

  // Going hidden cancels a pending foreground debounce and does not trigger check.
  await clock.advanceByAndSettle(CLIENT_UPDATE_COOLDOWN_MS.foreground);
  win.dispatch('focus');
  await clock.advanceByAndSettle(100);
  doc.hidden = true;
  doc.dispatch('visibilitychange');
  await clock.advanceByAndSettle(500);
  assert.equal(calls.length, 3);
  doc.hidden = false;

  // 4. SSE release published event penetrates cooldown (0ms) after 0~3000ms jitter and coalesces burst events.
  nextStatus = { phase: 'available', currentVersion: '0.0.32', release: makeRelease('r1', '0.0.33', 33) };
  win.dispatch(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT);
  await clock.advanceByAndSettle(200);
  win.dispatch(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT);
  await clock.advanceByAndSettle(1299);
  assert.equal(calls.length, 3);
  await clock.advanceByAndSettle(1);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].params, { automatic: true, reason: 'push' });
  assert.equal(controller.getSnapshot().status?.phase, 'available');

  // 5. Periodic 4h fallback respects 4h cooldown from last successful check (push) and triggers on boundary.
  const lastAt = calls[3].at;
  const elapsedToJustBefore4h = lastAt + CLIENT_UPDATE_COOLDOWN_MS.periodic - 1 - clock.now();
  clock.advanceBy(elapsedToJustBefore4h);
  await settle();
  assert.equal(calls.length, 4);

  await clock.advanceByAndSettle(CLIENT_UPDATE_PERIODIC_TICK_MS);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[4].params, { automatic: true, reason: 'periodic' });

  // 6. stop() removes all window/document listeners and clears all scheduled timers.
  controller.stop();
  assert.equal(win.listenerCount(), 0);
  assert.equal(doc.listenerCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test('controller supports unified Android nativeCheck with native cooldown authority and 4h periodic cadence', async () => {
  const clock = createFakeClock(2_000_000);
  const win = createFakeEventTarget();
  const doc = createFakeEventTarget({ hidden: false });
  const calls = [];
  let nativeStatus = { phase: 'idle', currentVersion: '0.0.32' };

  const controller = createClientUpdateController({
    request: async (op, params) => {
      calls.push({ op, params, at: clock.now() });
      return nativeStatus;
    },
    now: clock.now,
    random: () => 0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    windowTarget: win,
    documentTarget: doc,
  });

  controller.start({ ready: true, centerKey: 'https://center-a.example|android-1', nativeCheck: true });
  await settle();
  assert.deepEqual(
    calls.map(c => ({ op: c.op, params: c.params })),
    [
      { op: 'status', params: undefined },
      { op: 'check', params: { automatic: true, reason: 'startup' } },
    ],
  );

  // Android updateCheck returns immediately before async IO completes; if IO fails natively,
  // Web must NOT lock out subsequent updates-page or foreground checks with a premature lastCheckAt.
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.deepEqual(calls.at(-1).params, { automatic: true, reason: 'updates-page' });

  // Native status broadcast refreshes status when visible, ignored when hidden.
  nativeStatus = { phase: 'available', currentVersion: '0.0.32', release: makeRelease('apk-1', '0.0.33', 101) };
  win.dispatch(CLIENT_UPDATE_STATUS_EVENT);
  await settle();
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(calls.at(-1).op, 'status');

  const countBeforeHiddenOpen = calls.length;
  doc.hidden = true;
  win.dispatch(CLIENT_UPDATE_OPEN_EVENT);
  await settle();
  assert.equal(calls.length, countBeforeHiddenOpen);

  // Returning visible runs syncNative immediately and debounced foreground auto-check without Web 10m lockout.
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  await settle();
  assert.equal(calls.at(-1).op, 'status');
  await clock.advanceByAndSettle(CLIENT_UPDATE_FOREGROUND_DEBOUNCE_MS);
  assert.deepEqual(calls.at(-1).params, { automatic: true, reason: 'foreground' });

  // SSE push also works on Android with jitter=0.
  win.dispatch(CLIENT_UPDATE_RELEASE_PUBLISHED_EVENT);
  await clock.advanceByAndSettle(0);
  assert.deepEqual(calls.at(-1).params, { automatic: true, reason: 'push' });

  // Periodic fallback fires strictly on 4h cadence (NOT every 60s tick!).
  const periodicCalls = () => calls.filter(c => c.op === 'check' && c.params?.reason === 'periodic');
  assert.equal(periodicCalls().length, 0);

  const elapsedToJustBefore4h = 2_000_000 + CLIENT_UPDATE_COOLDOWN_MS.periodic - 1 - clock.now();
  clock.advanceBy(elapsedToJustBefore4h);
  await settle();
  assert.equal(periodicCalls().length, 0);

  await clock.advanceByAndSettle(1);
  assert.equal(periodicCalls().length, 1);

  // Next 239 minute ticks stay quiet until the next 4h window.
  clock.advanceBy(CLIENT_UPDATE_COOLDOWN_MS.periodic - 1);
  await settle();
  assert.equal(periodicCalls().length, 1);

  await clock.advanceByAndSettle(1);
  assert.equal(periodicCalls().length, 2);

  controller.stop();
  assert.equal(win.listenerCount(), 0);
  assert.equal(doc.listenerCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test('controller enforces terminal-only cooldown refresh, skips active phases, protects available, stays silent on auto errors, and supports preemption', async () => {
  const clock = createFakeClock(3_000_000);
  const win = createFakeEventTarget();
  const doc = createFakeEventTarget({ hidden: false });
  const calls = [];
  let handler = async () => ({ phase: 'available', currentVersion: '0.0.32', release: makeRelease('r1', '0.0.33', 33) });

  const controller = createClientUpdateController({
    request: (op, params) => {
      calls.push({ op, params });
      return handler(op, params);
    },
    now: clock.now,
    random: () => 0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    windowTarget: win,
    documentTarget: doc,
  });

  controller.start({ ready: true, centerKey: 'https://center-a.example|dev-1' });
  await settle();
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'r1');

  // 1. In-flight auto check never sets pending='check' or collapses available status.
  let resolveDeferred;
  handler = () =>
    new Promise(resolve => {
      resolveDeferred = resolve;
    });
  await clock.advanceByAndSettle(CLIENT_UPDATE_COOLDOWN_MS['updates-page']);
  controller.triggerAutoCheck('updates-page');
  assert.equal(controller.getSnapshot().pending, null);
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'r1');

  // Non-terminal 'checking' returned from an auto check neither collapses 'available' nor refreshes cooldown.
  resolveDeferred({ phase: 'checking', currentVersion: '0.0.32' });
  await settle();
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'r1');

  // 2. Non-terminal/failure outcomes (reject, error, cancelled, idle) do NOT refresh lastCheckAt or set actionError.
  handler = async () => {
    throw new Error('network timeout');
  };
  const countBeforeFail = calls.length;
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countBeforeFail + 1);
  assert.equal(controller.getSnapshot().actionError, '');
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'r1');

  handler = async () => ({ phase: 'error', currentVersion: '0.0.32', message: 'HTTP 502' });
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countBeforeFail + 2);
  assert.equal(controller.getSnapshot().actionError, '');
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'r1');

  // Cancelled or stale-reset idle outcomes also must NOT lock out cooldown.
  handler = async () => ({ phase: 'cancelled', currentVersion: '0.0.32' });
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countBeforeFail + 3);

  handler = async () => ({ phase: 'idle', currentVersion: '0.0.32' });
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countBeforeFail + 4);

  // Returning terminal 'available' succeeds right away and refreshes cooldown.
  handler = async () => ({ phase: 'available', currentVersion: '0.0.32', release: makeRelease('r2', '0.0.34', 34) });
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countBeforeFail + 5);
  assert.equal(controller.getSnapshot().status?.release?.id, 'r2');
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countBeforeFail + 5);

  // 3. Manual check refreshes cooldown only on terminal available/up-to-date (not cancelled/idle/error).
  await clock.advanceByAndSettle(CLIENT_UPDATE_COOLDOWN_MS['updates-page']);
  handler = async () => ({ phase: 'cancelled', currentVersion: '0.0.32' });
  controller.check();
  await settle();
  const countAfterCancelledManual = calls.length;
  handler = async () => ({ phase: 'up-to-date', currentVersion: '0.0.32' });
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countAfterCancelledManual + 1);

  await clock.advanceByAndSettle(CLIENT_UPDATE_COOLDOWN_MS['updates-page']);
  handler = async () => ({ phase: 'available', currentVersion: '0.0.32', release: makeRelease('r2', '0.0.34', 34) });
  controller.check();
  assert.equal(controller.getSnapshot().pending, 'check');
  await settle();
  // Fast manual check holds checking state until CLIENT_UPDATE_MIN_CHECK_MS elapses.
  assert.equal(controller.getSnapshot().pending, 'check');
  await clock.advanceByAndSettle(CLIENT_UPDATE_MIN_CHECK_MS);
  assert.equal(controller.getSnapshot().pending, null);
  assert.equal(controller.getSnapshot().lastCheckedAt, clock.now());
  const countAfterManual = calls.length;
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, countAfterManual);
  controller.triggerAutoCheck('push');
  await settle();
  assert.equal(calls.length, countAfterManual + 1);

  // 4. Active phases skip all auto checks including push and updates-page.
  for (const activePhase of [
    'downloading',
    'downloaded',
    'waiting-permission',
    'waiting-install',
    'waiting-tasks',
    'installing',
    'complete',
  ]) {
    handler = async () => ({ phase: activePhase, currentVersion: '0.0.32', release: makeRelease('r2', '0.0.34', 34) });
    await controller.refresh(false);
    assert.equal(controller.getSnapshot().status?.phase, activePhase);
    const before = calls.length;
    controller.triggerAutoCheck('push');
    controller.triggerAutoCheck('updates-page');
    controller.triggerAutoCheck('foreground');
    await settle();
    assert.equal(calls.length, before, `auto check skipped during ${activePhase}`);
  }

  // 5a. Manual check() preempts an in-flight silent auto check and ignores its late response (both mid-flight and post-completion).
  handler = async () => ({ phase: 'available', currentVersion: '0.0.32', release: makeRelease('r2', '0.0.34', 34) });
  await controller.refresh(false);
  let resolveAutoForManual;
  let resolveManual;
  handler = (op, params) => {
    if (op === 'check' && params?.automatic) {
      return new Promise(resolve => {
        resolveAutoForManual = resolve;
      });
    }
    return new Promise(resolve => {
      resolveManual = resolve;
    });
  };
  controller.triggerAutoCheck('push');
  assert.equal(controller.getSnapshot().pending, null);
  controller.check();
  assert.equal(controller.getSnapshot().pending, 'check');
  assert.equal(controller.getSnapshot().status?.phase, 'checking');
  // Late stale auto-check settling while manual check is in flight is ignored.
  resolveAutoForManual({ phase: 'up-to-date', currentVersion: '0.0.32' });
  await settle();
  assert.equal(controller.getSnapshot().pending, 'check');
  assert.equal(controller.getSnapshot().status?.phase, 'checking');
  resolveManual({ phase: 'available', currentVersion: '0.0.32', release: makeRelease('r3', '0.0.35', 35) });
  await clock.advanceByAndSettle(CLIENT_UPDATE_MIN_CHECK_MS);
  assert.equal(controller.getSnapshot().pending, null);
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'r3');

  // 5b. User clicking download() preempts an in-flight silent auto check and ignores its late response even after download resolves.
  let resolveAutoForDownload;
  handler = op => {
    if (op === 'check') {
      return new Promise(resolve => {
        resolveAutoForDownload = resolve;
      });
    }
    return Promise.resolve({ phase: 'downloading', currentVersion: '0.0.32', release: makeRelease('r3', '0.0.35', 35) });
  };
  controller.triggerAutoCheck('push');
  assert.equal(controller.getSnapshot().pending, null);
  controller.download();
  assert.equal(controller.getSnapshot().pending, 'download');
  await settle();
  assert.equal(controller.getSnapshot().pending, null);
  assert.equal(controller.getSnapshot().status?.phase, 'downloading');
  // Stale auto-check resolving AFTER download settled must not clobber 'downloading'.
  resolveAutoForDownload({ phase: 'up-to-date', currentVersion: '0.0.32' });
  await settle();
  assert.equal(controller.getSnapshot().status?.phase, 'downloading');

  // 6. Switching centerKey resets state & cooldown and runs a fresh startup check; disconnected controller ignores triggers.
  handler = async () => ({ phase: 'up-to-date', currentVersion: '0.0.32' });
  const beforeSwitch = calls.length;
  controller.start({ ready: true, centerKey: 'https://center-b.example|dev-2' });
  await settle();
  assert.equal(calls.length, beforeSwitch + 1);
  assert.deepEqual(calls.at(-1), { op: 'check', params: { automatic: true, reason: 'startup' } });
  assert.equal(controller.getSnapshot().status?.phase, 'up-to-date');

  controller.stop();
  const afterStop = calls.length;
  controller.triggerAutoCheck('push');
  controller.triggerAutoCheck('updates-page');
  await settle();
  assert.equal(calls.length, afterStop);
});

test('MobileClientUpdatePrompt state persists dismissal across remount, reopens on new release or notification open, isolates centers, and degrades safely', () => {
  const storage = createMemoryStorage();
  const centerA = 'https://center-a.example/path?token=ignored|dev-1';
  const centerB = 'https://center-b.example|dev-2';
  const r1 = makeRelease('rel-1', '0.0.33', 100);
  const r2 = makeRelease('rel-2', '0.0.34', 101);
  const statusR1 = { phase: 'available', currentVersion: '0.0.32', release: r1 };
  const statusR2 = { phase: 'available', currentVersion: '0.0.32', release: r2 };

  // 1. First mount shows prompt for available release.
  let stateA = createMobileUpdatePromptState(centerA, storage);
  let res = shouldShowMobileUpdatePrompt({
    active: true,
    visible: true,
    ready: true,
    pending: null,
    status: statusR1,
    centerKey: centerA,
    dismissState: stateA,
    storage,
  });
  assert.equal(res.open, true);
  assert.equal(res.releaseKey, clientUpdateReleaseKey(r1));

  // 2. Clicking "Later" / closing persists centerA -> rel-1:100 and closes modal.
  stateA = dismissMobileUpdatePromptRelease(stateA, centerA, res.releaseKey, storage);
  res = shouldShowMobileUpdatePrompt({
    active: true,
    visible: true,
    ready: true,
    pending: null,
    status: statusR1,
    centerKey: centerA,
    dismissState: stateA,
    storage,
  });
  assert.equal(res.open, false);

  // 3. Unmount & remount (fresh state instance) still suppresses the same release on centerA.
  let remountedA = createMobileUpdatePromptState(centerA, storage);
  res = shouldShowMobileUpdatePrompt({
    active: true,
    visible: true,
    ready: true,
    pending: null,
    status: statusR1,
    centerKey: centerA,
    dismissState: remountedA,
    storage,
  });
  assert.equal(res.open, false);

  // 4. Different centerKey (centerB) is isolated and still prompts for rel-1:100.
  const stateB = createMobileUpdatePromptState(centerB, storage);
  res = shouldShowMobileUpdatePrompt({
    active: true,
    visible: true,
    ready: true,
    pending: null,
    status: statusR1,
    centerKey: centerB,
    dismissState: stateB,
    storage,
  });
  assert.equal(res.open, true);

  // 5. New release (rel-2:101) on centerA prompts again normally.
  res = shouldShowMobileUpdatePrompt({
    active: true,
    visible: true,
    ready: true,
    pending: null,
    status: statusR2,
    centerKey: centerA,
    dismissState: remountedA,
    storage,
  });
  assert.equal(res.open, true);
  assert.equal(res.releaseKey, clientUpdateReleaseKey(r2));

  // 6. Receiving CLIENT_UPDATE_OPEN_EVENT reopens the dismissed release for this session without breaking later persistence.
  remountedA = reopenMobileUpdatePrompt(remountedA, centerA, storage);
  res = shouldShowMobileUpdatePrompt({
    active: true,
    visible: true,
    ready: true,
    pending: null,
    status: statusR1,
    centerKey: centerA,
    dismissState: remountedA,
    storage,
  });
  assert.equal(res.open, true);

  // Dismissing again re-closes; cold remount without open event stays dismissed.
  remountedA = dismissMobileUpdatePromptRelease(remountedA, centerA, res.releaseKey, storage);
  assert.equal(
    shouldShowMobileUpdatePrompt({
      active: true,
      visible: true,
      ready: true,
      pending: null,
      status: statusR1,
      centerKey: centerA,
      dismissState: remountedA,
      storage,
    }).open,
    false,
  );
  const afterColdRemount = createMobileUpdatePromptState(centerA, storage);
  assert.equal(
    shouldShowMobileUpdatePrompt({
      active: true,
      visible: true,
      ready: true,
      pending: null,
      status: statusR1,
      centerKey: centerA,
      dismissState: afterColdRemount,
      storage,
    }).open,
    false,
  );

  // 7. Cold start notification open before centerKey hydrates preserves reopened=true when centerKey arrives.
  let coldState = createMobileUpdatePromptState('', storage);
  coldState = reopenMobileUpdatePrompt(coldState, '', storage);
  coldState = syncMobileUpdatePromptCenter(coldState, centerA, storage);
  assert.equal(
    shouldShowMobileUpdatePrompt({
      active: true,
      visible: true,
      ready: true,
      pending: null,
      status: statusR1,
      centerKey: centerA,
      dismissState: coldState,
      storage,
    }).open,
    true,
  );

  // 8. Broken localStorage degrades gracefully to in-memory dismissal without throwing.
  const brokenStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  let fallbackState = createMobileUpdatePromptState(centerA, brokenStorage);
  assert.equal(
    shouldShowMobileUpdatePrompt({
      active: true,
      visible: true,
      ready: true,
      pending: null,
      status: statusR1,
      centerKey: centerA,
      dismissState: fallbackState,
      storage: brokenStorage,
    }).open,
    true,
  );
  fallbackState = dismissMobileUpdatePromptRelease(fallbackState, centerA, clientUpdateReleaseKey(r1), brokenStorage);
  assert.equal(
    shouldShowMobileUpdatePrompt({
      active: true,
      visible: true,
      ready: true,
      pending: null,
      status: statusR1,
      centerKey: centerA,
      dismissState: fallbackState,
      storage: brokenStorage,
    }).open,
    false,
  );
});

test('timing constants align 4h periodic auto interval with low-frequency fallback poll and check UX thresholds', () => {
  assert.equal(CLIENT_UPDATE_AUTO_INTERVAL_MS, 4 * 60 * 60 * 1000);
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

test('desktop controller consumes CustomEvent push snapshots directly without extra status RPC and tracks lastCheckedAt', async () => {
  const clock = createFakeClock(2_000_000);
  const listeners = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
  const doc = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const calls = [];
  const controller = createClientUpdateController({
    request: async (op, params) => {
      calls.push({ op, params });
      return { phase: 'up-to-date', currentVersion: '0.0.32' };
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    windowTarget: win,
    documentTarget: doc,
  });

  controller.start({ ready: true, centerKey: 'https://center.example|dev-1', nativeCheck: false });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(controller.getSnapshot().status?.phase, 'up-to-date');
  assert.equal(controller.getSnapshot().lastCheckedAt, 2_000_000);

  // Desktop native CustomEvent pushes an available update directly with zero status RPC.
  clock.advanceBy(5_000);
  const rel = makeRelease('rel-push', '0.0.33', 33);
  win.dispatch(
    CLIENT_UPDATE_STATUS_EVENT,
    new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
      detail: { phase: 'available', currentVersion: '0.0.32', release: rel, totalBytes: 1024 },
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(controller.getSnapshot().status?.phase, 'available');
  assert.equal(controller.getSnapshot().status?.release?.id, 'rel-push');
  assert.equal(controller.getSnapshot().lastCheckedAt, 2_005_000);

  // Downloading progress CustomEvent updates bytes immediately without RPC.
  win.dispatch(
    CLIENT_UPDATE_STATUS_EVENT,
    new CustomEvent(CLIENT_UPDATE_STATUS_EVENT, {
      detail: {
        phase: 'downloading',
        currentVersion: '0.0.32',
        release: rel,
        downloadedBytes: 512,
        totalBytes: 1024,
      },
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(controller.getSnapshot().status?.phase, 'downloading');
  assert.equal(controller.getSnapshot().status?.downloadedBytes, 512);
  controller.stop();
});
