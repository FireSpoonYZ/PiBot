// host-core/bot-browser/state.js
// Per-bot browser state, one human input lease, generation/revision tracking,
// and a sequential bot action queue with explicit takeover settlement.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BROWSER_DEFAULT_LEASE_TTL_MS,
  BROWSER_DEFAULT_TAKEOVER_TIMEOUT_MS,
  BROWSER_MAX_TABS_PER_BOT,
  browserError,
  normalizeTabs,
} from './protocol.js';
import { classifyPageSensitivity, mergeProviderHints } from './policy.js';

function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function defaultRandomToken() {
  return randomBytes(24).toString('base64url');
}

function defaultSensitivity() {
  return classifyPageSensitivity({ url: '', title: '' });
}

export function createBotBrowserState({
  botId,
  profileDir,
  now = () => Date.now(),
  randomToken = defaultRandomToken,
  leaseTtlMs = BROWSER_DEFAULT_LEASE_TTL_MS,
  takeoverTimeoutMs = BROWSER_DEFAULT_TAKEOVER_TIMEOUT_MS,
  maxTabsPerBot = BROWSER_MAX_TABS_PER_BOT,
  isPageWithheld = null,
  onEvent = null,
}) {
  let sessionId = null;
  let phase = 'bot'; // 'bot' | 'taking' | 'human' | 'held'
  let revision = 0;
  let available = false;
  let unavailableReason = null;
  let holdReason = null;
  let canStreamInteract = false;
  let capabilities = Object.freeze({ privateSecretIsolation: false });

  let pageId = null;
  let documentGeneration = null;
  let tabs = [];
  let lastHints = null;
  let lastProviderSensitive = false;
  let providerSensitiveReason = null;
  let sensitivity = defaultSensitivity();
  let snapshotRefs = new Map();

  // One human input lease (memory-only, never persisted, never logged).
  let lease = null; // { token, clientId, holderLabel, issuedAt, lastSeenAt, expiresAt, shared }
  let leaseGeneration = 0;
  let lastHolderLabel = null;
  let leaseTimer = null;

  // Monotonic frame sequence & invalidation floor for stale-frame detection.
  let lastFrameSeq = 0;
  let minValidFrameSeq = 1;
  let lastFramePageId = null;
  let lastFrameRevision = null;

  // Real sequential bot operation queue & in-flight tracking.
  const botQueue = [];
  let inFlightBotOp = null; // { id, action, controller, done, settled, outcome, startedAt }
  let opCounter = 0;
  let takingState = null; // { clientId, holderLabel, promise }

  let lastActivityAt = now();
  let closed = false;

  function emit(type, extra = {}) {
    if (typeof onEvent !== 'function') return;
    // Never emit lease tokens, frame bytes, or input text.
    try {
      onEvent({
        type,
        botId,
        sessionId,
        phase,
        revision,
        pageId,
        reason: currentReason(),
        holderLabel: currentHolderLabel(),
        sensitive: sensitivity.sensitive,
        secretRisk: sensitivity.secretRisk,
        ...extra,
      });
    } catch {
      // Event observers must never break state machine invariants.
    }
  }

  function clearLeaseTimer() {
    if (leaseTimer !== null) {
      clearTimeout(leaseTimer);
      leaseTimer = null;
    }
  }

  function scheduleLeaseTimer() {
    clearLeaseTimer();
    if (closed || phase !== 'human' || !lease) return;
    const remaining = Math.max(1, lease.expiresAt - now());
    leaseTimer = setTimeout(() => {
      leaseTimer = null;
      expireLeaseIfNeeded();
    }, remaining);
    leaseTimer.unref?.();
  }

  function bumpRevision(invalidateFrames = false) {
    revision += 1;
    if (invalidateFrames) {
      minValidFrameSeq = lastFrameSeq + 1;
      lastFramePageId = null;
      lastFrameRevision = null;
    }
    return revision;
  }

  function currentHolderLabel() {
    if (phase === 'human' && lease) return lease.holderLabel;
    if (phase === 'taking' && takingState) return takingState.holderLabel;
    if (phase === 'held' && lastHolderLabel) return lastHolderLabel;
    return null;
  }

  function currentReason() {
    if (!available && unavailableReason) return unavailableReason;
    if (phase === 'held' && holdReason) return holdReason;
    if (phase === 'taking') return 'taking_over';
    return null;
  }

  function activeTab() {
    if (!pageId) return tabs[0] ?? null;
    return tabs.find((t) => t.id === pageId) ?? tabs[0] ?? null;
  }

  function canBotOperate() {
    return !closed && (phase === 'bot' || (phase === 'human' && lease?.shared === true && !sensitivity.sensitive));
  }

  function recomputeSensitivity(override = {}) {
    const tab = activeTab();
    const url = override.url !== undefined ? override.url : (tab?.url ?? '');
    const title = override.title !== undefined ? override.title : (tab?.title ?? '');
    const hints = override.hints !== undefined ? override.hints : lastHints;
    const providerSensitive = override.providerSensitive !== undefined
      ? Boolean(override.providerSensitive)
      : lastProviderSensitive;

    const prevSensitive = sensitivity.sensitive;
    const prevSecret = sensitivity.secretRisk;

    lastHints = hints ?? null;
    lastProviderSensitive = providerSensitive;
    sensitivity = classifyPageSensitivity({
      url,
      title,
      hints: lastHints,
      providerSensitive: lastProviderSensitive,
      botId,
      pageId,
      isPageWithheld,
    });

    if (sensitivity.blockBotObserve) {
      snapshotRefs.clear();
    }
    if (lease?.shared && sensitivity.sensitive) {
      holdForSensitive({ reason: sensitivity.reasons[0] ?? 'sensitive_page', guidance: sensitivity.guidance });
    } else if (sensitivity.sensitive !== prevSensitive || sensitivity.secretRisk !== prevSecret) {
      bumpRevision(true);
    }
    return sensitivity;
  }

  /**
   * Expiration drops shared input while bot control continues. An expired exclusive
   * takeover leaves the browser held until the owner decides how to resume.
   */
  function expireLeaseIfNeeded() {
    if (phase !== 'human' || !lease) return false;
    if (now() <= lease.expiresAt) return false;

    clearLeaseTimer();
    const shared = lease.shared === true && !sensitivity.sensitive;
    lastHolderLabel = shared ? null : lease.holderLabel;
    lease = null;
    phase = shared ? 'bot' : 'held';
    holdReason = shared ? null : 'disconnected_hold';
    if (!shared) snapshotRefs.clear();
    bumpRevision(true);
    emit('lease_expired', { reason: shared ? 'shared_input_expired' : 'disconnected_hold' });
    return true;
  }

  function cancelQueuedBotOps(reason = 'paused_for_human') {
    let count = 0;
    while (botQueue.length > 0) {
      const entry = botQueue.shift();
      entry.cancelled = true;
      count += 1;
      const err = browserError(
        'BROWSER_PAUSED_FOR_HUMAN',
        'Bot browser command was cancelled before dispatch because human control or hold is active.',
        { phase, reason, holderLabel: currentHolderLabel() }
      );
      err.outcome = 'not-sent';
      entry.reject(err);
    }
    return count;
  }

  function abortInFlightBotOp(reason = 'takeover_requested') {
    if (!inFlightBotOp || inFlightBotOp.settled) return null;
    const err = browserError(
      'BROWSER_PAUSED_FOR_HUMAN',
      'In-flight bot browser action aborted for human takeover.',
      { phase, reason, holderLabel: currentHolderLabel() }
    );
    try {
      inFlightBotOp.controller.abort(err);
    } catch {
      // Ignore already-aborted controller errors.
    }
    return inFlightBotOp.done;
  }

  async function confirmSettlement(done) {
    if (await done === 'unconfirmed') throw browserError('BROWSER_TAKEOVER_UNCONFIRMED');
  }

  function pumpBotQueue() {
    if (!canBotOperate() || inFlightBotOp !== null || botQueue.length === 0) {
      return;
    }
    const next = botQueue.shift();
    if (!next || next.cancelled) {
      pumpBotQueue();
      return;
    }
    if (!canBotOperate()) {
      const err = browserError(
        closed ? 'BROWSER_CLOSED' : 'BROWSER_PAUSED_FOR_HUMAN',
        closed ? 'Bot browser service is closed.' : 'Browser is paused for human control.',
        { phase, reason: currentReason(), holderLabel: currentHolderLabel() }
      );
      err.outcome = 'not-sent';
      next.reject(err);
      return;
    }

    const controller = new AbortController();
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const op = {
      id: ++opCounter,
      action: next.action,
      controller,
      done,
      settled: false,
      outcome: 'running',
      startedAt: now(),
    };
    inFlightBotOp = op;
    lastActivityAt = now();

    Promise.resolve()
      .then(() => next.fn(controller.signal))
      .then(
        (result) => {
          op.outcome = 'settled';
          op.settled = true;
          if (inFlightBotOp === op) inFlightBotOp = null;
          resolveDone();
          next.resolve(result);
        },
        (error) => {
          op.outcome = controller.signal.aborted ? 'aborted' : 'failed';
          op.settled = true;
          if (inFlightBotOp === op) inFlightBotOp = null;
          const uncertain = next.mutating && error?.outcome === 'unconfirmed';
          if (uncertain && (phase === 'bot' || lease?.shared)) holdForSensitive({ reason: 'action_unconfirmed' });
          resolveDone(uncertain ? 'unconfirmed' : 'settled');
          next.reject(error);
        }
      )
      .finally(() => {
        pumpBotQueue();
      });
  }

  function enqueueBotOp(action, fn, { mutating = true } = {}) {
    expireLeaseIfNeeded();
    if (closed) {
      return Promise.reject(browserError('BROWSER_CLOSED'));
    }
    if (!canBotOperate()) {
      const err = browserError(
        'BROWSER_PAUSED_FOR_HUMAN',
        'Bot browser actions are paused while human takeover or hold is active.',
        { phase, reason: currentReason(), holderLabel: currentHolderLabel() }
      );
      err.outcome = 'not-sent';
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      botQueue.push({ action, fn, mutating, resolve, reject, cancelled: false });
      pumpBotQueue();
    });
  }

  function syncProviderResult(result, { invalidateFramesOnChange = true } = {}) {
    if (!result || typeof result !== 'object') return;
    lastActivityAt = now();

    let changed = false;

    if (typeof result.available === 'boolean') {
      if (available !== result.available) {
        available = result.available;
        changed = true;
      }
    }
    if (result.reason !== undefined) {
      const nextUnavailable = available ? null : (typeof result.reason === 'string' ? result.reason : null);
      if (unavailableReason !== nextUnavailable) {
        unavailableReason = nextUnavailable;
        changed = true;
      }
    } else if (available && unavailableReason !== null) {
      unavailableReason = null;
      changed = true;
    }

    if (typeof result.canStreamInteract === 'boolean') {
      if (canStreamInteract !== result.canStreamInteract) {
        canStreamInteract = result.canStreamInteract;
        changed = true;
      }
    }
    if (!available) {
      canStreamInteract = false;
    }

    if (result.capabilities && typeof result.capabilities === 'object') {
      capabilities = Object.freeze({
        privateSecretIsolation: result.capabilities.privateSecretIsolation === true,
      });
    }

    if (result.sessionId !== undefined) {
      const nextSessionId = typeof result.sessionId === 'string' && result.sessionId.trim() !== ''
        ? result.sessionId.trim()
        : null;
      if (sessionId !== nextSessionId) {
        sessionId = nextSessionId;
        changed = true;
      }
    }

    const prevPageId = pageId;
    const prevDocGen = documentGeneration;
    const prevActiveUrl = activeTab()?.url ?? '';

    if (Array.isArray(result.tabs)) {
      const nextTabs = normalizeTabs(result.tabs, maxTabsPerBot);
      const tabsChanged =
        nextTabs.length !== tabs.length ||
        nextTabs.some((t, idx) =>
          t.id !== tabs[idx].id || t.url !== tabs[idx].url || t.title !== tabs[idx].title
        );
      if (tabsChanged) {
        tabs = nextTabs;
        changed = true;
      }
      if (!sessionId && tabs.length > 0) {
        sessionId = `browser-${randomUUID()}`;
        changed = true;
      }
    }

    if (result.pageId !== undefined) {
      const nextPageId = typeof result.pageId === 'string' && result.pageId.trim() !== ''
        ? result.pageId.trim()
        : null;
      if (pageId !== nextPageId) {
        pageId = nextPageId;
        changed = true;
      }
    } else if (pageId && tabs.length > 0 && !tabs.some((t) => t.id === pageId)) {
      pageId = tabs[0].id;
      changed = true;
    } else if (!pageId && tabs.length > 0) {
      pageId = tabs[0].id;
      changed = true;
    }

    // Keep active tab url/title synced if provider returned top-level url/title for the active page.
    if (pageId && (typeof result.url === 'string' || typeof result.title === 'string')) {
      const idx = tabs.findIndex((t) => t.id === pageId);
      if (idx >= 0) {
        const cur = tabs[idx];
        const nextUrl = typeof result.url === 'string' ? result.url : cur.url;
        const nextTitle = typeof result.title === 'string' ? result.title : cur.title;
        if (nextUrl !== cur.url || nextTitle !== cur.title) {
          tabs = tabs.slice();
          tabs[idx] = { id: cur.id, title: nextTitle, url: nextUrl };
          changed = true;
        }
      } else if (typeof result.url === 'string') {
        tabs = [...tabs, { id: pageId, title: typeof result.title === 'string' ? result.title : '', url: result.url }].slice(0, maxTabsPerBot);
        changed = true;
      }
    }

    if (result.documentGeneration !== undefined && result.documentGeneration !== documentGeneration) {
      documentGeneration = result.documentGeneration;
      changed = true;
    }

    const nextActiveUrl = activeTab()?.url ?? (typeof result.url === 'string' ? result.url : '');
    const pageOrNavChanged =
      pageId !== prevPageId ||
      documentGeneration !== prevDocGen ||
      nextActiveUrl !== prevActiveUrl;

    if (pageOrNavChanged) {
      snapshotRefs.clear();
    }

    if (changed) {
      bumpRevision(invalidateFramesOnChange && pageOrNavChanged);
    }

    const nextHints = mergeProviderHints(result, pageOrNavChanged ? null : lastHints);
    if (typeof result.sensitiveReason === 'string' && result.sensitiveReason.trim() !== '') {
      providerSensitiveReason = result.sensitiveReason.trim();
    } else if (pageOrNavChanged) {
      providerSensitiveReason = null;
    }

    recomputeSensitivity({
      url: typeof result.url === 'string' ? result.url : undefined,
      title: typeof result.title === 'string' ? result.title : undefined,
      hints: nextHints !== null || pageOrNavChanged ? nextHints : undefined,
      providerSensitive: result.sensitive !== undefined ? result.sensitive : (pageOrNavChanged ? false : undefined),
    });
  }

  function grantLease(authority, displayLabelOverride = null, shared = false) {
    const issuedAt = now();
    const holderLabel = displayLabelOverride || authority.holderLabel;
    leaseGeneration += 1;
    lease = {
      token: randomToken(),
      clientId: authority.clientId,
      holderLabel,
      issuedAt,
      lastSeenAt: issuedAt,
      expiresAt: issuedAt + leaseTtlMs,
      shared,
    };
    lastHolderLabel = holderLabel;
    holdReason = null;
    phase = 'human';
    if (!shared) snapshotRefs.clear();
    bumpRevision(true);
    scheduleLeaseTimer();
    emit(shared ? 'shared_input_granted' : 'takeover_granted');
    return lease.token;
  }

  function renewLease(authority, leaseToken) {
    if (phase !== 'human' || !lease) return false;
    if (lease.clientId !== authority.clientId) return false;
    if (!tokensEqual(leaseToken, lease.token)) return false;
    const t = now();
    if (t > lease.expiresAt) {
      expireLeaseIfNeeded();
      return false;
    }
    lease.lastSeenAt = t;
    lease.expiresAt = t + leaseTtlMs;
    scheduleLeaseTimer();
    return true;
  }

  function verifyHumanLease({ authority, leaseToken, renew = true }) {
    expireLeaseIfNeeded();
    if (closed) throw browserError('BROWSER_CLOSED');
    if (phase === 'taking') {
      throw browserError('BROWSER_TAKEOVER_PENDING', undefined, { phase, holderLabel: currentHolderLabel() });
    }
    if (phase === 'held') {
      if (holdReason === 'disconnected_hold') {
        throw browserError('BROWSER_LEASE_EXPIRED', undefined, {
          phase,
          reason: holdReason,
          holderLabel: lastHolderLabel,
        });
      }
      throw browserError('BROWSER_TAKEOVER_REQUIRED', undefined, {
        phase,
        reason: holdReason,
        holderLabel: lastHolderLabel,
      });
    }
    if (phase !== 'human' || !lease) {
      throw browserError('BROWSER_TAKEOVER_REQUIRED', undefined, { phase });
    }
    if (lease.clientId !== authority.clientId) {
      throw browserError('BROWSER_LEASE_CONFLICT', undefined, {
        phase,
        holderLabel: lease.holderLabel,
      });
    }
    if (!tokensEqual(leaseToken, lease.token)) {
      throw browserError('BROWSER_LEASE_EXPIRED', 'Human lease token is invalid or superseded.', {
        phase,
        holderLabel: lease.holderLabel,
      });
    }
    if (renew) {
      const t = now();
      lease.lastSeenAt = t;
      lease.expiresAt = t + leaseTtlMs;
      scheduleLeaseTimer();
    }
    return true;
  }

  function beginSharedInput({ authority, leaseToken, preempt = false, holderLabelOverride }) {
    expireLeaseIfNeeded();
    if (closed) throw browserError('BROWSER_CLOSED');
    if (phase === 'taking') throw browserError('BROWSER_TAKEOVER_PENDING');
    if (phase === 'held' || sensitivity.sensitive) {
      throw browserError('BROWSER_TAKEOVER_REQUIRED', undefined, { phase, reason: currentReason() });
    }
    if (!available || !canStreamInteract) throw browserError('BROWSER_STREAM_UNAVAILABLE');
    if (!pageId) throw browserError('BROWSER_PAGE_NOT_FOUND');

    if (phase === 'human') {
      const sameClient = lease?.clientId === authority.clientId;
      if (lease?.shared && sameClient && tokensEqual(leaseToken, lease.token) && !preempt) {
        renewLease(authority, leaseToken);
        return lease.token;
      }
      // Reopening the pane on the same authenticated client rotates its shared token.
      if (!lease?.shared || (!preempt && !(sameClient && leaseToken == null))) {
        throw browserError('BROWSER_LEASE_CONFLICT', undefined, { phase, holderLabel: currentHolderLabel() });
      }
    }
    return grantLease(authority, holderLabelOverride, true);
  }

  /**
   * Exclusive takeover verifies any existing lease before replacing it. Bot work
   * drains before granting exclusive input, including when input was previously shared.
   */
  async function beginTakeover({
    authority,
    leaseToken = null,
    force = false,
    preempt = false,
    holderLabelOverride = null,
    onTakeoverHook = null,
  }) {
    expireLeaseIfNeeded();
    if (closed) throw browserError('BROWSER_CLOSED');

    const wantPreempt = force === true || preempt === true;
    const desiredLabel = holderLabelOverride || authority.holderLabel;

    // Already in human control: handle same-client renewal vs cross-client/unverified preemption.
    if (phase === 'human' && lease) {
      const verifiedHolder = lease.clientId === authority.clientId && tokensEqual(leaseToken, lease.token);
      if (!verifiedHolder && !wantPreempt) {
        throw browserError(
          'BROWSER_LEASE_CONFLICT',
          `Browser is currently controlled by ${lease.holderLabel}. Confirm preemption to take control here.`,
          { phase: 'human', holderLabel: lease.holderLabel }
        );
      }
      if (!lease.shared) {
        if (!wantPreempt) {
          renewLease(authority, leaseToken);
          return { token: lease.token, preempted: false, resumed: true };
        }
        const token = grantLease(authority, desiredLabel);
        if (!verifiedHolder) emit('takeover_preempted');
        return { token, preempted: !verifiedHolder, resumed: verifiedHolder };
      }
    }

    // Already draining a takeover.
    if (phase === 'taking' && takingState) {
      if (takingState.clientId !== authority.clientId) {
        if (!wantPreempt) {
          throw browserError('BROWSER_TAKEOVER_PENDING', undefined, {
            phase: 'taking',
            holderLabel: takingState.holderLabel,
          });
        }
        takingState.clientId = authority.clientId;
        takingState.holderLabel = desiredLabel;
      }
      await takingState.promise;
      if (closed) throw browserError('BROWSER_CLOSED');
      if (phase === 'human' && lease && lease.clientId === authority.clientId) {
        return { token: lease.token, preempted: wantPreempt, resumed: false };
      }
      throw browserError('BROWSER_TAKEOVER_UNCONFIRMED', undefined, { phase, reason: currentReason() });
    }

    // Move into exclusive takeover and fence both the active bot operation and any shared lease.
    const prevPhase = phase;
    phase = 'taking';
    holdReason = null;
    clearLeaseTimer();
    lease = null;
    snapshotRefs.clear();
    bumpRevision(true);
    emit('takeover_starting');

    cancelQueuedBotOps('takeover_requested');
    const inFlightDone = abortInFlightBotOp('takeover_requested');

    const activeTaking = {
      clientId: authority.clientId,
      holderLabel: desiredLabel,
      promise: null,
    };

    const drainPromise = (async () => {
      const waitTargets = [];
      if (inFlightDone) waitTargets.push(confirmSettlement(inFlightDone));
      if (typeof onTakeoverHook === 'function') {
        waitTargets.push(Promise.resolve().then(() => onTakeoverHook({
          botId,
          sessionId,
          pageId,
          reason: prevPhase === 'held' ? 'resume_hold' : 'takeover',
        })));
      }

      if (waitTargets.length > 0) {
        let timer = null;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(browserError('BROWSER_TAKEOVER_UNCONFIRMED'));
            }, takeoverTimeoutMs);
            timer.unref?.();
          });
          await Promise.race([Promise.all(waitTargets), timeoutPromise]);
        } catch (err) {
          if (!closed) {
            phase = 'held';
            holdReason = 'takeover_unconfirmed';
            lease = null;
            bumpRevision(true);
            emit('takeover_unconfirmed');
          }
          if (err?.code === 'BROWSER_TAKEOVER_UNCONFIRMED') throw err;
          throw browserError('BROWSER_TAKEOVER_UNCONFIRMED', undefined, { phase: 'held', reason: 'takeover_unconfirmed' });
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }

      if (closed) throw browserError('BROWSER_CLOSED');
      if (inFlightBotOp !== null) {
        phase = 'held';
        holdReason = 'takeover_unconfirmed';
        lease = null;
        bumpRevision(true);
        throw browserError('BROWSER_TAKEOVER_UNCONFIRMED');
      }

      // Confirmed settled: open human control with fresh random lease.
      const winnerAuthority = {
        clientId: activeTaking.clientId,
        holderLabel: activeTaking.holderLabel,
      };
      grantLease(winnerAuthority, activeTaking.holderLabel);
    })();

    activeTaking.promise = drainPromise;
    takingState = activeTaking;

    try {
      await drainPromise;
    } finally {
      if (takingState === activeTaking) takingState = null;
    }

    if (!lease || lease.clientId !== authority.clientId) {
      throw browserError('BROWSER_LEASE_CONFLICT', undefined, {
        phase,
        holderLabel: currentHolderLabel(),
      });
    }
    return { token: lease.token, preempted: false, resumed: prevPhase === 'held' };
  }

  async function holdForSystemLock({ reason = 'sensitive_step_lock', onTakeoverHook = null } = {}) {
    expireLeaseIfNeeded();
    if (closed) throw browserError('BROWSER_CLOSED');
    if (phase === 'human' && !lease?.shared) {
      // Human owner already holds control; keep human lease intact and clear bot refs.
      snapshotRefs.clear();
      return { held: false, phase };
    }
    phase = 'taking';
    holdReason = null;
    clearLeaseTimer();
    lease = null;
    snapshotRefs.clear();
    bumpRevision(true);
    cancelQueuedBotOps(reason);
    const inFlightDone = abortInFlightBotOp(reason);
    const waitTargets = [];
    if (inFlightDone) waitTargets.push(confirmSettlement(inFlightDone));
    if (typeof onTakeoverHook === 'function') {
      waitTargets.push(Promise.resolve().then(() => onTakeoverHook({
        botId,
        sessionId,
        pageId,
        reason,
      })));
    }
    if (waitTargets.length > 0) {
      let timer = null;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(browserError('BROWSER_TAKEOVER_UNCONFIRMED')), takeoverTimeoutMs);
          timer.unref?.();
        });
        await Promise.race([Promise.all(waitTargets), timeoutPromise]);
      } catch (err) {
        if (!closed) {
          phase = 'held';
          holdReason = 'takeover_unconfirmed';
          bumpRevision(true);
        }
        throw err;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }
    if (!closed) {
      phase = 'held';
      holdReason = reason;
      bumpRevision(true);
      emit('held_for_sensitive', { reason });
    }
    return { held: true, phase };
  }

  function holdForSensitive({ reason = 'sensitive_page', guidance = null } = {}) {
    const wasShared = lease?.shared === true;
    expireLeaseIfNeeded();
    if (closed) return;
    snapshotRefs.clear();
    const enteringHold = phase === 'bot' || wasShared;
    if (enteringHold) {
      clearLeaseTimer();
      lease = null;
      phase = 'held';
      holdReason = reason;
      bumpRevision(true);
    }
    cancelQueuedBotOps(reason);
    if (wasShared) abortInFlightBotOp(reason);
    if (enteringHold) {
      emit('held_for_sensitive', { reason, guidance });
    } else if (phase === 'held' && holdReason !== reason) {
      holdReason = reason;
      bumpRevision(false);
    }
  }

  function handback({ authority, leaseToken = null, currentSensitivity = sensitivity }) {
    expireLeaseIfNeeded();
    if (closed) throw browserError('BROWSER_CLOSED');
    if (phase === 'taking' || inFlightBotOp !== null) {
      throw browserError('BROWSER_TAKEOVER_PENDING', undefined, { phase });
    }
    if (phase === 'human') {
      verifyHumanLease({ authority, leaseToken, renew: false });
    }
    if (currentSensitivity?.blockHandback) {
      throw browserError(
        'BROWSER_HANDBACK_BLOCKED_SENSITIVE',
        currentSensitivity.guidance || 'Cannot hand back while on a sensitive, login, MFA, policy, or secret page.',
        {
          phase,
          reason: currentSensitivity.reasons?.[0] ?? 'sensitive_page',
          fallbackToSystemBrowser: currentSensitivity.fallbackToSystemBrowser === true,
        }
      );
    }

    clearLeaseTimer();
    lease = null;
    lastHolderLabel = null;
    holdReason = null;
    snapshotRefs.clear();
    if (phase !== 'bot') {
      phase = 'bot';
      bumpRevision(true);
      emit('handed_back');
    }
    const tab = activeTab();
    return {
      botId,
      sessionId,
      pageId,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      revision,
    };
  }

  function recordFrame({ pageId: framePageId }) {
    lastFrameSeq += 1;
    lastFramePageId = framePageId ?? pageId;
    lastFrameRevision = revision;
    lastActivityAt = now();
    return {
      seq: lastFrameSeq,
      revision,
      pageId: lastFramePageId,
    };
  }

  function assertInputFreshness({ pageId: reqPageId, revision: reqRevision, frameSeq }) {
    if (!pageId || reqPageId !== pageId) {
      throw browserError('BROWSER_STALE_PAGE', undefined, { pageId, revision });
    }
    if (reqRevision !== revision) {
      throw browserError('BROWSER_STALE_REVISION', undefined, { pageId, revision });
    }
    if (frameSeq !== undefined) {
      if (
        frameSeq < minValidFrameSeq ||
        frameSeq > lastFrameSeq ||
        lastFramePageId !== pageId ||
        lastFrameRevision !== revision
      ) {
        throw browserError('BROWSER_STALE_FRAME', undefined, { pageId, revision });
      }
    }
  }

  function assertOwnsPage(targetPageId) {
    if (!targetPageId) return;
    if (!tabs.some((t) => t.id === targetPageId)) {
      throw browserError('BROWSER_PAGE_NOT_FOUND', undefined, { pageId: targetPageId });
    }
  }

  function resetAfterRelease() {
    clearLeaseTimer();
    cancelQueuedBotOps('released');
    abortInFlightBotOp('released');
    lease = null;
    lastHolderLabel = null;
    holdReason = null;
    sessionId = null;
    pageId = null;
    documentGeneration = null;
    tabs = [];
    lastHints = null;
    lastProviderSensitive = false;
    providerSensitiveReason = null;
    sensitivity = defaultSensitivity();
    snapshotRefs.clear();
    phase = 'bot';
    bumpRevision(true);
    emit('released');
  }

  function markClosed() {
    if (closed) return;
    closed = true;
    clearLeaseTimer();
    cancelQueuedBotOps('closed');
    abortInFlightBotOp('closed');
    lease = null;
    snapshotRefs.clear();
  }

  function isActiveLeaseHolder(authority, leaseToken = null) {
    expireLeaseIfNeeded();
    if (phase !== 'human' || !lease) return false;
    if (lease.clientId !== authority.clientId) return false;
    if (leaseToken !== null && leaseToken !== undefined) {
      return tokensEqual(leaseToken, lease.token);
    }
    return true;
  }

  return {
    get botId() { return botId; },
    get profileDir() { return profileDir; },
    get sessionId() { return sessionId; },
    get phase() { return phase; },
    get sharedInput() { return lease?.shared === true; },
    get canBotOperate() { return canBotOperate(); },
    get revision() { return revision; },
    get available() { return available; },
    get reason() { return currentReason(); },
    get canStreamInteract() { return canStreamInteract; },
    get capabilities() { return capabilities; },
    get pageId() { return pageId; },
    get documentGeneration() { return documentGeneration; },
    get tabs() { return tabs; },
    get lastHints() { return lastHints; },
    get lastProviderSensitive() { return lastProviderSensitive; },
    get providerSensitiveReason() { return providerSensitiveReason; },
    get sensitivity() { return sensitivity; },
    get holderLabel() { return currentHolderLabel(); },
    get lastActivityAt() { return lastActivityAt; },
    get hasActiveSession() { return sessionId !== null || tabs.length > 0; },
    get hasInFlightBotOp() { return inFlightBotOp !== null; },
    get queuedBotOpCount() { return botQueue.length; },
    get closed() { return closed; },

    activeTab,
    expireLeaseIfNeeded,
    enqueueBotOp,
    syncProviderResult,
    recomputeSensitivity,
    beginSharedInput,
    beginTakeover,
    holdForSystemLock,
    holdForSensitive,
    handback,
    verifyHumanLease,
    renewLease,
    isActiveLeaseHolder,
    get leaseGeneration() { return leaseGeneration; },
    recordFrame,
    assertInputFreshness,
    assertOwnsPage,
    resetAfterRelease,
    markClosed,

    setSnapshotRefs(refMap) {
      snapshotRefs = refMap instanceof Map ? new Map(refMap) : new Map();
    },
    getSnapshotRef(ref) {
      return snapshotRefs.get(ref) ?? null;
    },
    clearSnapshotRefs() {
      snapshotRefs.clear();
    },
    setUnavailable(reasonText) {
      available = false;
      canStreamInteract = false;
      unavailableReason = typeof reasonText === 'string' && reasonText.trim() !== ''
        ? reasonText.trim()
        : 'browser_provider_unavailable';
    },
    ensureSessionId() {
      if (!sessionId) {
        sessionId = `browser-${randomUUID()}`;
      }
      return sessionId;
    },
    currentLeaseTokenFor(authority, presentedToken) {
      if (phase !== 'human' || !lease) return undefined;
      if (lease.clientId !== authority.clientId) return undefined;
      if (presentedToken && tokensEqual(presentedToken, lease.token)) {
        return lease.token;
      }
      return undefined;
    },
  };
}
