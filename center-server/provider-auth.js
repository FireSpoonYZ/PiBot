import { randomUUID } from 'node:crypto';

const FLOW_TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 30;
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Owner-controlled interactive OAuth broker. Pi owns the provider-specific
 * browser/device/paste-code flow and token refresh. Only status events and
 * prompts are visible to the browser; credential material stays encrypted.
 */
export function openProviderAuth({ store, catalog, onChange }) {
  const flows = new Map();
  const activeByProvider = new Map();
  let closed = false;

  async function getProvider(providerId) {
    const runtime = await catalog.runtime();
    const provider = runtime.getProvider(providerId);
    if (!provider || !store.getProvider(providerId)) throw fail('NOT_FOUND', 'Provider not found');
    return { runtime, provider };
  }

  async function describe(providerId) {
    const { provider } = await getProvider(providerId);
    const secret = store.getCredential('center-internal-pi-oauth-' + providerId);
    const configured = Boolean(secret?.configured);
    const key = store.getProvider(providerId)?.credentialRef;
    return {
      providerId,
      method: configured ? 'oauth' : key && store.getCredential(key)?.configured ? 'api_key' : 'none',
      oauth: Boolean(provider.auth.oauth),
      label: provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? '使用账号登录',
      subscription: provider.auth.oauth?.isSubscription === true,
    };
  }

  function safeEvent(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'auth_url' && typeof event.url === 'string') {
      const url = new URL(event.url);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      return { type: 'auth_url', url: url.href, instructions: String(event.instructions ?? '').slice(0, 600) };
    }
    if (event.type === 'device_code' && typeof event.userCode === 'string') {
      const url = new URL(event.verificationUri);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      return { type: 'device_code', userCode: event.userCode.slice(0, 128), verificationUri: url.href,
        intervalSeconds: event.intervalSeconds, expiresInSeconds: event.expiresInSeconds };
    }
    if (event.type === 'info' || event.type === 'progress') {
      return { type: event.type, message: String(event.message ?? '').slice(0, 600),
        ...(event.type === 'info' ? { links: (event.links ?? []).filter(x =>
          typeof x.url === 'string' && /^https?:\/\//.test(x.url)).slice(0, 5).map(x =>
          ({ url: x.url, label: String(x.label ?? '').slice(0, 120) })) } : {}) };
    }
    return null;
  }

  function abortFlow(flow) {
    flow.controller.abort();
    if (flow.pending) {
      flow.pending.reject(fail('INVALID_STATE', 'Login was cancelled'));
      flow.pending = null;
    }
    if (flow.status === 'pending') flow.status = 'cancelled';
    if (activeByProvider.get(flow.providerId) === flow.id) activeByProvider.delete(flow.providerId);
  }

  async function start(providerId) {
    if (closed) throw fail('INVALID_STATE', 'Provider authentication is closed');
    const { runtime, provider } = await getProvider(providerId);
    if (!provider.auth.oauth) throw fail('INVALID_ARGUMENT', 'Provider does not support account login');
    const previousId = activeByProvider.get(providerId);
    if (previousId) abortFlow(flows.get(previousId));
    const controller = new AbortController();
    const flow = { id: randomUUID(), providerId, status: 'pending', events: [],
      pending: null, controller, createdAt: Date.now(), prompt: null, error: null };
    flows.set(flow.id, flow);
    activeByProvider.set(providerId, flow.id);
    void (async () => {
      try {
        await runtime.login(providerId, 'oauth', {
          signal: controller.signal,
          notify(event) {
            const safe = safeEvent(event);
            if (safe) flow.events.push(safe);
            if (flow.events.length > MAX_EVENTS) flow.events.shift();
          },
          prompt(request) {
            if (flow.pending) return Promise.reject(fail('INVALID_STATE', 'Concurrent login prompts'));
            return new Promise((resolve, reject) => {
              const payload = { type: request.type, message: String(request.message ?? '').slice(0, 600),
                placeholder: String(request.placeholder ?? '').slice(0, 160) };
              if (request.type === 'select') payload.options = request.options.slice(0, 30);
              flow.prompt = payload;
              flow.pending = { resolve, reject };
              request.signal?.addEventListener('abort', () => {
                if (flow.pending?.resolve !== resolve) return;
                flow.pending = null;
                flow.prompt = null;
                reject(fail('INVALID_STATE', 'Prompt was cancelled'));
              }, { once: true });
            });
          },
        }, { agentName: 'PiBot Center' });
        if (controller.signal.aborted) return;
        const current = store.getProvider(providerId);
        if (!current.enabled) store.putProvider({ ...current, enabled: true }, current.revision);
        flow.status = 'complete';
        await catalog.apply();
        onChange();
        void catalog.sync().catch(() => {});
      } catch (error) {
        if (!controller.signal.aborted) {
          flow.status = 'failed';
          flow.error = error?.code === 'INVALID_STATE' ? '授权流程无效' : '授权未完成，请重试';
        }
      } finally {
        if (activeByProvider.get(providerId) === flow.id) activeByProvider.delete(providerId);
        flow.pending = null;
        flow.prompt = null;
      }
    })();
    return { flowId: flow.id };
  }

  function flowFor(providerId, flowId) {
    const flow = flows.get(flowId);
    if (!flow || flow.providerId !== providerId || Date.now() - flow.createdAt > FLOW_TTL_MS) {
      throw fail('NOT_FOUND', 'Login flow not found');
    }
    return flow;
  }

  function status(providerId, flowId) {
    const flow = flowFor(providerId, flowId);
    return { status: flow.status, events: [...flow.events], prompt: flow.prompt, error: flow.error };
  }

  function answer(providerId, flowId, answer) {
    const flow = flowFor(providerId, flowId);
    if (flow.status !== 'pending' || !flow.pending) throw fail('INVALID_STATE', 'No login input requested');
    if (typeof answer !== 'string' || answer.length > 8192) throw fail('INVALID_ARGUMENT', 'Invalid login input');
    const pending = flow.pending;
    flow.pending = null;
    flow.prompt = null;
    pending.resolve(answer);
    return { accepted: true };
  }

  function cancel(providerId, flowId) {
    abortFlow(flowFor(providerId, flowId));
    return { status: 'cancelled' };
  }

  async function logout(providerId) {
    const { runtime } = await getProvider(providerId);
    const id = activeByProvider.get(providerId);
    if (id) abortFlow(flows.get(id));
    await runtime.logout(providerId);
    await catalog.apply();
    onChange();
    return describe(providerId);
  }

  function close() {
    closed = true;
    for (const flow of flows.values()) abortFlow(flow);
    flows.clear();
    activeByProvider.clear();
  }

  return { describe, start, status, answer, cancel, logout, close };
}
