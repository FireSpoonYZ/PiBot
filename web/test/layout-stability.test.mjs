import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_ENTER_DELAY_MS,
  DEFAULT_MIN_VISIBLE_MS,
  createConnectionPhaseState,
  deriveConnectionPhase,
  stepConnectionPhaseState,
} from '../src/connection/connectionPhase.ts';
import {
  INITIAL_ACTION_STATE,
  reduceActionState,
} from '../src/layout/actionState.ts';
import {
  ACTIVE_CENTER_URL_STORAGE_KEY,
  SCOPE_CONVERSATIONS_CACHE_KEY_PREFIX,
  SCOPE_CONVERSATIONS_CACHE_VERSION,
  normalizeCenterUrlOrigin,
  normalizePartitionKey,
  readActiveCenterUrlCache,
  readCachedScopeConversations,
  readInitialCenterPartitionKey,
  readScopeConversationsCacheEntry,
  removeCachedScopeConversation,
  scopeConversationsCacheKey,
  writeActiveCenterUrlCache,
  writeCachedScopeConversations,
} from '../src/gbot-ui/scopeCache.ts';

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

function makeRoomConversation(overrides = {}) {
  const scopeId = overrides.scopeId ?? 'room-1';
  const identity = {
    profileId: 'prof-1',
    targetDeviceId: 'dev-host-1',
    generation: 2,
    kind: 'relay',
    ...(overrides.identity ?? {}),
  };
  const innerScope = {
    scopeId,
    kind: 'room',
    revision: 1,
    members: [
      { deviceId: 'dev-host-1', botId: 'bot-a' },
      { deviceId: 'dev-host-2', botId: 'bot-b' },
    ],
    title: overrides.scopeTitle ?? 'Core Group',
    ...(overrides.innerScope ?? {}),
  };
  const scope = {
    scope: innerScope,
    authorityDeviceId: 'dev-host-1',
    isAuthority: true,
    delivery: overrides.delivery ?? null,
    ...(overrides.scope ?? {}),
  };
  const base = {
    key: overrides.key ?? `${identity.profileId}|${identity.kind}|0|${identity.targetDeviceId}:${scopeId}`,
    identity,
    scope,
    title: overrides.title ?? 'Core Group',
    lastPreview: overrides.lastPreview ?? 'Latest update',
  };
  if ('lastActivityAt' in overrides) {
    base.lastActivityAt = overrides.lastActivityAt;
  }
  if ('api' in overrides) {
    base.api = overrides.api;
  }
  return base;
}

// ---------------------------------------------------------------------------
// F2: deriveConnectionPhase & hysteresis state machine
// ---------------------------------------------------------------------------

test('F2 deriveConnectionPhase merges IPC, center, remote, cached bots, and error flags', () => {
  // Active reconnecting / connecting flags take highest priority.
  assert.equal(deriveConnectionPhase({ ipcReconnecting: true }), 'connecting');
  assert.equal(deriveConnectionPhase({ centerReconnecting: true }), 'connecting');
  assert.equal(deriveConnectionPhase({ centerConnecting: true }), 'connecting');
  assert.equal(
    deriveConnectionPhase({
      ipcReconnecting: true,
      centerError: 'TLS failure',
      centerReady: false,
      remoteConnected: false,
    }),
    'connecting',
  );

  // Center errors surface when center is not ready or remote transport is down.
  assert.equal(
    deriveConnectionPhase({ centerError: 'Handshake failed', centerReady: false }),
    'error',
  );
  assert.equal(
    deriveConnectionPhase({
      centerError: 'Auth expired',
      centerReady: true,
      remoteConnected: false,
    }),
    'error',
  );
  // Stale error string when both centerReady and remoteConnected are healthy does not report error.
  assert.equal(
    deriveConnectionPhase({
      centerError: 'Stale error',
      centerReady: true,
      remoteConnected: true,
    }),
    'online',
  );
  // Whitespace-only centerError is ignored.
  assert.equal(
    deriveConnectionPhase({
      centerError: '   ',
      centerReady: false,
      hasConfiguredCenter: true,
    }),
    'offline',
  );

  // Local-only mode (no configured center and no cached remote bots) stays online.
  assert.equal(
    deriveConnectionPhase({
      hasConfiguredCenter: false,
      hasCachedRemoteBots: false,
      centerReady: false,
      remoteConnected: false,
    }),
    'online',
  );

  // Cached remote bots while disconnected report offline.
  assert.equal(
    deriveConnectionPhase({
      hasConfiguredCenter: false,
      hasCachedRemoteBots: true,
      remoteConnected: false,
    }),
    'offline',
  );
  assert.equal(
    deriveConnectionPhase({
      hasCachedRemoteBots: true,
      remoteConnected: true,
    }),
    'online',
  );

  // Configured center connectivity matrix.
  assert.equal(
    deriveConnectionPhase({ hasConfiguredCenter: true, centerReady: true, remoteConnected: true }),
    'online',
  );
  assert.equal(
    deriveConnectionPhase({ hasConfiguredCenter: true, centerReady: true, remoteConnected: false }),
    'offline',
  );
  assert.equal(
    deriveConnectionPhase({ hasConfiguredCenter: true, centerReady: false }),
    'offline',
  );
  assert.equal(
    deriveConnectionPhase({ hasConfiguredCenter: true, centerReady: false, remoteConnected: true }),
    'online',
  );
  assert.equal(deriveConnectionPhase({ hasConfiguredCenter: true }), 'online');

  // Omitted hasConfiguredCenter defaults to online unless explicitly false.
  assert.equal(deriveConnectionPhase({}), 'online');
  assert.equal(deriveConnectionPhase({ centerReady: false }), 'offline');
  assert.equal(deriveConnectionPhase({ centerReady: false, remoteConnected: true }), 'online');
  assert.equal(deriveConnectionPhase({ remoteConnected: false }), 'offline');
});

test('F2 hysteresis enter delay (800ms) suppresses transient disconnects and transitions at >= 800ms', () => {
  assert.equal(DEFAULT_ENTER_DELAY_MS, 800);
  assert.equal(DEFAULT_MIN_VISIBLE_MS, 600);

  const onlineInput = { hasConfiguredCenter: true, centerReady: true, remoteConnected: true };
  const reconnectingInput = {
    hasConfiguredCenter: true,
    centerReconnecting: true,
    remoteConnected: false,
  };

  const initial = createConnectionPhaseState(onlineInput, 1_000);
  assert.deepEqual(initial, {
    phase: 'online',
    rawPhase: 'online',
    visibleSinceMs: null,
    nonOnlineSinceMs: null,
    nextTransitionInMs: null,
  });

  // Disconnect starts at t=1500: visible phase remains 'online' with 800ms countdown.
  const at0 = stepConnectionPhaseState(initial, reconnectingInput, 1_500);
  assert.equal(at0.phase, 'online');
  assert.equal(at0.rawPhase, 'connecting');
  assert.equal(at0.nextTransitionInMs, 800);
  assert.equal(at0.state.nonOnlineSinceMs, 1_500);

  // Still disconnected at 799ms (t=2299): never shows 'connecting'.
  const at799 = stepConnectionPhaseState(at0.state, reconnectingInput, 2_299);
  assert.equal(at799.phase, 'online');
  assert.equal(at799.rawPhase, 'connecting');
  assert.equal(at799.nextTransitionInMs, 1);

  // Recovers before 800ms elapses: stays 'online' and resets enter timer.
  const recovered = stepConnectionPhaseState(at799.state, onlineInput, 2_299);
  assert.equal(recovered.phase, 'online');
  assert.equal(recovered.rawPhase, 'online');
  assert.equal(recovered.nextTransitionInMs, null);
  assert.equal(recovered.state.nonOnlineSinceMs, null);

  // Subsequent disconnect begins a fresh 800ms enter window.
  const freshDrop = stepConnectionPhaseState(recovered.state, reconnectingInput, 2_500);
  assert.equal(freshDrop.phase, 'online');
  assert.equal(freshDrop.nextTransitionInMs, 800);
  assert.equal(freshDrop.state.nonOnlineSinceMs, 2_500);

  // Continuing the original disconnect through exact 800ms (t=2300) transitions to 'connecting'.
  const entered = stepConnectionPhaseState(at799.state, reconnectingInput, 2_300);
  assert.equal(entered.phase, 'connecting');
  assert.equal(entered.rawPhase, 'connecting');
  assert.equal(entered.nextTransitionInMs, null);
  assert.equal(entered.state.visibleSinceMs, 2_300);
  assert.equal(entered.state.nonOnlineSinceMs, null);

  // Non-online raw phase changing mid-delay preserves nonOnlineSinceMs and enters latest raw phase.
  const startConnecting = createConnectionPhaseState({ ipcReconnecting: true }, 0);
  assert.equal(startConnecting.phase, 'online');
  assert.equal(startConnecting.nextTransitionInMs, 800);
  const midError = stepConnectionPhaseState(
    startConnecting,
    { centerError: 'Cert rejected', centerReady: false },
    500,
  );
  assert.equal(midError.phase, 'online');
  assert.equal(midError.rawPhase, 'error');
  assert.equal(midError.nextTransitionInMs, 300);
  const enteredError = stepConnectionPhaseState(
    midError.state,
    { centerError: 'Cert rejected', centerReady: false },
    800,
  );
  assert.equal(enteredError.phase, 'error');
  assert.equal(enteredError.rawPhase, 'error');
  assert.equal(enteredError.state.visibleSinceMs, 800);
});

test('F2 hysteresis min visible duration (600ms) holds connecting before returning to online', () => {
  const onlineInput = { hasConfiguredCenter: true, centerReady: true, remoteConnected: true };
  const connectingInput = { hasConfiguredCenter: true, centerConnecting: true };

  // Enter 'connecting' at t=2300 after 800ms disconnect starting at t=1500.
  const start = createConnectionPhaseState(onlineInput, 1_000);
  const pending = stepConnectionPhaseState(start, connectingInput, 1_500);
  const visible = stepConnectionPhaseState(pending.state, connectingInput, 2_300);
  assert.equal(visible.phase, 'connecting');
  assert.equal(visible.state.visibleSinceMs, 2_300);

  // Immediate recovery at t=2300 stays 'connecting' for the full 600ms.
  const hold0 = stepConnectionPhaseState(visible.state, onlineInput, 2_300);
  assert.equal(hold0.phase, 'connecting');
  assert.equal(hold0.rawPhase, 'online');
  assert.equal(hold0.nextTransitionInMs, 600);

  // Mid-window recovery at t=2550 reports exact remaining wait (350ms).
  const hold250 = stepConnectionPhaseState(hold0.state, onlineInput, 2_550);
  assert.equal(hold250.phase, 'connecting');
  assert.equal(hold250.rawPhase, 'online');
  assert.equal(hold250.nextTransitionInMs, 350);

  // 1ms before threshold (t=2899) still holds 'connecting' with 1ms remaining.
  const hold599 = stepConnectionPhaseState(hold250.state, onlineInput, 2_899);
  assert.equal(hold599.phase, 'connecting');
  assert.equal(hold599.rawPhase, 'online');
  assert.equal(hold599.nextTransitionInMs, 1);

  // At exact 600ms (t=2900) transitions cleanly back to 'online'.
  const backOnline = stepConnectionPhaseState(hold599.state, onlineInput, 2_900);
  assert.equal(backOnline.phase, 'online');
  assert.equal(backOnline.rawPhase, 'online');
  assert.equal(backOnline.nextTransitionInMs, null);
  assert.equal(backOnline.state.visibleSinceMs, null);

  // Dipping back to connecting during the hold preserves original visibleSinceMs.
  const redip = stepConnectionPhaseState(hold250.state, connectingInput, 2_600);
  assert.equal(redip.phase, 'connecting');
  assert.equal(redip.nextTransitionInMs, null);
  assert.equal(redip.state.visibleSinceMs, 2_300);
  const recoverAfterDip = stepConnectionPhaseState(redip.state, onlineInput, 2_700);
  assert.equal(recoverAfterDip.phase, 'connecting');
  assert.equal(recoverAfterDip.nextTransitionInMs, 200);
  const doneAfterDip = stepConnectionPhaseState(recoverAfterDip.state, onlineInput, 2_900);
  assert.equal(doneAfterDip.phase, 'online');
  assert.equal(doneAfterDip.nextTransitionInMs, null);
});

test('F2 cold start with cached remote bots starts immediately in connecting and respects 600ms min visible', () => {
  const onlineInput = {
    hasCachedRemoteBots: true,
    remoteConnected: true,
    centerReady: true,
  };

  // Case 1: Frame 1 with cached remote bots and remoteConnected=false (rawPhase='offline')
  // starts immediately in 'connecting' (no 800ms enter delay).
  const coldOffline = createConnectionPhaseState(
    { hasCachedRemoteBots: true, remoteConnected: false },
    100,
  );
  assert.equal(coldOffline.phase, 'connecting');
  assert.equal(coldOffline.rawPhase, 'offline');
  assert.equal(coldOffline.visibleSinceMs, 100);
  assert.equal(coldOffline.nonOnlineSinceMs, null);
  assert.equal(coldOffline.nextTransitionInMs, 600);

  // Immediate recovery to online still holds 'connecting' until t=700 (600ms elapsed).
  const fastOnline = stepConnectionPhaseState(coldOffline, onlineInput, 250);
  assert.equal(fastOnline.phase, 'connecting');
  assert.equal(fastOnline.rawPhase, 'online');
  assert.equal(fastOnline.nextTransitionInMs, 450);

  const almostOnline = stepConnectionPhaseState(fastOnline.state, onlineInput, 699);
  assert.equal(almostOnline.phase, 'connecting');
  assert.equal(almostOnline.nextTransitionInMs, 1);

  const settledOnline = stepConnectionPhaseState(almostOnline.state, onlineInput, 700);
  assert.equal(settledOnline.phase, 'online');
  assert.equal(settledOnline.rawPhase, 'online');
  assert.equal(settledOnline.nextTransitionInMs, null);

  // If cold start stays offline without connecting, 'connecting' relaxes to 'offline' at 600ms.
  const stillOfflineAt400 = stepConnectionPhaseState(
    coldOffline,
    { hasCachedRemoteBots: true, remoteConnected: false },
    400,
  );
  assert.equal(stillOfflineAt400.phase, 'connecting');
  assert.equal(stillOfflineAt400.rawPhase, 'offline');
  assert.equal(stillOfflineAt400.nextTransitionInMs, 300);

  const settledOffline = stepConnectionPhaseState(
    stillOfflineAt400.state,
    { hasCachedRemoteBots: true, remoteConnected: false },
    700,
  );
  assert.equal(settledOffline.phase, 'offline');
  assert.equal(settledOffline.rawPhase, 'offline');
  assert.equal(settledOffline.nextTransitionInMs, null);

  // Case 2: Cold start with cached remote bots already actively connecting.
  const coldConnecting = createConnectionPhaseState(
    { hasCachedRemoteBots: true, remoteConnected: false, centerConnecting: true },
    500,
  );
  assert.equal(coldConnecting.phase, 'connecting');
  assert.equal(coldConnecting.rawPhase, 'connecting');
  assert.equal(coldConnecting.visibleSinceMs, 500);
  assert.equal(coldConnecting.nextTransitionInMs, null);

  const coldConnectingOnline = stepConnectionPhaseState(coldConnecting, onlineInput, 800);
  assert.equal(coldConnectingOnline.phase, 'connecting');
  assert.equal(coldConnectingOnline.nextTransitionInMs, 300);

  const coldConnectingDone = stepConnectionPhaseState(coldConnectingOnline.state, onlineInput, 1_100);
  assert.equal(coldConnectingDone.phase, 'online');
  assert.equal(coldConnectingDone.nextTransitionInMs, null);

  // Case 3: Cold start with cached remote bots and existing error immediately shows 'error'.
  const coldError = createConnectionPhaseState(
    { hasCachedRemoteBots: true, remoteConnected: false, centerError: 'Unauthorized' },
    500,
  );
  assert.equal(coldError.phase, 'error');
  assert.equal(coldError.rawPhase, 'error');
  assert.equal(coldError.visibleSinceMs, 500);
  assert.equal(coldError.nextTransitionInMs, null);

  // Case 4: Cold start when remote is already connected starts 'online'.
  const coldAlreadyOnline = createConnectionPhaseState(onlineInput, 500);
  assert.equal(coldAlreadyOnline.phase, 'online');
  assert.equal(coldAlreadyOnline.visibleSinceMs, null);
  assert.equal(coldAlreadyOnline.nextTransitionInMs, null);
});

// ---------------------------------------------------------------------------
// S2: reduceActionState (useAction stale-error preservation)
// ---------------------------------------------------------------------------

test('S2 reduceActionState preserves error as stale on start, clears on succeed, and replaces on fail/set-error', () => {
  assert.deepEqual(INITIAL_ACTION_STATE, {
    error: '',
    errorStale: false,
    busy: false,
  });

  // Starting from clean state enters busy with no stale error.
  const firstStart = reduceActionState(INITIAL_ACTION_STATE, { type: 'start' });
  assert.deepEqual(firstStart, {
    error: '',
    errorStale: false,
    busy: true,
  });

  // First failure records error with errorStale: false.
  const firstFail = reduceActionState(firstStart, {
    type: 'fail',
    error: 'Center unreachable',
  });
  assert.deepEqual(firstFail, {
    error: 'Center unreachable',
    errorStale: false,
    busy: false,
  });

  // Retrying preserves existing error and marks it stale instead of collapsing the notice.
  const retrySnapshot = { ...firstFail };
  const retryStart = reduceActionState(firstFail, { type: 'start' });
  assert.deepEqual(retryStart, {
    error: 'Center unreachable',
    errorStale: true,
    busy: true,
  });
  // Input state is not mutated.
  assert.deepEqual(firstFail, retrySnapshot);

  // Succeeding clears error and resets errorStale and busy.
  const afterSuccess = reduceActionState(retryStart, { type: 'succeed' });
  assert.deepEqual(afterSuccess, {
    error: '',
    errorStale: false,
    busy: false,
  });

  // Failing a retry replaces the stale error in place with errorStale: false.
  const secondFail = reduceActionState(retryStart, {
    type: 'fail',
    error: 'TLS certificate mismatch',
  });
  assert.deepEqual(secondFail, {
    error: 'TLS certificate mismatch',
    errorStale: false,
    busy: false,
  });

  // Explicit set-error sets or clears error with errorStale: false while preserving busy.
  const manualDuringRetry = reduceActionState(retryStart, {
    type: 'set-error',
    error: 'Invalid center URL',
  });
  assert.deepEqual(manualDuringRetry, {
    error: 'Invalid center URL',
    errorStale: false,
    busy: true,
  });

  const clearedDuringRetry = reduceActionState(retryStart, {
    type: 'set-error',
    error: '',
  });
  assert.deepEqual(clearedDuringRetry, {
    error: '',
    errorStale: false,
    busy: true,
  });

  const clearedWhenIdle = reduceActionState(secondFail, {
    type: 'set-error',
    error: '',
  });
  assert.deepEqual(clearedWhenIdle, {
    error: '',
    errorStale: false,
    busy: false,
  });
});

// ---------------------------------------------------------------------------
// F4: Home screen frame-1 partition key & group chat cache (scopeCache.ts)
// ---------------------------------------------------------------------------

test('F4 readInitialCenterPartitionKey matches live center origin on frame 1 and honors allowCachedCenterUrl=false', () => {
  assert.equal(ACTIVE_CENTER_URL_STORAGE_KEY, 'active-center-url');
  const storage = createMemoryStorage({
    [ACTIVE_CENTER_URL_STORAGE_KEY]: 'https://center.example.com:8443/api/v1?boot=1',
  });

  // Frame 1: live URLs are all empty -> synchronously reads localStorage['active-center-url'].
  const frame1Key = readInitialCenterPartitionKey({
    activeCenterUrl: '',
    savedCenterUrl: undefined,
    centerConnUrl: '',
    localDeviceId: 'dev-local-1',
    storage,
  });
  assert.equal(frame1Key, 'center:https://center.example.com:8443');

  // Frame 2+: live activeCenterUrl resolves -> produces the exact same partition key (no jump).
  const frame2Key = readInitialCenterPartitionKey({
    activeCenterUrl: 'https://center.example.com:8443/status',
    savedCenterUrl: 'https://saved.example.com',
    centerConnUrl: 'https://conn.example.com',
    localDeviceId: 'dev-local-1',
    storage,
  });
  assert.equal(frame2Key, frame1Key);

  // Live URL precedence: activeCenterUrl > savedCenterUrl > centerConnUrl > cached storage.
  assert.equal(
    readInitialCenterPartitionKey({
      savedCenterUrl: 'https://saved.example.com/a',
      centerConnUrl: 'https://conn.example.com/b',
      storage,
    }),
    'center:https://saved.example.com',
  );
  assert.equal(
    readInitialCenterPartitionKey({
      centerConnUrl: 'https://conn.example.com/b',
      storage,
    }),
    'center:https://conn.example.com',
  );

  // allowCachedCenterUrl: false ignores cached URL and falls back to profile: or local:.
  assert.equal(
    readInitialCenterPartitionKey({
      allowCachedCenterUrl: false,
      remoteProfileId: 'prof-42',
      remoteKind: 'relay',
      localDeviceId: 'dev-local-1',
      storage,
    }),
    'profile:prof-42:relay',
  );
  assert.equal(
    readInitialCenterPartitionKey({
      allowCachedCenterUrl: false,
      remoteProfileId: 'prof-42',
      storage,
    }),
    'profile:prof-42',
  );
  assert.equal(
    readInitialCenterPartitionKey({
      allowCachedCenterUrl: false,
      localDeviceId: 'dev-local-1',
      storage,
    }),
    'local:dev-local-1',
  );
  assert.equal(
    readInitialCenterPartitionKey({
      allowCachedCenterUrl: false,
      storage,
    }),
    'local:local',
  );

  // storage: null disables storage fallback explicitly.
  assert.equal(
    readInitialCenterPartitionKey({
      localDeviceId: 'dev-offline',
      storage: null,
    }),
    'local:dev-offline',
  );

  // Origin normalization, partition key normalization, and active-center-url cache helpers.
  assert.equal(normalizeCenterUrlOrigin('https://hub.example.com/sub/path'), 'https://hub.example.com');
  assert.equal(normalizeCenterUrlOrigin('not-a-url'), 'not-a-url');
  assert.equal(normalizeCenterUrlOrigin('   '), '');
  assert.equal(normalizePartitionKey('prof-1|relay|7|dev-1'), 'prof-1|relay|dev-1');
  assert.equal(normalizePartitionKey('center:https://a.example|gen:12'), 'center:https://a.example');
  assert.equal(normalizePartitionKey('   '), 'default');

  assert.equal(writeActiveCenterUrlCache('  https://next.example.com/  ', storage), true);
  assert.equal(readActiveCenterUrlCache(storage), 'https://next.example.com/');
  assert.equal(writeActiveCenterUrlCache(null, storage), true);
  assert.equal(readActiveCenterUrlCache(storage), '');

  // Throwing storage is handled safely.
  const brokenStorage = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
    removeItem() {
      throw new Error('storage disabled');
    },
  };
  assert.equal(readActiveCenterUrlCache(brokenStorage), '');
  assert.equal(writeActiveCenterUrlCache('https://a.example', brokenStorage), false);
});

test('F4 scope conversations cache isolates partitions, distinguishes miss vs empty hit, strips transient fields, and handles errors safely', () => {
  const storage = createMemoryStorage();
  const partA = 'center:https://center-a.example';
  const partB = 'center:https://center-b.example';

  assert.equal(
    scopeConversationsCacheKey(partA),
    `${SCOPE_CONVERSATIONS_CACHE_KEY_PREFIX}${partA}`,
  );

  // 1. Uncached partition reports hit: false (cache miss).
  assert.deepEqual(readScopeConversationsCacheEntry(partA, storage), {
    hit: false,
    items: [],
    updatedAt: null,
  });
  assert.deepEqual(readCachedScopeConversations(partA, storage), []);

  // Removing from an uncached partition is a no-op and must NOT fabricate a cache hit.
  assert.equal(removeCachedScopeConversation(partA, 'room-1', storage), false);
  assert.equal(readScopeConversationsCacheEntry(partA, storage).hit, false);

  // 2. Writing an empty array records a confirmed empty cache hit (hit: true, items: []).
  assert.equal(writeCachedScopeConversations(partB, [], storage), true);
  const emptyEntry = readScopeConversationsCacheEntry(partB, storage);
  assert.equal(emptyEntry.hit, true);
  assert.deepEqual(emptyEntry.items, []);
  assert.equal(typeof emptyEntry.updatedAt, 'number');

  // 3. Write strips non-serializable api & transient delivery, drops deleted tombstones,
  //    truncates oversized previews, deduplicates by revision/authority, and sorts newest first.
  const longPreview = 'x'.repeat(620);
  const roomOlder = makeRoomConversation({
    scopeId: 'room-old',
    title: 'Old Room',
    lastPreview: 'earlier',
    lastActivityAt: '2026-06-01T08:00:00.000Z',
    delivery: { status: 'syncing', pendingCount: 2 },
    api: { send() {} },
  });
  const roomDupLowRev = makeRoomConversation({
    scopeId: 'room-new',
    title: 'Stale Copy',
    innerScope: { revision: 2 },
    scope: { isAuthority: false },
    lastPreview: 'stale',
    lastActivityAt: '2026-06-01T09:00:00.000Z',
  });
  const roomDupHighRev = makeRoomConversation({
    scopeId: 'room-new',
    title: 'Fresh Copy',
    innerScope: { revision: 5 },
    scope: { isAuthority: true },
    lastPreview: longPreview,
    lastActivityAt: '2026-06-01T12:00:00.000Z',
    delivery: { status: 'queued' },
    api: { read() {} },
  });
  const roomNullActivity = makeRoomConversation({
    scopeId: 'room-empty-history',
    title: 'Never Spoken',
    lastPreview: '',
    lastActivityAt: null,
  });
  const roomDeleted = makeRoomConversation({
    scopeId: 'room-deleted',
    title: 'Deleted Room',
    innerScope: { deletedAt: '2026-06-01T11:00:00.000Z' },
    lastActivityAt: '2026-06-01T13:00:00.000Z',
  });

  assert.equal(
    writeCachedScopeConversations(
      partA,
      [roomOlder, roomDupLowRev, roomDupHighRev, roomNullActivity, roomDeleted],
      storage,
    ),
    true,
  );

  // Partition B remains isolated and untouched.
  assert.deepEqual(readCachedScopeConversations(partB, storage), []);

  // Partition A returns sanitized, deduplicated, sorted items.
  const entryA = readScopeConversationsCacheEntry(partA, storage);
  assert.equal(entryA.hit, true);
  assert.deepEqual(
    entryA.items.map((item) => item.scope.scope.scopeId),
    ['room-new', 'room-old', 'room-empty-history'],
  );
  assert.equal(entryA.items[0].title, 'Fresh Copy');
  assert.equal(entryA.items[0].scope.scope.revision, 5);
  assert.equal(entryA.items[0].lastPreview.length, 500);
  assert.equal('api' in entryA.items[0], false);
  assert.equal(entryA.items[0].scope.delivery, null);
  assert.equal(entryA.items[1].scope.delivery, null);
  assert.equal('api' in entryA.items[1], false);
  assert.equal(entryA.items[2].lastActivityAt, null);

  // Partition keys differing only by connection generation share the same cache slot.
  const genEntry = readScopeConversationsCacheEntry(`${partA}|generation:9`, storage);
  assert.equal(genEntry.hit, true);
  assert.equal(genEntry.items.length, 3);

  // 4. removeCachedScopeConversation prunes only the targeted scopeId and preserves hit: true.
  assert.equal(removeCachedScopeConversation(partA, 'room-old', storage), true);
  assert.deepEqual(
    readCachedScopeConversations(partA, storage).map((item) => item.scope.scope.scopeId),
    ['room-new', 'room-empty-history'],
  );
  // Removing a missing scopeId on a hit partition succeeds without altering items.
  assert.equal(removeCachedScopeConversation(partA, 'room-nonexistent', storage), true);
  assert.equal(readCachedScopeConversations(partA, storage).length, 2);

  // Removing remaining items leaves a valid empty hit (hit: true, items: []).
  assert.equal(removeCachedScopeConversation(partA, 'room-new', storage), true);
  assert.equal(removeCachedScopeConversation(partA, 'room-empty-history', storage), true);
  const emptiedA = readScopeConversationsCacheEntry(partA, storage);
  assert.equal(emptiedA.hit, true);
  assert.deepEqual(emptiedA.items, []);

  // 5. Corrupted JSON, wrong schema version, legacy array format, and throwing storage are safe.
  const corruptPart = 'center:https://corrupt.example';
  storage.setItem(scopeConversationsCacheKey(corruptPart), '{not-valid-json');
  assert.deepEqual(readScopeConversationsCacheEntry(corruptPart, storage), {
    hit: false,
    items: [],
    updatedAt: null,
  });
  assert.deepEqual(readCachedScopeConversations(corruptPart, storage), []);

  const badVerPart = 'center:https://bad-version.example';
  storage.setItem(
    scopeConversationsCacheKey(badVerPart),
    JSON.stringify({ v: SCOPE_CONVERSATIONS_CACHE_VERSION + 99, items: [roomOlder] }),
  );
  assert.deepEqual(readScopeConversationsCacheEntry(badVerPart, storage), {
    hit: false,
    items: [],
    updatedAt: null,
  });

  const legacyPart = 'center:https://legacy-array.example';
  storage.setItem(scopeConversationsCacheKey(legacyPart), JSON.stringify([roomOlder]));
  const legacyEntry = readScopeConversationsCacheEntry(legacyPart, storage);
  assert.equal(legacyEntry.hit, true);
  assert.equal(legacyEntry.updatedAt, null);
  assert.equal(legacyEntry.items.length, 1);
  assert.equal(legacyEntry.items[0].scope.scope.scopeId, 'room-old');

  // Empty partition key and throwing storage never throw.
  assert.equal(writeCachedScopeConversations('   ', [roomOlder], storage), false);
  assert.deepEqual(readScopeConversationsCacheEntry('   ', storage), {
    hit: false,
    items: [],
    updatedAt: null,
  });

  const failingStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  assert.deepEqual(readScopeConversationsCacheEntry(partA, failingStorage), {
    hit: false,
    items: [],
    updatedAt: null,
  });
  assert.deepEqual(readCachedScopeConversations(partA, failingStorage), []);
  assert.equal(writeCachedScopeConversations(partA, [roomOlder], failingStorage), false);
  assert.equal(removeCachedScopeConversation(partA, 'room-old', failingStorage), false);
});

test('center-admin scrollable flex column items do not shrink or collapse to zero min-height', () => {
  const css = readFileSync(new URL('../src/center-admin/center-admin.css', import.meta.url), 'utf8');
  for (const selector of ['.ca-model-option', '.ca-menu-item', '.ca-google-choice', '.ca-google-assistant-option']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(match, `Expected CSS rule for ${selector}`);
    const body = match[1];
    assert.match(body, /flex-shrink\s*:\s*0\s*;/, `${selector} must set flex-shrink: 0 to prevent squishing inside scrollable flex columns`);
    assert.doesNotMatch(body, /min-height\s*:\s*0\s*;/, `${selector} must not set min-height: 0 inside flex columns`);
  }
});

test('assistant replies stay left-aligned and span full chat width across desktop, mobile, and scope surfaces', () => {
  const extractRule = (css, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(match, `Expected CSS rule for ${selector}`);
    return match[1];
  };

  const transcriptCss = readFileSync(new URL('../../desktop/web/src/ChatTranscript.css', import.meta.url), 'utf8');
  const desktopBubble = extractRule(transcriptCss, '.desktop-shell .desktop-transcript .bot-chat-bubble');
  assert.match(desktopBubble, /align-self\s*:\s*stretch\s*;/);
  assert.match(desktopBubble, /width\s*:\s*100%\s*;/);
  assert.match(desktopBubble, /max-width\s*:\s*100%\s*;/);
  assert.match(desktopBubble, /text-align\s*:\s*left\s*;/);
  assert.doesNotMatch(desktopBubble, /max-width\s*:[^;]*\bch\b/);

  for (const relPath of ['../../desktop/web/src/app.css', '../src/hub/chat.css', '../src/styles.css']) {
    const css = readFileSync(new URL(relPath, import.meta.url), 'utf8');
    const assistantBubble = extractRule(css, '.bot-chat-bubble.assistant');
    assert.match(assistantBubble, /width\s*:\s*100%\s*;/, `${relPath} .bot-chat-bubble.assistant must span 100% width`);
    assert.match(assistantBubble, /max-width\s*:\s*100%\s*;/, `${relPath} .bot-chat-bubble.assistant must not cap max-width below 100%`);
    assert.match(assistantBubble, /align-self\s*:\s*stretch\s*;/, `${relPath} .bot-chat-bubble.assistant must stretch across turn`);
    assert.match(assistantBubble, /text-align\s*:\s*left\s*;/, `${relPath} .bot-chat-bubble.assistant must stay left-aligned`);
  }

  const markdownCss = readFileSync(new URL('../src/Markdown.css', import.meta.url), 'utf8');
  assert.doesNotMatch(markdownCss, /max-width\s*:[^;]*\bch\b/, 'Markdown.css must not cap prose width with ch units');

  const scopeChatCss = readFileSync(new URL('../src/gbot-ui/conversation-chat.css', import.meta.url), 'utf8');
  const scopeMsg = extractRule(scopeChatCss, '.conversation-chat-message');
  assert.match(scopeMsg, /width\s*:\s*100%\s*;/);
  assert.match(scopeMsg, /max-width\s*:\s*100%\s*;/);
  const scopeBotBubble = extractRule(
    scopeChatCss,
    '.conversation-chat-message:not(.conversation-chat-message--user) .conversation-chat-message__bubble',
  );
  assert.match(scopeBotBubble, /width\s*:\s*100%\s*;/);
  assert.match(scopeBotBubble, /text-align\s*:\s*left\s*;/);
});

test('desktop bot list lets hub-list-scroll own wheel scrolling and avoids scrollbar-width overriding webkit scrollbars', () => {
  const extractRule = (css, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(match, `Expected CSS rule for ${selector}`);
    return match[1];
  };

  const desktopAppCss = readFileSync(new URL('../../desktop/web/src/app.css', import.meta.url), 'utf8');
  const appHubBotList = extractRule(desktopAppCss, '.hub-bot-list');
  assert.doesNotMatch(
    appHubBotList,
    /overflow(?:-y)?\s*:\s*(?:auto|scroll)\b/,
    'app.css .hub-bot-list must not create a nested scroll container inside .hub-list-scroll',
  );
  assert.doesNotMatch(
    appHubBotList,
    /overscroll-behavior(?:-y)?\s*:\s*(?:contain|none)\b/,
    'app.css .hub-bot-list must not trap wheel scroll chaining inside .hub-list-scroll',
  );

  const botChatsCss = readFileSync(new URL('../../desktop/web/src/BotChats.css', import.meta.url), 'utf8');
  const listScroll = extractRule(botChatsCss, '.hub-list-scroll');
  assert.match(listScroll, /overflow-y\s*:\s*auto\s*;/);
  assert.match(listScroll, /overscroll-behavior\s*:\s*contain\s*;/);

  const botList = extractRule(botChatsCss, '.hub-bot-list');
  assert.match(botList, /overflow\s*:\s*visible\s*;/);
  assert.match(botList, /overscroll-behavior\s*:\s*auto\s*;/);

  const tokensCss = readFileSync(new URL('../src/design-system/tokens.css', import.meta.url), 'utf8');
  assert.match(
    tokensCss,
    /@supports\s+not\s+selector\(::-webkit-scrollbar\)\s*\{[\s\S]*?scrollbar-width\s*:\s*thin\s*;[\s\S]*?scrollbar-color\s*:/,
    'tokens.css must guard scrollbar-width/scrollbar-color so WebKitGTK and Chromium keep custom ::-webkit-scrollbar styles',
  );
  const tokensWithoutGuard = tokensCss.replace(
    /@supports\s+not\s+selector\(::-webkit-scrollbar\)\s*\{[\s\S]*?\}\s*\}/,
    '',
  );
  assert.doesNotMatch(
    tokensWithoutGuard,
    /scrollbar-(?:width|color)\s*:/,
    'tokens.css must not emit unguarded scrollbar-width/scrollbar-color rules',
  );

  for (const relPath of [
    '../../desktop/web/src/app.css',
    '../../desktop/web/src/pet/pet.css',
    '../../desktop/web/src/pet/voice.css',
  ]) {
    const css = readFileSync(new URL(relPath, import.meta.url), 'utf8');
    assert.doesNotMatch(
      css,
      /scrollbar-width\s*:\s*thin\b/,
      `${relPath} must not set scrollbar-width: thin directly (breaks ::-webkit-scrollbar in WebKitGTK/Chromium)`,
    );
  }
});

test('center-admin discover models modal pins its save footer and prevents vertical search input inflation', () => {
  const css = readFileSync(new URL('../src/center-admin/center-admin.css', import.meta.url), 'utf8');
  const primitives = readFileSync(new URL('../src/center-admin/primitives.tsx', import.meta.url), 'utf8');
  const providers = readFileSync(new URL('../src/center-admin/ProvidersTab.tsx', import.meta.url), 'utf8');

  const extractRule = (source, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(match, `Expected CSS rule for ${selector}`);
    return match[1];
  };

  assert.match(extractRule(css, '.ca-dialog-header'), /flex-shrink\s*:\s*0\s*;/);
  assert.match(extractRule(css, '.ca-dialog-footer'), /flex-shrink\s*:\s*0\s*;/);
  assert.match(extractRule(css, '.ca-discover-list'), /flex\s*:\s*1\s+1\s+auto\s*;/);

  // Extract @container (max-width: 520px) block and verify .ca-discover-bar is not trapped inside it
  // (a 540px modal's .ca-dialog-body content box is 502px wide, which would always trigger <= 520px on desktop).
  const container520Start = css.indexOf('@container (max-width: 520px)');
  assert.notEqual(container520Start, -1, 'Expected @container (max-width: 520px) block');
  const container420Start = css.indexOf('@container (max-width: 420px)', container520Start);
  assert.notEqual(container420Start, -1, 'Expected @container (max-width: 420px) block');
  const container520Block = css.slice(container520Start, container420Start);
  assert.doesNotMatch(container520Block, /\.ca-discover-bar\b/);
  assert.doesNotMatch(container520Block, /\.ca-discover-device\b/);

  // Both narrow-container and mobile column layouts must reset flex-basis on stacked discover controls
  // so .ca-discover-search (flex: 1 1 140px in row mode) never inflates to 140px height.
  const media1024Start = css.indexOf('@media (max-width: 1024px)', container420Start);
  assert.notEqual(media1024Start, -1);
  const container420Block = css.slice(container420Start, media1024Start);
  assert.match(container420Block, /\.ca-discover-bar\s*>\s*\.ca-discover-search,\s*[\r\n]+\s*\.ca-discover-bar\s*>\s*\.ca-discover-device\s*\{[^}]*flex\s*:\s*0\s+0\s+auto\s*;/);

  const media640Start = css.indexOf('@media (max-width: 640px)');
  assert.notEqual(media640Start, -1);
  const coarseStart = css.indexOf('@media (pointer: coarse)', media640Start);
  assert.notEqual(coarseStart, -1);
  const media640Block = css.slice(media640Start, coarseStart);
  assert.match(media640Block, /\.ca-discover-bar\s*>\s*\.ca-discover-search,\s*[\r\n]+\s*\.ca-discover-bar\s*>\s*\.ca-discover-device\s*\{[^}]*flex\s*:\s*0\s+0\s+auto\s*;/);

  // CaModal renders .ca-dialog-footer as a sibling after .ca-dialog-body, not inside the scroll area.
  assert.match(
    primitives,
    /<div className=\{`ca-dialog-body\$\{bodyClassName \? ` \$\{bodyClassName\}` : ''\}`\}>\{children\}<\/div>\s*[\r\n]+\s*\{footer \? <div className="ca-dialog-footer">\{footer\}<\/div> : null\}/,
  );

  // Discover modal mounts its Save action in the pinned CaModal footer slot.
  assert.match(
    providers,
    /open=\{discoverModalOpen\}[\s\S]*?bodyClassName="ca-dialog-body-flex"[\s\S]*?footer=\{[\s\S]*?confirmBatchModels\(\)/,
  );
});
