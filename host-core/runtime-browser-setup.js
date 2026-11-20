// host-core/runtime-browser-setup.js
// Trusted Runtime coordinator for host-core/bot-browser/service.js and
// host-core/google-setup/service.js.
// Enforces:
//   - Owner control authority comes strictly from authenticated Host control +
//     verified local Bot/scope ownership, never from wire or model parameters.
//   - Agent tools are bound per Bot via Pi Durable extensions and double-check
//     persisted conversation ownership (resolveConversationBot + resolveBotIdentity)
//     on every invocation.
//   - Clean open/suspend/close lifecycle and honest unavailable fallback when a
//     sibling service module is absent on this Host.

import { join } from 'node:path';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { resolveBotIdentity } from './bot-identity.js';
import { messageError } from './message-protocol.js';
import {
  browserControlError,
  googleSetupError,
  normalizeBrowserControl,
  normalizeGoogleSetupControl,
  safeBrowserControlError,
  safeGoogleSetupError,
} from './browser-setup-protocol.js';

const MAX_AUTO_TOOL_TEXT_BYTES = 50 * 1024;
const FORBIDDEN_AGENT_TOOL_NAMES = new Set([
  'browserControl',
  'googleSetupControl',
  'browser_control',
  'google_setup_control',
  'vaultControl',
  'vault_control',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingTargetModule(err, targetSuffix) {
  if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const msg = typeof err.message === 'string' ? err.message : '';
  const url = typeof err.url === 'string' ? err.url : '';
  const normalizedSuffix = targetSuffix.replace(/^\.\//, '');
  return msg.includes(normalizedSuffix) || url.includes(normalizedSuffix);
}

async function loadOptionalFactory(specifier, exportName) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    if (isMissingTargetModule(err, specifier)) {
      return null;
    }
    throw err;
  }
  if (typeof mod?.[exportName] !== 'function') {
    throw messageError('INTERNAL', `${specifier} must export ${exportName}`);
  }
  return mod[exportName];
}

function createUnavailableBrowserService(reason) {
  return {
    available: false,
    async control(input) {
      if (input.action === 'status') {
        return {
          available: false,
          reason,
          canStreamInteract: false,
          phase: 'bot',
          revision: 0,
          tabs: [],
        };
      }
      throw browserControlError('BROWSER_UNAVAILABLE');
    },
    toolsForBot() {
      return [];
    },
    async close() {},
  };
}

function createUnavailableGoogleSetupService(reason) {
  return {
    available: false,
    async control(input) {
      if (input.action === 'status') {
        return {
          available: false,
          revision: 0,
          state: 'unavailable',
          steps: [],
          reason,
          blocker: { code: 'GOOGLE_SETUP_UNAVAILABLE', reason },
        };
      }
      throw googleSetupError('GOOGLE_SETUP_UNAVAILABLE');
    },
    toolsForBot() {
      return [];
    },
    async close() {},
  };
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
  abortBotTurn,
  context,
  createBotBrowserService: injectedBrowserFactory,
  createGoogleSetupService: injectedSetupFactory,
}) {
  if (injectedBrowserFactory !== undefined && typeof injectedBrowserFactory !== 'function') {
    throw messageError('INVALID_ARGUMENT', 'createBotBrowserService must be a function');
  }
  if (injectedSetupFactory !== undefined && typeof injectedSetupFactory !== 'function') {
    throw messageError('INVALID_ARGUMENT', 'createGoogleSetupService must be a function');
  }

  let suspended = false;
  let closed = false;
  let closePromise = null;
  const botExtensions = new Map();

  const isLocalBot = (botId) => {
    try {
      const bot = host.getBot(botId);
      return Boolean(bot && bot.deviceId === host.deviceId);
    } catch {
      return false;
    }
  };

  const browserFactory = injectedBrowserFactory
    ?? await loadOptionalFactory('./bot-browser/service.js', 'createBotBrowserService');
  const setupFactory = injectedSetupFactory
    ?? await loadOptionalFactory('./google-setup/service.js', 'createGoogleSetupService');

  const baseOptions = {
    host,
    deviceId: host.deviceId,
    dataRoot: host.dataRoot,
    profilesRoot: join(host.dataRoot, 'bot-browser-profiles'),
    platform: process.platform,
    nativeBridge: nativeBridge ?? null,
    isLocalBot,
    isOnline,
    isMaintenance,
    getHarness,
    resolveConversationBot,
    resolveBotIdentity: (conversationId, ctx) => resolveBotIdentity(host, getHarness(), conversationId, ctx ?? context),
    abortBotTurn: async (botId) => {
      if (typeof abortBotTurn === 'function') {
        await abortBotTurn(botId);
      }
    },
  };

  const browserService = browserFactory
    ? await browserFactory(baseOptions)
    : createUnavailableBrowserService('bot browser service module is not installed on this host');

  if (!browserService || typeof browserService.control !== 'function' || typeof browserService.close !== 'function') {
    if (browserService && typeof browserService.close === 'function') {
      try { await browserService.close(); } catch { /* ignore cleanup error */ }
    }
    throw messageError('INTERNAL', 'createBotBrowserService must return { control, toolsForBot, close }');
  }

  let setupService;
  try {
    setupService = setupFactory
      ? await setupFactory({
          ...baseOptions,
          botBrowser: browserService,
          getCenterUrl: typeof getCenterUrl === 'function' ? getCenterUrl : () => null,
        })
      : createUnavailableGoogleSetupService('google setup service module is not installed on this host');
    if (!setupService || typeof setupService.control !== 'function' || typeof setupService.close !== 'function') {
      throw messageError('INTERNAL', 'createGoogleSetupService must return { control, toolsForBot, close }');
    }
  } catch (err) {
    try { await browserService.close(); } catch { /* close error must not mask open error */ }
    throw err;
  }

  async function resolveOwnerAuthority(botId, scopeId, { allowArchived = false } = {}) {
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) {
      throw messageError('BOT_NOT_FOUND', 'bot not found on this host');
    }
    if (bot.archivedAt !== null && bot.archivedAt !== undefined && !allowArchived) {
      throw messageError('BOT_ARCHIVED', 'bot is archived and read-only');
    }
    if (scopeId === undefined) {
      return Object.freeze({
        kind: 'owner',
        role: 'owner',
        trusted: true,
        channel: 'control',
        deviceId: host.deviceId,
        botId: bot.botId,
        conversationId: bot.primaryConversationId,
        scopeId: null,
        conversationKind: 'primary',
      });
    }
    const workContexts = typeof getWorkContexts === 'function' ? getWorkContexts() : null;
    if (!workContexts || typeof workContexts.resolveWorkContext !== 'function') {
      throw messageError('WORK_CONTEXT_NOT_FOUND', 'work context is unavailable');
    }
    const { scope, binding } = await workContexts.resolveWorkContext(botId, scopeId);
    if (!binding || !scope) {
      throw messageError('WORK_CONTEXT_NOT_FOUND', 'work context is not active for this bot');
    }
    return Object.freeze({
      kind: 'owner',
      role: 'owner',
      trusted: true,
      channel: 'control',
      deviceId: host.deviceId,
      botId: bot.botId,
      conversationId: binding.conversationId,
      scopeId,
      conversationKind: scope.kind,
    });
  }

  function wrapAgentTool(tool, boundBotId, unavailableCode) {
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
      replay: tool.replay ?? 'unsafe',
      async execute(args, api, invocation) {
        invocation?.abortSignal?.throwIfAborted();
        if (closed || suspended) {
          return {
            output: [{ type: 'text', text: JSON.stringify({ code: unavailableCode, message: 'service is closed' }) }],
            isError: true,
          };
        }
        const verifiedBotId = await resolveConversationBot(api.conversationId);
        const identity = await resolveBotIdentity(host, getHarness(), api.conversationId, invocation);
        if (
          identity.deviceId !== host.deviceId ||
          identity.botId !== verifiedBotId ||
          verifiedBotId !== boundBotId
        ) {
          throw messageError('BOT_CONTEXT_REQUIRED', 'conversation ownership mismatch');
        }
        const verifiedContext = Object.freeze({
          kind: 'bot',
          role: 'bot',
          trusted: false,
          channel: 'agent',
          deviceId: identity.deviceId,
          botId: verifiedBotId,
          conversationId: identity.conversationId,
          scopeId: identity.scopeId,
          conversationKind: identity.kind,
          taskId: api.taskId,
          callId: api.callId,
          signal: invocation?.abortSignal,
          api,
          invocation,
        });
        const raw = handler === 'execute'
          ? await tool.execute(args, api, invocation, verifiedContext)
          : await tool.run(args, verifiedContext);
        invocation?.abortSignal?.throwIfAborted();
        return normalizeToolOutput(raw);
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
      resolveBotIdentity: (conversationId, ctx) => resolveBotIdentity(host, getHarness(), conversationId, ctx ?? context),
      surface: 'agent',
      authority: Object.freeze({
        kind: 'bot',
        role: 'bot',
        trusted: false,
        channel: 'agent',
        deviceId: host.deviceId,
        botId: bot.botId,
      }),
    });
    const { tools, sections } = extractToolSpec(service.toolsForBot(botContext));
    if (tools.length === 0 && sections.length === 0) return null;
    const wrappedTools = tools.map((tool) => wrapAgentTool(tool, bot.botId, unavailableCode));
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
    const browserExt = buildBotExtension(browserService, 'bot-browser', bot, 'BROWSER_UNAVAILABLE');
    if (browserExt) list.push(browserExt);
    const setupExt = buildBotExtension(setupService, 'google-setup', bot, 'GOOGLE_SETUP_UNAVAILABLE');
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

  async function browserControl(rawInput) {
    if (closed || suspended) {
      throw browserControlError('BROWSER_UNAVAILABLE');
    }
    const input = normalizeBrowserControl(rawInput);
    const allowArchived = input.action === 'status' || input.action === 'release';
    const authority = await resolveOwnerAuthority(input.botId, input.scopeId, { allowArchived });
    try {
      return await browserService.control(input, authority);
    } catch (err) {
      throw safeBrowserControlError(err);
    }
  }

  async function googleSetupControl(rawInput) {
    if (closed || suspended) {
      throw googleSetupError('GOOGLE_SETUP_UNAVAILABLE');
    }
    const input = normalizeGoogleSetupControl(rawInput);
    const allowArchived = input.action === 'status' || input.action === 'cancel';
    const authority = await resolveOwnerAuthority(input.botId, input.scopeId, { allowArchived });
    try {
      return await setupService.control(input, authority);
    } catch (err) {
      throw safeGoogleSetupError(err);
    }
  }

  async function releaseBot(botId) {
    botExtensions.delete(botId);
    if (closed) return;
    const cleanupAuthority = Object.freeze({
      kind: 'owner',
      role: 'owner',
      trusted: true,
      channel: 'lifecycle',
      deviceId: host.deviceId,
      botId,
      conversationId: null,
      scopeId: null,
      conversationKind: 'primary',
    });
    try {
      if (typeof setupService.releaseBot === 'function') {
        await setupService.releaseBot(botId);
      } else if (setupService.available !== false) {
        await setupService.control({ action: 'cancel', botId, reason: 'bot_deleted' }, cleanupAuthority);
      }
    } catch {
      /* best-effort bot deletion cleanup */
    }
    try {
      if (typeof browserService.releaseBot === 'function') {
        await browserService.releaseBot(botId);
      } else if (browserService.available !== false) {
        await browserService.control({ action: 'release', botId, force: true, reason: 'bot_deleted' }, cleanupAuthority);
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
