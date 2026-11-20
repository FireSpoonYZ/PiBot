// host-core/bot-browser/service.js
// Core Bot Browser service: per-bot isolated sessions & profiles, single-writer human takeover
// lease with real bot queue drain & in-flight confirmation, fail-closed disconnect hold,
// Privacy Shield sensitive-step isolation, and dual-lane control() vs toolsForBot() dispatch.
import { join } from 'node:path';
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
  sanitizeSnapshotForBot,
  sanitizeTabsForCaller,
  sanitizeUrlForModel,
  validateNavigationUrl,
} from './policy.js';
import { createBotBrowserState } from './state.js';
import { createBotBrowserTools } from './tools.js';

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

export function createBotBrowserService(options = {}) {
  const host = options.host;
  if (!host || typeof host.deviceId !== 'string' || typeof host.getBot !== 'function') {
    throw browserError('INVALID_ARGUMENT', 'createBotBrowserService requires options.host with deviceId and getBot()');
  }
  const profileRoot = typeof options.profileRoot === 'string' && options.profileRoot.trim() !== ''
    ? options.profileRoot.trim()
    : (typeof host.dataRoot === 'string' && host.dataRoot.trim() !== ''
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
  const onTakeover = typeof options.onTakeover === 'function' ? options.onTakeover : null;
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
      onEvent,
    });
    entry = { state, provider: null, providerPromise: null };
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
    if (closed) throw browserError('BROWSER_CLOSED');
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
    entry.provider = null;
    if (!provider) return;
    try {
      await provider.perform({ action: 'release', botId: entry.state.botId }).catch(() => {});
    } finally {
      await provider.close();
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
      entry.state.syncProviderResult(res);
      return res;
    } catch (err) {
      if (allowUnavailable) {
        entry.state.setUnavailable(err?.message || 'browser_provider_unavailable');
        return null;
      }
      throw err;
    }
  }

  function buildControlViewDto(state, authority, { includeLeaseToken = false, presentedLease = null } = {}) {
    state.expireLeaseIfNeeded();
    const isLeaseHolder = state.isActiveLeaseHolder(authority);
    const leaseToken = includeLeaseToken
      ? state.currentLeaseTokenFor(authority, presentedLease)
      : undefined;

    const canSeeSensitiveTabs =
      authority.canViewSensitive &&
      (!state.sensitivity.blockBystanderFrame || state.phase !== 'human' || isLeaseHolder);

    const tabs = sanitizeTabsForCaller(state.tabs, {
      isBot: false,
      canViewSensitive: canSeeSensitiveTabs,
      isPageWithheld: checkWithheld,
      botId: state.botId,
    });

    const dto = {
      available: state.available,
      ...(state.reason ? { reason: state.reason } : {}),
      canStreamInteract: state.canStreamInteract,
      phase: state.phase,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.pageId ? { pageId: state.pageId } : {}),
      revision: state.revision,
      tabs,
      ...(state.holderLabel ? { holderLabel: state.holderLabel } : {}),
      ...(includeLeaseToken && leaseToken ? { lease: leaseToken } : {}),
      isLeaseHolder,
      sensitive: state.sensitivity.sensitive,
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
      canViewSensitive: false,
      isPageWithheld: checkWithheld,
      botId: state.botId,
    });
    return {
      available: state.available,
      ...(state.reason ? { reason: state.reason } : {}),
      canStreamInteract: state.canStreamInteract,
      phase: state.phase,
      pausedForHuman: state.phase !== 'bot',
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
  async function control(input, authority) {
    assertNotClosedOrMaintenance();
    const auth = normalizeControlAuthority(authority);
    const req = normalizeControlInput(input, maxFrameBase64Bytes);
    assertLocalBot(req.botId);

    if (req.scopeId !== undefined && resolveWorkContext) {
      await resolveWorkContext(req.botId, req.scopeId);
    }

    const entry = getOrCreateEntry(req.botId);
    const { state } = entry;
    state.expireLeaseIfNeeded();

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
        const result = await state.beginTakeover({
          authority: auth,
          leaseToken: req.lease ?? null,
          force: req.force === true,
          preempt: req.preempt === true,
          holderLabelOverride: req.holderLabel ?? null,
          onTakeoverHook: onTakeover,
        });
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
        // Always inspect the live landing page BEFORE permitting handback.
        if (entry.provider) {
          await refreshProviderStatus(entry, { allowUnavailable: true, pageId: req.pageId });
        }
        const summary = state.handback({
          authority: auth,
          leaseToken: req.lease ?? null,
          currentSensitivity: state.sensitivity,
        });
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
        if (req.lease) {
          state.renewLease(auth, req.lease);
        }
        const provider = await ensureProvider(entry, { allowUnavailable: true });
        if (!provider) {
          throw browserError('BROWSER_STREAM_UNAVAILABLE', state.reason || 'Bot browser is unavailable on this host.');
        }
        if (!state.available || !state.pageId) {
          await refreshProviderStatus(entry, { allowUnavailable: true, pageId: req.pageId });
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
        const targetPageId = req.pageId ?? state.pageId;
        if (!targetPageId) {
          throw browserError('BROWSER_PAGE_NOT_FOUND', 'No active page open in this bot browser.');
        }

        // Pre-check known secret/sensitivity state before asking provider for pixels.
        const isHolder = state.isActiveLeaseHolder(auth, req.lease ?? null);
        if (state.sensitivity.blockNormalFrame) {
          throw browserError(
            'BROWSER_SECRET_STEP_BLOCKED',
            state.sensitivity.guidance,
            { phase: state.phase, reason: 'secret_risk', fallbackToSystemBrowser: true }
          );
        }
        if (state.sensitivity.blockBystanderFrame) {
          if (!auth.canViewSensitive || (state.phase === 'human' && !isHolder)) {
            throw browserError(
              'BROWSER_SENSITIVE_BLOCKED',
              'Sensitive page frames are withheld from bystanders and non-holder viewers.',
              { phase: state.phase, reason: state.sensitivity.reasons[0] ?? 'sensitive_page' }
            );
          }
        }

        const rawFrame = await provider.perform({
          action: 'frame',
          botId: req.botId,
          pageId: targetPageId,
          ...req.frameLimits,
        });
        const validated = validateFramePayload(rawFrame, req.frameLimits.maxBytes);
        const framePageId = validated.pageId ?? targetPageId;
        const liveSensitivity = classifyPageSensitivity({
          url: validated.url ?? state.activeTab()?.url ?? '',
          title: validated.title ?? state.activeTab()?.title ?? '',
          hints: validated.hints,
          providerSensitive: validated.sensitive,
          botId: req.botId,
          pageId: framePageId,
          isPageWithheld: checkWithheld,
        });

        // Sync metadata/sensitivity (never dropping security state).
        state.syncProviderResult({
          pageId: framePageId,
          ...(validated.url !== undefined ? { url: validated.url } : {}),
          ...(validated.title !== undefined ? { title: validated.title } : {}),
          ...(validated.documentGeneration !== undefined ? { documentGeneration: validated.documentGeneration } : {}),
          ...(validated.hints !== undefined ? { hints: validated.hints } : {}),
          ...(validated.sensitive ? { sensitive: true } : {}),
        }, { invalidateFramesOnChange: true });

        // Post-capture Privacy Shield gate BEFORE returning any image bytes.
        if (liveSensitivity.blockNormalFrame) {
          throw browserError(
            'BROWSER_SECRET_STEP_BLOCKED',
            liveSensitivity.guidance,
            { phase: state.phase, reason: 'secret_risk', fallbackToSystemBrowser: true }
          );
        }
        if (liveSensitivity.blockBystanderFrame) {
          if (!auth.canViewSensitive || (state.phase === 'human' && !isHolder)) {
            throw browserError(
              'BROWSER_SENSITIVE_BLOCKED',
              'Sensitive page frames are withheld from bystanders and non-holder viewers.',
              { phase: state.phase, reason: liveSensitivity.reasons[0] ?? 'sensitive_page' }
            );
          }
        }

        const stamped = state.recordFrame({ pageId: framePageId });
        return {
          seq: stamped.seq,
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

          const res = await provider.perform({
            action: 'input',
            botId: req.botId,
            pageId: req.pageId,
            expectedRevision: state.revision,
            expectedDocumentGeneration: state.documentGeneration,
            event: req.event,
          });
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
        assertControlMutationAllowed(state, auth, req);
        const safeUrl = req.url !== undefined
          ? validateNavigationUrl(req.url, { actor: 'human', allowBlank: true })
          : undefined;
        if (!state.hasActiveSession) {
          await reclaimIdleBotSessionsIfNeeded(req.botId);
        }
        if (state.tabs.length >= maxTabsPerBot) {
          throw browserError('BROWSER_TAB_LIMIT', `Tab limit (${maxTabsPerBot}) reached for bot ${req.botId}.`);
        }
        const provider = await ensureProvider(entry, { allowUnavailable: false });
        const res = await provider.perform({
          action: 'open',
          botId: req.botId,
          ...(safeUrl !== undefined ? { url: safeUrl } : {}),
        });
        state.ensureSessionId();
        state.syncProviderResult({ available: true, ...res });
        return buildControlViewDto(state, auth, { includeLeaseToken: false, presentedLease: req.lease });
      }

      case 'navigate': {
        assertControlMutationAllowed(state, auth, req);
        const safeUrl = validateNavigationUrl(req.url, { actor: 'human', allowBlank: false });
        if (req.pageId) state.assertOwnsPage(req.pageId);
        const provider = await ensureProvider(entry, { allowUnavailable: false });
        const res = await provider.perform({
          action: 'navigate',
          botId: req.botId,
          pageId: req.pageId ?? state.pageId,
          url: safeUrl,
        });
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
        const res = await provider.perform({
          action: req.action,
          botId: req.botId,
          pageId: targetPageId,
          ...(req.action === 'reload' && req.ignoreCache !== undefined ? { ignoreCache: req.ignoreCache } : {}),
        });
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

    return state.enqueueBotOp(action, async (opSignal) => {
      const signal = combineSignals(opSignal, callOpts.signal);
      const assertStillBot = () => {
        if (opSignal.aborted || state.phase !== 'bot') {
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
          const res = await provider.perform({
            action: 'open',
            botId,
            ...(safeUrl !== undefined ? { url: safeUrl } : {}),
            signal,
          });
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
          const provider = await ensureProvider(entry, { allowUnavailable: false });
          const res = await provider.perform({
            action: 'navigate',
            botId,
            pageId: reqPageId ?? state.pageId,
            url: safeUrl,
            signal,
          });
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
          const res = await provider.perform({
            action,
            botId,
            pageId: targetPageId,
            ...(action === 'reload' && rawArgs.ignoreCache !== undefined ? { ignoreCache: Boolean(rawArgs.ignoreCache) } : {}),
            signal,
          });
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
          const res = await provider.perform({
            action: 'snapshot',
            botId,
            pageId: targetPageId,
            ...snapshotOpts,
            signal,
          });
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
          const res = await provider.perform({
            action: 'act',
            botId,
            pageId: targetPageId,
            expectedDocumentGeneration: state.documentGeneration,
            act: normalizedAct,
            signal,
          });
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
          const rawFrame = await provider.perform({
            action: 'frame',
            botId,
            pageId: targetPageId,
            ...(rawArgs.limits ?? {}),
            signal,
          });
          assertStillBot();
          const validated = validateFramePayload(rawFrame, rawArgs.limits?.maxBytes ?? maxFrameBase64Bytes);
          const framePageId = validated.pageId ?? targetPageId;
          const liveSensitivity = classifyPageSensitivity({
            url: validated.url ?? state.activeTab()?.url ?? '',
            title: validated.title ?? state.activeTab()?.title ?? '',
            hints: validated.hints,
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
            ...(validated.hints !== undefined ? { hints: validated.hints } : {}),
            ...(validated.sensitive ? { sensitive: true } : {}),
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
    });
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
    setWithheldPagePredicate,
  };
}
