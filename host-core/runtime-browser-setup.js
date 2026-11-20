// host-core/runtime-browser-setup.js
// Trusted Runtime coordinator statically assembling host-core/bot-browser/service.js
// and host-core/google-setup/service.js (with static desktop/android browser
// providers for esbuild Desktop & Android bundles).
//
// Enforces:
//   - Trusted owner authority (`role:'owner'`, `actor:'owner'`, `trustedOwner:true`,
//     per-client unforgeable `clientId` from authenticated transport) — never
//     sourced from request body or model parameters.
//   - Distinct lease holders per authenticated client; `status` never returns
//     a lease token to any caller.
//   - Fail-closed sensitive-step locking between `google-setup` and `bot-browser`
//     via `setWithheldPagePredicate` + `browserLock`/`browserUnlock`.
//   - Per-Bot Durable tool binding with persisted conversation ownership verification
//     (`resolveBotIdentity` + `resolveConversationBot`) and whitelisted
//     `google-setup` / `google-browser-takeover` tool presentations.

import { join } from 'node:path';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { resolveBotIdentity } from './bot-identity.js';
import { messageError } from './message-protocol.js';
import { createBotBrowserService } from './bot-browser/service.js';
import { createDesktopBrowserProvider } from './bot-browser/desktop-provider.js';
import { createAndroidBrowserProvider } from './bot-browser/android-provider.js';
import { createGoogleSetupService } from './google-setup/service.js';
import {
  browserControlError,
  googleSetupError,
  normalizeBrowserControl,
  normalizeGoogleSetupControl,
  projectBrowserControlForService,
  projectGoogleSetupControlForService,
  safeBrowserControlError,
  safeGoogleSetupError,
} from './browser-setup-protocol.js';

const MAX_AUTO_TOOL_TEXT_BYTES = 50 * 1024;
const VALID_CLIENT_ID_RE = /^[A-Za-z0-9:._-]{3,128}$/;

const FORBIDDEN_AGENT_TOOL_NAMES = new Set([
  'browserControl',
  'googleSetupControl',
  'browser_control',
  'google_setup_control',
  'vaultControl',
  'vault_control',
]);

const SYSTEM_BROWSER_LOCK_AUTHORITY = Object.freeze({
  authenticated: true,
  role: 'owner',
  actor: 'owner',
  trustedOwner: true,
  clientId: 'system:google-setup',
  holderLabel: 'Google setup sensitive step',
  transport: 'internal',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveTrustedCaller(callerContext) {
  const transport = callerContext?.transport === 'relay' ? 'relay' : 'local';
  const rawClientId =
    typeof callerContext?.clientId === 'string' && VALID_CLIENT_ID_RE.test(callerContext.clientId)
      ? callerContext.clientId
      : null;
  const clientId = rawClientId ?? 'local-control:anonymous';
  const rawLabel =
    typeof callerContext?.holderLabel === 'string' && callerContext.holderLabel.trim() !== ''
      ? callerContext.holderLabel.trim().slice(0, 80)
      : (transport === 'relay' ? 'Remote client' : 'Local client');
  return { transport, clientId, holderLabel: rawLabel };
}

function normalizeToolOutput(raw) {
  if (isPlainObject(raw) && Array.isArray(raw.output)) {
    return raw;
  }
  if (isPlainObject(raw) && Array.isArray(raw.content)) {
    const out = { output: raw.content };
    if (raw.isError === true) out.isError = true;
    if (raw.structuredOutput !== undefined) out.structuredOutput = raw.structuredOutput;
    return out;
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  if (Buffer.byteLength(text, 'utf8') > MAX_AUTO_TOOL_TEXT_BYTES) {
    return {
      output: [{ type: 'text', text: JSON.stringify({ code: 'RESPONSE_TOO_LARGE', message: 'tool output exceeded size limit' }) }],
      isError: true,
    };
  }
  return { output: [{ type: 'text', text }] };
}

function extractToolSpec(rawSpec) {
  if (Array.isArray(rawSpec)) {
    return { tools: rawSpec, sections: [] };
  }
  if (isPlainObject(rawSpec)) {
    return {
      tools: Array.isArray(rawSpec.tools) ? rawSpec.tools : [],
      sections: Array.isArray(rawSpec.sections) ? rawSpec.sections : [],
    };
  }
  return { tools: [], sections: [] };
}

/**
 * Normalizes a `google-setup` tool presentation emitted by `google-setup/service.js`
 * so it carries a valid `installationId` and omits `null` optional strings,
 * matching both `host-core/tool-presentation.js` and `web/src/ToolPresentation.tsx`.
 */
function normalizePublishedSetupPresentation(raw) {
  if (!isPlainObject(raw) || raw.kind !== 'google-setup') return raw;
  const out = {
    kind: 'google-setup',
    version: 1,
    installationId:
      typeof raw.installationId === 'string' && raw.installationId.trim() !== ''
        ? raw.installationId.trim()
        : 'host.google-setup',
  };
  for (const key of ['botId', 'runId', 'card', 'step', 'mode', 'state', 'title', 'summary', 'blockerKind']) {
    if (typeof raw[key] === 'string' && raw[key].length > 0) {
      out[key] = raw[key];
    }
  }
  if (Number.isSafeInteger(raw.revision) && raw.revision >= 0) out.revision = raw.revision;
  if (Number.isSafeInteger(raw.copy) && raw.copy >= 0) out.copy = raw.copy;
  if (Array.isArray(raw.actions)) {
    const actions = [];
    for (const item of raw.actions.slice(0, 4)) {
      if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id) continue;
      const entry = {
        id: item.id,
        label: typeof item.label === 'string' && item.label ? item.label : item.id,
      };
      if (typeof item.step === 'string' && item.step) entry.step = item.step;
      actions.push(entry);
    }
    if (actions.length > 0) out.actions = actions;
  }
  return out;
}

function wrapApiForPresentation(api) {
  if (!api || typeof api.details !== 'function') return api;
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === 'details') {
        return async (details, execContext) => {
          if (isPlainObject(details) && isPlainObject(details.presentation) && details.presentation.kind === 'google-setup') {
            return target.details(
              { ...details, presentation: normalizePublishedSetupPresentation(details.presentation) },
              execContext,
            );
          }
          return target.details(details, execContext);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function maybeExtractBrowserTakeoverPresentation(botId, rawResult) {
  const output = isPlainObject(rawResult) && Array.isArray(rawResult.output) ? rawResult.output : null;
  const firstText = output?.find((block) => block?.type === 'text' && typeof block.text === 'string')?.text;
  if (!firstText) return null;
  let parsed;
  try {
    parsed = JSON.parse(firstText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const needsTakeover =
    parsed.status === 'PAUSED_FOR_HUMAN' ||
    parsed.action === 'requestTakeover' ||
    parsed.phase === 'human' ||
    parsed.phase === 'taking' ||
    parsed.phase === 'held';
  if (!needsTakeover) return null;
  const presentation = {
    kind: 'google-browser-takeover',
    version: 1,
    installationId: 'host.bot-browser',
    botId,
  };
  if (typeof parsed.pageId === 'string' && parsed.pageId) presentation.pageId = parsed.pageId;
  if (typeof parsed.phase === 'string' && parsed.phase) presentation.phase = parsed.phase;
  if (typeof parsed.reason === 'string' && parsed.reason) presentation.reason = parsed.reason.slice(0, 300);
  else if (typeof parsed.message === 'string' && parsed.message) presentation.reason = parsed.message.slice(0, 300);
  if (typeof parsed.canStreamInteract === 'boolean') presentation.canStreamInteract = parsed.canStreamInteract;
  return presentation;
}

export async function openRuntimeBrowserSetup({
  host,
  registry,
  getHarness,
  getWorkContexts,
  resolveConversationBot,
  nativeBridge,
  isOnline,
  isMaintenance,
  getCenterUrl,
  getCenterGoogleStatus,
  isBotTurnRunning,
  abortBotTurn,
  onBrowserEvent,
  onSetupEvent,
  context,
  createBotBrowserService: injectedBrowserFactory,
  createGoogleSetupService: injectedSetupFactory,
  createBrowserProvider: injectedProviderFactory,
}) {
  if (injectedBrowserFactory !== undefined && typeof injectedBrowserFactory !== 'function') {
    throw messageError('INVALID_ARGUMENT', 'createBotBrowserService must be a function');
  }
  if (injectedSetupFactory !== undefined && typeof injectedSetupFactory !== 'function') {
    throw messageError('INVALID_ARGUMENT', 'createGoogleSetupService must be a function');
  }
  if (injectedProviderFactory !== undefined && typeof injectedProviderFactory !== 'function') {
    throw messageError('INVALID_ARGUMENT', 'createBrowserProvider must be a function');
  }

  let suspended = false;
  let closed = false;
  let closePromise = null;
  const botExtensions = new Map();
  // Active fail-closed sensitive locks set by google-setup per botId.
  const sensitiveLocksByBot = new Map();

  const browserFactory = injectedBrowserFactory ?? createBotBrowserService;
  const setupFactory = injectedSetupFactory ?? createGoogleSetupService;
  const providerFactory = injectedProviderFactory ?? (
    nativeBridge
      ? (opts) => createAndroidBrowserProvider(opts)
      : (opts) => createDesktopBrowserProvider(opts)
  );

  // Authoritative agent identity resolver with exact (api, execContext) signature
  // expected by both host-core/bot-browser/tools.js and host-core/google-setup/service.js.
  async function verifyAgentConversationIdentity(api, execContext) {
    const harness = typeof getHarness === 'function' ? getHarness() : null;
    if (!harness) {
      throw messageError('BOT_CONTEXT_REQUIRED', 'Host harness is unavailable.');
    }
    const nativeId = api?.conversationId;
    const identity = await resolveBotIdentity(host, harness, nativeId, execContext ?? context);
    if (typeof resolveConversationBot === 'function') {
      const verifiedBotId = await resolveConversationBot(nativeId, execContext ?? context);
      if (verifiedBotId !== identity.botId || identity.deviceId !== host.deviceId) {
        throw messageError('BOT_CONTEXT_REQUIRED', 'Conversation ownership mismatch.');
      }
    }
    return identity;
  }

  async function resolveWorkContextForControl(botId, scopeId) {
    const workContexts = typeof getWorkContexts === 'function' ? getWorkContexts() : null;
    if (!workContexts || typeof workContexts.resolveWorkContext !== 'function') {
      throw messageError('WORK_CONTEXT_NOT_FOUND', 'work context is unavailable');
    }
    const resolved = await workContexts.resolveWorkContext(botId, scopeId);
    if (!resolved?.binding || !resolved?.scope) {
      throw messageError('WORK_CONTEXT_NOT_FOUND', 'work context is not active for this bot');
    }
    return resolved;
  }

  let setupService = null;

  const browserService = await browserFactory({
    host,
    profileRoot: join(host.dataRoot, 'bot-browser', 'profiles'),
    getHarness,
    resolveConversationBot,
    resolveIdentity: verifyAgentConversationIdentity,
    resolveWorkContext: resolveWorkContextForControl,
    createProvider: providerFactory,
    nativeBridge: nativeBridge ?? null,
    isMaintenance,
    isPageWithheld: (page) => Boolean(page?.botId && sensitiveLocksByBot.has(page.botId)),
    onTakeover: async ({ botId }) => {
      if (typeof abortBotTurn === 'function') {
        await abortBotTurn(botId);
      }
    },
    onEvent: (event) => {
      if (typeof onBrowserEvent === 'function') {
        try { onBrowserEvent(event); } catch { /* observer error must not break state */ }
      }
      if (
        !closed &&
        setupService &&
        typeof setupService.syncBrowserUrl === 'function' &&
        typeof event?.botId === 'string' &&
        typeof event?.url === 'string' &&
        event.url.trim() !== ''
      ) {
        void setupService.syncBrowserUrl(event.botId, event.url).catch(() => {});
      }
    },
  });

  if (!browserService || typeof browserService.control !== 'function' || typeof browserService.close !== 'function') {
    if (browserService && typeof browserService.close === 'function') {
      try { await browserService.close(); } catch { /* ignore cleanup error */ }
    }
    throw messageError('INTERNAL', 'createBotBrowserService must return { control, toolsForBot, close }');
  }

  if (typeof browserService.setWithheldPagePredicate === 'function') {
    browserService.setWithheldPagePredicate((page) => Boolean(page?.botId && sensitiveLocksByBot.has(page.botId)));
  }

  // Internal adapter used exclusively by google-setup for status checks and
  // sensitive-step browser locking; never accepts caller-supplied authority.
  async function internalBrowserControlForSetup(rawInput) {
    if (!isPlainObject(rawInput) || typeof rawInput.botId !== 'string') {
      throw browserControlError('INVALID_ARGUMENT');
    }
    if (rawInput.action === 'status') {
      return browserService.control(
        { action: 'status', botId: rawInput.botId },
        SYSTEM_BROWSER_LOCK_AUTHORITY,
      );
    }
    if (rawInput.action === 'takeover') {
      return browserService.control(
        {
          action: 'takeover',
          botId: rawInput.botId,
          ...(typeof rawInput.pageId === 'string' && rawInput.pageId ? { pageId: rawInput.pageId } : {}),
          force: true,
          holderLabel: 'Google setup sensitive step',
        },
        SYSTEM_BROWSER_LOCK_AUTHORITY,
      );
    }
    const normalized = normalizeBrowserControl(rawInput);
    const projected = projectBrowserControlForService(normalized);
    return browserService.control(projected, SYSTEM_BROWSER_LOCK_AUTHORITY);
  }

  async function browserLockForSetup({ botId, pageId, step, reason }) {
    // Engage fail-closed logical lock BEFORE touching the provider so even a
    // failed/unavailable browser never leaves the sensitive step unprotected.
    sensitiveLocksByBot.set(botId, {
      pageId: pageId ?? null,
      step: step ?? null,
      reason: reason ?? 'sensitive-step',
    });
    let requiresSystemBrowser = reason === 'oauth-client-secret' || reason === 'google-auth';
    try {
      const status = await browserService.control(
        { action: 'status', botId },
        SYSTEM_BROWSER_LOCK_AUTHORITY,
      );
      if (!status?.available || !status?.canStreamInteract) {
        requiresSystemBrowser = true;
      } else if (status.sessionId || (Array.isArray(status.tabs) && status.tabs.length > 0)) {
        await browserService.control(
          {
            action: 'takeover',
            botId,
            ...(typeof pageId === 'string' && pageId ? { pageId } : {}),
            force: true,
            holderLabel: 'Google setup sensitive step',
          },
          SYSTEM_BROWSER_LOCK_AUTHORITY,
        );
      }
    } catch {
      // Fail-closed: preserve sensitiveLocksByBot entry on any takeover/probe failure.
      requiresSystemBrowser = true;
    }
    return { locked: true, requiresSystemBrowser };
  }

  async function browserUnlockForSetup({ botId, step, reason }) {
    const existing = sensitiveLocksByBot.get(botId);
    if (!existing) return;
    if (reason === 'cancelled' || reason === 'setup-done' || !step || existing.step === step) {
      sensitiveLocksByBot.delete(botId);
    }
  }

  async function readPlatformCapabilities() {
    const isAndroidLocalHost =
      process.platform === 'android' || (Boolean(nativeBridge) && !injectedProviderFactory);
    const isHeadless =
      !isAndroidLocalHost &&
      !injectedProviderFactory &&
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY;
    return {
      isAndroidLocalHost,
      isHeadless,
      browserAvailable: !isAndroidLocalHost && !isHeadless,
      canStreamInteract: !isAndroidLocalHost && !isHeadless,
      canIsolateSensitivePages: !isAndroidLocalHost && !isHeadless,
      ...(isAndroidLocalHost
        ? { reason: 'Android local host uses system-browser guidance for Google setup.' }
        : isHeadless
          ? { reason: 'Headless host cannot stream interactive embedded browser pages.' }
          : {}),
    };
  }

  try {
    setupService = await setupFactory({
      dataRoot: host.dataRoot,
      host,
      getHarness,
      resolveBotIdentity: verifyAgentConversationIdentity,
      getCenterGoogleStatus:
        typeof getCenterGoogleStatus === 'function'
          ? getCenterGoogleStatus
          : async () => ({ reachable: false, client: { configured: false }, accounts: [] }),
      centerPublicUrl: () => (typeof getCenterUrl === 'function' ? getCenterUrl() : null),
      browserControl: internalBrowserControlForSetup,
      browserLock: browserLockForSetup,
      browserUnlock: browserUnlockForSetup,
      platformCapabilities: readPlatformCapabilities,
      isBotTurnRunning: typeof isBotTurnRunning === 'function' ? isBotTurnRunning : null,
      enableToolPresentation: true,
      onEvent: (event) => {
        if (typeof onSetupEvent === 'function') {
          try { onSetupEvent(event); } catch { /* observer error must not break setup */ }
        }
      },
    });
    if (!setupService || typeof setupService.control !== 'function' || typeof setupService.close !== 'function') {
      throw messageError('INTERNAL', 'createGoogleSetupService must return { control, toolsForBot, close }');
    }
  } catch (err) {
    try { await browserService.close(); } catch { /* close error must not mask open error */ }
    throw err;
  }

  async function resolveOwnerAuthority(botId, scopeId, callerContext, { allowArchived = false } = {}) {
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) {
      throw messageError('BOT_NOT_FOUND', 'bot not found on this host');
    }
    if (bot.archivedAt !== null && bot.archivedAt !== undefined && !allowArchived) {
      throw messageError('BOT_ARCHIVED', 'bot is archived and read-only');
    }
    const caller = resolveTrustedCaller(callerContext);
    if (scopeId === undefined) {
      return Object.freeze({
        authenticated: true,
        role: 'owner',
        actor: 'owner',
        trustedOwner: true,
        trusted: true,
        kind: 'owner',
        transport: caller.transport,
        clientId: caller.clientId,
        holderLabel: caller.holderLabel,
        deviceId: host.deviceId,
        botId: bot.botId,
        conversationId: bot.primaryConversationId,
        scopeId: null,
        conversationKind: 'primary',
      });
    }
    const { scope, binding } = await resolveWorkContextForControl(botId, scopeId);
    return Object.freeze({
      authenticated: true,
      role: 'owner',
      actor: 'owner',
      trustedOwner: true,
      trusted: true,
      kind: 'owner',
      transport: caller.transport,
      clientId: caller.clientId,
      holderLabel: caller.holderLabel,
      deviceId: host.deviceId,
      botId: bot.botId,
      conversationId: binding.conversationId,
      scopeId,
      conversationKind: scope.kind,
    });
  }

  function wrapAgentTool(tool, boundBotId, serviceKind, unavailableCode) {
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name.trim() === '') {
      throw messageError('INTERNAL', 'service tool definition must have a non-empty name');
    }
    if (FORBIDDEN_AGENT_TOOL_NAMES.has(tool.name)) {
      throw messageError('FORBIDDEN', `owner control name cannot be registered as an agent tool: ${tool.name}`);
    }
    const handler = typeof tool.execute === 'function'
      ? 'execute'
      : typeof tool.run === 'function'
        ? 'run'
        : null;
    if (!handler) {
      throw messageError('INTERNAL', `service tool ${tool.name} must provide execute or run`);
    }
    const parameters = tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} };
    return defineTool({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters,
      ...(tool.structuredOutputSchema !== undefined ? { structuredOutputSchema: tool.structuredOutputSchema } : {}),
      ...(tool.outputLimits !== undefined ? { outputLimits: tool.outputLimits } : {}),
      ...(tool.executionMode !== undefined ? { executionMode: tool.executionMode } : {}),
      replay: tool.replay ?? 'unsafe',
      async execute(args, api, invocation) {
        invocation?.abortSignal?.throwIfAborted();
        if (closed || suspended) {
          return {
            output: [{ type: 'text', text: JSON.stringify({ code: unavailableCode, message: 'service is closed' }) }],
            isError: true,
          };
        }
        const identity = await verifyAgentConversationIdentity(api, invocation);
        if (identity.botId !== boundBotId) {
          throw messageError('BOT_CONTEXT_REQUIRED', 'conversation ownership mismatch');
        }

        // Enforce google-setup agent browser policy before any bot_browser execution.
        if (serviceKind === 'bot-browser' && typeof setupService.getAgentBrowserPolicy === 'function') {
          const targetUrl = typeof args?.url === 'string' ? args.url : undefined;
          const policy = await setupService.getAgentBrowserPolicy(boundBotId, targetUrl);
          if (policy && policy.allowed === false) {
            return {
              output: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    code: 'BROWSER_SENSITIVE_BLOCKED',
                    status: 'PAUSED_FOR_HUMAN',
                    message: policy.note || policy.reason || 'Bot browser is locked for a sensitive Google setup step.',
                    reason: policy.reason ?? 'setup-locked',
                    fallbackToSystemBrowser: policy.requiresSystemBrowser === true || policy.handoffToSystemBrowser === true,
                  }),
                },
              ],
              isError: true,
            };
          }
          if (policy && policy.mode === 'read-only' && args?.action === 'act') {
            return {
              output: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    code: 'BROWSER_ACTION_BLOCKED',
                    status: 'PAUSED_FOR_HUMAN',
                    message: policy.reason || 'Owner performs clicking on this setup step; bot browser is read-only.',
                    reason: 'guide-here-read-only',
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        const verifiedContext = Object.freeze({
          kind: 'bot',
          role: 'bot',
          actor: 'bot',
          trusted: false,
          trustedOwner: false,
          channel: 'agent',
          deviceId: identity.deviceId,
          botId: identity.botId,
          conversationId: identity.conversationId,
          scopeId: identity.scopeId,
          conversationKind: identity.kind,
          taskId: api?.taskId,
          callId: api?.callId,
          signal: invocation?.abortSignal,
          api,
          invocation,
        });

        const wrappedApi = serviceKind === 'google-setup' ? wrapApiForPresentation(api) : api;
        const raw = handler === 'execute'
          ? await tool.execute(args, wrappedApi, invocation, verifiedContext)
          : await tool.run(args, verifiedContext);
        invocation?.abortSignal?.throwIfAborted();
        const normalized = normalizeToolOutput(raw);

        if (serviceKind === 'bot-browser' && typeof api?.details === 'function') {
          const takeoverPresentation = maybeExtractBrowserTakeoverPresentation(boundBotId, normalized);
          if (takeoverPresentation) {
            try {
              await api.details({ presentation: takeoverPresentation }, invocation);
            } catch {
              /* presentation publication is advisory and must not fail the tool result */
            }
          }
        }
        return normalized;
      },
    });
  }

  function buildBotExtension(service, prefix, bot, unavailableCode) {
    if (typeof service.toolsForBot !== 'function') return null;
    const botContext = Object.freeze({
      host,
      deviceId: host.deviceId,
      botId: bot.botId,
      primaryConversationId: bot.primaryConversationId,
      getHarness,
      resolveConversationBot,
      resolveBotIdentity: verifyAgentConversationIdentity,
      resolveIdentity: verifyAgentConversationIdentity,
      surface: 'agent',
      authority: Object.freeze({
        kind: 'bot',
        role: 'bot',
        actor: 'bot',
        trusted: false,
        trustedOwner: false,
        channel: 'agent',
        deviceId: host.deviceId,
        botId: bot.botId,
      }),
    });
    const { tools, sections } = extractToolSpec(service.toolsForBot(botContext));
    if (tools.length === 0 && sections.length === 0) return null;
    const wrappedTools = tools.map((tool) => wrapAgentTool(tool, bot.botId, prefix, unavailableCode));
    const extension = defineExtension({
      name: `host.${prefix}:${bot.botId}`,
      ...(wrappedTools.length > 0 ? { tools: wrappedTools } : {}),
      ...(sections.length > 0 ? { sections } : {}),
    });
    registry.install(extension);
    return extension;
  }

  function extensionsForBot(botId) {
    if (closed) return [];
    const cached = botExtensions.get(botId);
    if (cached) return cached;
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) return [];
    const list = [];
    const browserExt = buildBotExtension(browserService, 'bot-browser', bot, 'BROWSER_CLOSED');
    if (browserExt) list.push(browserExt);
    const setupExt = buildBotExtension(setupService, 'google-setup', bot, 'SETUP_CLOSED');
    if (setupExt) list.push(setupExt);
    botExtensions.set(botId, list);
    return list;
  }

  function prepareExistingBots() {
    for (const bot of host.listBots()) {
      if (bot.deviceId === host.deviceId) {
        extensionsForBot(bot.botId);
      }
    }
  }

  async function browserControl(rawInput, callerContext = undefined) {
    if (closed || suspended) {
      throw browserControlError('BROWSER_CLOSED');
    }
    const input = normalizeBrowserControl(rawInput);
    const allowArchived = input.action === 'status' || input.action === 'release';
    const authority = await resolveOwnerAuthority(input.botId, input.scopeId, callerContext, { allowArchived });
    const serviceInput = projectBrowserControlForService(input);
    try {
      const result = await browserService.control(serviceInput, authority);
      // Defense-in-depth: status queries MUST NEVER expose a lease token to any client.
      if (input.action === 'status' && isPlainObject(result) && Object.hasOwn(result, 'lease')) {
        const { lease: _omitted, ...safeResult } = result;
        return safeResult;
      }
      return result;
    } catch (err) {
      throw safeBrowserControlError(err);
    }
  }

  async function googleSetupControl(rawInput, callerContext = undefined) {
    if (closed || suspended) {
      throw googleSetupError('SETUP_CLOSED');
    }
    const input = normalizeGoogleSetupControl(rawInput);
    const allowArchived = input.action === 'status' || input.action === 'cancel';
    const authority = await resolveOwnerAuthority(input.botId, input.scopeId, callerContext, { allowArchived });
    const serviceInput = projectGoogleSetupControlForService(input);
    try {
      return await setupService.control(serviceInput, authority);
    } catch (err) {
      throw safeGoogleSetupError(err);
    }
  }

  async function releaseBot(botId) {
    botExtensions.delete(botId);
    sensitiveLocksByBot.delete(botId);
    if (closed) return;
    try {
      if (typeof setupService.forgetBot === 'function') {
        await setupService.forgetBot(botId);
      }
    } catch {
      /* best-effort bot deletion cleanup */
    }
    try {
      if (typeof browserService.cleanupBot === 'function') {
        await browserService.cleanupBot(botId);
      }
    } catch {
      /* best-effort bot deletion cleanup */
    }
  }

  function suspend() {
    suspended = true;
  }

  function close() {
    suspended = true;
    closed = true;
    closePromise ??= (async () => {
      botExtensions.clear();
      sensitiveLocksByBot.clear();
      const errors = [];
      try { await setupService.close(); } catch (err) { errors.push(err); }
      try { await browserService.close(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'browser/setup runtime close failed');
    })();
    return closePromise;
  }

  return {
    browserControl,
    googleSetupControl,
    extensionsForBot,
    prepareExistingBots,
    releaseBot,
    suspend,
    close,
  };
}
