import { randomUUID } from 'node:crypto';

const FLOW_TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 30;
const fail = (code, message) => Object.assign(new Error(message), { code });

function redactSecretFragments(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:access_token|refresh_token|id_token|api_key|apiKey|client_secret)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi, '$1[REDACTED]')
    .slice(0, 320);
}

function formatOAuthError(error) {
  if (error?.code === 'INVALID_STATE') return '授权流程已失效，请重新发起登录';
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const causeMsg = error?.cause instanceof Error ? error.cause.message : '';
  const combined = `${raw} ${causeMsg}`.trim();

  if (/unsupported_country_region_territory/i.test(combined)) {
    return 'OpenAI 拒绝了中心服务器当前出口地区的请求 (403 unsupported_country_region_territory)，请检查中心服务器代理 (HTTPS_PROXY) 配置';
  }
  if (/Port 1455 is in use|EADDRINUSE/i.test(combined)) {
    return '本机 1455 回调端口正被其他进程占用（如未完成的 Pi 登录或 Codex CLI），请先关闭占用进程或直接粘贴回调链接';
  }
  if (/requires a device ID/i.test(combined)) {
    return '中心实例设备标识无效，无法发起授权';
  }
  if (/Paste the full callback URL|must start with http:\/\/|Missing authorization code/i.test(combined)) {
    return '回调地址或授权码格式不正确，请复制浏览器登录完成跳转后的完整地址栏链接重试';
  }
  if (/did not contain an issued client ID/i.test(combined)) {
    return '回调链接缺少 client_id 参数，请重新发起登录并复制完整回调地址';
  }
  if (/State mismatch|OAuth state mismatch|Missing OAuth state/i.test(combined)) {
    return '授权校验状态不匹配（可能使用了旧的登录页面），请重新点击登录';
  }
  if (/device code login is not enabled/i.test(combined)) {
    return '当前服务端未开启设备码登录，请重新发起并选择「浏览器授权登录」';
  }
  if (/Failed to extract accountId from token/i.test(combined)) {
    return '未能从授权令牌中提取 ChatGPT 账户标识 (accountId)，请确认账号已开通 ChatGPT 并重试';
  }
  if (/timed out/i.test(combined)) {
    return '等待授权超时，请重新发起登录';
  }
  if (/Login cancelled/i.test(combined)) {
    return '已取消登录';
  }
  if (/authorization failed/i.test(combined)) {
    const clean = redactSecretFragments(raw);
    return `浏览器端拒绝或中止了授权：${clean}`;
  }
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|Proxy|TLS|certificate/i.test(combined)) {
    return `中心服务器无法连接上游授权服务（请检查网络或代理配置）：${redactSecretFragments(combined)}`;
  }
  const clean = redactSecretFragments(raw);
  return clean ? `登录失败：${clean}` : '授权未完成，请重试';
}

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
    const stored = store.getProvider(providerId);
    if (!stored) throw fail('NOT_FOUND', 'Provider not found');
    const runtime = await catalog.runtime();
    const provider = runtime.getProvider(providerId);
    return { runtime, provider, stored };
  }

  async function describe(providerId) {
    const { provider, stored } = await getProvider(providerId);
    const secret = store.getCredential('center-internal-pi-oauth-' + providerId);
    const configured = Boolean(secret?.configured);
    const key = stored.credentialRef;
    const hasKey = Boolean(key && store.getCredential(key)?.configured);
    return {
      providerId,
      method: configured ? 'oauth' : hasKey ? 'api_key' : 'none',
      oauth: Boolean(provider?.auth?.oauth),
      apiKey: !stored.native || Boolean(provider?.auth?.apiKey),
      label: provider?.auth?.oauth?.loginLabel ?? provider?.auth?.oauth?.name ?? '使用账号登录',
      subscription: provider?.auth?.oauth?.isSubscription === true,
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
      return {
        type: 'device_code',
        userCode: event.userCode.slice(0, 128),
        verificationUri: url.href,
        intervalSeconds: event.intervalSeconds,
        expiresInSeconds: event.expiresInSeconds,
      };
    }
    if (event.type === 'info' || event.type === 'progress') {
      return {
        type: event.type,
        message: String(event.message ?? '').slice(0, 600),
        ...(event.type === 'info'
          ? {
              links: (event.links ?? [])
                .filter(x => typeof x.url === 'string' && /^https?:\/\//.test(x.url))
                .slice(0, 5)
                .map(x => ({ url: x.url, label: String(x.label ?? '').slice(0, 120) })),
            }
          : {}),
      };
    }
    return null;
  }

  function abortFlow(flow) {
    if (!flow) return;
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
    if (!provider?.auth?.oauth) throw fail('INVALID_ARGUMENT', 'Provider does not support account login');
    const previousId = activeByProvider.get(providerId);
    if (previousId) abortFlow(flows.get(previousId));
    const controller = new AbortController();
    const flow = {
      id: randomUUID(),
      providerId,
      status: 'pending',
      events: [],
      pending: null,
      controller,
      createdAt: Date.now(),
      prompt: null,
      error: null,
    };
    flows.set(flow.id, flow);
    activeByProvider.set(providerId, flow.id);
    const installationId = store.getInstallationId();
    void (async () => {
      try {
        // Keep Pi's native originator/agent_name_hint untouched (OpenAI Codex simplified OAuth
        // validates originator) while supplying a persistent installation UUID for ChatGPT OAuth.
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
              const payload = {
                type: request.type,
                message: String(request.message ?? '').slice(0, 600),
                placeholder: String(request.placeholder ?? '').slice(0, 160),
              };
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
        }, { getDeviceId: () => installationId });
        if (controller.signal.aborted) return;
        const current = store.getProvider(providerId);
        if (current && (!current.enabled || !current.configured)) {
          store.putProvider({ ...current, enabled: true, configured: true }, current.revision);
        }
        flow.status = 'complete';
        await catalog.apply();
        onChange();
        void catalog.sync().catch(() => {});
      } catch (error) {
        if (!controller.signal.aborted) {
          flow.status = 'failed';
          flow.error = formatOAuthError(error);
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

  function normalizeManualCallbackInput(prompt, rawInput) {
    const trimmed = rawInput.trim();
    if (!trimmed) throw fail('INVALID_ARGUMENT', '请粘贴完整的回调链接或授权码');
    if (prompt.type === 'select' && Array.isArray(prompt.options)) {
      if (!prompt.options.some(opt => opt.id === trimmed)) {
        throw fail('INVALID_ARGUMENT', '请选择有效的授权方式');
      }
      return trimmed;
    }
    if (prompt.type !== 'manual_code') return trimmed;

    if (prompt.placeholder === 'http://127.0.0.1:1455/auth/callback') {
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw fail('INVALID_ARGUMENT', '请粘贴浏览器登录完成跳转后的完整回调链接（以 http://127.0.0.1:1455/auth/callback? 开头）');
      }
      if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.port === '1455' && parsed.pathname === '/auth/callback') {
        parsed.hostname = '127.0.0.1';
      } else {
        throw fail('INVALID_ARGUMENT', '回调链接需以 http://127.0.0.1:1455/auth/callback 开头，请复制登录完成跳转后的地址栏链接');
      }
      if (!parsed.searchParams.get('code') && !parsed.searchParams.get('error')) {
        throw fail('INVALID_ARGUMENT', '回调链接缺少 code 参数，请确认已完成授权并复制完整地址栏链接');
      }
      return parsed.toString();
    }

    if (/^https?:\/\//i.test(trimmed)) {
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw fail('INVALID_ARGUMENT', '回调链接格式不正确，请复制完整的地址栏链接');
      }
      if (!parsed.searchParams.get('code') && !parsed.searchParams.get('error')) {
        throw fail('INVALID_ARGUMENT', '回调链接缺少 code 参数，请复制登录完成跳转后的完整地址栏链接');
      }
    }
    return trimmed;
  }

  function answer(providerId, flowId, rawAnswer) {
    const flow = flowFor(providerId, flowId);
    if (flow.status !== 'pending' || !flow.pending) throw fail('INVALID_STATE', 'No login input requested');
    if (typeof rawAnswer !== 'string' || rawAnswer.length > 8192) throw fail('INVALID_ARGUMENT', 'Invalid login input');
    const normalized = normalizeManualCallbackInput(flow.prompt ?? {}, rawAnswer);
    const pending = flow.pending;
    flow.pending = null;
    flow.prompt = null;
    pending.resolve(normalized);
    return { accepted: true };
  }

  function cancel(providerId, flowId) {
    abortFlow(flowFor(providerId, flowId));
    return { status: 'cancelled' };
  }

  async function logout(providerId) {
    const { runtime, provider } = await getProvider(providerId);
    const id = activeByProvider.get(providerId);
    if (id) abortFlow(flows.get(id));
    if (provider) {
      await runtime.logout(providerId);
    }
    await catalog.apply();
    onChange();
    return describe(providerId);
  }

  async function clearAuth(providerId) {
    const id = activeByProvider.get(providerId);
    if (id) abortFlow(flows.get(id));
    try {
      const runtime = await catalog.runtime();
      if (runtime.getProvider(providerId)) {
        await runtime.logout(providerId);
      }
    } catch {
      // Store-level deletion handles credential cleanup even if runtime logout fails.
    }
  }

  function close() {
    closed = true;
    for (const flow of flows.values()) abortFlow(flow);
    flows.clear();
    activeByProvider.clear();
  }

  return { describe, start, status, answer, cancel, logout, clearAuth, close };
}
