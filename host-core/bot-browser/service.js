// host-core/bot-browser/service.js
// Core Bot Browser service: per-bot isolated sessions & profiles, single-writer human takeover
// lease with real bot queue drain & in-flight confirmation, fail-closed disconnect hold,
// Privacy Shield sensitive-step isolation, and dual-lane control() vs toolsForBot() dispatch.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertId } from '../message-protocol.js';
import {
  BROWSER_DEFAULT_IDLE_CLOSE_MS,
  BROWSER_DEFAULT_LEASE_TTL_MS,
  BROWSER_DEFAULT_TAKEOVER_TIMEOUT_MS,
  BROWSER_MAX_ACTIVE_SESSIONS,
  BROWSER_MAX_FRAME_BASE64_BYTES,
  BROWSER_MAX_TABS_PER_BOT,
  botBrowserProfileDirectory,
  browserError,
  isPlainObject,
  hasWaitCondition,
  normalizeBotActInput,
  normalizeBotSnapshotOptions,
  normalizeControlAuthority,
  normalizeControlInput,
  normalizePageId,
  safeBrowserError,
  validateFramePayload,
} from './protocol.js';
import {
  checkBotActionSensitivity,
  classifyPageSensitivity,
  mergeProviderHints,
  sanitizeSnapshotForBot,
  sanitizeTabsForCaller,
  sanitizeUrlForModel,
  validateNavigationUrl,
} from './policy.js';
import { createBotBrowserState } from './state.js';
import { createBotBrowserTools } from './tools.js';
import { normalizeNativeBrowserControl } from './native-control.js';
import { createClientBrowserRenderer } from './client-renderer.js';

function combineSignals(a, b) {
  if (a && b) return AbortSignal.any([a, b]);
  return a || b || undefined;
}

function clampPositiveNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function assertProviderShape(provider) {
  if (!isPlainObject(provider) || typeof provider.perform !== 'function' || typeof provider.close !== 'function') {
    throw browserError('BROWSER_BACKEND_FAILED', 'Browser provider must export perform(input) and close()');
  }
  return provider;
}

const PROVIDER_ERROR_CODE_MAP = Object.freeze({
  BROWSER_SECRET_FRAME_BLOCKED: 'BROWSER_SECRET_STEP_BLOCKED',
  BROWSER_SECRET_INPUT_BLOCKED: 'BROWSER_SECRET_STEP_BLOCKED',
  BROWSER_SENSITIVE_PAGE: 'BROWSER_SENSITIVE_BLOCKED',
  BROWSER_HUMAN_REQUIRED: 'BROWSER_SENSITIVE_BLOCKED',
  BROWSER_AUTH_USE_SYSTEM_BROWSER: 'BROWSER_SENSITIVE_BLOCKED',
  BROWSER_STALE_DOCUMENT: 'BROWSER_STALE_PAGE',
  BROWSER_PAGE_MISMATCH: 'BROWSER_STALE_PAGE',
  BROWSER_TAB_NOT_FOUND: 'BROWSER_PAGE_NOT_FOUND',
  BROWSER_NO_TAB: 'BROWSER_PAGE_NOT_FOUND',
  BROWSER_TAB_LIMIT_REACHED: 'BROWSER_TAB_LIMIT',
  BROWSER_ACTION_FORBIDDEN: 'BROWSER_ACTION_BLOCKED',
  BROWSER_ACTION_UNSUPPORTED: 'BROWSER_UNSUPPORTED',
});

function mapProviderError(err, state = null, { holdBotOnSensitive = false } = {}) {
  if (!err || typeof err !== 'object') {
    return browserError('BROWSER_BACKEND_FAILED');
  }
  const mappedCode = typeof err.code === 'string' && Object.hasOwn(PROVIDER_ERROR_CODE_MAP, err.code)
    ? PROVIDER_ERROR_CODE_MAP[err.code]
    : err.code;
  const fallbackToSystemBrowser =
    err.authUseSystemBrowser === true ||
    err.requiresSystemBrowser === true ||
    mappedCode === 'BROWSER_SECRET_STEP_BLOCKED';
  if (
    holdBotOnSensitive &&
    state &&
    (mappedCode === 'BROWSER_SENSITIVE_BLOCKED' || mappedCode === 'BROWSER_SECRET_STEP_BLOCKED')
  ) {
    state.holdForSensitive({
      reason: err.sensitiveCategory || err.sensitiveReason || 'sensitive_page',
      guidance: err.message || null,
    });
  }
  const mapped = browserError(
    mappedCode || 'BROWSER_BACKEND_FAILED',
    err.message,
    {
      ...(state ? { phase: state.phase, revision: state.revision, pageId: state.pageId } : {}),
      ...(err.sensitiveCategory ? { reason: err.sensitiveCategory } : {}),
      ...(fallbackToSystemBrowser ? { fallbackToSystemBrowser: true } : {}),
    }
  );
  if (err.outcome === 'not-sent' || err.outcome === 'unconfirmed') {
    mapped.outcome = err.outcome;
  }
  return mapped;
}

/**
 * Formats normalized bot act so BOTH desktop-provider (`input.command`, scroll `direction`/`amount`,
 * wait `timeoutMs`) and android-provider (`input.act`, scroll `deltaX`/`deltaY`, wait `ms`) accept it.
 */
function formatProviderAct(normalizedAct) {
  if (normalizedAct.kind === 'scroll') {
    const amount = Math.min(2000, Math.max(50, normalizedAct.amount ?? 400));
    const deltaX = normalizedAct.direction === 'right' ? amount : (normalizedAct.direction === 'left' ? -amount : 0);
    const deltaY = normalizedAct.direction === 'down' ? amount : (normalizedAct.direction === 'up' ? -amount : 0);
    return { ...normalizedAct, amount, deltaX, deltaY };
  }
  if (normalizedAct.kind === 'wait') {
    const timeoutMs = normalizedAct.timeoutMs ?? (hasWaitCondition(normalizedAct) ? 5_000 : 500);
    return { ...normalizedAct, timeoutMs, ms: timeoutMs };
  }
  return { ...normalizedAct };
}

/**
 * Formats normalized human input event so BOTH desktop-provider (`clickCount`, `modifiers`)
 * and android-provider (`count`, `x`/`y`) accept it cleanly.
 */
function formatProviderInputEvent(event) {
  if (event.kind === 'click' && event.count !== undefined) {
    return { ...event, clickCount: event.count };
  }
  return { ...event };
}

export function createBotBrowserService(options = {}) {
  const host = options.host;
  if (!host || typeof host.deviceId !== 'string' || typeof host.getBot !== 'function') {
    throw browserError('INVALID_ARGUMENT', 'createBotBrowserService requires options.host with deviceId and getBot()');
  }
  const configuredProfileRoot =
    (typeof options.profileRoot === 'string' && options.profileRoot.trim() !== '')
      ? options.profileRoot.trim()
      : (typeof options.profilesRoot === 'string' && options.profilesRoot.trim() !== '')
        ? options.profilesRoot.trim()
        : null;
  const profileRoot = configuredProfileRoot
    ?? (typeof host.dataRoot === 'string' && host.dataRoot.trim() !== ''
      ? join(host.dataRoot, 'bot-browser', 'profiles')
      : null);
  if (!profileRoot) {
    throw browserError('INVALID_ARGUMENT', 'createBotBrowserService requires host.dataRoot or options.profileRoot');
  }

  const getHarness = typeof options.getHarness === 'function' ? options.getHarness : null;
  const resolveConversationBot = typeof options.resolveConversationBot === 'function'
    ? options.resolveConversationBot
    : null;
  const resolveIdentity = typeof options.resolveIdentity === 'function' ? options.resolveIdentity : null;
  const resolveWorkContext = typeof options.resolveWorkContext === 'function' ? options.resolveWorkContext : null;
  const customProviderFactory = typeof options.createProvider === 'function'
    ? options.createProvider
    : (typeof options.providerFactory === 'function' ? options.providerFactory : null);
  const nativeBridge = options.nativeBridge ?? null;
  const abortBotTurn = typeof options.abortBotTurn === 'function' ? options.abortBotTurn : null;
  const onTakeover = typeof options.onTakeover === 'function'
    ? options.onTakeover
    : (abortBotTurn ? async ({ botId }) => { await abortBotTurn(botId); } : null);
  const onHandback = typeof options.onHandback === 'function' ? options.onHandback : null;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const isMaintenance = typeof options.isMaintenance === 'function' ? options.isMaintenance : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const randomToken = typeof options.randomToken === 'function' ? options.randomToken : undefined;

  const leaseTtlMs = clampPositiveNumber(options.leaseTtlMs, BROWSER_DEFAULT_LEASE_TTL_MS, 50, 120_000);
  const takeoverTimeoutMs = clampPositiveNumber(options.takeoverTimeoutMs, BROWSER_DEFAULT_TAKEOVER_TIMEOUT_MS, 20, 60_000);
  const maxActiveSessions = clampPositiveNumber(options.maxActiveSessions, BROWSER_MAX_ACTIVE_SESSIONS, 1, 64);
  const maxTabsPerBot = clampPositiveNumber(options.maxTabsPerBot, BROWSER_MAX_TABS_PER_BOT, 1, 32);
  const maxFrameBase64Bytes = clampPositiveNumber(
    options.maxFrameBase64Bytes,
    BROWSER_MAX_FRAME_BASE64_BYTES,
    1024,
    BROWSER_MAX_FRAME_BASE64_BYTES
  );
  const idleCloseMs = clampPositiveNumber(options.idleCloseMs, BROWSER_DEFAULT_IDLE_CLOSE_MS, 1000, 24 * 60 * 60_000);

  let withheldPredicate = typeof options.isPageWithheld === 'function' ? options.isPageWithheld : null;
  const checkWithheld = (page) => (withheldPredicate ? Boolean(withheldPredicate(page)) : false);

  /** @type {Map<string, { state: ReturnType<typeof createBotBrowserState>, provider: any, providerPromise: Promise<any> | null }>} */
  const entries = new Map();
  let closed = false;
  let closePromise = null;

  function assertNotClosedOrMaintenance() {
    if (closed) throw browserError('BROWSER_CLOSED');
    if (isMaintenance?.()) throw browserError('RUNTIME_BUSY');
  }

  function assertLocalBot(botId) {
    assertId(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) {
      throw browserError('BOT_NOT_FOUND', `Bot not found on this host: ${botId}`);
    }
    return bot;
  }

  function getOrCreateEntry(botId) {
    let entry = entries.get(botId);
    if (entry) return entry;
    const profileDir = botBrowserProfileDirectory(profileRoot, botId);
    const state = createBotBrowserState({
      botId,
      profileDir,
      now,
      randomToken,
      leaseTtlMs,
      takeoverTimeoutMs,
      maxTabsPerBot,
      isPageWithheld: checkWithheld,
      onPageUrl: options.onPageUrl,
      onEvent(event) {
        const grant = entry?.presentation;
        if (grant && (state.leaseGeneration !== grant.generation || event.pageId !== grant.pageId ||
            event.phase !== 'human' || state.sensitivity.blockNormalFrame)) {
          void dismissPresentation(entry).catch(() => {});
        }
        onEvent?.(event);
      },
    });
    entry = {
      state, provider: null, providerPromise: null, streamCaptures: new Map(),
      renderer: null, presentation: null, dismissing: null, presentationChanges: 0, opening: 0, closing: false,
    };
    entries.set(botId, entry);
    return entry;
  }

  async function loadDefaultProviderFactory() {
    if (nativeBridge) {
      const mod = await import('./android-provider.js');
      if (typeof mod.createAndroidBrowserProvider !== 'function') {
        throw browserError('BROWSER_UNAVAILABLE', 'Android browser provider is unavailable.');
      }
      return (opts) => mod.createAndroidBrowserProvider(opts);
    }
    const mod = await import('./desktop-provider.js');
    if (typeof mod.createDesktopBrowserProvider !== 'function') {
      throw browserError('BROWSER_UNAVAILABLE', 'Desktop browser provider is unavailable.');
    }
    return (opts) => mod.createDesktopBrowserProvider(opts);
  }

  async function ensureProvider(entry, { allowUnavailable = false } = {}) {
    if (closed || entry.closing) throw browserError('BROWSER_CLOSED');
    if (entry.provider) return entry.provider;
    if (entry.providerPromise) {
      const existing = await entry.providerPromise;
      if (existing || allowUnavailable) return existing;
      throw browserError('BROWSER_UNAVAILABLE', entry.state.reason || 'Bot browser provider is unavailable.');
    }

    entry.providerPromise = (async () => {
      try {
        const factory = customProviderFactory ?? (await loadDefaultProviderFactory());
        const provider = assertProviderShape(await factory({
          botId: entry.state.botId,
          profileDir: entry.state.profileDir,
          maxTabs: maxTabsPerBot,
          deviceId: host.deviceId,
          ...(nativeBridge ? { nativeBridge } : {}),
        }));
        if (closed) {
          await provider.close().catch(() => {});
          return null;
        }
        entry.provider = provider;
        return provider;
      } catch (err) {
        const reason = err?.message || 'browser_provider_unavailable';
        entry.state.setUnavailable(reason);
        if (allowUnavailable) return null;
        if (err?.code === 'BROWSER_UNAVAILABLE' || err?.code === 'BROWSER_UNSUPPORTED') throw err;
        throw browserError('BROWSER_UNAVAILABLE', reason);
      } finally {
        entry.providerPromise = null;
      }
    })();

    return entry.providerPromise;
  }

  async function closeEntryProvider(entry) {
    const provider = entry.provider;
    if (!provider) return;
    entry.closing = true;
    try {
      // Renderer replies remain routable while an attached client closes its tabs.
      if (!entry.renderer || (!closed && entries.get(entry.state.botId) === entry)) {
        await dismissPresentation(entry);
        await provider.perform({ action: 'release', botId: entry.state.botId }).catch(() => {});
      }
    } finally {
      entry.provider = null;
      entry.renderer = null;
      entry.presentation = null;
      try { await provider.close(); } finally { entry.closing = false; }
    }
  }

  async function reclaimIdleBotSessionsIfNeeded(targetBotId) {
    const activeEntries = [...entries.values()].filter((e) => e.state.hasActiveSession);
    if (activeEntries.length < maxActiveSessions) return;

    const currentTime = now();
    const candidates = activeEntries
      .filter((e) =>
        e.state.botId !== targetBotId &&
        e.state.phase === 'bot' &&
        !e.state.hasInFlightBotOp &&
        e.state.queuedBotOpCount === 0 &&
        currentTime - e.state.lastActivityAt >= idleCloseMs
      )
      .sort((a, b) => a.state.lastActivityAt - b.state.lastActivityAt);

    let activeCount = activeEntries.length;
    for (const candidate of candidates) {
      if (activeCount < maxActiveSessions) break;
      try {
        await closeEntryProvider(candidate);
        candidate.state.resetAfterRelease();
        activeCount -= 1;
      } catch {
        // Continue trying remaining idle candidates.
      }
    }
    if (activeCount >= maxActiveSessions) {
      throw browserError(
        'BROWSER_SESSION_LIMIT',
        `Active bot browser session limit (${maxActiveSessions}) reached on this host.`
      );
    }
  }

  async function refreshProviderStatus(entry, { allowUnavailable = true, pageId = undefined, signal = undefined } = {}) {
    const provider = await ensureProvider(entry, { allowUnavailable });
    if (!provider) return null;
    try {
      const res = await provider.perform({
        action: 'status',
        botId: entry.state.botId,
        ...(pageId ? { pageId } : {}),
        ...(signal ? { signal } : {}),
      });
      if (entry.provider !== provider) return null;
      entry.state.syncProviderResult(res);
      return res;
    } catch (err) {
      if (entry.provider !== provider) return null;
      if (allowUnavailable) {
        entry.state.setUnavailable(err?.message || 'browser_provider_unavailable');
        return null;
      }
      throw err;
    }
  }

  function buildControlViewDto(state, authority, { includeLeaseToken = false, presentedLease = null } = {}) {
    state.expireLeaseIfNeeded();
    const isLeaseHolder = state.isActiveLeaseHolder(authority, presentedLease);
    const leaseToken = includeLeaseToken
      ? state.currentLeaseTokenFor(authority, presentedLease)
      : undefined;

    const tabs = sanitizeTabsForCaller(state.tabs, {
      canViewSensitive: authority.canViewSensitive && (isLeaseHolder || state.phase === 'held'),
      isPageWithheld: checkWithheld,
      botId: state.botId,
      restrictedPageId: state.sensitivity.blockBystanderFrame ? state.pageId : null,
    });

    const sensitiveReason = state.sensitivity.sensitive
      ? (state.sensitivity.guidance || state.providerSensitiveReason || state.sensitivity.reasons[0] || undefined)
      : undefined;
    const attentionRequested = state.phase === 'held';
    const entry = entries.get(state.botId);
    const localRenderer = entry?.renderer?.clientId === authority.clientId;
    const attentionMessage = attentionRequested
      ? (state.sensitivity.guidance || state.providerSensitiveReason || state.reason || undefined)
      : undefined;

    const dto = {
      available: state.available,
      ...(state.reason ? { reason: state.reason } : {}),
      canStreamInteract: state.canStreamInteract,
      ...(authority.canControl && authority.role !== 'system' ? { supportsSharedInput: true } : {}),
      ...(state.sharedInput ? { sharedInput: true } : {}),
      ...(entry?.renderer ? { renderPlacement: 'client' } : {}),
      ...(localRenderer ? { rendererId: entry.renderer.rendererId, nativePresentation: true } : {}),
      ...(entry?.provider?.nativePresentation && authority.transport === 'local' ? { nativePresentation: true } : {}),
      canIsolateSensitivePages: state.capabilities.privateSecretIsolation,
      phase: state.phase,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.pageId ? { pageId: state.pageId } : {}),
      revision: state.revision,
      tabs,
      ...(state.holderLabel ? { holderLabel: state.holderLabel } : {}),
      ...(includeLeaseToken && leaseToken ? { lease: leaseToken } : {}),
      isHolder: isLeaseHolder,
      isLeaseHolder,
      sensitive: state.sensitivity.sensitive,
      ...(sensitiveReason ? { sensitiveReason } : {}),
      ...(attentionRequested ? { attentionRequested: true } : {}),
      ...(attentionMessage ? { attentionMessage } : {}),
      secretRisk: state.sensitivity.secretRisk,
      webLoginNotApiGrant: state.sensitivity.webLoginNotApiGrant,
      fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
      ...(state.sensitivity.guidance ? { guidance: state.sensitivity.guidance } : {}),
    };
    return dto;
  }

  function buildBotStatusDto(state) {
    state.expireLeaseIfNeeded();
    const tabs = sanitizeTabsForCaller(state.tabs, {
      isBot: true,
      isPageWithheld: checkWithheld,
      botId: state.botId,
      restrictedPageId: state.sensitivity.blockBotObserve ? state.pageId : null,
    });
    return {
      available: state.available,
      ...(state.reason ? { reason: state.reason } : {}),
      canStreamInteract: state.canStreamInteract,
      phase: state.phase,
      pausedForHuman: !state.canBotOperate,
      ...(state.sharedInput ? { sharedInput: true } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.pageId ? { pageId: state.pageId } : {}),
      revision: state.revision,
      tabs,
      sensitive: state.sensitivity.sensitive,
      secretRisk: state.sensitivity.secretRisk,
      webLoginNotApiGrant: state.sensitivity.webLoginNotApiGrant,
      fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
      ...(state.sensitivity.guidance ? { guidance: state.sensitivity.guidance } : {}),
    };
  }

  function assertControlMutationAllowed(state, authority, req) {
    if (!authority.canControl) {
      throw browserError('BROWSER_FORBIDDEN', 'Read-only viewer cannot mutate bot browser state.');
    }
    state.expireLeaseIfNeeded();
    if (state.phase === 'taking') {
      throw browserError('BROWSER_TAKEOVER_PENDING', undefined, {
        phase: state.phase,
        holderLabel: state.holderLabel,
      });
    }
    if (state.phase === 'held') {
      throw browserError(
        state.reason === 'disconnected_hold' ? 'BROWSER_LEASE_EXPIRED' : 'BROWSER_TAKEOVER_REQUIRED',
        undefined,
        { phase: state.phase, reason: state.reason, holderLabel: state.holderLabel }
      );
    }
    if (state.phase === 'human') {
      state.verifyHumanLease({ authority, leaseToken: req.lease, renew: true });
    } else if (state.phase === 'bot' && state.hasInFlightBotOp) {
      throw browserError(
        'BROWSER_TAKEOVER_REQUIRED',
        'Take over the page before sending manual navigation while the bot is actively operating.',
        { phase: state.phase }
      );
    }
    if (req.revision !== undefined && req.revision !== state.revision) {
      throw browserError('BROWSER_STALE_REVISION', undefined, {
        pageId: state.pageId,
        revision: state.revision,
      });
    }
  }

  /**
   * Trusted owner/viewer control RPC entry point (browserControl).
   * Volatile only: never logs frame bytes, input text, secrets, or lease tokens.
   */
  async function dismissPresentation(entry) {
    if (entry.dismissing) return entry.dismissing;
    const grant = entry.presentation;
    if (!grant) return;
    entry.presentation = null;
    entry.dismissing = (async () => {
      try {
        if (grant.renderer) await grant.renderer.hide(grant.pageId);
        else await grant.provider.perform({ action: 'nativeRevoke', grantId: grant.id });
      } catch {
        // The presenter enforces its own deadline even if the link is lost.
        const remaining = grant.expiresAt + 1_000 - Date.now();
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      }
    })().finally(() => { entry.dismissing = null; });
    return entry.dismissing;
  }

  async function changePresentationOwner(entry, change) {
    entry.presentationChanges += 1;
    try {
      await dismissPresentation(entry);
      return await change();
    } finally {
      entry.presentationChanges -= 1;
    }
  }

  async function controlNative(entry, req, auth) {
    const { state } = entry;
    if (!auth.canControl || auth.transport === 'system') throw browserError('BROWSER_FORBIDDEN');
    const renderer = entry.renderer;
    if (req.action === 'rendererAttach') {
      if (entry.closing) return { accepted: false };
      if (renderer?.clientId === auth.clientId && renderer.rendererId === req.rendererId) {
        return { accepted: true, rendererId: renderer.rendererId };
      }
      if (state.hasInFlightBotOp || state.queuedBotOpCount || entry.opening || entry.providerPromise ||
          entry.presentationChanges || entry.dismissing || renderer?.online()) return { accepted: false };

      const occupied = state.hasActiveSession || renderer?.hasTabs();
      const replaceExpired = occupied && renderer?.clientId === auth.clientId && entry.provider === renderer &&
        !state.sensitivity.sensitive && (state.phase === 'bot' || (state.sharedInput && state.isActiveLeaseHolder(auth)));
      if (occupied && !replaceExpired) return { accepted: false };

      const previous = entry.provider;
      const replacement = createClientBrowserRenderer({
        rendererId: req.rendererId, clientId: auth.clientId, maxTabs: maxTabsPerBot, maxFrameBytes: maxFrameBase64Bytes,
      });
      // Revoke the old presentation while fencing its renderer and tab IDs in this turn.
      if (replaceExpired) void dismissPresentation(entry).catch(() => {});
      entry.renderer = replacement;
      entry.provider = replacement;
      if (previous) void previous.close().catch(() => {});
      if (replaceExpired) state.resetAfterRelease();
      return { accepted: true, rendererId: req.rendererId };
    }
    if (req.action === 'nativeGrant' || req.action === 'nativeDismiss') {
      if (req.action === 'nativeGrant' && (entry.closing || entry.presentationChanges || entry.dismissing)) {
        throw browserError('BROWSER_TAKEOVER_PENDING');
      }
      state.verifyHumanLease({ authority: auth, leaseToken: req.lease, renew: req.action === 'nativeGrant' });
      if (state.pageId !== req.pageId) throw browserError('BROWSER_STALE_PAGE');
      if (req.action === 'nativeDismiss') {
        await dismissPresentation(entry);
        return { ok: true };
      }
      const provider = entry.provider;
      if ((!renderer || renderer.clientId !== auth.clientId) && !(provider?.nativePresentation && auth.transport === 'local')) {
        return { supported: false };
      }
      if (state.sensitivity.blockNormalFrame) throw browserError('BROWSER_SECRET_STEP_BLOCKED');
      const generation = state.leaseGeneration;
      const expiresAt = Date.now() + 4_000;
      const previous = entry.presentation;
      const id = previous?.generation === generation && previous.pageId === req.pageId ? previous.id : randomUUID();
      const grant = { id, pageId: req.pageId, generation, expiresAt, renderer, provider };
      entry.presentation = grant;
      if (!renderer) {
        try {
          const result = await provider.perform({ action: 'nativeGrant', pageId: req.pageId, grantId: id, expiresAt });
          if (result?.supported === false) {
            if (entry.presentation === grant) entry.presentation = null;
            return result;
          }
        } catch (error) {
          if (entry.presentation === grant) entry.presentation = null;
          throw error;
        }
      }
      if (entry.presentation !== grant || state.leaseGeneration !== generation || state.pageId !== req.pageId) {
        if (!renderer) await provider.perform({ action: 'nativeRevoke', grantId: id }).catch(() => {});
        throw browserError('BROWSER_LEASE_EXPIRED');
      }
      return { supported: true, grantId: id, expiresAt, ...(renderer ? { rendererId: renderer.rendererId } : {}) };
    }
    if (!renderer || renderer.rendererId !== req.rendererId || renderer.clientId !== auth.clientId) {
      throw browserError('BROWSER_FORBIDDEN');
    }
    switch (req.action) {
      case 'rendererNext': return renderer.next();
      case 'rendererReply': return renderer.reply(req);
      case 'rendererEgressAuthorize':
        return { allowed: renderer.online() && auth.transport === 'relay', allowedPorts: renderer.ports() };
      case 'rendererDetach':
        if (renderer.hasTabs() || entry.opening || state.hasInFlightBotOp) return { ok: false };
        await dismissPresentation(entry);
        if (entry.renderer !== renderer || entry.closing) return { ok: false };
        // The client closes its own tabs and proxy. Cancel outstanding Host
        // commands immediately and invalidate the old session and any lease.
        entry.provider = null;
        entry.renderer = null;
        const closing = renderer.close();
        state.resetAfterRelease();
        await closing;
        return { ok: true };
      default: throw browserError('INVALID_ARGUMENT');
    }
  }

  async function control(input, authority) {
    assertNotClosedOrMaintenance();
    const auth = normalizeControlAuthority(authority);
    const native = normalizeNativeBrowserControl(input, maxFrameBase64Bytes);
    const req = native ?? normalizeControlInput(input, maxFrameBase64Bytes);
    assertLocalBot(req.botId);

    if (req.scopeId !== undefined && resolveWorkContext) {
      await resolveWorkContext(req.botId, req.scopeId);
    }

    const entry = getOrCreateEntry(req.botId);
    const { state } = entry;
    state.expireLeaseIfNeeded();
    if (native) return controlNative(entry, req, auth);

    switch (req.action) {
      case 'status': {
        if (req.lease) {
          state.renewLease(auth, req.lease);
        }
        await refreshProviderStatus(entry, { allowUnavailable: true, pageId: req.pageId });
        return buildControlViewDto(state, auth, { includeLeaseToken: false, presentedLease: req.lease });
      }

      case 'takeover': {
        if (!auth.canControl) {
          throw browserError('BROWSER_FORBIDDEN', 'Only the owner or admin can take over the bot browser.');
        }
        if (auth.role === 'system') {
          await changePresentationOwner(entry, () => state.holdForSystemLock({
            reason: req.reason || 'sensitive_step_lock',
            onTakeoverHook: onTakeover,
          }));
          await refreshProviderStatus(entry, { allowUnavailable: true });
          return buildControlViewDto(state, auth, { includeLeaseToken: false });
        }
        if (req.shared) {
          const preempt = req.force === true || req.preempt === true;
          const replacesOwnLease = !req.lease && state.sharedInput && state.isActiveLeaseHolder(auth);
          const share = async () => {
            const latest = await refreshProviderStatus(entry, { allowUnavailable: true });
            if (!latest) throw browserError('BROWSER_STREAM_UNAVAILABLE');
            if (req.pageId && req.pageId !== state.pageId) throw browserError('BROWSER_STALE_PAGE');
            if (req.sessionId && req.sessionId !== state.sessionId) throw browserError('BROWSER_STALE_PAGE');
            return state.beginSharedInput({
              authority: auth,
              leaseToken: req.lease,
              preempt,
              holderLabelOverride: req.holderLabel,
            });
          };
          const token = preempt || replacesOwnLease ? await changePresentationOwner(entry, share) : await share();
          return buildControlViewDto(state, auth, { includeLeaseToken: true, presentedLease: token });
        }
        const take = () => state.beginTakeover({
          authority: auth,
          leaseToken: req.lease ?? null,
          force: req.force === true,
          preempt: req.preempt === true,
          holderLabelOverride: req.holderLabel ?? null,
          onTakeoverHook: onTakeover,
        });
        const result = req.force || req.preempt ? await changePresentationOwner(entry, take) : await take();
        // Sync current page/tabs WITHOUT reloading or creating a new tab.
        await refreshProviderStatus(entry, { allowUnavailable: true });
        return buildControlViewDto(state, auth, {
          includeLeaseToken: true,
          presentedLease: result.token,
        });
      }

      case 'handback': {
        if (!auth.canControl) {
          throw browserError('BROWSER_FORBIDDEN', 'Only the owner or admin can hand control back to the bot.');
        }
        if (req.revision !== undefined && req.revision !== state.revision) {
          throw browserError('BROWSER_STALE_REVISION', undefined, {
            pageId: state.pageId,
            revision: state.revision,
          });
        }
        // Refresh the page's access policy independently of who holds control.
        if (entry.provider) {
          await refreshProviderStatus(entry, { allowUnavailable: true, pageId: req.pageId });
        }
        if (entry.presentation) state.verifyHumanLease({ authority: auth, leaseToken: req.lease, renew: false });
        const giveBack = () => state.handback({ authority: auth, leaseToken: req.lease });
        const summary = entry.presentation || entry.dismissing
          ? await changePresentationOwner(entry, giveBack) : giveBack();
        if (onHandback) {
          try {
            await onHandback({
              ...summary,
              url: sanitizeUrlForModel(summary.url),
            });
          } catch {
            // Observer failure must not roll back committed handback.
          }
        }
        return buildControlViewDto(state, auth, { includeLeaseToken: false });
      }

      case 'release': {
        if (!auth.canControl) {
          throw browserError('BROWSER_FORBIDDEN', 'Only the owner or admin can release the bot browser.');
        }
        if (
          state.phase === 'human' &&
          !state.isActiveLeaseHolder(auth, req.lease ?? null) &&
          req.force !== true &&
          req.preempt !== true
        ) {
          throw browserError('BROWSER_LEASE_CONFLICT', undefined, {
            phase: state.phase,
            holderLabel: state.holderLabel,
          });
        }
        await closeEntryProvider(entry);
        state.resetAfterRelease();
        return buildControlViewDto(state, auth, { includeLeaseToken: false });
      }

      case 'frame': {
        const presentedLease = req.lease ?? null;
        const hasPresentedLease = presentedLease !== null;
        if (hasPresentedLease) {
          state.renewLease(auth, presentedLease);
        }
        const provider = await ensureProvider(entry, { allowUnavailable: true });
        if (!provider) {
          throw browserError('BROWSER_STREAM_UNAVAILABLE', state.reason || 'Bot browser is unavailable on this host.');
        }
        if (!state.available || !state.pageId) {
          await refreshProviderStatus(entry, { allowUnavailable: true, pageId: req.pageId });
        }
        if (closed || state.closed) {
          throw browserError('BROWSER_CLOSED');
        }
        if (!state.available || !state.canStreamInteract) {
          throw browserError(
            'BROWSER_STREAM_UNAVAILABLE',
            state.reason || 'Live interactive stream is unavailable for this host browser.'
          );
        }
        if (req.pageId) {
          state.assertOwnsPage(req.pageId);
        }
        if ((req.sessionId && req.sessionId !== state.sessionId) || (req.stream && req.pageId !== state.pageId)) {
          throw browserError('BROWSER_STALE_PAGE');
        }
        const targetPageId = req.pageId ?? state.pageId;
        if (!targetPageId) {
          throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active page open in this bot browser.');
        }

        const sessionAtStart = state.sessionId;
        const targetTab = () => state.tabs.find(tab => tab.id === targetPageId);
        const targetSensitivity = () => targetPageId === state.pageId ? state.sensitivity : classifyPageSensitivity({
          url: targetTab()?.url ?? '', title: targetTab()?.title ?? '', botId: req.botId,
          pageId: targetPageId, isPageWithheld: checkWithheld,
        });
        const sensitiveFrameRequiresLease = req.stream || auth.transport === 'relay';
        const mayViewRestricted = () => {
          const holder = state.isActiveLeaseHolder(auth, presentedLease); // also expires stale leases
          if (!auth.canViewSensitive) return false;
          if (sensitiveFrameRequiresLease) return hasPresentedLease && holder;
          if (state.phase === 'human' || hasPresentedLease) return holder;
          return state.phase === 'held' && state.reason !== 'disconnected_hold';
        };
        const assertMayDeliver = (sensitivity, allowed) => {
          if (sensitivity.blockNormalFrame) {
            throw browserError('BROWSER_SECRET_STEP_BLOCKED', sensitivity.guidance,
              { phase: state.phase, reason: 'secret_risk', fallbackToSystemBrowser: true });
          }
          if ((sensitivity.blockBystanderFrame || (sensitiveFrameRequiresLease && sensitivity.sensitive)) && !allowed) {
            throw browserError('BROWSER_SENSITIVE_BLOCKED',
              'Sensitive page frames are withheld from bystanders and non-holder viewers.',
              { phase: state.phase, reason: sensitivity.reasons[0] ?? 'sensitive_page' });
          }
        };
        const allowedBefore = mayViewRestricted();
        const leaseAtStart = state.leaseGeneration;
        const humanAtStart = state.phase === 'human';
        const sensitivityBefore = targetSensitivity();
        assertMayDeliver(sensitivityBefore, allowedBefore);

        const capture = () => provider.perform({
          action: 'frame',
          actor: 'human',
          viewer: 'human',
          botId: req.botId,
          pageId: targetPageId,
          ...req.frameLimits,
          limits: req.frameLimits,
          ...(req.sinceSeq !== undefined ? { afterSeq: req.sinceSeq } : {}),
          ...(req.stream ? { stream: true, waitMs: req.waitMs } : {}),
        });
        let rawFrame;
        try {
          if (req.stream) {
            // Share a capture in flight. Each viewer's lease and page are checked
            // independently on both sides of the await.
            const key = JSON.stringify([
              sessionAtStart, targetPageId, state.documentGeneration, leaseAtStart, req.frameLimits, req.sinceSeq, req.waitMs,
            ]);
            let pending = entry.streamCaptures.get(key);
            if (!pending) {
              pending = Promise.resolve(capture()).finally(() => entry.streamCaptures.delete(key));
              entry.streamCaptures.set(key, pending);
            }
            rawFrame = await pending;
          } else {
            rawFrame = await capture();
          }
        } catch (err) {
          throw mapProviderError(err, state);
        }

        if (closed || state.closed) {
          throw browserError('BROWSER_CLOSED');
        }

        const frameUnchanged = req.stream && rawFrame?.frameUnchanged === true;
        const validated = frameUnchanged ? { pageId: rawFrame.pageId } : validateFramePayload(rawFrame, req.frameLimits.maxBytes);
        const framePageId = validated.pageId ?? targetPageId;
        const frameHints = mergeProviderHints(rawFrame, validated.hints);

        if (framePageId !== targetPageId) throw browserError('BROWSER_STALE_PAGE');

        const sessionStillCurrent = entry.provider === provider && state.sessionId === sessionAtStart && state.hasActiveSession;
        const currentTab = targetTab();
        const staleDocument = framePageId === state.pageId && Number.isSafeInteger(validated.documentGeneration)
          && Number.isSafeInteger(state.documentGeneration) && validated.documentGeneration < state.documentGeneration;
        const sensitivityAtDelivery = targetSensitivity();
        const liveSensitivity = classifyPageSensitivity({
          url: validated.url ?? currentTab?.url ?? '',
          title: validated.title ?? currentTab?.title ?? '',
          hints: frameHints,
          providerSensitive: validated.sensitive,
          botId: req.botId,
          pageId: framePageId,
          isPageWithheld: checkWithheld,
        });

        // Sync metadata/sensitivity only while the same provider session and document are current.
        if (!frameUnchanged && sessionStillCurrent && !staleDocument && currentTab && framePageId === state.pageId) {
          state.syncProviderResult({
            pageId: framePageId,
            ...(validated.url !== undefined ? { url: validated.url } : {}),
            ...(validated.title !== undefined ? { title: validated.title } : {}),
            ...(validated.documentGeneration !== undefined ? { documentGeneration: validated.documentGeneration } : {}),
            ...(frameHints !== null ? { hints: frameHints } : {}),
            ...(validated.sensitive ? { sensitive: true } : {}),
            ...(typeof rawFrame?.sensitiveCategory === 'string' ? { sensitiveCategory: rawFrame.sensitiveCategory } : {}),
            ...(typeof rawFrame?.sensitiveReason === 'string' ? { sensitiveReason: rawFrame.sensitiveReason } : {}),
            ...(rawFrame?.authUseSystemBrowser === true ? { authUseSystemBrowser: true } : {}),
          }, { invalidateFramesOnChange: true });
        }

        // A renewal is harmless, but never deliver restricted pixels across a lease boundary.
        const allowedAfter = mayViewRestricted() && allowedBefore && sessionStillCurrent
          && state.leaseGeneration === leaseAtStart && (state.phase === 'human') === humanAtStart;
        assertMayDeliver(liveSensitivity, allowedAfter);
        assertMayDeliver(sensitivityAtDelivery, allowedAfter);
        assertMayDeliver(sensitivityBefore, allowedAfter);
        if (!sessionStillCurrent) throw browserError('BROWSER_STREAM_UNAVAILABLE');
        if (!currentTab || staleDocument || (req.stream && state.pageId !== framePageId)) {
          throw browserError('BROWSER_STALE_PAGE');
        }
        if (frameUnchanged) return { frameUnchanged: true, pageId: framePageId };

        const stamped = state.recordFrame({ pageId: framePageId });
        return {
          seq: stamped.seq,
          ...(req.stream && Number.isSafeInteger(rawFrame.captureSeq) && rawFrame.captureSeq > 0
            ? { captureSeq: rawFrame.captureSeq } : {}),
          mimeType: validated.mimeType,
          data: validated.data,
          width: validated.width,
          height: validated.height,
          revision: stamped.revision,
          pageId: stamped.pageId,
        };
      }

      case 'input': {
        if (!auth.canControl) {
          throw browserError('BROWSER_FORBIDDEN', 'Only the owner or admin can send manual browser input.');
        }
        try {
          state.verifyHumanLease({ authority: auth, leaseToken: req.lease, renew: true });
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          if (!state.available || !state.canStreamInteract) {
            throw browserError('BROWSER_STREAM_UNAVAILABLE', state.reason || 'Live interactive input is unavailable.');
          }
          state.assertOwnsPage(req.pageId);
          state.assertInputFreshness({
            pageId: req.pageId,
            revision: req.revision,
            frameSeq: req.frameSeq,
          });
          if (state.sensitivity.blockNormalFrame && !state.capabilities.privateSecretIsolation) {
            throw browserError(
              'BROWSER_SECRET_STEP_BLOCKED',
              state.sensitivity.guidance,
              { phase: state.phase, reason: 'secret_risk', fallbackToSystemBrowser: true }
            );
          }

          let res;
          try {
            res = await provider.perform({
              action: 'input',
              actor: 'human',
              botId: req.botId,
              pageId: req.pageId,
              expectedRevision: state.revision,
              ...(Number.isSafeInteger(state.documentGeneration) ? { documentGeneration: state.documentGeneration } : {}),
              expectedDocumentGeneration: state.documentGeneration,
              beforeInput: () => {
                state.verifyHumanLease({ authority: auth, leaseToken: req.lease, renew: false });
                state.assertInputFreshness({ pageId: req.pageId, revision: req.revision, frameSeq: req.frameSeq });
              },
              event: formatProviderInputEvent(req.event),
            });
          } catch (providerErr) {
            throw mapProviderError(providerErr, state);
          }
          if (isPlainObject(res)) {
            state.syncProviderResult(res);
          }
          return {
            ok: true,
            ...buildControlViewDto(state, auth, { includeLeaseToken: false, presentedLease: req.lease }),
          };
        } catch (err) {
          // Never reflect typed text/secrets in any input error message.
          throw safeBrowserError(err, 'BROWSER_BACKEND_FAILED');
        }
      }

      case 'open': {
        assertControlMutationAllowed(state, auth, { ...req, revision: undefined });
        entry.opening += 1;
        try {
          const safeUrl = req.url !== undefined
            ? validateNavigationUrl(req.url, { actor: 'human', allowBlank: true })
            : undefined;
          if (!state.hasActiveSession) await reclaimIdleBotSessionsIfNeeded(req.botId);
          if (state.tabs.length >= maxTabsPerBot) {
            throw browserError('BROWSER_TAB_LIMIT', `Tab limit (${maxTabsPerBot}) reached for bot ${req.botId}.`);
          }
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          let res;
          try {
            res = await provider.perform({
              action: 'open',
              actor: 'human',
              botId: req.botId,
              ...(safeUrl !== undefined ? { url: safeUrl } : {}),
            });
          } catch (err) {
            throw mapProviderError(err, state);
          }
          state.ensureSessionId();
          state.syncProviderResult({ available: true, ...res });
          return buildControlViewDto(state, auth, { includeLeaseToken: false, presentedLease: req.lease });
        } finally {
          entry.opening -= 1;
        }
      }

      case 'navigate': {
        assertControlMutationAllowed(state, auth, req);
        const safeUrl = validateNavigationUrl(req.url, { actor: 'human', allowBlank: false });
        if (req.pageId) state.assertOwnsPage(req.pageId);
        const provider = await ensureProvider(entry, { allowUnavailable: false });
        let res;
        try {
          res = await provider.perform({
            action: 'navigate',
            actor: 'human',
            botId: req.botId,
            pageId: req.pageId ?? state.pageId,
            url: safeUrl,
          });
        } catch (err) {
          throw mapProviderError(err, state);
        }
        state.ensureSessionId();
        state.syncProviderResult(res);
        return buildControlViewDto(state, auth, { includeLeaseToken: false, presentedLease: req.lease });
      }

      case 'back':
      case 'forward':
      case 'reload':
      case 'select':
      case 'closeTab': {
        assertControlMutationAllowed(state, auth, req);
        if (req.pageId) state.assertOwnsPage(req.pageId);
        const targetPageId = req.pageId ?? state.pageId;
        if (!targetPageId) {
          throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active browser tab for this bot.');
        }
        const provider = await ensureProvider(entry, { allowUnavailable: false });
        let res;
        try {
          res = await provider.perform({
            action: req.action,
            actor: 'human',
            botId: req.botId,
            pageId: targetPageId,
            ...(req.action === 'reload' && req.ignoreCache !== undefined ? { ignoreCache: req.ignoreCache } : {}),
          });
        } catch (err) {
          throw mapProviderError(err, state);
        }
        state.syncProviderResult(res);
        return buildControlViewDto(state, auth, { includeLeaseToken: false, presentedLease: req.lease });
      }

      default:
        throw browserError('INVALID_ARGUMENT', 'Unsupported browserControl action');
    }
  }

  /**
   * Internal Bot-only execution lane invoked exclusively by `toolsForBot()`.
   * Runs sequentially inside `state.enqueueBotOp`, enforces Privacy Shield and pre-action
   * interception, and returns PAUSED_FOR_HUMAN on takeover/hold/sensitive boundaries.
   */
  async function runBotAction(identity, rawArgs, callOpts = {}) {
    assertNotClosedOrMaintenance();
    const botId = identity.botId;
    assertLocalBot(botId);

    const entry = getOrCreateEntry(botId);
    const { state } = entry;
    state.expireLeaseIfNeeded();

    const action = rawArgs.action;

    if (action === 'status') {
      if (entry.provider && state.phase !== 'taking') {
        await refreshProviderStatus(entry, { allowUnavailable: true, signal: callOpts.signal });
      } else if (!entry.provider && state.phase === 'bot') {
        await refreshProviderStatus(entry, { allowUnavailable: true, signal: callOpts.signal });
      }
      return buildBotStatusDto(state);
    }

    if (action === 'requestTakeover') {
      const reason = typeof rawArgs.reason === 'string' && rawArgs.reason.trim() !== ''
        ? rawArgs.reason.trim().slice(0, 240)
        : 'bot_requested_takeover';
      state.holdForSensitive({
        reason: 'bot_requested_takeover',
        guidance: reason,
      });
      return {
        status: 'PAUSED_FOR_HUMAN',
        phase: state.phase,
        reason: state.reason,
        guidance: reason,
        revision: state.revision,
        pageId: state.pageId,
      };
    }

    const reqPageId = rawArgs.pageId !== undefined ? normalizePageId(rawArgs.pageId) : undefined;
    if (state.phase === 'bot' && state.sensitivity.sensitive) {
      await refreshProviderStatus(entry, { allowUnavailable: true, signal: callOpts.signal });
    }

    return state.enqueueBotOp(action, async (opSignal) => {
      const signal = combineSignals(opSignal, callOpts.signal);
      const assertStillBot = () => {
        if (opSignal.aborted || !state.canBotOperate) {
          throw browserError('BROWSER_PAUSED_FOR_HUMAN', undefined, {
            phase: state.phase,
            reason: state.reason,
            holderLabel: state.holderLabel,
          });
        }
        if (callOpts.signal?.aborted) {
          throw browserError('CANCELLED');
        }
      };

      assertStillBot();

      switch (action) {
        case 'open': {
          let safeUrl;
          if (rawArgs.url !== undefined) {
            try {
              safeUrl = validateNavigationUrl(rawArgs.url, { actor: 'bot', allowBlank: true });
            } catch (err) {
              if (err?.code === 'BROWSER_SENSITIVE_BLOCKED' || err?.code === 'BROWSER_SECRET_STEP_BLOCKED') {
                state.holdForSensitive({ reason: err.details?.reason ?? 'sensitive_url', guidance: err.message });
              }
              throw err;
            }
          }
          if (!state.hasActiveSession) {
            await reclaimIdleBotSessionsIfNeeded(botId);
          }
          if (state.tabs.length >= maxTabsPerBot) {
            throw browserError('BROWSER_TAB_LIMIT', `Tab limit (${maxTabsPerBot}) reached for this bot.`);
          }
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          assertStillBot();
          let res;
          try {
            res = await provider.perform({
              action: 'open',
              actor: 'bot',
              botId,
              ...(safeUrl !== undefined ? { url: safeUrl } : {}),
              signal,
            });
          } catch (err) {
            throw mapProviderError(err, state, { holdBotOnSensitive: true });
          }
          assertStillBot();
          state.ensureSessionId();
          state.syncProviderResult({ available: true, ...res });
          if (state.sensitivity.blockBotObserve || state.sensitivity.blockBotAct) {
            state.holdForSensitive({
              reason: state.sensitivity.reasons[0] ?? 'sensitive_page',
              guidance: state.sensitivity.guidance,
            });
            throw browserError(
              state.sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              state.sensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
              }
            );
          }
          return buildBotStatusDto(state);
        }

        case 'navigate': {
          if (typeof rawArgs.url !== 'string' || rawArgs.url.trim() === '') {
            throw browserError('INVALID_ARGUMENT', 'navigate requires url');
          }
          let safeUrl;
          try {
            safeUrl = validateNavigationUrl(rawArgs.url, { actor: 'bot', allowBlank: false });
          } catch (err) {
            if (err?.code === 'BROWSER_SENSITIVE_BLOCKED' || err?.code === 'BROWSER_SECRET_STEP_BLOCKED') {
              state.holdForSensitive({ reason: err.details?.reason ?? 'sensitive_url', guidance: err.message });
            }
            throw err;
          }
          if (reqPageId) state.assertOwnsPage(reqPageId);
          const targetPageId = reqPageId ?? state.pageId;
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          assertStillBot();
          let res;
          try {
            res = await provider.perform({
              action: 'navigate',
              actor: 'bot',
              botId,
              pageId: targetPageId,
              url: safeUrl,
              signal,
            });
          } catch (err) {
            throw mapProviderError(err, state, { holdBotOnSensitive: true });
          }
          assertStillBot();
          state.ensureSessionId();
          state.syncProviderResult(res);
          if (state.sensitivity.blockBotObserve || state.sensitivity.blockBotAct) {
            state.holdForSensitive({
              reason: state.sensitivity.reasons[0] ?? 'sensitive_page',
              guidance: state.sensitivity.guidance,
            });
            throw browserError(
              state.sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              state.sensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
              }
            );
          }
          return buildBotStatusDto(state);
        }

        case 'back':
        case 'forward':
        case 'reload':
        case 'select':
        case 'closeTab': {
          if ((action === 'select' || action === 'closeTab') && !reqPageId) {
            throw browserError('INVALID_ARGUMENT', `${action} requires pageId`);
          }
          if (reqPageId) state.assertOwnsPage(reqPageId);
          const targetPageId = reqPageId ?? state.pageId;
          if (!targetPageId) {
            throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active browser tab; call open first.');
          }
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          assertStillBot();
          let res;
          try {
            res = await provider.perform({
              action,
              actor: 'bot',
              botId,
              pageId: targetPageId,
              ...(action === 'reload' && rawArgs.ignoreCache !== undefined ? { ignoreCache: Boolean(rawArgs.ignoreCache) } : {}),
              signal,
            });
          } catch (err) {
            throw mapProviderError(err, state, { holdBotOnSensitive: true });
          }
          assertStillBot();
          state.syncProviderResult(res);
          if (action !== 'closeTab' && (state.sensitivity.blockBotObserve || state.sensitivity.blockBotAct)) {
            state.holdForSensitive({
              reason: state.sensitivity.reasons[0] ?? 'sensitive_page',
              guidance: state.sensitivity.guidance,
            });
            throw browserError(
              state.sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              state.sensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
              }
            );
          }
          assertStillBot();
          return buildBotStatusDto(state);
        }

        case 'snapshot': {
          if (reqPageId) state.assertOwnsPage(reqPageId);
          const targetPageId = reqPageId ?? state.pageId;
          if (!targetPageId) {
            throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active browser tab; call open first.');
          }
          if (state.sensitivity.blockBotObserve) {
            state.holdForSensitive({
              reason: state.sensitivity.reasons[0] ?? 'sensitive_page',
              guidance: state.sensitivity.guidance,
            });
            throw browserError(
              state.sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              state.sensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
              }
            );
          }
          const snapshotOpts = normalizeBotSnapshotOptions(rawArgs.snapshot ?? {});
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          assertStillBot();
          let res;
          try {
            res = await provider.perform({
              action: 'snapshot',
              actor: 'bot',
              botId,
              pageId: targetPageId,
              ...snapshotOpts,
              signal,
            });
          } catch (err) {
            throw mapProviderError(err, state, { holdBotOnSensitive: true });
          }
          assertStillBot();
          state.syncProviderResult(res);
          const sanitized = sanitizeSnapshotForBot(res, state.sensitivity);
          if (sanitized.blocked) {
            state.holdForSensitive({
              reason: sanitized.reason,
              guidance: sanitized.guidance,
            });
            throw browserError(sanitized.code, sanitized.guidance, {
              phase: state.phase,
              reason: sanitized.reason,
              fallbackToSystemBrowser: sanitized.fallbackToSystemBrowser,
            });
          }
          assertStillBot();
          state.setSnapshotRefs(sanitized.refMap);
          return {
            pageId: state.pageId,
            revision: state.revision,
            url: sanitizeUrlForModel(state.activeTab()?.url ?? res?.url ?? ''),
            title: state.activeTab()?.title ?? res?.title ?? '',
            snapshot: sanitized.text,
            truncated: sanitized.truncated,
            ...(state.sensitivity.webLoginNotApiGrant
              ? { webLoginNotApiGrant: true, guidance: state.sensitivity.guidance }
              : {}),
          };
        }

        case 'act': {
          if (reqPageId) state.assertOwnsPage(reqPageId);
          const targetPageId = reqPageId ?? state.pageId;
          if (!targetPageId) {
            throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active browser tab; call open first.');
          }
          const normalizedAct = normalizeBotActInput(rawArgs.act);
          const targetRefMeta = normalizedAct.ref ? state.getSnapshotRef(normalizedAct.ref) : null;
          const active = state.activeTab();

          // Pre-action Privacy Shield & policy/secret interception BEFORE clicking or filling!
          const decision = checkBotActionSensitivity({
            act: normalizedAct,
            pageUrl: active?.url ?? '',
            pageTitle: active?.title ?? '',
            hints: state.lastHints,
            providerSensitive: state.lastProviderSensitive,
            targetRefMeta,
            isPageWithheld: checkWithheld,
            botId,
            pageId: targetPageId,
          });
          if (!decision.allowed) {
            if (decision.holdSession) {
              state.holdForSensitive({
                reason: decision.reason,
                guidance: decision.guidance,
              });
            }
            throw browserError(decision.code, decision.guidance, {
              phase: state.phase,
              reason: decision.reason,
              fallbackToSystemBrowser: decision.fallbackToSystemBrowser === true,
            });
          }

          const provider = await ensureProvider(entry, { allowUnavailable: false });
          assertStillBot();
          const providerAct = formatProviderAct(normalizedAct);
          let res;
          try {
            res = await provider.perform({
              action: 'act',
              actor: 'bot',
              botId,
              pageId: targetPageId,
              ...(Number.isSafeInteger(state.documentGeneration) ? { documentGeneration: state.documentGeneration } : {}),
              expectedDocumentGeneration: state.documentGeneration,
              command: providerAct,
              act: providerAct,
              signal,
            });
          } catch (err) {
            throw mapProviderError(err, state, { holdBotOnSensitive: true });
          }
          assertStillBot();
          state.syncProviderResult(res);

          if (state.sensitivity.blockBotObserve || state.sensitivity.blockBotAct) {
            state.holdForSensitive({
              reason: state.sensitivity.reasons[0] ?? 'sensitive_page',
              guidance: state.sensitivity.guidance,
            });
            throw browserError(
              state.sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              state.sensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
              }
            );
          }

          return {
            ok: res?.ok !== false,
            pageId: state.pageId,
            revision: state.revision,
            url: sanitizeUrlForModel(state.activeTab()?.url ?? res?.url ?? ''),
            title: state.activeTab()?.title ?? res?.title ?? '',
            changed: res?.changed !== false,
          };
        }

        case 'screenshot': {
          if (reqPageId) state.assertOwnsPage(reqPageId);
          const targetPageId = reqPageId ?? state.pageId;
          if (!targetPageId) {
            throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active browser tab; call open first.');
          }
          if (state.sensitivity.blockBotObserve || state.sensitivity.secretRisk) {
            state.holdForSensitive({
              reason: state.sensitivity.reasons[0] ?? 'sensitive_page',
              guidance: state.sensitivity.guidance,
            });
            throw browserError(
              state.sensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              state.sensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: state.sensitivity.fallbackToSystemBrowser,
              }
            );
          }
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          assertStillBot();
          let rawFrame;
          try {
            rawFrame = await provider.perform({
              action: 'frame',
              actor: 'bot',
              viewer: 'bot',
              botId,
              pageId: targetPageId,
              ...(rawArgs.limits ?? {}),
              limits: rawArgs.limits,
              signal,
            });
          } catch (err) {
            throw mapProviderError(err, state, { holdBotOnSensitive: true });
          }
          assertStillBot();
          const validated = validateFramePayload(rawFrame, rawArgs.limits?.maxBytes ?? maxFrameBase64Bytes);
          const framePageId = validated.pageId ?? targetPageId;
          const frameHints = mergeProviderHints(rawFrame, validated.hints);
          const liveSensitivity = classifyPageSensitivity({
            url: validated.url ?? state.activeTab()?.url ?? '',
            title: validated.title ?? state.activeTab()?.title ?? '',
            hints: frameHints,
            providerSensitive: validated.sensitive,
            botId,
            pageId: framePageId,
            isPageWithheld: checkWithheld,
          });
          state.syncProviderResult({
            pageId: framePageId,
            ...(validated.url !== undefined ? { url: validated.url } : {}),
            ...(validated.title !== undefined ? { title: validated.title } : {}),
            ...(validated.documentGeneration !== undefined ? { documentGeneration: validated.documentGeneration } : {}),
            ...(frameHints !== null ? { hints: frameHints } : {}),
            ...(validated.sensitive ? { sensitive: true } : {}),
            ...(typeof rawFrame?.sensitiveCategory === 'string' ? { sensitiveCategory: rawFrame.sensitiveCategory } : {}),
            ...(typeof rawFrame?.sensitiveReason === 'string' ? { sensitiveReason: rawFrame.sensitiveReason } : {}),
            ...(rawFrame?.authUseSystemBrowser === true ? { authUseSystemBrowser: true } : {}),
          }, { invalidateFramesOnChange: false });

          if (liveSensitivity.blockBotObserve || liveSensitivity.secretRisk) {
            state.holdForSensitive({
              reason: liveSensitivity.reasons[0] ?? 'sensitive_page',
              guidance: liveSensitivity.guidance,
            });
            throw browserError(
              liveSensitivity.secretRisk ? 'BROWSER_SECRET_STEP_BLOCKED' : 'BROWSER_SENSITIVE_BLOCKED',
              liveSensitivity.guidance,
              {
                phase: state.phase,
                reason: state.reason,
                fallbackToSystemBrowser: liveSensitivity.fallbackToSystemBrowser,
              }
            );
          }

          assertStillBot();
          return {
            pageId: framePageId,
            revision: state.revision,
            width: validated.width,
            height: validated.height,
            mimeType: validated.mimeType,
            data: validated.data,
            url: sanitizeUrlForModel(state.activeTab()?.url ?? validated.url ?? ''),
            title: state.activeTab()?.title ?? validated.title ?? '',
          };
        }

        default:
          throw browserError('INVALID_ARGUMENT', 'Unsupported bot_browser action');
      }
    }, { mutating: action !== 'snapshot' && action !== 'screenshot' && !(action === 'act' && rawArgs.act?.kind === 'wait') });
  }

  /**
   * Returns Bot-facing Durable tool definitions (`bot_browser`).
   * Can be called either globally at runtime startup (`toolsForBot()`) or bound to a specific bot
   * (`toolsForBot({ botId })`); in both cases, execution still verifies persistent conversation ownership.
   */
  function toolsForBot(context = {}) {
    let boundBotId = null;
    if (context && context.botId !== undefined && context.botId !== null) {
      assertLocalBot(context.botId);
      boundBotId = context.botId;
    }
    return createBotBrowserTools({
      host,
      getHarness,
      resolveConversationBot,
      resolveIdentity,
      runBotAction,
      boundBotId,
    });
  }

  async function cleanupBot(botId) {
    assertId(botId, 'botId');
    const entry = entries.get(botId);
    if (!entry) return;
    entries.delete(botId);
    entry.state.markClosed();
    await closeEntryProvider(entry);
  }

  function setWithheldPagePredicate(fn) {
    if (fn !== null && typeof fn !== 'function') {
      throw browserError('INVALID_ARGUMENT', 'withheld page predicate must be a function or null');
    }
    withheldPredicate = fn;
  }

  function close() {
    closed = true;
    closePromise ??= (async () => {
      const snapshot = [...entries.values()];
      entries.clear();
      const errors = [];
      for (const entry of snapshot) {
        entry.state.markClosed();
      }
      const results = await Promise.allSettled(snapshot.map((entry) => closeEntryProvider(entry)));
      for (const res of results) {
        if (res.status === 'rejected') errors.push(res.reason);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'bot browser service close failed');
    })();
    return closePromise;
  }

  return {
    control,
    toolsForBot,
    close,
    cleanupBot,
    releaseBot: cleanupBot,
    setWithheldPagePredicate,
  };
}
