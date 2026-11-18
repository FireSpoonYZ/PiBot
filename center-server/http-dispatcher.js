// Ported from @earendil-works/pi-coding-agent/dist/cli/setup.js and
// dist/core/http-dispatcher.js so Center's Pi OAuth flows (OpenAI Codex,
// ChatGPT, Copilot, etc.), catalog sync, and /v1/models discovery honor
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY identically to Pi CLI.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BlockList, isIP } from 'node:net';

const codingAgentRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const undici = codingAgentRequire('undici');

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch;
let configured = false;

const ignoreUndiciDispatcherError = () => {};

function withUndiciErrorListener(dispatcher) {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, 'error', ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin, options) {
  return withUndiciErrorListener(new undici.Client(origin, options));
}

function createUndiciOriginDispatcher(origin, options) {
  if (options?.connections === 1) {
    return createUndiciClient(origin, options);
  }
  return withUndiciErrorListener(new undici.Pool(origin, {
    ...options,
    factory: createUndiciClient,
  }));
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function buildNoProxyCidrBlockList(noProxyRaw) {
  const blockList = new BlockList();
  let count = 0;
  for (const raw of String(noProxyRaw || '').split(/[,\s]+/)) {
    const entry = raw.trim();
    const slash = entry.indexOf('/');
    if (slash <= 0) continue;
    const ip = stripBrackets(entry.slice(0, slash));
    const prefix = Number.parseInt(entry.slice(slash + 1), 10);
    const family = isIP(ip);
    if (!family || !Number.isInteger(prefix)) continue;
    if ((family === 4 && prefix >= 0 && prefix <= 32) || (family === 6 && prefix >= 0 && prefix <= 128)) {
      blockList.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
      count++;
    }
  }
  return count > 0 ? blockList : null;
}

class PiCenterHttpDispatcher extends undici.Dispatcher {
  #directAgent;
  #envProxyAgent;
  #lastNoProxyRaw = null;
  #cidrBlockList = null;

  constructor(agentOpts) {
    super();
    this.#directAgent = withUndiciErrorListener(new undici.Agent(agentOpts));
    this.#envProxyAgent = withUndiciErrorListener(new undici.EnvHttpProxyAgent(agentOpts));
  }

  #isBypassed(origin) {
    let url;
    try {
      url = origin instanceof URL ? origin : new URL(String(origin));
    } catch {
      return false;
    }
    const rawHost = url.hostname.toLowerCase();
    const bareHost = stripBrackets(rawHost);
    // Never send container/test loopback traffic (e.g. Vaultwarden bw serve or
    // 127.0.0.1 test servers) through an external HTTP_PROXY.
    if (LOOPBACK_HOSTS.has(rawHost) || LOOPBACK_HOSTS.has(bareHost) || bareHost.endsWith('.localhost')) {
      return true;
    }
    const noProxyRaw = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
    if (noProxyRaw !== this.#lastNoProxyRaw) {
      this.#lastNoProxyRaw = noProxyRaw;
      this.#cidrBlockList = buildNoProxyCidrBlockList(noProxyRaw);
    }
    if (this.#cidrBlockList) {
      const family = isIP(bareHost);
      if (family && this.#cidrBlockList.check(bareHost, family === 4 ? 'ipv4' : 'ipv6')) {
        return true;
      }
    }
    return false;
  }

  dispatch(opts, handler) {
    const target = this.#isBypassed(opts?.origin) ? this.#directAgent : this.#envProxyAgent;
    return target.dispatch(opts, handler);
  }

  async close() {
    await Promise.all([this.#directAgent.close(), this.#envProxyAgent.close()]);
  }

  async destroy(err) {
    await Promise.all([this.#directAgent.destroy(err), this.#envProxyAgent.destroy(err)]);
  }
}

export function setupPiHttpRuntime(timeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS) {
  process.env.PI_CODING_AGENT ??= 'true';
  process.env.AI_AGENT ??= 'pi';
  if (configured) return;
  configured = true;

  const agentOpts = {
    allowH2: false,
    proxyTunnel: true,
    bodyTimeout: timeoutMs,
    connect: {
      autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    },
    headersTimeout: timeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  };

  const dispatcher = withUndiciErrorListener(new PiCenterHttpDispatcher(agentOpts));
  undici.setGlobalDispatcher(dispatcher);

  const shouldInstallGlobals = installedGlobalFetch === undefined
    ? globalThis.fetch === originalGlobalFetch
    : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}
