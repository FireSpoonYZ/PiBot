import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { McpOAuthProvider, authorizeMcp } from '@earendil-works/pi-mcp/oauth';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('INVALID_ARGUMENT', 'An identifier is required');
}

function httpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_ARGUMENT', 'Invalid MCP URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw fail('INVALID_ARGUMENT', 'Invalid MCP URL');
  }
  return url.href;
}

export function openMcpOAuth({ store, publicUrl }) {
  const callback = new URL('/api/oauth/mcp/callback', httpUrl(publicUrl)).href;
  const entries = new Map();
  const flows = new Map();
  const states = new Map();
  const context = new AsyncLocalStorage();
  let closed = false;

  function configFor({ installationId, deviceId, botId, url }) {
    if (closed) throw fail('INVALID_ARGUMENT', 'OAuth service is closed');
    identifier(installationId); identifier(deviceId); identifier(botId);
    const installation = store.getInstallation(installationId);
    if (!installation) throw fail('NOT_FOUND', 'Installation not found');
    if (installation.kind !== 'mcp' || installation.target !== 'center') {
      throw fail('INVALID_ARGUMENT', 'OAuth requires a center-hosted MCP');
    }
    if (!store.listDeviceBots(deviceId).some((bot) => bot.botId === botId)) {
      throw fail('NOT_FOUND', 'Bot not found');
    }
    const config = store.getBotCapability(deviceId, botId, installationId).effectiveConfig;
    if (config.oauth !== true || (config.transport ?? (config.url ? 'http' : 'stdio')) !== 'http') {
      throw fail('INVALID_ARGUMENT', 'OAuth requires an HTTP MCP with OAuth enabled');
    }
    if (config.apiKeyRef || [config.headers, config.headerRefs].some((headers) =>
      Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'authorization'))) {
      throw fail('INVALID_ARGUMENT', 'OAuth conflicts with Authorization or apiKeyRef');
    }
    const serverUrl = httpUrl(config.url);
    if (url !== undefined && httpUrl(url) !== serverUrl) throw fail('INVALID_ARGUMENT', 'MCP URL has changed');
    return serverUrl;
  }

  function entryFor(identity, url) {
    const key = JSON.stringify([identity.installationId, identity.deviceId, identity.botId, url]);
    let entry = entries.get(key);
    if (entry) return entry;
    const credentialId = 'center-internal-mcp-oauth-' + createHash('sha256').update(key).digest('hex');
    entry = { key, credentialId, url, identity, revoked: false, queue: Promise.resolve(), abort: new AbortController() };
    const stateStore = {
      load() {
        if (entry.revoked) return undefined;
        const current = store.getCredential(credentialId);
        return current?.configured ? JSON.parse(store.resolveCredential(credentialId)) : undefined;
      },
      save(value) {
        if (entry.revoked) throw fail('INVALID_ARGUMENT', 'OAuth provider is no longer active');
        const current = store.getCredential(credentialId);
        const flow = context.getStore();
        if (flow?.entry === entry && flow.phase === 'start') value = { ...value, oauthState: flow.state };
        store.putCredential(credentialId, { expectedRevision: current?.revision ?? null, value: JSON.stringify(value) });
      },
    };
    const provider = new McpOAuthProvider({
      serverUrl: url, redirectUrl: callback, clientMetadata: { client_name: 'E Launcher Center' }, store: stateStore,
      onRedirect(authorizationUrl) {
        const flow = context.getStore();
        if (!flow || flow.entry !== entry || flow.phase !== 'start' || authorizationUrl.searchParams.get('state') !== flow.state) {
          throw fail('INVALID_ARGUMENT', 'OAuth authorization must be started by the owner');
        }
        flow.authorizationUrl = authorizationUrl.href;
      },
    });
    // A fresh, single-use state binds each callback to this in-memory flow.
    provider.state = async () => {
      const flow = context.getStore();
      if (!flow || flow.entry !== entry || flow.phase !== 'start') {
        throw fail('INVALID_ARGUMENT', 'OAuth authorization must be started by the owner');
      }
      return flow.state;
    };
    entry.provider = provider;
    entry.stateStore = stateStore;
    entries.set(key, entry);
    return entry;
  }

  function enqueue(entry, action) {
    const result = entry.queue.then(action);
    entry.queue = result.catch(() => {});
    return result;
  }

  function markFailed(flow, message) {
    states.delete(flow.state);
    flow.status = 'failed';
    flow.error = message;
  }

  return {
    async getAuthProvider(identity) {
      const url = configFor(identity);
      return entryFor(identity, url).provider;
    },
    async start(identity) {
      const url = configFor(identity);
      const entry = entryFor(identity, url);
      return enqueue(entry, async () => {
        if (entry.revoked) throw fail('INVALID_ARGUMENT', 'OAuth provider is no longer active');
        for (const flow of flows.values()) {
          if (flow.entry === entry && flow.status === 'pending') markFailed(flow, 'OAuth flow was replaced');
        }
        const flow = { flowId: randomUUID(), state: randomBytes(32).toString('hex'), entry, status: 'pending', phase: 'start' };
        flows.set(flow.flowId, flow);
        states.set(flow.state, flow);
        try {
          const result = await context.run(flow, () => authorizeMcp(entry.provider, { serverUrl: url, skipRefresh: true, signal: entry.abort.signal }));
          if (result !== 'REDIRECT' || !flow.authorizationUrl || entry.revoked) throw new Error('Authorization did not redirect');
          return { flowId: flow.flowId, authorizationUrl: flow.authorizationUrl };
        } catch {
          markFailed(flow, 'OAuth authorization could not be started');
          throw fail('INVALID_ARGUMENT', 'OAuth authorization could not be started');
        }
      });
    },
    status(flowId) {
      identifier(flowId);
      const flow = flows.get(flowId);
      if (!flow) throw fail('NOT_FOUND', 'OAuth flow not found');
      return flow.error ? { status: flow.status, error: flow.error } : { status: flow.status };
    },
    async complete({ state, code, error, iss }) {
      if (typeof state !== 'string' || !state) throw fail('INVALID_ARGUMENT', 'Invalid OAuth state');
      const flow = states.get(state);
      if (!flow || flow.status !== 'pending') throw fail('INVALID_ARGUMENT', 'Invalid OAuth state');
      states.delete(state);
      return enqueue(flow.entry, async () => {
        if (flow.status !== 'pending' || flow.entry.revoked) throw fail('INVALID_ARGUMENT', 'OAuth flow is no longer active');
        try {
          configFor({ ...flow.entry.identity, url: flow.entry.url });
          if (error || typeof code !== 'string' || !code || flow.entry.stateStore.load()?.oauthState !== state) {
            throw new Error('Authorization denied');
          }
          flow.phase = 'complete';
          const result = await context.run(flow, () => authorizeMcp(flow.entry.provider, {
            serverUrl: flow.entry.url, authorizationCode: code, iss, signal: flow.entry.abort.signal,
          }));
          if (result !== 'AUTHORIZED' || flow.entry.revoked) throw new Error('Authorization failed');
          await flow.entry.provider.invalidateCredentials('verifier');
          flow.status = 'complete';
        } catch {
          markFailed(flow, 'OAuth authorization failed');
          throw fail('INVALID_ARGUMENT', 'OAuth authorization failed');
        }
      });
    },
    async logout(identity) {
      const url = configFor(identity);
      const entry = entryFor(identity, url);
      entry.revoked = true;
      entry.abort.abort();
      for (const flow of flows.values()) {
        if (flow.entry === entry && flow.status === 'pending') markFailed(flow, 'OAuth flow was cancelled');
      }
      await enqueue(entry, () => {
        const current = store.getCredential(entry.credentialId);
        if (current?.configured) store.deleteCredential(entry.credentialId, current.revision);
        entries.delete(entry.key);
      });
    },
    close() {
      closed = true;
      for (const entry of entries.values()) {
        entry.revoked = true;
        entry.abort.abort();
      }
      for (const flow of flows.values()) {
        if (flow.status === 'pending') markFailed(flow, 'OAuth service closed');
      }
      entries.clear();
    },
  };
}
